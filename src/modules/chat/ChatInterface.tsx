import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '@/modules/task-master';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { api } from '@/shared/api';
import type {
  ChatMessage,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { parseProviderUsageLimit } from '@/shared/utils';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { AgentCreateCard, AidevRouterBar, ClarifyPrompt, COMPOSE_EVENT, announceRunComplete, changedFilesSince, EscalationCard, routingStore, useAgentCreation, useAidevRouting, useEffortCap, useEscalation, useReturnFromHandoff, useRoutingState, ReturnCard, VerificationCard } from '@/modules/aidev-router';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';

type ChatInterfaceProps = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  // Nado AI Dev: a provider `complete` event ends the routed run started by the last send (§3.8)
  // and advances the agent-creation flow when one is pending (§3.7).
  const { reportOutcome: reportAidevOutcome } = useAidevRouting();
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const agentCreation = useAgentCreation({
    getLastAssistantText: () => { const list = chatMessagesRef.current; for (let index = list.length - 1; index >= 0; index -= 1) { const message = list[index]; if (message.type === 'assistant' && typeof message.content === 'string' && message.content.trim()) return message.content; } return null; },
    resend: (text) => { handleVoiceTranscriptRef.current?.(text, true); },
  });
  const handleVoiceTranscriptRef = useRef<((text: string, send?: boolean) => void) | null>(null);
  // Assigned from useEscalation below; the complete subscriber is installed before it exists.
  const handoffOnUsageLimitRef = useRef<((args: { sessionId: string; blockedEngine: 'claude' | 'codex'; reason: string }) => Promise<unknown>) | null>(null);
  const agentCreationRef = useRef(agentCreation);
  useEffect(() => { agentCreationRef.current = agentCreation; });
  useEffect(() => subscribe((event) => {
    if (event.kind !== 'complete') return;
    if (event.sessionId && selectedSession?.id && event.sessionId !== selectedSession.id) return;
    const exitCode = typeof event.exitCode === 'number' ? event.exitCode : (event.isError ? 1 : 0);
    const usageLimit = parseProviderUsageLimit(event.usageLimit);
    // a limit refusal is reported as such: the gateway skips the engine until the reset, and holds nothing else against it
    void reportAidevOutcome({ exit_code: exitCode, session_id: event.sessionId ?? selectedSession?.id ?? null, ...(usageLimit ? { usage_limit: { type: usageLimit.type, resets_at: usageLimit.resetsAt ?? null } } : {}) });
    // A usage limit refused this run, so the work continues on the other engine
    // (claude ↔ codex) instead of stopping — this engine cannot answer again until
    // the window resets (E-03, no tap). handoffOnUsageLimit blocks instead if the
    // other engine is not logged in, rather than attempting a handoff that cannot work.
    const limitedSessionId = event.sessionId ?? selectedSession?.id ?? null;
    if (usageLimit && limitedSessionId && (event.provider === 'claude' || event.provider === 'codex')) {
      void handoffOnUsageLimitRef.current?.({ sessionId: limitedSessionId, blockedEngine: event.provider, reason: `${event.provider}_usage_limit:${usageLimit.type}` });
    }
    // the workbench opens a changed file and brings the right pane forward (C-10)
    announceRunComplete({ sessionId: event.sessionId ?? selectedSession?.id ?? null, exitCode, changedFiles: changedFilesSince(chatMessagesRef.current) });
    // the store applies the final assistant text on the same tick; read it after React commits
    setTimeout(() => { void agentCreationRef.current.onRunComplete(); }, 400);
  }), [reportAidevOutcome, selectedSession?.id, subscribe]);
  const { t } = useTranslation('chat');
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    clarify,
    releaseClarify,
    dismissClarify,
    sending,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });
  useEffect(() => { chatMessagesRef.current = chatMessages; handleVoiceTranscriptRef.current = handleVoiceTranscript; });
  // D-04: the catalog's "만들기" on a proposed domain sends the creation turn through this chat (needs a project)
  useEffect(() => {
    const onCompose = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      if (!selectedProject) { routingStore.patch({ oneShotCreate: null }); return; }
      handleVoiceTranscriptRef.current?.(text, true);
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, [selectedProject]);

  // E-03: one-tap follow-up for a failed run. A handoff opens a new session on the other engine in
  // this project; its brief is sent once that session is selected and the composer's provider has
  // caught up with it (so routing sees the right engine).
  const escalation = useEscalation({
    resend: (text) => { handleVoiceTranscriptRef.current?.(text, true); },
    openSession: (sessionId, engine, title) => {
      if (!selectedProject) return;
      handleSessionEstablished(sessionId, { provider: engine, project: selectedProject, summary: title });
    },
    getProjectPath: () => selectedProject?.fullPath || selectedProject?.path || null,
  });
  const takeHandoffRef = useRef(escalation.takeHandoff);
  useEffect(() => { takeHandoffRef.current = escalation.takeHandoff; });
  useEffect(() => { handoffOnUsageLimitRef.current = escalation.handoffOnUsageLimit; });
  // a chat handed off on a usage limit offers the way back once the engine it left is usable again
  const returnFromHandoff = useReturnFromHandoff(selectedSession?.id ?? null, (sessionId, engine, title) => {
    if (!selectedProject) return;
    handleSessionEstablished(sessionId, { provider: engine, project: selectedProject, summary: title });
  });
  useEffect(() => {
    const id = selectedSession?.id;
    if (!id || (selectedSession?.__provider && selectedSession.__provider !== provider)) return;
    const brief = takeHandoffRef.current(id);
    if (brief) setTimeout(() => { handleVoiceTranscriptRef.current?.(brief, true); }, 0);
  }, [provider, selectedSession?.id, selectedSession?.__provider]);

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await requestLatestMessages(selectedSession.id, isActive);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    const anchorId = message.transcriptAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: { model: currentProviderModel, effort: currentProviderEffort, permissionMode },
    });
    if (scheduled) {
      setInput('');
    }
  }, [currentProviderEffort, currentProviderModel, input, permissionMode, scheduleMessage, setInput]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Lets markdown image paths in the transcript resolve against this project.
  const markdownWorkspaceValue = useMemo(() => ({
    projectId: selectedProject?.projectId ?? null,
  }), [selectedProject?.projectId]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  // Nado AI Dev: while routing is on, the router picks model/effort for every command, so the composer
  // shows that (last plan, or "자동") instead of the provider default it would ignore; picking a model or
  // effort there pins it for the router (engine = this composer's provider) until reset to 자동.
  const routingState = useRoutingState();
  const routingOn = routingState.mode !== 'off';
  const pinnedModel = routingState.overrides.model;
  const pinnedEffort = routingState.overrides.effort;
  const lastPlan = routingState.last?.plan;
  // the router's effort levels are the engine's (the session's last model may accept none, e.g. haiku)
  const { ladder: effortLadder } = useEffortCap();
  const routedEffortOptions = useMemo(() => (effortLadder?.[provider === 'codex' ? 'codex' : 'claude'] ?? []).map((value) => ({ value })), [effortLadder, provider]);
  const modelRouting = routingOn ? {
    label: pinnedModel || pinnedEffort ? ['고정', pinnedModel, pinnedEffort ? `강도 ${pinnedEffort}` : null].filter(Boolean).join(' · ') : lastPlan?.model ? `자동 · ${lastPlan.model}${lastPlan.effort ? `/${lastPlan.effort}` : ''}` : '자동',
    detail: pinnedModel || pinnedEffort ? '선택한 모델·강도로 고정됨 (라우터 바에서 해제 가능)' : '라우터가 명령마다 작업에 맞는 모델·강도를 고릅니다',
    pinned: Boolean(pinnedModel || pinnedEffort),
    onReset: () => { const { model: _model, effort: _effort, ...rest } = routingStore.get().overrides; routingStore.patch({ overrides: rest }); },
  } : null;
  const selectComposerModel = useCallback((model: string) => {
    if (routingStore.get().mode === 'off') { void handleSelectComposerModel(model); return; }
    routingStore.setOverrides({ model, engine: provider === 'codex' ? 'codex' : 'claude' });
  }, [handleSelectComposerModel, provider]);
  const selectComposerEffort = useCallback((effort: string) => {
    if (routingStore.get().mode === 'off') { void handleSelectComposerEffort(effort); return; }
    if (effort === 'default') { const { effort: _effort, ...rest } = routingStore.get().overrides; routingStore.patch({ overrides: rest }); return; }
    routingStore.setOverrides({ effort });
  }, [handleSelectComposerEffort]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}>
          <ChatMessagesPane
            scrollContainerRef={scrollContainerRef}
            // Not redundant with the `scroll` listener. A first page is 20 rows,
            // tool results fold into their calls, and the "load earlier" link is
            // hidden while more pages exist — so a short transcript is often not
            // scrollable at all and never emits `scroll`. Wheel and touch are
            // then the only way to reach the top pager or the "load all" overlay.
            onWheel={handleScroll}
            onTouchMove={handleScroll}
            isLoadingSessionMessages={isLoadingSessionMessages}
            isProcessing={isProcessing}
            hasActivityIndicator={hasActivityIndicator}
            chatMessages={chatMessages}
            selectedSession={selectedSession}
            currentSessionId={currentSessionId}
            provider={provider}
            setProvider={setProvider}
            textareaRef={textareaRef}
            providerModels={providerModels}
            setProviderModel={setStoredProviderModel}
            providerModelCatalog={providerModelCatalog}
            providerModelActions={providerModelActions}
            providerModelsLoading={providerModelsLoading}
            tasksEnabled={tasksEnabled}
            isTaskMasterInstalled={isTaskMasterInstalled}
            onShowAllTasks={onShowAllTasks}
            setInput={setInput}
            isLoadingMoreMessages={isLoadingMoreMessages}
            hasMoreMessages={hasMoreMessages}
            totalMessages={totalMessages}
            sessionMessagesCount={chatMessages.length}
            visibleMessageCount={visibleMessageCount}
            visibleMessages={visibleMessages}
            loadEarlierMessages={loadEarlierMessages}
            loadAllMessages={loadAllMessages}
            allMessagesLoaded={allMessagesLoaded}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            showLoadAllOverlay={showLoadAllOverlay}
            createDiff={createDiff}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantToolPermission={handleGrantToolPermission}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            // Editing replaces the turn and everything after it, so it is only
            // offered when the session is idle — a half-truncated transcript with
            // a live stream writing into it is not recoverable.
            onEditMessage={supportsMessageEditing && !isProcessing ? beginEditMessage : undefined}
            onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
            onLoadFullTranscript={loadFullTranscript}
          />
        </MarkdownWorkspaceContext.Provider>

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          effort={modelRouting ? (pinnedEffort ?? 'default') : currentProviderEffort}
          availableEffortOptions={modelRouting ? routedEffortOptions : currentProviderEffortOptions}
          onSelectEffort={selectComposerEffort}
          model={modelRouting ? (pinnedModel ?? '') : currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={selectComposerModel}
          modelRouting={modelRouting}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
          {sending ? (
            <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm" role="status" data-testid="chat-sending">
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-hidden />
              <span className="shrink-0 text-muted-foreground">보내는 중 · agent 고르는 중…</span>
              <span className="min-w-0 flex-1 truncate">{sending}</span>
            </div>
          ) : null}
          {clarify ? <ClarifyPrompt key={clarify.decisionId} question={clarify.question} onAnswer={(answer) => releaseClarify(answer)} onProceed={() => releaseClarify(null)} onDismiss={dismissClarify} /> : null}
          <ReturnCard back={returnFromHandoff} />
          {routingState.verification ? <VerificationCard status={routingState.verification.status} result={routingState.verification.result} onDismiss={() => routingStore.patch({ verification: null })} /> : null}
          {escalation.escalation ? <EscalationCard next={escalation.escalation.next} label={escalation.label} busy={escalation.busy} error={escalation.error} onRun={() => { void escalation.run(); }} onDismiss={escalation.dismiss} /> : null}
          {agentCreation.pending ? <AgentCreateCard pending={agentCreation.pending} onApprove={(draft) => { void agentCreation.approve(draft); }} onSelfCheck={agentCreation.runSelfCheck} onDismiss={agentCreation.dismiss} /> : null}
          <AidevRouterBar sessionId={selectedSession?.id ?? null} />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
