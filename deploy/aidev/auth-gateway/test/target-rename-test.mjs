// Renaming a PC (2026-11-12): the owner renames it from "원격 대상" with PATCH /targets/:id { name }. The new name keeps the
// format agents write it in and stays unique among the owner's PCs; a guest of a shared PC cannot rename it.
//   npm run build && node test/target-rename-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-target-rename-'));
const { openStore } = await import('../dist/store.js');
const { createAidevApi } = await import('../dist/aidev-api.js');

const store = openStore(path.join(dir, 'auth.db'));
for (const name of ['alice', 'bob']) await store.add(name, 'pw1234pw', `rt-${name}`, 1);
const [alice, bob] = ['alice', 'bob'].map((name) => store.account(name).id);

const api = createAidevApi({ store, laya: {}, runtimeFetch: async () => Response.json({}), json: (res, status, body) => { res.status = status; res.body = body; }, push: { sendToUser: async () => ({ delivered: 0 }) }, isOnline: () => false });
const call = async (uid, method, p, body) => {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.headers = { 'content-type': 'application/json' };
  const res = {};
  try { await api.handle(req, res, new URL(`http://gw/api/aidev${p}`), { user: { id: uid, username: 'u' }, sid: `s-${uid}` }); }
  catch (error) { res.status = error.status ?? 500; res.body = { error: error.message }; }
  return res;
};
const names = async (uid) => (await call(uid, 'GET', '/targets')).body.targets.map((t) => t.name).sort();

const office = store.addTarget({ userId: alice, name: 'office', pairingCode: 'AAAA1111', pairingExpires: Date.now() + 60000 });
store.addTarget({ userId: alice, name: 'home', pairingCode: 'BBBB2222', pairingExpires: Date.now() + 60000 });
store.updateTarget(alice, office, { policy: 'ask', description: 'desk' });

// the owner renames: only the name changes
let r = await call(alice, 'PATCH', `/targets/${office}`, { name: 'office-pc' });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.deepEqual(await names(alice), ['home', 'office-pc']);
assert.equal(store.target(alice, office).policy, 'ask');
assert.equal(store.target(alice, office).description, 'desk');

// the same name again is no change, and not a clash with itself
r = await call(alice, 'PATCH', `/targets/${office}`, { name: 'office-pc' });
assert.equal(r.status, 200, JSON.stringify(r.body));

// another of the owner's PCs already has the name: refused in words, not as a database error
r = await call(alice, 'PATCH', `/targets/${office}`, { name: 'home' });
assert.equal(r.status, 400);
assert.match(r.body.error, /이미 home/);

// a name agents could not write, empty or too long: refused, the old name stays
for (const name of ['', 'Office', 'a', 'my pc', '-x', 'x'.repeat(42)]) {
  r = await call(alice, 'PATCH', `/targets/${office}`, { name });
  assert.equal(r.status, 400, `${JSON.stringify(name)} → ${JSON.stringify(r.body)}`);
}
assert.deepEqual(await names(alice), ['home', 'office-pc']);

// registering keeps the same rules
r = await call(alice, 'POST', '/targets', { name: 'home' });
assert.equal(r.status, 400);
assert.match(r.body.error, /이미 home/);

// another account may use the name, and a guest of a shared PC cannot rename it
r = await call(bob, 'POST', '/targets', { name: 'office-pc' });
assert.equal(r.status, 201, JSON.stringify(r.body));
store.shareTarget(alice, office, 'bob');
r = await call(bob, 'PATCH', `/targets/${office}`, { name: 'mine' });
assert.equal(r.status, 403);
assert.equal(store.target(alice, office).name, 'office-pc');

fs.rmSync(dir, { recursive: true, force: true });
console.log('target-rename: rename, unchanged name, clash, invalid names, register clash, other account, guest refused — ok');
