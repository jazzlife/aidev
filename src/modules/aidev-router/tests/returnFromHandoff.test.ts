import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import { handoffOrigin, rememberHandoff } from '@/modules/aidev-router/hooks/useReturnFromHandoff';

/**
 * A usage-limit handoff lands in a new, engine-bound session; the way back needs to know where that
 * session came from (2026-10-09). The record lives per device and keeps only recent handoffs.
 */
beforeEach(() => localStorage.clear());

test('a handoff session remembers its origin; unknown sessions have none', () => {
  rememberHandoff('new-1', { fromSessionId: 'old-1', fromEngine: 'claude', toEngine: 'codex', reason: 'claude_usage_limit:five_hour', at: 1 });
  assert.deepEqual(handoffOrigin('new-1'), { fromSessionId: 'old-1', fromEngine: 'claude', toEngine: 'codex', reason: 'claude_usage_limit:five_hour', at: 1 });
  assert.equal(handoffOrigin('other'), null);
  assert.equal(handoffOrigin(null), null);
});

test('only the newest twenty handoffs are kept', () => {
  for (let index = 0; index < 25; index += 1) rememberHandoff(`s${index}`, { fromSessionId: `o${index}`, fromEngine: 'claude', toEngine: 'codex', reason: null, at: index });
  assert.equal(handoffOrigin('s0'), null);
  assert.equal(handoffOrigin('s4'), null);
  assert.equal(handoffOrigin('s5')?.fromSessionId, 'o5');
  assert.equal(handoffOrigin('s24')?.fromSessionId, 'o24');
});
