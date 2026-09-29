// The workbench/mobile screen core in a real browser (F-07b/F-07c): one program window drawn on a canvas
// (JPEG frames — this Chromium build has no H.264 decoder; the H.264 bitstream is checked with ffprobe in
// screen-video.mjs), then remote control with real mouse and keyboard events on the canvas → the X
// display's pointer lands on the same spot of that window.
//   node test/screen-browser.mjs <gateway> <token> <targetId> <display :99> <staticDir> <win "id,x,y,w,h">
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [gw, token, tid, display, staticDir, winArg] = process.argv.slice(2);
const [wid, wx, wy, ww, wh] = String(winArg).split(',').map(Number);
const repo = path.resolve(new URL('.', import.meta.url).pathname, '../../../..');
const entry = path.join(staticDir, 'screen-test-entry.ts');
fs.writeFileSync(entry, `import { RemoteScreenSession, screenSocketUrl, bindRemoteInput } from '@/modules/remote-screen';
const canvas = document.querySelector('canvas'); const keys = document.querySelector('textarea');
window.__state = null;
const s = new RemoteScreenSession((o) => screenSocketUrl(${Number(tid)}, o), canvas, { mode: 'jpeg', window: ${wid}, display: 1, fps: 10, maxWidth: 640, bitrate: 0 }, (st) => { window.__state = st; });
window.__session = s;
window.__bind = () => bindRemoteInput(canvas, keys, (ev) => s.input(ev));`);
execFileSync(path.join(repo, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--format=esm', `--alias:@=${path.join(repo, 'src')}`, `--outfile=${path.join(staticDir, 'screen-test.js')}`, '--log-level=error']);
fs.writeFileSync(path.join(staticDir, 'screen-test.html'), '<!doctype html><html><body style="margin:0;background:#000"><canvas style="width:640px;height:360px;display:block"></canvas><textarea style="position:absolute;opacity:0;width:1px;height:1px"></textarea><script type="module" src="/screen-test.js"></script></body></html>');
const { chromium } = await import(path.join(process.env.PLAYWRIGHT_DIR, 'index.mjs'));
const browser = await chromium.launch();
const out = {};
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  await page.goto(`${gw}/`);
  await page.evaluate((t) => localStorage.setItem('auth-token', t), token);
  await page.goto(`${gw}/screen-test.html`);
  await page.waitForFunction(() => window.__state && window.__state.width > 0, null, { timeout: 15000 });
  Object.assign(out, await page.evaluate(() => {
    const c = document.querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return { codec: window.__state.codec, width: c.width, height: c.height, litSamples: lit, controlAvailable: window.__state.controlAvailable };
  }));
  await page.waitForTimeout(1500);
  out.fps = await page.evaluate(() => window.__state.fps);
  await page.evaluate(() => { window.__session.setControl(true); window.__unbind = window.__bind(); });
  await page.waitForFunction(() => window.__state.control === true, null, { timeout: 5000 });
  // real pointer events: click at 75% / 25% of the canvas → the PC's pointer lands there
  await page.mouse.click(0.75 * 640, 0.25 * 360);
  await page.keyboard.type('hi');
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(600);
  const loc = execFileSync('xdotool', ['getmouselocation'], { env: { ...process.env, DISPLAY: display } }).toString();
  const x = Number(/x:(\d+)/.exec(loc)?.[1]); const y = Number(/y:(\d+)/.exec(loc)?.[1]);
  out.mouse = loc.trim();
  out.pointerFollows = Math.abs(x - (wx + 0.75 * (ww - 1))) <= 3 && Math.abs(y - (wy + 0.25 * (wh - 1))) <= 3;
  out.error = await page.evaluate(() => window.__state.error);
  await page.evaluate(() => window.__session.close());
} catch (e) { out.error = String(e).slice(0, 300); }
await browser.close();
console.log(JSON.stringify(out));
