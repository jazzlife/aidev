// Model floor + session stickiness (2026-10-07): a chat never runs below the user's model floor
// (account or chat), a follow-up keeps the chat's specialist and depth, an architect turn is D3+,
// and an escalation plan respects the floor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-floor-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route, TIER_TABLE, ARCHITECT_MIN_DEPTH } = await import('../dist/routing.js');
const { decideNext } = await import('../dist/escalation.js');
const { MODEL_LADDER } = await import('../dist/store-aidev.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const engines = { claude: { allowed: true, authenticated: true }, codex: { allowed: true, authenticated: true } };
const claudeOnly = { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } };

const laya = ({ agent, depth, kind = 'implement', needsNew = 0.05 }) => ({
  status: {},
  predict: async (_state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'agent') answers[id] = { choice: agent, probabilities: { [agent]: 0.97 }, confidence: 0.97 };
      else if (id === 'depth') answers[id] = { score: depth };
      else if (id === 'risk') answers[id] = { score: 0 };
      else if (id === 'task_kind') answers[id] = { choice: kind, probabilities: { [kind]: 0.95 }, confidence: 0.95 };
      else if (id === 'needs_new') answers[id] = { noul: needsNew };
      else if (q.type === 'noul') answers[id] = { noul: 0.05 };
      else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 } }; }
      else answers[id] = { score: 0 };
    }
    return { answers, latency_ms: 1, device: 'mock' };
  },
});

// ---- model floor: table says D2 sonnet/high; the account floor lifts it to opus with D3's effort
assert.deepEqual(MODEL_LADDER.claude, ['haiku', 'sonnet', 'opus', 'best']);
let r = await route(store, laya({ agent: 'frontend-react', depth: 2 }), uid, claudeOnly, { text: 'React 컴포넌트 수정' });
assert.equal(r.plan.model, 'sonnet'); assert.equal(r.scope.depth, 2);
store.setModelFloor(uid, { claude: 'opus' });
r = await route(store, laya({ agent: 'frontend-react', depth: 2 }), uid, claudeOnly, { text: 'React 컴포넌트 수정' });
assert.equal(r.plan.model, 'opus', 'account floor'); assert.equal(r.plan.effort, 'high');
assert.ok(r.plan.reason.some((line) => line.includes('model floor opus/high (account)')), r.plan.reason.join(' | '));
// the floor never lowers: D4 best stays best
r = await route(store, laya({ agent: 'frontend-react', depth: 4 }), uid, claudeOnly, { text: '아키텍처 설계' });
assert.equal(r.plan.model, 'best');
// an explicit user model still wins (sonnet below the floor)
r = await route(store, laya({ agent: 'frontend-react', depth: 2 }), uid, claudeOnly, { text: 'React 컴포넌트 수정', model: 'sonnet' });
assert.equal(r.plan.model, 'sonnet');
// invalid floors are rejected; "" clears
assert.throws(() => store.setModelFloor(uid, { claude: 'gpt-9' }), /model must be one of/);
store.setModelFloor(uid, { claude: '' });
assert.deepEqual(store.modelFloor(uid), {});
r = await route(store, laya({ agent: 'frontend-react', depth: 2 }), uid, claudeOnly, { text: 'React 컴포넌트 수정' });
assert.equal(r.plan.model, 'sonnet', 'floor cleared');

// ---- chat floor over the account: inline for a new chat, stored for a known one; effort cap still applies
r = await route(store, laya({ agent: 'frontend-react', depth: 1 }), uid, claudeOnly, { text: '버튼 색 바꿔', modelFloor: { claude: 'best' } });
assert.equal(r.plan.model, 'best'); assert.equal(r.plan.effort, 'xhigh', 'D4 effort rides along, cap xhigh');
assert.ok(r.plan.reason.some((line) => line.includes('(this chat)')));
store.setSessionModelFloor(uid, 'sess-floor', { claude: 'opus' });
assert.deepEqual(store.effectiveModelFloor(uid, 'sess-floor').floor, { claude: 'opus' });
store.setEffortCap(uid, { claude: 'medium' });
r = await route(store, laya({ agent: 'frontend-react', depth: 1 }), uid, claudeOnly, { text: '버튼 색 바꿔', sessionId: 'sess-floor', sessionEngine: 'claude' });
assert.equal(r.plan.model, 'opus'); assert.equal(r.plan.effort, 'medium', 'ceiling lowers the effort, not the model');
store.setEffortCap(uid, { claude: 'xhigh' });
store.setSessionModelFloor(uid, 'sess-floor', null);
assert.equal(store.sessionModelFloor(uid, 'sess-floor'), null);

// ---- session stickiness: a D3 ai-integration chat; "진행해" scored D1 generalist keeps agent and depth
const sid = 'sess-sticky';
const agentRow = store.agent(uid, 'ai-integration');
store.addRun({ userId: uid, sessionId: sid, agentId: agentRow.id, engine: 'claude', model: 'opus', effort: 'high', depth: 3 });
r = await route(store, laya({ agent: 'generalist', depth: 1, kind: 'explain' }), uid, claudeOnly, { text: '진행해', sessionId: sid, sessionEngine: 'claude' });
assert.equal(r.agent.name, 'ai-integration', 'follow-up keeps the chat agent'); assert.equal(r.decision, 'use');
assert.equal(r.scope.depth, 3, 'never below the chat depth'); assert.equal(r.plan.model, 'opus');
assert.ok(r.plan.reason.some((line) => line.includes('session agent ai-integration kept')));
// a confident judge naming another specialist may switch
const judge = async () => ({ agent: 'frontend-react', fit: 0.9, reason: 'React UI', new: null, question: null, source: 'llm' });
r = await route(store, laya({ agent: 'frontend-react', depth: 2 }), uid, claudeOnly, { text: 'React 화면 만들어' , sessionId: sid, sessionEngine: 'claude' }, { judge });
assert.equal(r.agent.name, 'frontend-react');
// the judge proposing a brand-new agent inside the chat does not start creation
const creator = async () => ({ agent: null, fit: 0, reason: 'none', new: { name: 'game-loop-player', domain: 'games', description: 'x', technologies: ['d3d'] }, question: null, source: 'llm' });
r = await route(store, laya({ agent: 'generalist', depth: 2, needsNew: 0.9 }), uid, claudeOnly, { text: '너 게임루프가 뭔지 모르는구나?', sessionId: sid, sessionEngine: 'claude' }, { judge: creator });
assert.equal(r.decision, 'use'); assert.equal(r.agent.name, 'ai-integration'); assert.equal(r.create, null);
// a chat that started on the generalist may still move to a specialist (judge or ranker)
const gsid = 'sess-general';
store.addRun({ userId: uid, sessionId: gsid, agentId: store.agent(uid, 'generalist').id, engine: 'claude', model: 'sonnet', effort: 'medium', depth: 1 });
r = await route(store, laya({ agent: 'database', depth: 2 }), uid, claudeOnly, { text: '인덱스 설계', sessionId: gsid, sessionEngine: 'claude' });
assert.equal(r.agent.name, 'database');
// a forced agent (app re-send / user pick) bypasses the stickiness
r = await route(store, laya({ agent: 'generalist', depth: 1 }), uid, claudeOnly, { text: '진행해', sessionId: sid, sessionEngine: 'claude', forceAgent: 'frontend-react' });
assert.equal(r.agent.name, 'frontend-react');

// ---- architect turn: a new specialist is designed at D3 or deeper
assert.equal(ARCHITECT_MIN_DEPTH, 3);
r = await route(store, laya({ agent: 'generalist', depth: 2, needsNew: 0.9 }), uid, claudeOnly, { text: 'Unity 셰이더로 물 표면 굴절 효과를 구현해줘' }, { judge: creator });
assert.equal(r.decision, 'create'); assert.equal(r.scope.depth, 3, `architect depth ${r.scope.depth}`); assert.equal(r.plan.model, 'opus');
assert.ok(r.plan.reason.some((line) => line.includes('agent design ≥ D3')));
// quick work still runs on the generalist now and queues the domain (no D3 for that)
r = await route(store, laya({ agent: 'generalist', depth: 1, needsNew: 0.9 }), uid, claudeOnly, { text: 'Unity 노드 이름 바꿔' }, { judge: creator });
assert.equal(r.decision, 'create_background'); assert.ok(r.scope.depth <= 2);

// ---- escalation plan respects the floor
store.setModelFloor(uid, { claude: 'opus' });
const failed = (() => { const id = store.addRun({ userId: uid, sessionId: 'sess-esc', agentId: agentRow.id, engine: 'claude', model: 'sonnet', effort: 'medium', depth: 1 }); store.updateRun(uid, id, { exitCode: 1, outcome: 'fail' }); return store.run(uid, id); })();
const offline = { predict: async () => { throw new Error('offline'); } };
let next = await decideNext(store, offline, failed, engines);
assert.equal(next.action, 'escalate_tier'); assert.equal(next.model, 'opus', `D2 plan lifted to the floor: ${next.model}`); assert.equal(next.effort, 'high');
store.setModelFloor(uid, { claude: '' });
next = await decideNext(store, offline, failed, engines);
assert.equal(next.model, TIER_TABLE[2].claude.model);

// ---- verification storage round-trip
const vid = store.addRun({ userId: uid, sessionId: 'sess-v', agentId: agentRow.id, engine: 'claude', model: 'opus', effort: 'high', depth: 3 });
store.setRunVerification(uid, vid, { verdict: 'fail', summary: 's', checked: [], issues: ['i'], engine: 'claude', model: 'opus', at: 1 });
assert.equal(JSON.parse(store.run(uid, vid).verification).verdict, 'fail');
assert.equal(store.lastRunForSession(uid, 'sess-v').agent_name, 'ai-integration');

store.db.close();
console.log('model-floor-test: PASS');
