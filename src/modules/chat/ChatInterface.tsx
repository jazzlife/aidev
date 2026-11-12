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
  SessionEstablishedOptions,
  SessionNavigationOptions,
} from '@/shared/types';
import type { AidevEngine } from '@/shared/types';
import { AIDEV_ENGINES, ENGINE_LABELS } from '@/shared/constants';
import { isAidevEngine, parseProviderUsageLimit } from '@/shared/utils';
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
import { AidevRouterBar, aidevApi, chatRouteOf, isPolicyProvider, ClarifyPrompt, announceRunComplete, changedFilesSince, EscalationCard, routingStore, sessionKey, useAidevRouting, useEffortCap, useEscalation, useReturnFromHandoff, useRoutingState, ReturnCard, VerificationCard } from '@/modules/aidev-router';
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
  // Nado AI Dev: a provider `complete` event ends the routed run started by the last send (§3.8). A missing specialist
  // is designed by the gateway out of band (§3.7), never as a turn of this chat.
  const { reportOutcome: reportAidevOutcome } = useAidevRouting();
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const handleVoiceTranscriptRef = useRef<((text: string, send?: boolean) => void) | null>(null);
  // Assigned from useEscalation below; the composer hook that calls it is created before it exists.
  const switchBackRef = useRef<((args: { sessionId: string; engine: AidevEngine; fromEngine: AidevEngine; text: string; reason: string }) => Promise<boolean>) | null>(null);
  // Assigned from useEscalation below; the complete subscriber is installed before it exists.
  const handoffOnUsageLimitRef = useRef<((args: { sessionId: string; blockedEngine: AidevEngine; reason: string }) => Promise<unknown>) | null>(null);
  // C-06: the chat on show here has no unread news on the phone either — on open, on coming back to the window,
  // on leaving, and shortly after a run here ends (the runtime's event reaches the gateway around the `complete`)
  const seenSessionId = isActive ? selectedSession?.id ?? null : null;
  const seenSessionIdRef = useRef(seenSessionId);
  useEffect(() => { seenSessionIdRef.current = seenSessionId; });
  useEffect(() => {
    if (!seenSessionId) return undefined;
    const seen = () => { if (document.visibilityState === 'visible') void aidevApi.notifySeen(seenSessionId).catch(() => undefined); };
    seen();
    document.addEventListener('visibilitychange', seen);
    return () => { document.removeEventListener('visibilitychange', seen); seen(); };
  }, [seenSessionId]);
  useEffect(() => subscribe((event) => {
    if (event.kind !== 'complete') return;
    const exitCode = typeof event.exitCode === 'number' ? event.exitCode : (event.isError ? 1 : 0);
    const usageLimit = parseProviderUsageLimit(event.usageLimit);
    // Any chat's routed run is reported, matched to that chat's own run (a chat left mid-run still gets its outcome,
    // verdict and follow-up, kept for when it is opened again). A `superseded` end is the user cutting in: the next
    // turn is already routed, so it is not this run's end to report.
    // a limit refusal is reported as such: the gateway skips the engine until the reset, and holds nothing else against it
    if (!event.superseded) void reportAidevOutcome({ exit_code: exitCode, session_id: event.sessionId ?? selectedSession?.id ?? null, ...(usageLimit ? { usage_limit: { type: usageLimit.type, resets_at: usageLimit.resetsAt ?? null } } : {}) });
    if (event.sessionId && selectedSession?.id && event.sessionId !== selectedSession.id) return;
    const finishedId = event.sessionId ?? selectedSession?.id ?? null;
    if (finishedId && finishedId === seenSessionIdRef.current) {
      setTimeout(() => {
        if (seenSessionIdRef.current === finishedId && document.visibilityState === 'visible') void aidevApi.notifySeen(finishedId).catch(() => undefined);
      }, 3000);
    }
    // A usage limit refused this run, so the work continues on the next provider of
    // the work order instead of stopping — this engine cannot answer again until
    // the window resets (E-03, no tap). handoffOnUsageLimit blocks instead if no
    // other provider is usable, rather than attempting a handoff that cannot work.
    const limitedSessionId = event.sessionId ?? selectedSession?.id ?? null;
    if (usageLimit && limitedSessionId && isAidevEngine(event.provider)) {
      void handoffOnUsageLimitRef.current?.({ sessionId: limitedSessionId, blockedEngine: event.provider, reason: `${event.provider}_usage_limit:${usageLimit.type}` });
    }
    // the workbench opens a changed file and brings the right pane forward (C-10)
    announceRunComplete({ sessionId: event.sessionId ?? selectedSession?.id ?? null, exitCode, changedFiles: changedFilesSince(chatMessagesRef.current) });
  }), [reportAidevOutcome, selectedSession?.id, subscribe]);
  const { t } = useTranslation('chat');
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

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
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  // A user who moved to another chat meanwhile is not pulled back to it: the
  // session is only registered (it shows in the sidebar) and runs there.
  const handleSessionEstablished = useCallback((sessionId: string, context: SessionEstablishedContext, options?: SessionEstablishedOptions) => {
    // the conversation goes on there, so the model/effort/agent picked for it go along
    routingStore.adoptSession(sessionId, options?.open !== false);
    onSessionEstablished?.(sessionId, context);
    if (options?.open === false) {
      return;
    }
    setCurrentSessionId(sessionId);
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
    handleInterruptSubmit,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    moveQueuedDraft,
    sendQueuedDraftNow,
    runHeldDraftNow,
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
    // engine priority: assigned from useEscalation below (the composer hook is created before it)
    onEngineSwitchBack: (args) => switchBackRef.current?.(args) ?? Promise.resolve(false),
  });
  useEffect(() => { chatMessagesRef.current = chatMessages; handleVoiceTranscriptRef.current = handleVoiceTranscript; });

  // E-03: one-tap follow-up for a failed run. A handoff opens a new session on the other engine in
  // this project; its brief is sent once that session is selected and the composer's provider has
  // caught up with it (so routing sees the right engine).
  const escalation = useEscalation({
    sessionId: currentSessionId || selectedSession?.id || null,
    resend: (text) => { handleVoiceTranscriptRef.current?.(text, true); },
    openSession: (sessionId, engine, title) => {
      if (!selectedProject) return;
      handleSessionEstablished(sessionId, { provider: engine, project: selectedProject, summary: title });
    },
    getProjectPath: () => selectedProject?.fullPath || selectedProject?.path || null,
  });
  const takeHandoffRef = useRef(escalation.takeHandoff);
  useEffect(() => { takeHandoffRef.current = escalation.takeHandoff; });
  useEffect(() => { handoffOnUsageLimitRef.current = escalation.handoffOnUsageLimit; switchBackRef.current = escalation.switchBack; });
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
  // this chat's own verdict; a verification of a run in another chat waits there
  const openChatId = currentSessionId || selectedSession?.id || null;
  const openVerification = routingState.verifications[sessionKey(openChatId)] ?? null;
  // a model, effort, engine or agent picked by hand holds for its chat only: another chat is routed afresh
  useEffect(() => { routingStore.followSession(selectedSession?.id ?? null); }, [selectedSession?.id]);
  // the router's effort levels are the pinned engine's (the session's last model may accept none, e.g. haiku); the
  // ladder lists the engines this account routes to
  const { ladder: effortLadder } = useEffortCap();
  // Routing covers chats on the engines the account routes to. A chat on another provider (an old Cursor session, or
  // OpenCode where no administrator enabled it) is sent unrouted and keeps its own model picker. Until the engines are
  // known, Claude and Codex count as routed (every account has had them) and OpenCode does not.
  const routedProvider = isPolicyProvider(provider) && (effortLadder ? Boolean(effortLadder[provider]) : provider !== 'opencode');
  const routingOn = routingState.mode !== 'off' && routedProvider;
  const pinnedModel = routingState.overrides.model;
  const pinnedEffort = routingState.overrides.effort;
  // this chat's own last plan: a chat not routed yet on this page shows "자동"
  const lastPlan = chatRouteOf(routingState, selectedSession?.id)?.route.plan;
  const composerEngine: AidevEngine = isAidevEngine(provider) ? provider : 'claude';
  const routedEngine = routingState.overrides.engine ?? composerEngine;
  const routedEffortOptions = useMemo(() => (effortLadder?.[routedEngine] ?? []).map((value) => ({ value })), [effortLadder, routedEngine]);
  // A model of another engine pins the chat there; a chat already bound to this engine is then handed off on its next
  // send. One group per engine the account routes to (the effort ladder lists those).
  const otherEngineModels = useMemo(() => (routingOn ? AIDEV_ENGINES
    .filter((engine) => engine !== composerEngine && effortLadder?.[engine] && providerModelCatalog[engine]?.OPTIONS?.length)
    .map((engine) => ({
      heading: `${ENGINE_LABELS[engine]} 모델${currentSessionId || selectedSession?.id ? ' · 다음 명령부터 새 채팅으로 인계' : ''}`,
      options: providerModelCatalog[engine]!.OPTIONS,
      onSelectModel: (model: string) => routingStore.setOverrides({ model, engine }),
    })) : []), [composerEngine, currentSessionId, effortLadder, providerModelCatalog, routingOn, selectedSession?.id]);
  const modelRouting = routingOn ? {
    label: pinnedModel || pinnedEffort ? ['고정', pinnedModel, pinnedEffort ? `강도 ${pinnedEffort}` : null].filter(Boolean).join(' · ') : lastPlan?.model ? `자동 · ${lastPlan.model}${lastPlan.effort ? `/${lastPlan.effort}` : ''}` : '자동',
    detail: pinnedModel || pinnedEffort ? '선택한 모델·강도로 고정됨 (라우터 바에서 해제 가능)' : '라우터가 명령마다 작업에 맞는 모델·강도를 고릅니다',
    pinned: Boolean(pinnedModel || pinnedEffort),
    onReset: () => { const { model: _model, effort: _effort, ...rest } = routingStore.get().overrides; routingStore.patch({ overrides: rest }); },
  } : null;
  const selectComposerModel = useCallback((model: string) => {
    if (!routingOn) { void handleSelectComposerModel(model); return; }
    routingStore.setOverrides({ model, engine: composerEngine });
  }, [composerEngine, handleSelectComposerModel, routingOn]);
  const selectComposerEffort = useCallback((effort: string) => {
    if (!routingOn) { void handleSelectComposerEffort(effort); return; }
    if (effort === 'default') { const { effort: _effort, ...rest } = routingStore.get().overrides; routingStore.patch({ overrides: rest }); return; }
    routingStore.setOverrides({ effort });
  }, [handleSelectComposerEffort, routingOn]);

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
          otherEngineModels={otherEngineModels}
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
          onInterruptSubmit={handleInterruptSubmit}
          isDragActive={isDragActive}
          queuedDrafts={queuedDrafts}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          onMoveQueuedDraft={moveQueuedDraft}
          onSendQueuedDraftNow={sendQueuedDraftNow}
          onRunHeldDraftNow={runHeldDraftNow}
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
          {openVerification ? <VerificationCard status={openVerification.status} result={openVerification.result} onDismiss={() => routingStore.setFor('verifications', openChatId, null)} /> : null}
          {escalation.escalation ? <EscalationCard next={escalation.escalation.next} label={escalation.label} busy={escalation.busy} error={escalation.error} onRun={() => { void escalation.run(); }} onDismiss={escalation.dismiss} /> : null}
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
