// F-03 smoke helper: a browser-like client of /api/aidev/targets/:id/stream.
//   node test/stream-client.mjs <gateway> <token> <targetId>
// Starts an interactive pty command over REST, attaches, types a line, resizes, interrupts it, and prints
// a JSON summary: {hello, started, attached, echoed, sizeSeen, exit, replay}.
import WebSocket from 'ws';

const [G, token, tid] = process.argv.slice(2);
const summary = { hello: false, started: false, attached: false, echoed: false, sizeSeen: false, exit: null, replay: false };
const out = new Map();
const done = (code = 0) => { console.log(JSON.stringify(summary)); process.exit(code); };
setTimeout(() => done(1), 20_000).unref();

const url = `${G.replace(/^http/, 'ws')}/api/aidev/targets/${tid}/stream?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(url, { headers: { origin: G } });
let streamId = null;
const seen = new Set();
ws.on('message', async (data, binary) => {
  if (binary) {
    const id = data.readUInt32BE(0);
    out.set(id, (out.get(id) ?? '') + data.subarray(4).toString('utf8'));
    const text = out.get(id);
    if (id === streamId && !summary.echoed && text.includes('got:hello-pty')) {
      summary.echoed = true;
      ws.send(JSON.stringify({ op: 'resize', streamId, cols: 91, rows: 27 }));
      setTimeout(() => ws.send(JSON.stringify({ op: 'write', streamId, data: 'size\n' })), 300);
    }
    if (id === streamId && !summary.sizeSeen && text.includes('27 91')) {
      summary.sizeSeen = true;
      ws.send(JSON.stringify({ op: 'signal', streamId, signal: 'INT' }));
    }
    return;
  }
  const msg = JSON.parse(String(data));
  if (msg.type === 'hello') {
    summary.hello = true;
    const r = await fetch(`${G}/api/aidev/targets/${tid}/exec`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'echo ready; read x; echo got:$x; read y; stty size; sleep 30', pty: true, cols: 80, rows: 24 }),
    }).then((res) => res.json());
    streamId = r.stream?.streamId ?? null;
    if (!streamId) { summary.error = r; done(1); }
    // the 'started' broadcast may arrive before this reply: attach from the reply, note either order
    if (seen.has(streamId)) summary.started = true;
    ws.send(JSON.stringify({ op: 'attach', streamId }));
  } else if (msg.type === 'started') {
    seen.add(msg.stream.streamId);
    if (msg.stream.streamId === streamId) summary.started = true;
  } else if (msg.type === 'attached' && msg.stream.streamId === streamId) {
    summary.attached = true;
    setTimeout(() => ws.send(JSON.stringify({ op: 'write', streamId, data: 'hello-pty\n' })), 300);
  } else if (msg.type === 'exit' && msg.stream.streamId === streamId) {
    summary.exit = { code: msg.stream.code, signal: msg.stream.signal, remoteRunId: msg.stream.remoteRunId };
    // a second viewer attaching after the fact gets the ring replayed
    const late = new WebSocket(url, { headers: { origin: G } });
    let text = '';
    late.on('message', (d, b) => {
      if (b) { text += d.subarray(4).toString('utf8'); return; }
      const m = JSON.parse(String(d));
      if (m.type === 'hello') late.send(JSON.stringify({ op: 'attach', streamId }));
      if (m.type === 'attached') { summary.replay = text.includes('got:hello-pty') && text.includes('ready'); late.close(); ws.close(); done(0); }
    });
  } else if (msg.type === 'error') {
    summary.error = msg.message;
  }
});
ws.on('error', (e) => { summary.error = e.message; done(1); });
