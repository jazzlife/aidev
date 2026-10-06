import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeUsageLimit, parseLegacyUsageLimit } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { isClaudeAuthFailure, isClaudeUsageLimit } from '@/modules/providers/services/claude-auth-store.service.js';

// A refused usage window has to end the run as a failure carrying the limit, because
// that `complete` is what moves the work to another engine. Reported as success (the
// behaviour before this existed) the user is stuck until the window resets.

test('a rejected window is normalized with its type and reset time', () => {
  const limit = normalizeUsageLimit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1767225600 });
  assert.equal(limit.type, 'seven_day');
  // Seconds are widened to epoch milliseconds for every consumer.
  assert.equal(limit.resetsAt, 1767225600000);
});

test('a reset time already in milliseconds is left alone', () => {
  assert.equal(normalizeUsageLimit({ resetsAt: 1767225600000 }).resetsAt, 1767225600000);
});

test('an unrecognised window type is recorded as unknown rather than passed through', () => {
  assert.equal(normalizeUsageLimit({ rateLimitType: 'four_hour' }).type, 'unknown');
  assert.equal(normalizeUsageLimit({}).type, 'unknown');
});

test('a missing reset time is null, never NaN', () => {
  assert.equal(normalizeUsageLimit({ status: 'rejected' }).resetsAt, null);
  assert.equal(normalizeUsageLimit({ resetsAt: 'soon' }).resetsAt, null);
});

test('overage reset time stands in when the window has none', () => {
  assert.equal(normalizeUsageLimit({ overageStatus: 'rejected', overageResetsAt: 1767225600 }).resetsAt, 1767225600000);
});

test('the CLI marker in a reply is read as a block', () => {
  const limit = parseLegacyUsageLimit('Claude AI usage limit reached|1767225600');
  assert.deepEqual(limit, { type: 'unknown', resetsAt: 1767225600000 });
});

test('prose about rate limits is not mistaken for being refused', () => {
  // This runs over model output: an answer that merely discusses limits must not
  // hand the conversation to another engine.
  assert.equal(parseLegacyUsageLimit('If you hit the usage limit reached error, wait for the reset.'), null);
  assert.equal(parseLegacyUsageLimit('Claude AI usage limit reached'), null);
  assert.equal(parseLegacyUsageLimit(''), null);
});

test('a thrown limit is told apart from an auth refusal', () => {
  // The two take different paths: a limit waits out a window, an expired login
  // needs the user to sign in again.
  assert.ok(isClaudeUsageLimit('Claude Code returned an error result: rate_limit_error'));
  assert.ok(isClaudeUsageLimit('Rate limit reached'));
  assert.ok(!isClaudeUsageLimit('Failed to authenticate: OAuth session expired'));
  assert.ok(!isClaudeAuthFailure('Rate limit reached'));
  assert.ok(!isClaudeUsageLimit('Tool Bash failed: exit 1'));
});
