import assert from 'node:assert/strict';
import test from 'node:test';

import { isBlockingRateLimit, isFableOnlyRefusal, modelLimitMessage, normalizeUsageLimit, parseLegacyUsageLimit } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { isClaudeAuthFailure, isClaudeUsageLimit } from '@/modules/providers/services/claude-auth-store.service.js';

// A refused usage window has to end the run as a failure carrying the limit, because
// that `complete` is what moves the work to another engine. Reported as success (the
// behaviour before this existed) the user is stuck until the window resets.

test('only a rejected window with no overage to fall back on is a block', () => {
  assert.ok(isBlockingRateLimit({ status: 'rejected' }));
  assert.ok(isBlockingRateLimit({ status: 'rejected', overageStatus: 'rejected' }));
  // A subscription with no overage provisioned reports overage 'rejected' on every
  // response while the window itself is fine — the bug that blocked runs with usage left.
  assert.ok(!isBlockingRateLimit({ status: 'allowed', overageStatus: 'rejected' }));
  assert.ok(!isBlockingRateLimit({ status: 'allowed_warning', overageStatus: 'rejected', utilization: 0.9 }));
  // A rejected window with overage allowed keeps running on overage.
  assert.ok(!isBlockingRateLimit({ status: 'rejected', overageStatus: 'allowed' }));
  assert.ok(!isBlockingRateLimit({ status: 'rejected', overageStatus: 'allowed_warning' }));
  assert.ok(!isBlockingRateLimit({}));
  assert.ok(!isBlockingRateLimit(undefined));
});

test("one model's own window (Fable / Opus weekly) is never a block: the account still runs on other models", () => {
  assert.ok(!isBlockingRateLimit({ status: 'rejected', rateLimitType: 'seven_day_fable', overageStatus: 'rejected' }));
  assert.ok(!isBlockingRateLimit({ status: 'rejected', rateLimitType: 'seven_day_opus' }));
  // the account-wide weekly window still is
  assert.ok(isBlockingRateLimit({ status: 'rejected', rateLimitType: 'seven_day' }));
  const limit = normalizeUsageLimit({ status: 'rejected', rateLimitType: 'seven_day_fable', resetsAt: 1767225600 });
  assert.equal(limit.type, 'seven_day_fable');
  assert.match(modelLimitMessage(limit), /주간\(Fable\) 한도/);
  assert.match(modelLimitMessage(limit), /다른 Claude 모델/);
});

test("a Fable turn's refusal is Fable's own share only when no account window is named and both have room", () => {
  const room = { windows: [{ type: 'five_hour', utilization: 0.3, blocked: false, resetsAt: null }, { type: 'seven_day', utilization: 0.7, blocked: false, resetsAt: null }] };
  assert.ok(isFableOnlyRefusal({ type: 'unknown', resetsAt: null }, room));
  assert.ok(isFableOnlyRefusal({ type: 'seven_day_fable', resetsAt: null }, null), 'a named model window needs no account check');
  // an account window named in the refusal is the account being out
  assert.ok(!isFableOnlyRefusal({ type: 'seven_day', resetsAt: null }, room));
  assert.ok(!isFableOnlyRefusal({ type: 'five_hour', resetsAt: null }, room));
  // a full or blocked account window, or no picture of the account, is not read as Fable-only
  assert.ok(!isFableOnlyRefusal({ type: 'unknown', resetsAt: null }, { windows: [{ type: 'five_hour', utilization: 1, blocked: false }, { type: 'seven_day', utilization: 0.7, blocked: false }] }));
  assert.ok(!isFableOnlyRefusal({ type: 'unknown', resetsAt: null }, { windows: [{ type: 'five_hour', utilization: 0.3, blocked: true }, { type: 'seven_day', utilization: 0.7, blocked: false }] }));
  assert.ok(!isFableOnlyRefusal({ type: 'unknown', resetsAt: null }, { windows: [{ type: 'five_hour', utilization: 0.3, blocked: false }] }));
  assert.ok(!isFableOnlyRefusal({ type: 'unknown', resetsAt: null }, undefined));
  assert.ok(!isFableOnlyRefusal(null, room));
});

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
