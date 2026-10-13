import type { openStore } from './store.js';

/**
 * Intelligence scores of the (model, effort) combinations the provider policy splits on (PROVIDER-ENGINE-PLAN §2.1,
 * G5-02a): Artificial Analysis' free API (https://artificialanalysis.ai — attribution required wherever the scores
 * are shown), once a day. Each model_scores row an administrator mapped (aa_ref = the AA model id or slug) gets the
 * Coding, Intelligence and Agentic indexes; all rows of one sync are written together under the index version, so
 * old and new scales never mix. Administrator scores (source 'admin') are never touched. The key lives in app_kv
 * `aa.api_key` (set on the server; never returned by any route or logged).
 */
type Store = ReturnType<typeof openStore>;
const BASE = process.env.AIDEV_AA_URL ?? 'https://artificialanalysis.ai/api/v2/language/models/free';
/** Free keys get 100 requests a day; the model list is a few pages. */
const MAX_PAGES = 10;
const DAY_MS = 24 * 3600_000;

type AaModel = { id?: string; slug?: string; name?: string; evaluations?: Record<string, number | null> | null };
type AaPage = { intelligence_index_version?: number | string; pagination?: { has_more?: boolean }; data?: AaModel[] };
export type ScoreSyncResult = { ok: boolean; version: string | null; models: number; matched: number; unmatched: string[]; ambiguous: string[]; error?: string };

export async function syncModelScores(store: Store, fetchImpl: typeof fetch = fetch): Promise<ScoreSyncResult> {
  const key = store.kvGet('aa.api_key');
  if (!key) return { ok: false, version: null, models: 0, matched: 0, unmatched: [], ambiguous: [], error: 'no Artificial Analysis API key (app_kv aa.api_key)' };
  const models: AaModel[] = [];
  let version: string | null = null;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await fetchImpl(`${BASE}?page=${page}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Artificial Analysis ${response.status}`);
      const body = await response.json() as AaPage;
      version ??= body.intelligence_index_version !== undefined ? String(body.intelligence_index_version) : null;
      models.push(...(body.data ?? []));
      if (!body.pagination?.has_more) break;
    }
  } catch (error) {
    // keep the last scores: a failed sync changes nothing
    return { ok: false, version, models: models.length, matched: 0, unmatched: [], ambiguous: [], error: error instanceof Error ? error.message : String(error) };
  }
  const byId = new Map(models.filter((m) => m.id).map((m) => [m.id!, m]));
  const bySlug = new Map<string, AaModel[]>();
  for (const m of models) if (m.slug) bySlug.set(m.slug, [...(bySlug.get(m.slug) ?? []), m]);
  const rows: Parameters<Store['applySyncedScores']>[0] = [];
  const unmatched: string[] = []; const ambiguous: string[] = [];
  for (const row of store.modelScoreRows()) {
    if (!row.aa_ref || row.source !== 'aa') continue;
    const label = `${row.engine}/${row.model}${row.effort ? `/${row.effort}` : ''}=${row.aa_ref}`;
    const slugHits = bySlug.get(row.aa_ref) ?? [];
    const hit = byId.get(row.aa_ref) ?? (slugHits.length === 1 ? slugHits[0] : null);
    if (!hit) { (slugHits.length > 1 ? ambiguous : unmatched).push(label); continue; }
    const e = hit.evaluations ?? {};
    const score = (name: string) => (typeof e[name] === 'number' ? e[name] as number : null);
    rows.push({ engine: row.engine, model: row.model, effort: row.effort, coding: score('artificial_analysis_coding_index'), intelligence: score('artificial_analysis_intelligence_index'), agentic: score('artificial_analysis_agentic_index') });
  }
  store.applySyncedScores(rows, version ?? 'unknown');
  return { ok: true, version, models: models.length, matched: rows.length, unmatched, ambiguous };
}

/** Daily sync (off with AIDEV_SCORE_SYNC=off); nothing happens until an administrator stores the key. */
export function startScoreSync(store: Store) {
  if (process.env.AIDEV_SCORE_SYNC === 'off') return;
  const tick = () => {
    const last = Number(store.kvGet('aa.synced_at') ?? 0);
    if (!store.kvGet('aa.api_key') || Date.now() - last < DAY_MS - 60_000) return;
    void syncModelScores(store).then((r) => console.log(`[aidev] model scores: ${r.ok ? `v${r.version}, ${r.matched} matched${r.unmatched.length ? `, unmatched ${r.unmatched.join(' ')}` : ''}${r.ambiguous.length ? `, ambiguous ${r.ambiguous.join(' ')}` : ''}` : `failed (${r.error})`}`))
      .catch((error) => console.warn('[aidev] model scores failed:', error instanceof Error ? error.message : error));
  };
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, 3600_000).unref();
}
