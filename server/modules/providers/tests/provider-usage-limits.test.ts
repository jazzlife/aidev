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

const codexOnly = async (provider: string) => provider === 'codex';

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
    let codex = (await service.snapshotLive(codexOnly, now)).codex!;
    assert.equal(codex.blockedUntil, null);
    assert.deepEqual(codex.windows, [
      { type: 'five_hour', utilization: 0.42, resetsAt: now + 3600_000, blocked: false },
      { type: 'seven_day', utilization: 0.11, resetsAt: 1791951976000, blocked: false },
    ]);
    // within the minute the account is not asked again
    await service.snapshotLive(codexOnly, now + 30_000);
    assert.equal(calls, 1);
    // a full window blocks until it resets
    payload = { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1791503600 }, secondary_window: null } };
    codex = (await service.snapshotLive(codexOnly, now + 61_000)).codex!;
    assert.equal(calls, 2);
    assert.equal(codex.blockedUntil, 1791503600000);
    assert.deepEqual(codex.windows, [{ type: 'five_hour', utilization: 1, resetsAt: 1791503600000, blocked: true }]);
    // the account cannot be read: the last picture stays
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    assert.equal((await service.snapshotLive(codexOnly, now + 122_000)).codex!.blockedUntil, 1791503600000);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    service.reset();
  }
});

test('only signed-in engines are reported; a signed-out one loses its picture, a new sign-in starts blank', async () => {
  service.reset();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
  try {
    const now = 1791500000000;
    service.recordClaude({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4, resetsAt: 1791503600 });
    service.recordBlock('codex', { type: 'five_hour', resetsAt: 1791503600000 });
    // nothing signed in: nothing to show, and the stored pictures are gone
    assert.deepEqual(await service.snapshotLive(async () => false, now), {});
    assert.deepEqual(service.snapshot(now), {});
    // the answer is kept a minute; a sign-out drops it at once
    service.forget('codex');
    // Claude signed in but no turn yet: an empty picture; Codex signed out: absent
    const signedIn = await service.snapshotLive(async (provider) => provider === 'claude', now + 1000);
    assert.deepEqual(signedIn, { claude: { provider: 'claude', observedAt: 0, windows: [], blockedUntil: null } });
    // a status check that fails keeps the last standing
    service.forget('codex');
    const unsure = await service.snapshotLive(async () => { throw new Error('cli gone'); }, now + 2000);
    assert.deepEqual(Object.keys(unsure), ['claude']);
  } finally {
    globalThis.fetch = previousFetch;
    service.reset();
  }
});

test('a window past its reset loses its old figure; a refresh asks about the sign-ins at once', async () => {
  service.reset();
  service.recordClaude({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.23, resetsAt: 1791503600, unifiedWindows: { seven_day: { utilization: 0.11, resetsAt: 1791900000 } } });
  const after = service.snapshot(1791503600001).claude!;
  assert.deepEqual(after.windows.find((w) => w.type === 'five_hour'), { type: 'five_hour', utilization: null, resetsAt: 1791503600000, blocked: false }, 'reset: not the 23% of before');
  assert.equal(after.windows.find((w) => w.type === 'seven_day')!.utilization, 0.11, 'not reset yet: kept');
  // the signed-in answer is cached a minute — unless the apps say a sign-in changed
  const now = 1791500000000;
  let asked = 0;
  await service.snapshotLive(async () => { asked += 1; return false; }, now);
  await service.snapshotLive(async () => { asked += 1; return true; }, now + 1000);
  assert.equal(asked, 3, 'claude, codex, opencode asked once; the second read answered from the cache');
  const fresh = await service.snapshotLive(async (provider) => provider === 'opencode', now + 2000, true);
  assert.deepEqual(Object.keys(fresh), ['opencode'], 'refresh: asked again');
  service.reset();
});

test('an OpenCode Go refusal is recorded with its window and reset', () => {
  service.reset();
  service.recordBlock('opencode', { type: 'go:5-hour', resetsAt: 1791507200000 });
  const opencode = service.snapshot(1791500000000).opencode!;
  assert.equal(opencode.blockedUntil, 1791507200000);
  assert.deepEqual(opencode.windows, [{ type: 'go:5-hour', utilization: 1, resetsAt: 1791507200000, blocked: true }]);
  service.reset();
});
