// Screen stream (F-07) from the browser side: node test/screen-client.mjs <gateway> <token> <targetId> <srcPng>
// Two viewers share one stream; a late viewer gets the last frame at once; a changed picture → a new frame.
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
const [gw, token, tid, src] = process.argv.slice(2);
const url = `${gw.replace(/^http/, 'ws')}/api/aidev/targets/${tid}/screen?token=${token}&fps=10&maxWidth=320`;
const open = () => new WebSocket(url, { headers: { origin: gw } });
const out = { frames1: 0, frames2: 0 };
const jpeg = (d) => d[0] === 0xff && d[1] === 0xd8;
const done = (extra = {}) => { console.log(JSON.stringify({ ...out, ...extra })); process.exit(0); };
setTimeout(() => done({ timeout: true }), 12000);
const a = open();
a.on('message', (d, binary) => {
  if (!binary) { const m = JSON.parse(String(d)); if (m.type === 'error') done({ error: m.message }); if (m.type === 'started') out.started = true; return; }
  if (!jpeg(d)) return done({ notJpeg: true });
  out.frames1++;
  if (out.frames1 === 1) {
    const b = open();
    b.on('message', (d2, bin2) => {
      if (!bin2) return;
      out.frames2++;
      if (out.frames2 === 1) { out.lateViewerGotLastFrame = jpeg(d2); execFileSync('node', ['test/make-png.mjs', src, '220']); }
    });
  }
  if (out.frames1 === 2) { out.changedFrame = true; out.sameStreamForBoth = out.frames2 >= 1; setTimeout(() => done(), 300); }
});
a.on('error', (e) => done({ error: e.message }));
