import type { openStore } from './store.js';
import type { Engine } from './store-aidev.js';

/**
 * Engine weight learning (IMPLEMENTATION-PLAN §3.4, E-06). w(task_kind, engine) is the base of the
 * router's engine score. Once a day (with the tier policy pass) each weight becomes the engine's
 * success rate on that task kind over the last 30 days, smoothed toward its prior (the seed or an
 * administrator's value) with PRIOR_N pseudo-runs, so a handful of runs cannot swing it; when both
 * engines succeed about equally (within 5 points) the faster one gets up to +0.05. Pinned weights are
 * left alone (statistics still refresh). Changes of 0.02 or more are logged to engine_weight_log.
 */
type Store = ReturnType<typeof openStore>;
export type WeightChange = { taskKind: string; engine: Engine; from: number; to: number; successN: number; failN: number; reason: string };

const DAY = 86_400_000;
const PRIOR_N = 10;
const SPEED_BONUS = 0.05;
const LOG_DELTA = 0.02;
const clamp = (v: number) => Math.max(0.05, Math.min(0.95, v));

export function runEngineWeights(store: Store, opts: { windowDays?: number; actor?: string; now?: number } = {}): { kinds: number; changes: WeightChange[] } {
  const now = opts.now ?? Date.now();
  const runs = store.engineRuns(now - (opts.windowDays ?? Number(process.env.AIDEV_TIER_WINDOW_DAYS ?? 30)) * DAY);
  const rows = new Map(store.engineWeightRows().map((row) => [`${row.task_kind}|${row.engine}`, row]));
  const kinds = new Set([...runs.map((run) => run.task_kind), ...[...rows.values()].map((row) => row.task_kind)]);
  const changes: WeightChange[] = [];
  for (const kind of kinds) {
    const stats = (['claude', 'codex'] as Engine[]).map((engine) => {
      const list = runs.filter((run) => run.task_kind === kind && run.engine === engine);
      const successN = list.filter((run) => run.outcome === 'success').length;
      const durations = list.filter((run) => run.finished_at).map((run) => run.finished_at! - run.started_at);
      const row = rows.get(`${kind}|${engine}`);
      const prior = row?.prior ?? row?.weight ?? 0.5;
      return { engine, row, prior, successN, failN: list.length - successN, n: list.length, avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null };
    });
    const learned = stats.map((s) => ({ ...s, weight: (s.successN + PRIOR_N * s.prior) / (s.n + PRIOR_N) }));
    // speed tie-break: similar success, clearly faster (≥20%) engine gets a small bonus
    const [a, b] = learned;
    if (a.n >= 5 && b.n >= 5 && a.avgMs && b.avgMs && Math.abs(a.successN / a.n - b.successN / b.n) <= 0.05) {
      const faster = a.avgMs < b.avgMs * 0.8 ? a : b.avgMs < a.avgMs * 0.8 ? b : null;
      if (faster) faster.weight += SPEED_BONUS;
    }
    for (const s of learned) {
      if (!s.n && !s.row) continue;
      const current = s.row?.weight ?? 0.5;
      const next = Math.round(clamp(s.weight) * 1000) / 1000;
      if (s.row?.pinned) { store.updateLearnedWeight(kind, s.engine, { weight: current, successN: s.successN, failN: s.failN, avgMs: s.avgMs }); continue; }
      store.updateLearnedWeight(kind, s.engine, { weight: s.n ? next : current, successN: s.successN, failN: s.failN, avgMs: s.avgMs });
      if (s.n && Math.abs(next - current) >= LOG_DELTA) {
        const reason = `성공 ${s.successN}/${s.n}${s.avgMs ? `, 평균 ${Math.round(s.avgMs / 1000)}s` : ''} (사전값 ${s.prior.toFixed(2)} 기준 보정)`;
        store.logEngineWeight({ taskKind: kind, engine: s.engine, from: current, to: next, successN: s.successN, failN: s.failN, reason, actor: opts.actor ?? 'auto' });
        changes.push({ taskKind: kind, engine: s.engine, from: current, to: next, successN: s.successN, failN: s.failN, reason });
        console.log(`[aidev] engine weight ${kind}/${s.engine}: ${current.toFixed(2)} → ${next.toFixed(2)} (${reason})`);
      }
    }
  }
  return { kinds: kinds.size, changes };
}
