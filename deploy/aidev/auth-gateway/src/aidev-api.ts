import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { openStore } from './store.js';
import { ENGINES, type Engine } from './store-aidev.js';
import type { LayaClient } from './laya.js';
import { decide, listKinds } from './laya-questions.js';
import { route, type EngineAvailability, type RouteInput } from './routing.js';

/**
 * /api/aidev/* — routing, decisions, agent catalog, runs, lessons, knowledge, engines, targets
 * (IMPLEMENTATION-PLAN §3.3). Everything requires a gateway session; admin-only routes check `role`.
 */
type Store = ReturnType<typeof openStore>;
type Session = { user: { id: number; username: string; runtime: string }; sid: string };
export type AidevDeps = {
  store: Store; laya: LayaClient;
  /** Authenticated fetch against the caller's CloudCLI runtime (path starts with /api/...). */
  runtimeFetch: (session: Session, path: string, init?: RequestInit) => Promise<Response>;
  json: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
};

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

  async function engineAvailability(session: Session): Promise<EngineAvailability> {
    const acct = store.accountEngines(session.user.id);
    const cached = Object.fromEntries(store.engineStatus(session.user.id).map((r) => [r.engine, r]));
    const out = { claude: { allowed: false, authenticated: false, error: null }, codex: { allowed: false, authenticated: false, error: null } } as EngineAvailability;
    await Promise.all(ENGINES.map(async (engine) => {
      out[engine].allowed = acct.engines.includes(engine);
      if (!out[engine].allowed) return;
      const c = cached[engine];
      if (c && Date.now() - c.checked_at < ENGINE_CACHE_MS) { out[engine].authenticated = Boolean(c.authenticated); out[engine].error = c.last_error; return; }
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

  function requireAdmin(session: Session) { if (store.accountEngines(session.user.id).role !== 'admin') throw new HttpError(403, 'Administrator only'); }
  function ownAgent(session: Session, id: number, write = false) {
    const a = store.agentById(id);
    if (!a || (a.owner_id !== null && a.owner_id !== session.user.id)) throw new HttpError(404, 'Agent not found');
    if (write && a.owner_id === null && store.accountEngines(session.user.id).role !== 'admin') throw new HttpError(403, 'Global agents are edited by administrators; create a private copy instead');
    return a;
  }
  const agentView = (a: ReturnType<Store['agentById']> & object) => ({ id: a.id, name: a.name, domain: a.domain, description: a.description, prompt: a.prompt, tools: a.tools ? JSON.parse(a.tools) : null, model: a.model, maxTurns: a.max_turns, skills: a.skills ? JSON.parse(a.skills) : null, mcpServers: a.mcp_servers ? JSON.parse(a.mcp_servers) : null, ownerId: a.owner_id, source: a.source, active: Boolean(a.active), uses: a.uses, version: a.version, createdAt: a.created_at, updatedAt: a.updated_at });

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
          projectHint: optStr(b.projectHint, 400), recentFiles: Array.isArray(b.recentFiles) ? (b.recentFiles as unknown[]).map(String).slice(0, 10) : null, model: optStr(b.model, 100), effort: optStr(b.effort, 20) };
        const engines = await engineAvailability(session);
        return json(res, 200, await route(store, laya, uid, engines, input)), true;
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
        store.overrideDecision(uid, Number(decMatch[1]), { finalAgent: optStr(b.final_agent, 60) ?? null, finalEngine: optStr(b.final_engine, 20) ?? null, finalModel: optStr(b.final_model, 100) ?? null, finalTarget: optStr(b.final_target, 60) ?? null, finalAnswer: b.final_answer });
        return json(res, 200, { ok: true }), true;
      }
      if (rest === '/decisions' && m === 'GET') return json(res, 200, { decisions: store.decisions(uid, Number(url.searchParams.get('limit') ?? 100)) }), true;

      // ---- engines --------------------------------------------------------------------------
      if (rest === '/engines' && m === 'GET') {
        const acct = store.accountEngines(uid);
        return json(res, 200, { engines: await engineAvailability(session), default_engine: acct.defaultEngine, role: acct.role, weights: store.engineWeights() }), true;
      }
      if (rest === '/engines/weights' && m === 'PUT') {
        requireAdmin(session);
        const b = await readJson(req);
        store.setEngineWeight(str(b.task_kind, 'task_kind', 40), str(b.engine, 'engine', 20) as Engine, num(b.weight, 'weight'));
        return json(res, 200, { weights: store.engineWeights() }), true;
      }

      // ---- agents ---------------------------------------------------------------------------
      if (rest === '/agents' && m === 'GET') {
        const includeInactive = url.searchParams.get('all') === '1';
        return json(res, 200, { agents: store.agents(uid, includeInactive).map(agentView) }), true;
      }
      if (rest === '/agents' && m === 'POST') {
        const b = await readJson(req);
        const id = store.addAgent({ name: str(b.name, 'name', 41), domain: optStr(b.domain, 40) ?? '', description: str(b.description, 'description', 600), prompt: str(b.prompt, 'prompt'), tools: Array.isArray(b.tools) ? (b.tools as unknown[]).map(String) : null,
          model: optStr(b.model, 100) ?? null, maxTurns: b.maxTurns === undefined ? null : num(b.maxTurns, 'maxTurns'), skills: Array.isArray(b.skills) ? (b.skills as unknown[]).map(String) : null, mcpServers: b.mcpServers && typeof b.mcpServers === 'object' ? b.mcpServers as Record<string, unknown> : null,
          ownerId: b.global === true ? (requireAdmin(session), null) : uid, source: optStr(b.source, 20) ?? 'user' });
        if (Array.isArray(b.knowledge)) for (const k of b.knowledge as Array<Record<string, unknown>>) {
          if (typeof k?.title === 'string' && typeof k?.body === 'string') store.addKnowledge({ agentId: id, title: k.title, body: k.body, sourceUrl: optStr(k.source_url, 2000) ?? null, sourceDate: optStr(k.source_date, 40) ?? null, ownerId: uid });
        }
        return json(res, 201, { agent: agentView(store.agentById(id)!) }), true;
      }
      const agentMatch = rest.match(/^\/agents\/(\d+)(\/promote|\/versions)?$/);
      if (agentMatch) {
        const id = Number(agentMatch[1]);
        if (agentMatch[2] === '/promote' && m === 'POST') { requireAdmin(session); ownAgent(session, id); store.promoteAgent(id); return json(res, 200, { agent: agentView(store.agentById(id)!) }), true; }
        if (agentMatch[2] === '/versions' && m === 'GET') { ownAgent(session, id); return json(res, 200, { versions: store.agentVersions(id) }), true; }
        if (!agentMatch[2] && m === 'GET') {
          const a = ownAgent(session, id);
          return json(res, 200, { agent: agentView(a), knowledge: store.knowledge(id, ['verified', 'sourced', 'unverified']), lessons: store.lessons(id, uid, ['verified', 'candidate']), stats: store.agentStats(id), versions: store.agentVersions(id).map((v) => ({ version: v.version, changelog: v.changelog, createdAt: v.created_at })) }), true;
        }
        if (!agentMatch[2] && m === 'PUT') {
          ownAgent(session, id, true);
          const b = await readJson(req);
          const version = store.newAgentVersion(id, { prompt: optStr(b.prompt), description: optStr(b.description, 600), domain: optStr(b.domain, 40), tools: b.tools === undefined ? undefined : (Array.isArray(b.tools) ? (b.tools as unknown[]).map(String) : null), model: b.model === undefined ? undefined : (optStr(b.model, 100) ?? null),
            skills: b.skills === undefined ? undefined : (Array.isArray(b.skills) ? (b.skills as unknown[]).map(String) : null), mcpServers: b.mcpServers === undefined ? undefined : (b.mcpServers && typeof b.mcpServers === 'object' ? b.mcpServers as Record<string, unknown> : null), maxTurns: b.maxTurns === undefined ? undefined : (b.maxTurns === null ? null : num(b.maxTurns, 'maxTurns')) }, optStr(b.changelog, 2000) ?? 'edited');
          if (typeof b.active === 'boolean') store.updateAgent(id, { active: b.active ? 1 : 0 });
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
        const row = store.updateRun(uid, id, { finishedAt: b.finished === false ? undefined : Date.now(), exitCode: b.exit_code === undefined ? undefined : (b.exit_code === null ? null : num(b.exit_code, 'exit_code')), toolErrors: b.tool_errors === undefined ? undefined : num(b.tool_errors, 'tool_errors'),
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
        return json(res, 200, { run: final, classified }), true;
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
        store.updateLesson(id, { status: optStr(b.status, 20), rule: optStr(b.rule, 2000), trigger: optStr(b.trigger, 1000) });
        return json(res, 200, { lesson: store.lessonById(id) }), true;
      }

      // ---- knowledge ------------------------------------------------------------------------
      if (rest === '/knowledge' && m === 'GET') {
        const q = url.searchParams.get('q'); const agentId = url.searchParams.has('agent') ? Number(url.searchParams.get('agent')) : undefined;
        if (agentId) ownAgent(session, agentId);
        return json(res, 200, { knowledge: q ? store.searchKnowledge(q, agentId) : (agentId ? store.knowledge(agentId, ['verified', 'sourced', 'unverified']) : []) }), true;
      }
      if (rest === '/knowledge' && m === 'POST') {
        const b = await readJson(req);
        const agentId = num(b.agent_id, 'agent_id'); ownAgent(session, agentId);
        const id = store.addKnowledge({ agentId, title: str(b.title, 'title', 200), body: str(b.body, 'body', 60000), sourceUrl: optStr(b.source_url, 2000) ?? null, sourceDate: optStr(b.source_date, 40) ?? null, status: optStr(b.status, 20), ownerId: uid });
        return json(res, 201, { knowledge: store.knowledgeById(id) }), true;
      }
      const knowledgeMatch = rest.match(/^\/knowledge\/(\d+)$/);
      if (knowledgeMatch && m === 'PATCH') {
        const b = await readJson(req); const id = Number(knowledgeMatch[1]);
        const k = store.knowledgeById(id); if (!k || (k.owner_id !== null && k.owner_id !== uid)) throw new HttpError(404, 'Knowledge not found');
        store.updateKnowledge(id, { status: optStr(b.status, 20), supersededBy: b.superseded_by === undefined ? undefined : (b.superseded_by === null ? null : num(b.superseded_by, 'superseded_by')), title: optStr(b.title, 200), body: optStr(b.body, 60000) });
        return json(res, 200, { knowledge: store.knowledgeById(id) }), true;
      }

      // ---- targets (registration only; the runner hub lands in stage F) ------------------------
      if (rest === '/targets' && m === 'GET') return json(res, 200, { targets: store.targets(uid).map((t) => ({ ...t, token_hash: undefined, pairing_code: t.pairing_expires && t.pairing_expires > Date.now() ? t.pairing_code : null, tags: t.tags ? JSON.parse(t.tags) : [], capabilities: t.capabilities ? JSON.parse(t.capabilities) : null })) }), true;
      if (rest === '/targets' && m === 'POST') {
        const b = await readJson(req);
        const code = crypto.randomBytes(4).toString('hex').toUpperCase();
        const id = store.addTarget({ userId: uid, name: str(b.name, 'name', 41), platform: optStr(b.platform, 20) ?? null, tags: Array.isArray(b.tags) ? (b.tags as unknown[]).map(String).slice(0, 20) : [], description: optStr(b.description, 600) ?? '', policy: optStr(b.policy, 10), pairingCode: code, pairingExpires: Date.now() + 10 * 60_000 });
        return json(res, 201, { target: { id, pairing_code: code, expires_in: 600 } }), true;
      }
      const targetMatch = rest.match(/^\/targets\/(\d+)(\/pair\/refresh)?$/);
      if (targetMatch) {
        const id = Number(targetMatch[1]);
        if (!store.target(uid, id)) throw new HttpError(404, 'Target not found');
        if (targetMatch[2] && m === 'POST') { const code = crypto.randomBytes(4).toString('hex').toUpperCase(); store.updateTarget(uid, id, { pairingCode: code, pairingExpires: Date.now() + 10 * 60_000 }); return json(res, 200, { pairing_code: code, expires_in: 600 }), true; }
        if (!targetMatch[2] && m === 'PATCH') { const b = await readJson(req); store.updateTarget(uid, id, { name: optStr(b.name, 41), description: optStr(b.description, 600), tags: Array.isArray(b.tags) ? (b.tags as unknown[]).map(String) : undefined, policy: optStr(b.policy, 10) }); return json(res, 200, { ok: true }), true; }
        if (!targetMatch[2] && m === 'DELETE') { store.deleteTarget(uid, id); return json(res, 200, { ok: true }), true; }
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
      if (rest === '/stats' && m === 'GET') { requireAdmin(session); return json(res, 200, { decisions_24h: store.decisionStats(86400_000), laya: laya.status }), true; }
      return json(res, 404, { error: 'Not found' }), true;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      return json(res, status, { error: error instanceof Error ? error.message : 'Request failed' }), true;
    }
  }
  return { handle, engineAvailability };
}
