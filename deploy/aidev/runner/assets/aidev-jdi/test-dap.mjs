// aidev-jdi protocol test: drives the adapter over stdio against real programs.
//   node test-dap.mjs <work dir with jflat/ and jpkg/ samples>   (needs a JDK ≥ 11 on PATH)
// jflat/Main.java — default package in a folder not named java; jpkg/ — package com.acme, nested class, lambda.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const W = process.argv[2] ?? '/tmp/claude-0/dbgwork';

function adapter() {
  const p = spawn('java', ['-jar', path.join(here, 'aidev-jdi.jar')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0); let seq = 1; const pending = new Map(); const events = []; const waiters = [];
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const h = buf.indexOf('\r\n\r\n'); if (h < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())[1]);
      if (buf.length < h + 4 + len) return;
      const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString()); buf = buf.subarray(h + 4 + len);
      if (msg.type === 'response') { const q = pending.get(msg.request_seq); pending.delete(msg.request_seq); msg.success ? q.resolve(msg.body ?? {}) : q.reject(new Error(`${msg.command}: ${msg.message}`)); }
      else if (msg.type === 'event') { events.push(msg); for (const w of [...waiters]) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } }
    }
  });
  const req = (command, args) => new Promise((resolve, reject) => { const s = seq++; pending.set(s, { resolve, reject }); const t = JSON.stringify({ seq: s, type: 'request', command, arguments: args }); p.stdin.write(`Content-Length: ${Buffer.byteLength(t)}\r\n\r\n${t}`); });
  const wait = (name, ms = 20000, pred = () => true) => {
    const idx = events.findIndex((e) => e.event === name && pred(e) && !e.used);
    if (idx >= 0) { events[idx].used = true; return Promise.resolve(events[idx]); }
    return new Promise((resolve, reject) => { const w = { test: (e) => e.event === name && pred(e) && (e.used = true), resolve }; waiters.push(w); setTimeout(() => reject(new Error(`no ${name} in ${ms}ms; stderr: ${err.slice(-500)}; events: ${events.map((e) => e.event).join(',')}`)), ms).unref(); });
  };
  const output = () => events.filter((e) => e.event === 'output').map((e) => e.body.output).join('');
  return { p, req, wait, output };
}

async function top(d, threadId) {
  const st = await d.req('stackTrace', { threadId, levels: 20 });
  return { frame: st.stackFrames[0], frames: st.stackFrames };
}
async function locals(d, frameId) {
  const sc = await d.req('scopes', { frameId });
  const v = await d.req('variables', { variablesReference: sc.scopes[0].variablesReference });
  return Object.fromEntries(v.variables.map((x) => [x.name, x]));
}

// 1. default package, folder not named java; breakpoint before launch; evaluate; conditional; exit code
{
  const d = adapter();
  const caps = await d.req('initialize', { adapterID: 'jvm', linesStartAt1: true, pathFormat: 'path' });
  assert.ok(caps.supportsConfigurationDoneRequest);
  await d.wait('initialized');
  const bp = await d.req('setBreakpoints', { source: { path: `${W}/jflat/Main.java` }, breakpoints: [{ line: 3, condition: 'a == 1' }] });
  assert.equal(bp.breakpoints[0].verified, false);
  await d.req('setExceptionBreakpoints', { filters: ['uncaught'] });
  await d.req('launch', { mainClass: 'Main', classPath: ['.'], cwd: `${W}/jflat` });
  await d.req('configurationDone');
  const verified = await d.wait('breakpoint', 20000, (e) => e.body.breakpoint.verified);
  assert.equal(verified.body.breakpoint.line, 3);
  const st = await d.wait('stopped');
  assert.equal(st.body.reason, 'breakpoint');
  const { frame, frames } = await top(d, st.body.threadId);
  assert.equal(frame.source.path, `${W}/jflat/Main.java`); assert.equal(frame.line, 3); assert.match(frame.name, /Main\.add\(int, int\)/);
  assert.equal(frames[1].line, 8);
  const l = await locals(d, frame.id);
  assert.equal(l.a.value, '1', `condition a == 1 → ${JSON.stringify(l)}`);
  assert.equal((await d.req('evaluate', { expression: 'a + b * 10', frameId: frame.id, context: 'watch' })).result, '21');
  assert.equal((await d.req('evaluate', { expression: '"x" + a + Integer.toHexString(255)', frameId: frame.id })).result, '"x1ff"');
  assert.equal((await d.req('evaluate', { expression: 'Math.max(a, 9) > 8 && !false', frameId: frame.id })).result, 'true');
  await assert.rejects(d.req('evaluate', { expression: 'nope + 1', frameId: frame.id }), /nope/);
  await d.req('setVariable', { variablesReference: (await d.req('scopes', { frameId: frame.id })).scopes[0].variablesReference, name: 'b', value: '100' });
  await d.req('setBreakpoints', { source: { path: `${W}/jflat/Main.java` }, breakpoints: [] });
  await d.req('continue', { threadId: st.body.threadId });
  const ex = await d.wait('exited');
  await d.wait('terminated');
  assert.equal(ex.body.exitCode, 0);
  assert.match(d.output(), /total 101/, `setVariable b=100 changes the total: ${d.output()}`);
  await d.req('disconnect', {});
  console.log('PASS default package: conditional bp, stack, locals, evaluate (+call), setVariable, exit code');
}

// 2. package layout: nested class, lambda, statics, stepping, collection display, exception stop
{
  const d = adapter();
  await d.req('initialize', { adapterID: 'jvm' });
  const src = `${W}/jpkg/src/main/java/com/acme/App.java`;
  await d.req('setBreakpoints', { source: { path: src }, breakpoints: [{ line: 8 }, { line: 20 }, { line: 22 }] });
  await d.req('setExceptionBreakpoints', { filters: ['uncaught'] });
  await d.req('launch', { mainClass: 'com.acme.App', classPath: ['out'], cwd: `${W}/jpkg`, args: ['zz'] });
  await d.req('configurationDone');
  let st = await d.wait('stopped');
  let { frame } = await top(d, st.body.threadId);
  assert.equal(frame.line, 8); assert.match(frame.name, /Box\.<init>/); assert.equal(frame.source.path, src);
  await d.req('setBreakpoints', { source: { path: src }, breakpoints: [{ line: 20 }, { line: 22 }] });
  await d.req('continue', { threadId: st.body.threadId });
  st = await d.wait('stopped');
  ({ frame } = await top(d, st.body.threadId));
  assert.equal(frame.line, 20);
  const l = await locals(d, frame.id);
  assert.match(l.list.value, /ArrayList size=5/); assert.equal(l.b.type, 'com.acme.App$Box');
  const box = await d.req('variables', { variablesReference: l.b.variablesReference });
  assert.deepEqual(box.variables.map((v) => `${v.name}=${v.value}`), ['v=0', 'tag="b0"']);
  assert.equal((await d.req('evaluate', { expression: 'list.size() + counter', frameId: frame.id })).result, '12');
  assert.equal((await d.req('evaluate', { expression: 'list.get(2).tag', frameId: frame.id })).result, '"b2"');
  assert.equal((await d.req('evaluate', { expression: 'App.counter', frameId: frame.id })).result, '7');
  await d.req('stepIn', { threadId: st.body.threadId });
  st = await d.wait('stopped'); assert.equal(st.body.reason, 'step');
  ({ frame } = await top(d, st.body.threadId));
  assert.match(frame.name, /App\.twice/); assert.equal(frame.line, 11);
  await d.req('next', { threadId: st.body.threadId });
  st = await d.wait('stopped'); ({ frame } = await top(d, st.body.threadId)); assert.equal(frame.line, 12);
  assert.equal((await locals(d, frame.id)).r.value, '0');
  await d.req('stepOut', { threadId: st.body.threadId });
  st = await d.wait('stopped'); ({ frame } = await top(d, st.body.threadId)); assert.equal(frame.line, 20); assert.match(frame.name, /main/);
  await d.req('setBreakpoints', { source: { path: src }, breakpoints: [{ line: 22 }] });
  await d.req('continue', { threadId: st.body.threadId });
  st = await d.wait('stopped'); ({ frame } = await top(d, st.body.threadId)); assert.equal(frame.line, 22); assert.match(frame.name, /main/);
  await d.req('continue', { threadId: st.body.threadId });
  st = await d.wait('stopped'); ({ frame } = await top(d, st.body.threadId)); assert.equal(frame.line, 22); assert.match(frame.name, /lambda\$main/);
  await d.req('continue', { threadId: st.body.threadId });
  st = await d.wait('stopped'); assert.equal(st.body.reason, 'exception'); assert.match(st.body.description, /IllegalStateException: boom zz/);
  const info = await d.req('exceptionInfo', { threadId: st.body.threadId }); assert.equal(info.exceptionId, 'java.lang.IllegalStateException');
  await d.req('continue', { threadId: st.body.threadId });
  const ex = await d.wait('exited'); assert.equal(ex.body.exitCode, 1);
  assert.match(d.output(), /lambda sum 7[\s\S]*sum 20/);
  await d.req('disconnect', {});
  console.log('PASS package layout: nested ctor, lambda, statics, stepIn/next/stepOut, collections, calls, uncaught exception');
}

// 3. attach to a JVM someone else started (suspend=y), pause, disconnect without killing
{
  const port = 47000 + Math.floor(Math.random() * 1000);
  const prog = spawn('java', [`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port}`, '-cp', 'out', 'com.acme.App'], { cwd: `${W}/jpkg`, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; prog.stdout.on('data', (x) => { out += x; });
  await new Promise((r) => setTimeout(r, 800));
  const d = adapter();
  await d.req('initialize', { adapterID: 'jvm' });
  await d.req('setBreakpoints', { source: { path: `${W}/jpkg/src/main/java/com/acme/App.java` }, breakpoints: [{ line: 11 }] });
  await d.req('attach', { hostName: '127.0.0.1', port, cwd: `${W}/jpkg` });
  await d.req('configurationDone');
  const st = await d.wait('stopped');
  const { frame } = await top(d, st.body.threadId);
  assert.equal(frame.line, 11);
  assert.equal((await locals(d, frame.id)).x.value, '0');
  await d.req('disconnect', { terminateDebuggee: false });
  const code = await new Promise((r) => prog.on('exit', r));
  assert.equal(code, 3); assert.match(out, /sum 20/);
  console.log('PASS attach: breakpoint in an already-started suspended JVM, detach lets it finish');
}
process.exit(0);
