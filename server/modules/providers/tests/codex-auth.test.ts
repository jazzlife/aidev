import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';
import { currentCodexAuthFailure, isCodexAuthFailure, noteCodexTurnError } from '@/shared/utils.js';

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

test('a refused sign-in (lapsed subscription) reports Codex signed out until a new sign-in or a sign-out', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'codex-auth-test-'));
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  process.env.HOME = homeDir;
  process.env.PATH = '';
  try {
    await mkdir(path.join(homeDir, '.codex'), { recursive: true });
    const authFile = path.join(homeDir, '.codex', 'auth.json');
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: 'token' } }));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(authFile, past, past);
    const auth = new CodexProviderAuth();
    const check = () => (auth as unknown as { checkCredentials: () => Promise<{ authenticated: boolean; error?: string }> }).checkCredentials();
    assert.equal((await check()).authenticated, true);

    // a usage limit with a reset time is not a sign-in failure
    noteCodexTurnError(new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits"));
    assert.equal((await check()).authenticated, true);
    // the SDK's plain { message } of a turn.failed event
    noteCodexTurnError({ message: "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus)" });
    const refused = await check();
    assert.equal(refused.authenticated, false);
    assert.match(refused.error ?? '', /Upgrade to Plus/);

    // signing in again rewrites auth.json: the failure is old
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(authFile, JSON.stringify({ tokens: { access_token: 'new-token' } }));
    assert.equal((await check()).authenticated, true);

    // a sign-out forgets it as well (auth.json dated before this failure)
    fs.utimesSync(authFile, past, past);
    noteCodexTurnError(new Error('OAuth refresh token was rejected: invalid_grant'));
    assert.equal((await check()).authenticated, false);
    await auth.logout();
    assert.equal(currentCodexAuthFailure(), null);
  } finally {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('isCodexAuthFailure tells a refused sign-in from other turn errors', () => {
  assert.ok(isCodexAuthFailure("You've hit your usage limit. Upgrade to Plus to continue using Codex"));
  assert.ok(isCodexAuthFailure('Failed to refresh token: 401 Unauthorized'));
  assert.ok(isCodexAuthFailure('Not logged in'));
  assert.ok(!isCodexAuthFailure('Selected model is at capacity. Please try a different model.'));
  assert.ok(!isCodexAuthFailure("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits"));
  assert.ok(!isCodexAuthFailure('command failed with exit code 1'));
});
