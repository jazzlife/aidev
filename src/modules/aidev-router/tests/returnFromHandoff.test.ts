import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import { handoffOrigin, rememberHandoff, returnTarget } from '@/modules/aidev-router/hooks/useReturnFromHandoff';

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

test('a chat that is itself the way back offers no return (Claude → Codex → Claude)', () => {
  rememberHandoff('codex-chat', { fromSessionId: 'claude-chat', fromEngine: 'claude', toEngine: 'codex', reason: 'claude_usage_limit:five_hour', at: 1 });
  rememberHandoff('claude-again', { fromSessionId: 'codex-chat', fromEngine: 'codex', toEngine: 'claude', reason: 'codex 사용량 한도에 걸려 claude로 넘깁니다', at: 2 });
  // the Codex chat may go back to Claude; the Claude chat that came from it is already where the chain began
  assert.equal(returnTarget('codex-chat')?.fromEngine, 'claude');
  assert.equal(returnTarget('claude-again'), null);
  // a first handoff with no upstream is offered
  rememberHandoff('lone', { fromSessionId: 'root', fromEngine: 'codex', toEngine: 'claude', reason: null, at: 3 });
  assert.equal(returnTarget('lone')?.fromEngine, 'codex');
});
