import assert from 'node:assert/strict';
import test from 'node:test';

import { isTaskNotificationResult } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Shapes as the CLI emitted them when a chat was resumed after its previous process left a background
// `sleep` running: the stopped-task report's turn ends first, with no model call, then the prompt's own turn.
const notificationResult = { type: 'result', subtype: 'success', num_turns: 0, duration_api_ms: 0, result: '', origin: { kind: 'task-notification' } };
const promptResult = { type: 'result', subtype: 'success', num_turns: 1, result: 'hi' };

test('the result of a turn the CLI ran for a task notification is recognised', () => {
  assert.equal(isTaskNotificationResult(notificationResult), true);
});

test('the result of the turn our prompt started is not', () => {
  assert.equal(isTaskNotificationResult(promptResult), false);
  assert.equal(isTaskNotificationResult({ ...promptResult, origin: { kind: 'human' } }), false);
});

test('only results count', () => {
  assert.equal(isTaskNotificationResult({ type: 'user', origin: { kind: 'task-notification' } }), false);
  assert.equal(isTaskNotificationResult({}), false);
});
