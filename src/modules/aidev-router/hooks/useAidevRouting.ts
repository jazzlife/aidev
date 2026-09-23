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

function buildAidevPayload(route: RouteResult, runId: number | null, overrides: { agent?: string }) {
  const agentName = overrides.agent && route.alternatives.some((alternative) => alternative.name === overrides.agent) ? overrides.agent : route.agent.name;
  return {
    runId,
    decisionId: route.decision_id,
    agent: {
      name: agentName,
      version: route.agent.version,
      description: route.agent.description,
      prompt: route.agent.definition.prompt,
      tools: route.agent.definition.tools,
      model: route.agent.definition.model,
      maxTurns: route.agent.definition.maxTurns,
      skills: route.agent.definition.skills,
      mcpServers: route.agent.definition.mcpServers,
    },
    lessons: route.lessons.map((lesson) => `${lesson.trigger} → ${lesson.rule}`),
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
    routingStore.patch({ busy: true, error: null });
    try {
      const overrides = current.overrides;
      const route = await aidevApi.route({
        text,
        sessionId: context.sessionId,
        sessionEngine: context.isNewSession ? null : asEngine(context.provider),
        preferEngine: overrides.engine ?? (context.isNewSession ? null : asEngine(context.provider)),
        targetId: overrides.targetId ?? null,
        projectHint: context.projectHint ?? null,
        model: overrides.model ?? null,
        effort: overrides.effort ?? null,
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
          depth: route.scope.depth,
          task_kind: route.scope.task_kind,
          risk: route.scope.risk,
          target_id: route.plan.target?.id ?? null,
        });
        runId = run.run_id;
      } catch {
        runId = null; // a missing run row only loses learning signal for this turn
      }
      routingStore.patch({ busy: false, last: route, lastText: text, runId });
      if (current.mode === 'manual' && !current.overrides.agent && !current.overrides.model) {
        // Manual mode: show the plan, but send without it until the user applies it from the bar.
        return null;
      }
      const applyPlan = !context.userPinnedModel && route.plan.engine !== null && (context.isNewSession || route.plan.engine === asEngine(context.provider));
      return {
        aidev: buildAidevPayload(route, runId, overrides),
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
  const reportOutcome = useCallback(async (outcome: { exit_code?: number | null; tool_errors?: number; user_feedback?: 'up' | 'down' | null; test_result?: 'pass' | 'fail' | null; summary?: string; reverted?: boolean }, runId?: number | null) => {
    const id = runId ?? routingStore.get().runId;
    if (!id) {
      return null;
    }
    try {
      return await aidevApi.runOutcome(id, outcome);
    } catch {
      return null;
    }
  }, []);

  return { state, beforeSend, reportOutcome, setMode: routingStore.setMode, setOverrides: routingStore.setOverrides, clearOverrides: routingStore.clearOverrides };
}
