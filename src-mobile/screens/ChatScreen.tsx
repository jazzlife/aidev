import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, useChatRealtimeHandlers, useSessionStore, useWebSocket, type LLMProvider, type NormalizedMessage, type PendingPermissionRequest, type ProjectSession } from '@/modules/chat-core';
import { AgentCreateCard, useAgentCreation, useAidevRouting, type Engine } from '@/modules/aidev-router';
import { Composer } from '@m/components/Composer';
import { MessageList } from '@m/components/MessageList';
import { PermissionSheet } from '@m/components/PermissionSheet';
import { RouterChip } from '@m/components/RouterChip';
import { RunFeedback } from '@m/components/RunFeedback';
import { TopBar } from '@m/components/TopBar';
import { ProjectPicker, readLastProject, type PickedProject } from '@m/components/ProjectPicker';

type SessionMeta = { id: string; provider: LLMProvider; projectPath: string; projectName: string; title: string };
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

  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [project, setProject] = useState<PickedProject | null>(() => readLastProject());
  const [pickingProject, setPickingProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [lastRunFinished, setLastRunFinished] = useState<number | null>(null);
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const lastSeqRef = useRef(new Map<string, number>());
  const statusCheckSentAtRef = useRef(new Map<string, number>());

  const sessionId = meta?.id ?? null;
  const provider: LLMProvider = meta?.provider ?? readProvider();
  const selectedSession: ProjectSession | null = meta ? { id: meta.id, provider: meta.provider, __provider: meta.provider } : null;

  // ---- resolve the session named in the URL ------------------------------------------------
  useEffect(() => {
    if (!routeSessionId) { setMeta(null); return; }
    let cancelled = false;
    setLoadError(null);
    api.sessionDetails(routeSessionId).then(async (response) => {
      const payload = await response.json() as { data?: { sessionId?: string; provider?: string; summary?: string; project?: { fullPath?: string; path?: string; displayName?: string } | null } };
      if (cancelled) return;
      const data = payload.data;
      if (!response.ok || !data) { setLoadError('세션을 찾을 수 없습니다'); return; }
      const resolvedProvider: LLMProvider = data.provider === 'codex' ? 'codex' : 'claude';
      setMeta({ id: routeSessionId, provider: resolvedProvider, projectPath: data.project?.fullPath || data.project?.path || '', projectName: data.project?.displayName || '', title: data.summary || '' });
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
    void reportOutcome({ exit_code: exitCode });
    setLastRunFinished(Date.now());
    setTimeout(() => { void agentCreationRef.current.onRunComplete(); }, 400);
  }), [subscribe, sessionId, reportOutcome]);

  // ---- send ------------------------------------------------------------------------------------
  const send = useCallback(async (text: string) => {
    if (busy) return;
    let target = meta;
    const isNew = !target;
    if (isNew && !project) { setPickingProject(true); return; }
    const decoration = await beforeSend(text, { sessionId: target?.id ?? null, provider, isNewSession: isNew, projectHint: (target?.projectName || project?.displayName) ?? null, userPinnedModel: false });
    if (isNew && project) {
      // The router's engine choice decides the provider of a brand-new session (§0: sessions are provider-bound).
      const engine = (decoration?.route.plan.engine ?? provider) as Engine;
      try {
        const response = await api.providers.createSession({ provider: engine, projectPath: project.fullPath, initialMessage: text });
        const body = await response.json() as { data?: { sessionId?: string } };
        if (!response.ok || !body.data?.sessionId) throw new Error('세션을 만들지 못했습니다');
        target = { id: body.data.sessionId, provider: engine, projectPath: project.fullPath, projectName: project.displayName, title: text.slice(0, 60) };
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
  }, [beforeSend, busy, meta, navigate, project, provider, sendMessage, sessionStore]);

  useEffect(() => { sendRef.current = (text) => { void send(text); }; }, [send]);
  const abort = useCallback(() => { if (sessionId) sendMessage({ type: 'chat.abort', sessionId }); }, [sendMessage, sessionId]);
  const decidePermission = useCallback((requestId: string, allow: boolean) => {
    sendMessage({ type: 'chat.permission-response', requestId, allow });
    setPendingPermissionRequests((previous) => previous.filter((request) => request.requestId !== requestId));
  }, [sendMessage]);

  const messages = sessionId ? sessionStore.getMessages(sessionId) : [];
  const slot = sessionId ? sessionStore.getSessionSlot(sessionId) : undefined;
  const title = meta?.title || (routeSessionId ? '대화' : '새 대화');
  const subtitle = meta ? `${meta.provider}${meta.projectName ? ` · ${meta.projectName}` : ''}` : (project ? `${provider} · ${project.displayName}` : '프로젝트를 선택하세요');

  return (
    <div className="m-app">
      <TopBar title={title} subtitle={subtitle} back="/" right={!meta ? <button type="button" className="text-[13px] text-accent px-3 m-touch" onClick={() => setPickingProject(true)}>프로젝트</button> : null} />
      {loadError ? <div className="px-4 py-2 text-danger text-sm">{loadError}</div> : null}
      {!isConnected ? <div className="px-4 py-1 text-[12px] text-warn bg-warn/10">연결 중…</div> : null}
      <MessageList messages={messages} loading={slot?.status === 'loading'} />
      {agentCreation.pending ? <div className="m-scroll max-h-[45dvh]"><AgentCreateCard compact pending={agentCreation.pending} onApprove={(draft) => { void agentCreation.approve(draft); }} onSelfCheck={agentCreation.runSelfCheck} onDismiss={agentCreation.dismiss} /></div> : null}
      {lastRunFinished && !busy ? <RunFeedback key={lastRunFinished} onFeedback={(value) => { void reportOutcome({ user_feedback: value }); }} /> : null}
      <RouterChip />
      <Composer busy={busy} disabled={!isConnected} onSend={(text) => { void send(text); }} onAbort={abort} placeholder={meta ? undefined : '무엇을 만들까요?'} />
      <PermissionSheet request={pendingPermissionRequests[0] ?? null} onDecide={decidePermission} />
      <ProjectPicker open={pickingProject} onClose={() => setPickingProject(false)} onPick={(picked) => { setProject(picked); setPickingProject(false); }} />
    </div>
  );
}
