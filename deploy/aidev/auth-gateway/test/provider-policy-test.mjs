// Provider policy (2026-10-13, docs/aidev/PROVIDER-ENGINE-PLAN.md §2): inside a provider the (model, effort) range
// floor..ceiling is split over D0..D4 by intelligence score (or by count without scores); above the ceiling model's
// level the ceiling model runs at its highest effort (Q2); with a work order the provider changes only on a usage
// limit (Q1); the verifier follows the verification order. A provider without a ladder keeps the tier table.
//   npm run build && node test/provider-policy-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const { pickStep, policySteps, previewPolicy, estimateScores, stepKey, MODEL_CATALOG } = await import('../dist/provider-policy.js');
const { MODEL_LADDER, EFFORT_LADDER, ENGINES } = await import('../dist/store-aidev.js');
const { TIER_TABLE } = await import('../dist/routing.js');

// ---- the catalog is the tier table's models (same names, weakest first) ----------------------------------------
for (const engine of ENGINES) {
  assert.deepEqual(MODEL_CATALOG[engine].map((m) => m.model), MODEL_LADDER[engine], `${engine} catalog = MODEL_LADDER`);
  for (const m of MODEL_CATALOG[engine]) for (const effort of m.efforts) assert.ok(EFFORT_LADDER[engine].includes(effort), `${engine} ${m.model} ${effort}`);
  for (let d = 0; d <= 4; d++) assert.ok(MODEL_CATALOG[engine].find((m) => m.model === TIER_TABLE[d][engine].model).level >= d, `${engine} D${d} model carries D${d}`);
}
console.log('PASS catalog matches the tier table');

const policy = (p) => ({ ladder: ['haiku', 'sonnet', 'opus', 'best'], floor: null, ceiling: null, effortFloor: null, effortCap: 'xhigh', ...p });
const at = (s) => (s ? `${s.model}${s.effort ? `·${s.effort}` : ''}` : null);

// ---- example 2 (steps split, no scores) -----------------------------------------------------------------------
assert.deepEqual(previewPolicy('claude', policy({})).map(at), ['haiku', 'sonnet·high', 'opus·medium', 'best·low', 'best·xhigh']);
assert.deepEqual(previewPolicy('claude', policy({ floor: 'sonnet', ceiling: 'opus' })).map(at), ['sonnet·low', 'sonnet·high', 'opus·low', 'opus·medium', 'opus·xhigh']);
assert.deepEqual(previewPolicy('claude', policy({ ceiling: 'sonnet' })).map(at), ['haiku', 'sonnet·low', 'sonnet·medium', 'sonnet·xhigh', 'sonnet·xhigh']);
const q2 = pickStep('claude', 4, policy({ floor: 'sonnet', ceiling: 'opus' }));
assert.equal(q2.q2, true, 'D4 above opus (level 3) → Q2'); assert.equal(at(q2), 'opus·xhigh');
assert.equal(pickStep('claude', 3, policy({ ceiling: 'sonnet' })).q2, true, 'D3 above sonnet (level 2) → Q2');
console.log('PASS steps split (example 2) and Q2');

// ---- effort floor / ceiling make the range ------------------------------------------------------------------------
assert.deepEqual(policySteps('claude', policy({ floor: 'sonnet', ceiling: 'sonnet', effortFloor: 'medium', effortCap: 'high' })).map(at), ['sonnet·medium', 'sonnet·high']);
assert.deepEqual(policySteps('claude', policy({ ceiling: 'sonnet', effortFloor: 'high', effortCap: 'high' })).map(at), ['haiku', 'sonnet·high'], 'haiku has no efforts: one step');
assert.deepEqual(policySteps('codex', { ladder: null, floor: 'gpt-5.6-luna', ceiling: 'gpt-5.6-luna', effortFloor: null, effortCap: 'ultra' }).map(at),
  ['gpt-5.6-luna·low', 'gpt-5.6-luna·medium', 'gpt-5.6-luna·high', 'gpt-5.6-luna·xhigh', 'gpt-5.6-luna·max'], 'luna stops at max');
assert.deepEqual(policySteps('claude', policy({ floor: 'opus', ceiling: 'opus', effortFloor: 'ultra', effortCap: 'xhigh' })).map(at), ['opus·max'], 'no effort in range → the nearest');
console.log('PASS effort floor and ceiling');

// ---- example 1 (score split, hypothetical scores) -------------------------------------------------------------------
const sc = new Map(Object.entries({ 'sonnet|low': 40, 'sonnet|medium': 45, 'sonnet|high': 50, 'sonnet|xhigh': 53, 'opus|low': 48, 'opus|medium': 52, 'opus|high': 55, 'opus|xhigh': 56 }));
const scored = previewPolicy('claude', policy({ floor: 'sonnet', ceiling: 'opus' }), sc);
assert.deepEqual(scored.map(at), ['sonnet·low', 'sonnet·medium', 'opus·low', 'opus·medium', 'opus·xhigh']);
assert.deepEqual(scored.map((p) => p.target), [40, 44, 48, 52, null]);
assert.deepEqual(scored.map((p) => p.mode), ['score', 'score', 'score', 'score', 'steps']);
// a weaker model at a higher effort that scores in between is used in its place
const between = new Map(sc); between.set('sonnet|xhigh', 51.5);
assert.equal(at(pickStep('claude', 3, policy({ floor: 'sonnet', ceiling: 'opus' }), between)), 'opus·medium', 'D3 target 52: opus·medium 52, not sonnet·xhigh 51.5');
between.set('sonnet|xhigh', 52); assert.equal(at(pickStep('claude', 3, policy({ floor: 'sonnet', ceiling: 'opus' }), between)), 'sonnet·xhigh', 'equal score: the ladder\'s earlier step');
// a missing score → steps split
const partial = new Map(sc); partial.delete('opus|high');
assert.equal(pickStep('claude', 2, policy({ floor: 'sonnet', ceiling: 'opus' }), partial).mode, 'steps');
console.log('PASS score split (example 1)');

// ---- estimates fill the gaps between a model's efforts -----------------------------------------------------------
const est = estimateScores('claude', new Map([['sonnet|low', 40], ['sonnet|high', 50], ['opus|xhigh', 56], ['opus|low', 47]]));
assert.equal(est.scores.get('sonnet|medium'), 45, 'linear between low and high');
assert.equal(est.scores.get('opus|medium'), 50, 'opus low 47 .. xhigh 56: medium 50');
assert.equal(est.scores.get('sonnet|xhigh'), 54, 'beyond the last known: the provider\'s average step (4)');
assert.ok(est.estimated.has('sonnet|medium') && !est.estimated.has('sonnet|low'));
assert.equal(est.scores.has(stepKey('best', 'low')), false, 'a model with no score stays empty');
console.log('PASS score estimates');

// ---- store: the range is checked as a whole ------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-policy-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route } = await import('../dist/routing.js');
const { decideNext } = await import('../dist/escalation.js');
const { createAidevApi } = await import('../dist/aidev-api.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
assert.equal(store.providerPolicy(uid, 'claude').ladder, null, 'no ladder: tier table');
assert.throws(() => store.setProviderPolicy(uid, 'claude', { floor: 'opus', ceiling: 'sonnet' }), /above the ceiling/);
assert.throws(() => store.setProviderPolicy(uid, 'claude', { ladder: ['sonnet', 'opus'], floor: 'haiku' }), /not on the ladder/);
assert.throws(() => store.setProviderPolicy(uid, 'claude', { effortFloor: 'max', effortCap: 'high' }), /above its ceiling/);
assert.throws(() => store.setProviderPolicy(uid, 'claude', { ladder: ['gpt-6-astra'] }), /model must be one of/);
store.setProviderPolicy(uid, 'claude', { ladder: ['sonnet', 'opus', 'best'], floor: 'sonnet', ceiling: 'opus', effortFloor: 'low', effortCap: 'xhigh' });
assert.deepEqual(store.providerPolicy(uid, 'claude'), { ladder: ['sonnet', 'opus', 'best'], floor: 'sonnet', ceiling: 'opus', effortFloor: 'low', effortCap: 'xhigh' });
assert.throws(() => store.setModelFloor(uid, { claude: 'best' }), /above the ceiling/, 'the old floor setting checks the ceiling too');
store.setEffortFloor(uid, { claude: 'high' });
assert.throws(() => store.setEffortCap(uid, { claude: 'medium' }), /below its floor/, 'the effort ceiling cannot go under the floor');
store.setEffortFloor(uid, { claude: 'low' });
assert.equal(store.scoreIndex(uid), 'coding', 'Coding Index by default');
store.setScoreIndex(uid, 'agentic'); assert.equal(store.scoreIndex(uid), 'agentic'); store.setScoreIndex(uid, null);
assert.throws(() => store.setVerifyPriority(uid, ['gemini']), /engines must be among/);
// a chat floor above the account ceiling lifts the ceiling with it
store.setSessionModelFloor(uid, 'chat-f', { claude: 'best' });
assert.equal(store.providerPolicy(uid, 'claude', 'chat-f').ceiling, 'best');
console.log('PASS store policy checks');

// ---- routing: the split for a provider with a ladder, the table for one without -----------------------------------
const both = { claude: { allowed: true, authenticated: true }, codex: { allowed: true, authenticated: true } };
const laya = (depth) => ({ status: {}, predict: async (_s, questions) => {
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    if (id === 'depth') answers[id] = { score: depth };
    else if (id === 'task_kind') answers[id] = { choice: 'explain', probabilities: { explain: 0.9 }, confidence: 0.9 };
    else if (q.type === 'noul') answers[id] = { noul: 0.05 };
    else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 }; }
    else answers[id] = { score: 0 };
  }
  return { answers, latency_ms: 1, device: 'mock' };
} });
store.setEnginePriority(uid, ['claude', 'codex']);
let r = await route(store, laya(2), uid, both, { text: '설명해줘' });
assert.equal(r.plan.engine, 'claude'); assert.deepEqual([r.plan.model, r.plan.effort], ['opus', 'low'], 'claude D2 in sonnet..opus: steps 4/8');
assert.deepEqual(r.plan.step, { index: 4, total: 8, mode: 'steps', q2: false, target: null, score: null });
assert.ok(r.plan.reason.some((l) => l.startsWith('policy claude: D2 → opus/low')), r.plan.reason.join(' | '));
r = await route(store, laya(4), uid, both, { text: '설명해줘' });
assert.deepEqual([r.plan.model, r.plan.effort, r.plan.step.q2], ['opus', 'xhigh', true], 'D4 above opus → Q2');
// Q1: the first provider is kept whatever its learned weight; only its usage limit moves the work
store.setEngineWeight('explain', 'codex', 0.95);
r = await route(store, laya(1), uid, both, { text: '설명해줘' });
assert.equal(r.plan.engine, 'claude', 'priority wins over weights');
const limited = { ...both, claude: { ...both.claude, limited_until: Date.now() + 3600_000 } };
r = await route(store, laya(1), uid, limited, { text: '설명해줘' });
assert.equal(r.plan.engine, 'codex', 'claude on a usage limit → the next provider');
assert.deepEqual([r.plan.model, r.plan.effort, r.plan.step], ['gpt-5.6-terra', 'medium', null], 'codex has no ladder: the tier table');
// a chat bound to a limited provider is moved on (switch_back), unless pinned
r = await route(store, laya(1), uid, limited, { text: '계속', sessionId: 's-lim', sessionEngine: 'claude' });
assert.equal(r.plan.engine, 'claude'); assert.equal(r.plan.switch_back?.engine, 'codex', 'bound engine limited → next');
store.setSessionPinnedEngine(uid, 's-pin', 'claude');
r = await route(store, laya(1), uid, limited, { text: '계속', sessionId: 's-pin', sessionEngine: 'claude' });
assert.equal(r.plan.switch_back, null, 'a pinned chat stays');
console.log('PASS routing: split, Q2, Q1');

// ---- escalation: the range climbs inside the provider; at its top the user is asked (Q1) ----------------------------
const addRun = (p) => store.run(uid, store.addRun({ userId: uid, sessionId: 'esc', agentId: store.agent(uid, 'generalist').id, taskKind: 'explain', ...p }));
const noLaya = { status: {}, predict: async () => { throw new Error('down'); } };
let next = await decideNext(store, noLaya, addRun({ engine: 'claude', model: 'opus', effort: 'low', depth: 2 }), both);
assert.deepEqual([next.action, next.engine, next.model, next.effort, next.from_engine], ['escalate_tier', 'claude', 'opus', 'medium', 'claude'], 'D3 pick');
next = await decideNext(store, noLaya, addRun({ engine: 'claude', model: 'opus', effort: 'xhigh', depth: 4 }), both);
assert.equal(next.action, 'ask_user', 'top of the range with a work order → ask, not switch'); assert.match(next.reason, /순서는 유지/);
const limitedRun = addRun({ engine: 'claude', model: 'opus', effort: 'low', depth: 2 });
store.updateRun(uid, limitedRun.id, { usageLimitResetsAt: 0 });
next = await decideNext(store, noLaya, store.run(uid, limitedRun.id), both);
assert.deepEqual([next.action, next.engine], ['switch_engine', 'codex'], 'usage limit → next provider');
console.log('PASS escalation: Q1 and the range');

// ---- verifier candidates: the verification order, each provider's pick at max(depth, 3) ---------------------------------
const session = { user: { id: uid, username: 'alice', runtime: 'u' + 'a'.repeat(24) }, sid: 's1' };
let verifyBody = null;
const runtimeFetch = async (_s, p, init = {}) => {
  if (p.startsWith('/api/providers/')) return Response.json({ data: { authenticated: true } });
  if (p === '/api/aidev-tools/verify') { verifyBody = JSON.parse(init.body); return Response.json({ data: { verdict: 'pass', summary: 'ok', checked: [], issues: [], engine: 'codex', model: 'x' } }); }
  return Response.json({}, { status: 404 });
};
const api = createAidevApi({ store, laya: laya(2), runtimeFetch, json: (res, status, body) => { res.status = status; res.body = body; }, push: { sendToUser: async () => ({ delivered: 0 }) }, isOnline: () => false });
const call = async (method, p, body) => {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.headers = {};
  const res = {}; await api.handle(req, res, new URL(`http://gw${p}`), session); return res;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
store.db.prepare("DELETE FROM runs").run();
let res = await call('PUT', '/api/aidev/settings/verify-priority', { order: ['claude', 'codex'] });
assert.equal(res.status, 200); assert.deepEqual(res.body.verify_priority, ['claude', 'codex']);
const worker = store.addRun({ userId: uid, sessionId: 'v1', agentId: store.agent(uid, 'frontend-react').id, engine: 'claude', model: 'opus', effort: 'low', depth: 2, taskKind: 'implement' });
await call('PATCH', `/api/aidev/runs/${worker}/outcome`, { exit_code: 0 }); await settle();
assert.deepEqual(verifyBody.candidates, [{ engine: 'claude', model: 'opus', effort: 'medium' }, { engine: 'codex', model: null, effort: null }], 'order as set; claude D3 pick, codex the runtime\'s model');
console.log('PASS verifier candidates');

// ---- settings API: one provider's range in one request, preview from the same split -----------------------------------
res = await call('PUT', '/api/aidev/settings/provider-policy', { engine: 'codex', ladder: ['gpt-5.6-terra', 'gpt-5.6-sol'], floor: 'gpt-5.6-terra', ceiling: 'gpt-5.6-sol', effort_floor: 'medium', effort_cap: 'high' });
assert.equal(res.status, 200, JSON.stringify(res.body));
assert.equal(res.body.providers.codex.mode, 'split');
assert.deepEqual(res.body.providers.codex.preview.map(at), ['gpt-5.6-terra·medium', 'gpt-5.6-terra·high', 'gpt-5.6-sol·medium', 'gpt-5.6-sol·medium', 'gpt-5.6-sol·high']);
res = await call('PUT', '/api/aidev/settings/provider-policy', { engine: 'codex', floor: 'gpt-6-astra' });
assert.equal(res.status, 400);
res = await call('PUT', '/api/aidev/settings/provider-policy', { engine: 'codex', reset: true });
assert.equal(res.body.providers.codex.mode, 'tier'); assert.equal(res.body.providers.codex.preview[1].model, 'gpt-5.6-terra');
res = await call('PUT', '/api/aidev/settings/score-index', { index: 'intelligence' });
assert.equal(res.body.score_index, 'intelligence'); assert.equal(res.body.scores_source.name, 'Artificial Analysis');
res = await call('GET', '/api/aidev/model-scores');
assert.equal(res.status, 403, 'scores admin only');
console.log('PASS settings API');

// ---- Artificial Analysis sync: mapped rows get the three indexes, admin values stay -------------------------------------
const { syncModelScores } = await import('../dist/model-scores.js');
store.kvSet('aa.api_key', 'test-key');
store.setModelScoreRef('claude', 'opus', 'high', 'claude-opus-5-5-high');
store.setModelScoreRef('claude', 'opus', 'low', 'uuid-low');
store.setModelScoreManual('claude', 'sonnet', 'low', { coding: 30, intelligence: 40, agentic: 35 });
const pages = [
  { intelligence_index_version: 4.3, pagination: { has_more: true }, data: [{ id: 'x1', slug: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', evaluations: { artificial_analysis_coding_index: 51, artificial_analysis_intelligence_index: 55, artificial_analysis_agentic_index: 53 } }] },
  { intelligence_index_version: 4.3, pagination: { has_more: false }, data: [{ id: 'uuid-low', slug: 'claude-opus-5-5', name: 'Claude Opus 5.5 (Low)', evaluations: { artificial_analysis_coding_index: 44, artificial_analysis_intelligence_index: 48, artificial_analysis_agentic_index: 45 } }] },
];
let fetched = 0;
const sync = await syncModelScores(store, async (url, init) => { assert.equal(init.headers['x-api-key'], 'test-key'); return Response.json(pages[fetched++]); });
assert.equal(sync.ok, true); assert.equal(sync.matched, 2); assert.equal(sync.version, '4.3'); assert.equal(fetched, 2);
const coding = store.stepScores('claude', 'coding').scores;
assert.equal(coding.get('opus|high'), 51); assert.equal(coding.get('opus|low'), 44); assert.equal(coding.get('opus|medium'), 47.5, 'estimated between low and high');
assert.equal(coding.get('sonnet|low'), 30, 'admin value');
// a new index version: rows not synced again are not mixed in
store.kvSet('aa.index_version', '5.0');
assert.equal(store.stepScores('claude', 'coding').scores.get('opus|high'), undefined, 'old-version scores are not used');
assert.equal(store.stepScores('claude', 'coding').scores.get('sonnet|low'), 30, 'admin values stay');
const failed = await syncModelScores(store, async () => new Response('no', { status: 500 }));
assert.equal(failed.ok, false);
console.log('PASS model score sync');

console.log('provider policy: all checks passed');
