import { ENGINES, type Engine } from './store-aidev.js';

/**
 * Provider policy (docs/aidev/PROVIDER-ENGINE-PLAN.md §2.3, user decisions 2026-10-13): inside one provider the
 * model and the reasoning effort ("가중치 단계") are picked from the user's range — model floor..ceiling ×
 * effort floor..ceiling — split evenly over the difficulty D0..D4 by the combinations' intelligence scores
 * (Artificial Analysis, Coding Index by default), or by their count when a score is missing. When the ceiling
 * model is not strong enough for the difficulty (its level is below it), the ceiling model runs at its highest
 * effort (Q2) — routing never leaves the provider for that. A provider without a ladder keeps the tier table.
 */

/** Reasoning-effort levels of every provider, weakest first: effort floors and ceilings compare on this order. */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const effortRank = (effort: string | null | undefined) => EFFORT_ORDER.indexOf(effort ?? '');

export type CatalogModel = { model: string; /** the difficulty (judge level 0–4) it carries comfortably */ level: number; /** efforts it accepts, weakest first ([] = none) */ efforts: string[] };
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/**
 * The models each provider routes to, weakest first — the tier table's models (routing TIER_TABLE, store
 * MODEL_LADDER) with the level they serve up to and the efforts the runtime catalogs accept for them
 * (server/modules/providers/list/{claude,codex}/*-models.provider.ts: haiku takes none, luna stops at max).
 */
export const MODEL_CATALOG: Partial<Record<Engine, CatalogModel[]>> = {
  claude: [
    { model: 'haiku', level: 0, efforts: [] },
    { model: 'sonnet', level: 2, efforts: CLAUDE_EFFORTS },
    { model: 'opus', level: 3, efforts: CLAUDE_EFFORTS },
    { model: 'best', level: 4, efforts: CLAUDE_EFFORTS },
  ],
  codex: [
    { model: 'gpt-5.6-luna', level: 0, efforts: CODEX_EFFORTS.slice(0, 5) },
    { model: 'gpt-5.6-terra', level: 2, efforts: CODEX_EFFORTS },
    { model: 'gpt-5.6-sol', level: 3, efforts: CODEX_EFFORTS },
    { model: 'gpt-6-astra', level: 4, efforts: CODEX_EFFORTS },
  ],
};
/**
 * OpenCode has no fixed catalog: its models are what the user's sign-ins reach (the runtime's `opencode models`, kept
 * per account by the store), and how hard a task each carries is not measured — a model without a level counts as
 * D2, so anything harder runs at the ceiling model's highest effort (Q2).
 */
export const UNMEASURED_LEVEL = 2;
export const catalogModel = (catalog: CatalogModel[], model: string | null | undefined) => catalog.find((m) => m.model === model) ?? null;

/** What a provider's range is made of: the ladder (null = the tier table decides) and the four bounds. */
export type ProviderPolicy = {
  /** the provider's models with their levels and efforts: the fixed catalog, or the account's own list (OpenCode) */
  catalog: CatalogModel[];
  /** the models to use, weakest first; null = no policy for this provider (the tier table) */
  ladder: string[] | null;
  floor: string | null; ceiling: string | null;
  effortFloor: string | null; effortCap: string | null;
};
/** Intelligence score per `${model}|${effort}` ('' for a model without efforts). */
export type StepScores = Map<string, number>;
export const stepKey = (model: string, effort: string | null) => `${model}|${effort ?? ''}`;
export type Step = { model: string; effort: string | null; score: number | null };
export type StepPick = Step & { index: number; total: number; mode: 'score' | 'steps'; q2: boolean; target: number | null };

/** The ladder the policy runs on: its own models that are in the catalog, or the catalog by level. */
export function policyLadder(policy: Pick<ProviderPolicy, 'ladder' | 'catalog'>): string[] {
  const known = policy.catalog.map((m) => m.model);
  return policy.ladder ? policy.ladder.filter((model) => known.includes(model)) : known;
}

/**
 * The (model, effort) combinations of the range, ladder order then effort order: models floor..ceiling, efforts
 * floor..ceiling. A model without efforts is one step; a model none of whose efforts is in range keeps the one
 * nearest to it, so every model in range is reachable.
 */
export function policySteps(policy: ProviderPolicy, scores?: StepScores): Step[] {
  const ladder = policyLadder(policy);
  const lo = policy.floor && ladder.includes(policy.floor) ? ladder.indexOf(policy.floor) : 0;
  const hi = policy.ceiling && ladder.includes(policy.ceiling) ? ladder.indexOf(policy.ceiling) : ladder.length - 1;
  const min = policy.effortFloor ? effortRank(policy.effortFloor) : -1;
  const max = policy.effortCap ? effortRank(policy.effortCap) : EFFORT_ORDER.length;
  const steps: Step[] = [];
  for (const model of ladder.slice(lo, hi + 1)) {
    const spec = catalogModel(policy.catalog, model)!;
    let efforts: Array<string | null> = spec.efforts.filter((effort) => effortRank(effort) >= min && effortRank(effort) <= max);
    if (!spec.efforts.length) efforts = [null];
    else if (!efforts.length) {
      const distance = (effort: string) => { const r = effortRank(effort); return r < min ? min - r : r - max; };
      efforts = [[...spec.efforts].sort((a, b) => distance(a) - distance(b))[0]];
    }
    for (const effort of efforts) steps.push({ model, effort, score: scores?.get(stepKey(model, effort)) ?? null });
  }
  return steps;
}

/**
 * The step a difficulty `depth` (0–4) runs at. Q2: above the ceiling model's level → the last step (ceiling model,
 * highest effort in range). Otherwise the score range lo..hi is split evenly over D0..D4 and the cheapest step at
 * or above the target is taken; without a score for every step, the steps themselves are split evenly.
 */
export function pickStep(depth: number, policy: ProviderPolicy, scores?: StepScores): StepPick | null {
  const steps = policySteps(policy, scores);
  if (!steps.length) return null;
  const d = Math.max(0, Math.min(4, Math.round(depth)));
  const total = steps.length;
  const ceilingLevel = catalogModel(policy.catalog, steps[total - 1].model)?.level ?? 4;
  if (d > ceilingLevel) return { ...steps[total - 1], index: total - 1, total, mode: 'steps', q2: true, target: null };
  if (steps.every((step) => step.score !== null)) {
    // stable sort: equal scores keep ladder order (the weaker model, then the lower effort, first)
    const ranked = steps.map((step, index) => ({ step, index })).sort((a, b) => a.step.score! - b.step.score! || a.index - b.index);
    const lo = ranked[0].step.score!; const hi = ranked[ranked.length - 1].step.score!;
    const target = lo + (d / 4) * (hi - lo);
    const hit = ranked.find((r) => r.step.score! >= target - 1e-6) ?? ranked[ranked.length - 1];
    return { ...hit.step, index: hit.index, total, mode: 'score', q2: false, target: Math.round(target * 10) / 10 };
  }
  const index = Math.round((d / 4) * (total - 1));
  return { ...steps[index], index, total, mode: 'steps', q2: false, target: null };
}

/** What D0..D4 run at under the policy (settings preview; the same function routing uses). */
export function previewPolicy(policy: ProviderPolicy, scores?: StepScores): Array<StepPick | null> {
  return [0, 1, 2, 3, 4].map((depth) => pickStep(depth, policy, scores));
}

/**
 * Fills the scores a combination lacks from the same model's other efforts: linear between two known efforts,
 * or — when the model has one known effort only — that score shifted by the provider's average step between
 * adjacent efforts (measured on its other models). Returns the filled map and the keys that were estimated.
 */
export function estimateScores(catalog: CatalogModel[], known: StepScores): { scores: StepScores; estimated: Set<string> } {
  const scores: StepScores = new Map(known);
  const estimated = new Set<string>();
  const deltas: number[] = [];
  for (const spec of catalog) {
    const pts = spec.efforts.map((effort, i) => ({ i, s: known.get(stepKey(spec.model, effort)) })).filter((p): p is { i: number; s: number } => p.s !== undefined);
    for (let k = 1; k < pts.length; k++) deltas.push((pts[k].s - pts[k - 1].s) / (pts[k].i - pts[k - 1].i));
  }
  const step = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  for (const spec of catalog) {
    const pts = spec.efforts.map((effort, i) => ({ i, s: known.get(stepKey(spec.model, effort)) })).filter((p): p is { i: number; s: number } => p.s !== undefined);
    if (!pts.length) continue;
    spec.efforts.forEach((effort, i) => {
      const key = stepKey(spec.model, effort);
      if (scores.has(key)) return;
      const below = [...pts].reverse().find((p) => p.i < i); const above = pts.find((p) => p.i > i);
      let value: number | null = null;
      if (below && above) value = below.s + ((above.s - below.s) * (i - below.i)) / (above.i - below.i);
      else if (step !== null) { const near = below ?? above!; value = near.s + step * (i - near.i); }
      if (value !== null) { scores.set(key, Math.round(value * 10) / 10); estimated.add(key); }
    });
  }
  return { scores, estimated };
}

/** A ladder as the user sends it: known models only, each once, at least one (else an error). */
export function cleanLadder(engine: Engine, catalog: CatalogModel[], ladder: unknown): string[] {
  if (!Array.isArray(ladder)) throw new Error('ladder must be an array of models');
  const known = catalog.map((m) => m.model);
  const out = [...new Set(ladder.map(String))];
  const unknown = out.filter((model) => !known.includes(model));
  if (unknown.length) throw new Error(`${engine} model must be one of ${known.slice(0, 30).join('|')} (not ${unknown.join(',')})`);
  if (!out.length) throw new Error(`${engine} ladder needs at least one model`);
  return out;
}

/** The order of providers as the user sends it (work or verification priority): known engines, each once. */
export function cleanOrder(order: unknown): Engine[] {
  if (!Array.isArray(order)) throw new Error('order must be an array of engines');
  const out = [...new Set(order.map(String))];
  const unknown = out.filter((engine) => !ENGINES.includes(engine as Engine));
  if (unknown.length) throw new Error(`engines must be among ${ENGINES.join(',')}`);
  return out as Engine[];
}
