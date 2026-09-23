import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { aidevMethods, migrateAidev, agentName, type AgentRow } from './store-aidev.js';

/** Gateway server and offline administration share this persistent identity store. */
export function openStore(filename: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, runtime TEXT UNIQUE NOT NULL,
      active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS gateway_sessions (
      sid TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
    -- Specialist agent catalog: one row = one Claude Agent SDK AgentDefinition.
    -- owner_id NULL = global (seeded or admin), otherwise private to that account.
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '', description TEXT NOT NULL, prompt TEXT NOT NULL,
      tools TEXT, model TEXT, max_turns INTEGER,
      owner_id INTEGER REFERENCES accounts(id), source TEXT NOT NULL DEFAULT 'user',
      active INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(name, owner_id));
    -- Every routing decision, for calibration/fine-tuning of Laya and for the UI history.
    CREATE TABLE IF NOT EXISTS decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES accounts(id),
      command TEXT NOT NULL, agent TEXT, probability REAL, confidence REAL, needs_new REAL, risk REAL,
      decision TEXT, probabilities TEXT, latency_ms REAL, device TEXT, final_agent TEXT, outcome TEXT,
      created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS decision_log_user ON decision_log(user_id, created_at);
  `);
  migrateAidev(db);
  type Account = { id: number; username: string; password_hash: string; runtime: string; active: number; engines: string; default_engine: string | null; role: string };
  const aidev = aidevMethods(db);
  return {
    db,
    ...aidev,
    // ---- specialist agents -------------------------------------------------
    agents(userId: number, includeInactive = false) {
      return db.prepare(`SELECT * FROM agents WHERE (owner_id IS NULL OR owner_id=?) ${includeInactive ? '' : 'AND active=1'} ORDER BY owner_id IS NOT NULL, domain, name`).all(userId) as AgentRow[];
    },
    agent(userId: number, name: string) {
      // a private agent shadows a global one with the same name
      return db.prepare('SELECT * FROM agents WHERE name=? AND (owner_id=? OR owner_id IS NULL) AND active=1 ORDER BY owner_id IS NULL LIMIT 1').get(name, userId) as AgentRow | undefined;
    },
    agentById(id: number) { return db.prepare('SELECT * FROM agents WHERE id=?').get(id) as AgentRow | undefined; },
    addAgent(a: { name: string; domain?: string; description: string; hint?: string | null; prompt: string; tools?: string[] | null; model?: string | null; maxTurns?: number | null; ownerId: number | null; source: string; skills?: string[] | null; mcpServers?: Record<string, unknown> | null }) {
      if (!agentName.test(a.name)) throw new Error('Agent name: lowercase letters, digits and dashes, 2-41 chars');
      if (a.description.length < 10 || a.description.length > 600) throw new Error('Description must be 10-600 characters (it is what the router sees)');
      if (a.prompt.length < 20 || a.prompt.length > 20000) throw new Error('Prompt must be 20-20000 characters');
      const now = Date.now();
      if (a.hint && a.hint.length > 60) throw new Error('hint must be at most 60 characters (4-7 English words)');
      const r = db.prepare('INSERT INTO agents(name,domain,description,prompt,tools,model,max_turns,owner_id,source,created_at,updated_at,skills,mcp_servers,hint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(a.name, a.domain ?? '', a.description, a.prompt, a.tools ? JSON.stringify(a.tools) : null, a.model ?? null, a.maxTurns ?? null, a.ownerId, a.source, now, now, a.skills ? JSON.stringify(a.skills) : null, a.mcpServers ? JSON.stringify(a.mcpServers) : null, a.hint?.trim() || null);
      const id = Number(r.lastInsertRowid);
      aidev.bumpExamplesVersion();
      db.prepare('INSERT INTO agent_versions(agent_id,version,prompt,tools,model,skills,mcp_servers,changelog,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, 1, a.prompt, a.tools ? JSON.stringify(a.tools) : null, a.model ?? null, a.skills ? JSON.stringify(a.skills) : null, a.mcpServers ? JSON.stringify(a.mcpServers) : null, 'initial', now);
      return id;
    },
    updateAgent(id: number, patch: Partial<{ domain: string; description: string; hint: string | null; prompt: string; tools: string[] | null; model: string | null; maxTurns: number | null; active: number }>) {
      const cur = this.agentById(id); if (!cur) throw new Error('Agent not found');
      if (patch.hint && patch.hint.length > 60) throw new Error('hint must be at most 60 characters');
      const next = { domain: patch.domain ?? cur.domain, description: patch.description ?? cur.description, prompt: patch.prompt ?? cur.prompt,
        tools: patch.tools === undefined ? cur.tools : (patch.tools ? JSON.stringify(patch.tools) : null), model: patch.model === undefined ? cur.model : patch.model,
        max_turns: patch.maxTurns === undefined ? cur.max_turns : patch.maxTurns, active: patch.active ?? cur.active, hint: patch.hint === undefined ? cur.hint : (patch.hint?.trim() || null) };
      db.prepare('UPDATE agents SET domain=?,description=?,prompt=?,tools=?,model=?,max_turns=?,active=?,hint=?,updated_at=? WHERE id=?')
        .run(next.domain, next.description, next.prompt, next.tools, next.model, next.max_turns, next.active, next.hint, Date.now(), id);
      aidev.bumpExamplesVersion();
    },
    bumpAgentUse(userId: number, name: string) { db.prepare('UPDATE agents SET uses=uses+1 WHERE name=? AND (owner_id=? OR owner_id IS NULL)').run(name, userId); },
    /** Seed routing examples for global agents (idempotent: (agent,text) unique). Returns rows added. */
    seedExamples(rows: Array<{ agent: string; text: string; lang?: string | null }>) {
      let added = 0;
      const byAgent = new Map<string, Array<{ text: string; lang?: string | null; source: string }>>();
      for (const row of rows) { const list = byAgent.get(row.agent) ?? []; list.push({ text: row.text, lang: row.lang ?? null, source: 'seed' }); byAgent.set(row.agent, list); }
      for (const [name, items] of byAgent) {
        const agent = db.prepare('SELECT id FROM agents WHERE name=? AND owner_id IS NULL').get(name) as { id: number } | undefined;
        if (agent) added += aidev.addExamples(agent.id, items);
      }
      return added;
    },
    /** Insert every seed agent whose name is not yet a global agent (existing rows are never overwritten). */
    seedAgents(seed: Array<{ name: string; domain: string; description: string; hint?: string; prompt: string; tools?: string[]; model?: string; maxTurns?: number; skills?: string[] }>) {
      let added = 0;
      db.transaction(() => {
        for (const a of seed) {
          const existing = db.prepare('SELECT id, hint FROM agents WHERE name=? AND owner_id IS NULL').get(a.name) as { id: number; hint: string | null } | undefined;
          if (existing) {
            // seeds may gain a routing hint after the row was created (migration from older releases)
            if (!existing.hint && a.hint) db.prepare('UPDATE agents SET hint=? WHERE id=?').run(a.hint, existing.id);
            continue;
          }
          this.addAgent({ ...a, ownerId: null, source: 'seed' }); added++;
        }
      })();
      return added;
    },
    // ---- routing decisions -------------------------------------------------
    logDecision(d: { userId: number; command: string; agent?: string; probability?: number; confidence?: number; needsNew?: number; risk?: number; decision?: string; probabilities?: unknown; latencyMs?: number; device?: string }) {
      const r = db.prepare('INSERT INTO decision_log(user_id,command,agent,probability,confidence,needs_new,risk,decision,probabilities,latency_ms,device,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(d.userId, d.command.slice(0, 4000), d.agent ?? null, d.probability ?? null, d.confidence ?? null, d.needsNew ?? null, d.risk ?? null, d.decision ?? null, d.probabilities ? JSON.stringify(d.probabilities) : null, d.latencyMs ?? null, d.device ?? null, Date.now());
      return Number(r.lastInsertRowid);
    },
    finalizeDecision(userId: number, id: number, finalAgent: string | null, outcome: string | null) {
      db.prepare('UPDATE decision_log SET final_agent=COALESCE(?,final_agent), outcome=COALESCE(?,outcome) WHERE id=? AND user_id=?').run(finalAgent, outcome, id, userId);
    },
    decisions(userId: number, limit = 100) {
      return db.prepare('SELECT id,command,agent,probability,confidence,needs_new,risk,decision,final_agent,outcome,latency_ms,created_at FROM decision_log WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, Math.min(limit, 1000));
    },
    // Training export: (command, final agent) pairs across all users, for Laya calibration/fine-tune.
    decisionExport() {
      return db.prepare('SELECT command, COALESCE(final_agent, agent) AS label, probability, confidence, decision, created_at FROM decision_log WHERE COALESCE(final_agent, agent) IS NOT NULL ORDER BY id').all();
    },
    account(username: string) { return db.prepare('SELECT * FROM accounts WHERE username=?').get(username) as Account | undefined; },
    accountByRuntime(runtime: string) { return db.prepare('SELECT * FROM accounts WHERE runtime=?').get(runtime) as Account | undefined; },
    session(sid: string) {
      return db.prepare(`SELECT a.* FROM accounts a JOIN gateway_sessions s ON s.user_id=a.id
        WHERE s.sid=? AND s.expires>? AND a.active=1`).get(sid, Date.now()) as Account | undefined;
    },
    issue(userId: number, expires: number) {
      const sid = crypto.randomBytes(32).toString('hex');
      db.prepare('DELETE FROM gateway_sessions WHERE expires<=?').run(Date.now());
      db.prepare('INSERT INTO gateway_sessions VALUES(?,?,?)').run(sid, userId, expires);
      return sid;
    },
    revoke(sid: string) { db.prepare('DELETE FROM gateway_sessions WHERE sid=?').run(sid); },
    async check(password: string, encoded: string) {
      const [salt, hash] = encoded.split(':');
      const derived = await derive(password, salt);
      const expected = Buffer.from(hash, 'hex');
      return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    },
    async add(username: string, password: string, runtime: string, active = 1) {
      if (!/^[a-z0-9_.-]{3,64}$/.test(username) || password.length < 4 || password.length > 256) throw new Error('Use a lowercase username and a password of 4–256 characters');
      const salt = crypto.randomBytes(16).toString('hex');
      const encoded = `${salt}:${(await derive(password, salt)).toString('hex')}`;
      db.prepare('INSERT INTO accounts(username,password_hash,runtime,active) VALUES(?,?,?,?)').run(username, encoded, runtime, active);
    },
    remove(username: string) {
      db.transaction(() => {
        db.prepare('DELETE FROM gateway_sessions WHERE user_id IN (SELECT id FROM accounts WHERE username=?)').run(username);
        db.prepare('DELETE FROM accounts WHERE username=?').run(username);
      })();
    },
    disable(username: string) {
      db.transaction(() => {
        db.prepare('DELETE FROM gateway_sessions WHERE user_id IN (SELECT id FROM accounts WHERE username=?)').run(username);
        db.prepare('UPDATE accounts SET active=0 WHERE username=?').run(username);
      })();
    },
  };
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, hash) => error ? reject(error) : resolve(hash)));
}
