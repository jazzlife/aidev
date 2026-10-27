// Deleting a PC (runner 0.20.0): a connected runner is told to remove itself (close 4410), one that was away hears it
// at its next connect (410 + x-aidev-runner: removed); runners before 0.20.0 only understand 4401 / 401 and get those.
// What the gateway kept of the PC goes: its remote runs and their log files, its shares, the chats pinned to it.
//   npm run build && node test/target-remove-test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-target-remove-'));
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken } = await import('../dist/runner-hub.js');
const { createAidevApi } = await import('../dist/aidev-api.js');

const store = openStore(path.join(dir, 'auth.db'));
for (const name of ['alice', 'bob']) await store.add(name, 'pw1234pw', `rt-${name}`, 1);
const [alice, bob] = ['alice', 'bob'].map((name) => store.account(name).id);
const logDir = path.join(dir, 'logs');
const wss = new WebSocketServer({ noServer: true });
const hub = createRunnerHub(store, wss, { logDir });
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
server.on('upgrade', (req, socket, head) => { if (!hub.upgrade(req, socket, head, new URL(req.url, 'http://x').pathname)) socket.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `ws://127.0.0.1:${server.address().port}`;
const until = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`timed out: ${what}`); };

const api = createAidevApi({ store, runners: hub, laya: {}, runtimeFetch: async () => Response.json({}), json: (res, status, body) => { res.status = status; res.body = body; }, push: { sendToUser: async () => ({ delivered: 0 }) }, isOnline: () => false });
const call = async (uid, method, p) => {
  const req = Readable.from([]); req.method = method; req.headers = {};
  const res = {};
  try { await api.handle(req, res, new URL(`http://gw/api/aidev${p}`), { user: { id: uid, username: 'u' }, sid: `s-${uid}` }); }
  catch (error) { res.status = error.status ?? 500; res.body = { error: error.message }; }
  return res;
};

/** A paired PC of alice's: its target id and token. */
function pc(name) {
  const tid = store.addTarget({ userId: alice, name, platform: 'linux', pairingCode: name.toUpperCase(), pairingExpires: Date.now() + 60000 });
  const token = crypto.randomBytes(32).toString('hex');
  store.updateTarget(alice, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });
  return { tid, token };
}
/** A runner's connect: open (then hello) — or the HTTP answer that refused it. */
function connect(token, version) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base}/_runner/ws`, { headers: { authorization: `Bearer ${token}`, 'x-aidev-runner': version } });
    ws.on('open', () => {
      ws.on('message', (data) => { const m = JSON.parse(String(data)); if (m.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'exec.list' ? { streams: [] } : {} })); });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.hello', params: { capabilities: { runner: version, os: 'linux', features: ['exec'] } } }));
      resolve({ ws, closed: new Promise((r) => ws.on('close', (code) => r(code))) });
    });
    ws.on('unexpected-response', (_req, res) => { resolve({ status: res.statusCode, removed: res.headers['x-aidev-runner'] === 'removed' }); res.resume(); });
  });
}

// ---- a connected 0.20.0 runner, with a run log, a share and a chat pinned to the PC
const box = pc('box');
const live = await connect(box.token, '0.20.0');
await until(() => hub.online(box.tid), 'box online');
const rr = store.addRemoteRun({ targetId: box.tid, userId: alice, kind: 'exec', cmd: 'echo hi' });
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, `${rr}.log`), 'hi\n');
fs.writeFileSync(path.join(logDir, '999999.log'), 'another PC\n');
store.shareTarget(alice, box.tid, 'bob');
store.setSessionTarget(alice, 's1', box.tid);
store.setSessionTarget(bob, 's2', box.tid);
assert.equal((await call(bob, 'DELETE', `/targets/${box.tid}`)).status, 403, 'a guest does not delete the PC');
assert.equal((await call(alice, 'DELETE', `/targets/${box.tid}`)).status, 200);
assert.equal(await live.closed, 4410, 'the connected runner is told to remove itself');
assert.equal(store.targetById(box.tid), undefined);
assert.equal(store.remoteRunById(alice, rr), undefined, 'its remote runs go');
await until(() => !fs.existsSync(path.join(logDir, `${rr}.log`)), 'its run log goes');
assert.ok(fs.existsSync(path.join(logDir, '999999.log')), "other PCs' logs stay");
assert.equal(store.targetAccess(bob, box.tid), undefined, 'its shares go');
assert.deepEqual([store.sessionTarget(alice, 's1'), store.sessionTarget(bob, 's2')], [null, null], 'chats pinned to it lose the pin');
console.log('PASS a connected runner gets 4410; runs, logs, shares and chat pins go');

// ---- the same runner connecting again (it was away): 410 removed; a runner before 0.20.0 with that token: 401
assert.deepEqual(await connect(box.token, '0.20.0'), { status: 410, removed: true }, 'an away runner hears it at its next connect');
assert.deepEqual(await connect(box.token, '0.19.1'), { status: 401, removed: false }, 'an older runner only understands 401');
assert.deepEqual(await connect(crypto.randomBytes(32).toString('hex'), '0.20.0'), { status: 401, removed: false }, 'an unknown token is only refused');
console.log('PASS an away runner gets 410 + removed at its next connect; older runners and unknown tokens get 401');

// ---- an older runner connected when its PC is deleted: 4401, as before
const old = pc('old');
const oldLive = await connect(old.token, '0.19.1');
await until(() => hub.online(old.tid), 'old online');
assert.equal((await call(alice, 'DELETE', `/targets/${old.tid}`)).status, 200);
assert.equal(await oldLive.closed, 4401, 'a runner before 0.20.0 is cut off as revoked');
console.log('PASS a runner before 0.20.0 gets 4401');

// ---- paired again (not deleted): the old token is only refused, never "removed"
const again = pc('again');
store.updateTarget(alice, again.tid, { tokenHash: hashToken(crypto.randomBytes(32).toString('hex')) });
assert.deepEqual(await connect(again.token, '0.20.0'), { status: 401, removed: false }, 'a re-paired token is not a removal');
console.log('PASS a re-paired token stays a plain refusal');

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('PASS target removal');
process.exit(0);
