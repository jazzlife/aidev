// F-09b end to end: the real runner (RUNNER_BIN) connected to a real runner-hub, the gateway's debug hub
// driving every adapter this machine can run against a real program — breakpoint → locals → evaluate →
// continue → end. Adapters whose language runtime is missing here are skipped (and say so).
//   RUNNER_BIN=… AIDEV_ADAPTER_MIRROR=… DBG_WORK=<dir with c/ cs/ go/ java/ mono/ samples> node test/debug-e2e-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const RUNNER_BIN = process.env.RUNNER_BIN;
const WORK = fs.realpathSync(process.env.DBG_WORK ?? '/tmp/claude-0/dbgwork');
if (!RUNNER_BIN) { console.log('SKIP: RUNNER_BIN not set'); process.exit(0); }
const only = (process.env.ONLY ?? '').split(',').filter(Boolean);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-dbg-e2e-'));
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken } = await import('../dist/runner-hub.js');
const { createDebugHub, validateLaunch } = await import('../dist/debug-hub.js');
const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const tid = store.addTarget({ userId: uid, name: 'e2e-box', platform: 'linux', pairingCode: 'E2E', pairingExpires: Date.now() + 60000 });
const token = crypto.randomBytes(32).toString('hex');
store.updateTarget(uid, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });

const runners = createRunnerHub(store, new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 }), { logDir: path.join(dir, 'logs') });
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
server.on('upgrade', (req, socket, head) => { if (!runners.upgrade(req, socket, head, new URL(req.url, 'http://x').pathname)) socket.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const gw = `http://127.0.0.1:${server.address().port}`;

const home = path.join(dir, 'runner-home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'runner.toml'), `gateway = "${gw}"\ntoken = "${token}"\ntarget_id = ${tid}\nname = "e2e-box"\nallowed_roots = ["${WORK}"]\n`);
const runner = spawn(RUNNER_BIN, ['start'], { env: { ...process.env, AIDEV_RUNNER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
let runnerLog = ''; runner.stdout.on('data', (d) => { runnerLog += d; }); runner.stderr.on('data', (d) => { runnerLog += d; });
for (let i = 0; i < 100 && !(runners.online(tid) && JSON.parse(store.target(uid, tid).capabilities ?? '{}').features); i++) await new Promise((r) => setTimeout(r, 100));
assert.ok(runners.online(tid), `runner did not connect: ${runnerLog}`);
const target = store.target(uid, tid);
const avail = await runners.call(tid, 'dap.adapters', {}, 30000);
console.log(`runner online; adapters available here: ${avail.available.join(', ')}`);

const hub = createDebugHub({ store, runners });
const have = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const cases = [
  { name: 'gdb (C)', ok: have('gdb') && fs.existsSync(`${WORK}/c/app`), launch: { adapter: 'gdb', program: 'app', cwd: `${WORK}/c`, breakpoints: [{ path: 'app.c', line: 3 }] }, file: `${WORK}/c/app.c`, line: 3, a: 'a' },
  { name: 'custom (gdb -i=dap over stdio)', ok: have('gdb') && fs.existsSync(`${WORK}/c/app`), launch: { adapter: 'custom', command: 'gdb', commandArgs: ['-i=dap', '-q'], program: 'app', cwd: `${WORK}/c`, breakpoints: [{ path: 'app.c', line: 3 }] }, file: `${WORK}/c/app.c`, line: 3, a: 'a' },
  { name: 'netcoredbg (C#, .NET 8)', ok: fs.existsSync(`${WORK}/cs/app/bin/Debug/net8.0/app.dll`), launch: { adapter: 'netcoredbg', program: 'bin/Debug/net8.0/app.dll', cwd: `${WORK}/cs/app`, breakpoints: [{ path: 'Program.cs', line: 3 }] }, file: `${WORK}/cs/app/Program.cs`, line: 3, a: 'a' },
  { name: 'delve (Go)', ok: have('go') && avail.available.includes('delve'), launch: { adapter: 'delve', program: '.', cwd: `${WORK}/go`, breakpoints: [{ path: 'main.go', line: 6 }] }, file: `${WORK}/go/main.go`, line: 6, a: 'a' },
  { name: 'jvm (Java via JDWP)', ok: have('java') && fs.existsSync(`${WORK}/java/Main.class`), launch: { adapter: 'jvm', mainClass: 'Main', classPath: ['.'], cwd: `${WORK}/java`, breakpoints: [{ path: 'Main.java', line: 3 }] }, file: `${WORK}/java/Main.java`, line: 3, a: 'a' },
  { name: 'jvm package layout (com.acme.App)', ok: have('java') && fs.existsSync(`${WORK}/jpkg/out/com/acme/App.class`), launch: { adapter: 'jvm', mainClass: 'com.acme.App', classPath: ['out'], cwd: `${WORK}/jpkg`, breakpoints: [{ path: 'src/main/java/com/acme/App.java', line: 11 }] }, file: `${WORK}/jpkg/src/main/java/com/acme/App.java`, line: 11, a: 'x' },
  { name: 'mono (C# on Mono)', ok: have('mono') && fs.existsSync(`${WORK}/mono/app.exe`), launch: { adapter: 'mono', program: 'app.exe', cwd: `${WORK}/mono`, breakpoints: [{ path: 'app.cs', line: 4 }] }, file: `${WORK}/mono/app.cs`, line: 4, a: 'a' },
].filter((c) => !only.length || only.some((o) => c.name.startsWith(o)));

let failed = 0;
for (const c of cases) {
  if (!c.ok) { console.log(`SKIP ${c.name}: runtime or sample missing`); continue; }
  const t0 = Date.now();
  let s = null;
  try {
    s = await hub.start(uid, target, validateLaunch(c.launch), { by: 'user' });
    assert.ok(['running', 'paused'].includes(s.state), `${s.state}: ${s.error}`);
    assert.ok(await hub.waitForPause(uid, s.id, 60000), 'no pause within 60 s');
    s = await hub.snapshot(uid, s.id);
    assert.equal(s.state, 'paused', `${s.state}: ${s.error} :: ${s.output.slice(-400)}`);
    const top = s.frames.find((f) => !f.internal) ?? s.frames[0];
    assert.equal(path.basename(top.path ?? ''), path.basename(c.file), `stopped in ${top.path}:${top.line}`);
    assert.equal(top.line, c.line, `stopped at line ${top.line}`);
    assert.ok(s.locals.some((v) => v.name === c.a), `locals: ${JSON.stringify(s.locals)}`);
    let ev = null;
    try { ev = await hub.evaluate(uid, s.id, 'a + b'); } catch (e) { ev = { result: `ERR ${e.message}` }; }
    await hub.control(uid, s.id, 'continue');
    assert.ok(await hub.waitForPause(uid, s.id, 30000));
    s = await hub.snapshot(uid, s.id);
    const second = s.state === 'paused' ? s.locals.find((v) => v.name === 'b')?.value : null;
    await hub.setBreakpoints(uid, s.id, c.launch.breakpoints[0].path, []);
    if (s.state === 'paused') { await hub.control(uid, s.id, 'continue'); await hub.waitForPause(uid, s.id, 30000); }
    for (let i = 0; i < 50 && hub.get(uid, s.id).state !== 'ended'; i++) await new Promise((r) => setTimeout(r, 100));
    s = await hub.snapshot(uid, s.id);
    if (s.state !== 'ended') await hub.stop(uid, s.id);
    console.log(`PASS ${c.name}: paused at ${path.basename(c.file)}:${c.line}, eval a+b=${ev?.result}, 2nd hit b=${second}, end ${s.state}${/total 3|sum 20/.test(s.output) ? ' (program output ok)' : ''} — ${Date.now() - t0}ms`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: ${e.message}${s?.id ? ` :: output ${hub.get(uid, s.id).error ?? ''}` : ''}`);
    if (s?.id) { try { const snap = await hub.snapshot(uid, s.id); console.log(snap.output.slice(-800)); await hub.stop(uid, s.id); } catch { /* ended */ } }
  }
}
hub.close();
runner.kill();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `debug e2e: ${failed} failed` : 'debug e2e: all run adapters passed');
process.exit(failed ? 1 : 0);
