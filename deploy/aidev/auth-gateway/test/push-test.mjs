// Web push end-to-end without the internet: a local HTTPS endpoint plays the browser's push service,
// decrypts what the gateway sends (RFC 8291 aes128gcm) and checks the VAPID header; then the Claude
// login reminder schedule is exercised against a scratch DB.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ece from 'http_ece';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-push-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });

// subscriber keys (what a browser would hold)
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);
const received = [];
let status = 201;
const server = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const body = ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: ecdh, authSecret });
    received.push({ headers: req.headers, payload: JSON.parse(body.toString()) });
    res.writeHead(status); res.end();
  });
});
await new Promise((resolve) => server.listen(0, resolve));
const endpoint = `https://localhost:${server.address().port}/push/abc`;

const { openStore } = await import('../dist/store.js');
const { createPush } = await import('../dist/push.js');
const store = openStore(path.join(dir, 'auth.db'));
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const push = createPush(store, 'mailto:aidev@localhost');
assert.equal(createPush(store, 'mailto:aidev@localhost').publicKey, push.publicKey, 'VAPID keys persist across restarts');
store.addPushSubscription(uid, endpoint, { p256dh: ecdh.getPublicKey('base64url'), auth: authSecret.toString('base64url') }, 'test');

// 1) delivery: encrypted payload decrypts, VAPID + TTL headers present
const r = await push.sendToUser(uid, { title: 't', body: 'b', url: '/m/settings', tag: 'test' });
assert.deepEqual(r, { subscriptions: 1, delivered: 1 });
assert.equal(received[0].payload.url, '/m/settings');
assert.match(received[0].headers.authorization, /^vapid t=.+, k=.+/);
assert.equal(received[0].headers['content-encoding'], 'aes128gcm');
console.log('PASS push delivered, decrypted, VAPID signed');

// 2) reminders: none for a fresh token, then D-30 / D-7 / D-1 / expired each once, failure once
const DAY = 86_400_000; const now = Date.now();
const expiresAt = now + 365 * DAY;
store.setClaudeAuth(uid, { expiresAt });
received.length = 0;
await push.claudeReminders(now);
assert.equal(received.length, 0, 'no reminder a year ahead');
for (const [daysLeft, want] of [[29, /D-29/], [28, null], [6, /D-6/], [1, /D-1/], [0, /만료되었습니다/], [-3, null]]) {
  received.length = 0;
  await push.claudeReminders(expiresAt - daysLeft * DAY + 1000);   // just under daysLeft remaining
  if (want) { assert.equal(received.length, 1, `reminder at ${daysLeft}`); assert.match(received[0].payload.title, want); assert.equal(received[0].payload.url, '/m/settings?login=claude'); }
  else assert.equal(received.length, 0, `no repeat at ${daysLeft}`);
}
console.log('PASS reminders at 30/7/1/0 days, each once');
store.setClaudeAuth(uid, { failureAt: now });
received.length = 0; await push.claudeReminders(now); await push.claudeReminders(now);
assert.equal(received.length, 1); assert.match(received[0].payload.body, /다시 로그인/);
store.setClaudeAuth(uid, { expiresAt: now + 365 * DAY });   // new login clears the failure
received.length = 0; await push.claudeReminders(now);
assert.equal(received.length, 0);
console.log('PASS refused turn notified once; a new login clears it');

// 3) a gone endpoint (410) is dropped
status = 410;
await push.sendToUser(uid, { title: 'x', body: 'y', url: '/m/' });
assert.equal(store.pushSubscriptions(uid).length, 0);
console.log('PASS 410 endpoint removed');
server.close(); store.db.close();
