// Runner updates from the workbench (2026-10-27): a 0.21.0+ runner is asked with runner.update and the update is done
// when it says hello with another version (a failure arrives as runner.update.failed); an older runner (0.14.0+) gets
// its own `update` command started apart from it (nohup / Start-Process); Android, too-old runners and guests are refused.
//   npm run build && node test/runner-update-test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-runner-update-'));
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken } = await import('../dist/runner-hub.js');
const { createAidevApi } = await import('../dist/aidev-api.js');

const store = openStore(path.join(dir, 'auth.db'));
for (const name of ['alice', 'bob']) await store.add(name, 'pw1234pw', `rt-${name}`, 1);
const [alice, bob] = ['alice', 'bob'].map((name) => store.account(name).id);
const wss = new WebSocketServer({ noServer: true });
const hub = createRunnerHub(store, wss, {});
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
server.on('upgrade', (req, socket, head) => { if (!hub.upgrade(req, socket, head, new URL(req.url, 'http://x').pathname)) socket.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `ws://127.0.0.1:${server.address().port}`;
const until = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`timed out: ${what}`); };

const api = createAidevApi({ store, runners: hub, laya: {}, runtimeFetch: async () => Response.json({}), json: (res, status, body) => { res.status = status; res.body = body; }, push: { sendToUser: async () => ({ delivered: 0 }) }, isOnline: () => false });
const call = async (uid, method, p, body) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = {};
  const res = {};
  try { await api.handle(req, res, new URL(`http://gw/api/aidev${p}`), { user: { id: uid, username: 'u' }, sid: `s-${uid}` }); }
  catch (error) { res.status = error.status ?? 500; res.body = { error: error.message }; }
  return res;
};
const view = async (tid) => (await call(alice, 'GET', '/targets')).body.targets.find((t) => t.id === tid);

/** A paired PC of alice's with a mock runner: what it was asked, and `exitCode` for the commands it runs. */
async function pc(name, version, os, features) {
  const tid = store.addTarget({ userId: alice, name, platform: os, pairingCode: name.toUpperCase(), pairingExpires: Date.now() + 60000 });
  const token = crypto.randomBytes(32).toString('hex');
  store.updateTarget(alice, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });
  const m = { tid, token, calls: [], exitCode: 0 };
  m.connect = async (v) => {
    const ws = new WebSocket(`${base}/_runner/ws`, { headers: { authorization: `Bearer ${token}`, 'x-aidev-runner': v } });
    ws.on('message', (data, binary) => {
      if (binary) return;
      const msg = JSON.parse(String(data));
      if (msg.id === undefined) return;
      m.calls.push([msg.method, msg.params]);
      const result = msg.method === 'exec.list' ? { streams: [] } : msg.method === 'exec.start' ? { streamId: msg.params.streamId, pid: 42, cwd: '/home/x' } : { from: v, to: msg.params?.version };
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'exec.start') setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'exec.exit', params: { streamId: msg.params.streamId, code: m.exitCode, durationMs: 5 } })), 20);
    });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.hello', params: { capabilities: { runner: v, os, features } } }));
    await until(() => hub.online(tid) && JSON.parse(store.targetById(tid).capabilities ?? '{}').runner === v, `${name} ${v} hello`);
    m.ws = ws;
  };
  await m.connect(version);
  return m;
}

// ---- a 0.21.0 runner: runner.update, then it reconnects with the new version
const neo = await pc('neo', '0.21.0', 'macos', ['exec', 'shell', 'update']);
assert.equal((await call(bob, 'POST', `/targets/${neo.tid}/update`, { version: '0.22.0' })).status, 404, 'no access, no update');
let r = await call(alice, 'POST', `/targets/${neo.tid}/update`, { version: '0.22.0' });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.deepEqual(neo.calls.find(([m]) => m === 'runner.update'), ['runner.update', { version: '0.22.0' }]);
assert.deepEqual([(await view(neo.tid)).update.from, (await view(neo.tid)).update.to, (await view(neo.tid)).update.error], ['0.21.0', '0.22.0', null], 'under way');
neo.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.update.failed', params: { version: '0.22.0', error: 'SHA-256이 맞지 않습니다' } }));
await until(() => hub.updateState(neo.tid)?.error, 'failure reported');
assert.match((await view(neo.tid)).update.error, /SHA-256/, 'a failure is shown');
r = await call(alice, 'POST', `/targets/${neo.tid}/update`, { version: 'evil; rm -rf /' });
assert.equal(r.status, 200);
assert.deepEqual(neo.calls.filter(([m]) => m === 'runner.update').at(-1)[1], { version: 'latest' }, 'anything but x.y.z is "latest"');
neo.ws.close();
await until(() => !hub.online(neo.tid), 'neo away');
await neo.connect('0.22.0');
assert.equal((await view(neo.tid)).update, null, 'done once it says hello with another version');
console.log('PASS a 0.21.0+ runner updates itself on runner.update; failure shown; done at the new hello');

// ---- an older runner: its own `update` command, started apart from it
const old = await pc('old', '0.19.1', 'linux', ['exec', 'shell']);
r = await call(alice, 'POST', `/targets/${old.tid}/update`, { version: '0.21.0' });
assert.equal(r.status, 200, JSON.stringify(r.body));
const start = old.calls.find(([m]) => m === 'exec.start')[1];
assert.equal(start.shell, 'sh');
assert.match(start.cmd, /nohup "\$exe" update 0\.21\.0 >"\$HOME\/\.aidev\/update\.log" 2>&1 <\/dev\/null &$/, 'started apart from the runner');
assert.equal((await view(old.tid)).update.to, '0.21.0');
const win = await pc('win', '0.18.4', 'windows', ['exec', 'shell']);
win.exitCode = 2;
r = await call(alice, 'POST', `/targets/${win.tid}/update`, {});
assert.equal(r.status, 409, 'the command failed to start');
const wcmd = win.calls.find(([m]) => m === 'exec.start')[1];
assert.equal(wcmd.shell, 'powershell');
assert.match(wcmd.cmd, /Start-Process -FilePath \$exe -ArgumentList 'update','latest' -WindowStyle Hidden/);
assert.match(wcmd.cmd, /'\.aidev\\bin\\aidev-runner\.exe'/, 'the installed runner (one backslash each in PowerShell)');
assert.equal((await view(win.tid)).update, null, 'nothing under way after a failed start');
console.log('PASS an older runner runs its own update command, detached (sh nohup / PowerShell Start-Process)');

// ---- refused: Android, before 0.14.0, offline
const droid = await pc('droid', '0.20.0', 'android', ['exec', 'shell']);
assert.equal((await call(alice, 'POST', `/targets/${droid.tid}/update`, {})).status, 426, 'Android updates the app');
const ancient = await pc('ancient', '0.13.5', 'linux', ['exec', 'shell']);
assert.equal((await call(alice, 'POST', `/targets/${ancient.tid}/update`, {})).status, 426, 'before 0.14.0 there is no update command');
ancient.ws.close();
await until(() => !hub.online(ancient.tid), 'ancient away');
assert.equal((await call(alice, 'POST', `/targets/${ancient.tid}/update`, {})).status, 409, 'offline');
console.log('PASS Android, runners before 0.14.0 and offline PCs are refused');

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('PASS runner update');
process.exit(0);
