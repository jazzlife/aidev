// E-05 tier policy against a scratch DB: failing cells go up, reliable cells go down one level,
// a lowered cell that does not hold goes back, only runs at the cell's current tier count,
// admin pin/reset, and routing picks the learned tier.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-tier-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { runTierPolicy, setTierPolicy } = await import('../dist/tier-policy.js');
const { TIER_TABLE } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const react = store.agent(uid, 'frontend-react');   // domain: frontend
const db = store.agent(uid, 'database');
let clock = Date.now();
const runs = (agent, engine, depth, level, outcomes) => {
  const tier = TIER_TABLE[level][engine];
  for (const outcome of outcomes) {
    clock += 1000;
    const id = store.addRun({ userId: uid, agentId: agent.id, engine, model: tier.model, effort: tier.effort, depth });
    // successes carry a 👍 (downgrades need positive quality evidence)
    store.db.prepare('UPDATE runs SET started_at=?, finished_at=?, outcome=?, user_feedback=? WHERE id=?').run(clock, clock + 30_000, outcome, outcome === 'success' ? 'up' : null, id);
  }
};
const pass = () => { clock += 60_000; const r = runTierPolicy(store, { now: clock }); clock += 60_000; return r; };
const S = (n) => Array(n).fill('success'); const F = (n) => Array(n).fill('fail');

// 0) quality first: downgrades are off by default — a perfect cell stays on the table
const { downgradeEnabled } = await import('../dist/tier-policy.js');
assert.equal(downgradeEnabled(store), false);
runs(db, 'codex', 3, 3, S(12));
pass();
assert.equal(store.tierPolicyRow(db.domain, 3, 'codex').level, null);
console.log('PASS downgrades off by default: 12/12 at D3 stays on the table');
// without 👍 a clean record is not enough either
store.kvSet('tier_policy_downgrade', 'on');
for (let i = 0; i < 12; i++) { clock += 1000; const id = store.addRun({ userId: uid, agentId: db.id, engine: 'claude', model: TIER_TABLE[2].claude.model, effort: TIER_TABLE[2].claude.effort, depth: 2 }); store.db.prepare("UPDATE runs SET started_at=?, finished_at=?, outcome='success' WHERE id=?").run(clock, clock + 1000, id); }
pass();
assert.equal(store.tierPolicyRow(db.domain, 2, 'claude').level, null);
console.log('PASS downgrade needs 👍 on at least half of the runs');

// 1) frontend D1 claude fails often → up to D2
runs(react, 'claude', 1, 1, [...S(2), ...F(4)]);
// 2) database D2 codex is reliable → down to D1
runs(db, 'codex', 2, 2, S(10));
// runs with a user-picked model do not count
const odd = store.addRun({ userId: uid, agentId: react.id, engine: 'claude', model: 'opus', effort: 'high', depth: 1 });
store.db.prepare("UPDATE runs SET outcome='success' WHERE id=?").run(odd);
let result = pass();
const fe = store.tierPolicyRow(react.domain, 1, 'claude');
const dbCell = store.tierPolicyRow(db.domain, 2, 'codex');
assert.equal(fe.level, 2); assert.equal(fe.model, TIER_TABLE[2].claude.model); assert.equal(fe.effort, TIER_TABLE[2].claude.effort); assert.equal(fe.success_n, 0);
assert.equal(dbCell.level, 1); assert.equal(dbCell.model, TIER_TABLE[1].codex.model);
assert.equal(result.changes.length, 2);
console.log('PASS', result.changes.map((c) => `${c.domain} D${c.depth} ${c.engine}: ${c.fromModel} → ${c.toModel}`).join(' | '));

// routing reads the learned cell (end-to-end routing is covered by smoke.sh)
assert.equal(store.tierPolicy(react.domain, 1, 'claude').model, TIER_TABLE[2].claude.model);
console.log('PASS routing reads the learned cell (tierPolicy lookup)');

// 3) a second pass without new runs changes nothing (counting restarted at the change)
result = pass();
assert.equal(result.changes.length, 0);
console.log('PASS no new runs → no further change');

// 4) the lowered database cell does not hold (60% at D1) → back to D2 (table), logged
runs(db, 'codex', 2, 1, [...S(3), ...F(2)]);
result = pass();
const back = store.tierPolicyRow(db.domain, 2, 'codex');
assert.equal(back.level, null); assert.equal(back.model, null);
assert.match(result.changes[0].reason, /복귀/);
console.log('PASS lowered cell below 75% → back to table:', result.changes[0].reason);

// 5) never lower than one level below the table
runs(db, 'codex', 2, 2, S(10)); pass();
runs(db, 'codex', 2, 1, S(12)); result = pass();
assert.equal(store.tierPolicyRow(db.domain, 2, 'codex').level, 1);
assert.equal(result.changes.length, 0);
console.log('PASS floor: one level below the table');

// 6) admin pin holds against the job; reset goes back to the table
setTierPolicy(store, { domain: react.domain, depth: 1, engine: 'claude' }, 3, true, 'admin');
runs(react, 'claude', 1, 3, S(12));
pass();
const pinned = store.tierPolicyRow(react.domain, 1, 'claude');
assert.equal(pinned.level, 3); assert.equal(pinned.pinned, 1); assert.equal(pinned.success_n, 12);
setTierPolicy(store, { domain: react.domain, depth: 1, engine: 'claude' }, null, false, 'admin');
assert.equal(store.tierPolicyRow(react.domain, 1, 'claude').level, null);
const log = store.tierPolicyLog(20);
assert.ok(log.some((e) => e.actor === 'admin' && /고정/.test(e.reason)));
assert.ok(log.filter((e) => e.actor === 'auto').length >= 4);
console.log('PASS admin pin holds, reset returns to table;', log.length, 'log entries');

fs.rmSync(dir, { recursive: true, force: true });
console.log('tier policy: all checks passed');
