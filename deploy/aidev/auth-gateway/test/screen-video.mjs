// Live screen as video + remote control (F-07b), against a real X display (Xvfb) captured by ffmpeg x11grab:
//   node test/screen-video.mjs <gateway> <token> <targetId> <display :99> <outDir>
// → JSON: codec, frames, first frame is an H.264 keyframe with SPS, the access units decode with ffmpeg,
//   a late viewer starts at a keyframe, control on → the mouse moves on the display (xdotool), control off.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { WebSocket } from 'ws';
const [gw, token, tid, display, outDir, only] = process.argv.slice(2);
const url = (q) => `${gw.replace(/^http/, 'ws')}/api/aidev/targets/${tid}/screen?token=${token}&${q}`;
const out = { frames: 0, keys: 0 };
const finish = (extra = {}) => { console.log(JSON.stringify({ ...out, ...extra })); process.exit(0); };
setTimeout(() => finish({ timeout: true }), 30000);
const aus = [];
if (only === 'refuse') {   // no consent: asking for control must be refused, the view keeps working
  const w = new WebSocket(url('mode=jpeg&fps=2&maxWidth=320'), { headers: { origin: gw } });
  w.on('message', (d, bin) => {
    if (bin) return;
    const m = JSON.parse(String(d));
    if (m.type === 'started') { out.controlAvailable = m.control; w.send(JSON.stringify({ op: 'control', on: true })); }
    if (m.type === 'error') finish({ error: m.message });
    if (m.type === 'control') finish({ controlOn: m.on });
  });
} else {
const a = new WebSocket(url('mode=video&fps=15&maxWidth=640&bitrate=1500'), { headers: { origin: gw } });
let lateStarted = false; let controlled = false;
a.on('message', (d, bin) => {
  if (!bin) {
    const m = JSON.parse(String(d));
    if (m.type === 'format') out.codec = m.codec;
    if (m.type === 'started') out.controlAvailable = m.control;
    if (m.type === 'error') out.error = m.message;
    if (m.type === 'control') {
      out.controlOn = m.on;
      if (m.on) {
        a.send(JSON.stringify({ op: 'input', ev: { t: 'move', x: 0.25, y: 0.5 } }));
        a.send(JSON.stringify({ op: 'input', ev: { t: 'button', b: 'left', down: true, x: 0.25, y: 0.5 } }));
        a.send(JSON.stringify({ op: 'input', ev: { t: 'button', b: 'left', down: false, x: 0.25, y: 0.5 } }));
        a.send(JSON.stringify({ op: 'input', ev: { t: 'key', key: 'a', code: 'KeyA', mods: { ctrl: true } } }));
        setTimeout(() => {
          const loc = execFileSync('xdotool', ['getmouselocation'], { env: { ...process.env, DISPLAY: display } }).toString();
          out.mouse = loc.trim();
          const size = execFileSync('xdotool', ['getdisplaygeometry'], { env: { ...process.env, DISPLAY: display } }).toString().trim().split(' ').map(Number);
          const x = Number(/x:(\d+)/.exec(loc)?.[1]); const y = Number(/y:(\d+)/.exec(loc)?.[1]);
          out.mouseAtQuarter = Math.abs(x - Math.round(0.25 * (size[0] - 1))) <= 1 && Math.abs(y - Math.round(0.5 * (size[1] - 1))) <= 1;
          a.send(JSON.stringify({ op: 'control', on: false }));
          setTimeout(() => finish(), 500);
        }, 700);
      }
    }
    return;
  }
  out.frames++;
  const kind = d[0]; const key = (d[1] & 1) === 1;
  if (out.frames === 1) { out.firstKind = kind; out.firstKey = key; out.firstNal = d[6] & 0x1f; }
  if (key) out.keys++;
  aus.push(d.subarray(2));
  if (out.frames === 20 && !lateStarted) {
    lateStarted = true;
    const b = new WebSocket(url('mode=video&fps=15&maxWidth=640&bitrate=1500'), { headers: { origin: gw } });
    b.on('message', (d2, bin2) => { if (bin2 && out.lateFirstKey === undefined) { out.lateFirstKey = (d2[1] & 1) === 1; b.close(); } });
  }
  if (out.frames === 45 && !controlled) {
    controlled = true;
    fs.writeFileSync(`${outDir}/screen.h264`, Buffer.concat(aus));
    try { out.decoded = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', `${outDir}/screen.h264`]).toString().trim().split(',').pop()); } catch (e) { out.decoded = String(e).slice(0, 200); }
    a.send(JSON.stringify({ op: 'control', on: true }));
  }
});
a.on('error', (e) => finish({ error: e.message }));
}
