import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search } from 'lucide-react';

import { api, useChatRealtimeHandlers, useSessionStore, useWebSocket, type LLMProvider, type NormalizedMessage, type PendingPermissionRequest, type ProjectSession } from '@/modules/chat-core';
import { AgentCreateCard, useAgentCreation, useAidevRouting, useEscalation, usePrejudge, type AidevSendDecoration, type Engine } from '@/modules/aidev-router';
import { Composer } from '@m/components/Composer';
import { MessageList } from '@m/components/MessageList';
import { PermissionSheet } from '@m/components/PermissionSheet';
import { RouterChip } from '@m/components/RouterChip';
import { RunFeedback } from '@m/components/RunFeedback';
import { RemoteMenu } from '@m/components/RemoteMenu';
import { SessionResults } from '@m/components/SessionResults';
import { TopBar } from '@m/components/TopBar';
import { usePreviewList } from '@/modules/remote-preview';
import { useDebugSessions } from '@/modules/remote-debug';
import { BottomSheet } from '@m/components/BottomSheet';
import { EscalationPrompt } from '@m/components/EscalationPrompt';
import { ProjectPicker, readLastProject, type PickedProject } from '@m/components/ProjectPicker';
import { ClarifyPrompt } from '@m/components/ClarifyPrompt';
import { DiffPeek } from '@m/components/DiffPeek';
import { FilePeek } from '@m/components/FilePeek';
import type { FileEdit, FileRef } from '@m/lib/peek';

type SessionMeta = { id: string; provider: LLMProvider; projectId: string; projectPath: string; projectName: string; title: string };
const PROVIDER_KEY = 'm.provider';
const readProvider = (): LLMProvider => { try { const value = localStorage.getItem(PROVIDER_KEY); return value === 'codex' ? 'codex' : 'claude'; } catch { return 'claude'; } };

/**
 * Mobile chat: one session (or a brand-new one), streaming transcript, tool permission prompts,
 * routing chip and run feedback. Protocol handling comes entirely from chat-core; this screen owns
 * only its view state.
 */
export function ChatScreen() {
  const { sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const { ws, sendMessage, subscribe, isConnected } = useWebSocket();
  const sessionStore = useSessionStore();
  const { beforeSend, reportOutcome } = useAidevRouting();
  const [draft, setDraft] = useState('');

  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [project, setProject] = useState<PickedProject | null>(() => readLastProject());
  const [pickingProject, setPickingProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [lastRunFinished, setLastRunFinished] = useState<number | null>(null);
  const [copyText, setCopyText] = useState<string | null>(null);
  // previews an agent opens while the chat is open get a banner; this is the newest one already seen/dismissed
  const [previewSeen, setPreviewSeen] = useState(() => Date.now());
  const { previews } = usePreviewList(true, 8000);
  const agentPreview = previews.find((p) => p.by === 'agent' && p.createdAt > previewSeen && !p.error) ?? null;
  // a debug session an agent starts (remote_debug_start) gets the same kind of banner
  const [debugSeen, setDebugSeen] = useState(() => Date.now());
  const { sessions: debugSessions } = useDebugSessions(true, 8000);
  const agentDebug = debugSessions.find((d) => d.origin === 'agent' && d.createdAt > debugSeen && d.state !== 'ended' && d.state !== 'failed') ?? null;
  const [copied, setCopied] = useState(false);
  // C-05 peeks: the file sheet (null file = search) and the diff of one file tool call
  const [filePeek, setFilePeek] = useState<{ open: boolean; file: FileRef | null; fromSearch: boolean }>({ open: false, file: null, fromSearch: false });
  const [diffPeek, setDiffPeek] = useState<FileEdit | null>(null);
  // §3.1 clarify: a routed command held back until the user adds the missing detail or lets it go as is
  const [clarify, setClarify] = useState<{ text: string; decoration: AidevSendDecoration } | null>(null);
  const copyMessage = async () => {
    if (!copyText) return;
    try { await navigator.clipboard.writeText(copyText); }
    catch {
      // older WebViews: a temporary textarea (selection is allowed in text fields)
      const area = document.createElement('textarea'); area.value = copyText; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
    }
    setCopied(true); setTimeout(() => { setCopied(false); setCopyText(null); }, 700);
  };
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const lastSeqRef = useRef(new Map<string, number>());
  const statusCheckSentAtRef = useRef(new Map<string, number>());

  const sessionId = meta?.id ?? null;
  usePrejudge(draft, meta?.projectName || project?.displayName || null);
  const provider: LLMProvider = meta?.provider ?? readProvider();
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

  // ---- history + live subscription ---------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;
    sessionStore.setActiveSession(sessionId);
    void sessionStore.fetchFromServer(sessionId);
  }, [sessionId, sessionStore]);
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
    void reportOutcome({ exit_code: exitCode, session_id: event.sessionId ?? sessionId });
    setLastRunFinished(Date.now());
    setTimeout(() => { void agentCreationRef.current.onRunComplete(); }, 400);
  }), [subscribe, sessionId, reportOutcome]);

  // ---- send ------------------------------------------------------------------------------------
  // Creates the session for a new chat (on the routed engine) and sends the turn with the routing decoration.
  const dispatch = useCallback(async (text: string, decoration: AidevSendDecoration | null) => {
    let target = meta;
    if (!target && project) {
      // The router's engine choice decides the provider of a brand-new session (§0: sessions are provider-bound).
      const engine = (decoration?.route.plan.engine ?? provider) as Engine;
      try {
        const response = await api.providers.createSession({ provider: engine, projectPath: project.fullPath, initialMessage: text });
        const body = await response.json() as { data?: { sessionId?: string } };
        if (!response.ok || !body.data?.sessionId) throw new Error('세션을 만들지 못했습니다');
        target = { id: body.data.sessionId, provider: engine, projectId: project.projectId, projectPath: project.fullPath, projectName: project.displayName, title: text.slice(0, 60) };
        try { localStorage.setItem(PROVIDER_KEY, engine); } catch { /* ignore */ }
        setMeta(target);
        navigate(`/session/${encodeURIComponent(target.id)}`, { replace: true });
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : '세션 생성 실패');
        return;
      }
    }
    if (!target) return;
    const echo: NormalizedMessage = { id: `local_${Date.now()}`, sessionId: target.id, timestamp: new Date().toISOString(), provider: target.provider, kind: 'text', role: 'user', content: text };
    sessionStore.appendRealtime(target.id, echo);
    setBusy(true);
    setLastRunFinished(null);
    sendMessage({
      type: 'chat.send', sessionId: target.id, content: text,
      options: {
        permissionMode: 'default',
        ...(decoration?.model ? { model: decoration.model } : {}),
        ...(decoration?.effort ? { effort: decoration.effort } : {}),
        ...(decoration ? { aidev: decoration.aidev } : {}),
        sessionSummary: text.slice(0, 80),
      },
    });
  }, [meta, navigate, project, provider, sendMessage, sessionStore]);

  /** `askClarify: false` for the app's own re-sends (creation, escalation, handoff) — the user already chose. */
  const send = useCallback(async (text: string, askClarify = true) => {
    if (busy) return;
    if (!meta && !project) { setPickingProject(true); return; }
    setClarify(null);
    const decoration = await beforeSend(text, { sessionId: meta?.id ?? null, provider, isNewSession: !meta, projectHint: (meta?.projectName || project?.displayName) ?? null, userPinnedModel: false });
    // §3.1: essential detail missing from a deeper command → ask once (agent creation asks its own questions)
    if (askClarify && decoration?.route.scope.ask_clarify && decoration.route.decision !== 'create') { setClarify({ text, decoration }); return; }
    await dispatch(text, decoration);
  }, [beforeSend, busy, dispatch, meta, project, provider, setClarify]);

  useEffect(() => { sendRef.current = (text) => { void send(text, false); }; }, [send]);
  // E-03: one-tap follow-up for a failed run; a handoff opens the new session on the other engine
  // and its brief is sent there once the screen has resolved that session.
  const escalation = useEscalation({
    resend: (text) => sendRef.current(text),
    openSession: (id) => navigate(`/session/${encodeURIComponent(id)}`),
    getProjectPath: () => meta?.projectPath || project?.fullPath || null,
  });
  const takeHandoffRef = useRef(escalation.takeHandoff);
  useEffect(() => { takeHandoffRef.current = escalation.takeHandoff; });
  useEffect(() => {
    if (!meta?.id || meta.id !== routeSessionId) return;
    const brief = takeHandoffRef.current(meta.id);
    if (brief) setTimeout(() => sendRef.current(brief), 0);
  }, [meta?.id, routeSessionId]);
  const abort = useCallback(() => { if (sessionId) sendMessage({ type: 'chat.abort', sessionId }); }, [sendMessage, sessionId]);
  const decidePermission = useCallback((requestId: string, allow: boolean) => {
    sendMessage({ type: 'chat.permission-response', requestId, allow });
    setPendingPermissionRequests((previous) => previous.filter((request) => request.requestId !== requestId));
  }, [sendMessage]);

  const messages = sessionId ? sessionStore.getMessages(sessionId) : [];
  const slot = sessionId ? sessionStore.getSessionSlot(sessionId) : undefined;
  const peekProject = meta?.projectId ? { projectId: meta.projectId, projectPath: meta.projectPath } : !meta && project ? { projectId: project.projectId, projectPath: project.fullPath } : null;
  const openFile = (file: FileRef | null) => { setDiffPeek(null); setFilePeek({ open: true, file, fromSearch: false }); };
  const title = meta?.title || (routeSessionId ? '대화' : '새 대화');
  const subtitle = meta ? `${meta.provider}${meta.projectName ? ` · ${meta.projectName}` : ''}` : (project ? `${provider} · ${project.displayName}` : '프로젝트를 선택하세요');

  return (
    <div className="m-app">
      <TopBar title={title} subtitle={subtitle} back="/" right={<div className="flex items-center">{peekProject ? <button type="button" aria-label="파일 찾기" onClick={() => openFile(null)} className="m-touch flex items-center justify-center rounded-full text-muted"><Search size={19} /></button> : null}<RemoteMenu />{!meta ? <button type="button" className="text-[13px] text-accent px-3 m-touch" onClick={() => setPickingProject(true)}>프로젝트</button> : null}</div>} />
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
      <MessageList messages={messages} loading={slot?.status === 'loading'} onMessageLongPress={(text) => { setCopied(false); setCopyText(text); }} onPeekFile={openFile} onPeekDiff={setDiffPeek} footer={sessionId ? <SessionResults sessionId={sessionId} refreshKey={lastRunFinished ?? 0} /> : null} />
      <BottomSheet open={copyText !== null} onClose={() => setCopyText(null)} title="메시지">
        <div className="text-[13px] text-muted line-clamp-4 whitespace-pre-wrap mb-3">{copyText}</div>
        <button type="button" className="w-full h-12 rounded-xl bg-accent text-accent-ink text-[15px] font-medium" onClick={() => { void copyMessage(); }}>{copied ? '복사했습니다' : '복사'}</button>
      </BottomSheet>
      {agentCreation.pending ? <div className="m-scroll max-h-[45dvh]"><AgentCreateCard compact pending={agentCreation.pending} onApprove={(draft) => { void agentCreation.approve(draft); }} onSelfCheck={agentCreation.runSelfCheck} onDismiss={agentCreation.dismiss} /></div> : null}
      {escalation.escalation && !busy ? <EscalationPrompt next={escalation.escalation.next} label={escalation.label} busy={escalation.busy} error={escalation.error} onRun={() => { void escalation.run(); }} onDismiss={escalation.dismiss} /> : null}
      {lastRunFinished && !busy ? <RunFeedback key={lastRunFinished} onFeedback={(value) => { void reportOutcome({ user_feedback: value }); }} /> : null}
      {clarify ? <ClarifyPrompt key={clarify.decoration.route.decision_id} text={clarify.text} question={clarify.decoration.route.scope.clarify_question} onProceed={() => { setClarify(null); void dispatch(clarify.text, clarify.decoration); }} onAnswer={(answer) => { setClarify(null); void dispatch(`${clarify.text}\n\n(추가 정보) ${answer}`, clarify.decoration); }} /> : null}
      <RouterChip sessionId={sessionId} />
      <Composer busy={busy} disabled={!isConnected} onDraftChange={setDraft} onSend={(text) => { void send(text); }} onAbort={abort} placeholder={meta ? undefined : '무엇을 만들까요?'} />
      <PermissionSheet request={pendingPermissionRequests[0] ?? null} onDecide={decidePermission} />
      <FilePeek open={filePeek.open} onClose={() => setFilePeek({ open: false, file: null, fromSearch: false })} project={peekProject} file={filePeek.file} fromSearch={filePeek.fromSearch} onFile={(file) => setFilePeek({ open: true, file, fromSearch: file !== null })} />
      <DiffPeek edit={diffPeek} onClose={() => setDiffPeek(null)} onOpenFile={(path) => openFile({ path, line: null })} />
      <ProjectPicker open={pickingProject} onClose={() => setPickingProject(false)} onPick={(picked) => { setProject(picked); setPickingProject(false); }} />
    </div>
  );
}
