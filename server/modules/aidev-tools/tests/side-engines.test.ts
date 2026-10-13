import assert from 'node:assert/strict';
import test from 'node:test';

import { sideEngines } from '@/modules/aidev-tools/aidev-tools.routes.js';

test('sideEngines: an account whose engines cannot run side turns is refused, not widened to every engine (D-05)', () => {
  // an older gateway sends no list: every engine, as before
  assert.deepEqual(sideEngines(undefined), { engines: undefined, none: false });
  assert.deepEqual(sideEngines(['claude', 'codex']), { engines: ['claude', 'codex'], none: false });
  // OpenCode runs side turns too (verification, curation, design, knowledge checks); Cursor does not
  assert.deepEqual(sideEngines(['codex', 'opencode', 'cursor']), { engines: ['codex', 'opencode'], none: false });
  assert.deepEqual(sideEngines(['opencode']), { engines: ['opencode'], none: false });
  // the judge runs on Claude and Codex only: an OpenCode-only account is refused — the empty list used to mean "all"
  // and ran the turn on Claude
  assert.deepEqual(sideEngines(['codex', 'opencode'], ['claude', 'codex']), { engines: ['codex'], none: false });
  assert.deepEqual(sideEngines(['opencode'], ['claude', 'codex']), { engines: [], none: true });
  assert.deepEqual(sideEngines([]), { engines: [], none: true });
});
