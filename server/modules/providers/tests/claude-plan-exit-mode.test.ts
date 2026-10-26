import assert from 'node:assert/strict';
import test from 'node:test';

import { modeAfterPlan } from '@/modules/providers/list/claude/claude-runtime.provider.js';

test('an approved plan runs without prompts when the user skips permissions', () => {
  // The turn starts in plan (skip-permissions does not apply there), so without this the CLI fell to `default`
  // and every command after Build timed out waiting for a prompt.
  assert.equal(modeAfterPlan({ skipPermissions: true, defaultPermissionMode: 'default' }), 'bypassPermissions');
  assert.equal(modeAfterPlan({ skipPermissions: false, defaultPermissionMode: 'bypassPermissions' }), 'bypassPermissions');
});

test("an approved plan returns to the user's default mode", () => {
  assert.equal(modeAfterPlan({ skipPermissions: false, defaultPermissionMode: 'acceptEdits' }), 'acceptEdits');
  assert.equal(modeAfterPlan({ defaultPermissionMode: 'auto' }), 'auto');
});

test('a default of plan or none, or no settings, returns to default', () => {
  assert.equal(modeAfterPlan({ defaultPermissionMode: 'plan' }), 'default');
  assert.equal(modeAfterPlan(undefined), 'default');
});
