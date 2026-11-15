// AI analysis contract v1 at the gateway (ai-analyze.ts): /ai/v1 authenticates the NadoVibe account (an analyze key or a
// session), forwards to that account's runtime with the runtime's own token, and answers in the contract's envelope.
// Also: /api/aidev/analyze/pick picks the model from the account's settings, and decide keys keep working as before.
//   npm run build && node test/ai-analyze-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-analyze-'));
fs.mkdirSync(path.join(T, 'secrets'));
fs.writeFileSync(path.join(T, 'secrets/jwt'), crypto.randomBytes(48).toString('base64'));
fs.writeFileSync(path.join(T, 'secrets/rt'), crypto.randomBytes(48).toString('base64'));
fs.mkdirSync(path.join(T, 'dist')); fs.writeFileSync(path.join(T, 'dist/index.html'), '<html>workbench</html>');
const [MGR, LAYA, GW] = [18390, 18395, 18380];
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
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const login = async (username, password) => (await req('POST', '/api/auth/login', { username, password })).json.token;
const envelope = (r, status, code) => {
  assert.equal(r.status, status, `${code}: ${r.text.slice(0, 200)}`);
  assert.equal(r.json?.ok, false, `envelope: ${r.text.slice(0, 200)}`);
  assert.equal(r.json.error.code, code);
  assert.ok(typeof r.json.error.message === 'string' && r.json.error.message.trim().length > 0, 'a readable message');
};
const ask = { requestId: 'r1', task: { system: 's', prompt: 'p' }, output: { format: 'text' } };

const bossToken = await login('boss', 'bosspass1');
const aliceToken = await login('alice', 'alicepass1');
const analyzeKey = (await req('POST', '/api/aidev/keys', { name: 'ledgo', scope: 'analyze' }, bearer(bossToken))).json;
assert.equal(analyzeKey.scope, 'analyze', 'an administrator mints an analyze key');
const decideKey = (await req('POST', '/api/aidev/keys', { name: 'game' }, bearer(bossToken))).json.token;

// ---- who may call ------------------------------------------------------------------------------
envelope(await req('POST', '/ai/v1/analyze', ask), 401, 'unauthenticated');
envelope(await req('POST', '/ai/v1/analyze', ask, bearer('aidk_notarealkeyatall')), 401, 'unauthenticated');
envelope(await req('POST', '/ai/v1/analyze', ask, bearer('not-a-jwt')), 401, 'unauthenticated');
envelope(await req('POST', '/ai/v1/analyze', ask, bearer(decideKey)), 403, 'forbidden');
envelope(await req('POST', `/ai/v1/analyze?token=${analyzeKey.token}`, ask), 401, 'unauthenticated');
console.log('PASS no token, a wrong token, a decide key and a token in the URL are refused in the envelope');

// ---- forwarding: the key's account's runtime, with the runtime's own token ---------------------------
let r = await req('POST', '/ai/v1/analyze', ask, bearer(analyzeKey.token));
assert.equal(r.status, 202, r.text);
assert.deepEqual([r.json.ok, r.json.jobId, r.json.runtime, r.json.path], [true, 'job_mock000001', 'rt-boss', '/api/ai-analyze/v1/analyze']);
assert.equal(r.json.auth, 'Bearer tok-rt-boss', 'the caller\'s key is replaced by the runtime token');
assert.equal(r.json.contentType, 'application/json');
assert.equal(r.json.bodyBytes, Buffer.byteLength(JSON.stringify(ask)), 'the body arrives whole');
r = await req('GET', '/ai/v1/analyze/job_mock000001', null, bearer(analyzeKey.token));
assert.deepEqual([r.status, r.json.status, r.json.path], [200, 'done', '/api/ai-analyze/v1/analyze/job_mock000001']);
// a session token works too, on that account's runtime
r = await req('POST', '/ai/v1/analyze', ask, bearer(aliceToken));
assert.deepEqual([r.status, r.json.runtime], [202, 'rt-alice']);
console.log('PASS an analyze key and a session reach their own account\'s runtime with the runtime token');

// the server CLI mints one too (NAME@analyze), and refuses a scope that does not exist
{
  const { execFileSync } = await import('node:child_process');
  const cliKey = execFileSync('node', ['dist/manage-users.js', 'api-key', 'boss', 'ledgo-cli@analyze'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  r = await req('POST', '/ai/v1/analyze', ask, bearer(cliKey));
  assert.deepEqual([r.status, r.json.runtime], [202, 'rt-boss'], 'a CLI-minted analyze key works');
  assert.throws(() => execFileSync('node', ['dist/manage-users.js', 'api-key', 'boss', 'x@bogus'], { env, stdio: 'ignore' }), 'an unknown scope is refused');
}
console.log('PASS the server CLI mints analyze keys');

// ---- paths, size, the off switch, a reply outside the envelope ------------------------------------
envelope(await req('GET', '/ai/v1/analyze', null, bearer(analyzeKey.token)), 404, 'not_found');
envelope(await req('GET', '/ai/v1/analyze/not-a-job%2F..', null, bearer(analyzeKey.token)), 404, 'not_found');
envelope(await req('POST', '/ai/v1/other', ask, bearer(analyzeKey.token)), 404, 'not_found');
const huge = await new Promise((resolve) => {
  // Content-Length alone decides: the gateway answers before reading a byte
  const out = http.request(`${G}/ai/v1/analyze`, { method: 'POST', headers: { ...bearer(analyzeKey.token), 'content-type': 'application/json', 'content-length': String(40 * 1024 * 1024) } }, (res) => {
    let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text }));
  });
  out.on('error', () => resolve({ status: 0, json: null, text: 'connection closed' }));
  out.write('{"requestId":');
});
envelope(huge, 413, 'too_large');
envelope(await req('POST', '/ai/v1/analyze', { ...ask, requestId: 'non-envelope' }, bearer(analyzeKey.token)), 500, 'upstream_error');
{
  const s = openStore(env.DATABASE_PATH);
  s.kvSet('ai_analyze', 'off');
  envelope(await req('POST', '/ai/v1/analyze', ask, bearer(analyzeKey.token)), 503, 'unavailable');
  s.db.prepare("DELETE FROM app_kv WHERE k='ai_analyze'").run();
  s.db.close();
  assert.equal((await req('POST', '/ai/v1/analyze', ask, bearer(analyzeKey.token))).status, 202, 'back on');
}
console.log('PASS unknown paths, an oversized body, a non-envelope reply and the off switch answer in the envelope');

// ---- an analyze key reaches nothing else; a decide key still does what it did ------------------------
for (const [method, p, body] of [['GET', '/api/aidev/laya/health'], ['POST', '/api/aidev/decide/agent.yesno', { state: { question: 'x' } }], ['GET', '/api/sessions'], ['GET', '/api/aidev/keys'], ['POST', '/api/aidev/analyze/pick', {}], ['GET', '/health']]) {
  const res = await req(method, p, body, bearer(analyzeKey.token));
  assert.equal(res.status, 403, `an analyze key must not reach ${method} ${p}: ${res.status}`);
}
r = await req('POST', '/api/aidev/decide/agent.yesno', { state: { question: 'Is this a test?', command: 'test' } }, bearer(decideKey));
assert.equal(r.status, 200, r.text);
assert.ok('answer' in r.json, 'decide keys are unchanged');
console.log('PASS an analyze key reaches only /ai/v1; decide keys are unchanged');

// ---- the model comes from the account's settings ------------------------------------------------------
r = await req('POST', '/api/aidev/analyze/pick', {}, bearer(aliceToken));
assert.equal(r.status, 200, r.text);
assert.deepEqual([r.json.engine, r.json.allowed, r.json.authenticated, r.json.model, r.json.effort], ['claude', true, true, 'sonnet', 'high'], 'no hint = D2 of the tier table');
r = await req('POST', '/api/aidev/analyze/pick', { effort: 'low' }, bearer(aliceToken));
assert.deepEqual([r.json.model, r.json.effort], ['sonnet', 'medium'], 'low = D1');
r = await req('POST', '/api/aidev/analyze/pick', { effort: 'high' }, bearer(aliceToken));
assert.deepEqual([r.json.model, r.json.effort], ['opus', 'high'], 'high = D3');
assert.equal((await req('PUT', '/api/aidev/settings/model-floor', { claude: 'opus' }, bearer(aliceToken))).status, 200);
r = await req('POST', '/api/aidev/analyze/pick', { effort: 'low' }, bearer(aliceToken));
assert.equal(r.json.model, 'opus', 'the account\'s model floor applies');
assert.equal((await req('PUT', '/api/aidev/settings/effort-cap', { claude: 'medium' }, bearer(aliceToken))).status, 200);
r = await req('POST', '/api/aidev/analyze/pick', { effort: 'high' }, bearer(aliceToken));
assert.deepEqual([r.json.model, r.json.effort], ['opus', 'medium'], 'the account\'s effort ceiling applies');
console.log('PASS the analysis model follows the account\'s tier, model floor and effort ceiling');

console.log('\nall ai analyze gateway checks passed');
done(0);
