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
  const usage = 'Usage: list | decisions [N] | add USERNAME | delete USERNAME | disable USERNAME | engines USERNAME codex|claude|claude,codex | default-engine USERNAME claude|codex|none | role USERNAME user|admin';
  const withExtra = ['engines', 'default-engine', 'role'].includes(action ?? '');
  if ((extra && !withExtra) || (withExtra && !extra) || (action === 'list' ? username : action === 'decisions' ? false : !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username ?? ''))) throw new Error(usage);
  if (action === 'decisions') {
    // last routing decisions with the signals behind them (B-13 evidence / routing post-mortems)
    const rows = store.db.prepare("SELECT d.id, a.username, d.command, d.agent, d.probability, d.needs_new, d.decision, d.final_engine, d.final_model, d.fallback, d.probabilities, d.created_at FROM decision_log d JOIN accounts a ON a.id=d.user_id WHERE d.kind='route' ORDER BY d.id DESC LIMIT ?").all(Number(username ?? 10) || 10) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const probs = typeof row.probabilities === 'string' ? JSON.parse(row.probabilities) as Record<string, unknown> : {};
      const top = (m: unknown) => (m && typeof m === 'object' ? Object.entries(m as Record<string, number>).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') : '-');
      console.log(`#${row.id} ${new Date(row.created_at as number).toISOString()} ${row.username}: "${String(row.command).slice(0, 80)}" → ${row.agent} p=${Number(row.probability).toFixed(2)} decision=${row.decision} needs_new=${Number(row.needs_new).toFixed(2)} engine=${row.final_engine ?? '-'} model=${row.final_model ?? '-'}${row.fallback ? ' FALLBACK' : ''}\n    laya: ${top(probs.agent_laya)} | nb: ${top(probs.agent_nb)} | kind: ${top(probs.task_kind)}`);
    }
  } else if (action === 'list') console.log(JSON.stringify(store.db.prepare('SELECT id,username,runtime,active,engines,default_engine,role FROM accounts ORDER BY id').all(), null, 2));
  else if (action === 'engines') { store.setAccountEngines(username, extra.split(',').map((s) => s.trim()) as never); console.log(`${username}: engines=${extra}`); }
  else if (action === 'default-engine') { store.setDefaultEngine(username, extra === 'none' ? null : extra as never); console.log(`${username}: default_engine=${extra}`); }
  else if (action === 'role') { if (extra !== 'user' && extra !== 'admin') throw new Error(usage); store.setRole(username, extra); console.log(`${username}: role=${extra}`); }
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
  } else throw new Error(usage);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Account operation failed'); process.exitCode = 1;
} finally { store.db.close(); }
