import assert from 'node:assert/strict';
import test from 'node:test';

import { describeOpenCodeError } from '@/shared/utils.js';

test('describeOpenCodeError tells a usage limit and a rejected sign-in from other failures', () => {
  // shapes measured on opencode 1.19.0 (docs/aidev/PROVIDER-ENGINE-PLAN.md §2.8)
  assert.deepEqual(describeOpenCodeError({ name: 'APIError', data: { message: 'Upstream request failed: Invalid credential', statusCode: 401 } }),
    { message: 'Upstream request failed: Invalid credential (HTTP 401)', statusCode: 401, kind: 'auth' });
  assert.equal(describeOpenCodeError({ name: 'APIError', data: { message: 'Too many requests', statusCode: 429 } }).kind, 'usage_limit');
  assert.equal(describeOpenCodeError({ name: 'APIError', data: { message: 'You have exceeded your weekly limit.', statusCode: 400 } }).kind, 'usage_limit', 'by wording when the status is not 429');
  // the free tier's refusal and an unknown model are neither: the run just failed
  assert.equal(describeOpenCodeError({ name: 'APIError', data: { message: "OpenCode's free tier can only be used from within OpenCode.", statusCode: 403 } }).kind, 'other');
  assert.deepEqual(describeOpenCodeError({ name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_1' } }),
    { message: 'Unexpected server error. Check server logs for details.', statusCode: null, kind: 'other' });
  assert.equal(describeOpenCodeError({ _tag: 'BadRequest' }).message, 'BadRequest');
  assert.equal(describeOpenCodeError(undefined).message, 'Unknown OpenCode error');
  assert.equal(describeOpenCodeError('rate limit reached').kind, 'usage_limit');
  // the wording OpenCode's own key gave on the server (2026-10-13), without relying on the status
  assert.equal(describeOpenCodeError({ name: 'APIError', data: { message: 'You have no credits remaining. Add credits to continue.' } }).kind, 'usage_limit');
});

test('describeOpenCodeError reads OpenCode Go and free-tier limits: the window by name and the reset from retry-after', () => {
  const before = Date.now();
  const go = describeOpenCodeError({ name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429, responseHeaders: { 'retry-after': '7200' }, responseBody: JSON.stringify({ type: 'error', error: { type: 'GoUsageLimitError' }, metadata: { workspace: 'wrk_1', limitName: '5-hour' } }) } });
  assert.equal(go.kind, 'usage_limit'); assert.equal(go.limitType, 'go:5-hour');
  assert.ok(go.resetsAt! >= before + 7_200_000 && go.resetsAt! <= Date.now() + 7_200_000);
  const unnamed = describeOpenCodeError({ name: 'APIError', data: { message: 'limit', statusCode: 429, responseBody: 'GoUsageLimitError' } });
  assert.deepEqual([unnamed.limitType, unnamed.resetsAt ?? null], ['go', null]);
  const free = describeOpenCodeError({ name: 'APIError', data: { message: 'Rate limited', statusCode: 429, responseBody: '{"error":"FreeUsageLimitError"}' } });
  assert.deepEqual([free.kind, free.limitType], ['usage_limit', 'free']);
  assert.equal(describeOpenCodeError({ name: 'APIError', data: { message: 'Bad request', statusCode: 400 } }).limitType ?? null, null);
});
