import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import { readDefaultPermissionMode, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The permission mode a new chat starts in comes from Settings (2026-10-07): Claude keeps it as
 * `defaultPermissionMode` on its permission settings, Codex as the `permissionMode` it already
 * stored. Both apps read it through this one reader.
 */
beforeEach(() => {
  resetUserPreferences();
});

test('no setting → null for every provider', () => {
  assert.equal(readDefaultPermissionMode('claude'), null);
  assert.equal(readDefaultPermissionMode('codex'), null);
  assert.equal(readDefaultPermissionMode('nope'), null);
});

test('Claude reads defaultPermissionMode; Codex reads permissionMode; blanks count as unset', () => {
  writeUserPreference('claudePermissions', { allowedTools: [], disallowedTools: [], skipPermissions: false, defaultPermissionMode: 'acceptEdits' });
  writeUserPreference('codexPermissions', { permissionMode: 'bypassPermissions' });
  assert.equal(readDefaultPermissionMode('claude'), 'acceptEdits');
  assert.equal(readDefaultPermissionMode('codex'), 'bypassPermissions');
  writeUserPreference('claudePermissions', { allowedTools: [], disallowedTools: [], skipPermissions: false, defaultPermissionMode: '' });
  assert.equal(readDefaultPermissionMode('claude'), null);
});
