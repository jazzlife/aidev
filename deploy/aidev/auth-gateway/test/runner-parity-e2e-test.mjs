// Runner parity with SSH / WinRM / adb (2026-10-02): the real runner (RUNNER_BIN) on this machine connected to a real
// runner-hub, checked end to end on whatever OS runs it — macOS here, Windows and Linux in CI (runner-e2e.yml):
//   shells (default, PowerShell, bash) with UTF-8 output and real exit codes · a stop ends the whole process tree ·
//   fs.pull copies any file (binary, > one chunk) and nothing outside the allowed folders · adb from the Android SDK
//   folder works in a command · capabilities report shells and admin rights.
//   RUNNER_BIN=… node test/runner-parity-e2e-test.mjs   (after npm run build)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const RUNNER_BIN = process.env.RUNNER_BIN;
if (!RUNNER_BIN) { console.log('SKIP: RUNNER_BIN not set'); process.exit(0); }
const WIN = process.platform === 'win32';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-parity-'));
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-parity-work-')));
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken } = await import('../dist/runner-hub.js');
const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const tid = store.addTarget({ userId: uid, name: 'parity-box', platform: process.platform, pairingCode: 'E2E', pairingExpires: Date.now() + 60000 });
const token = crypto.randomBytes(32).toString('hex');
store.updateTarget(uid, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });

const runners = createRunnerHub(store, new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 }), { logDir: path.join(dir, 'logs') });
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
server.on('upgrade', (req, socket, head) => { if (!runners.upgrade(req, socket, head, new URL(req.url, 'http://x').pathname)) socket.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// Unix: a stand-in adb in a fake Android SDK, off PATH (SHELL=/bin/sh keeps the user's rc PATH out) — a command must
// still find it. Windows: the machine's own SDK when there is one (GitHub's image has it).
const home = path.join(dir, 'runner-home');
fs.mkdirSync(home, { recursive: true });
const sdk = path.join(dir, 'android-sdk');
const runnerEnv = { ...process.env, AIDEV_RUNNER_HOME: home };
if (!WIN) {
  fs.mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'platform-tools', 'adb'), '#!/bin/sh\ncase "$1" in\n  version) echo "Android Debug Bridge version 1.0.41 (parity stand-in)";;\n  devices) printf "List of devices attached\\nemulator-5554\\tdevice\\n";;\n  *) echo "adb $*";;\nesac\n', { mode: 0o755 });
  // keep pwsh reachable where it is installed (Homebrew, /usr/bin on GitHub's Ubuntu) so PowerShell is checked too
  const pwshDir = (process.env.PATH ?? '').split(':').find((d) => d && fs.existsSync(path.join(d, 'pwsh')));
  Object.assign(runnerEnv, { ANDROID_HOME: sdk, SHELL: '/bin/sh', PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', path.dirname(process.execPath), pwshDir].filter(Boolean).join(':') });
  delete runnerEnv.ANDROID_SDK_ROOT;
}
const toml = (s) => `'${s}'`;   // literal strings: Windows backslashes stay as they are
fs.writeFileSync(path.join(home, 'runner.toml'), `gateway = "http://127.0.0.1:${server.address().port}"\ntoken = "${token}"\ntarget_id = ${tid}\nname = "parity-box"\nallowed_roots = [${toml(WORK)}]\n`);
const runner = spawn(RUNNER_BIN, ['start'], { env: runnerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let runnerLog = ''; runner.stdout.on('data', (d) => { runnerLog += d; }); runner.stderr.on('data', (d) => { runnerLog += d; });
for (let i = 0; i < 200 && !(runners.online(tid) && JSON.parse(store.target(uid, tid).capabilities ?? '{}').features); i++) await new Promise((r) => setTimeout(r, 100));
assert.ok(runners.online(tid), `runner did not connect: ${runnerLog}`);
const caps = JSON.parse(store.target(uid, tid).capabilities);
console.log(`runner ${caps.runner} on ${caps.os}/${caps.arch}: shells=${JSON.stringify(caps.shells)} admin=${JSON.stringify(caps.admin)} adb=${caps.tools?.adb ?? '-'}`);

let failed = 0;
const check = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); console.log(`PASS ${name} (${Date.now() - t0}ms)`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`); }
};
/** A command through the hub (as remote_exec runs it) → { code, out }. */
const run = async (cmd, extra = {}, waitMs = 60000) => {
  const st = await runners.exec(tid, uid, { cmd, cwd: WORK, ...extra }, { approvedBy: 'user' });
  const done = await runners.waitRun(st.remoteRunId, waitMs);
  assert.ok(done && !done.running, `still running after ${waitMs}ms: ${cmd}`);
  return { code: done.code, signal: done.signal, out: runners.tail(tid, st.streamId).toString('utf8') };
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

await check('capabilities: shells, admin, features', async () => {
  assert.ok(caps.features.includes('shell') && caps.features.includes('pull'), JSON.stringify(caps.features));
  assert.ok(Array.isArray(caps.shells) && caps.shells.length, 'shells');
  assert.equal(typeof caps.admin?.elevated, 'boolean');
  if (WIN) assert.ok(caps.shells.includes('cmd') && caps.shells.includes('powershell'));
  else assert.ok(caps.shells.includes('sh'));
});

await check('default shell: UTF-8 output and the exit code', async () => {
  const r = await run(WIN ? 'echo 한글 ok& exit /b 6' : "printf '한글 ok\\n'; exit 6");
  assert.ok(r.out.includes('한글 ok'), JSON.stringify(r.out));
  assert.equal(r.code, 6);
});

await check('PowerShell: UTF-8, quotes, pipes, cmdlet failure = 1, native code kept', async () => {
  if (!caps.shells.includes('powershell')) { console.log('  (no PowerShell here)'); return; }
  let r = await run(`$x = 'a"b'; Write-Output "한글 $x $(1+1)" | ForEach-Object { $_ }`, { shell: 'powershell' });
  assert.ok(r.out.includes('한글 a"b 2'), JSON.stringify(r.out));
  assert.equal(r.code, 0);
  r = await run('Get-Item ./definitely-missing', { shell: 'powershell' });
  assert.equal(r.code, 1, r.out);
  r = await run(WIN ? 'cmd /c exit 5' : "sh -c 'exit 5'", { shell: 'powershell' });
  assert.equal(r.code, 5);
  if (WIN) {
    r = await run("(Get-CimInstance Win32_OperatingSystem).Caption; (Get-Service | Measure-Object).Count -gt 0; (Get-WinEvent -LogName System -MaxEvents 1).Id -ge 0; 'cim-ok'", { shell: 'powershell' });
    assert.ok(r.out.includes('Windows') && r.out.includes('cim-ok'), r.out);
    assert.equal(r.code, 0, r.out);
  }
});

await check('bash: arithmetic and exit code', async () => {
  if (!caps.shells.includes('bash')) { console.log('  (no bash here)'); return; }
  const r = await run('echo $((40+2)); exit 3', { shell: 'bash' });
  assert.ok(r.out.includes('42'), r.out);
  assert.equal(r.code, 3);
});

await check('stop ends the whole process tree (shell → node grandchild)', async () => {
  const pidFile = path.join(WORK, 'gc.pid');
  const node = JSON.stringify(process.execPath);
  const js = "require('fs').writeFileSync('gc.pid', String(process.pid)); setInterval(() => {}, 1000)";
  // `; echo after` keeps the shell waiting, so node is a grandchild and not exec'd in its place
  const cmd = WIN ? `${node} -e "${js}" & echo after` : `${node} -e "${js}"; echo after`;
  const st = await runners.exec(tid, uid, { cmd, cwd: WORK }, { approvedBy: 'user' });
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(child), 'grandchild started');
  await runners.control(tid, st.streamId, 'signal', { signal: 'TERM' });
  const done = await runners.waitRun(st.remoteRunId, 20000);
  assert.ok(done && !done.running, 'command ended');
  for (let i = 0; i < 50 && alive(child); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(child), `grandchild ${child} still running after the stop`);
});

await check('fs.pull: a binary file over one chunk, byte for byte; nothing outside the allowed folders', async () => {
  const data = crypto.randomBytes(4 * 1024 * 1024 + 12345);
  fs.mkdirSync(path.join(WORK, 'out'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'out', 'app.bin'), data);
  const parts = []; let offset = 0; let first = null;
  for (;;) {
    const r = await runners.call(tid, 'fs.pull', { path: 'out/app.bin', offset }, 30000);
    first ??= r;
    const chunk = Buffer.from(r.b64, 'base64'); parts.push(chunk); offset += chunk.length;
    if (r.eof) break;
  }
  assert.equal(parts.length, 2);
  assert.ok(Buffer.concat(parts).equals(data));
  assert.equal(first.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  await assert.rejects(runners.call(tid, 'fs.pull', { path: path.join(dir, 'auth.db') }, 10000), /허용|allowed/);
});

await check('adb from the SDK folder works in a command', async () => {
  if (!caps.tools?.adb) { console.log('  (no adb on this machine)'); return; }
  const r = await run('adb version');
  assert.equal(r.code, 0, r.out);
  assert.ok(/Android Debug Bridge/.test(r.out), r.out);
  if (!WIN) assert.ok(r.out.includes('parity stand-in'), 'the SDK-folder adb, not one on PATH');
});

runner.kill();
server.close();
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `runner parity: ${failed} FAILED` : 'runner parity: all checks passed');
process.exit(failed ? 1 : 0);
