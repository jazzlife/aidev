import type { openStore } from './store.js';
import { EFFORT_LADDER, routingHint, type Engine } from './store-aidev.js';
import { budgetState, topChoice, type LayaClient, type Question } from './laya.js';
import { DEPTH_LEVELS, REMOTE_ACTIONS, RISK_LEVELS, TASK_KIND_CRITERIA, decide } from './laya-questions.js';
import { NaiveBayesRouter, fuse, tokenize } from './classifier.js';
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Weight of Laya vs the lexical prior in the fused agent choice (tuned on the bench set; env LAYA_WEIGHT). */
export const LAYA_WEIGHT = Math.max(0, Math.min(1, Number(process.env.LAYA_WEIGHT ?? 0.3)));   // bench 2026-09-23: plateau 0.2–0.35 (0.833)
/** Weight of Laya vs the lexical prior for task_kind (env LAYA_KIND_WEIGHT). */
export const LAYA_KIND_WEIGHT = Math.max(0, Math.min(1, Number(process.env.LAYA_KIND_WEIGHT ?? 0.35)));
/** Weight of Laya vs the lexical prior for remote_action (env LAYA_REMOTE_WEIGHT; bench: /route/eval remote). */
export const LAYA_REMOTE_WEIGHT = Math.max(0, Math.min(1, Number(process.env.LAYA_REMOTE_WEIGHT ?? 0.35)));
/** A remote action below this fused probability is treated as 'none' (the agent can still reach the PC through its tools). */
export const REMOTE_MIN_P = Math.max(0, Math.min(1, Number(process.env.REMOTE_MIN_P ?? 0.5)));
const nb = new NaiveBayesRouter();
const kindNb = new NaiveBayesRouter();
// remote_action lexical prior: a fixed labelled set shipped with the gateway (data/remote-actions.jsonl), loaded once
const remoteNb = new NaiveBayesRouter();
let remoteLoaded = false;
function loadRemoteExamples() {
  if (remoteLoaded) return;
  remoteLoaded = true;
  try {
    const file = process.env.AIDEV_REMOTE_EXAMPLES_FILE ?? new URL('../data/remote-actions.jsonl', import.meta.url).pathname;
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { text: string; remote_action: string });
    remoteNb.train(rows.filter((r) => r.text && r.remote_action in REMOTE_ACTIONS).map((r) => ({ text: r.text, agent: r.remote_action })));
  } catch (error) { console.warn('[gateway] remote-action examples not loaded:', error instanceof Error ? error.message : error); }
}
/** Lexical prior over REMOTE_ACTIONS ({} when the examples are missing). */
export function remotePrior(text: string) {
  loadRemoteExamples();
  return remoteNb.predict(text, Object.keys(REMOTE_ACTIONS));
}
/** The remote action route() uses: Laya fused with the lexical prior; under `minP` → 'none'. */
export function remoteDecision(layaP: Record<string, number> | null, nbP: Record<string, number> | null, alpha = LAYA_REMOTE_WEIGHT, minP = REMOTE_MIN_P) {
  const probabilities = fuse(layaP, nbP, alpha);
  const top = topChoice({ probabilities });
  return { action: top.choice && top.probability >= minP ? top.choice : 'none', probability: top.probability, probabilities };
}

/** A target named in the command ("m4pro에서 …", "on jazzlife-mac"): the longest registered name that appears as a word. */
export function mentionedTarget<T extends { name: string }>(text: string, targets: T[]): T | null {
  const lower = text.toLowerCase();
  const hits = targets.filter((t) => {
    const name = t.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[- ]?');
    return new RegExp(`(^|[^a-z0-9_-])${name}($|[^a-z0-9_-])`).test(lower);
  });
  return hits.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

/** Commands about an attached phone/TV/emulator (device.select applies only to these). */
const DEVICE_WORDS = /(기기|디바이스|단말|휴대폰|핸드폰|스마트폰|폰에|폰으로|갤럭시|태블릿|\btv\b|티비|워치|에뮬레이터|시뮬레이터|안드로이드|타이젠|\bdevice\b|\bphone\b|\bemulator\b|\bandroid\b|\btizen\b|\badb\b|\bsdb\b|\bapk\b|\btpk\b|\bwatch\b|\btablet\b)/i;
export function mentionsDevice(text: string) { return DEVICE_WORDS.test(text); }
/** Serials of the devices a target reports (runner caps.devices.{adb,sdb}), tagged with their tool. */
export function targetDevices(capabilities: unknown): Array<{ serial: string; tool: 'adb' | 'sdb' }> {
  const devices = (capabilities as { devices?: { adb?: unknown; sdb?: unknown } } | null)?.devices;
  const list = (tool: 'adb' | 'sdb') => (Array.isArray(devices?.[tool]) ? (devices![tool] as unknown[]).map(String).filter(Boolean).map((serial) => ({ serial, tool })) : []);
  return [...list('adb'), ...list('sdb')];
}
/** Short description of a target for Laya's target.select: platform, tags, tools, devices, screen. */
export function describeTarget(t: { description: string; platform: string | null; tags: string | null; capabilities: string | null }) {
  let caps: { tools?: Record<string, unknown>; screen?: boolean; devices?: unknown } = {};
  try { caps = t.capabilities ? JSON.parse(t.capabilities) : {}; } catch { /* stored by the runner */ }
  let tags: string[] = [];
  try { tags = t.tags ? JSON.parse(t.tags) as string[] : []; } catch { /* legacy */ }
  const devices = targetDevices(caps).map((d) => `${d.tool}:${d.serial}`);
  return [t.description || null, `platform ${t.platform ?? '?'}`, tags.length ? `tags ${tags.join(', ')}` : null,
    caps.tools ? `tools ${Object.keys(caps.tools).join(', ')}` : null, devices.length ? `devices ${devices.join(', ')}` : null, caps.screen ? 'screen capture' : null]
    .filter(Boolean).join('; ').slice(0, 580);
}
let nbVersion = -1;
function retrain(store: Store) {
  if (nbVersion !== store.examplesVersion() || nb.size === 0) { nb.train(store.allExamples()); kindNb.train(store.kindExamples()); nbVersion = store.examplesVersion(); }
}
/** Lexical prior over the caller's catalog; retrained lazily when examples change. */
export function lexicalPrior(store: Store, text: string, names: string[]) {
  retrain(store);
  return nb.predict(text, names);
}
/** Lexical prior over task kinds (same examples, `task_kind` labels); {} until any example carries a label. */
export function kindPrior(store: Store, text: string) {
  retrain(store);
  return kindNb.predict(text, Object.keys(TASK_KIND_CRITERIA));
}
const MIN_EXAMPLES = 10;
/** Per-agent fusion weight: well-exemplified agents use LAYA_WEIGHT, sparse ones lean on Laya. */
export const alphaFor = (name: string) => (nb.count(name) >= MIN_EXAMPLES ? LAYA_WEIGHT : 0.85);

/**
 * Send-time composite decision (IMPLEMENTATION-PLAN §3.1, §3.4): scope → agent → engine → model/effort,
 * plus the lessons/knowledge to inject. One Laya call (plus a shortlist call when the catalog is large).
 */
type Store = ReturnType<typeof openStore>;
export type EngineAvailability = Record<Engine, { allowed: boolean; authenticated: boolean; error?: string | null }>;
export type RouteInput = { text: string; sessionId?: string | null; sessionEngine?: Engine | null; preferEngine?: Engine | null; targetId?: number | null; projectHint?: string | null; recentFiles?: string[] | null; model?: string | null; effort?: string | null; /** user override: use this agent regardless of Laya's pick */ forceAgent?: string | null;
  /** this chat's own ceiling (a new chat sends it with its first message; later it is stored per session) */ effortCap?: Partial<Record<Engine, string>> | null };

// Each engine's ladder ends on its strongest model: Codex gpt-6-astra, Claude 'best' (= Fable when the
// subscription has it, else the latest Opus — resolved by the Claude CLI). 'opusplan' is not used at
// the top: it plans with Opus but executes with Sonnet, i.e. weaker than D3 on the hardest tasks.
export const TIER_TABLE: Record<number, Record<Engine, { model: string; effort: string }>> = {
  0: { claude: { model: 'haiku', effort: 'low' }, codex: { model: 'gpt-5.6-luna', effort: 'low' } },
  1: { claude: { model: 'sonnet', effort: 'medium' }, codex: { model: 'gpt-5.6-terra', effort: 'medium' } },
  2: { claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-5.6-terra', effort: 'high' } },
  3: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-5.6-sol', effort: 'high' } },
  4: { claude: { model: 'best', effort: 'xhigh' }, codex: { model: 'gpt-6-astra', effort: 'xhigh' } },
};
const LESSON_TOPK = [0, 3, 5, Infinity, Infinity];
const PROMPT_BUDGET_CHARS = [2000 * 4, 4000 * 4, 8000 * 4, Infinity, Infinity];
const KNOWLEDGE_DIGEST_CHARS = [0, 0, 2000 * 4, 8000 * 4, 8000 * 4];

/**
 * The effort a tier runs at under the user's ceiling (§3.4): the top level (D4) uses the ceiling itself
 * — so raising it to max/ultra is how the strongest runs get deeper reasoning — and every other level is
 * lowered to the ceiling when it would exceed it. Used by route() and escalation.decideNext().
 */
export function applyEffortCap(effort: string | null, level: number, engine: Engine, cap: string): string | null {
  if (!effort) return effort;
  const ladder = EFFORT_LADDER[engine];
  const capIndex = ladder.indexOf(cap);
  if (capIndex < 0) return effort;
  if (level >= 4) return cap;
  const index = ladder.indexOf(effort);
  return index > capIndex ? cap : effort;
}

/** Minimum depth per task kind: debugging, refactoring and design need a reasoning model even when the command is short. */
export const KIND_MIN_DEPTH: Record<string, number> = { debug: 2, refactor: 2, design: 2, implement: 1, ops: 1, bulk_read: 1, explain: 0 };
const DEPTH_ROUND_UP = 0.65;   // floor(x + 0.65): fractional part ≥ .35 rounds up
const FALLBACK_DEPTH = 2;      // Laya unavailable: assume real work rather than a lookup

/** Strength of a model on its engine's ladder (TIER_TABLE level of its first appearance; aliases included). */
export function modelRank(engine: Engine, model: string | null): number {
  if (!model) return -1;
  const aliases: Record<string, string> = { fable: 'best', 'opus[1m]': 'opus', 'sonnet[1m]': 'sonnet' };
  const name = aliases[model] ?? model;
  for (let level = 0; level <= 4; level++) if (TIER_TABLE[level][engine].model === name) return level;
  return 2;   // unknown model: treat as mid-tier
}

function clampDepth(d: number) { return Math.max(0, Math.min(4, Math.round(d))); }

/**
 * remote_action on its held-out set (F-08): Laya alone (the old rule: top ≥ 0.6), the lexical prior
 * alone, the fused pick at the configured weight/threshold, and a weight × threshold sweep. `recall`:
 * commands that need the PC and got some action; `false_remote`: 'none' commands sent to the PC.
 */
async function evaluateRemote(laya: LayaClient, rows: Array<{ text: string; remote_action: string; lang?: string }>) {
  const items: Array<{ label: string; lang?: string; laya: Record<string, number> | null; nb: Record<string, number> }> = [];
  let failures = 0;
  for (const row of rows) {
    let layaP: Record<string, number> | null = null;
    try {
      const r = await laya.predict({ command: row.text }, { remote_action: { type: 'choice', instructions: 'Does this developer command require running something on the user\'s remote machine, and what?', criteria: REMOTE_ACTIONS } });
      layaP = r.answers.remote_action?.probabilities ?? null;
    } catch { failures++; }
    items.push({ label: row.remote_action, lang: row.lang, laya: layaP, nb: remotePrior(row.text) });
  }
  const score = (pick: (item: typeof items[number]) => string) => {
    let ok = 0, need = 0, hit = 0, none = 0, falseRemote = 0;
    for (const item of items) {
      const p = pick(item);
      if (p === item.label) ok++;
      if (item.label !== 'none') { need++; if (p !== 'none') hit++; } else { none++; if (p !== 'none') falseRemote++; }
    }
    const r3 = (x: number, n: number) => (n ? Number((x / n).toFixed(3)) : null);
    return { accuracy: r3(ok, items.length), recall: r3(hit, need), false_remote: r3(falseRemote, none) };
  };
  const layaOnly = (item: typeof items[number]) => { const t = topChoice({ probabilities: item.laya ?? {} }); return t.choice && t.probability >= 0.6 ? t.choice : 'none'; };
  const sweep: Array<{ alpha: number; min_p: number; accuracy: number | null; recall: number | null; false_remote: number | null }> = [];
  for (const alpha of [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1]) for (const minP of [0.4, 0.5, 0.6, 0.7]) sweep.push({ alpha, min_p: minP, ...score((item) => remoteDecision(item.laya, item.nb, alpha, minP).action) });
  const best = sweep.reduce((a, b) => ((b.accuracy ?? 0) > (a.accuracy ?? 0) ? b : a));
  const fused = score((item) => remoteDecision(item.laya, item.nb).action);
  return {
    n: items.length, laya_failures: failures, laya_weight: LAYA_REMOTE_WEIGHT, min_p: REMOTE_MIN_P,
    fused, laya_only: score(layaOnly), lexical_only: score((item) => remoteDecision(null, item.nb).action),
    fused_ko: (() => { const ko = items.filter((i) => i.lang === "ko"); return ko.length ? Number((ko.filter((i) => remoteDecision(i.laya, i.nb).action === i.label).length / ko.length).toFixed(3)) : null; })(),
    best, sweep,
  };
}

/**
 * Routing evaluation on a labelled command set (admin): Laya-only, lexical-only and fused agent
 * accuracy plus the best fusion weight. Used by /api/aidev/route/eval and verify-b.sh.
 */
export async function evaluateRouting(store: Store, laya: LayaClient, userId: number, rows: Array<{ text: string; agent: string; lang?: string; task_kind?: string | null }>, remoteRows: Array<{ text: string; remote_action: string; lang?: string }> = []) {
  const remote = remoteRows.length ? await evaluateRemote(laya, remoteRows) : null;
  const all = store.agents(userId).filter((a) => a.domain !== 'meta');
  const criteria: Record<string, string> = Object.fromEntries(all.map((a) => [a.name, routingHint(a)]));
  const names = Object.keys(criteria);
  const t0 = Date.now();
  const items: Array<{ text: string; agent: string; lang?: string; kind: string | null; laya: Record<string, number> | null; nb: Record<string, number>; kindLaya: Record<string, number> | null; kindNb: Record<string, number> }> = [];
  let layaFailures = 0;
  for (const row of rows) {
    const nbP = lexicalPrior(store, row.text, names);
    const kindP = kindPrior(store, row.text);
    let layaP: Record<string, number> | null = null; let kindLayaP: Record<string, number> | null = null;
    try {
      const r = await laya.predict({ command: row.text }, { agent: { type: 'choice', instructions: 'Which specialist should handle the developer request in `command`?', criteria }, task_kind: { type: 'choice', instructions: 'What kind of work is this command mainly asking for?', criteria: TASK_KIND_CRITERIA } });
      layaP = r.answers.agent?.probabilities ?? null; kindLayaP = r.answers.task_kind?.probabilities ?? null;
    } catch { layaFailures++; }
    items.push({ text: row.text, agent: row.agent, lang: row.lang, kind: row.task_kind ?? null, laya: layaP, nb: nbP, kindLaya: kindLayaP, kindNb: kindP });
  }
  const top = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0];
  // agent picks mirror route(): a best match under 0.5 is the generalist (the prior is never trained on it)
  const topAgent = (p: Record<string, number>) => { const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0]; return best ? (best[1] < 0.5 ? 'generalist' : best[0]) : undefined; };
  const acc = (pick: (item: typeof items[number]) => string | undefined, filter?: (item: typeof items[number]) => boolean) => {
    const subset = filter ? items.filter(filter) : items; if (!subset.length) return null;
    return Number((subset.filter((item) => pick(item) === item.agent).length / subset.length).toFixed(3));
  };
  const sweep = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1].map((alpha) => ({ alpha, accuracy: acc((item) => topAgent(fuse(item.laya, item.nb, alpha, (name) => (nb.count(name) >= MIN_EXAMPLES ? alpha : 0.85)))) }));
  const best = sweep.reduce((a, b) => ((b.accuracy ?? 0) > (a.accuracy ?? 0) ? b : a));
  // task_kind: same three-way comparison on the rows that carry a label
  const labelled = items.filter((item) => item.kind);
  const kindAcc = (pick: (item: typeof items[number]) => string | undefined) => (labelled.length ? Number((labelled.filter((item) => pick(item) === item.kind).length / labelled.length).toFixed(3)) : null);
  const kindSweep = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1].map((alpha) => ({ alpha, accuracy: kindAcc((item) => top(fuse(item.kindLaya, item.kindNb, alpha))) }));
  const kindBest = kindSweep.reduce((a, b) => ((b.accuracy ?? 0) > (a.accuracy ?? 0) ? b : a));
  const kind = {
    n: labelled.length, laya_weight: LAYA_KIND_WEIGHT, examples: store.kindExamples().length,
    laya_only: kindAcc((item) => (item.kindLaya ? top(item.kindLaya) : undefined)), lexical_only: kindAcc((item) => top(item.kindNb)),
    fused: kindAcc((item) => top(fuse(item.kindLaya, item.kindNb, LAYA_KIND_WEIGHT))),
    bulk_read_recall: (() => { const rows = labelled.filter((item) => item.kind === 'bulk_read'); return rows.length ? Number((rows.filter((item) => top(fuse(item.kindLaya, item.kindNb, LAYA_KIND_WEIGHT)) === 'bulk_read').length / rows.length).toFixed(3)) : null; })(),
    best_alpha: kindBest.alpha, sweep: kindSweep,
  };
  return {
    remote,
    kind,
    n: items.length, catalog: names.length, examples: store.exampleCount(), laya_failures: layaFailures, laya_weight: LAYA_WEIGHT,
    laya_only: acc((item) => (item.laya ? topAgent(item.laya) : undefined)), lexical_only: acc((item) => topAgent(item.nb)),
    fused: acc((item) => topAgent(fuse(item.laya, item.nb, LAYA_WEIGHT, alphaFor))),
    fused_ko: acc((item) => topAgent(fuse(item.laya, item.nb, LAYA_WEIGHT, alphaFor)), (item) => item.lang === 'ko'),
    fused_en: acc((item) => topAgent(fuse(item.laya, item.nb, LAYA_WEIGHT, alphaFor)), (item) => item.lang === 'en'),
    sweep, best_alpha: best.alpha, ms: Date.now() - t0,
  };
}

/**
 * Specialist judge (§3.1): an LLM turn (runtime, Claude haiku / Codex mini) that decides whether an EXISTING
 * agent truly specialises in the command. Laya and the lexical prior only rank agents against each other,
 * so their top pick "wins" even when nothing fits; the judge makes the absolute call. Only a true specialist
 * is used; a trivial/domain-less command goes to the generalist; otherwise a new specialist is created.
 */
export type JudgeVerdict = { agent: string | null; fit: number; reason: string; new: { name: string; domain: string; description: string; technologies: string[] } | null; /** the judge's wording of the clarifying question (used only when Laya's clarify asks) */ question?: string | null; engine?: string; ms?: number; source?: 'llm' | 'cache' | 'similar' };
export type SpecialistJudge = (input: { command: string; candidates: Array<{ name: string; description: string }>; project?: string | null }) => Promise<JudgeVerdict | null>;
const normText = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
function cosine(a: string[], b: string[]) {
  const ca = new Map<string, number>(); const cb = new Map<string, number>();
  for (const t of a) ca.set(t, (ca.get(t) ?? 0) + 1);
  for (const t of b) cb.set(t, (cb.get(t) ?? 0) + 1);
  let dot = 0; for (const [t, n] of ca) dot += n * (cb.get(t) ?? 0);
  const na = Math.sqrt([...ca.values()].reduce((x, n) => x + n * n, 0)); const nb = Math.sqrt([...cb.values()].reduce((x, n) => x + n * n, 0));
  return na && nb ? dot / (na * nb) : 0;
}
const SIMILAR_JUDGED = 0.8;
/** Bumped whenever the runtime judge prompt changes meaning (specialist-judge.service.ts): cached verdicts of an older
 *  prompt are not reused. 2: `question` + "command execution is never a specialist" (2026-10-01). */
const JUDGE_VERSION = 2;
/** How long a send waits for the judge (env AIDEV_JUDGE_WAIT_MS). A slower verdict is still cached for the next send. */
const JUDGE_WAIT_MS = Number(process.env.AIDEV_JUDGE_WAIT_MS ?? 20_000);
const MAX_PREJUDGE_PER_USER = 3;

/** Running judge calls, keyed by user + catalog + command: the typing-time pre-judge and the send share one call. */
const judging = new Map<string, Promise<JudgeVerdict | null>>();

type JudgeContext = { specialists: ReturnType<Store['agents']>; catalogSig: string; textNorm: string; key: string; known: JudgeVerdict | null };
/** What the judge would be asked, and a verdict that is already known (cache, or a judge-confirmed similar command). */
function judgeContext(store: Store, userId: number, text: string, nbTop: { choice: string | null; probability: number }): JudgeContext {
  const specialists = store.agents(userId).filter((a) => a.domain !== 'meta' && a.name !== 'generalist');
  const catalogSig = crypto.createHash('sha1').update(`judge${JUDGE_VERSION}|${specialists.map((a) => `${a.name}@${a.version}`).sort().join(',')}`).digest('hex').slice(0, 16);
  const textNorm = normText(text);
  let known = store.judgeCached(userId, textNorm, catalogSig) as JudgeVerdict | null;
  if (known) known = { ...known, source: 'cache' };
  if (!known && nbTop.choice && nbTop.probability >= 0.9) {
    const candidate = specialists.find((a) => a.name === nbTop.choice);
    const tokens = tokenize(text);
    const best = candidate ? Math.max(0, ...store.judgedExamples(candidate.id).map((ex) => cosine(tokens, tokenize(ex)))) : 0;
    if (candidate && best >= SIMILAR_JUDGED) known = { agent: candidate.name, fit: 0.9, reason: `judge confirmed a similar command (${best.toFixed(2)})`, new: null, source: 'similar' };
  }
  return { specialists, catalogSig, textNorm, key: `${userId}|${catalogSig}|${textNorm}`, known };
}

/** Start (or join) the judge for this command. The verdict is cached when it arrives, even if nobody waits any more. */
function startJudge(store: Store, userId: number, ctx: JudgeContext, text: string, projectHint: string | null, judge: SpecialistJudge): Promise<JudgeVerdict | null> {
  const running = judging.get(ctx.key);
  if (running) return running;
  const promise = judge({ command: text, candidates: ctx.specialists.map((a) => ({ name: a.name, description: a.description })), project: projectHint })
    .then((v) => (v ? { ...v, source: 'llm' as const } : null))
    .catch(() => null)
    .then((v) => {
      if (v) store.cacheJudge(userId, ctx.textNorm, ctx.catalogSig, { agent: v.agent, fit: v.fit, reason: v.reason, new: v.new, question: v.question ?? null, engine: v.engine });
      return v;
    })
    .finally(() => judging.delete(ctx.key));
  judging.set(ctx.key, promise);
  return promise;
}

const waitAtMost = <T>(promise: Promise<T>, ms: number, onTimeout: T, timedOut?: () => void) => new Promise<T>((resolve) => {
  const timer = setTimeout(() => { timedOut?.(); resolve(onTimeout); }, ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(onTimeout); });
});

/**
 * Typing-time pre-judge (§3.1): the composer calls this when the user pauses typing, so the verdict is usually
 * cached by the time they press send (the judge takes ~3 s; Laya ~0.3 s). Never waits for the verdict.
 */
export function prejudge(store: Store, userId: number, input: { text: string; projectHint?: string | null }, judge: SpecialistJudge | undefined) {
  const text = input.text.trim();
  if (text.length < 4) return { status: 'skipped' as const, reason: 'too short' };
  if (!judge) return { status: 'skipped' as const, reason: 'no engine for the judge' };
  const names = store.agents(userId).filter((a) => a.domain !== 'meta').map((a) => a.name);
  const ctx = judgeContext(store, userId, text, topChoice({ probabilities: lexicalPrior(store, text, names) }));
  if (!ctx.specialists.length) return { status: 'skipped' as const, reason: 'no specialists' };
  if (ctx.known) return { status: ctx.known.source === 'cache' ? 'cached' as const : 'similar' as const, agent: ctx.known.agent };
  if (judging.has(ctx.key)) return { status: 'running' as const };
  // a fast typist would otherwise start one judge per pause; the latest few are enough
  if ([...judging.keys()].filter((k) => k.startsWith(`${userId}|`)).length >= MAX_PREJUDGE_PER_USER) return { status: 'skipped' as const, reason: 'busy' };
  void startJudge(store, userId, ctx, text, input.projectHint ?? null, judge);
  return { status: 'started' as const };
}

export async function route(store: Store, laya: LayaClient, userId: number, engines: EngineAvailability, input: RouteInput, opts: { judge?: SpecialistJudge } = {}) {
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
  const nbProbs = lexicalPrior(store, text, Object.keys(criteria));
  const nbTop = topChoice({ probabilities: nbProbs });
  const kindProbs = kindPrior(store, text);
  // remote_action: only asked when a PC is online; Laya fused with the lexical prior (bench: /route/eval remote)
  const remoteNbProbs = targets.length ? remotePrior(text) : {};
  let layaProbs: Record<string, number> | null = null;
  // ---- specialist judge: cached verdict → a judge-confirmed similar command → an LLM turn (runs alongside Laya)
  const jctx = judgeContext(store, userId, text, nbTop);
  let verdict: JudgeVerdict | null = input.forceAgent ? null : jctx.known;
  const judgeT0 = Date.now();
  let judgeTimedOut = false;
  const joined = !verdict && !input.forceAgent && judging.has(jctx.key);
  const judgePromise: Promise<JudgeVerdict | null> = verdict || input.forceAgent || !opts.judge || !jctx.specialists.length
    ? Promise.resolve(verdict)
    : waitAtMost(startJudge(store, userId, jctx, text, input.projectHint ?? null, opts.judge), JUDGE_WAIT_MS, null, () => { judgeTimedOut = true; });
  try {
    const r = await laya.predict(state, questions);
    latency = r.latency_ms ?? null; device = r.device ?? null;
    layaProbs = r.answers.agent?.probabilities ?? null;
    // Laya zero-shot is weak on 13-way agent choice; the lexical prior over agent examples carries
    // most of the signal (bench: NB 0.78 vs Laya 0.44) — fused in log space, weight LAYA_WEIGHT.
    agentTop = topChoice({ probabilities: fuse(layaProbs, nbProbs, LAYA_WEIGHT, alphaFor) });
    needsNew = r.answers.needs_new?.noul ?? 0;
    depthRaw = r.answers.depth?.score ?? 1;
    risk = r.answers.risk?.score ?? 1;
    multiDomain = r.answers.multi_domain?.noul ?? 0;
    clarify = r.answers.clarify?.noul ?? 0;
    // task_kind: the volume cues that mark bulk_read (line counts, "all files", log paths) are lexical,
    // so the same fusion applies (bench: see /route/eval kind_*).
    const tk = topChoice({ probabilities: fuse(r.answers.task_kind?.probabilities ?? null, kindProbs, LAYA_KIND_WEIGHT) }); taskKind = tk.choice ?? 'implement'; taskKindP = tk.probability;
    if (targets.length) { const ra = remoteDecision(r.answers.remote_action?.probabilities ?? null, remoteNbProbs); remoteAction = ra.action; remoteActionP = ra.probability; }
    probabilities = { agent: fuse(layaProbs, nbProbs, LAYA_WEIGHT, alphaFor), agent_laya: layaProbs, agent_nb: nbProbs, task_kind: fuse(r.answers.task_kind?.probabilities ?? null, kindProbs, LAYA_KIND_WEIGHT), task_kind_laya: r.answers.task_kind?.probabilities, task_kind_nb: kindProbs, depth: r.answers.depth?.probabilities, risk: r.answers.risk?.probabilities, remote_action: targets.length ? fuse(r.answers.remote_action?.probabilities ?? null, remoteNbProbs, LAYA_REMOTE_WEIGHT) : undefined, remote_action_laya: r.answers.remote_action?.probabilities, remote_action_nb: targets.length ? remoteNbProbs : undefined, needs_new: needsNew, multi_domain: multiDomain, clarify };
  } catch (error) {
    fallback = true; layaError = error instanceof Error ? error.message : String(error);
    // Laya down: the lexical prior alone still routes (agent only); scope falls back to D1/implement.
    if (Object.keys(nbProbs).length) { agentTop = topChoice({ probabilities: nbProbs }); probabilities = { agent: nbProbs, agent_nb: nbProbs }; }
    if (Object.keys(kindProbs).length) { const tk = topChoice({ probabilities: kindProbs }); taskKind = tk.choice ?? 'implement'; taskKindP = tk.probability; probabilities.task_kind = kindProbs; }
    if (Object.keys(remoteNbProbs).length) { const ra = remoteDecision(null, remoteNbProbs); remoteAction = ra.action; remoteActionP = ra.probability; probabilities.remote_action = remoteNbProbs; }
    depthRaw = FALLBACK_DEPTH;
    reason.push(`Laya unavailable (${layaError}); lexical prior only, depth D${FALLBACK_DEPTH}`);
  }

  // ---- agent decision (§0 expertise↔speed) ------------------------------------------------
  // Quality first (§3.4): an in-between depth score rounds up from .35, not .5 — a too-weak model costs
  // a failed run, a slightly stronger one only some usage.
  const scoredDepth = clampDepth(Math.floor(depthRaw + (risk >= 1.5 ? 1 : 0) + DEPTH_ROUND_UP));
  if (risk >= 1.5) reason.push(`risk ${risk.toFixed(1)} → depth +1`);
  let agentName = agentTop.choice && catalog[agentTop.choice] ? agentTop.choice : 'generalist';
  let decision: 'use' | 'generalist' | 'create' | 'create_background' = 'use';
  // how long the send waited for the judge beyond Laya (0 when the verdict was cached or pre-judged in time)
  const layaDoneAt = Date.now();
  verdict = await judgePromise;
  const judgeWaitMs = Date.now() - layaDoneAt;
  if (!verdict && !input.forceAgent && opts.judge && jctx.specialists.length) reason.push(judgeTimedOut ? `specialist judge still running after ${Math.round((Date.now() - judgeT0) / 1000)}s — its verdict is cached for the next send` : 'specialist judge failed');
  let proposal: JudgeVerdict['new'] = null;
  if (input.forceAgent) { /* handled below */ }
  else if (verdict) {
    const judged = verdict.agent && verdict.agent !== 'generalist' ? store.agent(userId, verdict.agent) : undefined;
    if (judged && judged.domain !== 'meta' && verdict.fit >= 0.6) {
      agentName = judged.name; decision = 'use';
      reason.push(`specialist judge: ${judged.name} (fit ${verdict.fit.toFixed(2)}, ${verdict.source}${verdict.reason ? `: ${verdict.reason}` : ''})${agentTop.choice !== judged.name ? ` — ranker had ${agentTop.choice} ${agentTop.probability.toFixed(2)}` : ''}`);
      // a confirmed command becomes an example of that specialist: the lexical prior learns from the judge
      if (verdict.source === 'llm') store.addExamples(judged.id, [{ text, source: 'judge', taskKind: null }]);
    } else if (verdict.agent === 'generalist') {
      agentName = 'generalist'; decision = 'generalist';
      reason.push(`specialist judge: general request → generalist${verdict.reason ? ` (${verdict.reason})` : ''}`);
    } else if (!verdict.new && verdict.question) {
      // no specialist and no domain to propose because the command itself is unclear ("그 버그 고쳐줘"):
      // creating an agent would be a guess — the generalist runs it and the clarify prompt can ask first
      agentName = 'generalist'; decision = 'generalist';
      reason.push(`specialist judge: command unclear, no domain to create for → generalist (${verdict.question})`);
    } else {
      agentName = 'generalist'; decision = 'create'; proposal = verdict.new;
      reason.push(`specialist judge: no existing specialist${verdict.new ? ` → create ${verdict.new.name} (${verdict.new.domain})` : ''}${verdict.reason ? `: ${verdict.reason}` : ''}`);
    }
  }
  else if (fallback && agentTop.probability < 0.5) { agentName = 'generalist'; decision = 'generalist'; }
  else if (fallback) { reason.push(`lexical prior ${agentName} ${(agentTop.probability * 100).toFixed(0)}%`); }
  else if (needsNew >= 0.5 && agentTop.probability < 0.7 && nbTop.probability < 0.6) {
    // Laya's needs_new is noisy; a confident lexical match ("react로 todo 앱" → frontend-react) vetoes creation.
    decision = scoredDepth >= 2 ? 'create' : 'create_background';
    agentName = 'generalist';
    reason.push(`no fitting agent (needs_new ${needsNew.toFixed(2)}, best ${agentTop.choice} ${agentTop.probability.toFixed(2)}) → ${decision}`);
  } else if (agentTop.probability < 0.5) {
    // no judge available: an ambiguous pick is not a specialist — shallow work goes to the generalist, deeper work creates one
    if (scoredDepth <= 1) { decision = 'generalist'; agentName = 'generalist'; reason.push(`ambiguous agent (${agentTop.probability.toFixed(2)}) and shallow → generalist fast path`); }
    else { decision = 'create'; agentName = 'generalist'; reason.push(`ambiguous agent (${agentTop.probability.toFixed(2)}) and no specialist judge → create`); }
  } else reason.push(`agent ${agentName} ${(agentTop.probability * 100).toFixed(0)}% (specialist judge unavailable)`);
  if (input.forceAgent && store.agent(userId, input.forceAgent)) { agentName = input.forceAgent; decision = 'use'; reason.push(`user override → ${agentName}`); }
  const needsLlmAnalysis = !fallback && (agentTop.probability < 0.5 || depthRaw >= 2.5 || multiDomain > 0.6);
  // Clarify (§3.1): the judge decides when it ran — on the server Laya's clarify did not separate vague from specific
  // commands (0.36 "로그인 버튼 고쳐줘" vs 0.42 with the file and behavior named) while the judge got 3/3. Laya decides
  // only without a verdict that carries the field (judge down, a 'similar' shortcut, a cache entry from before it).
  const judgeAsks = verdict && verdict.question !== undefined ? Boolean(verdict.question) : null;
  const agent = store.agent(userId, agentName) ?? store.agent(userId, 'generalist') ?? all[0];
  if (!agent) throw new Error('Agent catalog is empty');
  // floors: the kind of work and the specialist itself set a minimum depth (model tier, lessons, knowledge)
  const kindFloor = KIND_MIN_DEPTH[taskKind] ?? 0;
  const agentFloor = agent.name === 'generalist' ? 0 : (agent.min_tier ?? 0);
  const depth = Math.max(scoredDepth, kindFloor, agentFloor);
  // the final depth: a kind floor (debug ≥ D2) says the work is not a quick one even when Laya scored it D1
  const askClarify = depth >= 2 && (judgeAsks ?? (!fallback && clarify > 0.7));
  if (depth > scoredDepth) reason.push(`depth D${scoredDepth} → D${depth} (${[kindFloor > scoredDepth ? `${taskKind} ≥ D${kindFloor}` : null, agentFloor > scoredDepth ? `${agent.name} ≥ D${agentFloor}` : null].filter(Boolean).join(', ')})`);

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
  let engineError: string | null = null;
  if (input.sessionEngine && engines[input.sessionEngine]?.allowed) {
    engine = input.sessionEngine; engineLocked = true; reason.push(`session is bound to ${engine}`);
    // the bound engine cannot run right now (expired OAuth, missing key): say so instead of failing mid-turn
    if (!engines[engine].authenticated) { engineError = engines[engine].error ?? `${engine} is not authenticated`; reason.push(`${engine} unavailable: ${engineError}`); }
  }
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
    // an agent-pinned model applies only when it is at least as strong as the tier's (it never weakens a run)
    if (agent.model && modelRank(engine, agent.model) >= modelRank(engine, tier.model)) { if (agent.model !== tier.model) reason.push(`agent pins model ${agent.model}`); tier.model = agent.model; }
    else if (agent.model) reason.push(`agent model ${agent.model} ignored (weaker than ${tier.model})`);
    // the user's effort ceiling: the top tier runs at the ceiling, no tier goes above it
    const capInfo = store.effectiveEffortCap(userId, input.sessionId, input.effortCap);
    const ceiling = capInfo.cap[engine];
    const capped = applyEffortCap(tier.effort, tp?.level ?? depth, engine, ceiling);
    if (capped !== tier.effort) { reason.push(`effort ${tier.effort} → ${capped} (ceiling ${ceiling}${capInfo.chat?.[engine] ? ', this chat' : ''})`); tier.effort = capped; }
  }
  if (input.model) { tier.model = input.model; reason.push(`user model ${input.model}`); }
  if (input.effort) { tier.effort = input.effort; reason.push(`user effort ${input.effort}`); }

  // ---- target (F-08) ----------------------------------------------------------------------------
  // The explicit pick (router chip) → a PC named in the command → this chat's pinned PC → the account's
  // default PC → the only online PC → Laya target.select over the online PCs (platform, tools, devices).
  const named = mentionedTarget(text, targets);
  if (named && remoteAction === 'none') {
    // naming a PC means something happens there: the likeliest non-'none' action (default run)
    const rp = (probabilities.remote_action ?? {}) as Record<string, number>;
    remoteAction = Object.entries(rp).filter(([k]) => k !== 'none').sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'run';
    reason.push(`${named.name} named in the command → remote ${remoteAction}`);
  }
  // an unclear command (the judge asks back) is not sent to a PC on Laya's guess — server: "그 버그 고쳐줘" got
  // remote test 0.67 on the only PC. Naming a PC still counts; the answer to the question can bring it back.
  if (judgeAsks && !named && remoteAction !== 'none') {
    reason.push(`remote ${remoteAction} dropped: the command is unclear (asking back first)`);
    remoteAction = 'none';
  }
  let target: typeof targets[number] | null = null;
  let targetSource: 'input' | 'mention' | 'session' | 'default' | 'single' | 'laya' | null = null;
  let targetDecision: (Awaited<ReturnType<typeof decide>> & { decision_id: number }) | null = null;
  if (input.targetId) {
    target = targets.find((t) => t.id === input.targetId) ?? null;
    if (target) targetSource = 'input'; else reason.push(`chosen target ${input.targetId} is offline`);
  }
  if (!target && remoteAction !== 'none' && targets.length) {
    const pinnedId = input.sessionId ? store.sessionTarget(userId, input.sessionId) : null;
    const pinned = pinnedId ? targets.find((t) => t.id === pinnedId) ?? null : null;
    const byDefault = targets.find((t) => t.is_default) ?? null;
    if (named) { target = named; targetSource = 'mention'; }
    else if (pinned) { target = pinned; targetSource = 'session'; }
    else if (byDefault) { target = byDefault; targetSource = 'default'; }
    else if (targets.length === 1) { target = targets[0]; targetSource = 'single'; }
    else {
      // most recently seen first: Laya's low-confidence fallback is the first option
      const ordered = [...targets].sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));
      const options = Object.fromEntries(ordered.map((t) => [t.name, describeTarget(t)]));
      const d = await decide(laya, 'target.select', { state: { command: text, action: remoteAction }, options });
      const id = store.logKindDecision({ userId, kind: d.kind, command: text, answer: d.answer, confidence: d.confidence, probabilities: d.probabilities, latencyMs: d.latency_ms, device: d.device, fallback: d.fallback, state: { command: text, action: remoteAction, options } });
      targetDecision = { ...d, decision_id: id };
      target = ordered.find((t) => t.name === d.answer) ?? ordered[0];
      targetSource = 'laya';
    }
    if (pinnedId && !pinned && targetSource !== 'mention') reason.push('this chat\'s pinned PC is offline');
  }
  if (target) reason.push(`remote ${remoteAction} on ${target.name} (${targetSource})`);

  // ---- device (F-08): which attached phone/TV/emulator, when the target has any and the command is about one
  let targetDevice: { serial: string; tool: 'adb' | 'sdb'; source: 'mention' | 'single' | 'laya' } | null = null;
  let deviceDecision: (Awaited<ReturnType<typeof decide>> & { decision_id: number }) | null = null;
  if (target && remoteAction !== 'none') {
    let caps: unknown = null;
    try { caps = target.capabilities ? JSON.parse(target.capabilities) : null; } catch { /* runner-reported */ }
    const devices = targetDevices(caps);
    const lower = text.toLowerCase();
    const serialHit = devices.find((d) => lower.includes(d.serial.toLowerCase()));
    if (serialHit) targetDevice = { ...serialHit, source: 'mention' };
    else if (devices.length && mentionsDevice(text)) {
      if (devices.length === 1) targetDevice = { ...devices[0], source: 'single' };
      else {
        const options = Object.fromEntries(devices.map((d) => [d.serial, `${d.tool === 'adb' ? 'Android (adb)' : 'Tizen (sdb)'} device ${d.serial}`]));
        const d = await decide(laya, 'device.select', { state: { command: text, action: remoteAction, target: target.name }, options });
        const id = store.logKindDecision({ userId, kind: d.kind, command: text, answer: d.answer, confidence: d.confidence, probabilities: d.probabilities, latencyMs: d.latency_ms, device: d.device, fallback: d.fallback, state: { command: text, action: remoteAction, target: target.name, options } });
        deviceDecision = { ...d, decision_id: id };
        const pick = devices.find((x) => x.serial === d.answer) ?? devices[0];
        targetDevice = { ...pick, source: 'laya' };
      }
    }
    if (targetDevice) reason.push(`device ${targetDevice.tool}:${targetDevice.serial} (${targetDevice.source})`);
  }

  // ---- lessons / knowledge injection (§3.8) -----------------------------------------------------
  // (E-02) Pinned = verified 3+ times but the agent's prompt belongs to someone else (a global agent,
  // a private lesson): always carried, outside the top-k. Rules merged into the agent's own prompt
  // (promoted_version set) are not injected again. One relevant candidate may ride along on
  // probation: its run's outcome verifies or rejects it (store.applyLessonOutcome).
  const topk = LESSON_TOPK[depth];
  const verifiedAll = store.lessons(agent.id, userId, ['verified']).filter((l) => !l.promoted_version);
  const pinned = verifiedAll.filter((l) => l.promoted_to_prompt);
  const verified = verifiedAll.filter((l) => !l.promoted_to_prompt);
  let lessons = verified.slice(0, Number.isFinite(topk) ? topk : undefined);
  if (verified.length > topk && Number.isFinite(topk) && topk > 0) {
    const sel = await decide(laya, 'inject.select', { state: { command: text, k: topk }, options: Object.fromEntries(verified.slice(0, 20).map((l) => [String(l.id), `${l.trigger} → ${l.rule}`])) });
    const ids = Array.isArray(sel.answer) ? (sel.answer as string[]).map(Number) : [];
    if (ids.length) lessons = ids.map((id) => verified.find((l) => l.id === id)!).filter(Boolean);
  }
  lessons = [...pinned, ...lessons];
  let trial: (typeof lessons)[number] | null = null;
  if (depth >= 1 && !fallback) {
    const candidates = store.lessons(agent.id, userId, ['candidate']).slice(0, 5);
    for (const candidate of candidates) {
      const rel = await decide(laya, 'lesson.relevant', { state: { command: text, trigger: candidate.trigger, rule: candidate.rule } });
      if (typeof rel.answer === 'number' && rel.answer >= 0.6) { trial = candidate; reason.push(`trial lesson #${candidate.id} (${rel.answer.toFixed(2)})`); break; }
    }
  }
  if (trial) lessons.push(trial);
  let knowledgeDigest = '';
  const kBudget = KNOWLEDGE_DIGEST_CHARS[depth];
  if (kBudget > 0) {
    const items = store.knowledge(agent.id, undefined, userId);
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
    JSON.stringify({ agent: agentName, engine, model: tier.model, effort: tier.effort, depth, task_kind: taskKind, remote_action: remoteAction, target: target?.name ?? null, target_source: targetSource, device: targetDevice?.serial ?? null }), JSON.stringify(state).slice(0, 8000), decisionId);
  store.recordInjectedLessons(decisionId, lessons.map((l) => ({ id: l.id, trial: l === trial })));

  // Creation flow (§3.7): the client sends the same command to the agent-architect meta agent first.
  const architect = decision === 'create' || decision === 'create_background' ? store.agent(userId, 'agent-architect') : undefined;
  const create = architect ? {
    architect: { name: architect.name, version: architect.version, description: architect.description, prompt: architect.prompt, tools: architect.tools ? JSON.parse(architect.tools) as string[] : null, maxTurns: architect.max_turns, model: architect.model },
    catalog: all.map((a) => `${a.name}: ${routingHint(a)}`).join('\n'),
    background: decision === 'create_background',
    proposal,
  } : null;

  return {
    decision_id: decisionId,
    decision, fallback, laya_error: layaError, create,
    judge: verdict ? { agent: verdict.agent, fit: verdict.fit, reason: verdict.reason, source: verdict.source ?? null, engine: verdict.engine ?? null, ms: verdict.ms ?? null, wait_ms: judgeWaitMs, prejudged: joined, proposal: verdict.new } : null,
    scope: { depth, depth_raw: depthRaw, task_kind: taskKind, task_kind_probability: taskKindP, risk, multi_domain: multiDomain, clarify, remote_action: remoteAction, remote_action_probability: remoteActionP, needs_llm_analysis: needsLlmAnalysis, ask_clarify: askClarify, clarify_question: askClarify ? verdict?.question ?? null : null },
    agent: { id: agent.id, name: agent.name, version: agent.version, domain: agent.domain, description: agent.description, probability: agentTop.probability, confidence: agentTop.confidence,
      definition: { prompt, tools: agent.tools ? JSON.parse(agent.tools) as string[] : null, model: agent.model, maxTurns: agent.max_turns, skills: agent.skills ? JSON.parse(agent.skills) as string[] : null, mcpServers: agent.mcp_servers ? JSON.parse(agent.mcp_servers) as Record<string, unknown> : null } },
    alternatives: agentTop.ranked.filter(([name]) => name !== agentName).slice(0, 3).map(([name, probability]) => ({ name, probability, description: descriptions[name] })),
    needs_new: needsNew, shortlisted,
    plan: { engine, engine_locked: engineLocked, engine_error: engineError, model: tier.model, effort: tier.effort, target: target ? { id: target.id, name: target.name, platform: target.platform, tags: target.tags ? JSON.parse(target.tags) as string[] : [], capabilities: target.capabilities ? JSON.parse(target.capabilities) as unknown : null, source: targetSource } : null, device: targetDevice, reason },
    engines: { claude: { ...engines.claude, score: scores.claude.score, notes: scores.claude.parts }, codex: { ...engines.codex, score: scores.codex.score, notes: scores.codex.parts } },
    lessons: lessons.map((l) => ({ id: l.id, trigger: l.trigger, rule: l.rule, trial: l === trial })),
    knowledge_digest: knowledgeDigest || null,
    target_decision: targetDecision ? { decision_id: targetDecision.decision_id, answer: targetDecision.answer, confidence: targetDecision.confidence, fallback: targetDecision.fallback, probabilities: targetDecision.probabilities ?? null } : null,
    device_decision: deviceDecision ? { decision_id: deviceDecision.decision_id, answer: deviceDecision.answer, confidence: deviceDecision.confidence, fallback: deviceDecision.fallback } : null,
    // the online PCs the router chip offers (so it does not need a second request)
    targets: targets.map((t) => ({ id: t.id, name: t.name, platform: t.platform, is_default: Boolean(t.is_default) })),
    latency_ms: latency, total_ms: Date.now() - t0, device,
  };
}
