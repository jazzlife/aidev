import type { openStore } from './store.js';
import type { Engine } from './store-aidev.js';
import { TIER_TABLE } from './routing.js';
import { runEngineWeights } from './engine-weights.js';

/**
 * Tier policy learning (IMPLEMENTATION-PLAN §3.8, E-05). Once a day the gateway aggregates finished
 * runs per cell (agent domain × depth × engine) and moves the cell's effective tier:
 *   success < 0.6 with n ≥ 5                   → one level up (stronger model / effort)
 *   success ≥ 0.9 with n ≥ 10, ≥ half of them 👍 and none re-asked → one level down (at most one below
 *     the table) — only when an administrator turned downgrades on (quality first: off by default)
 *   lowered cell with success < 0.75 and n ≥ 5 → back up (the cheaper tier did not hold)
 * Only runs that actually ran at the cell's current tier count (user-picked models and agent-pinned
 * models are ignored), and counting restarts whenever the cell changes, so a change is judged on its
 * own results. Every change is written to tier_policy_log; an administrator can pin a cell (the job
 * then only refreshes its statistics) or reset it. Routing reads the cell's model/effort.
 */
type Store = ReturnType<typeof openStore>;
export type TierChange = { domain: string; depth: number; engine: string; from: number; to: number; fromModel: string; toModel: string; successN: number; failN: number; reason: string };

const DAY = 86_400_000;
const UP_BELOW = 0.6; const UP_MIN_N = 5;
const DOWN_FROM = 0.9; const DOWN_MIN_N = 10; const DOWN_UP_SHARE = 0.5;
/** Downgrades are opt-in (app_kv tier_policy_downgrade=on); upgrades and returns always apply. */
export const downgradeEnabled = (store: Store) => store.kvGet('tier_policy_downgrade') === 'on';
const HOLD_BELOW = 0.75;

const tierOf = (level: number, engine: string) => TIER_TABLE[Math.max(0, Math.min(4, level))][engine as Engine];
const label = (level: number, engine: string) => { const t = tierOf(level, engine); return `D${level} ${t.model}/${t.effort}`; };

/** Aggregates and applies one pass; returns what changed (also logged). `windowDays` bounds the runs read. */
export function runTierPolicy(store: Store, opts: { windowDays?: number; actor?: string; now?: number } = {}): { cells: number; changes: TierChange[] } {
  const now = opts.now ?? Date.now();
  const since = now - (opts.windowDays ?? Number(process.env.AIDEV_TIER_WINDOW_DAYS ?? 30)) * DAY;
  const runs = store.policyRuns(since);
  const cells = new Map<string, { domain: string; depth: number; engine: string }>();
  for (const run of runs) {
    const depth = Math.max(0, Math.min(4, Math.round(run.depth)));
    if (run.engine !== 'claude' && run.engine !== 'codex') continue;
    cells.set(`${run.domain}|${depth}|${run.engine}`, { domain: run.domain, depth, engine: run.engine });
  }
  for (const row of store.tierPolicyRows()) if (row.domain !== '*') cells.set(`${row.domain}|${row.depth}|${row.engine}`, { domain: row.domain, depth: row.depth, engine: row.engine });

  const changes: TierChange[] = [];
  const downgrade = downgradeEnabled(store);
  for (const cell of cells.values()) {
    const row = store.tierPolicyRow(cell.domain, cell.depth, cell.engine);
    const level = row?.level ?? cell.depth;
    const tier = tierOf(level, cell.engine);
    const from = Math.max(since, row?.updated_at ?? 0);
    const counted = runs.filter((run) => run.domain === cell.domain && Math.round(run.depth) === cell.depth && run.engine === cell.engine
      && run.model === tier.model && (run.effort ?? tier.effort) === tier.effort && run.started_at >= from);
    const successN = counted.filter((run) => run.outcome === 'success').length;
    const failN = counted.length - successN;
    const durations = counted.filter((run) => run.finished_at).map((run) => run.finished_at! - run.started_at);
    const avgMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const n = successN + failN;
    // a downgrade needs positive evidence of quality, not just the absence of failure signals
    const upN = counted.filter((run) => run.user_feedback === 'up').length;
    const reaskN = counted.filter((run) => run.reasked).length;
    const rate = n ? successN / n : 0;

    let next = level; let reason = '';
    if (!row?.pinned && n > 0) {
      if (level < cell.depth && n >= UP_MIN_N && rate < HOLD_BELOW) { next = level + 1; reason = `하향 후 성공률 ${(rate * 100).toFixed(0)}% (${n}회) < ${HOLD_BELOW * 100}% → 복귀`; }
      else if (n >= UP_MIN_N && rate < UP_BELOW && level < 4) { next = level + 1; reason = `성공률 ${(rate * 100).toFixed(0)}% (${n}회) < ${UP_BELOW * 100}% → 상향`; }
      else if (downgrade && n >= DOWN_MIN_N && rate >= DOWN_FROM && upN / n >= DOWN_UP_SHARE && reaskN === 0 && level > Math.max(0, cell.depth - 1)) { next = level - 1; reason = `성공률 ${(rate * 100).toFixed(0)}% (${n}회) ≥ ${DOWN_FROM * 100}% → 하향`; }
    }
    if (next !== level) {
      const to = tierOf(next, cell.engine);
      store.upsertTierPolicy({ ...cell, level: next === cell.depth ? null : next, model: next === cell.depth ? null : to.model, effort: next === cell.depth ? null : to.effort, successN: 0, failN: 0, avgMs: null, updatedAt: now });
      const change = { ...cell, from: level, to: next, fromModel: label(level, cell.engine), toModel: label(next, cell.engine), successN, failN, reason };
      store.logTierChange({ ...cell, fromLevel: level, toLevel: next, fromModel: change.fromModel, toModel: change.toModel, successN, failN, reason, actor: opts.actor ?? 'auto' });
      changes.push(change);
      console.log(`[aidev] tier policy ${cell.domain} D${cell.depth} ${cell.engine}: ${change.fromModel} → ${change.toModel} (${reason})`);
    } else {
      store.upsertTierPolicy({ ...cell, level: row?.level ?? null, model: row?.model ?? null, effort: row?.effort ?? null, successN, failN, avgMs, updatedAt: row?.updated_at ?? undefined });
    }
  }
  store.kvSet('tier_policy_at', String(now));
  return { cells: cells.size, changes };
}

/** Administrator pin / reset of one cell (`level` null = back to the table; `pinned` stops the job moving it). */
export function setTierPolicy(store: Store, cell: { domain: string; depth: number; engine: string }, level: number | null, pinned: boolean, actor: string) {
  if (cell.engine !== 'claude' && cell.engine !== 'codex') throw new Error('engine must be claude|codex');
  if (!Number.isInteger(cell.depth) || cell.depth < 0 || cell.depth > 4) throw new Error('depth must be 0-4');
  if (level !== null && (!Number.isInteger(level) || level < 0 || level > 4)) throw new Error('level must be 0-4 or null');
  const row = store.tierPolicyRow(cell.domain, cell.depth, cell.engine);
  const from = row?.level ?? cell.depth;
  const to = level ?? cell.depth;
  const tier = tierOf(to, cell.engine);
  store.upsertTierPolicy({ ...cell, level: to === cell.depth ? null : to, model: to === cell.depth ? null : tier.model, effort: to === cell.depth ? null : tier.effort, successN: from === to ? row?.success_n ?? 0 : 0, failN: from === to ? row?.fail_n ?? 0 : 0, avgMs: from === to ? row?.avg_ms ?? null : null, pinned: pinned ? 1 : 0, updatedAt: from === to ? row?.updated_at ?? Date.now() : Date.now() });
  const reason = `관리자 ${level === null ? '초기화' : '지정'}${pinned ? ' (고정)' : ''}`;
  store.logTierChange({ ...cell, fromLevel: from, toLevel: to, fromModel: label(from, cell.engine), toModel: label(to, cell.engine), successN: row?.success_n ?? 0, failN: row?.fail_n ?? 0, reason, actor });
  return store.tierPolicyRow(cell.domain, cell.depth, cell.engine);
}

/** Daily schedule for tier policy + engine weights (checks every 6 hours whether a day has passed). AIDEV_TIER_POLICY=off disables it. */
export function startTierPolicySchedule(store: Store) {
  if (process.env.AIDEV_TIER_POLICY === 'off') { console.log('[aidev] tier policy schedule off'); return; }
  const tick = () => {
    const last = Number(store.kvGet('tier_policy_at') ?? 0);
    if (Date.now() - last < DAY) return;
    try {
      const result = runTierPolicy(store);
      const weights = runEngineWeights(store);   // E-06 rides on the same daily pass
      console.log(`[aidev] policy pass: tiers ${result.cells} cells / ${result.changes.length} changes, engine weights ${weights.kinds} kinds / ${weights.changes.length} changes`);
    } catch (error) { console.warn('[aidev] tier policy failed:', error instanceof Error ? error.message : error); }
  };
  setTimeout(tick, 3 * 60_000).unref();
  setInterval(tick, 6 * 3600_000).unref();
}
