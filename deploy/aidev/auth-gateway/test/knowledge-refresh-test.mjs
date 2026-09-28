// E-04 knowledge refresh against a scratch DB: how each check result is applied, review proposals,
// due selection, owner scoping, and a scheduled pass through a stand-in runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-knowledge-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { applyCheck, decideProposal, createKnowledgeRefresher } = await import('../dist/knowledge-refresh.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
await store.add('bob', 'pw1234pw', 'u' + 'b'.repeat(24), 1);
store.setRole('alice', 'admin');
const alice = store.account('alice'); const bob = store.account('bob');
const agent = store.agent(alice.id, 'frontend-react');
const laya = (p) => ({ predict: async () => { if (p === null) throw new Error('offline'); return { answers: { q: { noul: p } } }; } });
const past = Date.now() - 1000;
const item = (title, owner, extra = {}) => store.knowledgeById(store.addKnowledge({ agentId: agent.id, title, body: `${title} body text long enough`, sourceUrl: 'https://react.dev/x', sourceDate: '2025-01-01', ownerId: owner, expiresAt: past, ...extra }));
const rep = { title: 'React 20 hooks', body: 'useEffectEvent is stable in React 20.', source_url: 'https://react.dev/y', source_date: '2026-09-01' };

// current → another TTL
let k = item('React 19 hooks', alice.id);
let r = await applyCheck(store, laya(0.5), k, { status: 'current', summary: 'still valid', replacement: null }, alice.id);
k = store.knowledgeById(k.id);
assert.equal(r.outcome, 'current'); assert.ok(k.expires_at > Date.now() + 80 * 86400_000); assert.ok(k.checked_at);
console.log('PASS current → valid another 90 days');

// unreachable ×3 → unverified (no longer injected)
k = item('Old blog post', alice.id);
for (let i = 1; i <= 3; i++) { r = await applyCheck(store, laya(0.5), store.knowledgeById(k.id), { status: 'unreachable', summary: '404', replacement: null }, alice.id); }
k = store.knowledgeById(k.id);
assert.equal(r.outcome, 'unverified'); assert.equal(k.status, 'unverified'); assert.equal(k.check_fails, 3);
assert.ok(!store.knowledge(agent.id, undefined, alice.id).some((x) => x.id === k.id), 'unverified items are not injected');
console.log('PASS unreachable 3× → unverified, dropped from injection');

// changed + Laya sure → superseded by a new sourced item
k = item('React 19 compiler', alice.id);
r = await applyCheck(store, laya(0.9), k, { status: 'changed', summary: 'API renamed', replacement: rep }, alice.id);
assert.equal(r.outcome, 'superseded');
const fresh = store.knowledgeById(r.newId);
assert.equal(store.knowledgeById(k.id).status, 'superseded'); assert.equal(store.knowledgeById(k.id).superseded_by, r.newId);
assert.equal(fresh.status, 'sourced'); assert.equal(fresh.owner_id, alice.id); assert.equal(fresh.source_date, '2026-09-01');
console.log('PASS changed (Laya 0.9) → new item, old superseded');

// changed + Laya says minor → kept
k = item('React 19 suspense', alice.id);
r = await applyCheck(store, laya(0.1), k, { status: 'changed', summary: 'typo fixed', replacement: rep }, alice.id);
assert.equal(r.outcome, 'kept'); assert.equal(store.knowledgeById(k.id).status, 'sourced');
console.log('PASS changed (Laya 0.1) → kept');

// changed + Laya unsure / offline → proposal; the item is not due again while it waits
k = item('React 19 actions', alice.id);
r = await applyCheck(store, laya(null), k, { status: 'changed', summary: 'new API', replacement: rep }, alice.id);
assert.equal(r.outcome, 'proposed');
assert.equal(store.knowledgeById(r.newId).status, 'proposed'); assert.equal(store.knowledgeById(r.newId).replaces, k.id);
assert.ok(!store.dueKnowledge(50, alice.id).some((x) => x.id === k.id), 'item with a pending proposal is not due');
assert.equal(store.knowledgeProposals(alice.id, false).length, 1);
decideProposal(store, r.newId, true);
assert.equal(store.knowledgeById(r.newId).status, 'sourced'); assert.equal(store.knowledgeById(k.id).status, 'superseded');
console.log('PASS Laya offline → proposal → accepted');

k = item('React 19 forms', alice.id);
r = await applyCheck(store, laya(0.5), k, { status: 'changed', summary: 'maybe', replacement: rep }, alice.id);
decideProposal(store, r.newId, false);
assert.equal(store.knowledgeById(r.newId), undefined); assert.equal(store.knowledgeById(k.id).status, 'sourced'); assert.ok(store.knowledgeById(k.id).expires_at > Date.now());
console.log('PASS proposal rejected → removed, original kept');

// owner scoping: bob never sees alice's private items on a global agent
const bobs = store.knowledge(agent.id, ['verified', 'sourced', 'unverified', 'proposed'], bob.id);
assert.ok(bobs.every((x) => x.owner_id === null || x.owner_id === bob.id));
assert.equal(store.searchKnowledge('React', agent.id, bob.id).length, 0);
assert.ok(store.searchKnowledge('React', agent.id, alice.id).length > 0);
console.log('PASS knowledge is scoped to its owner');

// scheduled pass: global items run on the admin's runtime, private ones on the owner's
const g = item('Global Vite note', null); const b1 = item('Bob private note', bob.id);
const calls = [];
const refresher = createKnowledgeRefresher({
  store, laya: laya(0.9),
  engines: async () => ({ claude: { allowed: true, authenticated: true }, codex: { allowed: true, authenticated: false } }),
  runtimeFetch: async (account, p, init) => { const body = JSON.parse(init.body); calls.push({ user: account.username, title: body.title, engine: body.engine, hasPrompt: Boolean(body.prompt) }); return new Response(JSON.stringify({ success: true, data: { status: 'current', summary: 'ok', replacement: null } }), { status: 200 }); },
  notify: async () => undefined,
});
await refresher.runScheduled(10);
assert.ok(calls.some((c) => c.user === 'alice' && c.title === 'Global Vite note'));
assert.ok(calls.some((c) => c.user === 'bob' && c.title === 'Bob private note'));
assert.ok(calls.every((c) => c.engine === 'claude' && c.hasPrompt));
assert.equal(store.knowledgeById(g.id).check_fails, 0); assert.ok(store.knowledgeById(b1.id).expires_at > Date.now());
assert.ok(Number(store.kvGet('knowledge_refresh_at')) > 0);
assert.equal(store.dueKnowledge(50).length, 0);
console.log('PASS scheduled pass: global → admin runtime, private → owner runtime,', calls.length, 'checks');

fs.rmSync(dir, { recursive: true, force: true });
console.log('knowledge refresh: all checks passed');
