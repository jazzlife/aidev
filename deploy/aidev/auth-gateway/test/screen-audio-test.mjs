// The PC's sound beside its screen (2026-11-03): a viewer that plays it (v=3) turns it on for its stream once
// (screen.audio), the runner's sound frames (kind 5) reach only such viewers, are never kept for late joiners and do
// not wait for a keyframe; a capture error reaches them. Older pages (v=2) on the same stream get pictures only.
// A mock runner; no real PC.
//   npm run build && node test/screen-audio-test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-screen-audio-'));
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken, screenOpts } = await import('../dist/runner-hub.js');

const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'rt-alice', 1);
const alice = store.account('alice').id;
const tid = store.addTarget({ userId: alice, name: 'box', platform: 'linux', pairingCode: 'BOX', pairingExpires: Date.now() + 60000 });
const token = crypto.randomBytes(32).toString('hex');
store.updateTarget(alice, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });
const hub = createRunnerHub(store, new WebSocketServer({ noServer: true }), {});
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (hub.upgrade(req, socket, head, url.pathname)) return;
  hub.attachScreen(req, socket, head, tid, { id: alice, name: 'alice' }, () => true, screenOpts(Object.fromEntries(url.searchParams)), Number(url.searchParams.get('v')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `ws://127.0.0.1:${server.address().port}`;

const notes = [];
const runner = new WebSocket(`${base}/_runner/ws`, { headers: { authorization: `Bearer ${token}`, 'x-aidev-runner': '0.22.0' } });
runner.on('message', (data, binary) => {
  if (binary) return;
  const m = JSON.parse(String(data));
  if (m.id === undefined) { notes.push([m.method, m.params]); return; }
  runner.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'exec.list' ? { streams: [] } : {} }));
});
await new Promise((r) => runner.on('open', r));
runner.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.hello', params: { capabilities: { runner: '0.22.0', os: 'linux', screen: true, control: true, features: ['screen', 'windows', 'video', 'input', 'acks', 'audio'] } } }));
const until = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`timed out: ${what}`); };
const quiet = () => new Promise((r) => setTimeout(r, 150));
await until(() => hub.online(tid) && JSON.parse(store.targetById(tid).capabilities ?? '{}').screen, 'runner hello');

function viewer(v) {
  const ws = new WebSocket(`${base}/screen?v=${v}&mode=video&window=7&codecs=h264`);
  const page = { ws, msgs: [], frames: [], last: (type) => [...page.msgs].reverse().find((m) => m.type === type) };
  ws.on('message', (data, binary) => { if (binary) page.frames.push(Buffer.from(data)); else page.msgs.push(JSON.parse(String(data))); });
  return page;
}
const audioNotes = () => notes.filter(([m]) => m === 'screen.audio');
/** A frame from the runner on `streamId`: `[id u32][kind][flags][…]`. */
const frame = (streamId, kind, flags, ...rest) => { const b = Buffer.alloc(4); b.writeUInt32BE(streamId); return Buffer.concat([b, Buffer.from([kind, flags, ...rest])]); };

const A = viewer(3);
await until(() => A.last('started'), 'A started');
const sid = A.last('started').streamId;
assert.equal(A.last('started').audio, true, 'a v=3 page on a PC with sound plays it');
await until(() => audioNotes().length === 1, 'sound turned on');
assert.deepEqual(audioNotes()[0][1], { streamId: sid, on: true });
const B = viewer(2);
await until(() => B.last('started'), 'B started');
assert.equal(B.last('started').streamId, sid, 'one stream for both');
assert.equal(B.last('started').audio, false, 'an older page gets no sound');
const C = viewer(3);
await until(() => C.last('started'), 'C started');
await quiet();
assert.equal(audioNotes().length, 1, 'turned on once per stream');
console.log('PASS v=3 viewers turn the sound on for their stream, once; v=2 viewers are told there is none');

// a keyframe, then sound: the sound reaches the v=3 pages only, at once
runner.send(frame(sid, 1, 1 | 2, 0, 0, 0, 1, 0, 0, 0, 1, 0x67), { binary: true });
await until(() => A.frames.length === 1 && B.frames.length === 1 && C.frames.length === 1, 'the keyframe');
runner.send(frame(sid, 5, 1, 0, 0, 0, 9, 0xfc, 0xff), { binary: true });
await until(() => A.frames.length === 2 && C.frames.length === 2, 'the sound');
assert.deepEqual([...A.frames[1]], [5, 1, 0, 0, 0, 9, 0xfc, 0xff], 'passed as it came');
await quiet();
assert.equal(B.frames.length, 1, 'not to the older page');
// a late viewer starts from the keyframe; the sound sent before it joined is not replayed
const D = viewer(3);
await until(() => D.frames.length >= 1, 'D has the kept frames');
await quiet();
assert.deepEqual(D.frames.map((f) => f[0]), [1], 'only the pictures are kept for late viewers');
// and the sound from now on
runner.send(frame(sid, 5, 0, 0, 0, 0, 10, 0xfc), { binary: true });
await until(() => D.frames.length === 2, 'sound for D');
console.log('PASS sound frames: to v=3 viewers only, at once, never kept for late joiners');

runner.send(JSON.stringify({ jsonrpc: '2.0', method: 'screen.audio', params: { streamId: sid, error: '소리를 캡처할 수 없습니다' } }));
await until(() => A.last('audio'), 'A told');
assert.equal(A.last('audio').error, '소리를 캡처할 수 없습니다');
await quiet();
assert.equal(B.last('audio'), undefined, 'the older page is not');
runner.send(JSON.stringify({ jsonrpc: '2.0', method: 'screen.audio', params: { streamId: sid, error: null } }));
await until(() => A.msgs.filter((m) => m.type === 'audio').length === 2, 'recovered');
assert.equal(A.last('audio').error, null);
console.log('PASS a capture error (and its recovery) reaches the viewers that play the sound');

for (const p of [A, B, C, D]) p.ws.close();
runner.close();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('PASS screen audio');
process.exit(0);
