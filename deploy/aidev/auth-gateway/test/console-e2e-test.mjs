// F-09c end to end: the real runner (RUNNER_BIN) + runner-hub + console hub driving command-line debuggers
// in a pty on the "PC": gdb, lldb, jdb, pdb, a Python REPL — prompt detection, line-by-line answers,
// shell-escape refusal, interrupt, stop. Debuggers missing on this machine are skipped.
//   RUNNER_BIN=… DBG_WORK=<dir with c/ java/ samples> node test/console-e2e-test.mjs
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-con-e2e-'));
const { openStore } = await import('../dist/store.js');
const { createRunnerHub, hashToken } = await import('../dist/runner-hub.js');
const { createConsoleHub, plain, shellEscape, DEFAULT_PROMPT } = await import('../dist/console-hub.js');

// ---- pure helpers
assert.equal(plain('\x1b[1m(gdb) \x1b[0m').text, '(gdb) ');
assert.equal(plain('50%\r100%\ndone').text, '100%\ndone');
assert.equal(plain('ab\x08c').text, 'ac');
assert.deepEqual(plain('x\x1b[3'), { text: 'x', carry: '\x1b[3' });
for (const p of ['Delete all breakpoints? (y or n) ', 'Overwrite? [y/N] ', '(gdb) ', '(lldb) ', '(Pdb) ', '> ', 'main[1] ', '0:000> ', '>>> ', 'PS C:\\w> ', 'user@host:~$ ']) assert.ok(DEFAULT_PROMPT.test(p), p);
for (const p of ['Reading symbols from app...', 'total 3']) assert.ok(!DEFAULT_PROMPT.test(p), p);
assert.equal(shellEscape('shell rm -rf /'), 'rm -rf /');
assert.equal(shellEscape('!ls -la'), 'ls -la');
assert.equal(shellEscape('call system("reboot")'), 'reboot');
assert.equal(shellEscape('print a + b'), null);
assert.equal(shellEscape('break app.c:3'), null);
assert.equal(shellEscape('show version'), null);
assert.equal(shellEscape('systemtap'), null);
assert.equal(shellEscape('shell'), '(셸)');
console.log('PASS console helpers: ANSI/CR/backspace, prompts, shell escapes');

const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const tid = store.addTarget({ userId: uid, name: 'con-box', platform: 'linux', pairingCode: 'CON', pairingExpires: Date.now() + 60000 });
const token = crypto.randomBytes(32).toString('hex');
store.updateTarget(uid, tid, { tokenHash: hashToken(token), pairingCode: null, pairingExpires: null });
const runners = createRunnerHub(store, new WebSocketServer({ noServer: true }), { logDir: path.join(dir, 'logs') });
const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
server.on('upgrade', (req, socket, head) => { if (!runners.upgrade(req, socket, head, new URL(req.url, 'http://x').pathname)) socket.destroy(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const home = path.join(dir, 'runner-home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'runner.toml'), `gateway = "http://127.0.0.1:${server.address().port}"\ntoken = "${token}"\ntarget_id = ${tid}\nname = "con-box"\nallowed_roots = ["${WORK}"]\n`);
const runner = spawn(RUNNER_BIN, ['start'], { env: { ...process.env, AIDEV_RUNNER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
let runnerLog = ''; runner.stdout.on('data', (d) => { runnerLog += d; }); runner.stderr.on('data', (d) => { runnerLog += d; });
for (let i = 0; i < 100 && !runners.online(tid); i++) await new Promise((r) => setTimeout(r, 100));
assert.ok(runners.online(tid), `runner did not connect: ${runnerLog}`);
const target = store.target(uid, tid);
const hub = createConsoleHub({ runners });
const have = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };
fs.writeFileSync(path.join(WORK, 'c', 'app.py'), 'def add(a, b):\n    s = a + b\n    return s\n\ntotal = 0\nfor i in range(3):\n    total = add(total, i)\nprint("total", total)\n');

const cases = [
  { name: 'gdb', ok: have('gdb') && fs.existsSync(`${WORK}/c/app`), cmd: 'gdb -q -nx ./app', cwd: `${WORK}/c`, steps: [
    ['break app.c:3', /Breakpoint 1 at/],
    ['run', /Breakpoint 1, add \(a=0, b=0\)/],
    ['print a + b * 10', /\$1 = 0/],
    ['bt', /#1 .*main/],
    ['continue', /Breakpoint 1, add \(a=0, b=1\)/],
    ['delete', /\(y or n\)/],
    ['y', /^$|\(gdb\)/],
    ['continue', /total 3[\s\S]*exited normally/],
  ] },
  { name: 'lldb', ok: have('lldb') && fs.existsSync(`${WORK}/c/app`), cmd: 'lldb --no-lldbinit ./app', cwd: `${WORK}/c`, steps: [
    ['breakpoint set --file app.c --line 3', /Breakpoint 1: where = app`add/],
    ['run', /stop reason = breakpoint 1/],
    ['frame variable a b', /\(int\) a = 0[\s\S]*\(int\) b = 0/],
    ['thread backtrace', /frame #1: .*main/],
    ['breakpoint delete --force', /removed/i],
    ['continue', /exited with status = 0/],
  ] },
  { name: 'jdb', ok: have('jdb') && fs.existsSync(`${WORK}/java/Main.class`), cmd: 'jdb -classpath . Main', cwd: `${WORK}/java`, steps: [
    ['stop at Main:3', /Deferring breakpoint Main:3/],
    ['run', /Breakpoint hit: .*Main\.add\(\), line=3/],
    ['locals', /a = 0[\s\S]*b = 0/],
    ['print a + b', /a \+ b = 0/],
    ['where', /Main\.main/],
    ['clear Main:3', /Removed: breakpoint Main:3/],
    ['cont', /total 3/],
  ] },
  { name: 'pdb', ok: have('python3'), cmd: 'python3 -m pdb app.py', cwd: `${WORK}/c`, steps: [
    ['break app.py:2', /Breakpoint 1 at .*app\.py:2/],
    ['continue', /app\.py\(2\)add\(\)/],
    ['p a, b', /\(0, 0\)/],
    ['clear 1', /Deleted breakpoint 1/],
    ['continue', /total 3/],
    ['quit', /.*/],
  ] },
  { name: 'python REPL (interrupt)', ok: have('python3'), cmd: 'python3 -q -i', cwd: `${WORK}/c`, steps: [
    ['1 + 2', /^3$/m],
    ['import time; time.sleep(60)', null],
  ] },
].filter((c) => !only.length || only.some((o) => c.name.startsWith(o)));

let failed = 0;
for (const c of cases) {
  if (!c.ok) { console.log(`SKIP ${c.name}: not installed or sample missing`); continue; }
  const t0 = Date.now();
  let id = null;
  try {
    const s = await hub.start(uid, target, { cmd: c.cmd, cwd: c.cwd }, { by: 'user', waitMs: 20000 });
    id = s.id;
    assert.equal(s.state, 'running', `${s.state}: ${s.output}`);
    assert.ok(s.atPrompt, `no prompt after start (${s.waited}): ${JSON.stringify(s.output.slice(-300))}`);
    await assert.rejects(hub.send(uid, id, 'shell rm -rf /tmp/nothing-here'), /remote_exec/);
    for (const [input, expect] of c.steps) {
      const r = await hub.send(uid, id, input, { waitMs: expect ? 30000 : 1500 });
      if (expect) assert.match(r.output, expect, `${input} → (${r.waited}) ${JSON.stringify(r.output.slice(-600))}`);
    }
    if (c.name.startsWith('python')) {
      const r = await hub.interrupt(uid, id);
      assert.match(r.output, /KeyboardInterrupt/, `interrupt: ${JSON.stringify(r.output)}`);
      assert.ok(r.atPrompt);
    }
    const end = await hub.stop(uid, id);
    assert.equal(end.state, 'ended');
    console.log(`PASS ${c.name}: prompt → ${c.steps.length} commands answered, shell escape refused, stop — ${Date.now() - t0}ms`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: ${e.message}`);
    if (id) { try { console.log(hub.transcript(uid, id).output.slice(-1500)); await hub.stop(uid, id); } catch { /* ended */ } }
  }
}
hub.close();
runner.kill();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `console e2e: ${failed} failed` : 'console e2e: all run consoles passed');
process.exit(failed ? 1 : 0);
