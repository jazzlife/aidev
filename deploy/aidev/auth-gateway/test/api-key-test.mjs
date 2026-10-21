// Scoped API keys (api-keys.ts): a long-lived credential a game can hold, that reaches the Laya
// decision endpoints and nothing else. The real gateway (dist) against the mock Laya/manager.
//   npm run build && node test/api-key-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-apikey-'));
fs.mkdirSync(path.join(T, 'secrets'));
fs.writeFileSync(path.join(T, 'secrets/jwt'), crypto.randomBytes(48).toString('base64'));
fs.writeFileSync(path.join(T, 'secrets/rt'), crypto.randomBytes(48).toString('base64'));
fs.mkdirSync(path.join(T, 'dist')); fs.writeFileSync(path.join(T, 'dist/index.html'), '<html>workbench</html>');
const [MGR, LAYA, GW] = [18290, 18295, 18280];
const G = `http://127.0.0.1:${GW}`;
const env = { ...process.env, DATABASE_PATH: path.join(T, 'auth.db'), JWT_SECRET_FILE: path.join(T, 'secrets/jwt'), RUNTIME_MANAGER_TOKEN_FILE: path.join(T, 'secrets/rt'),
  RUNTIME_MANAGER_URL: `http://127.0.0.1:${MGR}`, LAYA_URL: `http://127.0.0.1:${LAYA}`, PUBLIC_ORIGIN: G, PORT: String(GW), STATIC_ROOT: path.join(T, 'dist'),
  MOCK_MANAGER_PORT: String(MGR), MOCK_LAYA_PORT: String(LAYA) };

const { openStore } = await import('../dist/store.js');
{
  const s = openStore(env.DATABASE_PATH);
  await s.add('boss', 'bosspass1', 'rt-boss', 1);
  await s.add('alice', 'alicepass1', 'rt-alice', 1);
  s.setRole('boss', 'admin');
  s.db.close();
}
const procs = [spawn('node', ['test/mock-services.mjs'], { env, stdio: 'ignore' })];
await new Promise((r) => setTimeout(r, 400));
const gw = spawn('node', ['dist/auth-gateway.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(gw);
let log = ''; gw.stdout.on('data', (d) => { log += d; }); gw.stderr.on('data', (d) => { log += d; });
const done = (code) => { for (const p of procs) p.kill(); fs.rmSync(T, { recursive: true, force: true }); process.exit(code); };
process.on('uncaughtException', (e) => { console.error(e); console.error(log.slice(-2000)); done(1); });
process.on('unhandledRejection', (e) => { console.error(e); console.error(log.slice(-2000)); done(1); });
for (let i = 0; i < 50; i++) { if (await fetch(`${G}/_gateway/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 200)); }

const req = async (method, p, body, headers = {}) => {
  const r = await fetch(`${G}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
};
const login = async (username, password) => {
  const r = await req('POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, `login ${username}: ${r.text}`);
  return r.json.token;
};
const bearer = (token) => ({ authorization: `Bearer ${token}` });

const adminToken = await login('boss', 'bosspass1');
const aliceToken = await login('alice', 'alicepass1');

// ---- minting is for administrators, with a real session ----------------------------------------
assert.equal((await req('POST', '/api/aidev/keys', { name: 'game' })).status, 401, 'no key without a session');
assert.equal((await req('POST', '/api/aidev/keys', { name: 'game' }, bearer(aliceToken))).status, 403, 'a plain account may not mint keys');
let r = await req('POST', '/api/aidev/keys', { name: 'mission possible', days: 365 }, bearer(adminToken));
assert.equal(r.status, 200, r.text);
const key = r.json.token;
assert.match(key, /^aidk_[A-Za-z0-9_-]{43}$/, `token shape: ${key}`);
assert.equal(r.json.scope, 'decide');
assert.ok(r.json.expiresAt > Date.now(), 'expiry is in the future');
assert.ok(r.json.prefix.startsWith('aidk_') && r.json.prefix.length === 11, 'a short prefix is kept for display');
console.log('PASS minting is admin + session only');

// the token itself is never stored, only its hash
{
  const s = openStore(env.DATABASE_PATH);
  const row = s.db.prepare('SELECT hash, name, scope FROM api_keys ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.hash, crypto.createHash('sha256').update(key).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(key), 'the plaintext token is not in the row');
  assert.equal(row.name, 'mission possible');
  s.db.close();
}
console.log('PASS only the hash is stored');

// ---- what the key may do -----------------------------------------------------------------------
r = await req('GET', '/api/aidev/laya/health', null, bearer(key));
assert.equal(r.status, 200, r.text);
r = await req('POST', '/api/aidev/decide/agent.yesno', { state: { question: 'Is this a test?', command: 'test' } }, bearer(key));
assert.equal(r.status, 200, r.text);
assert.ok('answer' in r.json && 'confidence' in r.json, `kind decision answered: ${r.text}`);
// raw predict: the shape the Unreal/Unity clients send
r = await req('POST', '/api/aidev/decide', { state: { command: 'guard sees someone' }, questions: { act: { type: 'noul', instructions: 'Should the guard act now?' } } }, bearer(key));
assert.equal(r.status, 200, r.text);
assert.ok(r.json.answers?.act, `raw predict answered: ${r.text}`);
console.log('PASS the key reaches health, /decide/<kind> and raw /decide');

// ---- what the key may NOT do -------------------------------------------------------------------
// every one of these is a 403 from the scope check, before any handler sees the request
for (const [method, p, body] of [
  ['GET', '/api/aidev/agents'],
  ['GET', '/api/aidev/targets'],
  ['GET', '/api/aidev/kinds'],
  ['GET', '/api/aidev/keys'],
  ['POST', '/api/aidev/keys', { name: 'self-minted' }],
  ['POST', '/api/aidev/route', { text: 'do something' }],
  ['GET', '/api/aidev/stats'],
  ['DELETE', '/api/aidev/keys/1'],
  ['GET', '/api/auth/user'],
  ['POST', '/api/auth/refresh'],
  ['GET', '/api/sessions'],
  ['GET', '/health'],
  ['GET', '/api/aidev/decide'],            // the decide path, but a method it is not scoped for
  ['POST', '/api/aidev/decide/AGENT.PICK'], // kind names are lowercase; no fuzzy matching
  ['POST', '/api/aidev/decide/../route', { text: 'escape attempt' }],
]) {
  const res = await req(method, p, body, bearer(key));
  assert.equal(res.status, 403, `${method} ${p} must be refused for a scoped key, got ${res.status} ${res.text.slice(0, 120)}`);
}
console.log('PASS the key is refused everywhere else (runtime proxy, catalog, key management, auth)');

// a key is not accepted as a URL token either (it would end up in logs)
assert.equal((await req('GET', `/api/aidev/laya/health?token=${encodeURIComponent(key)}`)).status, 200, 'health needs no auth at all');
r = await req('POST', `/api/aidev/decide/agent.yesno?token=${encodeURIComponent(key)}`, { state: { question: 'x' } });
assert.equal(r.status, 401, 'a key in the query string is not a credential');
console.log('PASS a key only works in the Authorization header');

// ---- unknown, revoked, expired -----------------------------------------------------------------
assert.equal((await req('GET', '/api/aidev/laya/health', null, bearer('aidk_notarealkeyatall'))).status, 401);
r = await req('GET', '/api/aidev/keys', null, bearer(adminToken));
assert.equal(r.status, 200);
assert.equal(r.json.keys.length, 1);
assert.equal(r.json.keys[0].uses > 0, true, 'uses are counted');
const keyId = r.json.keys[0].id;
assert.equal((await req('DELETE', `/api/aidev/keys/${keyId}`, null, bearer(aliceToken))).status, 403, 'a plain account may not revoke');
assert.equal((await req('DELETE', `/api/aidev/keys/${keyId}`, null, bearer(adminToken))).status, 200);
assert.equal((await req('POST', '/api/aidev/decide/agent.yesno', { state: { question: 'x' } }, bearer(key))).status, 401, 'a revoked key stops working at once');
assert.equal((await req('DELETE', `/api/aidev/keys/${keyId}`, null, bearer(adminToken))).status, 404, 'revoking twice is a 404');
console.log('PASS revoking is immediate');

// an expired key is refused (written straight into the store so no clock games are needed)
{
  const s = openStore(env.DATABASE_PATH);
  const made = s.createApiKey({ userId: s.account('boss').id, name: 'short', scope: 'decide', days: 1 });
  s.db.prepare('UPDATE api_keys SET expires_at=? WHERE id=?').run(Date.now() - 1000, made.id);
  s.db.close();
  assert.equal((await req('POST', '/api/aidev/decide/agent.yesno', { state: { question: 'x' } }, bearer(made.token))).status, 401, 'an expired key is refused');
}
// a key of a disabled account is refused
{
  const s = openStore(env.DATABASE_PATH);
  const made = s.createApiKey({ userId: s.account('boss').id, name: 'live', scope: 'decide', days: null });
  assert.equal(made.expiresAt, null, 'no days = no expiry');
  assert.equal((await req('POST', '/api/aidev/decide/agent.yesno', { state: { question: 'x' } }, bearer(made.token))).status, 200);
  s.disable('boss');
  assert.equal((await req('POST', '/api/aidev/decide/agent.yesno', { state: { question: 'x' } }, bearer(made.token))).status, 401, 'disabling the account kills its keys');
  s.db.close();
}
console.log('PASS expiry and a disabled account end a key');

// ---- the body cap on the key path --------------------------------------------------------------
{
  const s = openStore(env.DATABASE_PATH);
  s.db.prepare("UPDATE accounts SET active=1 WHERE username='boss'").run();
  const made = s.createApiKey({ userId: s.account('boss').id, name: 'big', scope: 'decide', days: null });
  s.db.close();
  const big = { state: { command: 'x'.repeat(40 * 1024) }, questions: { q: { type: 'noul', instructions: 'big?' } } };
  assert.equal((await req('POST', '/api/aidev/decide', big, bearer(made.token))).status, 413, 'an oversized body is refused on the key path');
}
console.log('PASS the key path caps the request body');

console.log('\nall api key checks passed');
done(0);
