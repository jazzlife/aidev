import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeCliModel } from '@/shared/utils.js';

test('the platform\'s best runs as the CLI\'s fable alias (newer CLIs resolve best to Opus)', () => {
  assert.equal(claudeCliModel('best'), 'fable');
});

test('every other model name passes through unchanged', () => {
  for (const model of ['fable', 'opus', 'opus[1m]', 'sonnet', 'haiku', 'default', 'opusplan', 'claude-fable-5-2', null, undefined]) {
    assert.equal(claudeCliModel(model), model);
  }
});
