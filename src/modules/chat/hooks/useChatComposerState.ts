import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { shouldAskClarify, useAidevRouting, usePrejudge, type AidevSendDecoration } from '@/modules/aidev-router';
import { api } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import type { CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionProcessing, ModelCommandData, QueuedDraft, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import {
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessages,
  subscribeToChatDrafts,
  writeDraftText,
  writeQueuedMessages,
  type StoredQueuedMessage,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Engine priority (2026-10-09): routing said a higher-priority engine is usable again for this (unpinned) chat.
   * The host continues the conversation there with this text; true when it did, so nothing is sent here.
   */
  onEngineSwitchBack?: (args: { sessionId: string; engine: 'claude' | 'codex'; fromEngine: 'claude' | 'codex'; text: string; reason: string }) => Promise<boolean>;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};






const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};


/**
 * The session's queue as the composer shows it. The store is the source of
 * truth (the server shortens it as it sends); browser File objects only exist
 * in this composer and are looked up by the turn's id for editing.
 */
const restoreQueuedDrafts = (sessionKey: string, files: Map<string, File[]>): QueuedDraft[] => (
  readQueuedMessages(sessionKey).map((saved, index) => {
    // A turn queued by an older client has no id; its place in line stands in.
    const id = saved.id ?? `queued-${index}`;
    return {
      id,
      content: saved.content,
      attachments: files.get(id) ?? [],
      uploadedAttachments: saved.attachments,
      options: saved.options,
    };
  })
);

const toStoredQueuedMessage = (draft: QueuedDraft): StoredQueuedMessage => ({
  id: draft.id,
  content: draft.content,
  options: draft.options,
  attachments: draft.uploadedAttachments,
});

const sameQueuedDrafts = (a: QueuedDraft[], b: QueuedDraft[]): boolean => (
  a.length === b.length
  && JSON.stringify(a.map(toStoredQueuedMessage)) === JSON.stringify(b.map(toStoredQueuedMessage))
);

const createQueuedMessageId = (): string => `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * How the user asked for a submit: `interrupt` cuts into the running turn
 * instead of queueing behind it; `queued` sends a turn taken out of the queue
 * (its text, already-uploaded files and the settings it was queued with)
 * instead of what is in the composer, which stays as it is.
 */
type SubmitOptions = { interrupt?: boolean; queued?: QueuedDraft };

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  onEngineSwitchBack,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);

  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      submitOptions?: SubmitOptions,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  // Browser File objects of turns queued from this composer, by turn id, so
  // editing a queued turn gets its files back. The store only keeps the
  // uploaded descriptors, which is all the server needs to send it.
  const queuedFilesRef = useRef<Map<string, File[]>>(new Map());
  // The open session's command queue, as rendered. A mirror of the draft
  // store (the one place queue edits are written), so the server shortening
  // the queue as it sends, and another device editing it, show up the same way.
  const [queuedDrafts, setQueuedDrafts] = useState<QueuedDraft[]>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return [];
    }
    // No files were queued from a composer that is only now mounting.
    return restoreQueuedDrafts(sessionKey, new Map());
  });

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  // Nado AI Dev routing: one gateway round-trip before the send decides the specialist
  // agent, engine and model tier for this turn (IMPLEMENTATION-PLAN §3.6). Failures
  // never block the send — the message goes out exactly as an unrouted send would.
  const { beforeSend: aidevBeforeSend } = useAidevRouting();
  // §3.1 clarify (C-09): a routed send held until the user adds the missing detail or lets it go; the command
  // stays in the composer, and the hold belongs to the chat it was typed in. `interrupt` remembers that the user
  // was cutting into the running turn, so the release still does.
  const [clarifyHold, setClarifyHold] = useState<{ sessionKey: string | null; text: string; decoration: AidevSendDecoration; uploadedAttachments: unknown[]; interrupt: boolean } | null>(null);
  // the hold being released: the next submit reuses its routing and uploads instead of doing both again
  const clarifyResumeRef = useRef<{ decoration: AidevSendDecoration; uploadedAttachments: unknown[] } | null>(null);
  // the command between Enter and its send (routing, uploads, a new session can take seconds): the composer clears at
  // once and shows it as "보내는 중", and a second Enter meanwhile is not a second send (it was: the same command went
  // out twice). The ref closes the gap before React re-renders.
  const sendingRef = useRef(false);
  const [sending, setSending] = useState<string | null>(null);
  // …and while the user is still typing, the specialist judge already looks at the draft
  usePrejudge(input, typeof selectedProject?.displayName === 'string' ? selectedProject.displayName : (typeof selectedProject?.name === 'string' ? selectedProject.name : null));

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      submitOptions?: SubmitOptions,
    ) => {
      event.preventDefault();
      const queued = submitOptions?.queued ?? null;
      const currentInput = queued ? queued.content : inputValueRef.current;
      const currentAttachments = queued ? [] : attachedFiles;
      const queuedUploadedAttachments = queued?.uploadedAttachments ?? [];
      const interrupt = submitOptions?.interrupt === true;
      if (
        (!currentInput.trim() && currentAttachments.length === 0 && queuedUploadedAttachments.length === 0)
        || !selectedProject
      ) {
        return;
      }
      // A queued turn sent early must not be queued again behind the running
      // turn; the "send now" action only fires when it can cut in.
      if (queued && isLoading && !interrupt) {
        return;
      }

      // A turn is already in flight and the user did not ask to cut in: add
      // this message to the back of the session's queue instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      if (isLoading && !interrupt) {
        const queuedSessionKey = sessionKey;
        if (!queuedSessionKey) {
          // A running turn always belongs to an established session.
          return;
        }

        const queuedOptions = buildSendOptions(currentInput);
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        const queuedId = createQueuedMessageId();
        queuedFilesRef.current.set(queuedId, currentAttachments);
        // Appended to whatever the store holds right now, not to this render's
        // list: the server may have sent the head during the upload.
        writeQueuedMessages(queuedSessionKey, [
          ...readQueuedMessages(queuedSessionKey),
          { id: queuedId, content: currentInput, options: queuedOptions, attachments: uploadedAttachments },
        ]);

        // Recorded under the session the message was queued FOR, and before
        // the session-switch return below — the queued text must be
        // recallable even when it dispatches without this composer.
        recordSentMessage(currentInput, queuedSessionKey);

        // The server owns dispatch after persistence. If the user changed
        // sessions during upload, the durable record is already enough; the
        // newly opened composer shows its own session's queue.
        if (sessionKeyRef.current !== queuedSessionKey) {
          return;
        }

        setInput('');
        inputValueRef.current = '';
        setAttachedFiles([]);
        setFileErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        if (draftScopeRef.current) {
          writeDraftText(draftScopeRef.current, '');
        }
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      if (sendingRef.current) return;
      sendingRef.current = true;
      setSending(currentInput);
      // the composer keeps what the user is typing when a queued turn is sent early
      if (!queued) {
        setInput('');
        inputValueRef.current = '';
      }
      // the text goes back into the composer when the send does not happen (error, or a clarify hold that edits it)
      const restoreInput = () => { setInput(currentInput); inputValueRef.current = currentInput; };
      // Replacing an already-sent message belongs to the composer's text, not to a queued turn sent early.
      const replacesAnchorId = queued ? null : editingAnchorId;
      try {
      const messageContent = currentInput;
      const resume = queued ? null : clarifyResumeRef.current;
      clarifyResumeRef.current = null;

      let uploadedAttachments = queued ? queuedUploadedAttachments : resume?.uploadedAttachments ?? [];
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          restoreInput();
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      // Routing (IMPLEMENTATION-PLAN §3.1) runs before a brand-new session is allocated: the plan's
      // engine decides the provider of that session (sessions are provider-bound), so a Codex plan
      // never lands on a Claude session with a Codex model — and vice versa.
      const aidevDecoration = resume ? resume.decoration : await aidevBeforeSend(messageContent, {
        sessionId: targetSessionId,
        provider,
        isNewSession: !targetSessionId,
        projectHint: typeof selectedProject?.displayName === 'string' ? selectedProject.displayName : (typeof selectedProject?.name === 'string' ? selectedProject.name : null),
        userPinnedModel: false,
      });
      // a new send supersedes a hold; a command missing essential detail waits for one line (ClarifyPrompt)
      setClarifyHold(null);
      // a turn that was already composed and queued is not held for a clarifying question
      if (!resume && !queued && shouldAskClarify(aidevDecoration)) {
        setClarifyHold({ sessionKey, text: messageContent, decoration: aidevDecoration, uploadedAttachments, interrupt });
        restoreInput();
        return;
      }
      // engine priority: the chat continues on the higher engine that is usable again (unless pinned)
      if (!resume && !queued && aidevDecoration?.switchBack && targetSessionId && onEngineSwitchBack && (provider === 'claude' || provider === 'codex')) {
        const moved = await onEngineSwitchBack({ sessionId: targetSessionId, engine: aidevDecoration.switchBack.engine, fromEngine: provider, text: messageContent, reason: aidevDecoration.switchBack.reason });
        if (moved) return;
      }
      const plannedEngine = aidevDecoration?.route.plan.engine;
      const sessionProvider: LLMProvider = !targetSessionId && (plannedEngine === 'claude' || plannedEngine === 'codex') ? plannedEngine : provider;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const response = await api.providers.createSession({
            provider: sessionProvider,
            projectPath: resolvedProjectPath,
            initialMessage: messageContent,
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          restoreInput();
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          restoreInput();
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider: sessionProvider,
          project: selectedProject,
          summary: createdSessionName,
        });
      }

      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
        // Tags this echo as the replacement, so the truncation the server
        // broadcasts a moment later cuts the turns being replaced without
        // taking the message the user just sent with them.
        ...(replacesAnchorId ? { replacesAnchorId } : {}),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // a queued turn goes out with the settings it was queued under
      const baseSendOptions = queued?.options ?? buildSendOptions(messageContent);
      const routedSendOptions = aidevDecoration
        ? {
          ...baseSendOptions,
          aidev: aidevDecoration.aidev,
          ...(aidevDecoration.model ? { model: aidevDecoration.model } : {}),
          ...(aidevDecoration.effort ? { effort: aidevDecoration.effort } : {}),
        }
        : baseSendOptions;

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      sendMessage({
        // Replacing an already-sent message is its own frame: it changes the
        // shape of the conversation, so it gets validated separately and can
        // report why it was refused.
        type: replacesAnchorId ? 'chat.edit-send' : 'chat.send',
        sessionId: targetSessionId,
        ...(replacesAnchorId ? { anchorId: replacesAnchorId } : {}),
        // Cutting in: the server aborts the running turn and starts this one
        // right behind it (a no-op when the turn finished meanwhile).
        ...(interrupt ? { interrupt: true } : {}),
        // A queued turn sent early: the server drops it from the stored queue,
        // so no copy of the queue saved from before can queue it again.
        ...(queued ? { queuedId: queued.id } : {}),
        content: messageContent,
        options: {
          ...routedSendOptions,
          attachments: uploadedAttachments,
        },
      });
      // Recorded under the (possibly just-allocated) session id, so the first
      // message of a new chat lands in the history of the session the user is
      // navigated to. Queued drafts were recorded when they were queued; the
      // consecutive-duplicate check keeps this second call a no-op.
      recordSentMessage(currentInput, targetSessionId);
      if (queued) {
        // nothing of the composer's own was sent
        return;
      }
      setEditingAnchorId(null);
      // the composer was cleared at Enter; what was typed since stays
      resetCommandMenuState();
      setAttachedFiles([]);
      setFileErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, inputValueRef.current);
      }
      } finally {
        sendingRef.current = false;
        setSending(null);
      }
    },
    [
      aidevBeforeSend,
      onEngineSwitchBack,
      selectedSession,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      recordSentMessage,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  /** Sends the held command — with the answer appended, or as it is (`null`) — on its original routing. */
  const releaseClarify = useCallback((answer: string | null) => {
    const hold = clarifyHold;
    if (!hold) return;
    setClarifyHold(null);
    clarifyResumeRef.current = { decoration: hold.decoration, uploadedAttachments: hold.uploadedAttachments };
    // the composer still holds the command (possibly touched up meanwhile)
    const base = inputValueRef.current.trim() ? inputValueRef.current : hold.text;
    const next = answer ? `${base.trimEnd()}\n\n(추가 정보) ${answer}` : base;
    setInput(next);
    inputValueRef.current = next;
    handleSubmitRef.current?.(createFakeSubmitEvent(), { interrupt: hold.interrupt });
  }, [clarifyHold, setInput]);
  const dismissClarify = useCallback(() => setClarifyHold(null), []);

  // The rendered queue follows the store: the open session's queue on a
  // session switch, and every later change to it (a turn queued here, the
  // server sending the head, an edit on another device).
  useEffect(() => {
    const sync = () => {
      const next = sessionKey ? restoreQueuedDrafts(sessionKey, queuedFilesRef.current) : [];
      setQueuedDrafts((previous) => (sameQueuedDrafts(previous, next) ? previous : next));
    };
    sync();
    return subscribeToChatDrafts(sync);
  }, [sessionKey]);

  // The server owns sending. While the queue is visible, re-read it from the
  // server periodically so the cards disappear as their turns go out.
  useEffect(() => {
    if (!sessionKey || queuedDrafts.length === 0) {
      return;
    }
    const timer = setInterval(() => void hydrateChatDrafts(), 5_000);
    return () => clearInterval(timer);
  }, [queuedDrafts.length, sessionKey]);

  // A turn starting or ending is when the server takes the next one off the
  // queue: reload it then, so a sent turn's card does not linger for a poll.
  useEffect(() => {
    if (sessionKey && readQueuedMessages(sessionKey).length > 0) {
      void hydrateChatDrafts();
    }
  }, [isLoading, sessionKey]);

  /** Takes one queued turn out of the line and back into the composer. */
  const editQueuedDraft = useCallback((id: string) => {
    const draft = queuedDrafts.find((candidate) => candidate.id === id);
    if (!draft || !sessionKey) {
      return;
    }
    writeQueuedMessages(sessionKey, queuedDrafts.filter((candidate) => candidate.id !== id).map(toStoredQueuedMessage));
    setInput(draft.content);
    inputValueRef.current = draft.content;
    setAttachedFiles(draft.attachments);
    textareaRef.current?.focus();
  }, [queuedDrafts, sessionKey, setInput]);

  const deleteQueuedDraft = useCallback((id: string) => {
    if (!sessionKey) {
      return;
    }
    queuedFilesRef.current.delete(id);
    writeQueuedMessages(sessionKey, queuedDrafts.filter((candidate) => candidate.id !== id).map(toStoredQueuedMessage));
  }, [queuedDrafts, sessionKey]);

  /** Moves one queued turn one place up (-1) or down (+1); the server sends the head first. */
  const moveQueuedDraft = useCallback((id: string, direction: -1 | 1) => {
    const from = queuedDrafts.findIndex((candidate) => candidate.id === id);
    const to = from + direction;
    if (!sessionKey || from < 0 || to < 0 || to >= queuedDrafts.length) {
      return;
    }
    const next = [...queuedDrafts];
    [next[from], next[to]] = [next[to], next[from]];
    writeQueuedMessages(sessionKey, next.map(toStoredQueuedMessage));
  }, [queuedDrafts, sessionKey]);

  /**
   * Sends one queued turn right away: it leaves the queue and goes out with
   * its own text, uploads and settings, cutting into the running turn. While
   * a send is already under way, or the running turn cannot be interrupted,
   * the turn stays where it is.
   */
  const sendQueuedDraftNow = useCallback((id: string) => {
    const draft = queuedDrafts.find((candidate) => candidate.id === id);
    if (!draft || !sessionKey || sendingRef.current || (isLoading && !canAbortSession)) {
      return;
    }
    queuedFilesRef.current.delete(id);
    writeQueuedMessages(sessionKey, queuedDrafts.filter((candidate) => candidate.id !== id).map(toStoredQueuedMessage));
    void handleSubmit(createFakeSubmitEvent(), { interrupt: isLoading, queued: draft });
  }, [canAbortSession, handleSubmit, isLoading, queuedDrafts, sessionKey]);

  /**
   * Sends now, cutting into the running turn, instead of queueing behind it.
   * A turn that cannot be interrupted right now is queued instead, so nothing
   * typed is lost.
   */
  const handleInterruptSubmit = useCallback(
    (event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => {
      void handleSubmit(event, { interrupt: canAbortSession });
    },
    [canAbortSession, handleSubmit],
  );

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        const modifier = event.ctrlKey || event.metaKey;
        // While a turn runs, the send key queues and one step up cuts in:
        // Enter / ⌘Enter when Enter sends, Ctrl+Enter / Ctrl+Shift+Enter when
        // Ctrl+Enter sends. Idle, the modifier combos all just send.
        if (modifier && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event, { interrupt: canAbortSession && !sendByCtrlEnter });
        } else if (modifier && event.shiftKey && sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event, { interrupt: canAbortSession });
        } else if (!event.shiftKey && !modifier && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      canAbortSession,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [setInput]);

  return {
    input,
    setInput,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
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
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    handleInterruptSubmit,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    moveQueuedDraft,
    sendQueuedDraftNow,
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
    clarify: clarifyHold && clarifyHold.sessionKey === sessionKey ? { question: clarifyHold.decoration.route.scope.clarify_question ?? null, decisionId: clarifyHold.decoration.route.decision_id } : null,
    releaseClarify,
    dismissClarify,
    /** the command being sent (routing / upload / new session) — shown under the composer until it goes out */
    sending,
  };
}
