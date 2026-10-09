import assert from 'node:assert/strict';
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
