import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Isolated HOME and a stand-in `claude` that behaves like `claude setup-token`: prints the sign-in
// URL, reads the pasted code, then prints a token (good code) or an error (anything else).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-claude-login-'));
process.env.HOME = home;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const token = `sk-ant-oat01-${'A'.repeat(60)}_b-c`;
const fakeCli = path.join(home, 'fake-claude.sh');
fs.writeFileSync(fakeCli, `#!/usr/bin/env bash
echo "Browser didn't open? Use the url below to sign in (c to copy)"
echo ""
echo "https://claude.com/cai/oauth/authorize?code=true&client_id=x&scope=user%3Ainference&state=abc"
printf "Paste code here if prompted > "
read -r code
if [ "$code" = "good-code#abc" ]; then echo ""; echo "Your OAuth token (valid for 1 year):"; echo ""; echo "${token}"; else echo "Error: Invalid code"; fi
sleep 2
`, { mode: 0o755 });
process.env.CLAUDE_CLI_PATH = fakeCli;

const { claudeLoginService } = await import('@/modules/aidev-tools/claude-login.service.js');
const { claudeAuthStore } = await import('@/modules/providers/index.js');

test('a refused code ends the attempt with the CLI message and stores nothing', async () => {
  const started = await claudeLoginService.start();
  assert.match(started.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?.*state=abc$/);
  await assert.rejects(claudeLoginService.submitCode(started.loginId, 'wrong#abc'), /Invalid code/);
  assert.equal(claudeAuthStore.info(), null);
  await assert.rejects(claudeLoginService.submitCode(started.loginId, 'good-code#abc'), /만료/);
});

test('a good code stores the 1-year token privately, in process env and in ~/.claude/settings.json', async () => {
  claudeAuthStore.recordFailure('Failed to authenticate: OAuth session expired and could not be refreshed');
  assert.ok(claudeAuthStore.currentFailure());
  const started = await claudeLoginService.start();
  const saved = await claudeLoginService.submitCode(started.loginId, 'good-code#abc');
  assert.ok(Math.abs(saved.expiresAt - saved.issuedAt - 365 * 86_400_000) < 1000);
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, token);
  const stored = path.join(home, '.cloudcli', 'aidev-claude-token.json');
  assert.equal(JSON.parse(fs.readFileSync(stored, 'utf8')).token, token);
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.equal(claudeAuthStore.currentFailure(), null, 'a new login clears the recorded failure');
  assert.equal(claudeAuthStore.info()?.expiresAt, saved.expiresAt);
});

test('startup loads the stored token; non-tokens are refused', () => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  claudeAuthStore.loadIntoEnv();
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.throws(() => claudeAuthStore.save('not-a-token'));
});
