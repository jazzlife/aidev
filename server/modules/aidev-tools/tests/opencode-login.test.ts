import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// an isolated home: the test must not touch the OpenCode sign-ins of the machine it runs on
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-opencode-login-'));
(os as unknown as { homedir: () => string }).homedir = () => home;
const authFile = path.join(home, '.local', 'share', 'opencode', 'auth.json');

const { openCodeLoginService } = await import('@/modules/aidev-tools/opencode-login.service.js');

test('an API key is stored the way opencode 1.19.0 stores it, privately, next to the other sign-ins', () => {
  assert.deepEqual(openCodeLoginService.providers(), []);
  assert.deepEqual(openCodeLoginService.saveApiKey(' OpenCode-Go ', '  sk-go-key-0123456789  '), { provider: 'opencode-go', providers: ['opencode-go'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(authFile, 'utf8')), { 'opencode-go': { type: 'api', key: 'sk-go-key-0123456789' } });
  assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
  // another provider joins; the same provider again replaces its key; an OAuth sign-in the CLI stored stays
  fs.writeFileSync(authFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(authFile, 'utf8')), 'github-copilot': { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } }));
  openCodeLoginService.saveApiKey('openai', 'sk-proj-abcdefgh');
  assert.deepEqual(openCodeLoginService.saveApiKey('opencode-go', 'sk-go-key-new-000000').providers, ['github-copilot', 'openai', 'opencode-go']);
  const stored = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert.equal(stored['opencode-go'].key, 'sk-go-key-new-000000');
  assert.equal(stored['github-copilot'].type, 'oauth');
});

test('a malformed provider id or key is refused and nothing is written', () => {
  const before = fs.readFileSync(authFile, 'utf8');
  assert.throws(() => openCodeLoginService.saveApiKey('../etc', 'sk-abcdefgh12'), /공급자 id/);
  assert.throws(() => openCodeLoginService.saveApiKey('openai', 'short'), /API 키/);
  assert.throws(() => openCodeLoginService.saveApiKey('openai', 'sk with spaces 123'), /API 키/);
  assert.equal(fs.readFileSync(authFile, 'utf8'), before);
});
