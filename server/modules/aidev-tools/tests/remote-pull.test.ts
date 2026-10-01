import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * remote_pull (scp / adb pull counterpart) and remote_exec's `shell` against a fake gateway: chunked fs.pull with the
 * runner's sha256, the default .aidev/pulled destination, a file that changes mid-copy, and the shell pass-through.
 */
type Handler = (method: string, path: string, body: Record<string, unknown>) => unknown;
let handler: Handler = () => ({});
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(handler(req.method ?? 'GET', (req.url ?? '').replace(/^\/internal\/aidev/, ''), body)));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.AIDEV_RUNTIME = 'rt-test';
process.env.AIDEV_GATEWAY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.JWT_SECRET = 'x'.repeat(48);
const { remotePull } = await import('@/modules/aidev-tools/remote-sync.service.js');
const { aidevToolsService } = await import('@/modules/aidev-tools/aidev-tools.service.js');
test.after(() => server.close());

const targets = { targets: [{ id: 7, name: 'win-box', online: true, platform: 'windows', policy: 'full', allowed_roots: ['C:\\Users\\me\\aidev-work'] }] };
const CHUNK = 4 * 1024 * 1024;
/** A runner's fs.pull over `data` (sha256 with offset 0, like the real one). */
const runnerFile = (data: Buffer, remote = 'C:\\Users\\me\\aidev-work\\app\\crash.dmp') => (method: string, p: string, body: Record<string, unknown>) => {
  if (p === '/targets') return targets;
  if (p === '/targets/7/rpc' && body.method === 'fs.pull') {
    const offset = Number((body.params as { offset?: number }).offset ?? 0);
    const chunk = data.subarray(offset, offset + CHUNK);
    return { result: { path: remote, size: data.length, offset, b64: chunk.toString('base64'), eof: offset + chunk.length >= data.length, ...(offset === 0 ? { sha256: createHash('sha256').update(data).digest('hex') } : {}) } };
  }
  throw new Error(`unexpected ${method} ${p}`);
};

test('a binary file larger than one chunk lands in .aidev/pulled, byte for byte', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-'));
  const data = Buffer.from(Array.from({ length: CHUNK * 2 + 777 }, (_, i) => (i * 7) % 256));
  handler = runnerFile(data);
  const r = await remotePull({ path: 'app\\crash.dmp' }, { cwd });
  assert.equal(r.to, path.join(cwd, '.aidev', 'pulled', 'crash.dmp'));
  assert.equal(r.bytes, data.length);
  assert.ok(fs.readFileSync(r.to).equals(data));
  assert.ok(!fs.existsSync(`${r.to}.aidev-part`));
  // an existing folder as dest keeps the name
  fs.mkdirSync(path.join(cwd, 'logs'));
  assert.equal((await remotePull({ path: 'app/crash.dmp', dest: 'logs' }, { cwd })).to, path.join(cwd, 'logs', 'crash.dmp'));
});

test('a file that changes while copying is refused and leaves nothing behind', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-'));
  const data = Buffer.alloc(CHUNK + 10, 1);
  const real = runnerFile(data);
  handler = (m, p, b) => {
    const r = real(m, p, b) as { result?: { sha256?: string } };
    if (r.result?.sha256) r.result.sha256 = '0'.repeat(64);
    return r;
  };
  await assert.rejects(remotePull({ path: 'build.log' }, { cwd }), /바뀌었습니다/);
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.aidev', 'pulled')), []);
});

test('remote_exec passes the shell to the gateway', async () => {
  let sent: Record<string, unknown> = {};
  handler = (_m, p, body) => {
    if (p === '/targets') return targets;
    if (p === '/targets/7/exec') { sent = body; return { status: 'denied', reason: 'policy' }; }
    throw new Error(`unexpected ${p}`);
  };
  const r = await aidevToolsService.remoteExec({ cmd: 'Get-Service | Select-Object -First 3', shell: 'powershell' });
  assert.equal(r.status, 'denied');
  assert.equal(sent.shell, 'powershell');
  assert.equal(sent.cmd, 'Get-Service | Select-Object -First 3');
});
