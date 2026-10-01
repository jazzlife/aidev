// C-06 notify.level: runtime events → Laya 0 quiet / 1 badge / 2 push (fallback 1); approval always pushes;
// an open app caps it at a badge; badges are per session until seen.
//   node test/notify-test.mjs   (after npm run build)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-notify-'));
const { openStore } = await import('../dist/store.js');
const { createNotifier, describeEvent } = await import('../dist/notify.js');
const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;

let score = 2; let layaDown = false; let online = false;
const laya = { status: {}, predict: async () => { if (layaDown) throw new Error('laya down'); return { answers: { q: { score, confidence: 0.8 } }, latency_ms: 1, device: 'mock' }; } };
const pushed = [];
const push = { sendToUser: async (userId, payload) => { pushed.push({ userId, ...payload }); return { subscriptions: 1, delivered: 1 }; } };
const notifier = createNotifier({ store, laya, push, isOnline: () => online });
const ev = (code, sessionId = 's1', detail = null) => ({ code, sessionId, sessionName: '로그인 버그', provider: 'claude', detail });

let r = await notifier.handle(uid, ev('run.stopped', 's1', 'completed'));
assert.equal(r.level, 2); assert.equal(pushed.length, 1);
assert.equal(pushed[0].url, '/m/session/s1'); assert.equal(pushed[0].title, '로그인 버그'); assert.equal(pushed[0].body, 'Claude: 작업이 끝났습니다');
assert.deepEqual(store.unread(uid).map((u) => [u.session_id, u.level]), [['s1', 2]]);
console.log('PASS Laya 2, app closed → push to the session + badge');

online = true;
r = await notifier.handle(uid, ev('run.failed', 's2', 'exit 1'));
assert.equal(r.level, 1); assert.equal(pushed.length, 1, 'no push while an app is open');
assert.ok(store.unread(uid).some((u) => u.session_id === 's2' && u.level === 1));
console.log('PASS an open app caps it at a badge');

online = false; score = 0;
r = await notifier.handle(uid, ev('run.background_completed', 's3'));
assert.equal(r.level, 0); assert.ok(!store.unread(uid).some((u) => u.session_id === 's3')); assert.equal(pushed.length, 1);
r = await notifier.handle(uid, ev('permission.required', 's3', 'Bash'));
assert.equal(r.level, 2); assert.equal(pushed.length, 2); assert.equal(pushed[1].body, 'Claude: 승인이 필요합니다 (Bash)');
console.log('PASS Laya 0 stays quiet; an approval request always pushes');

layaDown = true;
r = await notifier.handle(uid, ev('run.stopped', 's4', 'completed'));
assert.equal(r.fallback, true); assert.equal(r.level, 1); assert.equal(pushed.length, 2);
const logged = store.db.prepare("SELECT COUNT(*) AS n FROM decision_log WHERE kind='notify.level'").get().n;
assert.equal(logged, 5, 'every event is a logged notify.level decision');
console.log('PASS Laya down → badge (fallback 1); every decision logged');

// a badge never drops while unread; seen clears one session or all
score = 1; layaDown = false;
await notifier.handle(uid, ev('run.stopped', 's1', 'completed'));
assert.equal(store.unread(uid).find((u) => u.session_id === 's1').level, 2);
assert.equal(store.markSeen(uid, 's1'), 1); assert.ok(!store.unread(uid).some((u) => u.session_id === 's1'));
assert.ok(store.markSeen(uid, null) >= 2); assert.equal(store.unread(uid).length, 0);
assert.equal(describeEvent({ code: 'run.stopped', detail: 'interrupted', provider: 'codex' }), 'Codex: 실행이 멈췄습니다 (interrupted)');
console.log('PASS badges keep their highest level until seen; seen clears one or all');

fs.rmSync(dir, { recursive: true, force: true });
console.log('notify: all checks passed');
