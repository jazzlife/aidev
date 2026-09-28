import assert from 'node:assert/strict';
import test from 'node:test';

import { isClaudeAuthFailure } from '@/modules/providers/services/claude-auth-store.service.js';

test('isClaudeAuthFailure recognises refused logins and nothing else', () => {
  assert.ok(isClaudeAuthFailure('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed'));
  assert.ok(isClaudeAuthFailure('authentication_error: invalid x-api-key'));
  assert.ok(!isClaudeAuthFailure('Tool Bash failed: exit 1'));
  assert.ok(!isClaudeAuthFailure('Rate limit reached'));
});
