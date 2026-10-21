import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import { openStore } from './store.js';
import { runTierPolicy } from './tier-policy.js';
import { runEngineWeights } from './engine-weights.js';
import { syncModelScores } from './model-scores.js';
import { effortRank, MODEL_CATALOG } from './provider-policy.js';
import { ENGINES } from './store-aidev.js';

const store = openStore(process.env.DATABASE_PATH ?? '/data/auth.db');
const [action, username, extra] = process.argv.slice(2);
const managerUrl = process.env.RUNTIME_MANAGER_URL ?? 'http://runtime-manager:8090';
const managerToken = fs.readFileSync(process.env.RUNTIME_MANAGER_TOKEN_FILE ?? '/run/secrets/runtime-token', 'utf8').trim();
async function runtime(name: string, operation: 'provision' | 'delete') {
  const response = await fetch(`${managerUrl}/v1/runtimes/${name}/${operation}`, { method: 'POST', headers: { 'x-runtime-token': managerToken }, signal: AbortSignal.timeout(125_000) });
  if (!response.ok) throw new Error(`Runtime ${operation} failed; check runtime-manager logs and retry`);
}
try {
  const usage = 'Usage: list | decisions [N] | tier-policy [run] | session USERNAME | end-session SID | api-key USERNAME NAME[:DAYS] (scoped Laya key for a game/tool, token printed once) | api-keys USERNAME | revoke-key USERNAME KEY_ID | add USERNAME | admin-login USERNAME (password on stdin; signs in to /admin) | delete USERNAME | disable USERNAME | engines USERNAME codex|claude|claude,codex|claude,codex,opencode | default-engine USERNAME claude|codex|opencode|none | role USERNAME user|admin | effort-cap USERNAME claude=xhigh|max,codex=xhigh|max|ultra | model-floor USERNAME claude=opus|best|none,codex=gpt-5.6-sol|gpt-6-astra|none | engine-priority USERNAME claude,codex|opencode,claude,codex|none | model-ceiling USERNAME claude=opus|none,codex=… | effort-floor USERNAME claude=medium|none,codex=… | model-ladder USERNAME claude=sonnet+opus+best|none,codex=… | engine-model opencode MODEL=0..4|none (how hard a task an OpenCode model carries) | verify-priority USERNAME codex,claude|none | score-index USERNAME coding|intelligence|agentic | aa-key (Artificial Analysis API key on stdin) | model-scores [sync] | model-score ENGINE/MODEL[/EFFORT] (OpenCode: opencode/PROVIDER/MODEL[/EFFORT]) ref=AA_ID_OR_SLUG|ref=none|coding=N,intelligence=N,agentic=N|scores=none';
  const withExtra = ['engines', 'default-engine', 'role', 'effort-cap', 'api-key', 'revoke-key', 'model-floor', 'engine-priority', 'model-ceiling', 'effort-floor', 'model-ladder', 'verify-priority', 'score-index', 'model-score', 'engine-model'].includes(action ?? '');
  if ((extra && !withExtra) || (withExtra && !extra) || (action === 'list' ? username : action === 'decisions' ? false : action === 'end-session' ? !/^[A-Za-z0-9_-]{16,128}$/.test(username ?? '') : action === 'tier-policy' ? (username !== undefined && username !== 'run') : action === 'model-scores' ? (username !== undefined && username !== 'sync') : action === 'aa-key' ? username !== undefined : action === 'model-score' ? !/^[a-z]+(\/[A-Za-z0-9._:\[\]-]+){1,3}$/.test(username ?? '') : action === 'engine-model' ? !ENGINES.includes(username as never) : !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username ?? ''))) throw new Error(usage);
  if (action === 'decisions') {
    // last routing decisions with the signals behind them (B-13 evidence / routing post-mortems)
    const rows = store.db.prepare("SELECT d.id, a.username, d.command, d.agent, d.probability, d.needs_new, d.decision, d.final_engine, d.final_model, d.fallback, d.probabilities, d.created_at FROM decision_log d JOIN accounts a ON a.id=d.user_id WHERE d.kind='route' ORDER BY d.id DESC LIMIT ?").all(Number(username ?? 10) || 10) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const probs = typeof row.probabilities === 'string' ? JSON.parse(row.probabilities) as Record<string, unknown> : {};
      const top = (m: unknown) => (m && typeof m === 'object' ? Object.entries(m as Record<string, number>).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') : '-');
      console.log(`#${row.id} ${new Date(row.created_at as number).toISOString()} ${row.username}: "${String(row.command).slice(0, 80)}" → ${row.agent} p=${Number(row.probability).toFixed(2)} decision=${row.decision} needs_new=${Number(row.needs_new).toFixed(2)} engine=${row.final_engine ?? '-'} model=${row.final_model ?? '-'}${row.fallback ? ' FALLBACK' : ''}\n    laya: ${top(probs.agent_laya)} | nb: ${top(probs.agent_nb)} | kind: ${top(probs.task_kind)}`);
    }
  } else if (action === 'session') {
    // Server-side verification (relay `verify` job): a 10-minute gateway session for USERNAME, printed
    // as "<token> <sid>" to the caller on the AI-PC only — no password is typed or sent anywhere.
    const account = store.account(username); if (!account?.active) throw new Error('User not found or disabled');
    const secret = fs.readFileSync(process.env.JWT_SECRET_FILE ?? '/run/secrets/gateway-jwt', 'utf8').trim();
    const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'https://dev.nado.work').origin;
    const ttl = 600;
    const sid = store.issue(account.id, Date.now() + ttl * 1000);
    console.log(`${jwt.sign({ sid, userId: account.id, username }, secret, { expiresIn: ttl, issuer: 'aidev', audience: origin, algorithm: 'HS256' })} ${sid}`);
  } else if (action === 'end-session') {
    store.revoke(username); console.log('session revoked');
  } else if (action === 'tier-policy') {
    // E-05: learned tiers per (domain, depth, engine) and the recent change log; `run` applies a pass now
    if (username === 'run') { const weights = runEngineWeights(store, { actor: 'cli' }); console.log(`engine weights: ${weights.kinds} kinds, ${weights.changes.length} changes`); const result = runTierPolicy(store, { actor: 'cli' }); console.log(`pass: ${result.cells} cells, ${result.changes.length} changes`); for (const c of result.changes) console.log(`  ${c.domain} D${c.depth} ${c.engine}: ${c.fromModel} → ${c.toModel} (${c.reason})`); }
    const last = Number(store.kvGet('tier_policy_at') ?? 0);
    console.log(`last pass: ${last ? new Date(last).toISOString() : 'never'}`);
    for (const r of store.tierPolicyRows()) { const n = r.success_n + r.fail_n; console.log(`${r.domain.padEnd(12)} D${r.depth} ${r.engine.padEnd(6)} ${r.level === null ? 'table' : `→D${r.level} ${r.model}/${r.effort}`}${r.pinned ? ' [pinned]' : ''}  ${n ? `${Math.round((r.success_n / n) * 100)}% of ${n}` : 'no runs'}${r.avg_ms ? ` avg ${Math.round(r.avg_ms / 1000)}s` : ''}`); }
    for (const w of store.engineWeightRows()) { const n = w.success_n + w.fail_n; console.log(`weight ${w.task_kind.padEnd(9)} ${w.engine.padEnd(6)} ${w.weight.toFixed(2)} (prior ${(w.prior ?? w.weight).toFixed(2)})${w.pinned ? ' [pinned]' : ''}  ${n ? `${w.success_n}/${n} ok` : 'no runs'}${w.avg_ms ? ` avg ${Math.round(w.avg_ms / 1000)}s` : ''}`); }
    for (const e of store.engineWeightLog(5)) console.log(`  weight log ${new Date(e.at as number).toISOString().slice(0, 16)} ${e.task_kind}/${e.engine}: ${Number(e.from_weight).toFixed(2)} → ${Number(e.to_weight).toFixed(2)} (${e.reason}; ${e.actor})`);
    for (const e of store.tierPolicyLog(10)) console.log(`  log ${new Date(e.at as number).toISOString().slice(0, 16)} ${e.domain} D${e.depth} ${e.engine}: ${e.from_model} → ${e.to_model} (${e.reason}; ${e.actor})`);
  } else if (action === 'list') console.log(JSON.stringify(store.db.prepare('SELECT id,username,runtime,active,engines,default_engine,role FROM accounts ORDER BY id').all(), null, 2));
  else if (action === 'engines') { store.setAccountEngines(username, extra.split(',').map((s) => s.trim()) as never); console.log(`${username}: engines=${extra}`); }
  else if (action === 'default-engine') { store.setDefaultEngine(username, extra === 'none' ? null : extra as never); console.log(`${username}: default_engine=${extra}`); }
  else if (action === 'effort-cap') {
    const account = store.account(username); if (!account) throw new Error('User not found');
    const cap = Object.fromEntries(extra.split(',').map((pair) => pair.split('=').map((s) => s.trim())));
    console.log(`${username}: effort ceiling ${JSON.stringify(store.setEffortCap(account.id, cap))}`);
  }
  else if (action === 'model-floor') {
    // the weakest model routing may pick per engine ("none" clears); see MODEL_LADDER
    const account = store.account(username); if (!account) throw new Error('User not found');
    const floor = Object.fromEntries(extra.split(',').map((pair) => pair.split('=').map((s) => s.trim())).map(([engine, value]) => [engine, value === 'none' ? null : value]));
    console.log(`${username}: model floor ${JSON.stringify(store.setModelFloor(account.id, floor))}`);
  }
  else if (action === 'engine-priority') {
    // the order engines are used in when more than one is usable ("none" → the learned weights)
    const account = store.account(username); if (!account) throw new Error('User not found');
    console.log(`${username}: engine priority ${JSON.stringify(store.setEnginePriority(account.id, extra === 'none' ? null : extra.split(',').map((s) => s.trim()) as never))}`);
  }
  else if (['model-ceiling', 'effort-floor', 'model-ladder'].includes(action)) {
    // provider policy (PROVIDER-ENGINE-PLAN §3.2): ENGINE=VALUE pairs, "none" clears; a ladder is MODEL+MODEL+… weakest first
    const account = store.account(username); if (!account) throw new Error('User not found');
    const pairs = Object.fromEntries(extra.split(',').map((pair) => pair.split('=').map((s) => s.trim())).map(([engine, value]) => [engine, value === 'none' ? null : action === 'model-ladder' ? value.split('+') : value]));
    const saved = action === 'model-ceiling' ? store.setModelCeiling(account.id, pairs) : action === 'effort-floor' ? store.setEffortFloor(account.id, pairs) : store.setModelLadder(account.id, pairs);
    console.log(`${username}: ${action} ${JSON.stringify(saved)}`);
  }
  else if (action === 'engine-model') {
    // an OpenCode model's level (0–4; none = unmeasured, routed as D2): MODEL=LEVEL
    const at = extra.lastIndexOf('=');
    if (at < 1 || MODEL_CATALOG[username as never]) throw new Error(usage);
    const level = extra.slice(at + 1);
    store.setModelLevel(username as never, extra.slice(0, at), level === 'none' ? null : Number(level));
    console.log(`${username}/${extra.slice(0, at)}: level ${level}`);
  }
  else if (action === 'verify-priority') {
    const account = store.account(username); if (!account) throw new Error('User not found');
    console.log(`${username}: verify priority ${JSON.stringify(store.setVerifyPriority(account.id, extra === 'none' ? null : extra.split(',').map((s) => s.trim()) as never))}`);
  }
  else if (action === 'score-index') {
    const account = store.account(username); if (!account) throw new Error('User not found');
    console.log(`${username}: score index ${store.setScoreIndex(account.id, extra)}`);
  }
  else if (action === 'aa-key') {
    // the Artificial Analysis API key the daily score sync uses; read from stdin so it never lands in shell history
    let key = '';
    for await (const chunk of process.stdin) { key += chunk; if (key.length > 400) throw new Error('Key too long'); }
    key = key.trim();
    if (!key) throw new Error('empty key');
    store.kvSet('aa.api_key', key);
    console.log('Artificial Analysis API key stored');
  }
  else if (action === 'model-scores') {
    if (username === 'sync') { const r = await syncModelScores(store); console.log(JSON.stringify(r)); if (!r.ok) process.exitCode = 1; }
    console.log(`index version ${store.kvGet('aa.index_version') ?? '-'}, synced ${store.kvGet('aa.synced_at') ? new Date(Number(store.kvGet('aa.synced_at'))).toISOString() : 'never'}, key ${store.kvGet('aa.api_key') ? 'set' : 'not set'}`);
    for (const r of store.modelScoreRows()) console.log(`${r.engine}/${r.model}${r.effort ? `/${r.effort}` : ''}  coding ${r.coding ?? '-'}  intelligence ${r.intelligence ?? '-'}  agentic ${r.agentic ?? '-'}  (${r.source}${r.aa_ref ? ` ${r.aa_ref}` : ''}${r.index_version ? ` v${r.index_version}` : ''})`);
  }
  else if (action === 'model-score') {
    // which AA model a combination is (ref=…), or an administrator's own scores (coding=…,intelligence=…,agentic=…)
    // a fixed catalog names its combinations; OpenCode's models are per account ("provider/model"), so only the engine is checked
    const [engine, ...rest] = username.split('/');
    if (!ENGINES.includes(engine as never)) throw new Error(`engine must be one of ${ENGINES.join('|')}`);
    const fixed = (MODEL_CATALOG as Record<string, Array<{ model: string; efforts: string[] }> | undefined>)[engine];
    const effort = (fixed ? rest.length > 1 : rest.length > 2 && effortRank(rest[rest.length - 1]) >= 0) ? rest.pop() : undefined;
    const model = rest.join('/');
    const spec = fixed?.find((x) => x.model === model);
    if (fixed && (!spec || (effort ? !spec.efforts.includes(effort) : spec.efforts.length > 0))) throw new Error(`unknown combination ${username} (efforts: ${spec?.efforts.join('|') || 'none'})`);
    const pairs = Object.fromEntries(extra.split(',').map((pair) => pair.split('=').map((s) => s.trim())));
    if ('ref' in pairs) store.setModelScoreRef(engine as never, model, effort ?? null, pairs.ref === 'none' ? null : pairs.ref);
    else if (pairs.scores === 'none') store.setModelScoreManual(engine as never, model, effort ?? null, null);
    else store.setModelScoreManual(engine as never, model, effort ?? null, Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, Number(v)])));
    console.log(`${username}: ${JSON.stringify(store.modelScoreRows().find((r) => r.engine === engine && r.model === model && r.effort === (effort ?? '')) ?? null)}`);
  }
  else if (action === 'api-key') {
    // A scoped Laya key for a program (game, tool, device). Printed once: the store keeps only its hash.
    // Admin-only, exactly like POST /api/aidev/keys — the key inherits its owner's role, and raw
    // /api/aidev/decide is administrator-only, so a key on a plain account would 403 on half the API.
    const account = store.account(username); if (!account?.active) throw new Error('User not found or disabled');
    if (store.accountEngines(account.id).role !== 'admin') throw new Error(`${username} is not an administrator (set it with: role ${username} admin)`);
    const [name, dayText] = extra.split(':');
    const days = dayText === undefined || dayText === '' ? null : Number(dayText);
    if (days !== null && !Number.isFinite(days)) throw new Error('NAME[:DAYS] — DAYS must be a number of days, or leave it off for a key that does not expire');
    const key = store.createApiKey({ userId: account.id, name: name ?? 'game', scope: 'decide', days });
    console.log(key.token);
    console.error(`key #${key.id} "${key.name}" scope=${key.scope} for ${username}; ${key.expiresAt ? `expires ${new Date(key.expiresAt).toISOString()}` : 'no expiry'}. The token above is shown once.`);
  }
  else if (action === 'api-keys') {
    const account = store.account(username); if (!account) throw new Error('User not found');
    const rows = store.apiKeys(account.id);
    if (!rows.length) console.log('no keys');
    for (const k of rows) {
      const state = k.revoked_at ? 'revoked' : k.expires_at && k.expires_at <= Date.now() ? 'expired' : 'active';
      console.log(`#${k.id} ${k.prefix}… ${k.scope.padEnd(7)} ${state.padEnd(8)} "${k.name}" uses=${k.uses} last=${k.last_used_at ? new Date(k.last_used_at).toISOString().slice(0, 16) : 'never'} expires=${k.expires_at ? new Date(k.expires_at).toISOString().slice(0, 10) : '-'}`);
    }
  }
  else if (action === 'revoke-key') {
    const account = store.account(username); if (!account) throw new Error('User not found');
    if (!store.revokeApiKey(account.id, Number(extra))) throw new Error('No such active key for that user');
    console.log(`key #${extra} revoked`);
  }
  else if (action === 'role') { if (extra !== 'user' && extra !== 'admin') throw new Error(usage); store.setRole(username, extra); console.log(`${username}: role=${extra}`); }
  else if (action === 'admin-login') {
    // the /admin page's own sign-in, kept as a hash in app_kv — the password never lands in the repository
    let password = '';
    for await (const chunk of process.stdin) { password += chunk; if (password.length > 258) throw new Error('Password too long'); }
    await store.setAdminLogin(username, password.replace(/\r?\n$/, ''));
    console.log(`admin login set: ${username}`);
  }
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
