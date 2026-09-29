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
