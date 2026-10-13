import assert from 'node:assert/strict';
import test from 'node:test';

import { sideEngines } from '@/modules/aidev-tools/aidev-tools.routes.js';

test('sideEngines: an account whose engines cannot run side turns is refused, not widened to every engine (D-05)', () => {
  // an older gateway sends no list: every engine, as before
  assert.deepEqual(sideEngines(undefined), { engines: undefined, none: false });
  assert.deepEqual(sideEngines(['claude', 'codex']), { engines: ['claude', 'codex'], none: false });
  assert.deepEqual(sideEngines(['codex', 'opencode']), { engines: ['codex'], none: false });
  // OpenCode-only (or nothing usable): the empty list used to mean "all" and ran the turn on Claude
  assert.deepEqual(sideEngines(['opencode']), { engines: [], none: true });
  assert.deepEqual(sideEngines([]), { engines: [], none: true });
});
