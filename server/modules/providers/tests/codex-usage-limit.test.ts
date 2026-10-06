import assert from 'node:assert/strict';
import test from 'node:test';

import { isCodexUsageLimit } from '@/modules/providers/list/codex/codex-runtime.provider.js';

// Codex's SDK has no structured rate-limit event (unlike Claude's `rate_limit_event`),
// so the refusal only reaches the runtime as the turn-failure/thrown-error message —
// this classifier is the only thing standing between a real limit and an ordinary
// failure getting handed off to Claude.

test('a rate-limit style message is recognised', () => {
  assert.ok(isCodexUsageLimit('rate_limit_exceeded: please retry later'));
  assert.ok(isCodexUsageLimit('You have hit your usage limit for this period'));
  assert.ok(isCodexUsageLimit('429 Too Many Requests'));
  assert.ok(isCodexUsageLimit('quota exceeded for this account'));
});

test('an unrelated turn failure is not mistaken for a limit', () => {
  assert.ok(!isCodexUsageLimit('Turn failed'));
  assert.ok(!isCodexUsageLimit('Codex Exec exited with code 1: command not found'));
  assert.ok(!isCodexUsageLimit(''));
});
