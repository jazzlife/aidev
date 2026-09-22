import crypto from 'node:crypto';
import fs from 'node:fs';
import { openStore } from './store.js';

const store = openStore(process.env.DATABASE_PATH ?? '/data/auth.db');
const [action, username, extra] = process.argv.slice(2);
const managerUrl = process.env.RUNTIME_MANAGER_URL ?? 'http://runtime-manager:8090';
const managerToken = fs.readFileSync(process.env.RUNTIME_MANAGER_TOKEN_FILE ?? '/run/secrets/runtime-token', 'utf8').trim();
async function runtime(name: string, operation: 'provision' | 'delete') {
  const response = await fetch(`${managerUrl}/v1/runtimes/${name}/${operation}`, { method: 'POST', headers: { 'x-runtime-token': managerToken }, signal: AbortSignal.timeout(125_000) });
  if (!response.ok) throw new Error(`Runtime ${operation} failed; check runtime-manager logs and retry`);
}
try {
  if (extra || (action === 'list' ? username : !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username ?? ''))) throw new Error('Usage: list | add USERNAME | delete USERNAME | disable USERNAME');
  if (action === 'list') console.log(JSON.stringify(store.db.prepare('SELECT id,username,runtime,active FROM accounts ORDER BY id').all(), null, 2));
  else if (action === 'add') {
    if (store.account(username)) throw new Error('User already exists');
    let password = '';
    for await (const chunk of process.stdin) { password += chunk; if (password.length > 258) throw new Error('Password too long'); }
    const name = `u${crypto.randomBytes(12).toString('hex')}`;
    await store.add(username, password.replace(/\r?\n$/, ''), name, 0);
    try {
      await runtime(name, 'provision');
      store.db.prepare('UPDATE accounts SET active=1 WHERE username=?').run(username);
    } catch (error) {
      try { await runtime(name, 'delete'); store.remove(username); }
      catch { throw new Error(`Provisioning failed; ${username} is disabled. Run delete ${username} to finish cleanup.`); }
      throw error;
    }
    console.log(`Created ${username}: aidev-cloudcli-${name}`);
  } else if (action === 'delete' || action === 'disable') {
    const account = store.account(username);
    if (!account) throw new Error('User not found');
    store.disable(username);
    if (action === 'delete') {
      await runtime(account.runtime, 'delete'); store.remove(username);
      console.log(`Deleted ${username} and its container. Home/workspace volumes retained for recovery.`);
    } else console.log(`Disabled ${username}`);
  } else throw new Error('Usage: list | add USERNAME | delete USERNAME | disable USERNAME');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Account operation failed'); process.exitCode = 1;
} finally { store.db.close(); }
