// A PC whose runner goes away while its screen is watched (an update, a restart, a network drop): the viewer is told
// it is offline, and once the runner is back the viewer's stream starts again by itself — same window, same quality,
// no reload. A mock runner; no real PC.
//   npm run build && node test/screen-reconnect-test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-screen-reconnect-'));
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken, screenOpts } = await import('../dist/runner-hub.js');
const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'rt-alice', 1);
const alice = store.account('alice').id;
const tid = store.addTarget({ userId: alice, name: 'box', platform: 'windows', pairingCode: 'BOX', pairingExpires: Date.now() + 60000 });
const token = crypto.randomBytes(32).toString('hex');
store.updateTarget(alice, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });
const hub = createRunnerHub(store, new WebSocketServer({ noServer: true }), {});
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (hub.upgrade(req, socket, head, url.pathname)) return;
  hub.attachScreen(req, socket, head, tid, { id: alice, name: 'alice' }, () => true, screenOpts(Object.fromEntries(url.searchParams)), 3);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `ws://127.0.0.1:${server.address().port}`;
const until = async (fn, what) => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`timed out: ${what}`); };

const starts = [];
async function connectRunner(version) {
  const runner = new WebSocket(`${base}/_runner/ws`, { headers: { authorization: `Bearer ${token}`, 'x-aidev-runner': version } });
  runner.on('message', (data, binary) => {
    if (binary) return;
    const m = JSON.parse(String(data));
    if (m.id === undefined) return;
    if (m.method === 'screen.start') starts.push(m.params);
    runner.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'exec.list' ? { streams: [] } : {} }));
  });
  await new Promise((r) => runner.on('open', r));
  runner.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.hello', params: { capabilities: { runner: version, os: 'windows', screen: true, control: true, features: ['screen', 'windows', 'video', 'input', 'acks', 'audio'] } } }));
  await until(() => hub.online(tid) && JSON.parse(store.targetById(tid).capabilities ?? '{}').runner === version, `runner ${version} hello`);
  return runner;
}

let runner = await connectRunner('0.21.1');
const page = { msgs: [] };
const ws = new WebSocket(`${base}/screen?v=3&mode=video&window=4294967040&codecs=h264&fps=15&maxWidth=960&bitrate=1200`);
ws.on('message', (data, binary) => { if (!binary) page.msgs.push(JSON.parse(String(data))); });
const count = (type) => page.msgs.filter((m) => m.type === type).length;
await until(() => count('started') === 1, 'started');
const first = page.msgs.find((m) => m.type === 'started');

// the runner updates itself: its connection drops, a new one says hello a moment later
runner.terminate();
await until(() => count('offline') === 1, 'the page is told the PC is away');
runner = await connectRunner('0.22.0');
await until(() => count('started') === 2, 'the stream starts again by itself');
const again = page.msgs.filter((m) => m.type === 'started')[1];
assert.notEqual(again.streamId, first.streamId, 'a new stream on the new connection');
assert.equal(starts.length, 2);
assert.deepEqual([starts[1].window, starts[1].fps, starts[1].maxWidth, starts[1].bitrate], [4294967040, 15, 960, 1200], 'the same window and quality');
assert.equal(again.audio, true, "and the new runner's sound");
// a viewer whose stream is still running is not moved
runner.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.hello', params: { capabilities: { runner: '0.22.0', os: 'windows', screen: true, control: true, features: ['screen', 'windows', 'video', 'input', 'acks', 'audio'] } } }));
await new Promise((r) => setTimeout(r, 200));
assert.equal(count('started'), 2, 'a hello on the same connection changes nothing');
console.log('PASS a watched screen comes back by itself after the runner reconnects');

ws.close(); runner.close(); server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('PASS screen reconnect');
process.exit(0);
