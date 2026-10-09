import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { Clock, Download, Gauge, GitBranch, MoreHorizontal, Search } from 'lucide-react';

import { api, grantClaudeToolPermission, buildClaudeToolPermissionEntry, useChatRealtimeHandlers, useSessionStore, useWebSocket, type LLMProvider, type NormalizedMessage, type PendingPermissionRequest, type ProjectSession } from '@/modules/chat-core';
import { AgentCreateCard, aidevApi, routingStore, shouldAskClarify, useAgentCreation, useAidevRouting, useEscalation, usePrejudge, useReturnFromHandoff, useRoutingState, ReturnCard, VerificationCard, type AidevSendDecoration, type Engine } from '@/modules/aidev-router';
import { parseProviderUsageLimit } from '@/shared/utils';
import { Composer } from '@m/components/Composer';
import { MessageList } from '@m/components/MessageList';
import { PermissionSheet, type PermissionDecision } from '@m/components/PermissionSheet';
import { PermissionModeSheet } from '@m/components/PermissionModeSheet';
import { RouterChip } from '@m/components/RouterChip';
import { RunFeedback } from '@m/components/RunFeedback';
import { SessionResults } from '@m/components/SessionResults';
import { TopBar } from '@m/components/TopBar';
import { usePreviewList } from '@/modules/remote-preview';
import { useDebugSessions } from '@/modules/remote-debug';
import { ConversationActions, sheetButton, type ConversationChange } from '@m/components/ConversationActions';
import { ScheduleSheet, useScheduledMessages } from '@m/components/ScheduleSheet';
import { ComposerAssist } from '@m/components/ComposerAssist';
import { CommandResultSheet, type CommandResult } from '@m/components/CommandResultSheet';
import { MicButton } from '@m/components/MicButton';
import { GitSheet } from '@m/components/GitSheet';
import { TodoProgress, latestTodos } from '@m/components/ToolCards';
import { trackCommandUse, type SlashCommand } from '@m/lib/composerAssist';
import { exportConversation } from '@m/lib/exportMarkdown';
import { MessageActions, type MessageTarget } from '@m/components/MessageActions';
import { EscalationPrompt } from '@m/components/EscalationPrompt';
import { ProjectPicker, readLastProject, type PickedProject } from '@m/components/ProjectPicker';
import { ClarifyPrompt } from '@m/components/ClarifyPrompt';
import { DiffPeek } from '@m/components/DiffPeek';
import { FilePeek } from '@m/components/FilePeek';
import type { FileEdit, FileRef } from '@m/lib/peek';
import { useGo, useParent } from '@m/lib/nav';
import { setCurrentConversation, setCurrentProject } from '@m/lib/current';
import { MODE_LABELS, adoptDraftPermissionMode, buildSendOptions, uploadAttachments, useCapsMap, usePermissionMode, type UploadedAttachment } from '@m/lib/chatOptions';

type SessionMeta = { id: string; provider: LLMProvider; projectId: string; projectPath: string; projectName: string; title: string };
/** A send waiting for the agent to finish (typed while it answered). */
type Queued = { text: string; files: File[] };
/** What the router (and the title) reads for a send of attachments only: the server takes an empty text, the router cannot. */
const attachmentLabel = (names: string[]) => `첨부 ${names.length}개 (${names.slice(0, 3).join(', ')}${names.length > 3 ? ' …' : ''})`;
const isImage = (a: { mimeType?: string; name?: string; path?: string }) => Boolean(a.mimeType?.startsWith('image/')) || /\.(gif|jpe?g|png|webp|heic)$/i.test(a.name || a.path || '');
const PROVIDER_KEY = 'm.provider';
const readProvider = (): LLMProvider => { try { const value = localStorage.getItem(PROVIDER_KEY); return value === 'codex' ? 'codex' : 'claude'; } catch { return 'claude'; } };

/**
 * Mobile chat: one session (or a brand-new one), streaming transcript, tool permission prompts,
 * routing chip and run feedback. Protocol handling comes entirely from chat-core; this screen owns
 * only its view state.
 */
export function ChatScreen() {
  const { sessionId: routeSessionId } = useParams();
  const navigate = useGo();
  const { ws, sendMessage, subscribe, isConnected } = useWebSocket();
  const sessionStore = useSessionStore();
  const { beforeSend, reportOutcome } = useAidevRouting();
  // engine priority switch-back, assigned from useEscalation below (send is defined before it)
  const switchBackRef = useRef<((args: { sessionId: string; engine: Engine; fromEngine: Engine; text: string; reason: string }) => Promise<boolean>) | null>(null);
  // the verifier's verdict for the last routed run (card above the composer)
  const routingState = useRoutingState();
  const [draft, setDraft] = useState('');
  // where the cursor is in the draft (the `/` and `@` suggestions read the text before it)
  const [cursor, setCursor] = useState(0);
  // a `/` command's result on show (or a project command waiting for confirmation)
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  // why the last dictation gave no text
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const [meta, setMeta] = useState<SessionMeta | null>(null);
  // D-04: "만들기" on a proposal opens this new chat with the creation turn; it goes out once a project is chosen
  const location = useLocation();
  // a new chat started from a project screen starts in that project
  const [project, setProject] = useState<PickedProject | null>(() => (location.state as { project?: PickedProject } | null)?.project ?? readLastProject());
  const composeText = (location.state as { compose?: string } | null)?.compose ?? null;
  const composeRef = useRef<string | null>(composeText);
  const [pickingProject, setPickingProject] = useState(() => Boolean(composeText) && !readLastProject());
  const [busy, setBusy] = useState(false);
  // Enter → sent: the command shown as "보내는 중" while routing / a new session take their time; the ref blocks a repeat
  const sendingRef = useRef(false);
  const [sending, setSending] = useState<string | null>(null);
  // a send that did not happen puts its text back in the composer
  const [restore, setRestore] = useState<{ text: string; files?: File[]; n: number } | null>(null);
  // a send typed while the agent answered: it goes by itself when the answer ends (and nothing waits for approval)
  const [queued, setQueued] = useState<Queued | null>(null);
  // the permission request whose sheet was closed without an answer (a banner reopens it)
  const [laterRequestId, setLaterRequestId] = useState<string | null>(null);
  // the permission-mode sheet (from the composer's pill)
  const [modeSheet, setModeSheet] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  // the conversation's context use ({used, total}): fetched on open and after each run, updated live while it runs
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  // the scheduling sheet: making one (the send button held, with the text to send) or the list (conversation sheet)
  // the git sheet of the conversation's project ("변경 사항")
  const [gitSheet, setGitSheet] = useState(false);
  const [scheduleSheet, setScheduleSheet] = useState<{ mode: 'create' | 'list'; text: string } | null>(null);
  const [lastRunFinished, setLastRunFinished] = useState<number | null>(null);
  // the message held down (its sheet: copy, read aloud, edit, fork here)
  const [messageTarget, setMessageTarget] = useState<MessageTarget | null>(null);
  // the conversation sheet (⋯ in the top bar)
  const [conversationSheet, setConversationSheet] = useState(false);
  // a sent message being edited: the next send replaces it (and what followed it)
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);
  // a fork or other conversation action that failed, shown above the composer
  const [actionError, setActionError] = useState<string | null>(null);
  // previews an agent opens while the chat is open get a banner; this is the newest one already seen/dismissed
  const [previewSeen, setPreviewSeen] = useState(() => Date.now());
  const { previews } = usePreviewList(true, 8000);
  const agentPreview = previews.find((p) => p.by === 'agent' && p.createdAt > previewSeen && !p.error) ?? null;
  // a debug session an agent starts (remote_debug_start) gets the same kind of banner
  const [debugSeen, setDebugSeen] = useState(() => Date.now());
  const { sessions: debugSessions } = useDebugSessions(true, 8000);
  const agentDebug = debugSessions.find((d) => d.origin === 'agent' && d.createdAt > debugSeen && d.state !== 'ended' && d.state !== 'failed') ?? null;
  // C-05 peeks: the file sheet (null file = search) and the diff of one file tool call
  const [filePeek, setFilePeek] = useState<{ open: boolean; file: FileRef | null; fromSearch: boolean }>({ open: false, file: null, fromSearch: false });
  const [diffPeek, setDiffPeek] = useState<FileEdit | null>(null);
  // §3.1 clarify: a routed command held back until the user adds the missing detail or lets it go as is
  const [clarify, setClarify] = useState<{ text: string; decoration: AidevSendDecoration; attachments: UploadedAttachment[]; previews: string[] } | null>(null);
  // object URLs of picked images shown in the phone's own copy of a sent message, per echo; let go once the server's
  // copy replaces the echo (`seen` first, so an echo not rendered yet is not mistaken for a replaced one) or on leaving
  const echoPreviewsRef = useRef(new Map<string, { urls: string[]; seen: boolean }>());
  // previews made for a send that has not become an echo yet (routing, a held clarify)
  const pendingPreviewsRef = useRef(new Set<string>());
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const lastSeqRef = useRef(new Map<string, number>());
  const statusCheckSentAtRef = useRef(new Map<string, number>());

  const sessionId = meta?.id ?? null;
  usePrejudge(draft, meta?.projectName || project?.displayName || null);
  const provider: LLMProvider = meta?.provider ?? readProvider();
  const caps = useCapsMap();
  const permission = usePermissionMode(sessionId, provider, caps);
  const selectedSession: ProjectSession | null = meta ? { id: meta.id, provider: meta.provider, __provider: meta.provider } : null;

  // ---- resolve the session named in the URL ------------------------------------------------
  useEffect(() => {
    if (!routeSessionId) { setMeta(null); return; }
    let cancelled = false;
    setLoadError(null);
    // a command held for clarification belongs to the chat it was typed in
    setClarify(null);
    api.sessionDetails(routeSessionId).then(async (response) => {
      const payload = await response.json() as { data?: { sessionId?: string; provider?: string; summary?: string; project?: { projectId?: string; fullPath?: string; path?: string; displayName?: string } | null } };
      if (cancelled) return;
      const data = payload.data;
      if (!response.ok || !data) { setLoadError('세션을 찾을 수 없습니다'); return; }
      const resolvedProvider: LLMProvider = data.provider === 'codex' ? 'codex' : 'claude';
      setMeta({ id: routeSessionId, provider: resolvedProvider, projectId: data.project?.projectId || '', projectPath: data.project?.fullPath || data.project?.path || '', projectName: data.project?.displayName || '', title: data.summary || '' });
    }).catch(() => { if (!cancelled) setLoadError('세션을 불러오지 못했습니다'); });
    return () => { cancelled = true; };
  }, [routeSessionId]);

  // the drawer's "현재 작업": this conversation, and its project is where the next new conversation starts
  useEffect(() => {
    if (!meta) return;
    setCurrentConversation({ sessionId: meta.id, title: meta.title, projectId: meta.projectId, projectName: meta.projectName, provider: meta.provider });
    if (meta.projectId) setCurrentProject({ projectId: meta.projectId, displayName: meta.projectName, fullPath: meta.projectPath });
  }, [meta]);

  useEffect(() => {
    if (!sessionId) { setTokenBudget(null); return undefined; }
    let alive = true;
    api.providers.sessionTokenUsage(sessionId).then(async (response) => {
      const body = await response.json().catch(() => null) as { data?: Record<string, unknown> } | null;
      if (alive) setTokenBudget(response.ok ? body?.data ?? null : null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [sessionId, lastRunFinished]);
  const used = typeof tokenBudget?.used === 'number' ? tokenBudget.used : null;
  const total = typeof tokenBudget?.total === 'number' && tokenBudget.total > 0 ? tokenBudget.total : null;
  const contextShare = used !== null && total ? used / total : null;
  const scheduled = useScheduledMessages(meta?.id ?? null);

  // ---- history + live subscription ---------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;
    sessionStore.setActiveSession(sessionId);
    void sessionStore.fetchFromServer(sessionId);
  }, [sessionId, sessionStore]);
  // C-06: an open conversation has no unread news — on open, when leaving, and shortly after a run here ends
  // (the runtime's event reaches the gateway around the same time as the chat's `complete`)
  useEffect(() => {
    if (!sessionId) return undefined;
    const seen = () => { void aidevApi.notifySeen(sessionId).catch(() => undefined); };
    seen();
    return seen;
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId || !lastRunFinished) return undefined;
    const timer = setTimeout(() => { void aidevApi.notifySeen(sessionId).catch(() => undefined); }, 3000);
    return () => clearTimeout(timer);
  }, [sessionId, lastRunFinished]);
  useEffect(() => {
    if (!sessionId || !ws || !isConnected) return;
    statusCheckSentAtRef.current.set(sessionId, Date.now());
    sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: lastSeqRef.current.get(sessionId) ?? 0 }] });
  }, [sessionId, ws, isConnected, sendMessage]);

  const requestLatestMessages = useCallback(async (id: string) => { await sessionStore.refreshLatestFromServer(id); }, [sessionStore]);
  useChatRealtimeHandlers({
    isActive: true, subscribe, provider, selectedSession, currentSessionId: sessionId, setTokenBudget,
    pendingPermissionRequests, setPendingPermissionRequests, streamTimerRef, accumulatedStreamRef, lastSeqRef, statusCheckSentAtRef,
    onSessionProcessing: (id) => { if (!id || id === sessionId) setBusy(true); },
    onSessionIdle: (id) => { if (!id || id === sessionId) setBusy(false); },
    requestLatestMessages, sessionStore,
  });
  // Agent creation flow (§3.7): the architect's draft is read from the newest assistant message.
  const sendRef = useRef<(text: string) => void>(() => undefined);
  const agentCreation = useAgentCreation({
    getLastAssistantText: () => { const list = sessionId ? sessionStore.getMessages(sessionId) : []; for (let index = list.length - 1; index >= 0; index -= 1) { const message = list[index]; if (message.kind === 'text' && message.role === 'assistant' && message.content) return message.content; } return null; },
    resend: (text) => sendRef.current(text),
  });
  const agentCreationRef = useRef(agentCreation);
  useEffect(() => { agentCreationRef.current = agentCreation; });
  // Run outcome signal (§3.8): the provider's `complete` event ends the routed run.
  useEffect(() => subscribe((event) => {
    if (event.kind !== 'complete' || (event.sessionId && event.sessionId !== sessionId)) return;
    const exitCode = typeof event.exitCode === 'number' ? event.exitCode : (event.isError ? 1 : 0);
    // a limit refusal is reported as such: the gateway skips the engine until the reset and proposes the other engine
    const usageLimit = parseProviderUsageLimit(event.usageLimit);
    void reportOutcome({ exit_code: exitCode, session_id: event.sessionId ?? sessionId, ...(usageLimit ? { usage_limit: { type: usageLimit.type, resets_at: usageLimit.resetsAt ?? null } } : {}) });
    setLastRunFinished(Date.now());
    setTimeout(() => { void agentCreationRef.current.onRunComplete(); }, 400);
  }), [subscribe, sessionId, reportOutcome]);

  // ---- send ------------------------------------------------------------------------------------
  // Creates the session for a new chat (on the routed engine) and sends the turn with the routing decoration.
  const dispatch = useCallback(async (text: string, decoration: AidevSendDecoration | null, attachments: UploadedAttachment[] = [], previews: string[] = []) => {
    let target = meta;
    if (!target && project) {
      // The router's engine choice decides the provider of a brand-new session (§0: sessions are provider-bound).
      const engine = (decoration?.route.plan.engine ?? provider) as Engine;
      try {
        const response = await api.providers.createSession({ provider: engine, projectPath: project.fullPath, initialMessage: text || attachmentLabel(attachments.map((a) => a.name ?? '파일')) });
        const body = await response.json() as { data?: { sessionId?: string } };
        if (!response.ok || !body.data?.sessionId) throw new Error('세션을 만들지 못했습니다');
        target = { id: body.data.sessionId, provider: engine, projectId: project.projectId, projectPath: project.fullPath, projectName: project.displayName, title: (text || attachmentLabel(attachments.map((a) => a.name ?? '파일'))).slice(0, 60) };
        try { localStorage.setItem(PROVIDER_KEY, engine); } catch { /* ignore */ }
        adoptDraftPermissionMode(target.id);
        setMeta(target);
        navigate(`/session/${encodeURIComponent(target.id)}`);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : '세션 생성 실패');
        return false;
      }
    }
    if (!target) return false;
    const label = text || attachmentLabel(attachments.map((a) => a.name ?? a.path?.split(/[\\/]/).pop() ?? '파일'));
    // the phone's own copy shows the picked images at once (object URLs of the files just sent)
    const images = attachments.map((a, index) => ({ a, preview: previews[index] })).filter(({ a }) => isImage(a)).map(({ a, preview }) => ({ path: a.path, name: a.name, ...(preview ? { data: preview } : {}) }));
    const files = attachments.filter((a) => !isImage(a));
    // an edit replaces a sent message: the server rewinds to it, and the echo says which one it stands in for
    const anchorId = target.id === meta?.id ? editingAnchorId : null;
    const echo: NormalizedMessage = { id: `local_${Date.now()}`, sessionId: target.id, timestamp: new Date().toISOString(), provider: target.provider, kind: 'text', role: 'user', content: text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(anchorId ? { replacesAnchorId: anchorId } : {}) };
    sessionStore.appendRealtime(target.id, echo);
    const shown = previews.filter(Boolean);
    if (shown.length) {
      echoPreviewsRef.current.set(echo.id, { urls: shown, seen: false });
      for (const url of shown) pendingPreviewsRef.current.delete(url);
    }
    setBusy(true);
    setLastRunFinished(null);
    setEditingAnchorId(null);
    sendMessage({
      type: anchorId ? 'chat.edit-send' : 'chat.send', sessionId: target.id, content: text, ...(anchorId ? { anchorId } : {}),
      options: {
        // the conversation's permission mode (a new chat: the draft's) and the saved allow/deny rules, as the workbench sends them
        ...buildSendOptions(target.provider, permission.mode),
        ...(decoration?.model ? { model: decoration.model } : {}),
        ...(decoration?.effort ? { effort: decoration.effort } : {}),
        ...(decoration ? { aidev: decoration.aidev } : {}),
        sessionSummary: label.slice(0, 80),
        attachments,
      },
    });
    return true;
  }, [editingAnchorId, meta, navigate, permission.mode, project, provider, sendMessage, sessionStore]);

  const send = useCallback(async (text: string, files: File[] = []) => {
    // a send in flight (routing can take seconds): a repeated tap is not a second send
    if (busy || sendingRef.current) return;
    if (!meta && !project) { setPickingProject(true); setRestore({ text, files, n: Date.now() }); return; }
    setClarify(null);
    sendingRef.current = true;
    // attachments only: the router and the title read a short description of them
    const routed = text || attachmentLabel(files.map((file) => file.name));
    setSending(routed);
    let previews: string[] = [];
    try {
      let attachments: UploadedAttachment[] = [];
      if (files.length) {
        try { attachments = await uploadAttachments(files); } catch (error) {
          setLoadError(error instanceof Error ? error.message : '첨부를 올리지 못했습니다');
          setRestore({ text, files, n: Date.now() });
          return;
        }
        previews = files.map((file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : ''));
        for (const url of previews) if (url) pendingPreviewsRef.current.add(url);
      }
      const decoration = await beforeSend(routed, { sessionId: meta?.id ?? null, provider, isNewSession: !meta, projectHint: (meta?.projectName || project?.displayName) ?? null, userPinnedModel: false });
      // read before the clarify guard: its type predicate narrows `decoration` to null afterwards
      const switchBack = decoration?.switchBack ?? null;
      // §3.1: essential detail missing from a deeper command → ask once (not for agent creation or the app's re-sends)
      if (shouldAskClarify(decoration)) { setClarify({ text, decoration, attachments, previews }); return; }
      // engine priority: the chat continues on the higher engine that is usable again (unless pinned)
      if (switchBack && meta && (meta.provider === 'claude' || meta.provider === 'codex') && !attachments.length) {
        const moved = await switchBackRef.current?.({ sessionId: meta.id, engine: switchBack.engine, fromEngine: meta.provider, text: routed, reason: switchBack.reason });
        if (moved) return;
      }
      if (!(await dispatch(text, decoration, attachments, previews))) {
        for (const url of previews) if (url) { URL.revokeObjectURL(url); pendingPreviewsRef.current.delete(url); }
        setRestore({ text, files, n: Date.now() });
      }
    } finally {
      sendingRef.current = false;
      setSending(null);
    }
  }, [beforeSend, busy, dispatch, meta, project, provider, setClarify]);

  useEffect(() => { sendRef.current = (text) => { void send(text); }; }, [send]);
  // the queued send goes once the answer has ended and nothing waits for the user's approval
  useEffect(() => {
    if (!queued || busy || sendingRef.current || pendingPermissionRequests.length) return;
    setQueued(null);
    void send(queued.text, queued.files);
  }, [busy, pendingPermissionRequests.length, queued, send]);
  useEffect(() => {
    const text = composeRef.current;
    if (!text || meta || !isConnected || !project) return;
    composeRef.current = null;
    void send(text);
  }, [isConnected, meta, project, send]);
  // leaving before it went out disarms the proposal, so it cannot hijack a later send
  useEffect(() => () => { if (composeRef.current) routingStore.patch({ oneShotCreate: null }); }, []);
  // E-03: one-tap follow-up for a failed run; a handoff opens the new session on the other engine
  // and its brief is sent there once the screen has resolved that session.
  const escalation = useEscalation({
    resend: (text) => sendRef.current(text),
    openSession: (id) => navigate(`/session/${encodeURIComponent(id)}`),
    getProjectPath: () => meta?.projectPath || project?.fullPath || null,
  });
  const takeHandoffRef = useRef(escalation.takeHandoff);
  useEffect(() => { takeHandoffRef.current = escalation.takeHandoff; switchBackRef.current = escalation.switchBack ?? null; });
  // a chat handed off on a usage limit offers the way back once the engine it left is usable again
  const returnFromHandoff = useReturnFromHandoff(sessionId, (id) => navigate(`/session/${encodeURIComponent(id)}`));
  useEffect(() => {
    if (!meta?.id || meta.id !== routeSessionId) return;
    const brief = takeHandoffRef.current(meta.id);
    if (brief) setTimeout(() => sendRef.current(brief), 0);
  }, [meta?.id, routeSessionId]);
  const abort = useCallback(() => { if (sessionId) sendMessage({ type: 'chat.abort', sessionId }); }, [sendMessage, sessionId]);
  const decidePermission = useCallback((requestId: string, decision: PermissionDecision) => {
    sendMessage({ type: 'chat.permission-response', requestId, allow: decision.allow, updatedInput: decision.updatedInput, message: decision.message, rememberEntry: decision.rememberEntry });
    setPendingPermissionRequests((previous) => previous.filter((request) => request.requestId !== requestId));
  }, [sendMessage]);
  // "항상 허용": the rule joins the server-synced allow-list (the workbench's too), and every waiting request it covers goes
  const alwaysAllow = useCallback((request: PendingPermissionRequest, entry: string) => {
    grantClaudeToolPermission(entry);
    const covered = pendingPermissionRequests.filter((other) => other.requestId === request.requestId || buildClaudeToolPermissionEntry(other.toolName, other.input) === entry);
    for (const other of covered) decidePermission(other.requestId, { allow: true, rememberEntry: entry });
  }, [decidePermission, pendingPermissionRequests]);
  const waiting = pendingPermissionRequests[0] ?? null;
  const sheetRequest = waiting && waiting.requestId !== laterRequestId ? waiting : null;

  const providerCaps = caps?.[provider];
  const canRewind = (target: MessageTarget | null) => Boolean(target && target.message.role === 'user' && target.message.transcriptAnchorId && meta);
  const editMessage = (target: MessageTarget) => {
    setEditingAnchorId(target.message.transcriptAnchorId ?? null);
    setRestore({ text: target.text, n: Date.now() });
  };
  const forkHere = async (target: MessageTarget) => {
    if (!meta || !target.message.transcriptAnchorId) return;
    setActionError(null);
    try {
      const response = await api.forkSession(meta.id, { upToAnchorId: target.message.transcriptAnchorId });
      const body = await response.json().catch(() => ({})) as { data?: { sessionId?: string }; message?: string };
      if (!response.ok || !body.data?.sessionId) throw new Error(body.message || `실패했습니다 (${response.status})`);
      navigate(`/session/${encodeURIComponent(body.data.sessionId)}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '분기하지 못했습니다');
    }
  };
  const conversationChanged = (change: ConversationChange) => {
    if (change.kind === 'renamed') setMeta((current) => (current ? { ...current, title: change.title } : current));
    else if (change.kind === 'forked') navigate(`/session/${encodeURIComponent(change.forkId)}`);
    else if (change.kind === 'hidden' || change.kind === 'deleted') navigate(meta?.projectId ? `/projects/${encodeURIComponent(meta.projectId)}` : '/');
  };

  const assistProject = meta?.projectId ? { projectId: meta.projectId, fullPath: meta.projectPath } : !meta && project ? { projectId: project.projectId, fullPath: project.fullPath } : null;
  const runCommand = async (command: SlashCommand) => {
    if (!assistProject) return;
    trackCommandUse(assistProject.projectId, command.name);
    setRestore({ text: '', n: Date.now() });
    setActionError(null);
    try {
      const response = await api.commands.execute({
        commandName: command.name, commandPath: command.path, args: [],
        context: { projectPath: assistProject.fullPath, projectId: assistProject.projectId, sessionId: meta?.id ?? null, provider, model: null, tokenUsage: tokenBudget },
      });
      const body = await response.json().catch(() => ({})) as { type?: string; action?: string; data?: Record<string, unknown>; content?: string; hasBashCommands?: boolean; message?: string; error?: string };
      if (!response.ok) throw new Error(body.message || body.error || `실패했습니다 (${response.status})`);
      if (body.type === 'builtin') {
        if (body.action === 'config') navigate('/settings');
        else setCommandResult({ type: 'builtin', action: body.action ?? '', data: body.data });
      } else if (body.type === 'custom') {
        if (body.hasBashCommands) setCommandResult({ type: 'custom', command: command.name, content: body.content ?? '', hasBashCommands: true });
        else void send(body.content ?? '');
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '명령을 실행하지 못했습니다');
    }
  };

  const messages = sessionId ? sessionStore.getMessages(sessionId) : [];
  const todos = useMemo(() => latestTodos(messages), [messages]);
  // an echo's image previews go once the server's copy has replaced it
  useEffect(() => {
    for (const [echoId, entry] of echoPreviewsRef.current) {
      const present = messages.some((message) => message.id === echoId);
      if (present) entry.seen = true;
      else if (entry.seen) { for (const url of entry.urls) URL.revokeObjectURL(url); echoPreviewsRef.current.delete(echoId); }
    }
  }, [messages]);
  useEffect(() => () => {
    for (const entry of echoPreviewsRef.current.values()) for (const url of entry.urls) URL.revokeObjectURL(url);
    for (const url of pendingPreviewsRef.current) URL.revokeObjectURL(url);
    echoPreviewsRef.current.clear(); pendingPreviewsRef.current.clear();
  }, []);
  const slot = sessionId ? sessionStore.getSessionSlot(sessionId) : undefined;
  const peekProject = meta?.projectId ? { projectId: meta.projectId, projectPath: meta.projectPath } : !meta && project ? { projectId: project.projectId, projectPath: project.fullPath } : null;
  const openFile = (file: FileRef | null) => { setDiffPeek(null); setFilePeek({ open: true, file, fromSearch: false }); };
  const title = meta?.title || (routeSessionId ? '대화' : '새 대화');
  // up = the conversation's project (its list of conversations); a new chat without a project yet: home
  const projectId = meta?.projectId || (!meta ? project?.projectId : '') || '';
  const projectPath = projectId ? `/projects/${encodeURIComponent(projectId)}` : null;
  useParent(projectPath ?? (routeSessionId ? '/projects' : '/'));
  const subtitle = meta ? `${meta.provider}${meta.projectName ? ` · ${meta.projectName}` : ''}` : (project ? `${provider} · ${project.displayName}` : '프로젝트를 선택하세요');

  return (
    <div className="m-app">
      <TopBar title={title} subtitle={subtitle} back onSubtitle={projectPath ? () => navigate(projectPath) : undefined} right={<div className="flex items-center">{peekProject ? <button type="button" aria-label="파일 찾기" onClick={() => openFile(null)} className="m-touch flex items-center justify-center rounded-full text-muted"><Search size={19} /></button> : null}{!meta ? <button type="button" className="text-[13px] text-accent px-3 m-touch" onClick={() => setPickingProject(true)}>프로젝트</button> : null}{meta ? <button type="button" aria-label="대화 메뉴" onClick={() => setConversationSheet(true)} className="m-touch flex items-center justify-center rounded-full text-muted"><MoreHorizontal size={20} /></button> : null}</div>} />
      {agentPreview ? (
        <div className="flex items-center gap-2 border-b border-line bg-accent/10 px-4 py-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate">미리보기가 열렸습니다 · {agentPreview.label ?? agentPreview.targetName}:{agentPreview.port}</span>
          <button type="button" className="m-touch rounded-lg bg-accent px-3 py-1 text-accent-ink" onClick={() => navigate(`/preview?p=${agentPreview.targetId}:${agentPreview.port}`)}>보기</button>
          <button type="button" aria-label="닫기" className="m-touch px-1 text-muted" onClick={() => setPreviewSeen(agentPreview.createdAt)}>✕</button>
        </div>
      ) : null}
      {agentDebug ? (
        <div className="flex items-center gap-2 border-b border-line bg-warn/10 px-4 py-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate">agent가 디버깅 중 · {agentDebug.program?.split(/[\\/]/).pop() ?? agentDebug.module ?? agentDebug.adapter} ({agentDebug.targetName})</span>
          <button type="button" className="m-touch rounded-lg bg-accent px-3 py-1 text-accent-ink" onClick={() => navigate(`/debug?s=${agentDebug.id}`)}>보기</button>
          <button type="button" aria-label="닫기" className="m-touch px-1 text-muted" onClick={() => setDebugSeen(agentDebug.createdAt)}>✕</button>
        </div>
      ) : null}
      {loadError ? <div className="px-4 py-2 text-danger text-sm">{loadError}</div> : null}
      {!isConnected ? <div className="px-4 py-1 text-[12px] text-warn bg-warn/10">연결 중…</div> : null}
      <MessageList messages={messages} projectPath={peekProject?.projectPath ?? null} loading={slot?.status === 'loading'} hasMore={Boolean(slot?.hasMore)} onLoadOlder={() => (sessionId ? sessionStore.fetchMore(sessionId) : Promise.resolve())} onMessageLongPress={(text, message) => setMessageTarget({ text, message })} onPeekFile={openFile} onPeekDiff={setDiffPeek} footer={sessionId ? <SessionResults sessionId={sessionId} refreshKey={lastRunFinished ?? 0} /> : null} />
      <MessageActions target={messageTarget} onClose={() => setMessageTarget(null)}
        canEdit={canRewind(messageTarget) && Boolean(messageTarget?.text) && Boolean(providerCaps?.supportsMessageEditing) && !busy}
        canFork={canRewind(messageTarget) && Boolean(providerCaps?.supportsSessionForking)}
        onEdit={editMessage} onFork={(target) => { void forkHere(target); }} />
      <ConversationActions target={conversationSheet && meta ? { sessionId: meta.id, title: meta.title, provider: meta.provider } : null} onClose={() => setConversationSheet(false)} onChange={conversationChanged}
        extra={(
          <>
            {used !== null && !tokenBudget?.unsupported ? (
              <div className={`${sheetButton} active:bg-transparent`} data-testid="token-usage">
                <Gauge size={18} /> 컨텍스트<span className="ml-auto text-[13px] text-muted">{used.toLocaleString()}{total ? ` / ${total.toLocaleString()} (${Math.round((contextShare ?? 0) * 100)}%)` : ''}</span>
              </div>
            ) : null}
            <button type="button" className={sheetButton} onClick={() => { setConversationSheet(false); void exportConversation(meta?.title ?? '대화', messages).catch(() => setActionError('내보내지 못했습니다')); }}><Download size={18} /> 내보내기<span className="ml-auto text-[12px] text-muted">Markdown</span></button>
            {meta?.projectId ? <button type="button" className={sheetButton} onClick={() => { setConversationSheet(false); setGitSheet(true); }}><GitBranch size={18} /> 변경 사항<span className="ml-auto text-[12px] text-muted">커밋·푸시</span></button> : null}
            <button type="button" className={sheetButton} onClick={() => { setConversationSheet(false); setScheduleSheet({ mode: 'list', text: '' }); }}><Clock size={18} /> 예약된 메시지<span className="ml-auto text-[13px] text-muted">{scheduled.pending.length}</span></button>
          </>
        )} />
      <GitSheet open={gitSheet} onClose={() => setGitSheet(false)} project={meta?.projectId ? { projectId: meta.projectId, displayName: meta.projectName } : null} provider={provider} />
      <ScheduleSheet mode={scheduleSheet?.mode ?? null} text={scheduleSheet?.text ?? ''} scheduled={scheduled.pending} onClose={() => setScheduleSheet(null)}
        onSchedule={async (at) => {
          // the send options of a send now (mode and saved rules); model and effort are the router's when it goes
          await scheduled.schedule(scheduleSheet?.text ?? '', at, { ...buildSendOptions(provider, permission.mode), sessionSummary: (scheduleSheet?.text ?? '').slice(0, 80) });
          setRestore({ text: '', n: Date.now() });
        }}
        onCancel={scheduled.cancel} />
      {actionError ? <div className="px-4 py-1 text-[13px] text-danger" role="alert">{actionError}</div> : null}
      {agentCreation.pending ? <div className="m-scroll max-h-[45dvh]"><AgentCreateCard compact pending={agentCreation.pending} onApprove={(draft) => { void agentCreation.approve(draft); }} onSelfCheck={agentCreation.runSelfCheck} onDismiss={agentCreation.dismiss} /></div> : null}
      {!busy ? <ReturnCard compact back={returnFromHandoff} /> : null}
      {routingState.verification && !busy ? <VerificationCard compact status={routingState.verification.status} result={routingState.verification.result} onDismiss={() => routingStore.patch({ verification: null })} /> : null}
      {escalation.escalation && !busy ? <EscalationPrompt next={escalation.escalation.next} label={escalation.label} busy={escalation.busy} error={escalation.error} onRun={() => { void escalation.run(); }} onDismiss={escalation.dismiss} /> : null}
      {lastRunFinished && !busy ? <RunFeedback key={lastRunFinished} onFeedback={(value) => { void reportOutcome({ user_feedback: value }); }} /> : null}
      {clarify ? <ClarifyPrompt key={clarify.decoration.route.decision_id} text={clarify.text || attachmentLabel(clarify.attachments.map((a) => a.name ?? '파일'))} question={clarify.decoration.route.scope.clarify_question} onProceed={() => { setClarify(null); void dispatch(clarify.text, clarify.decoration, clarify.attachments, clarify.previews); }} onAnswer={(answer) => { setClarify(null); void dispatch(`${clarify.text}\n\n(추가 정보) ${answer}`, clarify.decoration, clarify.attachments, clarify.previews); }} /> : null}
      <RouterChip sessionId={sessionId} />
      {sending ? (
        <div className="mx-3 mb-1 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[13px]" role="status" data-testid="chat-sending">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-hidden />
          <span className="shrink-0 text-muted">보내는 중…</span>
          <span className="min-w-0 flex-1 truncate">{sending}</span>
        </div>
      ) : null}
      {queued ? (
        <div className="mx-3 mb-1 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13px]" data-testid="chat-queued">
          <span className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[11px] text-muted">대기 중</span>
          <span className="min-w-0 flex-1 truncate">{queued.text}{queued.files.length ? ` · 첨부 ${queued.files.length}` : ''}</span>
          <button type="button" className="shrink-0 px-1 text-accent" onClick={() => { setRestore({ text: queued.text, files: queued.files, n: Date.now() }); setQueued(null); }}>수정</button>
          <button type="button" className="shrink-0 px-1 text-muted" onClick={() => setQueued(null)}>취소</button>
        </div>
      ) : null}
      {contextShare !== null && contextShare >= 0.8 ? <div className="mx-3 mb-1 rounded-lg bg-warn/10 px-3 py-1.5 text-[12px] text-warn" role="status" data-testid="context-warning">컨텍스트 {Math.round(contextShare * 100)}% 사용 · 곧 자동으로 요약됩니다</div> : null}
      {waiting && !sheetRequest ? (
        <button type="button" onClick={() => setLaterRequestId(null)} className="mx-3 mb-1 flex items-center gap-2 rounded-xl border border-warn/50 bg-warn/10 px-3 py-2 text-left text-[13px]" data-testid="permission-waiting">
          <span className="min-w-0 flex-1 truncate">{waiting.toolName === 'AskUserQuestion' ? 'agent가 답을 기다립니다' : waiting.toolName === 'ExitPlanMode' ? '계획 승인을 기다립니다' : `${waiting.toolName} 허용을 기다립니다`}</span>
          <span className="shrink-0 text-accent">열기</span>
        </button>
      ) : null}
      <TodoProgress todos={todos} />
      {voiceError ? <div className="px-4 py-1 text-[13px] text-danger" role="alert">{voiceError}</div> : null}
      <ComposerAssist draft={draft} cursor={cursor} project={assistProject} provider={provider} onInsert={(text) => setRestore({ text, n: Date.now() })} onCommand={(command) => { void runCommand(command); }} />
      <Composer busy={busy} restore={restore} disabled={!isConnected} onDraftChange={(text, at) => { setDraft(text); setCursor(at); }}
        extra={<MicButton disabled={!isConnected} onError={setVoiceError} onText={(text) => setRestore({ text: draft.trim() ? `${draft.trimEnd()} ${text}` : text, n: Date.now() })} />}
        onSend={(text, files) => {
          if (sendingRef.current) return false;
          // answering: the send waits its turn (typed again: added to the waiting one)
          if (busy) { setQueued((prev) => (prev ? { text: `${prev.text}\n\n${text}`, files: [...prev.files, ...files] } : { text, files })); return true; }
          void send(text, files); return true;
        }}
        onAbort={abort} placeholder={meta ? undefined : '무엇을 만들까요?'}
        mode={{ label: MODE_LABELS[permission.mode]?.short ?? permission.mode, onOpen: () => setModeSheet(true) }}
        editing={editingAnchorId ? { onCancel: () => { setEditingAnchorId(null); setRestore({ text: '', n: Date.now() }); } } : null}
        onSchedule={meta ? (text, files) => {
          if (files.length) { setActionError('예약 메시지에는 첨부를 넣을 수 없습니다'); return; }
          setActionError(null);
          setScheduleSheet({ mode: 'create', text });
        } : undefined} />
      <PermissionSheet request={sheetRequest} provider={provider} onDecide={decidePermission} onAlwaysAllow={alwaysAllow} onLater={() => setLaterRequestId(waiting?.requestId ?? null)} />
      <CommandResultSheet result={commandResult} onClose={() => setCommandResult(null)} onSend={(content) => { void send(content); }} />
      <PermissionModeSheet open={modeSheet} onClose={() => setModeSheet(false)} modes={permission.modes} mode={permission.mode} onChoose={permission.choose} />
      <FilePeek open={filePeek.open} onClose={() => setFilePeek({ open: false, file: null, fromSearch: false })} project={peekProject} file={filePeek.file} fromSearch={filePeek.fromSearch} onFile={(file) => setFilePeek({ open: true, file, fromSearch: file !== null })} />
      <DiffPeek edit={diffPeek} onClose={() => setDiffPeek(null)} onOpenFile={(path) => openFile({ path, line: null })} projectPath={peekProject?.projectPath ?? null} />
      <ProjectPicker open={pickingProject} onClose={() => setPickingProject(false)} onPick={(picked) => { setProject(picked); setPickingProject(false); }} />
    </div>
  );
}
