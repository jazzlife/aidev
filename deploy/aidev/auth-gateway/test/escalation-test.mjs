// E-03 escalation rules against a scratch DB: Laya's pick is kept executable (top tier → other
// engine, no other engine → stronger model / ask), signed-out engines hand off, chains stop at 2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-escalation-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { decideNext } = await import('../dist/escalation.js');
const { TIER_TABLE } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const agent = store.agent(uid, 'frontend-react');

/** Laya stand-in answering one fixed choice (null → unavailable, so the fallback path runs). */
const laya = (choice) => ({ predict: async () => { if (!choice) throw new Error('offline'); return { answers: { q: { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } } } }; } });
const both = { claude: { allowed: true, authenticated: true }, codex: { allowed: true, authenticated: true } };
const claudeOnly = { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } };
const run = (engine, depth, from = null) => {
  const tier = TIER_TABLE[depth][engine];
  const id = store.addRun({ userId: uid, agentId: agent.id, engine, model: tier.model, effort: tier.effort, depth, escalatedFromRun: from });
  store.updateRun(uid, id, { exitCode: 1, outcome: 'fail' });
  return store.run(uid, id);
};

let next = await decideNext(store, laya('escalate_tier'), run('claude', 1), both);
assert.equal(next.action, 'escalate_tier'); assert.equal(next.engine, 'claude'); assert.equal(next.depth, 2); assert.equal(next.model, TIER_TABLE[2].claude.model);
console.log('PASS escalate_tier D1 → D2', next.model, next.effort);

next = await decideNext(store, laya('retry_same'), run('codex', 2), both);
assert.equal(next.action, 'retry_same'); assert.equal(next.engine, 'codex'); assert.equal(next.model, TIER_TABLE[2].codex.model);
console.log('PASS retry_same keeps engine/model');

next = await decideNext(store, laya('escalate_tier'), run('claude', 4), both);
assert.equal(next.action, 'switch_engine'); assert.equal(next.engine, 'codex'); assert.equal(next.model, TIER_TABLE[4].codex.model);
console.log('PASS top tier → other engine', next.model);

next = await decideNext(store, laya('escalate_tier'), run('claude', 4), claudeOnly);
assert.equal(next.action, 'ask_user'); assert.equal(next.model, null);
console.log('PASS top tier with no other engine → ask_user');

next = await decideNext(store, laya('switch_engine'), run('claude', 1), claudeOnly);
assert.equal(next.action, 'escalate_tier'); assert.equal(next.depth, 2);
console.log('PASS switch_engine without another engine → escalate_tier');

next = await decideNext(store, laya(null), run('codex', 3), both);
assert.equal(next.action, 'escalate_tier'); assert.equal(next.depth, 4); assert.equal(next.model, TIER_TABLE[4].codex.model);
console.log('PASS Laya offline → stronger model');

const signedOut = { claude: { allowed: true, authenticated: false }, codex: { allowed: true, authenticated: true } };
next = await decideNext(store, laya('retry_same'), run('claude', 2), signedOut);
assert.equal(next.action, 'switch_engine'); assert.equal(next.engine, 'codex');
console.log('PASS signed-out engine → handoff to', next.engine);

const first = run('claude', 1); const second = run('claude', 2, first.id); const third = run('claude', 3, second.id);
next = await decideNext(store, laya('escalate_tier'), second, both);
assert.equal(next.chain, 1); assert.equal(next.action, 'escalate_tier');
next = await decideNext(store, laya('escalate_tier'), third, both);
assert.equal(next.chain, 2); assert.equal(next.action, 'ask_user');
console.log('PASS chain of 2 escalations → ask_user');

fs.rmSync(dir, { recursive: true, force: true });
console.log('escalation: all checks passed');
