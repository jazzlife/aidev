// Screen latency control (F-07d) from a v2 page: node test/screen-acks.mjs <gateway> <token> <targetId> <srcPng>
// Numbered frames; while the page has not shown (acked) frame 1, the runner makes no new frame; the ack lets the
// next one through; the runner's numbers arrive as `stats`.
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
const [gw, token, tid, src] = process.argv.slice(2);
// its own stream (maxWidth 336): an older page on the same stream would be acked for when sent
const url = `${gw.replace(/^http/, 'ws')}/api/aidev/targets/${tid}/screen?token=${token}&v=2&window=1&mode=jpeg&fps=10&maxWidth=336`;
const ws = new WebSocket(url, { headers: { origin: gw } });
const out = { frames: [] };
const done = (extra = {}) => { console.log(JSON.stringify({ ...out, ...extra })); process.exit(0); };
setTimeout(() => done({ timeout: true }), 15000);
const seqOf = (d) => ((d[1] & 2) === 2 ? d.readUInt32BE(2) : 0);
let heldSince = 0;
ws.on('message', (d, binary) => {
  if (!binary) {
    const m = JSON.parse(String(d));
    if (m.type === 'error') done({ error: m.message });
    if (m.type === 'stats' && typeof m.bitrate === 'number' && typeof m.captureMs === 'number') out.stats = true;
    return;
  }
  const seq = seqOf(d);
  out.frames.push(seq);
  if (out.frames.length === 1) {
    out.numbered = seq === 1 && d[0] === 3 && d[6] === 0xff && d[7] === 0xd8;
    // not acked: wait past the runner's budget (no loop measured yet: 400 ms), then change the picture
    setTimeout(() => { execFileSync('node', ['test/make-png.mjs', src, '230']); heldSince = Date.now(); }, 600);
    setTimeout(() => {
      out.heldBack = out.frames.length === 1;
      ws.send(JSON.stringify({ op: 'ack', seq: 1 }));
    }, 1600);
  } else if (out.frames.length === 2) {
    out.afterAck = seq === 2 && Date.now() - heldSince >= 900;
    setTimeout(() => done(), 1200);   // stats come once a second
  }
});
ws.on('error', (e) => done({ error: e.message }));
