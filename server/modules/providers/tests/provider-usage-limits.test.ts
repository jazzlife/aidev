import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerUsageLimitsService } from '@/modules/providers/services/provider-usage-limits.service.js';

const service = providerUsageLimitsService;

test('a Claude rate_limit_event becomes the account picture: window, utilization, reset in ms', () => {
  service.reset();
  service.recordClaude({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.76, resetsAt: 1767225600, overageStatus: 'rejected', unifiedWindows: { seven_day: { utilization: 0.31, resetsAt: 1767830400 } } });
  const claude = service.snapshot(1767000000000).claude;
  assert.ok(claude);
  assert.equal(claude.blockedUntil, null);
  assert.deepEqual(claude.windows, [
    { type: 'five_hour', utilization: 0.76, resetsAt: 1767225600000, blocked: false },
    { type: 'seven_day', utilization: 0.31, resetsAt: 1767830400000, blocked: false },
  ]);
});

test('a rejected window blocks until its reset; an allowed event afterwards lifts it', () => {
  service.reset();
  service.recordClaude({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1767225600, overageStatus: 'rejected' });
  let claude = service.snapshot(1767200000000).claude!;
  assert.equal(claude.blockedUntil, 1767225600000);
  assert.equal(claude.windows[0].blocked, true);
  // past the reset the block is reported lifted even without a new event
  assert.equal(service.snapshot(1767225600001).claude!.blockedUntil, null);
  service.recordClaude({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1, resetsAt: 1767243600 });
  claude = service.snapshot(1767226000000).claude!;
  assert.equal(claude.blockedUntil, null);
  assert.equal(claude.windows[0].utilization, 0.1);
  // overage allowed keeps running: not a block
  service.recordClaude({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed', resetsAt: 1767243600 });
  assert.equal(service.snapshot(1767226000000).claude!.blockedUntil, null);
});

test("a model's weekly window (Fable) refusing marks that window only; the account stays open until its reset", () => {
  service.reset();
  service.recordClaude({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2, resetsAt: 1767225600 });
  service.recordClaude({ status: 'rejected', rateLimitType: 'seven_day_fable', utilization: 1, resetsAt: 1767830400, overageStatus: 'rejected' });
  let claude = service.snapshot(1767200000000).claude!;
  assert.equal(claude.blockedUntil, null, 'not an account block');
  assert.deepEqual(claude.windows.map((window) => [window.type, window.blocked]), [['five_hour', false], ['seven_day_fable', true]]);
  // an allowed account event and a turn that went through (on another model) leave the Fable flag alone
  service.recordClaude({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: 1767225600 });
  service.recordClear('claude');
  claude = service.snapshot(1767200000000).claude!;
  assert.equal(claude.windows.find((window) => window.type === 'seven_day_fable')?.blocked, true);
  // its own reset lifts it
  assert.equal(service.snapshot(1767830400001).claude!.windows.find((window) => window.type === 'seven_day_fable')?.blocked, false);
});

test('Codex only shows refusals: a block with no reset holds five hours, a completed turn clears it', () => {
  service.reset();
  const at = Date.now();
  service.recordBlock('codex', { type: 'unknown', resetsAt: null });
  const blocked = service.snapshot(at + 1000).codex!;
  assert.ok(blocked.blockedUntil && blocked.blockedUntil > at + 4 * 3600_000);
  assert.equal(blocked.windows[0].type, 'unknown');
  assert.equal(service.snapshot(at + 6 * 3600_000).codex!.blockedUntil, null, 'an unknown reset expires after five hours');
  service.recordClear('codex');
  const cleared = service.snapshot(at + 2000).codex!;
  assert.equal(cleared.blockedUntil, null);
  assert.deepEqual(cleared.windows, []);
  service.reset();
});

test('Codex: the drawer read asks the ChatGPT account for its windows, at most once a minute', async () => {
  service.reset();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'tok', account_id: 'acct' } }));
  const previousHome = process.env.CODEX_HOME;
  const previousFetch = globalThis.fetch;
  process.env.CODEX_HOME = codexHome;
  let calls = 0;
  let payload: unknown = { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 11, limit_window_seconds: 604800, reset_after_seconds: 437601, reset_at: 1791951976 }, secondary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 3600 } } };
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    calls += 1;
    assert.equal(init?.headers?.Authorization, 'Bearer tok');
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  try {
    const now = 1791500000000;
    let codex = (await service.snapshotLive(now)).codex!;
    assert.equal(codex.blockedUntil, null);
    assert.deepEqual(codex.windows, [
      { type: 'five_hour', utilization: 0.42, resetsAt: now + 3600_000, blocked: false },
      { type: 'seven_day', utilization: 0.11, resetsAt: 1791951976000, blocked: false },
    ]);
    // within the minute the account is not asked again
    await service.snapshotLive(now + 30_000);
    assert.equal(calls, 1);
    // a full window blocks until it resets
    payload = { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1791503600 }, secondary_window: null } };
    codex = (await service.snapshotLive(now + 61_000)).codex!;
    assert.equal(calls, 2);
    assert.equal(codex.blockedUntil, 1791503600000);
    assert.deepEqual(codex.windows, [{ type: 'five_hour', utilization: 1, resetsAt: 1791503600000, blocked: true }]);
    // the account cannot be read: the last picture stays
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    assert.equal((await service.snapshotLive(now + 122_000)).codex!.blockedUntil, 1791503600000);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    service.reset();
  }
});
