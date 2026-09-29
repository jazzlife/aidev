import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { openStore } from './store.js';
import { EFFORT_LADDER, ENGINES, type Engine } from './store-aidev.js';
import type { LayaClient } from './laya.js';
import type { Push } from './push.js';
import { RpcError, type RunnerHub } from './runner-hub.js';
import type { RemoteGate } from './remote-gate.js';
import { applyLessonOutcome, promote } from './lesson-loop.js';
import { downgradeEnabled, runTierPolicy, setTierPolicy } from './tier-policy.js';
import { runEngineWeights } from './engine-weights.js';
import { createKnowledgeRefresher, decideProposal } from './knowledge-refresh.js';
import { decideNext, type NextAction } from './escalation.js';
import { decide, listKinds } from './laya-questions.js';
import fs from 'node:fs';
import { evaluateRouting, route, TIER_TABLE, type EngineAvailability, type RouteInput } from './routing.js';

/**
 * /api/aidev/* — routing, decisions, agent catalog, runs, lessons, knowledge, engines, targets
 * (IMPLEMENTATION-PLAN §3.3). Everything requires a gateway session; admin-only routes check `role`.
 */
type Store = ReturnType<typeof openStore>;
type Session = { user: { id: number; username: string; runtime: string }; sid: string };
export type AidevDeps = {
  store: Store; laya: LayaClient;
  /** Authenticated fetch against the caller's CloudCLI runtime (path starts with /api/...). */
  runtimeFetch: (session: Session, path: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
  json: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
  /** Web push (mobile PWA): subscriptions and the Claude login reminders. */
  push: Push;
  /** Remote PC runners (stage F): live connections and JSON-RPC calls. */
  runners?: RunnerHub;
  /** Agent remote execution gate: risk, policy, approvals (F-05). */
  gate?: RemoteGate;
};

/**
 * `~/x` and `$HOME/x` as agents write them: older runners (≤0.2.1) take them literally, so map them onto
 * the allowed root that has the same first folder (…/aidev-work for ~/aidev-work/app), else the home
 * folder above the first root. Anything else is passed through for the runner to check.
 */
export function normalizeCwd(cwd: string | null, roots: string[]): string | null {
  if (!cwd) return cwd;
  const m = cwd.trim().match(/^(~|\$HOME)(\/.*)?$/);
  if (!m || !roots.length) return cwd.trim();
  const rest = (m[2] ?? '').replace(/^\/+/, '');
  if (!rest) return roots[0];
  const [first, ...more] = rest.split('/');
  const root = roots.find((r) => r.replace(/\/+$/, '').split('/').pop() === first);
  if (root) return [root.replace(/\/+$/, ''), ...more].filter(Boolean).join('/');
  const home = roots[0].replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  return home ? `${home}/${rest}` : cwd.trim();
}
/** Terminal output → plain text: no ANSI colour/cursor codes; a \r-redrawn line keeps its last state. */
export const plainText = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][A-Z0-9]/g, '')
  .split('\n').map((line) => { const parts = line.replace(/\r$/, '').split('\r'); return parts[parts.length - 1]; }).join('\n');
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const num = (v: unknown, name: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`); return n; };
const str = (v: unknown, name: string, max = 20000) => { if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} required`); if (v.length > max) throw new HttpError(400, `${name} too long`); return v; };
const optStr = (v: unknown, max = 20000) => (typeof v === 'string' && v.length <= max ? v : undefined);

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > limit) throw new HttpError(413, 'Body too large'); chunks.push(Buffer.from(chunk)); }
  if (!chunks.length) return {};
  try { const v = JSON.parse(Buffer.concat(chunks).toString()); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function createAidevApi(deps: AidevDeps) {
  const { store, laya, json } = deps;
  const ENGINE_CACHE_MS = 60_000;
  const CURATE_TIMEOUT_MS = 180_000;

  async function engineAvailability(session: Session, force = false): Promise<EngineAvailability> {
    const acct = store.accountEngines(session.user.id);
    const cached = Object.fromEntries(store.engineStatus(session.user.id).map((r) => [r.engine, r]));
    const out = { claude: { allowed: false, authenticated: false, error: null }, codex: { allowed: false, authenticated: false, error: null } } as EngineAvailability;
    await Promise.all(ENGINES.map(async (engine) => {
      out[engine].allowed = acct.engines.includes(engine);
      if (!out[engine].allowed) return;
      const c = cached[engine];
      if (c && !force && Date.now() - c.checked_at < ENGINE_CACHE_MS) { out[engine].authenticated = Boolean(c.authenticated); out[engine].error = c.last_error; return; }
      try {
        const r = await deps.runtimeFetch(session, `/api/providers/${engine}/auth/status`);
        const body = await r.json() as { data?: { authenticated?: boolean; installed?: boolean; error?: string } };
        const authenticated = Boolean(body.data?.authenticated);
        const error = authenticated ? null : (body.data?.error ?? (body.data?.installed === false ? 'not installed' : 'not signed in'));
        store.setEngineStatus(session.user.id, engine, authenticated, error);
        out[engine].authenticated = authenticated; out[engine].error = error;
      } catch (error) {
        // keep the last known value; surface the probe failure
        out[engine].authenticated = Boolean(c?.authenticated); out[engine].error = c?.last_error ?? (error instanceof Error ? error.message : 'status check failed');
      }
    }));
    return out;
  }

  // E-04: weekly knowledge re-check on the owner's runtime (and on demand from the catalog).
  const asSession = (account: { id: number; username: string; runtime: string }): Session => ({ user: { id: account.id, username: account.username, runtime: account.runtime }, sid: 'knowledge-refresh' });
  const knowledgeRefresher = createKnowledgeRefresher({
    store, laya,
    runtimeFetch: (account, path, init, timeoutMs) => deps.runtimeFetch(asSession(account), path, init, timeoutMs),
    engines: (account) => engineAvailability(asSession(account)),
    notify: (userId, payload) => deps.push.sendToUser(userId, payload),
  });

  /** Asks the user's runtime to curate a failed run, judges the candidate with Laya, stores it as a candidate lesson. */
  async function curateFailure(session: Session, run: { id: number; session_id: string | null; agent_id: number | null; engine: string | null; decision_id: number | null; exit_code: number | null; tool_errors: number; user_feedback: string | null; reverted: number; test_result: string | null }) {
    const agent = run.agent_id ? store.agentById(run.agent_id) : undefined;
    if (!agent || agent.domain === 'meta' || !run.session_id) return;
    const decisionRow = run.decision_id ? store.db.prepare('SELECT command FROM decision_log WHERE id=?').get(run.decision_id) as { command: string } | undefined : undefined;
    const signals = { exit_code: run.exit_code, tool_errors: run.tool_errors, user_feedback: run.user_feedback, reverted: run.reverted, test_result: run.test_result };
    const response = await deps.runtimeFetch(session, '/api/aidev-tools/curate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: run.session_id, run_id: run.id, agent: agent.name, engine: run.engine, command: decisionRow?.command ?? null, signals }) }, CURATE_TIMEOUT_MS);   // a headless model turn: well beyond the 10 s status-probe budget
    const body = await response.json() as { data?: { candidate?: { trigger: string; rule: string; engine: string | null; generalizable: boolean } | null } };
    const candidate = body.data?.candidate;
    if (!candidate) return;
    const judged = await decide(laya, 'lesson.accept', { state: { command: decisionRow?.command ?? '', trigger: candidate.trigger, rule: candidate.rule } });
    store.logKindDecision({ userId: session.user.id, kind: judged.kind, command: `${candidate.trigger} → ${candidate.rule}`, answer: judged.answer, confidence: judged.confidence, probabilities: judged.probabilities, latencyMs: judged.latency_ms, device: judged.device, fallback: judged.fallback });
    const accepted = typeof judged.answer === 'number' ? judged.answer >= 0.6 : false;
    // Rejected-by-Laya candidates are still kept (status rejected) so the catalog can show what was learned and why.
    const id = store.addLesson({ agentId: agent.id, engine: candidate.engine, trigger: candidate.trigger, rule: candidate.rule, evidenceRunId: run.id, ownerId: session.user.id, status: accepted ? 'candidate' : 'rejected' });
    console.log(`[aidev] lesson ${id} for ${agent.name} (${accepted ? 'candidate' : 'rejected'} p=${typeof judged.answer === 'number' ? judged.answer.toFixed(2) : '-'}): ${candidate.trigger} → ${candidate.rule}`);
  }

  function requireAdmin(session: Session) { if (store.accountEngines(session.user.id).role !== 'admin') throw new HttpError(403, 'Administrator only'); }
  function ownAgent(session: Session, id: number, write = false) {
    const a = store.agentById(id);
    if (!a || (a.owner_id !== null && a.owner_id !== session.user.id)) throw new HttpError(404, 'Agent not found');
    if (write && a.owner_id === null && store.accountEngines(session.user.id).role !== 'admin') throw new HttpError(403, 'Global agents are edited by administrators; create a private copy instead');
    return a;
  }
  const agentView = (a: ReturnType<Store['agentById']> & object) => ({ id: a.id, name: a.name, domain: a.domain, description: a.description, hint: a.hint, verified: Boolean(a.verified), prompt: a.prompt, tools: a.tools ? JSON.parse(a.tools) : null, model: a.model, maxTurns: a.max_turns, skills: a.skills ? JSON.parse(a.skills) : null, mcpServers: a.mcp_servers ? JSON.parse(a.mcp_servers) : null, ownerId: a.owner_id, source: a.source, active: Boolean(a.active), uses: a.uses, version: a.version, minTier: a.min_tier ?? null, createdAt: a.created_at, updatedAt: a.updated_at });

  /** Returns true when the request was handled. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, session: Session | null): Promise<boolean> {
    const p = url.pathname;
    if (p !== '/api/aidev' && !p.startsWith('/api/aidev/')) return false;
    const rest = p.slice('/api/aidev'.length) || '/';
    const m = req.method ?? 'GET';
    try {
      if (rest === '/laya/health' && m === 'GET') {
        const health = await laya.health().catch((error) => ({ status: 'unreachable', error: error instanceof Error ? error.message : String(error) }));
        return json(res, health.status === 'ok' ? 200 : 503, { ...health, client: laya.status }), true;
      }
      if (!session) return json(res, 401, { error: 'Authentication required' }, { 'x-auth-error': 'invalid-token' }), true;
      const uid = session.user.id;

      // ---- routing --------------------------------------------------------------------------
      if (rest === '/kinds' && m === 'GET') return json(res, 200, { kinds: listKinds() }), true;
      if (rest === '/route' && m === 'POST') {
        const b = await readJson(req);
        const input: RouteInput = { text: str(b.text, 'text', 32000), sessionId: optStr(b.sessionId, 200), sessionEngine: ENGINES.includes(b.sessionEngine as Engine) ? b.sessionEngine as Engine : null,
          preferEngine: ENGINES.includes(b.preferEngine as Engine) ? b.preferEngine as Engine : null, targetId: b.targetId === undefined || b.targetId === null ? null : num(b.targetId, 'targetId'),
          forceAgent: optStr(b.forceAgent, 41) ?? null, projectHint: optStr(b.projectHint, 400), recentFiles: Array.isArray(b.recentFiles) ? (b.recentFiles as unknown[]).map(String).slice(0, 10) : null, model: optStr(b.model, 100), effort: optStr(b.effort, 20),
          effortCap: b.effortCap && typeof b.effortCap === 'object' ? { claude: optStr((b.effortCap as Record<string, unknown>).claude, 20), codex: optStr((b.effortCap as Record<string, unknown>).codex, 20) } as Partial<Record<Engine, string>> : null };
        const engines = await engineAvailability(session);
        return json(res, 200, await route(store, laya, uid, engines, input)), true;
      }
      // a chat's own effort ceiling (the account default lives in /settings/effort-cap)
      const sessMatch = rest.match(/^\/session-settings\/([A-Za-z0-9._:-]{1,200})$/);
      if (sessMatch) {
        const sid = sessMatch[1];
        if (m === 'GET') { const info = store.effectiveEffortCap(uid, sid); return json(res, 200, { effort_cap: info.chat, default: info.account, effective: info.cap }), true; }
        if (m === 'PUT' || m === 'DELETE') {
          const b = m === 'PUT' ? await readJson(req) : {};
          try {
            const cap = m === 'DELETE' ? null : { claude: b.claude === null ? undefined : optStr(b.claude, 20), codex: b.codex === null ? undefined : optStr(b.codex, 20) };
            const saved = store.setSessionEffortCap(uid, sid, cap);
            const info = store.effectiveEffortCap(uid, sid);
            return json(res, 200, { effort_cap: saved, default: info.account, effective: info.cap }), true;
          } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid effort'); }
        }
      }
      if (rest === '/route/eval' && m === 'POST') {
        const b = await readJson(req, 4 * 1024 * 1024);
        let rows = Array.isArray(b.rows) ? (b.rows as Array<{ text: string; agent: string; lang?: string; task_kind?: string | null }>) : [];
        if (!rows.length) {
          const file = process.env.AIDEV_BENCH_FILE ?? '/srv/app/current/control/laya/bench/commands.jsonl';
          rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { text: string; agent: string; lang?: string; task_kind?: string | null });
        }
        return json(res, 200, await evaluateRouting(store, laya, uid, rows.slice(0, 2000))), true;
      }
      const decideMatch = rest.match(/^\/decide\/([a-z][a-z0-9_.]*)$/);
      if (decideMatch && m === 'POST') {
        const b = await readJson(req);
        const state = b.state && typeof b.state === 'object' ? b.state as Record<string, unknown> : {};
        const options = b.options && typeof b.options === 'object' ? Object.fromEntries(Object.entries(b.options as Record<string, unknown>).map(([k, v]) => [k, String(v).slice(0, 600)])) : undefined;
        const result = await decide(laya, decideMatch[1], { state, options, threshold: typeof b.threshold === 'number' ? b.threshold : undefined });
        const id = store.logKindDecision({ userId: uid, kind: result.kind, command: String(state.command ?? state.question ?? state.summary ?? ''), answer: result.answer, confidence: result.confidence, probabilities: result.probabilities, latencyMs: result.latency_ms, device: result.device, fallback: result.fallback, state: { ...state, options } });
        return json(res, 200, { decision_id: id, ...result, raw: undefined }), true;
      }
      if (rest === '/decide' && m === 'POST') { // raw predict, for benchmarks
        requireAdmin(session);
        const b = await readJson(req);
        return json(res, 200, await laya.predict((b.state ?? {}) as Record<string, unknown>, (b.questions ?? {}) as never)), true;
      }
      const decMatch = rest.match(/^\/decisions\/(\d+)$/);
      if (decMatch && m === 'PATCH') {
        const b = await readJson(req);
        const decisionId = Number(decMatch[1]);
        store.overrideDecision(uid, decisionId, { finalAgent: optStr(b.final_agent, 60) ?? null, finalEngine: optStr(b.final_engine, 20) ?? null, finalModel: optStr(b.final_model, 100) ?? null, finalTarget: optStr(b.final_target, 60) ?? null, finalAnswer: b.final_answer });
        // A user correction is the best routing example there is: feed it to the lexical prior.
        const finalAgent = optStr(b.final_agent, 60);
        if (finalAgent) {
          const decisionRow = store.db.prepare('SELECT command FROM decision_log WHERE id=? AND user_id=?').get(decisionId, uid) as { command: string } | undefined;
          const agent = store.agent(uid, finalAgent);
          if (decisionRow && agent) store.addExamples(agent.id, [{ text: decisionRow.command, source: 'override' }]);
        }
        return json(res, 200, { ok: true }), true;
      }
      if (rest === '/decisions' && m === 'GET') return json(res, 200, { decisions: store.decisions(uid, Number(url.searchParams.get('limit') ?? 100)) }), true;

      // ---- engines --------------------------------------------------------------------------
      // ---- web push (mobile PWA) -------------------------------------------------------------
      if (rest === '/push/key' && m === 'GET') return json(res, 200, { publicKey: deps.push.publicKey }), true;
      if (rest === '/push/subscribe' && m === 'POST') {
        const b = await readJson(req);
        const sub = (b.subscription && typeof b.subscription === 'object' ? b.subscription : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
        const endpoint = str(sub.endpoint, 'subscription.endpoint', 2000);
        if (!/^https:\/\//.test(endpoint)) throw new HttpError(400, 'subscription.endpoint must be https');
        const keys = { p256dh: str(sub.keys?.p256dh, 'subscription.keys.p256dh', 200), auth: str(sub.keys?.auth, 'subscription.keys.auth', 100) };
        store.addPushSubscription(uid, endpoint, keys, optStr(req.headers['user-agent'], 400) ?? null);
        return json(res, 201, { ok: true }), true;
      }
      if (rest === '/push/unsubscribe' && m === 'POST') {
        const b = await readJson(req);
        return json(res, 200, { removed: store.removePushSubscription(uid, str(b.endpoint, 'endpoint', 2000)) }), true;
      }
      if (rest === '/push/test' && m === 'POST') {
        return json(res, 200, await deps.push.sendToUser(uid, { title: 'Nado AI Dev 알림 테스트', body: '이 기기로 알림이 도착합니다.', url: '/m/settings', tag: 'test' })), true;
      }
      // Reported by the user's runtime (runtime JWT via /internal/aidev) after an in-app Claude
      // login (expires_at) or when a turn was refused for authentication (failure_at).
      if (rest === '/claude-auth' && m === 'POST') {
        const b = await readJson(req);
        const report: { expiresAt?: number | null; failureAt?: number | null } = {};
        if (b.expires_at !== undefined) report.expiresAt = b.expires_at === null ? null : num(b.expires_at, 'expires_at');
        if (b.failure_at !== undefined) report.failureAt = b.failure_at === null ? null : num(b.failure_at, 'failure_at');
        store.setClaudeAuth(uid, report);
        // a refused turn is worth telling at once; expiry reminders follow their own schedule
        if (report.failureAt) void deps.push.claudeReminders().catch(() => undefined);
        return json(res, 200, { ok: true }), true;
      }
      if (rest === '/engines' && m === 'GET') {
        const acct = store.accountEngines(uid);
        // ?refresh=1 right after an in-app login, so the next route sees the engine at once
        return json(res, 200, { engines: await engineAvailability(session, url.searchParams.get('refresh') === '1'), default_engine: acct.defaultEngine, role: acct.role, weights: store.engineWeights(), effort_cap: store.effortCap(uid), effort_ladder: EFFORT_LADDER }), true;
      }
      // the user's effort ceiling per engine (own subscription usage, so every user sets their own)
      if (rest === '/settings/effort-cap' && m === 'PUT') {
        const b = await readJson(req);
        try { return json(res, 200, { effort_cap: store.setEffortCap(uid, { claude: optStr(b.claude, 20), codex: optStr(b.codex, 20) }) }), true; }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid effort'); }
      }
      if (rest === '/engines/weights' && m === 'PUT') {
        requireAdmin(session);
        const b = await readJson(req);
        try { store.setEngineWeight(str(b.task_kind, 'task_kind', 40), str(b.engine, 'engine', 20) as Engine, num(b.weight, 'weight'), { pinned: b.pinned === true, actor: session.user.username }); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid'); }
        return json(res, 200, { weights: store.engineWeights(), rows: store.engineWeightRows() }), true;
      }
      // E-06: learned weights with the statistics behind them and their change log (admin)
      if (rest === '/engines/weights' && m === 'GET') { requireAdmin(session); return json(res, 200, { rows: store.engineWeightRows(), log: store.engineWeightLog(50) }), true; }

      // ---- agents ---------------------------------------------------------------------------
      if (rest === '/agents' && m === 'GET') {
        const includeInactive = url.searchParams.get('all') === '1';
        return json(res, 200, { agents: store.agents(uid, includeInactive).map(agentView) }), true;
      }
      if (rest === '/agents' && m === 'POST') {
        const b = await readJson(req);
        const id = store.addAgent({ name: str(b.name, 'name', 41), domain: optStr(b.domain, 40) ?? '', description: str(b.description, 'description', 600), hint: optStr(b.hint, 60) ?? null, prompt: str(b.prompt, 'prompt'), tools: Array.isArray(b.tools) ? (b.tools as unknown[]).map(String) : null,
          model: optStr(b.model, 100) ?? null, maxTurns: b.maxTurns === undefined ? null : num(b.maxTurns, 'maxTurns'), skills: Array.isArray(b.skills) ? (b.skills as unknown[]).map(String) : null, mcpServers: b.mcpServers && typeof b.mcpServers === 'object' ? b.mcpServers as Record<string, unknown> : null,
          ownerId: b.global === true ? (requireAdmin(session), null) : uid, source: optStr(b.source, 20) ?? 'user' });
        if (b.min_tier !== undefined && b.min_tier !== null) store.setAgentMinTier(id, num(b.min_tier, 'min_tier'));
        if (Array.isArray(b.examples)) store.addExamples(id, (b.examples as unknown[]).filter((e): e is string => typeof e === 'string').slice(0, 200).map((text) => ({ text, source: 'generated' })));
        if (Array.isArray(b.knowledge)) for (const k of b.knowledge as Array<Record<string, unknown>>) {
          if (typeof k?.title === 'string' && typeof k?.body === 'string') store.addKnowledge({ agentId: id, title: k.title, body: k.body, sourceUrl: optStr(k.source_url, 2000) ?? null, sourceDate: optStr(k.source_date, 40) ?? null, ownerId: uid });
        }
        return json(res, 201, { agent: agentView(store.agentById(id)!) }), true;
      }
      const exMatch = rest.match(/^\/agents\/(\d+)\/examples(?:\/(\d+))?$/);
      if (exMatch) {
        const id = Number(exMatch[1]); ownAgent(session, id);
        if (m === 'GET') return json(res, 200, { examples: store.examples(id) }), true;
        if (m === 'POST') { ownAgent(session, id, true); const b = await readJson(req); const items = Array.isArray(b.examples) ? (b.examples as unknown[]).filter((e): e is string => typeof e === 'string') : [str(b.text, 'text', 1000)]; return json(res, 201, { added: store.addExamples(id, items.map((text) => ({ text, source: 'user' }))) }), true; }
        if (m === 'DELETE' && exMatch[2]) { ownAgent(session, id, true); return json(res, 200, { removed: store.removeExample(Number(exMatch[2])) }), true; }
      }
      const agentMatch = rest.match(/^\/agents\/(\d+)(\/promote|\/versions)?$/);
      if (agentMatch) {
        const id = Number(agentMatch[1]);
        if (agentMatch[2] === '/promote' && m === 'POST') { requireAdmin(session); ownAgent(session, id); store.promoteAgent(id); return json(res, 200, { agent: agentView(store.agentById(id)!) }), true; }
        if (agentMatch[2] === '/versions' && m === 'GET') { ownAgent(session, id); return json(res, 200, { versions: store.agentVersions(id) }), true; }
        if (!agentMatch[2] && m === 'GET') {
          const a = ownAgent(session, id);
          return json(res, 200, { agent: agentView(a), knowledge: store.knowledge(id, ['verified', 'sourced', 'unverified', 'proposed'], uid), lessons: store.lessons(id, uid, ['verified', 'candidate']), stats: store.agentStats(id), versions: store.agentVersions(id).map((v) => ({ version: v.version, changelog: v.changelog, createdAt: v.created_at })) }), true;
        }
        if (!agentMatch[2] && m === 'PUT') {
          ownAgent(session, id, true);
          const b = await readJson(req);
          // only definition changes make a new version; flags (active, hint, verified, min_tier) do not
          const versioned = ['prompt', 'description', 'domain', 'tools', 'model', 'skills', 'mcpServers', 'maxTurns'].some((key) => b[key] !== undefined);
          const version = !versioned ? store.agentById(id)!.version : store.newAgentVersion(id, { prompt: optStr(b.prompt), description: optStr(b.description, 600), domain: optStr(b.domain, 40), tools: b.tools === undefined ? undefined : (Array.isArray(b.tools) ? (b.tools as unknown[]).map(String) : null), model: b.model === undefined ? undefined : (optStr(b.model, 100) ?? null),
            skills: b.skills === undefined ? undefined : (Array.isArray(b.skills) ? (b.skills as unknown[]).map(String) : null), mcpServers: b.mcpServers === undefined ? undefined : (b.mcpServers && typeof b.mcpServers === 'object' ? b.mcpServers as Record<string, unknown> : null), maxTurns: b.maxTurns === undefined ? undefined : (b.maxTurns === null ? null : num(b.maxTurns, 'maxTurns')) }, optStr(b.changelog, 2000) ?? 'edited');
          if (typeof b.active === 'boolean' || b.hint !== undefined) store.updateAgent(id, { ...(typeof b.active === 'boolean' ? { active: b.active ? 1 : 0 } : {}), ...(b.hint !== undefined ? { hint: optStr(b.hint, 60) ?? null } : {}) });
          if (typeof b.verified === 'boolean') store.setAgentVerified(id, b.verified);
          if (b.min_tier !== undefined) { try { store.setAgentMinTier(id, b.min_tier === null ? null : num(b.min_tier, 'min_tier')); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid min_tier'); } }
          return json(res, 200, { agent: agentView(store.agentById(id)!), version }), true;
        }
        if (!agentMatch[2] && m === 'DELETE') { ownAgent(session, id, true); store.updateAgent(id, { active: 0 }); return json(res, 200, { ok: true }), true; }
      }

      // ---- runs -----------------------------------------------------------------------------
      if (rest === '/runs' && m === 'POST') {
        const b = await readJson(req);
        const id = store.addRun({ userId: uid, sessionId: optStr(b.session_id, 200) ?? null, decisionId: b.decision_id === undefined ? null : num(b.decision_id, 'decision_id'), agentId: b.agent_id === undefined ? null : num(b.agent_id, 'agent_id'), agentVersion: b.agent_version === undefined ? null : num(b.agent_version, 'agent_version'),
          engine: optStr(b.engine, 20) ?? null, model: optStr(b.model, 100) ?? null, effort: optStr(b.effort, 20) ?? null, depth: b.depth === undefined ? null : num(b.depth, 'depth'), taskKind: optStr(b.task_kind, 40) ?? null, risk: b.risk === undefined ? null : num(b.risk, 'risk'), targetId: b.target_id === undefined ? null : num(b.target_id, 'target_id'), escalatedFromRun: b.escalated_from_run === undefined ? null : num(b.escalated_from_run, 'escalated_from_run') });
        return json(res, 201, { run_id: id }), true;
      }
      if (rest === '/runs' && m === 'GET') return json(res, 200, { runs: store.runs(uid, { agentId: url.searchParams.has('agent') ? Number(url.searchParams.get('agent')) : undefined, sessionId: url.searchParams.get('session') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 50) }) }), true;
      const runMatch = rest.match(/^\/runs\/(\d+)\/outcome$/);
      if (runMatch && m === 'PATCH') {
        const b = await readJson(req);
        const id = Number(runMatch[1]);
        const fb = b.user_feedback; if (fb !== undefined && fb !== null && fb !== 'up' && fb !== 'down') throw new HttpError(400, 'user_feedback must be up|down|null');
        const tr = b.test_result; if (tr !== undefined && tr !== null && tr !== 'pass' && tr !== 'fail') throw new HttpError(400, 'test_result must be pass|fail|null');
        const row = store.updateRun(uid, id, { sessionId: optStr(b.session_id, 200) ?? undefined, finishedAt: b.finished === false ? undefined : Date.now(), exitCode: b.exit_code === undefined ? undefined : (b.exit_code === null ? null : num(b.exit_code, 'exit_code')), toolErrors: b.tool_errors === undefined ? undefined : num(b.tool_errors, 'tool_errors'),
          userFeedback: fb as string | null | undefined, reverted: b.reverted === undefined ? undefined : (b.reverted ? 1 : 0), reasked: b.reasked === undefined ? undefined : (b.reasked ? 1 : 0), testResult: tr as string | null | undefined, costTokens: b.cost_tokens === undefined ? undefined : num(b.cost_tokens, 'cost_tokens') });
        // §3.8 outcome rule; explicit signals first, then Laya on a summary, else unknown
        let outcome: string = 'unknown'; let classified: unknown = null;
        if ((row.exit_code !== null && row.exit_code !== 0) || row.tool_errors >= 3 || row.user_feedback === 'down' || row.reverted || row.test_result === 'fail') outcome = 'fail';
        else if (row.user_feedback === 'up' || row.test_result === 'pass') outcome = 'success';
        else if (typeof b.summary === 'string' && b.summary.trim()) {
          const d = await decide(laya, 'outcome.classify', { state: { summary: b.summary.slice(0, 4000) } });
          store.logKindDecision({ userId: uid, kind: d.kind, command: b.summary.slice(0, 4000), answer: d.answer, confidence: d.confidence, probabilities: d.probabilities, latencyMs: d.latency_ms, device: d.device, fallback: d.fallback });
          outcome = typeof d.answer === 'string' ? d.answer : 'unknown'; classified = { confidence: d.confidence, fallback: d.fallback };
        }
        const final = store.updateRun(uid, id, { outcome });
        if (final.decision_id) store.finalizeDecision(uid, final.decision_id, null, outcome);
        // Learning loop (§3.8): a successful run with a specialist confirms the routing — the command
        // becomes an example for that agent, so the lexical prior sharpens with real usage.
        // E-03: a fresh failure gets a proposed next step (offered to the user as a one-tap card).
        let next: NextAction | null = null;
        if (outcome === 'fail' && row.outcome !== 'fail' && final.agent_id) {
          try {
            next = await decideNext(store, laya, final, await engineAvailability(session));
            store.db.prepare('UPDATE runs SET next_action=? WHERE id=?').run(JSON.stringify(next), final.id);
            console.log(`[aidev] run ${final.id} failed → ${next.action}${next.model ? ` (${next.engine} ${next.model}/${next.effort})` : ''}: ${next.reason}`);
          } catch (error) { console.warn('[aidev] escalation failed:', error instanceof Error ? error.message : error); }
        }
        // Learning loop (§3.8 / E-02): the lessons this command carried learn from how it ended.
        if (final.decision_id && (outcome === 'success' || outcome === 'fail') && row.outcome !== outcome) {
          for (const line of applyLessonOutcome(store, final.decision_id, outcome)) console.log(`[aidev] ${line}`);
        }
        // Learning loop (§3.8 / E-01): a fresh failure is curated out of band into a lesson candidate.
        if (outcome === 'fail' && final.agent_id && row.outcome !== 'fail' && final.session_id) {
          void curateFailure(session, final).catch((error) => console.warn('[aidev] lesson curation failed:', error instanceof Error ? error.message : error));
        }
        if (outcome === 'success' && final.agent_id && final.decision_id && row.outcome !== 'success') {
          const decisionRow = store.db.prepare('SELECT command FROM decision_log WHERE id=?').get(final.decision_id) as { command: string } | undefined;
          const agent = store.agentById(final.agent_id);
          if (decisionRow && agent && agent.name !== 'generalist' && agent.domain !== 'meta') store.addExamples(agent.id, [{ text: decisionRow.command, source: 'run', taskKind: final.task_kind }]);   // a confirmed run also confirms its task kind
        }
        return json(res, 200, { run: final, classified, next }), true;
      }

      // ---- lessons --------------------------------------------------------------------------
      if (rest === '/lessons' && m === 'GET') {
        const agentId = num(url.searchParams.get('agent'), 'agent'); ownAgent(session, agentId);
        return json(res, 200, { lessons: store.lessons(agentId, uid, (url.searchParams.get('status') ?? 'verified,candidate').split(',')) }), true;
      }
      if (rest === '/lessons' && m === 'POST') {
        const b = await readJson(req);
        const agentId = num(b.agent_id, 'agent_id'); ownAgent(session, agentId);
        const id = store.addLesson({ agentId, engine: optStr(b.engine, 20) ?? null, trigger: str(b.trigger, 'trigger', 1000), rule: str(b.rule, 'rule', 2000), evidenceRunId: b.evidence_run_id === undefined ? null : num(b.evidence_run_id, 'evidence_run_id'), ownerId: uid, status: b.status === 'verified' ? 'verified' : 'candidate' });
        return json(res, 201, { lesson: store.lessonById(id) }), true;
      }
      const lessonMatch = rest.match(/^\/lessons\/(\d+)$/);
      if (lessonMatch && m === 'PATCH') {
        const b = await readJson(req); const id = Number(lessonMatch[1]);
        const l = store.lessonById(id); if (!l || (l.owner_id !== null && l.owner_id !== uid)) throw new HttpError(404, 'Lesson not found');
        const status = optStr(b.status, 20);
        store.updateLesson(id, { status, rule: optStr(b.rule, 2000), trigger: optStr(b.trigger, 1000), ...(status === 'verified' && l.status !== 'verified' ? { verifiedBy: 'user' } : {}) });
        // manual promotion from the catalog (normally automatic after PROMOTE_HITS successes)
        let promoted: string | null = null;
        if (b.promote === true) {
          const cur = store.lessonById(id)!;
          if (cur.status !== 'verified' || cur.promoted_to_prompt) throw new HttpError(409, 'Only a verified, not yet promoted lesson can be promoted');
          promoted = promote(store, id);
          console.log(`[aidev] ${promoted} (manual)`);
        }
        return json(res, 200, { lesson: store.lessonById(id), promoted }), true;
      }

      // ---- knowledge ------------------------------------------------------------------------
      if (rest === '/knowledge' && m === 'GET') {
        const q = url.searchParams.get('q'); const agentId = url.searchParams.has('agent') ? Number(url.searchParams.get('agent')) : undefined;
        if (agentId) ownAgent(session, agentId);
        return json(res, 200, { knowledge: q ? store.searchKnowledge(q, agentId, uid) : (agentId ? store.knowledge(agentId, ['verified', 'sourced', 'unverified', 'proposed'], uid) : []) }), true;
      }
      if (rest === '/knowledge' && m === 'POST') {
        const b = await readJson(req);
        const agentId = num(b.agent_id, 'agent_id'); ownAgent(session, agentId);
        const id = store.addKnowledge({ agentId, title: str(b.title, 'title', 200), body: str(b.body, 'body', 60000), sourceUrl: optStr(b.source_url, 2000) ?? null, sourceDate: optStr(b.source_date, 40) ?? null, status: optStr(b.status, 20), ownerId: uid });
        return json(res, 201, { knowledge: store.knowledgeById(id) }), true;
      }
      // E-04: re-check against sources (runs in the background on the caller's runtime; poll GET)
      if (rest === '/knowledge/refresh' && m === 'POST') {
        const b = await readJson(req);
        const admin = store.accountEngines(uid).role === 'admin';
        try {
          const job = knowledgeRefresher.start(session.user, { itemId: b.id === undefined ? undefined : num(b.id, 'id'), includeGlobal: admin });
          return json(res, 202, { job }), true;
        } catch (error) { throw new HttpError(error instanceof Error && error.message === 'Knowledge not found' ? 404 : 400, error instanceof Error ? error.message : 'refresh failed'); }
      }
      if (rest === '/knowledge/refresh' && m === 'GET') return json(res, 200, { job: knowledgeRefresher.status(uid) }), true;
      if (rest === '/knowledge/proposals' && m === 'GET') return json(res, 200, { proposals: store.knowledgeProposals(uid, store.accountEngines(uid).role === 'admin').map((p) => ({ ...p, replaces_item: p.replaces ? store.knowledgeById(p.replaces) ?? null : null })) }), true;
      const proposalMatch = rest.match(/^\/knowledge\/(\d+)\/decide$/);
      if (proposalMatch && m === 'POST') {
        const b = await readJson(req); const id = Number(proposalMatch[1]);
        const k = store.knowledgeById(id);
        const mayDecide = k && (k.owner_id === uid || (k.owner_id === null && store.accountEngines(uid).role === 'admin'));
        if (!k || !mayDecide || k.status !== 'proposed') throw new HttpError(404, 'Proposal not found');
        const result = decideProposal(store, id, b.accept === true);
        console.log(`[aidev] knowledge proposal #${id} ${b.accept === true ? 'accepted' : 'rejected'} by ${session.user.username}`);
        return json(res, 200, result), true;
      }
      const knowledgeMatch = rest.match(/^\/knowledge\/(\d+)$/);
      if (knowledgeMatch && m === 'PATCH') {
        const b = await readJson(req); const id = Number(knowledgeMatch[1]);
        const k = store.knowledgeById(id); if (!k || (k.owner_id !== null && k.owner_id !== uid)) throw new HttpError(404, 'Knowledge not found');
        store.updateKnowledge(id, { status: optStr(b.status, 20), supersededBy: b.superseded_by === undefined ? undefined : (b.superseded_by === null ? null : num(b.superseded_by, 'superseded_by')), title: optStr(b.title, 200), body: optStr(b.body, 60000) });
        return json(res, 200, { knowledge: store.knowledgeById(id) }), true;
      }

      // ---- targets (remote PCs with aidev-runner; F-02) ----------------------------------------
      const targetView = (t: NonNullable<ReturnType<Store['target']>>) => ({
        ...t, token_hash: undefined, paired: Boolean(t.token_hash),
        pairing_code: t.pairing_expires && t.pairing_expires > Date.now() ? t.pairing_code : null,
        pairing_expires: t.pairing_expires && t.pairing_expires > Date.now() ? t.pairing_expires : null,
        tags: t.tags ? JSON.parse(t.tags) : [], capabilities: t.capabilities ? JSON.parse(t.capabilities) : null,
        allowed_roots: t.allowed_roots ? JSON.parse(t.allowed_roots) : [],
        online: deps.runners?.online(t.id) ?? false, connection: deps.runners?.connection(t.id) ?? null,
      });
      if (rest === '/targets' && m === 'GET') return json(res, 200, { targets: store.targets(uid).map(targetView) }), true;
      if (rest === '/targets' && m === 'POST') {
        const b = await readJson(req);
        const code = crypto.randomBytes(4).toString('hex').toUpperCase();
        const id = store.addTarget({ userId: uid, name: str(b.name, 'name', 41), platform: optStr(b.platform, 20) ?? null, tags: Array.isArray(b.tags) ? (b.tags as unknown[]).map(String).slice(0, 20) : [], description: optStr(b.description, 600) ?? '', policy: optStr(b.policy, 10), pairingCode: code, pairingExpires: Date.now() + 10 * 60_000 });
        return json(res, 201, { target: { id, pairing_code: code, expires_in: 600 } }), true;
      }
      // last N bytes of a run: the live ring while the gateway holds the stream, else the log file
      const readRunTail = async (r: { id: number; target_id: number }, want: number): Promise<Buffer> => {
        const live = deps.runners?.streamByRun(r.id);
        const ring = live ? deps.runners!.tail(r.target_id, live.streamId) : null;
        if (ring) return ring.subarray(-want);
        const file = deps.runners?.logPath(r.id);
        const stat = file ? await fs.promises.stat(file).catch(() => null) : null;
        if (!file || !stat?.isFile()) return Buffer.alloc(0);
        const fh = await fs.promises.open(file, 'r');
        try { const len = Math.min(stat.size, want); const data = Buffer.alloc(len); await fh.read(data, 0, len, stat.size - len); return data; } finally { await fh.close(); }
      };
      // ---- remote runs (F-03): start a command on a target, list runs, read logs, stop ---------------
      const remoteRunView = (r: NonNullable<ReturnType<Store['remoteRunById']>>) => ({ ...r, artifacts: r.artifacts ? JSON.parse(r.artifacts) : null, live: deps.runners?.streamByRun(r.id) ?? null });
      // ---- project sync (F-04): the runtime drives sync.manifest/write/delete on the runner ----------
      const rpcMatch = rest.match(/^\/targets\/(\d+)\/(rpc|sync-report)$/);
      if (rpcMatch && m === 'POST') {
        const id = Number(rpcMatch[1]);
        const target = store.target(uid, id);
        if (!target) throw new HttpError(404, 'Target not found');
        if (rpcMatch[2] === 'sync-report') {
          const b = await readJson(req);
          const dest = optStr(b.dest, 1000) ?? null;
          const rr = store.addRemoteRun({ runId: typeof b.runId === 'number' && store.run(uid, b.runId) ? b.runId : null, targetId: id, userId: uid, kind: 'sync', cmd: `sync ${optStr(b.project, 200) ?? '?'} → ${dest ?? '?'}`, cwd: dest, approvedBy: session.sid.startsWith('runtime:') ? 'auto' : 'user' });
          const art = { uploaded: Number(b.uploaded) || 0, deleted: Number(b.deleted) || 0, unchanged: Number(b.unchanged) || 0, bytes: Number(b.bytes) || 0, duration_ms: Number(b.ms) || 0, skipped: Array.isArray(b.skipped) ? (b.skipped as unknown[]).slice(0, 50) : [], error: optStr(b.error, 500) ?? undefined };
          store.finishRemoteRun(rr, { exitCode: art.error ? 1 : 0, artifacts: art });
          console.log(`[runner] target #${id} sync run #${rr} ${dest}: +${art.uploaded} -${art.deleted} =${art.unchanged} ${art.bytes}B ${art.duration_ms}ms${art.error ? ` ERROR ${art.error}` : ''}`);
          return json(res, 200, { remoteRunId: rr }), true;
        }
        // file batches for sync.write reach 8 MB (base64 ~11 MB)
        const b = await readJson(req, 12 * 1024 * 1024);
        const method = str(b.method, 'method', 40);
        const allowed = ['sync.manifest', 'sync.write', 'sync.delete', 'runner.capabilities', 'fs.resolve'];
        if (!allowed.includes(method)) throw new HttpError(403, `method not allowed: ${method}`);
        if (method !== 'sync.manifest' && method !== 'fs.resolve' && method !== 'runner.capabilities' && target.policy === 'deny') throw new HttpError(403, '이 대상의 실행 정책이 "실행 금지"입니다');
        if (!deps.runners?.online(id)) throw new HttpError(409, `대상 ${target.name}이(가) 오프라인입니다`);
        const params = b.params && typeof b.params === 'object' ? b.params as Record<string, unknown> : {};
        if (typeof params.root === 'string') params.root = normalizeCwd(params.root, target.allowed_roots ? JSON.parse(target.allowed_roots) as string[] : []);
        try { return json(res, 200, { result: await deps.runners.call(id, method, params, method === 'sync.manifest' ? 180_000 : 120_000) }), true; }
        catch (error) { throw new HttpError(error instanceof RpcError && error.code === -32010 ? 409 : 400, error instanceof Error ? error.message : 'rpc failed'); }
      }
      const execMatch = rest.match(/^\/targets\/(\d+)\/(exec|runs)$/);
      if (execMatch) {
        const id = Number(execMatch[1]);
        const target = store.target(uid, id);
        if (!target) throw new HttpError(404, 'Target not found');
        if (execMatch[2] === 'runs' && m === 'GET') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 200);
          return json(res, 200, { runs: store.remoteRuns(uid, id, limit).map(remoteRunView), streams: deps.runners?.streams(id) ?? [] }), true;
        }
        if (execMatch[2] === 'exec' && m === 'POST') {
          // the user's own hand (workbench) runs directly; an agent (runtime session) goes through the gate (F-05)
          const agentCall = session.sid.startsWith('runtime:');
          if (!agentCall && target.policy === 'deny') throw new HttpError(403, '이 대상의 실행 정책이 "거부"입니다 — 원격 대상에서 정책을 바꾸세요');
          if (!deps.runners) throw new HttpError(503, 'runner hub unavailable');
          const b = await readJson(req);
          const cmd = str(b.cmd, 'cmd', 16000);
          let env: Record<string, string> | undefined;
          if (b.env !== undefined) {
            if (!b.env || typeof b.env !== 'object' || Array.isArray(b.env)) throw new HttpError(400, 'env must be an object');
            const entries = Object.entries(b.env as Record<string, unknown>);
            if (entries.length > 50 || entries.some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) || typeof v !== 'string' || v.length > 8192)) throw new HttpError(400, 'env: up to 50 NAME=string pairs');
            env = Object.fromEntries(entries) as Record<string, string>;
          }
          const int = (v: unknown, lo: number, hi: number) => (v === undefined || v === null ? undefined : Math.min(Math.max(Math.round(num(v, 'number')), lo), hi));
          const exec = { cmd, cwd: normalizeCwd(optStr(b.cwd, 1000) || null, target.allowed_roots ? JSON.parse(target.allowed_roots) as string[] : []), pty: agentCall ? false : b.pty === true, cols: int(b.cols, 10, 500), rows: int(b.rows, 4, 300), env, timeoutSec: int(b.timeoutSec, 1, 86400) };
          try {
            if (agentCall) {
              if (!deps.gate) throw new HttpError(503, 'remote gate unavailable');
              if (!deps.runners.online(id)) return json(res, 200, { status: 'offline', error: `대상 ${target.name}이(가) 오프라인입니다 — 러너가 실행 중인지 확인하라고 사용자에게 알리세요` }), true;
              const runId = typeof b.runId === 'number' && store.run(uid, b.runId) ? b.runId : null;
              const result = await deps.gate.request(uid, target, exec, { runId, agent: optStr(b.agent, 41) ?? null });
              return json(res, 200, result), true;
            }
            const stream = await deps.runners.exec(id, uid, exec, { approvedBy: 'user' });
            return json(res, 201, { stream }), true;
          } catch (error) {
            if (error instanceof HttpError) throw error;
            // an agent gets the reason as a result it can act on (folder, roots), not a transport error
            if (agentCall) return json(res, 200, { status: 'error', error: error instanceof Error ? error.message : 'exec failed', allowed_roots: target.allowed_roots ? JSON.parse(target.allowed_roots) : [] }), true;
            throw new HttpError(error instanceof RpcError && error.code === -32010 ? 409 : 400, error instanceof Error ? error.message : 'exec failed');
          }
        }
      }
      // ---- approvals (F-05): agent commands waiting for the user --------------------------------
      if (rest === '/approvals' && m === 'GET') return json(res, 200, { approvals: deps.gate?.list(uid, url.searchParams.get('all') === '1') ?? [] }), true;
      const approvalMatch = rest.match(/^\/approvals\/([A-Za-z0-9_-]{8,40})(\/wait)?$/);
      if (approvalMatch && deps.gate) {
        if (approvalMatch[2] === '/wait' && m === 'GET') {
          const timeoutMs = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 25, 1), 50) * 1000;
          const a = await deps.gate.wait(uid, approvalMatch[1], timeoutMs);
          if (!a) throw new HttpError(404, 'approval not found');
          return json(res, 200, { approval: a }), true;
        }
        if (!approvalMatch[2] && m === 'GET') { const a = deps.gate.get(uid, approvalMatch[1]); if (!a) throw new HttpError(404, 'approval not found'); return json(res, 200, { approval: a }), true; }
        if (!approvalMatch[2] && m === 'POST') {
          // only the person answers: an agent can never approve its own command
          if (session.sid.startsWith('runtime:')) throw new HttpError(403, 'approvals are answered by the user');
          const b = await readJson(req);
          try { return json(res, 200, { approval: await deps.gate.answer(uid, approvalMatch[1], b.allow === true, { auto: b.auto === true }) }), true; }
          catch (error) { throw new HttpError((error as { status?: number }).status ?? 400, error instanceof Error ? error.message : 'approval failed'); }
        }
      }
      if (rest === '/remote-runs' && m === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 200);
        return json(res, 200, { runs: store.remoteRuns(uid, undefined, limit).map(remoteRunView) }), true;
      }
      const remoteRunMatch = rest.match(/^\/remote-runs\/(\d+)(\/log|\/signal|\/wait)?$/);
      if (remoteRunMatch) {
        const row = store.remoteRunById(uid, Number(remoteRunMatch[1]));
        if (!row) throw new HttpError(404, 'Remote run not found');
        if (!remoteRunMatch[2] && m === 'GET') return json(res, 200, { run: remoteRunView(row) }), true;
        if (remoteRunMatch[2] === '/log' && m === 'GET') {
          const want = Math.min(Math.max(Number(url.searchParams.get('bytes')) || 65536, 1024), 1024 * 1024);
          const live = deps.runners?.streamByRun(row.id);
          let text = (await readRunTail(row, want)).toString('utf8');
          if (url.searchParams.get('plain') === '1') text = plainText(text);
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-remote-run-running': live?.running ? '1' : '0' });
          res.end(text);
          return true;
        }
        if (remoteRunMatch[2] === '/wait' && m === 'GET') {
          // long-poll for agents (remote_exec / remote_logs): returns when the run ends or after ?timeout= seconds
          const rawTimeout = url.searchParams.get('timeout');
          const timeoutMs = Math.min(Math.max(rawTimeout === null ? 25 : Number(rawTimeout) || 0, 0), 50) * 1000;
          const bytes = Math.min(Math.max(Number(url.searchParams.get('bytes')) || 12000, 1024), 200_000);
          if (deps.runners && timeoutMs) await deps.runners.waitRun(row.id, timeoutMs);
          const fresh = store.remoteRunById(uid, row.id) ?? row;
          return json(res, 200, { run: remoteRunView(fresh), output: plainText((await readRunTail(fresh, bytes * 2)).toString('utf8')).slice(-bytes) }), true;
        }
        if (remoteRunMatch[2] === '/signal' && m === 'POST') {
          const b = await readJson(req);
          const signal = typeof b.signal === 'string' && /^(INT|TERM|KILL)$/.test(b.signal) ? b.signal : 'INT';
          const live = deps.runners?.streamByRun(row.id);
          if (!live?.running) throw new HttpError(409, '실행 중이 아닙니다');
          try { await deps.runners!.control(row.target_id, live.streamId, 'signal', { signal }); } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'signal failed'); }
          return json(res, 200, { ok: true }), true;
        }
      }
      const targetMatch = rest.match(/^\/targets\/(\d+)(\/pair\/refresh|\/ping|\/refresh-caps)?$/);
      if (targetMatch) {
        const id = Number(targetMatch[1]);
        if (!store.target(uid, id)) throw new HttpError(404, 'Target not found');
        if (targetMatch[2] === '/ping' && m === 'POST') {
          const t0 = Date.now();
          try { const result = await deps.runners!.call(id, 'runner.ping', {}, 10_000); return json(res, 200, { ok: true, rtt_ms: Date.now() - t0, result }), true; }
          catch (error) { return json(res, 200, { ok: false, error: error instanceof Error ? error.message : 'ping failed' }), true; }
        }
        if (targetMatch[2] === '/refresh-caps' && m === 'POST') {
          try {
            const caps = await deps.runners!.call<Record<string, unknown>>(id, 'runner.capabilities', {}, 20_000);
            store.updateTarget(uid, id, { capabilities: caps, lastSeen: Date.now(), allowedRoots: Array.isArray(caps.allowed_roots) ? (caps.allowed_roots as unknown[]).map(String) : null });
            return json(res, 200, { target: targetView(store.target(uid, id)!) }), true;
          } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'runner unavailable'); }
        }
        if (targetMatch[2] && m === 'POST') { const code = crypto.randomBytes(4).toString('hex').toUpperCase(); store.updateTarget(uid, id, { pairingCode: code, pairingExpires: Date.now() + 10 * 60_000 }); return json(res, 200, { pairing_code: code, expires_in: 600 }), true; }
        if (!targetMatch[2] && m === 'PATCH') { const b = await readJson(req); store.updateTarget(uid, id, { name: optStr(b.name, 41), description: optStr(b.description, 600), tags: Array.isArray(b.tags) ? (b.tags as unknown[]).map(String) : undefined, policy: optStr(b.policy, 10) }); return json(res, 200, { ok: true }), true; }
        if (!targetMatch[2] && m === 'DELETE') { store.deleteTarget(uid, id); deps.runners?.disconnect(id); return json(res, 200, { ok: true }), true; }
      }

      // ---- admin / export ----------------------------------------------------------------------
      if (rest === '/export/decisions' && m === 'GET') {
        requireAdmin(session);
        const kind = url.searchParams.get('kind') ?? 'route';
        const rows = kind === 'route' ? store.decisionExport() : store.decisionExportKind(kind);
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        for (const r of rows) res.write(`${JSON.stringify(r)}\n`);
        return res.end(), true;
      }
      // E-05: learned tier per (domain, depth, engine) + change log; run now / pin / reset (admin)
      if (rest === '/tier-policy' && m === 'GET') {
        requireAdmin(session);
        return json(res, 200, { cells: store.tierPolicyRows(), log: store.tierPolicyLog(50), last_run: Number(store.kvGet('tier_policy_at') ?? 0) || null, table: TIER_TABLE, downgrade: downgradeEnabled(store) }), true;
      }
      if (rest === '/tier-policy/settings' && m === 'PUT') {
        requireAdmin(session);
        const b = await readJson(req);
        if (typeof b.downgrade === 'boolean') { store.kvSet('tier_policy_downgrade', b.downgrade ? 'on' : 'off'); console.log(`[aidev] tier policy downgrades ${b.downgrade ? 'on' : 'off'} (${session.user.username})`); }
        return json(res, 200, { downgrade: downgradeEnabled(store) }), true;
      }
      if (rest === '/tier-policy/run' && m === 'POST') { requireAdmin(session); const tiers = runTierPolicy(store, { actor: session.user.username }); return json(res, 200, { ...tiers, weights: runEngineWeights(store, { actor: session.user.username }) }), true; }
      if (rest === '/tier-policy' && m === 'PUT') {
        requireAdmin(session);
        const b = await readJson(req);
        const cell = { domain: str(b.domain, 'domain', 60), depth: num(b.depth, 'depth'), engine: str(b.engine, 'engine', 10) };
        try { return json(res, 200, { cell: setTierPolicy(store, cell, b.level === null || b.level === undefined ? null : num(b.level, 'level'), b.pinned === true, session.user.username) }), true; }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'invalid'); }
      }
      if (rest === '/stats' && m === 'GET') { requireAdmin(session); return json(res, 200, { decisions_24h: store.decisionStats(86400_000), laya: laya.status }), true; }
      return json(res, 404, { error: 'Not found' }), true;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      return json(res, status, { error: error instanceof Error ? error.message : 'Request failed' }), true;
    }
  }
  return { handle, engineAvailability, knowledgeRefresher };
}
