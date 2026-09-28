// Quality-first depth (§3.4): in-between scores round up from .35, task-kind and specialist floors
// raise the depth, an agent-pinned model never weakens a run, Laya down → D2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-floors-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route, KIND_MIN_DEPTH, modelRank } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const engines = { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } };

/** Laya stand-in: fixed agent, depth score and task kind. */
const laya = ({ agent, depth, kind }) => ({
  status: {},
  predict: async (_state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'agent') answers[id] = { choice: agent, probabilities: { [agent]: 0.97 }, confidence: 0.97 };
      else if (id === 'depth') answers[id] = { score: depth };
      else if (id === 'risk') answers[id] = { score: 0 };
      else if (id === 'task_kind') answers[id] = { choice: kind, probabilities: { [kind]: 0.95 }, confidence: 0.95 };
      else if (q.type === 'noul') answers[id] = { noul: 0.05 };
      else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 } }; }
      else answers[id] = { score: 0 };
    }
    return { answers, latency_ms: 1, device: 'mock' };
  },
});
const go = (l, text = 'React 컴포넌트 수정') => route(store, l, uid, engines, { text });

let r = await go(laya({ agent: 'frontend-react', depth: 1.4, kind: 'implement' }));
assert.equal(r.scope.depth, 2, `1.4 → ${r.scope.depth}`); assert.equal(r.plan.model, 'sonnet'); assert.equal(r.plan.effort, 'high');
r = await go(laya({ agent: 'frontend-react', depth: 1.3, kind: 'implement' }));
assert.equal(r.scope.depth, 1);
console.log('PASS depth 1.4 → D2 (rounds up from .35), 1.3 → D1');

r = await go(laya({ agent: 'frontend-react', depth: 0.2, kind: 'debug' }));
assert.equal(r.scope.depth, KIND_MIN_DEPTH.debug); assert.match(r.plan.reason.join('\n'), /debug ≥ D2/);
r = await go(laya({ agent: 'frontend-react', depth: 0.1, kind: 'explain' }));
assert.equal(r.scope.depth, 0); assert.equal(r.plan.model, 'haiku');
console.log('PASS task-kind floor: short debug command runs at D2; a pure explanation may stay at D0');

r = await go(laya({ agent: 'security-review', depth: 0.3, kind: 'explain' }), '이 로그인 코드 보안 점검해줘');
assert.equal(r.agent.name, 'security-review'); assert.equal(r.scope.depth, 3); assert.equal(r.plan.model, 'opus');
console.log('PASS specialist floor: security-review runs at D3 (opus) however short the command');

// agent-pinned model: never weaker than the tier
const react = store.agent(uid, 'frontend-react');
store.db.prepare("UPDATE agents SET model='haiku' WHERE id=?").run(react.id);
r = await go(laya({ agent: 'frontend-react', depth: 2, kind: 'implement' }));
assert.equal(r.plan.model, 'sonnet'); assert.match(r.plan.reason.join('\n'), /haiku ignored/);
store.db.prepare("UPDATE agents SET model='opus' WHERE id=?").run(react.id);
r = await go(laya({ agent: 'frontend-react', depth: 1, kind: 'implement' }));
assert.equal(r.plan.model, 'opus');
store.db.prepare('UPDATE agents SET model=NULL WHERE id=?').run(react.id);
assert.equal(modelRank('claude', 'fable'), 4); assert.equal(modelRank('codex', 'gpt-5.6-sol'), 3);
console.log('PASS agent-pinned model only raises (haiku ignored at D2, opus applied at D1)');

// admin-set floor on an agent
store.setAgentMinTier(react.id, 3);
r = await go(laya({ agent: 'frontend-react', depth: 0.5, kind: 'implement' }));
assert.equal(r.scope.depth, 3);
store.setAgentMinTier(react.id, null);
assert.throws(() => store.setAgentMinTier(react.id, 7), /min_tier/);
console.log('PASS agent min_tier set/cleared/validated');

r = await go({ status: {}, predict: async () => { throw new Error('offline'); } });
assert.equal(r.scope.depth, 2);
console.log('PASS Laya down → D2');

fs.rmSync(dir, { recursive: true, force: true });
console.log('routing floors: all checks passed');
