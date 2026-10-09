import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatResetTime, usageLimitView } from '@/modules/aidev-router/hooks/useUsageLimits';

/** The drawers draw the engines' usage windows from the runtime's snapshot (2026-10-09). */
test('no snapshot → unknown; a snapshot → labelled windows with percentages', () => {
  assert.equal(usageLimitView('claude', null).unknown, true);
  const view = usageLimitView('claude', { provider: 'claude', observedAt: 1, blockedUntil: null, windows: [
    { type: 'five_hour', utilization: 0.764, resetsAt: 1767225600000, blocked: false },
    { type: 'seven_day', utilization: null, resetsAt: null, blocked: false },
  ] });
  assert.equal(view.unknown, false);
  assert.deepEqual(view.windows.map((window) => [window.label, window.percent]), [['5시간', 76], ['주간', null]]);
});

test('a blocked engine keeps its unknown window; an unblocked one drops it', () => {
  const blocked = usageLimitView('codex', { provider: 'codex', observedAt: 1, blockedUntil: 0, windows: [{ type: 'unknown', utilization: null, resetsAt: null, blocked: true }] });
  assert.equal(blocked.windows.length, 1);
  assert.equal(blocked.windows[0].label, '한도');
  const clear = usageLimitView('codex', { provider: 'codex', observedAt: 1, blockedUntil: null, windows: [{ type: 'unknown', utilization: null, resetsAt: null, blocked: false }] });
  assert.equal(clear.windows.length, 0);
});

test('reset times read as today, tomorrow or a date', () => {
  const now = new Date('2026-10-09T10:00:00').getTime();
  assert.match(formatResetTime(new Date('2026-10-09T14:30:00').getTime(), now), /14:30|02:30/);
  assert.match(formatResetTime(new Date('2026-10-10T09:00:00').getTime(), now), /^내일 /);
  assert.match(formatResetTime(new Date('2026-10-15T09:00:00').getTime(), now), /10\. 15\./);
});
