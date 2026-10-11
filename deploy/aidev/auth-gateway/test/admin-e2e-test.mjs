// /admin user administration + the password change a new or reset account must make (2026-10-12), end to end:
// the real gateway (dist) against the mock runtime-manager. No AI-PC needed.
//   npm run build && node test/admin-e2e-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-admin-'));
fs.mkdirSync(path.join(T, 'secrets'));
fs.writeFileSync(path.join(T, 'secrets/jwt'), crypto.randomBytes(48).toString('base64'));
fs.writeFileSync(path.join(T, 'secrets/rt'), crypto.randomBytes(48).toString('base64'));
fs.mkdirSync(path.join(T, 'dist')); fs.writeFileSync(path.join(T, 'dist/index.html'), '<html>workbench</html>');
const [MGR, LAYA, GW] = [18190, 18195, 18180];
const G = `http://127.0.0.1:${GW}`;
const env = { ...process.env, DATABASE_PATH: path.join(T, 'auth.db'), JWT_SECRET_FILE: path.join(T, 'secrets/jwt'), RUNTIME_MANAGER_TOKEN_FILE: path.join(T, 'secrets/rt'),
  RUNTIME_MANAGER_URL: `http://127.0.0.1:${MGR}`, LAYA_URL: `http://127.0.0.1:${LAYA}`, PUBLIC_ORIGIN: G, PORT: String(GW), STATIC_ROOT: path.join(T, 'dist'),
  MOCK_MANAGER_PORT: String(MGR), MOCK_LAYA_PORT: String(LAYA) };
const { openStore } = await import('../dist/store.js');
{ const s = openStore(env.DATABASE_PATH); await s.setAdminLogin('turtlelab', 'admin-test-pass'); await s.add('alice', 'alicepass1', 'rt-alice', 1); s.db.close(); }
const procs = [spawn('node', ['test/mock-services.mjs'], { env, stdio: 'ignore' })];
await new Promise((r) => setTimeout(r, 400));
const gw = spawn('node', ['dist/auth-gateway.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(gw);
let log = ''; gw.stdout.on('data', (d) => { log += d; }); gw.stderr.on('data', (d) => { log += d; });
const done = (code) => { for (const p of procs) p.kill(); fs.rmSync(T, { recursive: true, force: true }); process.exit(code); };
process.on('uncaughtException', (e) => { console.error(e); console.error(log.slice(-2000)); done(1); });
process.on('unhandledRejection', (e) => { console.error(e); console.error(log.slice(-2000)); done(1); });
for (let i = 0; i < 50; i++) { if (await fetch(`${G}/_gateway/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 200)); }

let cookie = '';
const req = async (method, p, body, extra = {}) => {
  const r = await fetch(`${G}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') };
};
const login = (username, password) => req('POST', '/api/auth/login', { username, password });

// ---- the page and its sign-in
let r = await req('GET', '/admin');
assert.equal(r.status, 200); assert.match(r.text, /사용자 관리/);
assert.equal((await req('GET', '/admin/app.js')).status, 200);
assert.equal((await req('GET', '/admin/api/users')).status, 401, 'no list without the admin sign-in');
assert.equal((await req('POST', '/admin/api/login', { username: 'turtlelab', password: 'wrong' })).status, 401);
assert.equal((await req('POST', '/admin/api/login', { username: 'alice', password: 'alicepass1' })).status, 401, 'a user account is not the admin');
assert.equal((await req('POST', '/admin/api/login', { username: 'turtlelab', password: 'admin-test-pass' }, { origin: 'https://evil.example' })).status, 403, 'other origins are refused');
r = await req('POST', '/admin/api/login', { username: 'turtlelab', password: 'admin-test-pass' });
assert.equal(r.status, 200);
cookie = r.setCookie.split(';')[0];
assert.match(r.setCookie, /HttpOnly/);
r = await req('GET', '/admin/api/users');
assert.deepEqual(r.json.users.map((u) => u.username), ['alice']);
console.log('PASS admin page and its own sign-in');

// ---- add: initial password 123456, a new password before the first session
assert.equal((await req('POST', '/admin/api/users', { username: 'Bad Name' })).status, 400);
assert.equal((await req('POST', '/admin/api/users', { username: 'alice' })).status, 409);
r = await req('POST', '/admin/api/users', { username: 'carol' });
assert.equal(r.status, 201);
assert.deepEqual(r.json.users.find((u) => u.username === 'carol'), { id: r.json.users.find((u) => u.username === 'carol').id, username: 'carol', active: true, role: 'user', mustChangePassword: true });
const carolId = r.json.users.find((u) => u.username === 'carol').id;
r = await login('carol', '123456');
assert.equal(r.status, 403); assert.equal(r.json.code, 'password_change_required'); assert.equal(r.json.token, undefined, 'no session yet');
assert.equal((await login('carol', 'nope')).status, 401);
const change = (password, newPassword) => req('POST', '/api/auth/change-password', { username: 'carol', password, newPassword });
assert.equal((await change('123456', 'abc')).status, 400, 'at least 4 characters');
assert.equal((await change('123456', '123456')).status, 400);
assert.equal((await change('wrong-pass', 'carolpass1')).status, 401, 'the current password proves who it is');
r = await change('123456', 'carolpass1');
assert.equal(r.status, 200); assert.ok(r.json.token); assert.equal(r.json.user.username, 'carol');
const carolToken = r.json.token;
assert.equal((await req('GET', '/api/auth/user', null, { authorization: `Bearer ${carolToken}`, cookie: '' })).json.user.username, 'carol');
assert.equal((await login('carol', '123456')).status, 401, 'the initial password is gone');
assert.equal((await login('carol', 'carolpass1')).status, 200);
assert.equal((await req('GET', '/admin/api/users')).json.users.find((u) => u.id === carolId).mustChangePassword, false);
console.log('PASS add → 123456 → a new password before the first session');

// ---- reset: sessions end, 123456 again with a forced change
r = await req('POST', `/admin/api/users/${carolId}/reset-password`);
assert.equal(r.json.users.find((u) => u.id === carolId).mustChangePassword, true);
assert.equal((await req('GET', '/api/auth/user', null, { authorization: `Bearer ${carolToken}` })).status, 401, 'open sessions end on reset');
assert.equal((await login('carol', 'carolpass1')).status, 401);
assert.equal((await login('carol', '123456')).json.code, 'password_change_required');
assert.equal((await change('123456', 'carolpass2')).status, 200);
console.log('PASS reset → sessions end → forced change again');

// ---- edit: rename, role, disable / enable
r = await req('PATCH', `/admin/api/users/${carolId}`, { username: 'carol2', role: 'admin' });
assert.deepEqual(r.json.users.find((u) => u.id === carolId), { id: carolId, username: 'carol2', active: true, role: 'admin', mustChangePassword: false });
assert.equal((await req('PATCH', `/admin/api/users/${carolId}`, { username: 'alice' })).status, 409);
assert.equal((await req('PATCH', `/admin/api/users/${carolId}`, { active: false })).json.users.find((u) => u.id === carolId).active, false);
assert.equal((await login('carol2', 'carolpass2')).status, 401, 'a disabled account cannot sign in');
await req('PATCH', `/admin/api/users/${carolId}`, { active: true });
assert.equal((await login('carol2', 'carolpass2')).status, 200);
console.log('PASS rename, role, disable / enable');

// ---- delete: gone, the name free again; an account other rows point at is hidden instead
r = await req('DELETE', `/admin/api/users/${carolId}`);
assert.ok(!r.json.users.some((u) => u.id === carolId));
assert.equal((await login('carol2', 'carolpass2')).status, 401);
{ const s = openStore(env.DATABASE_PATH); const alice = s.account('alice'); s.addTarget({ userId: alice.id, name: 'box', pairingCode: 'X1', pairingExpires: Date.now() + 60000 }); s.db.close(); }
const aliceId = (await req('GET', '/admin/api/users')).json.users.find((u) => u.username === 'alice').id;
r = await req('DELETE', `/admin/api/users/${aliceId}`);
assert.equal(r.status, 200); assert.ok(!r.json.users.some((u) => u.username === 'alice'));
assert.equal((await login('alice', 'alicepass1')).status, 401);
assert.equal((await req('POST', '/admin/api/users', { username: 'alice' })).status, 201, 'the name is free again');
console.log('PASS delete (also an account with data: hidden, name freed)');

assert.equal((await req('POST', '/admin/api/logout')).status, 200);
cookie = '';
assert.equal((await req('GET', '/admin/api/users')).status, 401);
console.log('ALL PASS admin-e2e-test');
done(0);
