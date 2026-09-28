import { useCallback, useState } from 'react';

import { api } from '@/shared/api';
import { aidevApi, type Engine } from '@/modules/aidev-router/api';
import { routingStore, useRoutingState } from '@/modules/aidev-router/store';

type UseEscalationArgs = {
  /** Sends text as a new user turn in the open session through the composer (routing runs again). */
  resend: (text: string) => void;
  /** Opens another session (the handoff target, bound to `engine`) in the host UI. */
  openSession: (sessionId: string, engine: Engine, title: string) => void;
  /** Project path of the open session; the handoff session is created in the same project. */
  getProjectPath: () => string | null;
};

const ENGINE_LABEL: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * One-tap follow-up for a failed routed run (IMPLEMENTATION-PLAN §3.8, E-03). The gateway's
 * proposal (`routingStore.escalation`, set by useAidevRouting.reportOutcome) is executed here:
 *   retry_same / escalate_tier → the same command re-sent once with the proposed model/effort,
 *                                 linked to the failed run (escalated_from_run);
 *   switch_engine              → a handoff brief is built from the transcript, a session on the other
 *                                 engine is created in the same project and the brief is sent there;
 *   ask_user                   → nothing to run; the card only explains why.
 * The original specialist agent is kept for the follow-up turn. Used by ChatInterface (workbench)
 * and the mobile ChatScreen; nothing runs without the user's tap (each attempt spends usage).
 */
export function useEscalation({ resend, openSession, getProjectPath }: UseEscalationArgs) {
  const { escalation, last } = useRoutingState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dismiss = useCallback(() => { routingStore.patch({ escalation: null }); setError(null); }, []);

  const run = useCallback(async () => {
    const current = routingStore.get().escalation;
    if (!current || busy) return;
    const { next, text } = current;
    const agentName = routingStore.get().last?.agent.name ?? null;
    const oneShotAgent = agentName && agentName !== 'agent-architect' ? agentName : null;
    const plan = { engine: next.engine ?? undefined, model: next.model, effort: next.effort, depth: next.depth, escalatedFromRun: next.from_run };
    setError(null);
    if (next.action === 'retry_same' || next.action === 'escalate_tier') {
      if (!text.trim()) { setError('다시 보낼 명령을 찾지 못했습니다'); return; }
      routingStore.patch({ oneShotPlan: plan, oneShotAgent, escalation: null });
      resend(text);
      return;
    }
    if (next.action !== 'switch_engine' || !next.engine) { dismiss(); return; }
    const projectPath = getProjectPath();
    if (!current.sessionId || !projectPath) { setError('인계할 세션 정보가 없습니다'); return; }
    setBusy(true);
    try {
      const fromEngine = routingStore.get().last?.plan.engine ?? null;
      const brief = await aidevApi.handoffBrief(current.sessionId, { from_engine: fromEngine, to_engine: next.engine, reason: next.reason });
      const response = await api.providers.createSession({ provider: next.engine, projectPath, initialMessage: text || brief.text });
      const body = await response.json() as { data?: { sessionId?: string } };
      const newId = body.data?.sessionId;
      if (!response.ok || !newId) throw new Error(`세션을 만들지 못했습니다 (${response.status})`);
      routingStore.patch({ pendingHandoff: { sessionId: newId, text: brief.text }, oneShotPlan: plan, oneShotAgent, escalation: null });
      openSession(newId, next.engine, `[인계] ${(text || '이어서 작업').slice(0, 60)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '인계 실패');
    } finally {
      setBusy(false);
    }
  }, [busy, dismiss, getProjectPath, resend, openSession]);

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
      : next.action === 'escalate_tier' ? `더 강한 모델로 다시 시도 (${next.model}${next.effort ? ` · ${next.effort}` : ''})`
        : next.action === 'switch_engine' && next.engine ? `${ENGINE_LABEL[next.engine]}로 인계 (${next.model})`
          : null;
  return { escalation, agentName: last?.agent.name ?? null, label, busy, error, run, dismiss, takeHandoff };
}
