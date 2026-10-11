// A PC shared between accounts (2026-10-11): access (own / shared / owner disabled / share taken back), one runner
// stream per window whatever quality each viewer asked for (the holder's quality wins), and the control lock — one
// person controls at a time, the others ask, the holder hands over or lets go, the owner takes it back, and only the
// holder's input reaches the PC (gateway path and direct channel). A mock runner; no real PC.
//   npm run build && node test/screen-control-test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-screen-control-'));
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken, screenOpts } = await import('../dist/runner-hub.js');
const { createAidevApi } = await import('../dist/aidev-api.js');

// ---- accounts and sharing
const store = openStore(path.join(dir, 'auth.db'));
for (const name of ['alice', 'bob', 'carol', 'dave']) await store.add(name, 'pw1234pw', `rt-${name}`, 1);
const id = (name) => store.account(name).id;
const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map(id);
const tid = store.addTarget({ userId: alice, name: 'box', platform: 'linux', pairingCode: 'BOX', pairingExpires: Date.now() + 60000 });
store.addTarget({ userId: bob, name: 'box', platform: 'linux', pairingCode: 'BOB', pairingExpires: Date.now() + 60000 });   // bob's own "box"
store.shareTarget(alice, tid, 'bob');
store.shareTarget(alice, tid, 'carol');
assert.throws(() => store.shareTarget(bob, tid, 'dave'), /Target not found/, 'only the owner shares');
assert.throws(() => store.shareTarget(alice, tid, 'alice'), /자기 자신/);
assert.throws(() => store.shareTarget(alice, tid, 'nobody'), /없습니다/);
assert.equal(store.targetAccess(bob, tid)?.shared_by, 'alice');
assert.equal(store.targetAccess(alice, tid)?.shared_by, undefined);
assert.equal(store.targetAccess(dave, tid), undefined);
assert.equal(store.target(bob, tid), undefined, 'managing stays with the owner');
assert.deepEqual(store.targets(bob).map((t) => [t.name, t.shared_by ?? null]), [['box', null], ['box', 'alice']], 'own PCs first, then shared ones');
store.updateTarget(alice, tid, {});
store.setDefaultTarget(alice, tid, true);
assert.equal(store.targets(bob).find((t) => t.id === tid).is_default, 0, "the owner's default PC is not the guest's");
assert.deepEqual(store.targetShares(alice, tid).map((s) => s.username), ['bob', 'carol']);
store.setSessionTarget(bob, 's1', tid);
assert.equal(store.sessionTarget(bob, 's1'), tid, 'a shared PC can be pinned to a chat');
store.disable('alice');
assert.equal(store.targetAccess(bob, tid), undefined, "sharing stops with the owner's account");
store.db.prepare("UPDATE accounts SET active=1 WHERE username='alice'").run();
assert.ok(store.targetAccess(bob, tid));
store.shareTarget(alice, tid, 'dave');
store.unshareTarget(alice, tid, dave);
assert.equal(store.targetAccess(dave, tid), undefined);
console.log('PASS sharing: owner-only management, own first, default stays the owner\'s, owner disabled / unshared → no access');

// ---- gateway with a mock runner
const token = crypto.randomBytes(32).toString('hex');
store.updateTarget(alice, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });
const wss = new WebSocketServer({ noServer: true });
const hub = createRunnerHub(store, wss, {});
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
const names = { [alice]: 'alice', [bob]: 'bob', [carol]: 'carol' };
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (hub.upgrade(req, socket, head, url.pathname)) return;
  const uid = Number(url.searchParams.get('uid'));
  hub.attachScreen(req, socket, head, tid, { id: uid, name: names[uid] }, () => Boolean(store.targetAccess(uid, tid)), screenOpts(Object.fromEntries(url.searchParams)), 2);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `ws://127.0.0.1:${server.address().port}`;

const calls = [];          // [method, params] the runner was asked (RPC)
const notes = [];          // [method, params] notifications to the runner
const runner = new WebSocket(`${base}/_runner/ws`, { headers: { authorization: `Bearer ${token}`, 'x-aidev-runner': '0.18.3' } });
runner.on('message', (data, binary) => {
  if (binary) return;
  const m = JSON.parse(String(data));
  if (m.id === undefined) { notes.push([m.method, m.params]); return; }
  calls.push([m.method, m.params]);
  const result = m.method === 'screen.rtc' ? { answer: 'v=0 answer' } : m.method === 'exec.list' ? { streams: [] } : {};
  runner.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
});
await new Promise((r) => runner.on('open', r));
runner.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.hello', params: { capabilities: { runner: '0.18.3', os: 'linux', screen: true, control: true, features: ['screen', 'windows', 'video', 'input', 'acks', 'p2p', 'p2p-input'] } } }));
const until = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`timed out: ${what}`); };
await until(() => hub.online(tid) && JSON.parse(store.targetById(tid).capabilities ?? '{}').control, 'runner hello');

/** A page on the screen socket: what it received, and helpers. */
function viewer(uid, q) {
  const ws = new WebSocket(`${base}/screen?uid=${uid}&v=2&mode=video&window=7&codecs=vp9,h264&${q}`);
  const v = { ws, msgs: [], send: (o) => ws.send(JSON.stringify(o)), last: (type) => [...v.msgs].reverse().find((m) => m.type === type) };
  ws.on('message', (data, binary) => { if (!binary) v.msgs.push(JSON.parse(String(data))); });
  return v;
}
const starts = () => calls.filter(([m]) => m === 'screen.start');
const inputs = () => notes.filter(([m]) => m === 'input.event').map(([, p]) => p.who);

// ---- one stream per window; the first viewer's quality, then the holder's
const A = viewer(alice, 'fps=30&maxWidth=1440&bitrate=4000');
await until(() => A.last('started'), 'alice started');
const B = viewer(bob, 'fps=15&maxWidth=960&bitrate=1000');
await until(() => B.last('started'), 'bob started');
assert.equal(starts().length, 1, 'the PC encodes the window once');
assert.equal(B.last('started').streamId, A.last('started').streamId);
assert.equal(B.last('started').maxWidth, 1440, "a later viewer gets the stream's quality");
assert.equal(A.last('started').p2p, false, 'no direct connection without control');
console.log('PASS one runner stream per window for two accounts with different qualities');

// ---- bob takes control (free); alice's and carol's input does not reach the PC
B.send({ op: 'control', on: true });
await until(() => B.last('control')?.on, 'bob has control');
assert.equal(B.last('control').p2p, true, 'the holder may connect directly');
await until(() => starts().length === 2, "the stream restarts at the holder's quality");
assert.equal(starts()[1][1].maxWidth, 960);
await until(() => A.msgs.filter((m) => m.type === 'started').length === 2 && B.msgs.filter((m) => m.type === 'started').length === 2, 'everyone moved to the new stream');
assert.equal(A.last('started').streamId, B.last('started').streamId);
assert.deepEqual(A.last('control-state').holder, { name: 'bob', owner: false, me: false, mine: false });
assert.equal(A.last('control-state').owner, true);
// carol asks for the holder's quality: handing over keeps the stream (and bob's channel on it)
const C = viewer(carol, 'fps=15&maxWidth=960&bitrate=1000');
await until(() => C.last('started'), 'carol started');
assert.equal(starts().length, 2, "a third viewer joins the holder's stream");
A.send({ op: 'input', ev: { t: 'move', x: 0.1, y: 0.1, who: 'alice' } });
C.send({ op: 'input', ev: { t: 'move', x: 0.1, y: 0.1, who: 'carol' } });
B.send({ op: 'input', ev: { t: 'move', x: 0.5, y: 0.5, who: 'bob' } });
await until(() => inputs().includes('bob'), 'bob input');
assert.deepEqual(inputs(), ['bob'], 'only the holder\'s input reaches the PC');
assert.equal(notes.find(([m]) => m === 'input.event')[1].win, 7, 'positions stay relative to the watched window');
assert.equal(hub.controlHolder(tid).name, 'bob');
console.log('PASS control lock: only the holder\'s input passes; quality follows the holder');

// ---- the API: a guest sees the PC without its pairing code and cannot manage it; agent input waits for the holder
const api = createAidevApi({ store, runners: hub, laya: {}, runtimeFetch: async () => Response.json({}), json: (res, status, body) => { res.status = status; res.body = body; }, push: { sendToUser: async () => ({ delivered: 0 }) }, isOnline: () => false });
const call = async (uid, method, p, body) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = {};
  const res = {};
  try { await api.handle(req, res, new URL(`http://gw/api/aidev${p}`), { user: { id: uid, username: names[uid] }, sid: `s-${uid}` }); }
  catch (error) { res.status = error.status ?? 500; res.body = { error: error.message }; }
  return res;
};
let r = await call(bob, 'GET', '/targets');
const sharedView = r.body.targets.find((t) => t.id === tid);
assert.deepEqual([sharedView.owner, sharedView.shared_by, sharedView.pairing_code], [false, 'alice', null]);
assert.equal(r.body.targets.find((t) => t.id !== tid).owner, true);
assert.equal((await call(bob, 'POST', `/targets/${tid}/shares`, { username: 'dave' })).status, 403, 'a guest does not share');
assert.equal((await call(bob, 'PATCH', `/targets/${tid}`, { policy: 'deny' })).status, 403, 'a guest does not change the policy');
assert.equal((await call(bob, 'POST', `/targets/${tid}/pair/refresh`)).status, 403, 'a guest gets no pairing code');
assert.equal((await call(dave, 'GET', `/targets/${tid}/runs`)).status, 404, 'no access without a share');
r = await call(alice, 'POST', `/targets/${tid}/shares`, { username: 'Dave' });
assert.deepEqual(r.body.shares.map((x) => x.username), ['bob', 'carol', 'dave']);
r = await call(alice, 'DELETE', `/targets/${tid}/shares/${dave}`);
assert.deepEqual(r.body.shares.map((x) => x.username), ['bob', 'carol']);
r = await call(alice, 'POST', `/targets/${tid}/input`, { window: 7, actions: [{ type: 'move', x: 0.5, y: 0.5 }] });
assert.equal(r.status, 409, "the owner's agent waits while bob controls");
assert.match(r.body.error, /bob 님이/);
r = await call(bob, 'POST', `/targets/${tid}/input`, { window: 7, actions: [{ type: 'move', x: 0.5, y: 0.5 }] });
assert.equal(r.status, 200, "the holder's own agent may type");
console.log('PASS API: guest view without pairing code, owner-only management and sharing, agent input respects the holder');

// ---- direct channels: only the holder offers; another viewer with a channel keeps direct input off
C.send({ op: 'rtc', offer: 'v=0 carol' });
await until(() => C.last('rtc'), 'carol rtc answer');
assert.match(C.last('rtc').error, /제어하는 사람만/);
B.send({ op: 'rtc', offer: 'v=0 bob' });
await until(() => B.last('rtc')?.answer, 'bob rtc answer');
await until(() => notes.some(([m, p]) => m === 'screen.control' && p.on), 'direct input on for the holder alone');
assert.equal(B.last('control-direct')?.on, true);
console.log('PASS direct connection only for the holder, direct input while alone');

// ---- carol asks; bob hands over; bob had a channel there → carol's input goes through the gateway
C.send({ op: 'control-request' });
await until(() => B.last('control-state')?.requests.length === 1, 'bob sees the request');
assert.deepEqual(B.last('control-state').requests[0], { id: B.last('control-state').requests[0].id, name: 'carol', me: false });
assert.equal(C.last('control-state').requests[0].me, true);
B.send({ op: 'control-grant' });
await until(() => C.last('control')?.on, 'carol has control');
await until(() => B.last('control')?.on === false, 'bob lost control');
assert.match(B.last('control').message, /carol 님에게/);
await until(() => notes.filter(([m]) => m === 'screen.control').at(-1)[1].on === false, 'direct input off: bob still has a channel there');
assert.equal(starts().length, 2, 'same quality: no restart on hand-over');
B.send({ op: 'input', ev: { t: 'move', x: 0.2, y: 0.2, who: 'bob-late' } });
C.send({ op: 'input', ev: { t: 'move', x: 0.3, y: 0.3, who: 'carol' } });
await until(() => inputs().includes('carol'), 'carol input');
assert.ok(!inputs().includes('bob-late'), 'the former holder is cut off');
console.log('PASS request → hand over; the former holder\'s input and channel stop counting');

// ---- bob asks again, carol declines; the owner takes control; carol's release order
B.send({ op: 'control-request' });
await until(() => C.last('control-state')?.requests.length === 1, 'carol sees bob');
C.send({ op: 'control-deny' });
await until(() => B.last('control-note'), 'bob is told');
assert.match(B.last('control-note').message, /거절/);
C.send({ op: 'control-take' });
await until(() => C.msgs.some((m) => m.type === 'error' && /소유자만/.test(m.message)), 'only the owner takes');
B.send({ op: 'control-request' });
await until(() => A.last('control-state')?.requests.length === 1, 'bob waits');
A.send({ op: 'control-take' });
await until(() => A.last('control')?.on, 'alice took control');
await until(() => C.last('control')?.on === false, 'carol lost it');
assert.match(C.last('control').message, /소유자 alice/);
C.send({ op: 'input', ev: { t: 'move', x: 0.4, y: 0.4, who: 'carol-late' } });
A.send({ op: 'input', ev: { t: 'move', x: 0.5, y: 0.5, who: 'alice' } });
await until(() => inputs().includes('alice'), 'alice input');
assert.ok(!inputs().includes('carol-late'));
// alice lets go: bob (who asked) gets it
A.send({ op: 'control', on: false });
await until(() => B.last('control')?.on, 'bob gets it on release');
assert.deepEqual(A.last('control-state').holder, { name: 'bob', owner: false, me: false, mine: false });
console.log('PASS decline, owner-only take, release → the first who asked');

// ---- the holder leaves; the same account on another screen; a share taken back closes the socket
B.ws.close();
await until(() => A.last('control-state')?.holder === null, 'nobody controls after bob left');
const C2 = viewer(carol, 'fps=30&maxWidth=1440&bitrate=4000');
await until(() => C2.last('started'), 'carol second screen');
C.send({ op: 'control', on: true });
await until(() => C.last('control')?.on, 'carol controls');
C2.send({ op: 'control', on: true });
await until(() => C2.last('control')?.on, 'moved to the same account\'s other screen');
assert.match(C.last('control').message, /같은 계정/);
store.unshareTarget(alice, tid, carol);
const closed = await new Promise((r) => { C2.ws.on('close', (code) => r(code)); });
assert.equal(closed, 1008, 'a share taken back ends the socket (alive check)');
await until(() => A.last('control-state')?.holder === null, 'control released with the socket');
console.log('PASS holder leaving, same-account move, share taken back closes the screen');

for (const v of [A, C]) v.ws.close();
runner.close();
server.close();
console.log('ALL PASS screen-control-test');
process.exit(0);
