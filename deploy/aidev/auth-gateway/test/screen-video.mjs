// A program window as live video + remote control (F-07b/F-07c), against a real X display (Xvfb): the runner
// captures the window itself and encodes H.264 inside (OpenH264).
//   node test/screen-video.mjs <gateway> <token> <targetId> <display :99> <outDir> <win "id[,x,y,w,h]"> [refuse|close]
// → JSON: codec, frames, first frame is an H.264 keyframe with SPS, the access units decode (ffprobe), a late
//   viewer starts at a keyframe, control on → the pointer lands at the same spot of the window (xdotool).
//   refuse: control without the owner's consent.  close: KILL_PID's window closes → the stream ends with an error.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { WebSocket } from 'ws';
const [gw, token, tid, display, outDir, winArg, only] = process.argv.slice(2);
const [wid, wx, wy, ww, wh] = String(winArg).split(',').map(Number);
const url = (q) => `${gw.replace(/^http/, 'ws')}/api/aidev/targets/${tid}/screen?token=${token}&window=${wid}&${q}`;
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
} else if (only === 'close') {   // the program exits while watched
  const w = new WebSocket(url('mode=video&fps=10&maxWidth=640&bitrate=800'), { headers: { origin: gw } });
  w.on('message', (d, bin) => {
    if (bin) { out.frames++; if (out.frames === 3) process.kill(Number(process.env.KILL_PID)); return; }
    const m = JSON.parse(String(d));
    if (m.type === 'error') finish({ error: m.message });
  });
} else {
const a = new WebSocket(url('mode=video&fps=15&maxWidth=640&bitrate=1500'), { headers: { origin: gw } });
let lateStarted = false; let controlled = false;
a.on('message', (d, bin) => {
  if (!bin) {
    const m = JSON.parse(String(d));
    if (m.type === 'format') { out.codec = m.codec; out.width = m.width; out.height = m.height; }
    if (m.type === 'started') out.controlAvailable = m.control;
    if (m.type === 'error') out.error = m.message;
    if (m.type === 'control') {
      out.controlOn = m.on;
      if (m.on) {
        a.send(JSON.stringify({ op: 'input', ev: { t: 'move', x: 0.25, y: 0.5 } }));
        a.send(JSON.stringify({ op: 'input', ev: { t: 'button', b: 'left', down: true, x: 0.25, y: 0.5 } }));
        a.send(JSON.stringify({ op: 'input', ev: { t: 'button', b: 'left', down: false, x: 0.25, y: 0.5 } }));
        a.send(JSON.stringify({ op: 'input', ev: { t: 'key', key: 'a', code: 'KeyA', mods: { ctrl: true } } }));
        // a browser cannot aim at another window: its `win` is replaced by the gateway with the watched one
        a.send(JSON.stringify({ op: 'input', ev: { t: 'move', x: 0.25, y: 0.5, win: 1 } }));
        setTimeout(() => {
          const loc = execFileSync('xdotool', ['getmouselocation'], { env: { ...process.env, DISPLAY: display } }).toString();
          out.mouse = loc.trim();
          const x = Number(/x:(\d+)/.exec(loc)?.[1]); const y = Number(/y:(\d+)/.exec(loc)?.[1]);
          const ex = wx + Math.round(0.25 * (ww - 1)); const ey = wy + Math.round(0.5 * (wh - 1));
          out.expected = `x:${ex} y:${ey}`;
          out.mouseInWindow = Math.abs(x - ex) <= 1 && Math.abs(y - ey) <= 1;
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
