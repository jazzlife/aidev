import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { aidevApi, type Engine } from '@/modules/aidev-router/api';
import { routingStore, useRoutingState } from '@/modules/aidev-router/store';
import { rememberHandoff } from '@/modules/aidev-router/hooks/useReturnFromHandoff';

type UseEscalationArgs = {
  /** Sends text as a new user turn in the open session through the composer (routing runs again). */
  resend: (text: string) => void;
  /** Opens another session (the handoff target, bound to `engine`) in the host UI. */
  openSession: (sessionId: string, engine: Engine, title: string) => void;
  /** Project path of the open session; the handoff session is created in the same project. */
  getProjectPath: () => string | null;
};

type HandoffArgs = {
  engine: Engine;
  /** The engine the chat is leaving — the session's own, never read off the routing store (its last plan may belong to another chat). */
  fromEngine: Engine;
  sessionId: string;
  /** The command to continue with; the brief is sent instead when there is none. */
  text: string;
  reason: string | null;
  plan: Record<string, unknown>;
  oneShotAgent: string | null;
  title: string;
  /** a request typed now, sent in the new session after the brief (engine switch-back) */
  appendText?: string;
};

const ENGINE_LABEL: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * One-tap follow-up for a failed routed run (IMPLEMENTATION-PLAN §3.8, E-03). The gateway's
 * proposal (`routingStore.escalation`, set by useAidevRouting.reportOutcome) is executed here:
 *   retry_same / escalate_tier → the same command re-sent once with the proposed model/effort,
 *                                 linked to the failed run (escalated_from_run);
 *   retry_worker               → the verifier failed the run: the command plus the verifier's findings goes
 *                                 back to the same worker without a tap (cross-verification loop; the gateway
 *                                 caps the chain), and the new run is verified again;
 *   switch_engine              → a handoff brief is built from the transcript, a session on the other
 *                                 engine is created in the same project and the brief is sent there;
 *   ask_user                   → nothing to run; the card only explains why.
 * The original specialist agent is kept for the follow-up turn. Used by ChatInterface (workbench)
 * and the mobile ChatScreen; nothing runs without the user's tap (each attempt spends usage) —
 * except retry_worker and a usage-limit block, which `handoffOnUsageLimit` carries over on its own.
 */
export function useEscalation({ resend, openSession, getProjectPath }: UseEscalationArgs) {
  const { escalation, last } = useRoutingState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sessions already carried over, so a repeated limit on the same chat cannot
  // spawn a second handoff session.
  const handedOffSessions = useRef<Set<string>>(new Set());

  const dismiss = useCallback(() => { routingStore.patch({ escalation: null }); setError(null); }, []);

  /** Builds the brief, opens a session on `engine` in the same project, and queues the brief for it. */
  const handoff = useCallback(async ({ engine, fromEngine, sessionId, text, reason, plan, oneShotAgent, title, appendText }: HandoffArgs) => {
    const projectPath = getProjectPath();
    if (!projectPath) { setError('인계할 프로젝트 경로를 찾지 못했습니다'); return; }
    setBusy(true);
    try {
      const brief = await aidevApi.handoffBrief(sessionId, { from_engine: fromEngine, to_engine: engine, reason });
      const response = await api.providers.createSession({ provider: engine, projectPath, initialMessage: text || brief.text });
      const body = await response.json() as { data?: { sessionId?: string } };
      const newId = body.data?.sessionId;
      if (!response.ok || !newId) throw new Error(`세션을 만들지 못했습니다 (${response.status})`);
      handedOffSessions.current.add(sessionId);
      // the new chat remembers where it came from, so it can offer the way back once that engine is usable again
      rememberHandoff(newId, { fromSessionId: sessionId, fromEngine, toEngine: engine, reason, at: Date.now() });
      routingStore.patch({ pendingHandoff: { sessionId: newId, text: appendText ? `${brief.text}\n\n## 이어서 할 요청\n${appendText}` : brief.text }, oneShotPlan: plan, oneShotAgent, escalation: null });
      openSession(newId, engine, title);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '인계 실패');
    } finally {
      setBusy(false);
    }
  }, [getProjectPath, openSession]);

  const run = useCallback(async () => {
    const current = routingStore.get().escalation;
    if (!current || busy) return;
    const { next, text } = current;
    const agentName = routingStore.get().last?.agent.name ?? null;
    const oneShotAgent = agentName && agentName !== 'agent-architect' ? agentName : null;
    const plan = { engine: next.engine ?? undefined, model: next.model, effort: next.effort, depth: next.depth, escalatedFromRun: next.from_run };
    setError(null);
    if (next.action === 'retry_same' || next.action === 'retry_worker' || next.action === 'escalate_tier') {
      if (!text.trim()) { setError('다시 보낼 명령을 찾지 못했습니다'); return; }
      routingStore.patch({ oneShotPlan: plan, oneShotAgent, escalation: null });
      resend(text);
      return;
    }
    if (next.action !== 'switch_engine' || !next.engine) { dismiss(); return; }
    if (!current.sessionId) { setError('인계할 세션 정보가 없습니다'); return; }
    await handoff({
      engine: next.engine,
      // a switch_engine proposal always targets the other engine, so the failed run's engine is its opposite
      fromEngine: next.engine === 'claude' ? 'codex' : 'claude',
      sessionId: current.sessionId,
      text,
      reason: next.reason,
      plan,
      oneShotAgent,
      title: `[인계] ${(text || '이어서 작업').slice(0, 60)}`,
    });
  }, [busy, dismiss, handoff, resend]);

  // Runs already sent back to their worker, so a re-render (or the card reappearing) never sends twice.
  const reworkedRuns = useRef<Set<number>>(new Set());
  // retry_worker is the one proposal that goes out by itself: the worker gets the verifier's findings right away
  useEffect(() => {
    const current = escalation;
    if (!current || current.next.action !== 'retry_worker' || reworkedRuns.current.has(current.next.from_run)) return;
    reworkedRuns.current.add(current.next.from_run);
    void run();
  }, [escalation, run]);

  /**
   * Carries the work to the other engine without waiting for a tap, for a run the
   * provider refused on a usage limit (claude ↔ codex — the only two engines the
   * gateway routes between).
   *
   * This is the one failure where asking first only stalls: the limit is not a bad
   * plan the user could choose differently about, and the same engine cannot succeed
   * until the window resets. The gateway is not consulted either — its proposal may
   * never arrive (it only escalates runs it routed), so the limit decides locally.
   *
   * The other engine has to actually be usable first: with only one engine logged
   * in, a limit is a dead end, not a handoff, so this reports `blocked` instead of
   * silently trying (and failing) to open a session nothing is signed into.
   */
  const handoffOnUsageLimit = useCallback(async (args: { sessionId: string; blockedEngine: Engine; reason: string }): Promise<{ status: 'handed-off' | 'blocked' | 'skipped'; otherEngine: Engine }> => {
    const otherEngine: Engine = args.blockedEngine === 'claude' ? 'codex' : 'claude';
    if (busy || handedOffSessions.current.has(args.sessionId)) return { status: 'skipped', otherEngine };

    const authResponse = await api.providers.authStatus(otherEngine);
    const authBody = authResponse.ok ? await authResponse.json() as { data?: { authenticated?: boolean } } : null;
    if (!authBody?.data?.authenticated) {
      // Only one engine is usable, so this is a dead end rather than a handoff —
      // surfaced through the same ask_user card other failures use, so the user
      // is not left staring at a transcript that just stopped.
      routingStore.patch({
        escalation: {
          next: { action: 'ask_user', engine: null, model: null, effort: null, depth: null, from_run: 0, chain: 0, reason: `${ENGINE_LABEL[otherEngine]}도 로그인되어 있지 않아 자동으로 전환할 수 없습니다. 한도가 초기화될 때까지 기다리거나 ${ENGINE_LABEL[otherEngine]}에 로그인해주세요.` },
          text: routingStore.get().lastText ?? '',
          sessionId: args.sessionId,
        },
      });
      return { status: 'blocked', otherEngine };
    }

    const text = routingStore.get().lastText ?? '';
    const agentName = routingStore.get().last?.agent.name ?? null;
    setError(null);
    await handoff({
      engine: otherEngine,
      fromEngine: args.blockedEngine,
      sessionId: args.sessionId,
      text,
      reason: args.reason,
      plan: { engine: otherEngine },
      oneShotAgent: agentName && agentName !== 'agent-architect' ? agentName : null,
      title: `[${ENGINE_LABEL[otherEngine]} 인계] ${(text || '이어서 작업').slice(0, 60)}`,
    });
    return { status: 'handed-off', otherEngine };
  }, [busy, handoff]);

  /**
   * Engine priority (2026-10-09): routing said a higher-priority engine is usable again for a chat that is not
   * pinned — the request typed now continues in a new session on that engine, with a brief of this chat, instead
   * of being sent here. Returns false when the move could not be made (the host then sends here).
   */
  const switchBack = useCallback(async (args: { sessionId: string; engine: Engine; fromEngine: Engine; text: string; reason: string }): Promise<boolean> => {
    if (busy) return false;
    const agentName = routingStore.get().last?.agent.name ?? null;
    setError(null);
    await handoff({
      engine: args.engine,
      fromEngine: args.fromEngine,
      sessionId: args.sessionId,
      text: '',
      appendText: args.text,
      reason: args.reason,
      plan: { engine: args.engine },
      oneShotAgent: agentName && agentName !== 'agent-architect' ? agentName : null,
      title: `[${ENGINE_LABEL[args.engine]} 복귀] ${args.text.slice(0, 60)}`,
    });
    return routingStore.get().pendingHandoff !== null;
  }, [busy, handoff]);

  /** Host calls this once the handoff session is open; returns the brief to send there (once). */
  const takeHandoff = useCallback((sessionId: string | null | undefined): string | null => {
    const pending = routingStore.get().pendingHandoff;
    if (!pending || !sessionId || pending.sessionId !== sessionId) return null;
    routingStore.patch({ pendingHandoff: null });
    return pending.text;
  }, []);

  const next = escalation?.next ?? null;
  const label = !next ? null
    : next.action === 'retry_same' ? '같은 설정으로 다시 시도'
      : next.action === 'retry_worker' ? '지적된 문제를 작업자에게 다시 맡기기'
        : next.action === 'escalate_tier' ? `더 강한 모델로 다시 시도 (${next.model}${next.effort ? ` · ${next.effort}` : ''})`
          : next.action === 'switch_engine' && next.engine ? `${ENGINE_LABEL[next.engine]}로 인계 (${next.model})`
            : null;
  return { escalation, agentName: last?.agent.name ?? null, label, busy, error, run, dismiss, takeHandoff, handoffOnUsageLimit, switchBack };
}
