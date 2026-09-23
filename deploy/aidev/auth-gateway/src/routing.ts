import type { openStore } from './store.js';
import { routingHint, type Engine } from './store-aidev.js';
import { budgetState, topChoice, type LayaClient, type Question } from './laya.js';
import { DEPTH_LEVELS, REMOTE_ACTIONS, RISK_LEVELS, TASK_KIND_CRITERIA, decide } from './laya-questions.js';

/**
 * Send-time composite decision (IMPLEMENTATION-PLAN §3.1, §3.4): scope → agent → engine → model/effort,
 * plus the lessons/knowledge to inject. One Laya call (plus a shortlist call when the catalog is large).
 */
type Store = ReturnType<typeof openStore>;
export type EngineAvailability = Record<Engine, { allowed: boolean; authenticated: boolean; error?: string | null }>;
export type RouteInput = { text: string; sessionId?: string | null; sessionEngine?: Engine | null; preferEngine?: Engine | null; targetId?: number | null; projectHint?: string | null; recentFiles?: string[] | null; model?: string | null; effort?: string | null };

export const TIER_TABLE: Record<number, Record<Engine, { model: string; effort: string }>> = {
  0: { claude: { model: 'haiku', effort: 'low' }, codex: { model: 'gpt-5.6-luna', effort: 'low' } },
  1: { claude: { model: 'sonnet', effort: 'medium' }, codex: { model: 'gpt-5.6-terra', effort: 'medium' } },
  2: { claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-5.6-terra', effort: 'high' } },
  3: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-5.6-sol', effort: 'high' } },
  4: { claude: { model: 'opusplan', effort: 'xhigh' }, codex: { model: 'gpt-6-astra', effort: 'xhigh' } },
};
const LESSON_TOPK = [0, 3, 5, Infinity, Infinity];
const PROMPT_BUDGET_CHARS = [2000 * 4, 4000 * 4, 8000 * 4, Infinity, Infinity];
const KNOWLEDGE_DIGEST_CHARS = [0, 0, 2000 * 4, 8000 * 4, 8000 * 4];

function clampDepth(d: number) { return Math.max(0, Math.min(4, Math.round(d))); }

export async function route(store: Store, laya: LayaClient, userId: number, engines: EngineAvailability, input: RouteInput) {
  const t0 = Date.now();
  const reason: string[] = [];
  const text = input.text.trim();
  if (!text) throw new Error('text required');

  // ---- catalog ---------------------------------------------------------------------
  const all = store.agents(userId).filter((a) => a.domain !== 'meta');
  // Laya's option head is ~192 tokens for ALL options together, so every agent is presented as
  // "name: <short hint>"; the long bilingual descriptions would be truncated to their first words.
  const catalog: Record<string, string> = Object.fromEntries(all.map((a) => [a.name, routingHint(a)]));
  const descriptions: Record<string, string> = Object.fromEntries(all.map((a) => [a.name, a.description]));
  const state = budgetState({ command: text, project: input.projectHint ?? undefined, recent_files: input.recentFiles?.slice(0, 10)?.join(', ') || undefined });
  const agentInstructions = 'Which specialist should handle the developer request in `command`?';
  let shortlisted: string[] | null = null;
  let criteria = catalog;
  if (Object.keys(catalog).length > 20) {
    shortlisted = await laya.shortlist(state, catalog, 20, agentInstructions);
    if (!shortlisted.includes('generalist') && catalog.generalist) shortlisted.push('generalist');
    criteria = Object.fromEntries(shortlisted.map((k) => [k, catalog[k]]));
  }
  const targets = store.targets(userId).filter((t) => t.status === 'online');
  const questions: Record<string, Question> = {
    agent: { type: 'choice', instructions: agentInstructions, criteria },
    needs_new: { type: 'noul', instructions: 'Does this command need a specialist that is NOT in the list above (none of the listed agents fits the domain well)?' },
    depth: { type: 'score', instructions: 'How deep is this task?', criteria: DEPTH_LEVELS },
    task_kind: { type: 'choice', instructions: 'What kind of work is this command mainly asking for?', criteria: TASK_KIND_CRITERIA },
    risk: { type: 'score', instructions: 'How risky is executing this command on a developer workstation?', criteria: RISK_LEVELS },
    multi_domain: { type: 'noul', instructions: 'Does this command span two or more distinct specialist domains (for example frontend and database)?' },
    clarify: { type: 'noul', instructions: 'Is essential information missing (which file, project, target, expected behavior) so that one clarifying question should be asked before starting?' },
  };
  if (targets.length) questions.remote_action = { type: 'choice', instructions: 'Does this developer command require running something on the user\'s remote machine, and what?', criteria: REMOTE_ACTIONS };

  // ---- Laya --------------------------------------------------------------------------
  let fallback = false; let latency: number | null = null; let device: string | null = null; let layaError: string | null = null;
  let agentTop = { choice: 'generalist' as string | null, probability: 0, confidence: 0, ranked: [] as Array<[string, number]> };
  let needsNew = 0, depthRaw = 1, risk = 1, multiDomain = 0, clarify = 0, taskKind = 'implement', taskKindP = 0, remoteAction = 'none', remoteActionP = 0;
  let probabilities: Record<string, unknown> = {};
  try {
    const r = await laya.predict(state, questions);
    latency = r.latency_ms ?? null; device = r.device ?? null;
    agentTop = topChoice(r.answers.agent);
    needsNew = r.answers.needs_new?.noul ?? 0;
    depthRaw = r.answers.depth?.score ?? 1;
    risk = r.answers.risk?.score ?? 1;
    multiDomain = r.answers.multi_domain?.noul ?? 0;
    clarify = r.answers.clarify?.noul ?? 0;
    const tk = topChoice(r.answers.task_kind); taskKind = tk.choice ?? 'implement'; taskKindP = tk.probability;
    if (r.answers.remote_action) { const ra = topChoice(r.answers.remote_action); remoteAction = ra.choice ?? 'none'; remoteActionP = ra.probability; }
    probabilities = { agent: r.answers.agent?.probabilities, task_kind: r.answers.task_kind?.probabilities, depth: r.answers.depth?.probabilities, risk: r.answers.risk?.probabilities, remote_action: r.answers.remote_action?.probabilities, needs_new: needsNew, multi_domain: multiDomain, clarify };
  } catch (error) {
    fallback = true; layaError = error instanceof Error ? error.message : String(error);
    reason.push(`Laya unavailable (${layaError}); fallback generalist/D1`);
  }
  if (!fallback && remoteActionP < 0.6) remoteAction = 'none';

  // ---- agent decision (§0 expertise↔speed) ------------------------------------------------
  const depth = clampDepth(depthRaw + (risk >= 1.5 ? 1 : 0));
  if (risk >= 1.5) reason.push(`risk ${risk.toFixed(1)} → depth +1`);
  let agentName = agentTop.choice && catalog[agentTop.choice] ? agentTop.choice : 'generalist';
  let decision: 'use' | 'generalist' | 'create' | 'create_background' = 'use';
  if (fallback) { agentName = 'generalist'; decision = 'generalist'; }
  else if (needsNew >= 0.5 && agentTop.probability < 0.7) {
    decision = depth >= 2 ? 'create' : 'create_background';
    agentName = 'generalist';
    reason.push(`no fitting agent (needs_new ${needsNew.toFixed(2)}, best ${agentTop.choice} ${agentTop.probability.toFixed(2)}) → ${decision}`);
  } else if (agentTop.probability < 0.5) {
    if (depth <= 1) { decision = 'generalist'; agentName = 'generalist'; reason.push(`ambiguous agent (${agentTop.probability.toFixed(2)}) and shallow → generalist fast path`); }
    else reason.push(`ambiguous agent (${agentTop.probability.toFixed(2)}); using best match, LLM review suggested`);
  } else reason.push(`agent ${agentName} ${(agentTop.probability * 100).toFixed(0)}%`);
  const needsLlmAnalysis = !fallback && (agentTop.probability < 0.5 || depthRaw >= 2.5 || multiDomain > 0.6);
  const askClarify = !fallback && clarify > 0.7 && depth >= 2;
  const agent = store.agent(userId, agentName) ?? store.agent(userId, 'generalist') ?? all[0];
  if (!agent) throw new Error('Agent catalog is empty');

  // ---- engine (§3.4) ------------------------------------------------------------------------
  const weights = store.engineWeights();
  const scores: Record<Engine, { score: number | null; parts: string[] }> = { claude: { score: null, parts: [] }, codex: { score: null, parts: [] } };
  for (const engine of ['claude', 'codex'] as Engine[]) {
    const e = engines[engine];
    if (!e?.allowed) { scores[engine].parts.push('not allowed for this account'); continue; }
    if (!e.authenticated) { scores[engine].parts.push(`not authenticated${e.error ? ` (${e.error})` : ''}`); continue; }
    let s = weights[taskKind]?.[engine] ?? 0.5; scores[engine].parts.push(`w(${taskKind})=${s.toFixed(2)}`);
    const tp = store.tierPolicy(agent.domain, depth, engine);
    if (tp && tp.success_n + tp.fail_n >= 5) { const adj = Math.max(-0.2, Math.min(0.2, (tp.success_n / (tp.success_n + tp.fail_n) - 0.75) * 0.8)); s += adj; scores[engine].parts.push(`tier ${adj >= 0 ? '+' : ''}${adj.toFixed(2)}`); }
    const errs = store.recentEngineErrors(userId, engine, 3600_000);
    if (errs > 0) { s -= 0.3; scores[engine].parts.push(`recent failures −0.30`); }
    scores[engine].score = s;
  }
  const usable = (['claude', 'codex'] as Engine[]).filter((e) => scores[e].score !== null);
  let engine: Engine | null = null; let engineLocked = false;
  const acct = store.accountEngines(userId);
  if (input.sessionEngine && engines[input.sessionEngine]?.allowed) { engine = input.sessionEngine; engineLocked = true; reason.push(`session is bound to ${engine}`); }
  else if (input.preferEngine && usable.includes(input.preferEngine)) { engine = input.preferEngine; reason.push(`user prefers ${engine}`); }
  else if (usable.length) {
    const best = Math.max(...usable.map((e) => scores[e].score!));
    const tied = usable.filter((e) => Math.abs(scores[e].score! - best) < 1e-6);
    engine = tied.length === 1 ? tied[0] : (acct.defaultEngine && tied.includes(acct.defaultEngine) ? acct.defaultEngine : (tied.includes('claude') ? 'claude' : tied[0]));
    reason.push(`engine ${engine} (${usable.map((e) => `${e} ${scores[e].score!.toFixed(2)}`).join(', ')})`);
  } else reason.push('no engine is available (none allowed+authenticated)');
  // ---- tier -----------------------------------------------------------------------------------
  const tier = engine ? { ...TIER_TABLE[depth][engine] } : { model: null as string | null, effort: null as string | null };
  if (engine) {
    const tp = store.tierPolicy(agent.domain, depth, engine);
    if (tp?.model) { tier.model = tp.model; tier.effort = tp.effort ?? tier.effort; reason.push(`tier_policy override ${tp.model}/${tp.effort}`); }
    if (agent.model && depth <= 2) { /* agent-pinned model only wins at shallow depth; deeper tasks follow the tier */ tier.model = agent.model; reason.push(`agent pins model ${agent.model}`); }
  }
  if (input.model) { tier.model = input.model; reason.push(`user model ${input.model}`); }
  if (input.effort) { tier.effort = input.effort; reason.push(`user effort ${input.effort}`); }

  // ---- target ---------------------------------------------------------------------------------
  let target = input.targetId ? targets.find((t) => t.id === input.targetId) ?? null : null;
  let targetDecision: Awaited<ReturnType<typeof decide>> | null = null;
  if (!target && remoteAction !== 'none' && targets.length) {
    if (targets.length === 1) target = targets[0];
    else {
      targetDecision = await decide(laya, 'target.select', { state: { command: text, action: remoteAction }, options: Object.fromEntries(targets.map((t) => [t.name, `${t.description} (${t.platform ?? '?'}; ${t.tags ?? '[]'})`])) });
      target = targets.find((t) => t.name === targetDecision!.answer) ?? targets[0];
    }
    reason.push(`remote ${remoteAction} on ${target.name}`);
  }

  // ---- lessons / knowledge injection (§3.8) -----------------------------------------------------
  const topk = LESSON_TOPK[depth];
  const verified = store.lessons(agent.id, userId, ['verified']);
  let lessons = verified.slice(0, Number.isFinite(topk) ? topk : undefined);
  if (verified.length > topk && Number.isFinite(topk) && topk > 0) {
    const sel = await decide(laya, 'inject.select', { state: { command: text, k: topk }, options: Object.fromEntries(verified.slice(0, 20).map((l) => [String(l.id), `${l.trigger} → ${l.rule}`])) });
    const ids = Array.isArray(sel.answer) ? (sel.answer as string[]).map(Number) : [];
    if (ids.length) lessons = ids.map((id) => verified.find((l) => l.id === id)!).filter(Boolean);
  }
  store.bumpLessonHits(lessons.map((l) => l.id));
  let knowledgeDigest = '';
  const kBudget = KNOWLEDGE_DIGEST_CHARS[depth];
  if (kBudget > 0) {
    const items = store.knowledge(agent.id);
    const parts: string[] = [];
    let used = 0;
    for (const k of items) {
      const body = depth >= 3 ? k.body : k.body.slice(0, 300);
      const chunk = `### ${k.title}${k.source_url ? ` (${k.source_url}${k.source_date ? `, ${k.source_date}` : ''})` : ''}\n${body}`;
      if (used + chunk.length > kBudget) break;
      parts.push(chunk); used += chunk.length;
    }
    knowledgeDigest = parts.join('\n\n');
  }
  const promptBudget = PROMPT_BUDGET_CHARS[depth];
  const prompt = agent.prompt.length > promptBudget ? `${agent.prompt.slice(0, promptBudget)}…` : agent.prompt;

  // ---- log --------------------------------------------------------------------------------------
  const decisionId = store.logDecision({ userId, command: text, agent: agentName, probability: agentTop.probability, confidence: agentTop.confidence, needsNew, risk, decision, probabilities, latencyMs: latency ?? undefined, device: device ?? undefined });
  store.db.prepare('UPDATE decision_log SET kind=?, fallback=?, answer=?, state=? WHERE id=?').run('route', fallback ? 1 : 0,
    JSON.stringify({ agent: agentName, engine, model: tier.model, effort: tier.effort, depth, task_kind: taskKind, remote_action: remoteAction, target: target?.name ?? null }), JSON.stringify(state).slice(0, 8000), decisionId);
  if (decision === 'use') store.bumpAgentUse(userId, agentName);

  return {
    decision_id: decisionId,
    decision, fallback, laya_error: layaError,
    scope: { depth, depth_raw: depthRaw, task_kind: taskKind, task_kind_probability: taskKindP, risk, multi_domain: multiDomain, clarify, remote_action: remoteAction, needs_llm_analysis: needsLlmAnalysis, ask_clarify: askClarify },
    agent: { id: agent.id, name: agent.name, version: agent.version, domain: agent.domain, description: agent.description, probability: agentTop.probability, confidence: agentTop.confidence,
      definition: { prompt, tools: agent.tools ? JSON.parse(agent.tools) as string[] : null, model: agent.model, maxTurns: agent.max_turns, skills: agent.skills ? JSON.parse(agent.skills) as string[] : null, mcpServers: agent.mcp_servers ? JSON.parse(agent.mcp_servers) as Record<string, unknown> : null } },
    alternatives: agentTop.ranked.filter(([name]) => name !== agentName).slice(0, 3).map(([name, probability]) => ({ name, probability, description: descriptions[name] })),
    needs_new: needsNew, shortlisted,
    plan: { engine, engine_locked: engineLocked, model: tier.model, effort: tier.effort, target: target ? { id: target.id, name: target.name, platform: target.platform, tags: target.tags ? JSON.parse(target.tags) as string[] : [], capabilities: target.capabilities ? JSON.parse(target.capabilities) as unknown : null } : null, reason },
    engines: { claude: { ...engines.claude, score: scores.claude.score, notes: scores.claude.parts }, codex: { ...engines.codex, score: scores.codex.score, notes: scores.codex.parts } },
    lessons: lessons.map((l) => ({ id: l.id, trigger: l.trigger, rule: l.rule })),
    knowledge_digest: knowledgeDigest || null,
    target_decision: targetDecision ? { answer: targetDecision.answer, confidence: targetDecision.confidence, fallback: targetDecision.fallback } : null,
    latency_ms: latency, total_ms: Date.now() - t0, device,
  };
}
