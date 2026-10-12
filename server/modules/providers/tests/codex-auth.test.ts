import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';

test('logout: removes ~/.codex/auth.json even when the codex CLI is not there to do it', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'codex-auth-test-'));
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  process.env.HOME = homeDir;
  // no codex on PATH: the test never runs (or signs out) a real CLI
  process.env.PATH = '';
  try {
    await mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await writeFile(path.join(homeDir, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'token' } }));

    await new CodexProviderAuth().logout();

    assert.ok(!fs.existsSync(path.join(homeDir, '.codex', 'auth.json')));
    // already signed out: still fine
    await new CodexProviderAuth().logout();
  } finally {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    await rm(homeDir, { recursive: true, force: true });
  }
});
