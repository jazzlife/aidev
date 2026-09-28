import type { openStore } from './store.js';
import { KNOWLEDGE_TTL_MS, type Engine, type KnowledgeRow } from './store-aidev.js';
import type { LayaClient } from './laya.js';
import { decide } from './laya-questions.js';
import { TIER_TABLE, type EngineAvailability } from './routing.js';
import type { PushPayload } from './push.js';

/**
 * Knowledge refresh (IMPLEMENTATION-PLAN §3.8, E-04). Sourced knowledge expires (90 days); a due
 * item is re-checked by the owner's runtime (`POST /api/aidev-tools/knowledge-check`, a headless
 * web-enabled turn on the owner's subscription) and the answer is applied here:
 *   current      → valid for another TTL
 *   unreachable  → retried in 14 days; after 3 misses in a row it is set 'unverified' (no longer injected)
 *   changed      → Laya `knowledge.stale` judges the replacement: ≥0.7 → new item, old one superseded;
 *                  ≤0.3 → kept; otherwise (or Laya down) → a 'proposed' row waits for the owner's review
 * Global items (no owner) run on the first administrator's runtime. The scheduled pass runs every
 * AIDEV_KNOWLEDGE_REFRESH_DAYS (7) days, at most AIDEV_KNOWLEDGE_BATCH (10) items per owner;
 * AIDEV_KNOWLEDGE_REFRESH=off disables it (the manual refresh in the catalog still works).
 */
type Store = ReturnType<typeof openStore>;
export type RefreshAccount = { id: number; username: string; runtime: string };
export type RefreshOutcome = 'current' | 'unreachable' | 'unverified' | 'superseded' | 'proposed' | 'kept' | 'error' | 'skipped';
export type RefreshResult = { id: number; title: string; outcome: RefreshOutcome; note: string; newId?: number };
export type KnowledgeCheck = { status: 'current' | 'changed' | 'unreachable'; summary: string; replacement: { title: string; body: string; source_url: string | null; source_date: string | null } | null; engine?: string };

type Deps = {
  store: Store;
  laya: LayaClient;
  /** Calls the account's runtime (starting it if needed). */
  runtimeFetch: (account: RefreshAccount, path: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
  engines: (account: RefreshAccount) => Promise<EngineAvailability>;
  notify?: (userId: number, payload: PushPayload) => Promise<unknown>;
};

const DAY = 86_400_000;
const RETRY_UNREACHABLE_MS = 14 * DAY;
const CHANGED_WITHOUT_REPLACEMENT_MS = 30 * DAY;
const MAX_UNREACHABLE = 3;
const CHECK_TIMEOUT_MS = 300_000;
const REPLACE_AT = 0.7;
const KEEP_AT = 0.3;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Applies one check result to the store (exported for tests; no runtime involved). */
export async function applyCheck(store: Store, laya: LayaClient, item: KnowledgeRow, check: KnowledgeCheck, userId: number): Promise<RefreshResult> {
  const now = Date.now();
  const base = { id: item.id, title: item.title };
  if (check.status === 'current') {
    store.updateKnowledge(item.id, { expiresAt: now + KNOWLEDGE_TTL_MS, checkedAt: now, checkFails: 0, checkNote: check.summary || '출처 확인: 최신' });
    return { ...base, outcome: 'current', note: check.summary };
  }
  if (check.status === 'unreachable') {
    const fails = item.check_fails + 1;
    if (fails >= MAX_UNREACHABLE) {
      store.updateKnowledge(item.id, { status: 'unverified', checkedAt: now, checkFails: fails, checkNote: `출처를 ${fails}번 연속 확인하지 못해 주입을 멈췄습니다: ${check.summary}` });
      return { ...base, outcome: 'unverified', note: check.summary };
    }
    store.updateKnowledge(item.id, { expiresAt: now + RETRY_UNREACHABLE_MS, checkedAt: now, checkFails: fails, checkNote: `출처 확인 실패 ${fails}/${MAX_UNREACHABLE}: ${check.summary}` });
    return { ...base, outcome: 'unreachable', note: check.summary };
  }
  if (!check.replacement) {
    store.updateKnowledge(item.id, { expiresAt: now + CHANGED_WITHOUT_REPLACEMENT_MS, checkedAt: now, checkFails: 0, checkNote: `변경 가능성(대체 본문 없음): ${check.summary}` });
    return { ...base, outcome: 'kept', note: check.summary };
  }
  const rep = check.replacement;
  const state = {
    stored: { title: item.title, body: clip(item.body, 1500), source_date: item.source_date },
    fetched: { title: rep.title, body: clip(rep.body, 1500), source_url: rep.source_url, source_date: rep.source_date },
    change: check.summary,
  };
  const judged = await decide(laya, 'knowledge.stale', { state });
  store.logKindDecision({ userId, kind: judged.kind, command: `${item.title} → ${rep.title}`, answer: judged.answer, confidence: judged.confidence, probabilities: judged.probabilities, latencyMs: judged.latency_ms, device: judged.device, fallback: judged.fallback });
  const p = typeof judged.answer === 'number' ? judged.answer : null;
  if (!judged.fallback && p !== null && p >= REPLACE_AT) {
    const newId = store.addKnowledge({ agentId: item.agent_id, title: rep.title, body: rep.body, sourceUrl: rep.source_url ?? item.source_url, sourceDate: rep.source_date, status: 'sourced', ownerId: item.owner_id, checkNote: `#${item.id} 대체 (Laya ${p.toFixed(2)}): ${check.summary}` });
    store.updateKnowledge(item.id, { status: 'superseded', supersededBy: newId, checkedAt: now, checkNote: `#${newId}(으)로 대체됨: ${check.summary}` });
    return { ...base, outcome: 'superseded', note: check.summary, newId };
  }
  if (!judged.fallback && p !== null && p <= KEEP_AT) {
    store.updateKnowledge(item.id, { expiresAt: now + KNOWLEDGE_TTL_MS, checkedAt: now, checkFails: 0, checkNote: `차이가 있지만 대체할 정도는 아님 (Laya ${p.toFixed(2)}): ${check.summary}` });
    return { ...base, outcome: 'kept', note: check.summary };
  }
  const newId = store.addKnowledge({ agentId: item.agent_id, title: rep.title, body: rep.body, sourceUrl: rep.source_url ?? item.source_url, sourceDate: rep.source_date, status: 'proposed', ownerId: item.owner_id, expiresAt: null, replaces: item.id, checkNote: check.summary });
  store.updateKnowledge(item.id, { checkedAt: now, checkNote: `갱신 제안 #${newId} 검토 대기${p !== null && !judged.fallback ? ` (Laya ${p.toFixed(2)})` : ' (Laya 판정 불가)'}` });
  return { ...base, outcome: 'proposed', note: check.summary, newId };
}

/** A person's answer to a 'proposed' replacement. */
export function decideProposal(store: Store, proposalId: number, accept: boolean) {
  const proposal = store.knowledgeById(proposalId);
  if (!proposal || proposal.status !== 'proposed') throw new Error('Proposal not found');
  const now = Date.now();
  const old = proposal.replaces ? store.knowledgeById(proposal.replaces) : undefined;
  if (accept) {
    store.updateKnowledge(proposal.id, { status: 'sourced', expiresAt: now + KNOWLEDGE_TTL_MS, checkedAt: now, checkNote: `검토 승인${old ? `: #${old.id} 대체` : ''}` });
    if (old && old.status !== 'superseded') store.updateKnowledge(old.id, { status: 'superseded', supersededBy: proposal.id, checkNote: `#${proposal.id}(으)로 대체됨 (검토 승인)` });
    return { accepted: proposal.id, superseded: old?.id ?? null };
  }
  store.deleteKnowledge(proposal.id);
  if (old) store.updateKnowledge(old.id, { expiresAt: now + KNOWLEDGE_TTL_MS, checkedAt: now, checkFails: 0, checkNote: '갱신 제안 거절: 기존 내용 유지' });
  return { accepted: null, superseded: null };
}

export function createKnowledgeRefresher(deps: Deps) {
  const { store, laya } = deps;
  const jobs = new Map<number, { running: boolean; total: number; done: number; results: RefreshResult[]; startedAt: number; finishedAt: number | null; error: string | null }>();
  let scheduled: Promise<void> | null = null;

  async function pickEngine(account: RefreshAccount): Promise<{ engine: Engine; model: string } | null> {
    const engines = await deps.engines(account);
    if (engines.claude.allowed && engines.claude.authenticated) return { engine: 'claude', model: 'sonnet' };
    if (engines.codex.allowed && engines.codex.authenticated) return { engine: 'codex', model: TIER_TABLE[1].codex.model };
    return null;
  }

  async function checkOne(account: RefreshAccount, item: KnowledgeRow, engine: { engine: Engine; model: string }): Promise<RefreshResult> {
    try {
      const agent = store.agentById(item.agent_id);
      const refresher = store.agent(account.id, 'knowledge-refresher');
      const response = await deps.runtimeFetch(account, '/api/aidev-tools/knowledge-check', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: item.title, body: item.body, source_url: item.source_url, source_date: item.source_date, agent: agent?.name ?? null, engine: engine.engine, model: engine.model, prompt: refresher?.prompt ?? null }),
      }, CHECK_TIMEOUT_MS);
      const payload = await response.json() as { data?: KnowledgeCheck; error?: string };
      if (!response.ok || !payload.data) throw new Error(payload.error ?? `runtime ${response.status}`);
      const result = await applyCheck(store, laya, item, payload.data, account.id);
      console.log(`[aidev] knowledge #${item.id} "${clip(item.title, 50)}" → ${result.outcome}${result.newId ? ` #${result.newId}` : ''} (${engine.engine})`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[aidev] knowledge #${item.id} check failed: ${message}`);
      return { id: item.id, title: item.title, outcome: 'error', note: message };
    }
  }

  function summary(results: RefreshResult[]) {
    const count = (o: RefreshOutcome) => results.filter((r) => r.outcome === o).length;
    const parts = [
      count('current') ? `최신 ${count('current')}` : null,
      count('superseded') ? `갱신 ${count('superseded')}` : null,
      count('proposed') ? `검토 필요 ${count('proposed')}` : null,
      count('unreachable') + count('unverified') ? `출처 확인 실패 ${count('unreachable') + count('unverified')}` : null,
      count('error') ? `오류 ${count('error')}` : null,
    ].filter(Boolean);
    return parts.join(' · ') || '변경 없음';
  }

  /** Checks `items` on `account`'s runtime, one at a time; progress is visible through status(). */
  async function run(account: RefreshAccount, items: KnowledgeRow[], jobUser: number) {
    const job = { running: true, total: items.length, done: 0, results: [] as RefreshResult[], startedAt: Date.now(), finishedAt: null as number | null, error: null as string | null };
    jobs.set(jobUser, job);
    try {
      const engine = items.length ? await pickEngine(account) : null;
      if (items.length && !engine) { job.error = '확인에 쓸 엔진이 로그인되어 있지 않습니다'; return job; }
      for (const item of items) {
        job.results.push(await checkOne(account, item, engine!));
        job.done += 1;
      }
      return job;
    } finally {
      job.running = false; job.finishedAt = Date.now();
    }
  }

  /** Scheduled pass over every owner with due items. */
  async function runScheduled(batch = Number(process.env.AIDEV_KNOWLEDGE_BATCH ?? 10)) {
    const perAccount = new Map<number, RefreshResult[]>();
    for (const owner of store.dueKnowledgeOwners()) {
      const account = owner === null ? store.firstAdmin() : store.accountById(owner);
      if (!account || ('active' in account && !account.active)) continue;
      const items = store.dueKnowledge(batch, owner);
      if (!items.length) continue;
      const job = await run(account, items, account.id);
      if (job.error) console.warn(`[aidev] knowledge refresh for ${account.username} skipped: ${job.error}`);
      perAccount.set(account.id, [...(perAccount.get(account.id) ?? []), ...job.results]);
    }
    for (const [userId, results] of perAccount) {
      if (!results.length) continue;
      console.log(`[aidev] knowledge refresh user ${userId}: ${summary(results)}`);
      if (deps.notify && results.some((r) => r.outcome === 'proposed' || r.outcome === 'superseded' || r.outcome === 'unverified')) {
        await deps.notify(userId, { title: '지식 갱신', body: `저장된 지식 ${results.length}건을 확인했습니다: ${summary(results)}`, url: '/m/settings?review=knowledge', tag: 'aidev-knowledge' }).catch(() => undefined);
      }
    }
    store.kvSet('knowledge_refresh_at', String(Date.now()));
  }

  return {
    /** Manual refresh from the catalog: one item (any state but superseded/proposed) or the caller's due items. */
    start(account: RefreshAccount, opts: { itemId?: number; includeGlobal: boolean }) {
      const current = jobs.get(account.id);
      if (current?.running) return current;
      let items: KnowledgeRow[];
      if (opts.itemId !== undefined) {
        const item = store.knowledgeById(opts.itemId);
        if (!item || !item.source_url || ['superseded', 'proposed'].includes(item.status)) throw new Error('확인할 수 있는 지식이 아닙니다 (출처 URL 필요)');
        if (item.owner_id === null ? !opts.includeGlobal : item.owner_id !== account.id) throw new Error('Knowledge not found');
        items = [item];
      } else {
        items = [...store.dueKnowledge(20, account.id), ...(opts.includeGlobal ? store.dueKnowledge(20, null) : [])];
      }
      void run(account, items, account.id);
      return jobs.get(account.id)!;
    },
    status(userId: number) { return jobs.get(userId) ?? null; },
    runScheduled,
    /** Starts the periodic pass (checks every 6 hours whether a period has elapsed). */
    startSchedule() {
      if (process.env.AIDEV_KNOWLEDGE_REFRESH === 'off') { console.log('[aidev] knowledge refresh schedule off'); return; }
      const periodMs = Number(process.env.AIDEV_KNOWLEDGE_REFRESH_DAYS ?? 7) * DAY;
      const tick = () => {
        if (scheduled) return;
        const last = Number(store.kvGet('knowledge_refresh_at') ?? 0);
        if (Date.now() - last < periodMs) return;
        scheduled = runScheduled().catch((error) => console.warn('[aidev] knowledge refresh failed:', error instanceof Error ? error.message : error)).finally(() => { scheduled = null; });
      };
      setTimeout(tick, 5 * 60_000).unref();
      setInterval(tick, 6 * 3600_000).unref();
    },
  };
}
export type KnowledgeRefresher = ReturnType<typeof createKnowledgeRefresher>;
