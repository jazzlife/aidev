// Engine priority (2026-10-09): the user's order beats the learned weights; a limited engine is skipped and the
// next taken; a chat bound to a lower engine is asked to move back once the higher one is usable — unless pinned.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-priority-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const laya = { status: {}, predict: async (_s, questions) => { const answers = {}; for (const [id, q] of Object.entries(questions)) { if (id === 'agent') answers[id] = { choice: 'devops', probabilities: { devops: 0.97 }, confidence: 0.97 }; else if (id === 'depth') answers[id] = { score: 2 }; else if (id === 'task_kind') answers[id] = { choice: 'ops', probabilities: { ops: 0.95 }, confidence: 0.95 }; else if (q.type === 'noul') answers[id] = { noul: 0.05 }; else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 } }; } else answers[id] = { score: 0 }; } return { answers, latency_ms: 1, device: 'mock' }; } };
const both = (claudeLimited = null) => ({ claude: { allowed: true, authenticated: true, limited_until: claudeLimited }, codex: { allowed: true, authenticated: true, limited_until: null } });
const soon = Date.now() + 3600_000;

// learned ops weight favours codex; no priority → codex
store.setEngineWeight('ops', 'codex', 0.9, { pinned: true, actor: 'test' }); store.setEngineWeight('ops', 'claude', 0.1, { pinned: true, actor: 'test' });
let r = await route(store, laya, uid, both(), { text: '배포 스크립트 점검' });
assert.equal(r.plan.engine, 'codex');

// priority claude > codex wins over the weights; a limited claude is skipped; back to claude after
assert.deepEqual(store.setEnginePriority(uid, ['claude', 'codex']), ['claude', 'codex']);
r = await route(store, laya, uid, both(), { text: '배포 스크립트 점검' });
assert.equal(r.plan.engine, 'claude'); assert.ok(r.plan.reason.some((line) => line.startsWith('engine priority claude > codex → claude')), r.plan.reason.join(' | '));
r = await route(store, laya, uid, both(soon), { text: '배포 스크립트 점검' });
assert.equal(r.plan.engine, 'codex', 'limited claude skipped');
// a manual preference still wins
r = await route(store, laya, uid, both(), { text: '배포 스크립트 점검', preferEngine: 'codex' });
assert.equal(r.plan.engine, 'codex');

// a chat bound to codex is asked to move back to claude once claude is usable; not while limited; never when pinned
r = await route(store, laya, uid, both(soon), { text: '이어서', sessionId: 'codex-chat', sessionEngine: 'codex' });
assert.equal(r.plan.engine, 'codex'); assert.equal(r.plan.switch_back, null);
r = await route(store, laya, uid, both(), { text: '이어서', sessionId: 'codex-chat', sessionEngine: 'codex' });
assert.equal(r.plan.engine, 'codex', 'the bound engine still runs this send if the app does not move');
assert.equal(r.plan.switch_back?.engine, 'claude', JSON.stringify(r.plan));
assert.equal(r.plan.engine_pinned, false);
store.setSessionPinnedEngine(uid, 'codex-chat', 'codex');
r = await route(store, laya, uid, both(), { text: '이어서', sessionId: 'codex-chat', sessionEngine: 'codex' });
assert.equal(r.plan.switch_back, null, 'pinned chats stay'); assert.equal(r.plan.engine_pinned, true);
store.setSessionPinnedEngine(uid, 'codex-chat', null);
assert.equal(store.sessionPinnedEngine(uid, 'codex-chat'), null);
// a chat already on the top engine is never asked to move
r = await route(store, laya, uid, both(), { text: '이어서', sessionId: 'claude-chat', sessionEngine: 'claude' });
assert.equal(r.plan.switch_back, null);
// clearing the priority returns to the weights
store.setEnginePriority(uid, null);
assert.deepEqual(store.enginePriority(uid), []);
r = await route(store, laya, uid, both(), { text: '배포 스크립트 점검' });
assert.equal(r.plan.engine, 'codex');
assert.throws(() => store.setEnginePriority(uid, ['gemini']), /engines must be among/);

store.db.close();
console.log('engine-priority-test: PASS');
