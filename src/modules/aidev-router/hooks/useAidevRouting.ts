import { useCallback } from 'react';

import { aidevApi, type Engine, type RouteResult } from '@/modules/aidev-router/api';
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
const asEngine = (value: string): Engine | null => (ENGINES.includes(value as Engine) ? value as Engine : null);

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
    // a new send supersedes any follow-up still offered for the previous run
    routingStore.patch({ busy: true, error: null, escalation: null });
    try {
      const overrides = current.overrides;
      // A self-check turn or an explicit agent pick bypasses Laya's agent choice (§3.7, C-07).
      const forceAgent = current.oneShotAgent || overrides.agent || null;
      if (current.oneShotAgent) routingStore.patch({ oneShotAgent: null });
      // E-03: an escalated retry / handoff pins engine, model and effort for this one send.
      const oneShot = current.oneShotPlan;
      if (oneShot) routingStore.patch({ oneShotPlan: null });
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
        // the chat's own ceiling: stored server-side for known sessions, sent inline for a new chat
        effortCap: current.chatCap.sessionId === (context.isNewSession ? null : context.sessionId ?? null) ? current.chatCap.cap : null,
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
      if (route.decision === 'create' && route.create && !route.create.background && !forceAgent && !current.pendingCreate) {
        routingStore.patch({ pendingCreate: { stage: 'architect', originalText: text, sessionId: context.sessionId, decisionId: route.decision_id, draft: null, agentId: null, agentName: null, selfCheckResult: null, error: null } });
        const architect = route.create.architect;
        payload.agent = { name: architect.name, version: architect.version, description: architect.description, prompt: architect.prompt, tools: architect.tools, model: architect.model, maxTurns: architect.maxTurns, skills: null, mcpServers: null };
        payload.lessons = [];
        const proposal = route.create.proposal;
        payload.knowledgeDigest = `## 현재 카탈로그 (name: routing hint)\n${route.create.catalog}${proposal ? `\n\n## 라우터가 판단한 필요한 전문 분야\n- 이름 제안: ${proposal.name}\n- 분야: ${proposal.domain}\n- 설명: ${proposal.description}\n- 핵심 기술: ${proposal.technologies.join(', ')}\n이 분야를 정확히 전문으로 하는 agent를 설계할 것(기존 agent와 겹치지 않게).` : ''}`;
      }
      return {
        aidev: payload,
        model: applyPlan ? route.plan.model : null,
        effort: applyPlan ? route.plan.effort : null,
        route,
        runId,
      };
    } catch (error) {
      routingStore.patch({ busy: false, error: error instanceof Error ? error.message : 'routing failed' });
      return null;
    }
  }, []);

  /** Records the terminal signal of the run started by the last routed send (§3.8). */
  const reportOutcome = useCallback(async (outcome: { session_id?: string | null; exit_code?: number | null; tool_errors?: number; user_feedback?: 'up' | 'down' | null; test_result?: 'pass' | 'fail' | null; summary?: string; reverted?: boolean }, runId?: number | null) => {
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
      return result;
    } catch {
      return null;
    }
  }, []);

  return { state, beforeSend, reportOutcome, setMode: routingStore.setMode, setOverrides: routingStore.setOverrides, clearOverrides: routingStore.clearOverrides };
}
