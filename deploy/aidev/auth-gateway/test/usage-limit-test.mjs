// Usage-limit refusals (2026-10-09): recorded on the run with the reset time, they are not engine errors
// (no routing penalty, no tier statistics), routing skips the engine only while the window is in force,
// and escalation of such a run hands off to the other engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-limit-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route } = await import('../dist/routing.js');
const { decideNext } = await import('../dist/escalation.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const agent = store.agent(uid, 'frontend-react');
const now = Date.now();

// a refused run: remembered with its reset time; not counted as an engine error nor as policy input
const refused = store.addRun({ userId: uid, agentId: agent.id, engine: 'claude', model: 'opus', effort: 'high', depth: 3 });
store.updateRun(uid, refused, { exitCode: 1, outcome: 'fail', usageLimitResetsAt: now + 30 * 60_000 });
assert.equal(store.recentEngineErrors(uid, 'claude', 3600_000), 0, 'a limit is not an engine error');
assert.equal(store.engineLimitedUntil(uid, 'claude', now), now + 30 * 60_000);
assert.equal(store.policyRuns(0).some((run) => run.engine === 'claude'), false, 'a limit is not tier evidence');
// a real failure still counts
const broke = store.addRun({ userId: uid, agentId: agent.id, engine: 'codex', model: 'gpt-5.6-sol', effort: 'high', depth: 3 });
store.updateRun(uid, broke, { exitCode: 1, outcome: 'fail' });
assert.equal(store.recentEngineErrors(uid, 'codex', 3600_000), 1);
// an unknown reset time holds for five hours; a past window is over
assert.equal(store.engineLimitedUntil(uid, 'claude', now + 31 * 60_000), null, 'window over');
const unknown = store.addRun({ userId: uid, agentId: agent.id, engine: 'claude', model: 'opus', effort: 'high', depth: 3 });
store.updateRun(uid, unknown, { exitCode: 1, outcome: 'fail', usageLimitResetsAt: 0 });
assert.ok(store.engineLimitedUntil(uid, 'claude', now) > now + 4 * 3600_000);
assert.equal(store.engineLimitedUntil(uid, 'claude', now + 6 * 3600_000), null);

// routing: the limited engine is skipped while the window is in force, with the reason named; no penalty after
const laya = { status: {}, predict: async (_s, questions) => { const answers = {}; for (const [id, q] of Object.entries(questions)) { if (id === 'agent') answers[id] = { choice: 'frontend-react', probabilities: { 'frontend-react': 0.97 }, confidence: 0.97 }; else if (id === 'depth') answers[id] = { score: 2 }; else if (id === 'task_kind') answers[id] = { choice: 'implement', probabilities: { implement: 0.95 }, confidence: 0.95 }; else if (q.type === 'noul') answers[id] = { noul: 0.05 }; else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 } }; } else answers[id] = { score: 0 }; } return { answers, latency_ms: 1, device: 'mock' }; } };
const both = (limitedUntil) => ({ claude: { allowed: true, authenticated: true, limited_until: limitedUntil }, codex: { allowed: true, authenticated: true, limited_until: null } });
let r = await route(store, laya, uid, both(now + 30 * 60_000), { text: 'React 컴포넌트 수정' });
assert.equal(r.plan.engine, 'codex', 'limited claude skipped');
assert.ok(r.engines.claude.notes.some((note) => note.startsWith('usage limit until')), r.engines.claude.notes.join(' | '));
r = await route(store, laya, uid, both(null), { text: 'React 컴포넌트 수정' });
assert.equal(r.plan.engine, 'claude', `after the window claude routes again (${r.plan.reason.join(' | ')})`);
assert.ok(!r.engines.claude.notes.some((note) => note.includes('recent failures')), 'no penalty from the refusal');

// escalation of a limit-refused run: the other engine, at once
const offline = { predict: async () => { throw new Error('offline'); } };
let next = await decideNext(store, offline, store.run(uid, refused), { claude: { allowed: true, authenticated: true }, codex: { allowed: true, authenticated: true } });
assert.equal(next.action, 'switch_engine'); assert.equal(next.engine, 'codex'); assert.match(next.reason, /한도/);
next = await decideNext(store, offline, store.run(uid, refused), { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } });
assert.equal(next.action, 'ask_user'); assert.match(next.reason, /한도/);

store.db.close();
console.log('usage-limit-test: PASS');
