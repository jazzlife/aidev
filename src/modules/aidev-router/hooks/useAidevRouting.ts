import { useCallback } from 'react';

import { aidevApi, type Engine, type RouteResult, type RunView } from '@/modules/aidev-router/api';
import { routingStore, sessionKey, useRoutingState } from '@/modules/aidev-router/store';
import { isAidevEngine } from '@/shared/utils';

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
   * The host continues the conversation on `engine` (a handoff with this text appended) instead of sending here:
   * a higher-priority engine is usable again for an unpinned chat (engine priority, 2026-10-09), or the user
   * pinned this chat to the other engine.
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
  /** The project folder in the runtime (the judge reads a new chat's technology from it). */
  projectPath?: string | null;
  /** Whether the composer's model is an explicit user choice rather than the provider default. */
  userPinnedModel: boolean;
};


/**
 * Used by the workbench composer and the mobile chat (C-05/C-09): whether a routed send should wait for one line of
 * detail (§3.1). Never for the app's own re-sends — the user already chose there.
 */
export function shouldAskClarify(decoration: AidevSendDecoration | null): decoration is AidevSendDecoration {
  return Boolean(decoration && decoration.route.scope.ask_clarify && !decoration.appResend);
}
const asEngine = (value: string): Engine | null => (isAidevEngine(value) ? value : null);

/** How long a verification is followed (a verifier reads the repository and re-runs checks) and how often it is asked for. */
const VERIFY_POLL_MS = 5_000;
const VERIFY_MAX_MS = 13 * 60_000;

/**
 * Polls the run until the verifier's verdict is stored, then shows it. A failed verdict also carries the
 * gateway's next step, so the escalation card appears with the verifier's findings appended to the
 * command the retry will send — the next attempt knows what the last one got wrong. When that step is
 * retry_worker, useEscalation sends it back to the worker by itself (cross-verification loop).
 */
async function followVerification(runId: number, sessionId: string | null, sent: { text: string; agent: string | null }) {
  // the verdict belongs to this run's chat, whichever chat is on screen when it comes (adoptSession may rename a new chat's '')
  const own = () => {
    const verifications = routingStore.get().verifications;
    const key = verifications[sessionKey(sessionId)]?.runId === runId ? sessionId : verifications['']?.runId === runId ? null : undefined;
    return key === undefined ? null : { key, verification: verifications[sessionKey(key)] };
  };
  const until = Date.now() + VERIFY_MAX_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
    if (!own()) return;   // a newer send in that chat replaced it, or it was dismissed
    let view: RunView;
    try { view = await aidevApi.run(runId); } catch { continue; }
    const result = view.run.verification;
    if (!result) { if (!view.verifying) break; continue; }
    const current = own();
    if (!current) return;
    routingStore.setFor('verifications', current.key, { runId, status: 'done', result });
    if (result.verdict === 'fail' && view.run.next_action && !routingStore.get().escalations[sessionKey(current.key)]) {
      const findings = result.issues.length ? `\n\n[검증에서 발견된 문제 — 먼저 해결할 것]\n${result.issues.map((issue) => `- ${issue}`).join('\n')}` : `\n\n[검증 결과] ${result.summary}`;
      routingStore.setFor('escalations', current.key, { next: view.run.next_action, text: sent.text ? `${sent.text}${findings}` : '', sessionId: current.key, agent: sent.agent });
    }
    return;
  }
  const stale = own();
  if (stale && stale.verification.status === 'pending') routingStore.setFor('verifications', stale.key, { runId, status: 'done', result: { verdict: 'unclear', summary: '검증 결과를 받지 못했습니다', checked: [], issues: [], engine: null, model: null, at: Date.now() } });
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
    // Routing picks between its engines only. A chat on another provider (an old Cursor session) is sent as it is.
    if (!asEngine(context.provider)) {
      return null;
    }
    // a new send supersedes any follow-up or verdict still shown for this chat's previous run (other chats keep theirs)
    routingStore.patch({ busy: true, error: null });
    routingStore.setFor('escalations', context.sessionId, null);
    routingStore.setFor('verifications', context.sessionId, null);
    try {
      const overrides = current.overrides;
      // A retry's plan and agent belong to the retry's own command (the composer may put a draft before it). Another
      // command sent first is routed as itself: server run #398 — "진행해" (D1) ran on a failed run's opus/xhigh D4 retry plan.
      const forText = current.oneShotPlan?.forText;
      const staleRetry = Boolean(forText && !text.trim().endsWith(forText.trim()));
      // A self-check turn or an explicit agent pick bypasses Laya's agent choice (§3.7, C-07).
      const oneShotAgent = staleRetry ? null : current.oneShotAgent;
      const forceAgent = oneShotAgent || overrides.agent || null;
      if (current.oneShotAgent) routingStore.patch({ oneShotAgent: null });
      // E-03: an escalated retry / handoff pins engine, model and effort for this one send.
      const oneShot = staleRetry ? null : current.oneShotPlan;
      if (current.oneShotPlan) routingStore.patch({ oneShotPlan: null });
      const route = await aidevApi.route({
        text,
        sessionId: context.sessionId,
        sessionEngine: context.isNewSession ? null : asEngine(context.provider),
        preferEngine: oneShot?.engine ?? overrides.engine ?? (context.isNewSession ? null : asEngine(context.provider)),
        targetId: overrides.targetId ?? null,
        projectHint: context.projectHint ?? null,
        projectPath: context.projectPath ?? null,
        model: oneShot?.model ?? overrides.model ?? null,
        effort: oneShot?.effort ?? overrides.effort ?? null,
        forceAgent,
        // the chat's own ceiling and model floor: stored server-side for known sessions, sent inline for a new chat
        effortCap: current.chatCap.sessionId === (context.isNewSession ? null : context.sessionId ?? null) ? current.chatCap.cap : null,
        modelFloor: current.chatFloor.sessionId === (context.isNewSession ? null : context.sessionId ?? null) ? current.chatFloor.floor : null,
      });
      // The composer's provider is an engine this account does not route to (OpenCode where no administrator enabled
      // it): sent as it is. Routed, a new chat the user started on OpenCode became a Claude or Codex session, and an
      // existing one logged its runs under an engine that never ran them.
      const composerEngine = asEngine(context.provider);
      if (composerEngine && route.engines[composerEngine]?.allowed === false) {
        routingStore.patch({ busy: false });
        return null;
      }
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
      routingStore.setFor('sent', context.sessionId, { runId, text, agent: route.agent.name, reported: false });
      // Pinned by hand to the other engine (bar chip, or a model from the other engine's list): sessions are
      // provider-bound, so this chat cannot run there — the send continues in a new session on that engine (handoff).
      const sessionEngine = context.isNewSession ? null : asEngine(context.provider);
      const pinnedElsewhere = sessionEngine && !oneShot && overrides.engine && overrides.engine !== sessionEngine ? overrides.engine : null;
      if (current.mode === 'manual' && !current.overrides.agent && !current.overrides.model && !pinnedElsewhere) {
        // Manual mode: show the plan, but send without it until the user applies it from the bar.
        return null;
      }
      const applyPlan = !context.userPinnedModel && route.plan.engine !== null && (context.isNewSession || route.plan.engine === asEngine(context.provider));
      const payload = buildAidevPayload(route, runId);
      // No fitting specialist: the gateway designs it out of band (route.create.design) while this turn runs on the
      // routed agent — the architect never takes a turn of the chat (2026-11-09: an interruption, another chat's end or
      // a mistyped closing tag each lost the design when the app read it back from the chat).
      // a manual engine choice for this send (chip/bar, escalation, handoff) keeps the chat where it is
      const manualEngine = Boolean(oneShot?.engine || overrides.engine);
      return {
        aidev: payload,
        model: applyPlan ? route.plan.model : null,
        effort: applyPlan ? route.plan.effort : null,
        route,
        runId,
        appResend: Boolean(oneShotAgent || oneShot),
        switchBack: pinnedElsewhere ? { engine: pinnedElsewhere, reason: `the user pinned this chat to ${pinnedElsewhere}` }
          : route.plan.switch_back && !manualEngine && !context.isNewSession ? route.plan.switch_back : null,
      };
    } catch (error) {
      routingStore.patch({ busy: false, error: error instanceof Error ? error.message : 'routing failed' });
      return null;
    }
  }, []);

  /**
   * Records the terminal signal of a routed run (§3.8). A run's end (`exit_code`) is matched to the run its own chat
   * last opened — never to the page's last send, which may belong to another chat — and is reported once; feedback
   * goes to the last run.
   */
  const reportOutcome = useCallback(async (outcome: { session_id?: string | null; exit_code?: number | null; tool_errors?: number; user_feedback?: 'up' | 'down' | null; test_result?: 'pass' | 'fail' | null; summary?: string; reverted?: boolean; /** the engine refused the run on a usage limit (its reset time when known) */ usage_limit?: { type: string; resets_at: number | null } | null }, runId?: number | null) => {
    const ending = outcome.exit_code !== undefined;
    const sentMap = routingStore.get().sent;
    const sentKey = outcome.session_id && sentMap[outcome.session_id] ? outcome.session_id : sentMap[''] ? null : outcome.session_id ?? null;
    const sent = ending ? sentMap[sessionKey(sentKey)] ?? null : null;
    // a chat's run that this page did not route (sent from another device, a timer) has nothing to report here
    if (ending && !runId && (!sent || sent.reported)) return null;
    const id = runId ?? (ending ? sent?.runId : routingStore.get().runId) ?? null;
    if (ending && sent) routingStore.setFor('sent', sentKey, { ...sent, reported: true });
    const isLastRun = id !== null && id === routingStore.get().runId;
    if (ending && isLastRun) routingStore.patch({ runFinishedAt: Date.now() });
    if (outcome.user_feedback) routingStore.patch({ runFeedback: outcome.user_feedback });
    if (outcome.session_id && isLastRun) routingStore.patch({ runSessionId: outcome.session_id });
    if (!id) {
      return null;
    }
    const chatId = outcome.session_id ?? (sent ? sentKey : routingStore.get().runSessionId);
    const followUp = { text: sent?.text ?? routingStore.get().lastText ?? '', agent: sent?.agent ?? routingStore.get().last?.agent.name ?? null };
    try {
      const result = await aidevApi.runOutcome(id, outcome);
      // E-03: a failed run comes back with a proposed next step (retry / stronger model / other engine), kept in its chat
      if (result.next) routingStore.setFor('escalations', chatId, { next: result.next, text: followUp.text, sessionId: chatId, agent: followUp.agent });
      // worker ≠ verifier: the gateway started an independent check of this run — follow it to its verdict
      if (result.verifying) { routingStore.setFor('verifications', chatId, { runId: id, status: 'pending', result: null }); void followVerification(id, chatId, followUp); }
      return result;
    } catch {
      return null;
    }
  }, []);

  return { state, beforeSend, reportOutcome, setMode: routingStore.setMode, setOverrides: routingStore.setOverrides, clearOverrides: routingStore.clearOverrides };
}
