// F-09: the gateway's DAP client against the real adapters (js-debug, debugpy, codelldb), with a stand-in
// for the runner that starts them locally. Launch with breakpoints → pause → stack/locals/evaluate →
// step → breakpoint changes → continue to the end (exit code, output, remote run row).
//   DAP_ADAPTERS=<dir with js-debug/, dp/ (debugpy), cl/extension/> node test/debug-hub-test.mjs   (after npm run build)
// Skips an adapter whose files or language runtime are missing.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const A = process.env.DAP_ADAPTERS ?? '/tmp/claude-0/dap';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-debug-'));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-debug-work-')));
const { openStore } = await import('../dist/store.js');
const { createDebugHub, validateLaunch, launchCommand, launchConfig, targetPath } = await import('../dist/debug-hub.js');
const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const tid = store.addTarget({ userId: uid, name: 'dev-box', platform: 'linux', pairingCode: 'X', pairingExpires: Date.now() + 60000 });
store.updateTarget(uid, tid, { status: 'online' });
const target = store.target(uid, tid);

fs.writeFileSync(path.join(work, 'app.js'), 'function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nlet total = 0;\nfor (let i = 0; i < 3; i++) total = add(total, i);\nconsole.log("total", total);\nprocess.exitCode = total === 3 ? 0 : 1;\n');
fs.writeFileSync(path.join(work, 'app.py'), 'import sys\n\ndef add(a, b):\n    s = a + b\n    return s\n\ntotal = 0\nfor i in range(3):\n    total = add(total, i)\nprint("total", total)\nsys.exit(0 if total == 3 else 1)\n');
fs.writeFileSync(path.join(work, 'app.c'), '#include <stdio.h>\nint add(int a, int b) {\n  int sum = a + b;\n  return sum;\n}\nint main(void) {\n  int total = 0;\n  for (int i = 0; i < 3; i++) total = add(total, i);\n  printf("total %d\\n", total);\n  return total == 3 ? 0 : 1;\n}\n');
let haveCc = true;
try { execFileSync('cc', ['-g', '-O0', '-o', path.join(work, 'app'), path.join(work, 'app.c')]); } catch { haveCc = false; }

// ---- runner stand-in: starts the adapter here, tunnels are plain TCP ----------------------------------
const procs = new Map(); let nextId = 0;
const free = () => new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });
const commands = {
  'js-debug': (port) => ['node', [path.join(A, 'jsd/js-debug/src/dapDebugServer.js'), String(port), '127.0.0.1'], {}],
  debugpy: (port) => ['python3', ['-m', 'debugpy.adapter', '--host', '127.0.0.1', '--port', String(port)], { PYTHONPATH: path.join(A, 'dp') }],
  codelldb: (port) => [path.join(A, 'cl/extension/adapter/codelldb'), ['--port', String(port)], {}],
};
const runners = {
  online: () => true,
  requireFeature: () => undefined,
  async call(_t, method, p) {
    if (method === 'dap.stop') { procs.get(p.id)?.kill(); procs.delete(p.id); return { ok: true }; }
    if (method !== 'dap.start') throw new Error(method);
    const port = await free();
    const [cmd, args, env] = commands[p.adapter](port);
    const child = spawn(cmd, args, { cwd: p.cwd ?? work, env: { ...process.env, ...env }, stdio: 'ignore' });
    const id = ++nextId; procs.set(id, child);
    for (let i = 0; i < 100; i++) { if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) break; await new Promise((r) => setTimeout(r, 100)); }
    return { id, port, version: 'test', cwd: p.cwd ?? work, program: p.program ? path.resolve(p.cwd ?? work, p.program) : null };
  },
  openTunnel: (_t, port) => new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1', () => resolve(s)); s.on('error', reject); }),
};
// debugpy and codelldb serve one client: the stand-in's readiness probe would use it up, so it waits without
// connecting for those (the real runner checks by binding the port)
const probeFree = { debugpy: true, codelldb: true };
const origCall = runners.call;
runners.call = async (t, method, p) => {
  if (method === 'dap.start' && probeFree[p.adapter]) {
    const port = await free();
    const [cmd, args, env] = commands[p.adapter](port);
    const child = spawn(cmd, args, { cwd: p.cwd ?? work, env: { ...process.env, ...env }, stdio: 'ignore' });
    const id = ++nextId; procs.set(id, child);
    for (let i = 0; i < 100; i++) { const busy = await new Promise((r) => { const srv = net.createServer(); srv.once('error', () => r(true)); srv.listen(port, '127.0.0.1', () => srv.close(() => r(false))); }); if (busy) break; await new Promise((r) => setTimeout(r, 100)); }
    return { id, port, version: 'test', cwd: p.cwd ?? work, program: p.program ? path.resolve(p.cwd ?? work, p.program) : null };
  }
  return origCall(t, method, p);
};

// ---- pure helpers ------------------------------------------------------------------------------------
assert.equal(targetPath('/w/p', 'src/a.js'), '/w/p/src/a.js');
assert.equal(targetPath('C:\\w\\p', 'a.js'), 'C:\\w\\p\\a.js');
assert.equal(targetPath('/w', '/abs/a.js'), '/abs/a.js');
assert.equal(launchCommand(validateLaunch({ adapter: 'debugpy', module: 'pytest', args: ['-k', 'my test'] })), "python3 -m pytest -k 'my test'");
assert.equal(launchCommand(validateLaunch({ adapter: 'js-debug', runtimeExecutable: 'npm', runtimeArgs: ['test'] })), 'npm test');
assert.throws(() => validateLaunch({ adapter: 'gdb9000', program: 'x' }), /adapter/);
assert.throws(() => validateLaunch({ adapter: 'jvm', program: 'app.py' }), /jar/);
assert.throws(() => validateLaunch({ adapter: 'jvm', mainClass: 'a;rm' }), /mainClass/);
assert.throws(() => validateLaunch({ adapter: 'gdb', request: 'attach' }), /pid or address/);
assert.equal(launchCommand(validateLaunch({ adapter: 'jvm', mainClass: 'com.acme.App', classPath: ['out', 'lib/x.jar'], args: ['a b'] })), "java -cp out:lib/x.jar com.acme.App 'a b'");
assert.equal(launchCommand(validateLaunch({ adapter: 'jvm', program: 'build/app.jar' })), 'java -jar build/app.jar');
assert.deepEqual(launchConfig(validateLaunch({ adapter: 'jvm', request: 'attach', address: '10.0.0.5:5005' }), null, '/w'), { name: 'aidev', request: 'attach', cwd: '/w', hostName: '10.0.0.5', port: 5005, timeout: 30000 });
assert.equal(launchConfig(validateLaunch({ adapter: 'jvm', program: 'app.jar' }), '/w/app.jar', '/w').jar, '/w/app.jar');
assert.equal(launchConfig(validateLaunch({ adapter: 'gdb', request: 'attach', address: 'localhost:3333', program: 'fw.elf' }), '/w/fw.elf', '/w').target, 'localhost:3333');
assert.throws(() => validateLaunch({ adapter: 'js-debug', runtimeExecutable: 'bash' }), /runtimeExecutable/);
assert.throws(() => validateLaunch({ adapter: 'debugpy', module: 'os; rm' }), /module/);
assert.throws(() => validateLaunch({ adapter: 'codelldb' }), /program/);
console.log('PASS launch validation, command line, path mapping');

const hub = createDebugHub({ store, runners });
const cases = [
  { adapter: 'js-debug', file: 'app.js', line: 2, program: 'app.js', a: 'a', ok: fs.existsSync(path.join(A, 'jsd')) },
  { adapter: 'debugpy', file: 'app.py', line: 4, program: 'app.py', a: 'a', ok: fs.existsSync(path.join(A, 'dp/debugpy')) },
  { adapter: 'codelldb', file: 'app.c', line: 3, program: 'app', a: 'a', ok: haveCc && fs.existsSync(path.join(A, 'cl/extension/adapter/codelldb')) },
];
for (const c of cases) {
  if (!c.ok) { console.log(`SKIP ${c.adapter} (adapter or compiler missing)`); continue; }
  const t0 = Date.now();
  let s = await hub.start(uid, target, validateLaunch({ adapter: c.adapter, program: c.program, cwd: work, breakpoints: [{ path: c.file, line: c.line }] }), { by: 'user' });
  assert.ok(['running', 'paused'].includes(s.state), `${c.adapter}: ${s.state} ${s.error}`);
  assert.ok(await hub.waitForPause(uid, s.id, 20000), `${c.adapter}: no pause`);
  s = await hub.snapshot(uid, s.id);
  assert.equal(s.state, 'paused', `${c.adapter}: ${s.state} ${s.error}`);
  assert.equal(s.stopped.reason, 'breakpoint');
  const top = s.frames.find((f) => !f.internal);
  assert.equal(top.path, path.join(work, c.file)); assert.equal(top.line, c.line);
  assert.ok(s.locals.some((v) => v.name === 'a' && v.value === '0'), `${c.adapter} locals: ${JSON.stringify(s.locals)}`);
  assert.ok(s.breakpoints[0].verified, `${c.adapter} bp: ${JSON.stringify(s.breakpoints)}`);
  const ev = await hub.evaluate(uid, s.id, 'a + b');
  assert.equal(ev.result, '0', `${c.adapter} eval: ${JSON.stringify(ev)}`);
  // continue → the same breakpoint again with a = 0, b = 1
  await hub.control(uid, s.id, 'continue');
  assert.ok(await hub.waitForPause(uid, s.id, 10000));
  s = await hub.snapshot(uid, s.id);
  assert.ok(s.locals.some((v) => v.name === 'b' && v.value === '1'), `${c.adapter} second stop: ${JSON.stringify(s.locals)}`);
  // step over one line
  await hub.control(uid, s.id, 'next');
  assert.ok(await hub.waitForPause(uid, s.id, 10000));
  s = await hub.snapshot(uid, s.id);
  assert.equal(s.stopped.reason, 'step'); assert.equal(s.frames.find((f) => !f.internal).line, c.line + 1);
  // remove the breakpoint and run to the end
  const bps = await hub.setBreakpoints(uid, s.id, c.file, []);
  assert.equal(bps.length, 0);
  await hub.control(uid, s.id, 'continue');
  assert.ok(await hub.waitForPause(uid, s.id, 15000));
  for (let i = 0; i < 30 && hub.get(uid, s.id).state !== 'ended'; i++) await new Promise((r) => setTimeout(r, 100));
  s = await hub.snapshot(uid, s.id);
  assert.equal(s.state, 'ended', `${c.adapter}: ${s.state}`);
  assert.match(s.output, /total 3/);
  const run = store.remoteRunById(uid, s.remoteRunId);
  assert.equal(run.kind, 'debug'); assert.ok(run.finished_at > 0);
  if (c.adapter !== 'js-debug') assert.equal(run.exit_code, 0, `${c.adapter} exit ${run.exit_code}`);
  const events = await hub.events(uid, s.id, 0, 0);
  assert.ok(events.events.some((e) => e.type === 'state' && e.state === 'paused' && e.location?.line === c.line));
  console.log(`PASS ${c.adapter}: breakpoint → locals a=0 → eval a+b → continue (b=1) → step → clear → ran to the end, output "total 3" (${Date.now() - t0}ms)`);
}

// stop a paused session; unknown program; ownership
const js = cases[0];
if (js.ok) {
  const s = await hub.start(uid, target, validateLaunch({ adapter: 'js-debug', program: 'app.js', cwd: work, stopOnEntry: true }), { by: 'user' });
  assert.ok(await hub.waitForPause(uid, s.id, 20000));
  assert.throws(() => hub.get(uid + 1, s.id), /없습니다/);
  const v = await hub.stop(uid, s.id);
  assert.equal(v.state, 'ended');
  await assert.rejects(hub.control(uid, s.id, 'continue'), /끝났습니다/);
  console.log('PASS stopOnEntry pause → stop ends it; other users cannot see it');
}
hub.close();
for (const p of procs.values()) p.kill();
fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true });
console.log('debug hub: all checks passed');
process.exit(0);
