import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

/**
 * remote_exec (F-05) against a fake gateway: target resolution, the approval long-poll, the result
 * long-poll, background mode and the refusal paths. The service reads its platform env at import,
 * so it is imported after the fake gateway is listening.
 */
type Handler = (method: string, path: string, body: Record<string, unknown>) => unknown;
let handler: Handler = () => ({});
const calls: string[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    const path = (req.url ?? '').replace(/^\/internal\/aidev/, '');
    calls.push(`${req.method} ${path}`);
    assert.equal(req.headers['x-aidev-runtime'], 'rt-test');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(handler(req.method ?? 'GET', path, body)));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.AIDEV_RUNTIME = 'rt-test';
process.env.AIDEV_GATEWAY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.JWT_SECRET = 'x'.repeat(48);
const { aidevToolsService } = await import('@/modules/aidev-tools/aidev-tools.service.js');
test.after(() => server.close());

const targets = { targets: [{ id: 7, name: 'm4pro', online: true, platform: 'macos', policy: 'ask' }, { id: 8, name: 'win-box', online: false, platform: 'windows', policy: 'ask' }] };
const finished = (id: number, code: number, output: string) => ({ run: { id, finished_at: Date.now(), exit_code: code, started_at: Date.now() - 900, artifacts: { duration_ms: 900, signal: null }, live: { running: false, signal: null } }, output });

test('safe command: runs on the only online target and returns exit code + output', async () => {
  calls.length = 0;
  let sent: Record<string, unknown> = {};
  handler = (method, path, body) => {
    if (path === '/targets') return targets;
    if (path === '/targets/7/exec') { sent = body; return { status: 'started', stream: { remoteRunId: 31 } }; }
    if (path.startsWith('/remote-runs/31/wait')) return finished(31, 0, '3 passing\n');
    throw new Error(`unexpected ${method} ${path}`);
  };
  const r = await aidevToolsService.remoteExec({ cmd: 'npm test' }, { runId: 99, agent: 'testing' });
  assert.equal(r.status, 'finished');
  assert.equal(r.exitCode, 0);
  assert.equal(r.target, 'm4pro');
  assert.equal(r.approvedBy, 'auto');
  assert.match(r.output ?? '', /3 passing/);
  assert.equal(sent.runId, 99);
  assert.equal(sent.agent, 'testing');
});

test('risky command: waits for the approval, then for the result', async () => {
  let polls = 0;
  handler = (_method, path) => {
    if (path === '/targets') return targets;
    if (path === '/targets/7/exec') return { status: 'pending', approval: { id: 'apprv0001', risk: 2, reasons: ['파일 삭제'] } };
    if (path.startsWith('/approvals/apprv0001/wait')) return { approval: ++polls < 2 ? { status: 'pending', remoteRunId: null, error: null } : { status: 'allowed', remoteRunId: 32, error: null } };
    if (path.startsWith('/remote-runs/32/wait')) return finished(32, 0, 'removed\n');
    throw new Error(`unexpected ${path}`);
  };
  const r = await aidevToolsService.remoteExec({ target: 'M4PRO', cmd: 'rm -rf build' });
  assert.equal(polls, 2);
  assert.equal(r.status, 'finished');
  assert.equal(r.approvedBy, 'user');
  assert.equal(r.remoteRunId, 32);
});

test('denied by the user or by policy, offline target, unknown target', async () => {
  handler = (_method, path) => {
    if (path === '/targets') return targets;
    if (path === '/targets/7/exec') return { status: 'pending', approval: { id: 'apprv0002', risk: 2, reasons: ['sudo'] } };
    if (path.startsWith('/approvals/apprv0002/wait')) return { approval: { status: 'denied', remoteRunId: 40, error: null } };
    if (path === '/targets/8/exec') return { status: 'offline', error: 'win-box offline' };
    throw new Error(`unexpected ${path}`);
  };
  const denied = await aidevToolsService.remoteExec({ cmd: 'sudo ls' });
  assert.equal(denied.status, 'denied');
  assert.match(denied.message ?? '', /거부/);
  const offline = await aidevToolsService.remoteExec({ target: 'win-box', cmd: 'dir' });
  assert.equal(offline.status, 'offline');
  await assert.rejects(aidevToolsService.remoteExec({ target: 'nope', cmd: 'ls' }), /등록된 대상: m4pro, win-box \(offline\)/);
});

test('background: returns while running; remote_logs and remote_stop follow up', async () => {
  const running = { run: { id: 50, finished_at: null, exit_code: null, started_at: Date.now() - 5000, artifacts: null, live: { running: true, signal: null } }, output: 'VITE ready on http://localhost:5173\n' };
  const waits: string[] = [];
  handler = (method, path) => {
    if (path === '/targets') return targets;
    if (path === '/targets/7/exec') return { status: 'started', stream: { remoteRunId: 50 } };
    if (path.startsWith('/remote-runs/50/wait')) { waits.push(path); return running; }
    if (path === '/remote-runs/50/signal' && method === 'POST') return { ok: true };
    throw new Error(`unexpected ${path}`);
  };
  const r = await aidevToolsService.remoteExec({ cmd: 'npm run dev', background: true });
  assert.equal(r.status, 'running');
  assert.equal(r.running, true);
  assert.match(r.output ?? '', /VITE ready/);
  assert.match(waits[0], /timeout=5\b/);
  const before = waits.length;
  const logs = await aidevToolsService.remoteLogs(50, 0);
  assert.equal(logs.status, 'running');
  assert.equal(waits.length, before + 1);
  assert.match(waits[before], /timeout=0\b/);
  const stopped = await aidevToolsService.remoteStop(50);
  assert.equal(stopped.remoteRunId, 50);
});

test('remote_preview (F-06): opens the preview on the routed target and passes the hint through', async () => {
  let sent: Record<string, unknown> = {};
  handler = (method, path, body) => {
    if (path === '/targets') return targets;
    if (method === 'POST' && path === '/targets/7/preview') { sent = body; return { preview: { url: 'https://dev.nado.work/p/7-5173-abcdefghijklmnop/', base: '/p/7-5173-abcdefghijklmnop/', mode: 'keep', error: null }, hint: 'ok' }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const r = await aidevToolsService.remotePreview({ port: 5173, label: 'todo' }, { targetId: 7 }) as Record<string, unknown>;
  assert.equal(r.target, 'm4pro');
  assert.equal(r.mode, 'keep');
  assert.equal(r.base, '/p/7-5173-abcdefghijklmnop/');
  assert.equal(r.hint, 'ok');
  assert.deepEqual(sent, { port: 5173, label: 'todo' });
});

test('remote_screenshot (F-07): captures on the routed target and returns the image with the chat run id', async () => {
  let sent: Record<string, unknown> = {};
  handler = (method, path, body) => {
    if (path === '/targets') return targets;
    if (method === 'POST' && path === '/targets/7/screenshot') { sent = body; return { image: '/9j/AAAA', mime: 'image/jpeg', width: 1440, height: 900, bytes: 4, ms: 210, display: 1, remoteRunId: 40 }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const r = await aidevToolsService.remoteScreenshot({ maxWidth: 1440 }, { targetId: 7, runId: 12 }) as Record<string, unknown>;
  assert.equal(r.target, 'm4pro');
  assert.equal(r.image, '/9j/AAAA');
  assert.equal(r.width, 1440);
  assert.deepEqual(sent, { maxWidth: 1440, runId: 12 });
});

test('remote_windows / remote_screenshot{query} (F-07c): program windows, then one window by name', async () => {
  let sent: Record<string, unknown> = {};
  handler = (method, path, body) => {
    if (path === '/targets') return targets;
    if (method === 'GET' && path === '/targets/7/windows') return { windows: [{ id: 42, pid: 9, app: 'Simulator', title: 'iPhone 16', x: 0, y: 0, width: 400, height: 860, focused: true }], displays: null, perWindow: true };
    if (method === 'POST' && path === '/targets/7/screenshot') { sent = body; return { image: '/9j/BBBB', mime: 'image/jpeg', width: 400, height: 860, bytes: 4, ms: 90, window: { id: 42, app: 'Simulator', title: 'iPhone 16' }, remoteRunId: 41 }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const w = await aidevToolsService.remoteWindows({}, { targetId: 7 }) as { windows: Array<Record<string, unknown>> };
  assert.deepEqual(w.windows, [{ id: 42, app: 'Simulator', title: 'iPhone 16', width: 400, height: 860, focused: true }]);
  const r = await aidevToolsService.remoteScreenshot({ query: 'simulator' }, { targetId: 7, runId: 12 }) as Record<string, unknown>;
  assert.deepEqual(sent, { query: 'simulator', runId: 12 });
  assert.equal((r.window as { id: number }).id, 42);
});

test('remote_devices / remote_device_shot (F-10): attached devices, then one device\'s screen', async () => {
  let sent: Record<string, unknown> = {};
  handler = (method, path, body) => {
    if (path === '/targets') return targets;
    if (method === 'GET' && path === '/targets/7/devices') return { devices: [{ tool: 'adb', serial: 'emulator-5554', state: 'device', name: 'Pixel 7' }], errors: {}, tools: { adb: true, sdb: false, sim: true } };
    if (method === 'POST' && path === '/targets/7/devices/shot') { sent = body; return { image: '/9j/CCCC', mime: 'image/jpeg', width: 1080, height: 2400, bytes: 4, ms: 600, device: { tool: 'adb', serial: 'emulator-5554', name: 'Pixel 7' }, remoteRunId: 42 }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const d = await aidevToolsService.remoteDevices({}, { targetId: 7 }) as { target: string; devices: Array<Record<string, unknown>> };
  assert.equal(d.target, 'm4pro');
  assert.equal(d.devices[0].serial, 'emulator-5554');
  const r = await aidevToolsService.remoteDeviceShot({ serial: 'emulator-5554' }, { targetId: 7, runId: 12 }) as Record<string, unknown>;
  assert.deepEqual(sent, { serial: 'emulator-5554', runId: 12 });
  assert.equal(r.image, '/9j/CCCC');
});

const pausedSnap = (id: string, line: number, locals: Array<Record<string, unknown>>) => ({
  id, state: 'paused', error: null, exitCode: null, program: '/w/app.py', cwd: '/w', version: '1.8.22',
  stopped: { reason: 'breakpoint', description: null },
  frames: [{ id: 3, name: 'add', path: '/w/app.py', line, internal: false }, { id: 4, name: 'run_module', path: '/usr/lib/python3.12/runpy.py', line: 88, internal: true }],
  locals, localsScope: 'Locals', breakpoints: [{ path: '/w/app.py', line: 2, condition: null, verified: true, message: null }], output: 'x'.repeat(5000),
});

test('remote_debug_start (F-09): asks the user through the gate, then returns where the program paused', async () => {
  let sent: Record<string, unknown> = {};
  let polls = 0;
  handler = (method, path, body) => {
    if (path === '/targets') return targets;
    if (method === 'POST' && path === '/targets/7/debug') { sent = body; return { status: 'pending', approval: { id: 'apprvdbg1', risk: 1.5, reasons: ['확인'] } }; }
    if (path.startsWith('/approvals/apprvdbg1/wait')) return { approval: ++polls < 2 ? { status: 'pending', debugSessionId: null, error: null } : { status: 'allowed', debugSessionId: 'dbgabc1', error: null } };
    if (method === 'GET' && path === '/debug/dbgabc1?wait=45') return { session: pausedSnap('dbgabc1', 2, [{ name: 'a', value: '0', type: 'int', ref: 0 }, { name: 'rows', value: '[...]', type: 'list', ref: 17 }]) };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const r = await aidevToolsService.remoteDebugStart({ adapter: 'debugpy', program: 'app.py', cwd: '~/aidev-work/p', breakpoints: [{ file: 'app.py', line: 2 }], waitSec: 45 }, { targetId: 7, runId: 5, agent: 'backend-node' }) as Record<string, unknown>;
  assert.deepEqual(sent.breakpoints, [{ path: 'app.py', line: 2 }]);
  assert.equal(sent.runId, 5); assert.equal(sent.waitSec, 45);
  assert.equal(r.session, 'dbgabc1'); assert.equal(r.state, 'paused'); assert.equal(r.approvedBy, 'user');
  assert.deepEqual(r.pausedAt, { reason: 'breakpoint', description: null, function: 'add', file: '/w/app.py', line: 2 });
  assert.deepEqual(r.stack, ['add (/w/app.py:2) #frame 3'], 'internal frames are left out');
  assert.deepEqual(r.locals, [{ name: 'a', value: '0', type: 'int', ref: undefined }, { name: 'rows', value: '[...]', type: 'list', ref: 17 }]);
  assert.equal((r.output as string).length, 3000);
});

test('remote_debug_step / eval / breakpoints / stop (F-09) map onto the gateway session API', async () => {
  const seen: string[] = [];
  handler = (method, path, body) => {
    seen.push(`${method} ${path} ${JSON.stringify(body)}`);
    if (method === 'POST' && path === '/debug/dbgabc1/control') return { session: pausedSnap('dbgabc1', 3, [{ name: 's', value: '1', type: 'int', ref: 0 }]) };
    if (method === 'POST' && path === '/debug/dbgabc1/evaluate') return { result: '1', type: 'int', ref: 0 };
    if (method === 'GET' && path === '/debug/dbgabc1/variables?ref=17') return { variables: [{ name: '0', value: '1', type: 'int', ref: 0 }] };
    if (method === 'POST' && path === '/debug/dbgabc1/breakpoints') return { breakpoints: [] };
    if (method === 'DELETE' && path === '/debug/dbgabc1') return { session: { ...pausedSnap('dbgabc1', 3, []), state: 'ended', stopped: null, exitCode: 0 } };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const step = await aidevToolsService.remoteDebugStep('dbgabc1', 'next', 10) as Record<string, unknown>;
  assert.equal((step.pausedAt as { line: number }).line, 3);
  assert.match(seen[0], /"action":"next","waitSec":10/);
  assert.deepEqual(await aidevToolsService.remoteDebugEval('dbgabc1', { expression: 'a + b' }), { result: '1', type: 'int', ref: 0 });
  assert.deepEqual(await aidevToolsService.remoteDebugEval('dbgabc1', { ref: 17 }), { variables: [{ name: '0', value: '1', type: 'int', ref: 0 }] });
  await aidevToolsService.remoteDebugBreakpoints('dbgabc1', 'app.py', []);
  const end = await aidevToolsService.remoteDebugStop('dbgabc1') as Record<string, unknown>;
  assert.equal(end.state, 'ended'); assert.equal(end.exitCode, 0); assert.equal(end.locals, undefined);
});

test('remote_console_* (F-09c): start through the gate, send lines / Ctrl-C, read, stop', async () => {
  const seen: string[] = [];
  let polls = 0;
  const con = (over: Record<string, unknown>) => ({ id: 'conabc1', state: 'running', exitCode: null, atPrompt: true, output: '', cmd: 'gdb -q ./app', ...over });
  handler = (method, path, body) => {
    seen.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
    if (path === '/targets') return targets;
    if (method === 'POST' && path === '/targets/7/console') return { status: 'pending', approval: { id: 'apprcon1', risk: 1.5, reasons: [] } };
    if (path.startsWith('/approvals/apprcon1/wait')) return { approval: ++polls < 2 ? { status: 'pending', debugSessionId: null, error: null } : { status: 'allowed', debugSessionId: 'conabc1', error: null } };
    if (method === 'GET' && path === '/console/conabc1/transcript') return { console: con({ output: 'Reading symbols from ./app...\n(gdb) ' }) };
    if (method === 'POST' && path === '/console/conabc1/send') return { console: con({ output: `${'y'.repeat(20_000)}\nBreakpoint 1 at 0x1157\n(gdb) `, waited: 'prompt' }) };
    if (method === 'POST' && path === '/console/conabc1/interrupt') return { console: con({ output: '^C\nProgram received signal SIGINT\n(gdb) ' }) };
    if (method === 'GET' && path === '/console/conabc1/read?wait=5') return { console: con({ atPrompt: false, output: 'running…', waited: 'quiet' }) };
    if (method === 'DELETE' && path === '/console/conabc1') return { console: con({ state: 'ended', atPrompt: false, exitCode: null }) };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const s = await aidevToolsService.remoteConsoleStart({ command: 'gdb -q ./app', cwd: '~/w/c' }, { targetId: 7, runId: 5, agent: 'systems-c' }) as Record<string, unknown>;
  assert.equal(s.session, 'conabc1'); assert.equal(s.approvedBy, 'user'); assert.equal(s.waitingForInput, true);
  assert.match(String(s.output), /\(gdb\)/);
  assert.match(seen.find((x) => x.startsWith('POST /targets/7/console'))!, /"cmd":"gdb -q \.\/app".*"runId":5.*"agent":"systems-c"/);
  const r = await aidevToolsService.remoteConsoleSend('conabc1', { input: 'break app.c:3' }) as Record<string, unknown>;
  assert.ok(String(r.output).length < 12_100 && String(r.output).endsWith('(gdb) '), 'long output keeps its tail');
  assert.match(String(r.hint), /입력 대기/);
  assert.match(String((await aidevToolsService.remoteConsoleSend('conabc1', { interrupt: true }) as Record<string, unknown>).output), /SIGINT/);
  assert.match(String((await aidevToolsService.remoteConsoleRead('conabc1', 5) as Record<string, unknown>).hint), /remote_console_read|interrupt/);
  const end = await aidevToolsService.remoteConsoleStop('conabc1') as Record<string, unknown>;
  assert.equal(end.state, 'ended');
  await assert.rejects(aidevToolsService.remoteConsoleSend('conabc1', {}), /input/);
});

test('remote_agent (F-09d): hands the task to the PC\'s Claude Code on stdin, through the gate, and parses its report', async () => {
  let sent: Record<string, unknown> = {};
  const withTools = { targets: [{ ...targets.targets[0], capabilities: { runner: '0.9.0', features: ['exec', 'stdin'], tools: { claude: '2.1.285 (Claude Code)', codex: 'codex-cli 0.159.2' } } }] };
  const stream = [
    '{"type":"system","subtype":"init","session_id":"sess-abcdef"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"xcodebuild -scheme App test"}}]},"session_id":"sess-abcdef"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"원인: 메인 스레드 교착. LoginView.swift 수정, 테스트 통과.","num_turns":7,"total_cost_usd":0.4,"session_id":"sess-abcdef"}',
  ].join('\n');
  handler = (method, path, body) => {
    if (path === '/targets') return withTools;
    if (method === 'POST' && path === '/targets/7/exec') { sent = body; return { status: 'pending', approval: { id: 'apprag1', risk: 2, reasons: ['다른 AI agent에 이 PC 전체 권한 위임'] } }; }
    if (path.startsWith('/approvals/apprag1/wait')) return { approval: { status: 'allowed', remoteRunId: 91, error: null } };
    if (path.startsWith('/remote-runs/91/wait')) return finished(91, 0, stream);
    throw new Error(`unexpected ${method} ${path}`);
  };
  const r = await aidevToolsService.remoteAgent({ task: '로그인 화면 멈춤 원인을 찾아 고쳐라', cwd: '~/aidev-work/app' }, { targetId: 7, runId: 3, agent: 'ios-swift' }) as Record<string, unknown>;
  assert.equal(sent.cmd, 'claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Bash');
  assert.match(String(sent.stdin), /로그인 화면 멈춤/); assert.match(String(sent.stdin), /m4pro/);
  assert.equal(sent.cwd, '~/aidev-work/app'); assert.equal(sent.timeoutSec, 14400);
  assert.equal(r.agent, 'claude'); assert.equal(r.approvedBy, 'user'); assert.equal(r.status, 'finished');
  assert.equal(r.sessionId, 'sess-abcdef'); assert.match(String(r.result), /LoginView/);
  assert.deepEqual(r.steps, ['Bash: xcodebuild -scheme App test']);
  assert.match(String(r.hint), /resume: "sess-abcdef"/);
  assert.equal(r.output, undefined, 'raw stream is not repeated when parsed');

  // no CLI installed / old runner: a clear answer instead of a failed command
  handler = (_m, path) => (path === '/targets' ? { targets: [{ ...targets.targets[0], capabilities: { runner: '0.9.0', features: ['stdin'], tools: {} } }] } : {});
  assert.equal((await aidevToolsService.remoteAgent({ task: 'x' }, { targetId: 7 }) as Record<string, unknown>).status, 'unavailable');
  handler = (_m, path) => (path === '/targets' ? { targets: [{ ...targets.targets[0], capabilities: { runner: '0.8.0', features: ['exec'], tools: { claude: 'x' } } }] } : {});
  assert.match(String((await aidevToolsService.remoteAgent({ task: 'x' }, { targetId: 7 }) as Record<string, unknown>).message), /0\.9\.0/);
});
