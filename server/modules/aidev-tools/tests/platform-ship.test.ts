import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * platform_ship against a fake gateway and a real git repository under a scratch /workspace: HEAD of the repository
 * the agent works in is shipped by its path relative to the workspace, uncommitted work is refused, and the status
 * call waits for a result.
 */
const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
let polls = 0;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    const route = (req.url ?? '').replace(/^\/internal\/aidev/, '');
    calls.push({ method: req.method ?? 'GET', path: route, body });
    res.writeHead(route === '/platform/ship' ? 202 : 200, { 'content-type': 'application/json' });
    if (route === '/platform/ship') return res.end(JSON.stringify({ id: 'abcd1234abcd1234', running: true, step: null, result: null, log: '' }));
    polls += 1;
    const done = polls >= 2;
    res.end(JSON.stringify({ id: 'abcd1234abcd1234', running: !done, step: done ? 'push' : 'checks', result: done ? { status: 'ok', sha: 'f'.repeat(40), text: 'release ffff is live' } : null, log: 'SHIP_STEP checks\nok' }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-ws-'));
const repo = path.join(workspace, 'aidev');
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
execFileSync('git', ['init', '-q', repo]);
git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'README.md'), 'a\n');
git('add', '.'); git('commit', '-qm', 'one');
process.env.AIDEV_RUNTIME = 'rt-test';
process.env.AIDEV_GATEWAY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.AIDEV_WORKSPACE_ROOT = workspace;
process.env.JWT_SECRET = 'x'.repeat(48);
const { platformShip, platformShipStatus } = await import('@/modules/aidev-tools/platform-ship.service.js');
test.after(() => { server.close(); fs.rmSync(workspace, { recursive: true, force: true }); });

test('ships HEAD of the repository the agent works in, by its path under the workspace', async () => {
  calls.length = 0;
  const result = await platformShip({ dir: path.join(repo, 'src') });
  assert.equal(result.id, 'abcd1234abcd1234');
  assert.deepEqual(calls[0], { method: 'POST', path: '/platform/ship', body: { from: 'aidev', ref: git('rev-parse', 'HEAD') } });
});

test('refuses uncommitted work and folders outside the workspace', async () => {
  fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
  await assert.rejects(platformShip({ dir: repo }), /uncommitted changes/);
  git('checkout', '--', 'README.md');
  await assert.rejects(platformShip({ dir: os.tmpdir() }), /not inside a git repository|must be under/);
  await assert.rejects(platformShip({ dir: null }), /path is required/);
});

test('GitHub main can be shipped without a workspace commit', async () => {
  calls.length = 0;
  await platformShip({ fromGithub: true });
  assert.deepEqual(calls[0]?.body, { ref: 'main' });
});

test('status waits for the result when asked', async () => {
  polls = 0;
  const status = await platformShipStatus({ id: 'abcd1234abcd1234', waitSec: 20 });
  assert.equal(status.result?.status, 'ok');
  assert.equal(polls, 2);
  await assert.rejects(platformShipStatus({ id: '../x' }), /ship id/);
});
