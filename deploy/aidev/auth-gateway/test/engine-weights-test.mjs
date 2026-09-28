// E-06 engine weight learning against a scratch DB: smoothing toward the prior, a few runs barely
// move it, many runs do, speed tie-break, pinned weights stay, admin edit becomes the prior, log.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-weights-'));
const { openStore } = await import('../dist/store.js');
const { runEngineWeights } = await import('../dist/engine-weights.js');
const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
let clock = Date.now() - 3600_000;
const runs = (kind, engine, outcomes, ms = 60_000) => { for (const outcome of outcomes) { clock += 1000; const id = store.addRun({ userId: uid, engine, model: 'x', effort: 'low', depth: 1, taskKind: kind }); store.db.prepare('UPDATE runs SET started_at=?, finished_at=?, outcome=? WHERE id=?').run(clock, clock + ms, outcome, id); } };
const w = (kind, engine) => store.engineWeightRows().find((r) => r.task_kind === kind && r.engine === engine);
const S = (n) => Array(n).fill('success'); const F = (n) => Array(n).fill('fail');

assert.equal(w('bulk_read', 'codex').weight, 0.7); assert.equal(w('bulk_read', 'codex').prior, 0.7);
console.log('PASS seed weights carry their prior');

// two failures barely move a neutral weight; 20 runs move it clearly
runs('debug', 'claude', F(2));
runEngineWeights(store);
assert.ok(Math.abs(w('debug', 'claude').weight - 0.417) < 0.01, `2 fails: ${w('debug', 'claude').weight}`);
runs('debug', 'codex', S(18)); runs('debug', 'codex', F(2));
let result = runEngineWeights(store);
assert.ok(w('debug', 'codex').weight > 0.75, `18/20: ${w('debug', 'codex').weight}`);
assert.equal(w('debug', 'codex').success_n, 18);
assert.ok(result.changes.some((c) => c.taskKind === 'debug' && c.engine === 'codex'));
console.log('PASS smoothing: 2 fails →', w('debug', 'claude').weight, '| 18/20 →', w('debug', 'codex').weight);

// similar success, codex ≥20% faster → +0.05 for codex
runs('implement', 'claude', S(8), 120_000); runs('implement', 'claude', F(2), 120_000);
runs('implement', 'codex', S(8), 60_000); runs('implement', 'codex', F(2), 60_000);
runEngineWeights(store);
const diff = w('implement', 'codex').weight - w('implement', 'claude').weight;
assert.ok(Math.abs(diff - 0.05) < 0.002, `speed bonus ${diff}`);
console.log('PASS speed tie-break: faster engine +', diff.toFixed(3));

// admin edit: pinned stays, prior follows the admin value
store.setEngineWeight('design', 'claude', 0.8, { pinned: true, actor: 'admin' });
runs('design', 'claude', F(10));
runEngineWeights(store);
assert.equal(w('design', 'claude').weight, 0.8); assert.equal(w('design', 'claude').fail_n, 10); assert.equal(w('design', 'claude').pinned, 1);
store.setEngineWeight('design', 'claude', 0.8, { actor: 'admin' });
runEngineWeights(store);
assert.ok(w('design', 'claude').weight < 0.5, `unpinned, prior 0.8, 0/10 → ${w('design', 'claude').weight}`);
const log = store.engineWeightLog(50);
assert.ok(log.some((e) => e.actor === 'admin') && log.some((e) => e.actor === 'auto'));
assert.deepEqual(store.engineWeights().design.claude, w('design', 'claude').weight);
console.log('PASS pin holds, admin value becomes the prior;', log.length, 'log entries');

fs.rmSync(dir, { recursive: true, force: true });
console.log('engine weights: all checks passed');
