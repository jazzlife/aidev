import { useCallback } from 'react';

import { aidevApi, type Engine, type RouteResult, type RunView } from '@/modules/aidev-router/api';
import { routingStore, useRoutingState } from '@/modules/aidev-router/store';

/**
 * What the composer attaches to `chat.send options` after routing (IMPLEMENTATION-PLAN §3.5).
 * `aidev` is the engine-neutral turn payload the runtime providers sanitize; `model`/`effort`
 * are the plan's picks, applied only when the user has not pinned a model themselves.
 */
export type AidevSendDecoration = {
  aidev: Record<string, unknown>;
  model: string | null;
  effort: string | null;
  route: RouteResult;
  runId: number | null;
  /** the send carried a one-shot agent or plan: the app re-sending (agent creation, self-check, escalation, handoff) */
  appResend: boolean;
  /**
   * Engine priority (2026-10-09): a higher-priority engine is usable again and this chat is not pinned — the host
   * continues the conversation there (a handoff with this text appended) instead of sending here.
   */
  switchBack: { engine: Engine; reason: string } | null;
};

export type BeforeSendContext = {
  /** Session id when one already exists — its provider is then fixed (§0). */
  sessionId: string | null;
  /** Provider the composer is about to send with (the session's, or the user's pick for a new chat). */
  provider: string;
  isNewSession: boolean;
  projectHint?: string | null;
  /** Whether the composer's model is an explicit user choice rather than the provider default. */
  userPinnedModel: boolean;
};

const ENGINES: Engine[] = ['claude', 'codex'];

/**
 * Used by the workbench composer and the mobile chat (C-05/C-09): whether a routed send should wait for one line of
 * detail (§3.1). Never for agent creation (the architect asks its own questions) or for the app's own re-sends —
 * the user already chose there.
 */
export function shouldAskClarify(decoration: AidevSendDecoration | null): decoration is AidevSendDecoration {
  return Boolean(decoration && decoration.route.scope.ask_clarify && decoration.route.decision !== 'create' && !decoration.appResend);
}
const asEngine = (value: string): Engine | null => (ENGINES.includes(value as Engine) ? value as Engine : null);

/** How long a verification is followed (a verifier reads the repository and re-runs checks) and how often it is asked for. */
const VERIFY_POLL_MS = 5_000;
const VERIFY_MAX_MS = 13 * 60_000;

/**
 * Polls the run until the verifier's verdict is stored, then shows it. A failed verdict also carries the
 * gateway's next step, so the escalation card appears with the verifier's findings appended to the
 * command the retry will send — the next attempt knows what the last one got wrong. When that step is
 * retry_worker, useEscalation sends it back to the worker by itself (cross-verification loop).
 */
async function followVerification(runId: number, sessionId: string | null) {
  const until = Date.now() + VERIFY_MAX_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
    const current = routingStore.get().verification;
    if (!current || current.runId !== runId) return;   // a newer send replaced it
    let view: RunView;
    try { view = await aidevApi.run(runId); } catch { continue; }
    const result = view.run.verification;
    if (!result) { if (!view.verifying) break; continue; }
    routingStore.patch({ verification: { runId, status: 'done', result } });
    if (result.verdict === 'fail' && view.run.next_action && !routingStore.get().escalation) {
      const text = routingStore.get().lastText ?? '';
      const findings = result.issues.length ? `\n\n[검증에서 발견된 문제 — 먼저 해결할 것]\n${result.issues.map((issue) => `- ${issue}`).join('\n')}` : `\n\n[검증 결과] ${result.summary}`;
      routingStore.patch({ escalation: { next: view.run.next_action, text: text ? `${text}${findings}` : '', sessionId } });
    }
    return;
  }
  const stale = routingStore.get().verification;
  if (stale && stale.runId === runId && stale.status === 'pending') routingStore.patch({ verification: { runId, status: 'done', result: { verdict: 'unclear', summary: '검증 결과를 받지 못했습니다', checked: [], issues: [], engine: null, model: null, at: Date.now() } } });
}

function buildAidevPayload(route: RouteResult, runId: number | null) {
  return {
    runId,
    decisionId: route.decision_id,
    agent: {
      name: route.agent.name,
      version: route.agent.version,
      description: route.agent.description,
      prompt: route.agent.definition.prompt,
      tools: route.agent.definition.tools,
      model: route.agent.definition.model,
      maxTurns: route.agent.definition.maxTurns,
      skills: route.agent.definition.skills,
      mcpServers: route.agent.definition.mcpServers,
    },
    // a trial lesson is a candidate on probation: this run's outcome verifies or rejects it (E-02)
    lessons: route.lessons.map((lesson) => `${lesson.trial ? '[시험 적용] ' : ''}${lesson.trigger} → ${lesson.rule}`),
    knowledgeDigest: route.knowledge_digest,
    engine: route.plan.engine,
    model: route.plan.model,
    effort: route.plan.effort,
    target: route.plan.target,
    // F-08: the attached device the run should address (adb/sdb -s <serial>)
    device: route.plan.device ? { serial: route.plan.device.serial, tool: route.plan.device.tool } : null,
    scope: { depth: route.scope.depth, taskKind: route.scope.task_kind, risk: route.scope.risk, remoteAction: route.scope.remote_action },
  };
}

/**
 * Used by the chat composer (`useChatComposerState`) right before `chat.send`, and by the
 * router UI to re-route on demand. Never throws: any failure returns null so the send
 * proceeds exactly as an unrouted CloudUI send would.
 */
export function useAidevRouting() {
  const state = useRoutingState();

  const beforeSend = useCallback(async (text: string, context: BeforeSendContext): Promise<AidevSendDecoration | null> => {
    const current = routingStore.get();
    if (current.mode === 'off' || !text.trim()) {
      return null;
    }
    // a new send supersedes any follow-up or verdict still shown for the previous run
    routingStore.patch({ busy: true, error: null, escalation: null, verification: null });
    try {
      const overrides = current.overrides;
      // A self-check turn or an explicit agent pick bypasses Laya's agent choice (§3.7, C-07).
      const forceAgent = current.oneShotAgent || overrides.agent || null;
      if (current.oneShotAgent) routingStore.patch({ oneShotAgent: null });
      // E-03: an escalated retry / handoff pins engine, model and effort for this one send.
      const oneShot = current.oneShotPlan;
      if (oneShot) routingStore.patch({ oneShotPlan: null });
      // D-04: an accepted create-queue proposal
      const createProposal = current.oneShotCreate;
      if (createProposal) routingStore.patch({ oneShotCreate: null });
      const route = await aidevApi.route({
        text,
        sessionId: context.sessionId,
        sessionEngine: context.isNewSession ? null : asEngine(context.provider),
        preferEngine: oneShot?.engine ?? overrides.engine ?? (context.isNewSession ? null : asEngine(context.provider)),
        targetId: overrides.targetId ?? null,
        projectHint: context.projectHint ?? null,
        model: oneShot?.model ?? overrides.model ?? null,
        effort: oneShot?.effort ?? overrides.effort ?? null,
        forceAgent,
        createProposal,
        // the chat's own ceiling and model floor: stored server-side for known sessions, sent inline for a new chat
        effortCap: current.chatCap.sessionId === (context.isNewSession ? null : context.sessionId ?? null) ? current.chatCap.cap : null,
        modelFloor: current.chatFloor.sessionId === (context.isNewSession ? null : context.sessionId ?? null) ? current.chatFloor.floor : null,
      });
      let runId: number | null = null;
      try {
        const run = await aidevApi.createRun({
          decision_id: route.decision_id,
          session_id: context.sessionId,
          agent_id: route.agent.id,
          agent_version: route.agent.version,
          engine: route.plan.engine,
          model: route.plan.model,
          effort: route.plan.effort,
          // an escalated attempt is recorded at the tier it runs at, so a further failure climbs from there
          depth: oneShot?.depth ?? route.scope.depth,
          task_kind: route.scope.task_kind,
          risk: route.scope.risk,
          target_id: route.plan.target?.id ?? null,
          ...(oneShot?.escalatedFromRun ? { escalated_from_run: oneShot.escalatedFromRun } : {}),
        });
        runId = run.run_id;
      } catch {
        runId = null; // a missing run row only loses learning signal for this turn
      }
      routingStore.patch({ busy: false, last: route, lastText: text, runId, runSessionId: context.sessionId, runFinishedAt: null, runFeedback: null });
      if (current.mode === 'manual' && !current.overrides.agent && !current.overrides.model) {
        // Manual mode: show the plan, but send without it until the user applies it from the bar.
        return null;
      }
      const applyPlan = !context.userPinnedModel && route.plan.engine !== null && (context.isNewSession || route.plan.engine === asEngine(context.provider));
      const payload = buildAidevPayload(route, runId);
      // No fitting specialist: this turn goes to the agent-architect (design only); the original
      // command is re-sent once the user approves the draft (§3.7). Shallow tasks just run.
      // a finished or failed creation card left open does not block the next one (it used to, silently)
      const creating = current.pendingCreate && current.pendingCreate.stage !== 'done' && !current.pendingCreate.error;
      if (route.decision === 'create' && route.create && !route.create.background && !forceAgent && !creating) {
        // a queued domain's commands already ran on the generalist: nothing to re-send once its agent exists
        const fromQueue = route.create.from_queue ? route.create.queue?.id ?? null : null;
        routingStore.patch({ pendingCreate: { stage: 'architect', originalText: fromQueue ? '' : text, queueId: fromQueue, sessionId: context.sessionId, decisionId: route.decision_id, draft: null, agentId: null, agentName: null, selfCheckResult: null, error: null } });
        const architect = route.create.architect;
        payload.agent = { name: architect.name, version: architect.version, description: architect.description, prompt: architect.prompt, tools: architect.tools, model: architect.model, maxTurns: architect.maxTurns, skills: null, mcpServers: null };
        payload.lessons = [];
        const proposal = route.create.proposal;
        payload.knowledgeDigest = `## 현재 카탈로그 (name: routing hint)\n${route.create.catalog}${proposal ? `\n\n## 라우터가 판단한 필요한 전문 분야\n- 이름 제안: ${proposal.name}\n- 분야: ${proposal.domain}\n- 설명: ${proposal.description}\n- 핵심 기술: ${proposal.technologies.join(', ')}\n이 분야를 정확히 전문으로 하는 agent를 설계할 것(기존 agent와 겹치지 않게).` : ''}`;
      }
      // a manual engine choice for this send (chip/bar, escalation, handoff) keeps the chat where it is
      const manualEngine = Boolean(oneShot?.engine || overrides.engine);
      return {
        aidev: payload,
        model: applyPlan ? route.plan.model : null,
        effort: applyPlan ? route.plan.effort : null,
        route,
        runId,
        appResend: Boolean(current.oneShotAgent || oneShot || createProposal),
        switchBack: route.plan.switch_back && !manualEngine && !context.isNewSession ? route.plan.switch_back : null,
      };
    } catch (error) {
      routingStore.patch({ busy: false, error: error instanceof Error ? error.message : 'routing failed' });
      return null;
    }
  }, []);

  /** Records the terminal signal of the run started by the last routed send (§3.8). */
  const reportOutcome = useCallback(async (outcome: { session_id?: string | null; exit_code?: number | null; tool_errors?: number; user_feedback?: 'up' | 'down' | null; test_result?: 'pass' | 'fail' | null; summary?: string; reverted?: boolean; /** the engine refused the run on a usage limit (its reset time when known) */ usage_limit?: { type: string; resets_at: number | null } | null }, runId?: number | null) => {
    const id = runId ?? routingStore.get().runId;
    if (outcome.exit_code !== undefined) routingStore.patch({ runFinishedAt: Date.now() });
    if (outcome.user_feedback) routingStore.patch({ runFeedback: outcome.user_feedback });
    if (outcome.session_id) routingStore.patch({ runSessionId: outcome.session_id });
    if (!id) {
      return null;
    }
    try {
      const result = await aidevApi.runOutcome(id, outcome);
      // E-03: a failed run comes back with a proposed next step (retry / stronger model / other engine)
      if (result.next) routingStore.patch({ escalation: { next: result.next, text: routingStore.get().lastText ?? '', sessionId: outcome.session_id ?? routingStore.get().runSessionId } });
      // worker ≠ verifier: the gateway started an independent check of this run — follow it to its verdict
      if (result.verifying) { routingStore.patch({ verification: { runId: id, status: 'pending', result: null } }); void followVerification(id, outcome.session_id ?? routingStore.get().runSessionId); }
      return result;
    } catch {
      return null;
    }
  }, []);

  return { state, beforeSend, reportOutcome, setMode: routingStore.setMode, setOverrides: routingStore.setOverrides, clearOverrides: routingStore.clearOverrides };
}
