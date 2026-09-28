import type Database from 'better-sqlite3';

/**
 * Routing / learning / remote-target tables (IMPLEMENTATION-PLAN §3.2). Everything that is
 * not account identity lives here. Only the gateway process writes; runtimes and runners
 * go through the gateway API. Migrations are idempotent: re-running on an existing DB is a no-op.
 */
export type Engine = 'claude' | 'codex';
export const ENGINES: Engine[] = ['claude', 'codex'];
export const TASK_KINDS = ['bulk_read', 'implement', 'debug', 'refactor', 'design', 'ops', 'explain'] as const;
export type TaskKind = typeof TASK_KINDS[number];

export type AgentRow = { id: number; name: string; domain: string; description: string; hint: string | null; verified: number; prompt: string; tools: string | null; model: string | null; max_turns: number | null; owner_id: number | null; source: string; active: number; uses: number; created_at: number; updated_at: number; version: number; skills: string | null; mcp_servers: string | null; min_tier: number | null };
export type AgentVersionRow = { id: number; agent_id: number; version: number; prompt: string; tools: string | null; model: string | null; skills: string | null; mcp_servers: string | null; changelog: string | null; created_at: number };
/** Default life of a sourced knowledge item before it is re-checked against its source (§3.8). */
export const KNOWLEDGE_TTL_MS = 90 * 86400_000;
export type KnowledgeRow = { id: number; agent_id: number; title: string; body: string; source_url: string | null; source_date: string | null; status: string; superseded_by: number | null; expires_at: number | null; owner_id: number | null; created_at: number; updated_at: number; checked_at: number | null; check_fails: number; check_note: string | null; replaces: number | null };
/** Reasoning-effort levels each engine accepts, weakest first (the runtime model catalogs; Claude's
 * 'ultracode' is a session mode, not a level). The user's ceiling is one of these. */
export const EFFORT_LADDER: Record<Engine, string[]> = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
export const DEFAULT_EFFORT_CAP: Record<Engine, string> = { claude: 'xhigh', codex: 'xhigh' };
export type TierPolicyRow = { domain: string; depth: number; engine: string; model: string | null; effort: string | null; success_n: number; fail_n: number; avg_ms: number | null; level: number | null; pinned: number; updated_at: number | null };
export type LessonRow = { id: number; agent_id: number; engine: string | null; trigger: string; rule: string; evidence_run_id: number | null; status: string; hits: number; owner_id: number | null; promoted_to_prompt: number; fails: number; verified_by: string | null; promoted_version: number | null; created_at: number };
export type RunRow = { id: number; user_id: number; session_id: string | null; decision_id: number | null; agent_id: number | null; agent_version: number | null; engine: string | null; model: string | null; effort: string | null; depth: number | null; task_kind: string | null; risk: number | null; target_id: number | null; started_at: number; finished_at: number | null; exit_code: number | null; tool_errors: number; user_feedback: string | null; reverted: number; reasked: number; test_result: string | null; cost_tokens: number | null; escalated_from_run: number | null; outcome: string | null };
export type TargetRow = { id: number; user_id: number; name: string; platform: string | null; arch: string | null; tags: string | null; description: string; token_hash: string | null; pairing_code: string | null; pairing_expires: number | null; policy: string; allowed_roots: string | null; capabilities: string | null; status: string; last_seen: number | null; created_at: number };

const agentName = /^[a-z0-9][a-z0-9-]{1,40}$/;
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

function addColumn(db: Database.Database, table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateAidev(db: Database.Database) {
  addColumn(db, 'accounts', 'engines', "TEXT NOT NULL DEFAULT 'claude,codex'");
  addColumn(db, 'accounts', 'default_engine', 'TEXT');
  addColumn(db, 'accounts', 'role', "TEXT NOT NULL DEFAULT 'user'");
  addColumn(db, 'decision_log', 'kind', "TEXT NOT NULL DEFAULT 'route'");
  addColumn(db, 'decision_log', 'fallback', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'decision_log', 'answer', 'TEXT');
  addColumn(db, 'decision_log', 'final_engine', 'TEXT');
  addColumn(db, 'decision_log', 'final_model', 'TEXT');
  addColumn(db, 'decision_log', 'final_target', 'TEXT');
  addColumn(db, 'decision_log', 'state', 'TEXT');
  addColumn(db, 'agents', 'version', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'agents', 'skills', 'TEXT');
  addColumn(db, 'agents', 'mcp_servers', 'TEXT');
  addColumn(db, 'agents', 'hint', 'TEXT');   // short routing label Laya reads (4-7 English words)
  addColumn(db, 'agents', 'verified', 'INTEGER NOT NULL DEFAULT 0');   // generated agents: self-check passed
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, prompt TEXT NOT NULL, tools TEXT, model TEXT, skills TEXT, mcp_servers TEXT,
      changelog TEXT, created_at INTEGER NOT NULL, UNIQUE(agent_id, version));
    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      title TEXT NOT NULL, body TEXT NOT NULL, source_url TEXT, source_date TEXT,
      status TEXT NOT NULL DEFAULT 'unverified', superseded_by INTEGER, expires_at INTEGER,
      owner_id INTEGER REFERENCES accounts(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_agent ON knowledge(agent_id, status);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title, body, content='knowledge', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE OF title, body ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      engine TEXT, trigger TEXT NOT NULL, rule TEXT NOT NULL, evidence_run_id INTEGER,
      status TEXT NOT NULL DEFAULT 'candidate', hits INTEGER NOT NULL DEFAULT 0,
      owner_id INTEGER REFERENCES accounts(id), promoted_to_prompt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS lessons_agent ON lessons(agent_id, status);
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES accounts(id), session_id TEXT,
      decision_id INTEGER REFERENCES decision_log(id), agent_id INTEGER, agent_version INTEGER,
      engine TEXT, model TEXT, effort TEXT, depth REAL, task_kind TEXT, risk REAL, target_id INTEGER,
      started_at INTEGER NOT NULL, finished_at INTEGER, exit_code INTEGER, tool_errors INTEGER NOT NULL DEFAULT 0,
      user_feedback TEXT, reverted INTEGER NOT NULL DEFAULT 0, reasked INTEGER NOT NULL DEFAULT 0, test_result TEXT,
      cost_tokens INTEGER, escalated_from_run INTEGER, outcome TEXT);
    CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, started_at);
    CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, outcome);
    CREATE TABLE IF NOT EXISTS agent_examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      text TEXT NOT NULL, lang TEXT, source TEXT NOT NULL DEFAULT 'seed', task_kind TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_examples_agent ON agent_examples(agent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_examples_unique ON agent_examples(agent_id, text);
    CREATE TABLE IF NOT EXISTS engine_status (
      user_id INTEGER NOT NULL, engine TEXT NOT NULL, authenticated INTEGER NOT NULL, checked_at INTEGER NOT NULL,
      last_error TEXT, PRIMARY KEY(user_id, engine));
    CREATE TABLE IF NOT EXISTS engine_weights (task_kind TEXT NOT NULL, engine TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY(task_kind, engine));
    CREATE TABLE IF NOT EXISTS tier_policy (
      domain TEXT NOT NULL, depth INTEGER NOT NULL, engine TEXT NOT NULL, model TEXT, effort TEXT,
      success_n INTEGER NOT NULL DEFAULT 0, fail_n INTEGER NOT NULL DEFAULT 0, avg_ms INTEGER, PRIMARY KEY(domain, depth, engine));
    CREATE TABLE IF NOT EXISTS targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES accounts(id), name TEXT NOT NULL,
      platform TEXT, arch TEXT, tags TEXT, description TEXT NOT NULL DEFAULT '', token_hash TEXT,
      pairing_code TEXT, pairing_expires INTEGER, policy TEXT NOT NULL DEFAULT 'ask', allowed_roots TEXT,
      capabilities TEXT, status TEXT NOT NULL DEFAULT 'offline', last_seen INTEGER, created_at INTEGER NOT NULL,
      UNIQUE(user_id, name));
    CREATE TABLE IF NOT EXISTS remote_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, kind TEXT NOT NULL, cmd TEXT, cwd TEXT, risk REAL, approved_by TEXT,
      started_at INTEGER NOT NULL, finished_at INTEGER, exit_code INTEGER, artifacts TEXT);
    CREATE INDEX IF NOT EXISTS remote_runs_target ON remote_runs(target_id, started_at);
  `);
  addColumn(db, 'agent_examples', 'task_kind', 'TEXT');
  addColumn(db, 'agents', 'min_tier', 'INTEGER');   // lowest depth this specialist runs at (§3.4 floors); null = no floor   // label for the task-kind lexical prior (databases created before the column)
  // Web push (mobile PWA) and the Claude subscription-login reminders that use it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL, last_ok INTEGER, failures INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
  `);
  // Lesson verification loop (§3.8 / E-02): which lessons each routed command carried, and how
  // the runs that carried them ended.
  addColumn(db, 'runs', 'next_action', 'TEXT');   // E-03: what the gateway proposed after this run failed (JSON)
  addColumn(db, 'lessons', 'fails', 'INTEGER NOT NULL DEFAULT 0');          // failed runs that carried the lesson
  addColumn(db, 'lessons', 'verified_by', 'TEXT');                          // 'auto' (a trial run succeeded) | 'user'
  addColumn(db, 'lessons', 'promoted_version', 'INTEGER');                  // agent version the rule was merged into
  db.exec(`CREATE TABLE IF NOT EXISTS decision_lessons (
    decision_id INTEGER NOT NULL, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, trial INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(decision_id, lesson_id));`);
  addColumn(db, 'accounts', 'claude_token_expires_at', 'INTEGER');   // reported by the runtime after an in-app login
  addColumn(db, 'accounts', 'claude_auth_failure_at', 'INTEGER');    // reported by the runtime when a turn is refused
  addColumn(db, 'accounts', 'claude_notice', 'TEXT');
  addColumn(db, 'accounts', 'effort_cap', 'TEXT');                  // per-engine effort ceiling chosen by the user (JSON), see routing EFFORT_LADDER                // last reminder sent ("<expiresAt>:<days>" or "fail:<at>")
  // Knowledge refresh (§3.8 / E-04): last check, consecutive unreachable checks, the check's note,
  // and — for a replacement Laya was not sure about — the item a 'proposed' row would replace.
  addColumn(db, 'knowledge', 'checked_at', 'INTEGER');
  addColumn(db, 'knowledge', 'check_fails', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'knowledge', 'check_note', 'TEXT');
  addColumn(db, 'knowledge', 'replaces', 'INTEGER');
  // Tier policy learning (§3.8 / E-05): the cell's effective tier level (null = the table's depth),
  // an administrator pin, when it last changed (stats count from then), and the change log.
  addColumn(db, 'tier_policy', 'level', 'INTEGER');
  addColumn(db, 'tier_policy', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'tier_policy', 'updated_at', 'INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS tier_policy_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, domain TEXT NOT NULL, depth INTEGER NOT NULL, engine TEXT NOT NULL,
    from_level INTEGER, to_level INTEGER, from_model TEXT, to_model TEXT, success_n INTEGER, fail_n INTEGER, reason TEXT NOT NULL, actor TEXT NOT NULL);`);
  // engine_weights seed: bulk reading/analysis prefers Codex, everything else neutral (§0 decisions)
  const n = (db.prepare('SELECT COUNT(*) AS n FROM engine_weights').get() as { n: number }).n;
  if (n === 0) {
    const ins = db.prepare('INSERT INTO engine_weights VALUES(?,?,?)');
    db.transaction(() => {
      for (const kind of TASK_KINDS) for (const engine of ENGINES) ins.run(kind, engine, kind === 'bulk_read' ? (engine === 'codex' ? 0.7 : 0.3) : 0.5);
    })();
  }
  // Engine weight learning (§3.4 / E-06): the seed/admin prior the learned weight is smoothed toward,
  // an admin pin, and the statistics behind the current weight; changes go to engine_weight_log.
  addColumn(db, 'engine_weights', 'prior', 'REAL');
  addColumn(db, 'engine_weights', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'engine_weights', 'success_n', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'engine_weights', 'fail_n', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'engine_weights', 'avg_ms', 'INTEGER');
  addColumn(db, 'engine_weights', 'updated_at', 'INTEGER');
  db.exec(`UPDATE engine_weights SET prior=weight WHERE prior IS NULL;
    CREATE TABLE IF NOT EXISTS engine_weight_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, task_kind TEXT NOT NULL, engine TEXT NOT NULL,
      from_weight REAL, to_weight REAL, success_n INTEGER, fail_n INTEGER, reason TEXT NOT NULL, actor TEXT NOT NULL);`);
}

export function aidevMethods(db: Database.Database) {
  let exampleVersion = 1;
  const m = {
    // ---- key/value + web push ---------------------------------------------
    kvGet(k: string) { return (db.prepare('SELECT v FROM app_kv WHERE k=?').get(k) as { v: string } | undefined)?.v ?? null; },
    kvSet(k: string, v: string) { db.prepare('INSERT INTO app_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v); },
    addPushSubscription(userId: number, endpoint: string, keys: { p256dh: string; auth: string }, userAgent: string | null) {
      db.prepare(`INSERT INTO push_subscriptions(user_id,endpoint,keys,user_agent,created_at) VALUES(?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, keys=excluded.keys, user_agent=excluded.user_agent, failures=0`).run(userId, endpoint, JSON.stringify(keys), userAgent, Date.now());
    },
    removePushSubscription(userId: number, endpoint: string) { return db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(userId, endpoint).changes; },
    dropPushSubscription(id: number) { db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(id); },
    pushSubscriptions(userId: number) {
      return (db.prepare('SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id=?').all(userId) as Array<{ id: number; endpoint: string; keys: string }>)
        .map((row) => ({ id: row.id, endpoint: row.endpoint, keys: JSON.parse(row.keys) as { p256dh: string; auth: string } }));
    },
    markPush(id: number, ok: boolean) {
      if (ok) db.prepare('UPDATE push_subscriptions SET last_ok=?, failures=0 WHERE id=?').run(Date.now(), id);
      else db.prepare('UPDATE push_subscriptions SET failures=failures+1 WHERE id=?').run(id);
    },
    // ---- Claude subscription login state (reported by the user's runtime) ---
    setClaudeAuth(userId: number, report: { expiresAt?: number | null; failureAt?: number | null }) {
      if (report.expiresAt !== undefined) db.prepare('UPDATE accounts SET claude_token_expires_at=?, claude_auth_failure_at=NULL WHERE id=?').run(report.expiresAt, userId);
      if (report.failureAt !== undefined) db.prepare('UPDATE accounts SET claude_auth_failure_at=? WHERE id=?').run(report.failureAt, userId);
    },
    claudeAuthAccounts() {
      return db.prepare('SELECT id, username, claude_token_expires_at AS expiresAt, claude_auth_failure_at AS failureAt, claude_notice AS notice FROM accounts WHERE active=1 AND (claude_token_expires_at IS NOT NULL OR claude_auth_failure_at IS NOT NULL)')
        .all() as Array<{ id: number; username: string; expiresAt: number | null; failureAt: number | null; notice: string | null }>;
    },
    setClaudeNotice(userId: number, notice: string) { db.prepare('UPDATE accounts SET claude_notice=? WHERE id=?').run(notice, userId); },
    // ---- account engines --------------------------------------------------
    accountEngines(userId: number): { engines: Engine[]; defaultEngine: Engine | null; role: string } {
      const row = db.prepare('SELECT engines, default_engine, role FROM accounts WHERE id=?').get(userId) as { engines: string; default_engine: string | null; role: string } | undefined;
      const engines = (row?.engines ?? '').split(',').map((s) => s.trim()).filter((s): s is Engine => ENGINES.includes(s as Engine));
      return { engines: engines.length ? engines : ['claude', 'codex'], defaultEngine: (row?.default_engine as Engine | null) ?? null, role: row?.role ?? 'user' };
    },
    setAccountEngines(username: string, engines: Engine[]) {
      const list = engines.filter((e) => ENGINES.includes(e));
      if (!list.length) throw new Error(`engines must be one or more of ${ENGINES.join(',')}`);
      const r = db.prepare('UPDATE accounts SET engines=? WHERE username=?').run(list.join(','), username);
      if (!r.changes) throw new Error('User not found');
    },
    /** The user's effort ceiling per engine (routing uses it for the top tier and never goes above it). */
    effortCap(userId: number): Record<Engine, string> {
      const row = db.prepare('SELECT effort_cap FROM accounts WHERE id=?').get(userId) as { effort_cap: string | null } | undefined;
      let saved: Partial<Record<Engine, string>> = {};
      try { saved = row?.effort_cap ? JSON.parse(row.effort_cap) as Partial<Record<Engine, string>> : {}; } catch { saved = {}; }
      return { claude: EFFORT_LADDER.claude.includes(saved.claude ?? '') ? saved.claude! : DEFAULT_EFFORT_CAP.claude, codex: EFFORT_LADDER.codex.includes(saved.codex ?? '') ? saved.codex! : DEFAULT_EFFORT_CAP.codex };
    },
    setEffortCap(userId: number, cap: Partial<Record<Engine, string>>) {
      const next = { ...m.effortCap(userId) };
      for (const engine of ENGINES) {
        const value = cap[engine];
        if (value === undefined) continue;
        if (!EFFORT_LADDER[engine].includes(value)) throw new Error(`${engine} effort must be one of ${EFFORT_LADDER[engine].join('|')}`);
        next[engine] = value;
      }
      db.prepare('UPDATE accounts SET effort_cap=? WHERE id=?').run(JSON.stringify(next), userId);
      return next;
    },
    setDefaultEngine(username: string, engine: Engine | null) {
      if (engine && !ENGINES.includes(engine)) throw new Error(`engine must be one of ${ENGINES.join(',')}`);
      const r = db.prepare('UPDATE accounts SET default_engine=? WHERE username=?').run(engine, username);
      if (!r.changes) throw new Error('User not found');
    },
    setRole(username: string, role: 'user' | 'admin') {
      const r = db.prepare('UPDATE accounts SET role=? WHERE username=?').run(role, username);
      if (!r.changes) throw new Error('User not found');
    },
    engineStatus(userId: number) {
      return db.prepare('SELECT engine, authenticated, checked_at, last_error FROM engine_status WHERE user_id=?').all(userId) as Array<{ engine: Engine; authenticated: number; checked_at: number; last_error: string | null }>;
    },
    setEngineStatus(userId: number, engine: Engine, authenticated: boolean, error?: string | null) {
      db.prepare('INSERT INTO engine_status(user_id,engine,authenticated,checked_at,last_error) VALUES(?,?,?,?,?) ON CONFLICT(user_id,engine) DO UPDATE SET authenticated=excluded.authenticated, checked_at=excluded.checked_at, last_error=excluded.last_error')
        .run(userId, engine, authenticated ? 1 : 0, Date.now(), error ?? null);
    },
    engineWeights() {
      const out: Record<string, Record<Engine, number>> = {};
      for (const r of db.prepare('SELECT * FROM engine_weights').all() as Array<{ task_kind: string; engine: Engine; weight: number }>) (out[r.task_kind] ??= { claude: 0.5, codex: 0.5 })[r.engine] = r.weight;
      return out;
    },
    /** Administrator edit: the value becomes the prior too (learning is smoothed toward it); `pinned` stops learning. */
    setEngineWeight(taskKind: string, engine: Engine, weight: number, opts: { pinned?: boolean; actor?: string } = {}) {
      if (!ENGINES.includes(engine)) throw new Error('engine must be claude|codex');
      const w = Math.max(0, Math.min(1, weight));
      const cur = db.prepare('SELECT weight FROM engine_weights WHERE task_kind=? AND engine=?').get(taskKind, engine) as { weight: number } | undefined;
      db.prepare(`INSERT INTO engine_weights(task_kind,engine,weight,prior,pinned,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(task_kind,engine)
        DO UPDATE SET weight=excluded.weight, prior=excluded.prior, pinned=excluded.pinned, updated_at=excluded.updated_at`).run(taskKind, engine, w, w, opts.pinned ? 1 : 0, Date.now());
      m.logEngineWeight({ taskKind, engine, from: cur?.weight ?? null, to: w, successN: 0, failN: 0, reason: `관리자 지정${opts.pinned ? ' (고정)' : ''}`, actor: opts.actor ?? 'admin' });
    },
    engineWeightRows() {
      return db.prepare('SELECT * FROM engine_weights ORDER BY task_kind, engine').all() as Array<{ task_kind: string; engine: Engine; weight: number; prior: number | null; pinned: number; success_n: number; fail_n: number; avg_ms: number | null; updated_at: number | null }>;
    },
    updateLearnedWeight(taskKind: string, engine: Engine, r: { weight: number; successN: number; failN: number; avgMs: number | null }) {
      db.prepare(`INSERT INTO engine_weights(task_kind,engine,weight,prior,success_n,fail_n,avg_ms,updated_at) VALUES(?,?,?,0.5,?,?,?,?) ON CONFLICT(task_kind,engine)
        DO UPDATE SET weight=excluded.weight, success_n=excluded.success_n, fail_n=excluded.fail_n, avg_ms=excluded.avg_ms, updated_at=excluded.updated_at`).run(taskKind, engine, r.weight, r.successN, r.failN, r.avgMs, Date.now());
    },
    logEngineWeight(e: { taskKind: string; engine: string; from: number | null; to: number; successN: number; failN: number; reason: string; actor: string }) {
      db.prepare('INSERT INTO engine_weight_log(at,task_kind,engine,from_weight,to_weight,success_n,fail_n,reason,actor) VALUES(?,?,?,?,?,?,?,?,?)').run(Date.now(), e.taskKind, e.engine, e.from, e.to, e.successN, e.failN, e.reason, e.actor);
    },
    engineWeightLog(limit = 50) { return db.prepare('SELECT * FROM engine_weight_log ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>; },
    /** Finished runs with a clear outcome since `since`, per task kind and engine (weight learning input). */
    engineRuns(since: number) {
      return db.prepare("SELECT task_kind, engine, outcome, started_at, finished_at FROM runs WHERE started_at >= ? AND outcome IN ('success','fail') AND task_kind IS NOT NULL AND engine IN ('claude','codex')").all(since) as Array<{ task_kind: string; engine: Engine; outcome: string; started_at: number; finished_at: number | null }>;
    },
    tierPolicy(domain: string, depth: number, engine: Engine) {
      return db.prepare('SELECT * FROM tier_policy WHERE domain IN (?, \'*\') AND depth=? AND engine=? ORDER BY domain=\'*\' LIMIT 1').get(domain, depth, engine) as { model: string | null; effort: string | null; success_n: number; fail_n: number; avg_ms: number | null; level: number | null } | undefined;
    },
    setAgentMinTier(id: number, minTier: number | null) {
      if (minTier !== null && (!Number.isInteger(minTier) || minTier < 0 || minTier > 4)) throw new Error('min_tier must be 0-4 or null');
      db.prepare('UPDATE agents SET min_tier=? WHERE id=?').run(minTier, id);
    },
    tierPolicyRows() {
      return db.prepare('SELECT * FROM tier_policy ORDER BY domain, depth, engine').all() as TierPolicyRow[];
    },
    tierPolicyRow(domain: string, depth: number, engine: string) {
      return db.prepare('SELECT * FROM tier_policy WHERE domain=? AND depth=? AND engine=?').get(domain, depth, engine) as TierPolicyRow | undefined;
    },
    upsertTierPolicy(r: { domain: string; depth: number; engine: string; level: number | null; model: string | null; effort: string | null; successN: number; failN: number; avgMs: number | null; pinned?: number; updatedAt?: number }) {
      const cur = m.tierPolicyRow(r.domain, r.depth, r.engine);
      db.prepare(`INSERT INTO tier_policy(domain,depth,engine,model,effort,success_n,fail_n,avg_ms,level,pinned,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(domain,depth,engine) DO UPDATE SET model=excluded.model, effort=excluded.effort, success_n=excluded.success_n, fail_n=excluded.fail_n, avg_ms=excluded.avg_ms, level=excluded.level, pinned=excluded.pinned, updated_at=excluded.updated_at`)
        .run(r.domain, r.depth, r.engine, r.model, r.effort, r.successN, r.failN, r.avgMs, r.level, r.pinned ?? cur?.pinned ?? 0, r.updatedAt ?? cur?.updated_at ?? null);
    },
    logTierChange(e: { domain: string; depth: number; engine: string; fromLevel: number; toLevel: number; fromModel: string; toModel: string; successN: number; failN: number; reason: string; actor: string }) {
      db.prepare('INSERT INTO tier_policy_log(at,domain,depth,engine,from_level,to_level,from_model,to_model,success_n,fail_n,reason,actor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(Date.now(), e.domain, e.depth, e.engine, e.fromLevel, e.toLevel, e.fromModel, e.toModel, e.successN, e.failN, e.reason, e.actor);
    },
    tierPolicyLog(limit = 50) { return db.prepare('SELECT * FROM tier_policy_log ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>; },
    /** Finished runs with a clear outcome since `since`, with their agent's domain (policy aggregation input). */
    policyRuns(since: number) {
      return db.prepare(`SELECT r.depth, r.engine, r.model, r.effort, r.outcome, r.started_at, r.finished_at, r.user_feedback, r.reasked, a.domain FROM runs r JOIN agents a ON a.id=r.agent_id
        WHERE r.started_at >= ? AND r.outcome IN ('success','fail') AND r.engine IS NOT NULL AND r.depth IS NOT NULL AND a.domain != 'meta'`).all(since) as Array<{ depth: number; engine: string; model: string | null; effort: string | null; outcome: string; started_at: number; finished_at: number | null; user_feedback: string | null; reasked: number; domain: string }>;
    },
    tierStats(engine: Engine) {
      return db.prepare('SELECT domain, depth, success_n, fail_n FROM tier_policy WHERE engine=?').all(engine) as Array<{ domain: string; depth: number; success_n: number; fail_n: number }>;
    },
    // ---- agents (versions, skills, mcp) -----------------------------------
    agentVersions(agentId: number) { return db.prepare('SELECT * FROM agent_versions WHERE agent_id=? ORDER BY version DESC').all(agentId) as AgentVersionRow[]; },
    /** Snapshot the current definition as a new version row, then apply the patch to the agent. */
    newAgentVersion(agentId: number, patch: Partial<{ prompt: string; tools: string[] | null; model: string | null; skills: string[] | null; mcpServers: Record<string, unknown> | null; description: string; domain: string; maxTurns: number | null }>, changelog: string) {
      const cur = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) as AgentRow | undefined;
      if (!cur) throw new Error('Agent not found');
      if (patch.prompt !== undefined && (patch.prompt.length < 20 || patch.prompt.length > 20000)) throw new Error('Prompt must be 20-20000 characters');
      if (patch.description !== undefined && (patch.description.length < 10 || patch.description.length > 600)) throw new Error('Description must be 10-600 characters');
      const now = Date.now();
      const version = cur.version + 1;
      db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM agent_versions WHERE agent_id=? AND version=?').get(agentId, cur.version))
          db.prepare('INSERT INTO agent_versions(agent_id,version,prompt,tools,model,skills,mcp_servers,changelog,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(agentId, cur.version, cur.prompt, cur.tools, cur.model, cur.skills, cur.mcp_servers, 'initial', cur.created_at);
        const next = {
          prompt: patch.prompt ?? cur.prompt, tools: patch.tools === undefined ? cur.tools : json(patch.tools), model: patch.model === undefined ? cur.model : patch.model,
          skills: patch.skills === undefined ? cur.skills : json(patch.skills), mcp: patch.mcpServers === undefined ? cur.mcp_servers : json(patch.mcpServers),
          description: patch.description ?? cur.description, domain: patch.domain ?? cur.domain, maxTurns: patch.maxTurns === undefined ? cur.max_turns : patch.maxTurns,
        };
        db.prepare('INSERT INTO agent_versions(agent_id,version,prompt,tools,model,skills,mcp_servers,changelog,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(agentId, version, next.prompt, next.tools, next.model, next.skills, next.mcp, changelog.slice(0, 2000), now);
        db.prepare('UPDATE agents SET prompt=?,tools=?,model=?,skills=?,mcp_servers=?,description=?,domain=?,max_turns=?,version=?,updated_at=? WHERE id=?')
          .run(next.prompt, next.tools, next.model, next.skills, next.mcp, next.description, next.domain, next.maxTurns, version, now, agentId);
      })();
      return version;
    },
    bumpExamplesVersion() { exampleVersion++; },
    setAgentVerified(agentId: number, verified: boolean) { db.prepare('UPDATE agents SET verified=?, updated_at=? WHERE id=?').run(verified ? 1 : 0, Date.now(), agentId); },
    promoteAgent(agentId: number) {
      const cur = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) as AgentRow | undefined;
      if (!cur) throw new Error('Agent not found');
      if (cur.owner_id === null) return;
      if (db.prepare('SELECT 1 FROM agents WHERE name=? AND owner_id IS NULL').get(cur.name)) throw new Error('A global agent with this name already exists');
      db.prepare('UPDATE agents SET owner_id=NULL, source=?, updated_at=? WHERE id=?').run('promoted', Date.now(), agentId);
    },
    // ---- routing examples (lexical prior) ---------------------------------
    /** Bumped whenever examples or agents change; the lexical prior retrains lazily on change. */
    examplesVersion() { return exampleVersion; },
    /** Examples plus one pseudo-example per active agent (name + hint + description) so agents without examples still have a lexical footprint. */
    /**
     * Training rows for the lexical agent prior. The generalist is a fallback, not a domain: its
     * examples are generic phrasing ("간단한 앱 만들어봐") that swamps weak domain signals, so they are
     * left out and "generalist" is reached through low confidence instead (bench: same accuracy,
     * "react로 간단한 todo 앱" moves from generalist 0.82 to frontend-react 0.76).
     */
    allExamples() {
      const rows = db.prepare("SELECT e.text, a.name AS agent FROM agent_examples e JOIN agents a ON a.id=e.agent_id WHERE a.active=1 AND a.name!='generalist' AND a.domain!='meta'").all() as Array<{ text: string; agent: string }>;
      const pseudo = (db.prepare("SELECT name, hint, description FROM agents WHERE active=1 AND domain!='meta' AND name!='generalist'").all() as Array<{ name: string; hint: string | null; description: string }>)
        .map((a) => ({ text: `${a.name.replace(/-/g, ' ')} ${a.hint ?? ''} ${a.description}`, agent: a.name }));
      return [...rows, ...pseudo];
    },
    /** Examples labelled with a task kind, for the task-kind lexical prior (label in the `agent` slot). */
    kindExamples() {
      return db.prepare('SELECT text, task_kind AS agent FROM agent_examples WHERE task_kind IS NOT NULL').all() as Array<{ text: string; agent: string }>;
    },
    examples(agentId: number, limit = 200) { return db.prepare('SELECT id, text, lang, source, task_kind, created_at FROM agent_examples WHERE agent_id=? ORDER BY id DESC LIMIT ?').all(agentId, limit) as Array<{ id: number; text: string; lang: string | null; source: string; task_kind: string | null; created_at: number }>; },
    addExamples(agentId: number, items: Array<{ text: string; lang?: string | null; source?: string; taskKind?: string | null }>) {
      const ins = db.prepare('INSERT OR IGNORE INTO agent_examples(agent_id,text,lang,source,task_kind,created_at) VALUES(?,?,?,?,?,?)');
      // an example already present without a label (seeded before the column existed) takes the label now
      const label = db.prepare('UPDATE agent_examples SET task_kind=? WHERE agent_id=? AND text=? AND task_kind IS NULL');
      let added = 0; let labelled = 0;
      db.transaction(() => {
        for (const item of items) {
          const text = item.text.trim().slice(0, 1000);
          if (text.length < 3) continue;
          const lang = item.lang ?? (/[가-힣]/.test(text) ? 'ko' : 'en');
          const kind = item.taskKind && (TASK_KINDS as readonly string[]).includes(item.taskKind) ? item.taskKind : null;
          const inserted = ins.run(agentId, text, lang, item.source ?? 'user', kind, Date.now()).changes;
          added += inserted;
          if (!inserted && kind) labelled += label.run(kind, agentId, text).changes;
        }
      })();
      if (added || labelled) exampleVersion++;
      return added;
    },
    removeExample(id: number) { const r = db.prepare('DELETE FROM agent_examples WHERE id=?').run(id); if (r.changes) exampleVersion++; return r.changes; },
    exampleCount() { return (db.prepare('SELECT COUNT(*) AS n FROM agent_examples').get() as { n: number }).n; },
    agentStats(agentId: number) {
      return db.prepare(`SELECT COUNT(*) AS runs, SUM(outcome='success') AS success, SUM(outcome='fail') AS fail,
        AVG(CASE WHEN finished_at IS NOT NULL THEN finished_at-started_at END) AS avg_ms FROM runs WHERE agent_id=?`).get(agentId) as { runs: number; success: number | null; fail: number | null; avg_ms: number | null };
    },
    // ---- knowledge ----------------------------------------------------------
    /** Items of an agent visible to `userId` (global + their own); without a user, only global items. */
    knowledge(agentId: number, status?: string[], userId?: number | null) {
      const st = status?.length ? status : ['verified', 'sourced'];
      return db.prepare(`SELECT * FROM knowledge WHERE agent_id=? AND status IN (${st.map(() => '?').join(',')}) AND (owner_id IS NULL OR owner_id=?) ORDER BY status='verified' DESC, updated_at DESC`).all(agentId, ...st, userId ?? -1) as KnowledgeRow[];
    },
    knowledgeById(id: number) { return db.prepare('SELECT * FROM knowledge WHERE id=?').get(id) as KnowledgeRow | undefined; },
    searchKnowledge(query: string, agentId: number | undefined, userId: number, limit = 20) {
      const q = query.replace(/["*^]/g, ' ').trim().split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(' OR ');
      if (!q) return [] as KnowledgeRow[];
      return db.prepare(`SELECT k.* FROM knowledge_fts f JOIN knowledge k ON k.id=f.rowid WHERE knowledge_fts MATCH ? ${agentId ? 'AND k.agent_id=?' : ''} AND k.status NOT IN ('superseded','proposed') AND (k.owner_id IS NULL OR k.owner_id=?) ORDER BY bm25(knowledge_fts) LIMIT ?`)
        .all(...(agentId ? [q, agentId, userId, limit] : [q, userId, limit])) as KnowledgeRow[];
    },
    addKnowledge(k: { agentId: number; title: string; body: string; sourceUrl?: string | null; sourceDate?: string | null; status?: string; ownerId: number | null; expiresAt?: number | null; replaces?: number | null; checkNote?: string | null }) {
      if (k.title.length < 3 || k.title.length > 200) throw new Error('title must be 3-200 characters');
      if (k.body.length < 10 || k.body.length > 60000) throw new Error('body must be 10-60000 characters');
      const status = k.status ?? (k.sourceUrl ? 'sourced' : 'unverified');
      if (!['verified', 'sourced', 'unverified', 'proposed'].includes(status)) throw new Error('invalid status');
      const now = Date.now();
      const r = db.prepare('INSERT INTO knowledge(agent_id,title,body,source_url,source_date,status,expires_at,owner_id,created_at,updated_at,replaces,check_note,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(k.agentId, k.title, k.body, k.sourceUrl ?? null, k.sourceDate ?? null, status, k.expiresAt === undefined ? now + KNOWLEDGE_TTL_MS : k.expiresAt, k.ownerId, now, now, k.replaces ?? null, k.checkNote ?? null, k.replaces ? now : null);
      return Number(r.lastInsertRowid);
    },
    updateKnowledge(id: number, patch: Partial<{ status: string; supersededBy: number | null; title: string; body: string; expiresAt: number | null; checkedAt: number | null; checkFails: number; checkNote: string | null }>) {
      const cur = m.knowledgeById(id); if (!cur) throw new Error('Knowledge not found');
      if (patch.status && !['verified', 'sourced', 'unverified', 'superseded', 'proposed'].includes(patch.status)) throw new Error('invalid status');
      db.prepare('UPDATE knowledge SET status=?, superseded_by=?, title=?, body=?, expires_at=?, checked_at=?, check_fails=?, check_note=?, updated_at=? WHERE id=?')
        .run(patch.status ?? cur.status, patch.supersededBy === undefined ? cur.superseded_by : patch.supersededBy, patch.title ?? cur.title, patch.body ?? cur.body, patch.expiresAt === undefined ? cur.expires_at : patch.expiresAt,
          patch.checkedAt === undefined ? cur.checked_at : patch.checkedAt, patch.checkFails ?? cur.check_fails, patch.checkNote === undefined ? cur.check_note : patch.checkNote, Date.now(), id);
    },
    deleteKnowledge(id: number) { db.prepare('DELETE FROM knowledge WHERE id=?').run(id); },
    /**
     * Items whose re-check is due: sourced/verified with a source URL, past `expires_at`, and no
     * replacement already waiting for review. `ownerId` narrows to one owner (null = global items).
     */
    dueKnowledge(limit = 50, ownerId?: number | null) {
      const owner = ownerId === undefined ? '' : ownerId === null ? 'AND k.owner_id IS NULL' : 'AND k.owner_id=?';
      return db.prepare(`SELECT k.* FROM knowledge k WHERE k.status IN ('sourced','verified') AND k.source_url IS NOT NULL AND k.expires_at IS NOT NULL AND k.expires_at < ? ${owner}
        AND NOT EXISTS (SELECT 1 FROM knowledge p WHERE p.replaces=k.id AND p.status='proposed') ORDER BY k.expires_at LIMIT ?`)
        .all(...(ownerId === undefined || ownerId === null ? [Date.now(), limit] : [Date.now(), ownerId, limit])) as KnowledgeRow[];
    },
    /** Replacements waiting for a person (Laya was unsure): the user's own, plus global ones for admins. */
    knowledgeProposals(userId: number, includeGlobal: boolean) {
      return db.prepare(`SELECT p.*, a.name AS agent_name FROM knowledge p JOIN agents a ON a.id=p.agent_id WHERE p.status='proposed' AND (p.owner_id=? ${includeGlobal ? 'OR p.owner_id IS NULL' : ''}) ORDER BY p.created_at DESC`)
        .all(userId) as Array<KnowledgeRow & { agent_name: string }>;
    },
    /** Owners with due items (null = global items), for the scheduled refresh. */
    dueKnowledgeOwners() {
      return (db.prepare(`SELECT DISTINCT k.owner_id AS owner FROM knowledge k WHERE k.status IN ('sourced','verified') AND k.source_url IS NOT NULL AND k.expires_at IS NOT NULL AND k.expires_at < ?
        AND NOT EXISTS (SELECT 1 FROM knowledge p WHERE p.replaces=k.id AND p.status='proposed')`).all(Date.now()) as Array<{ owner: number | null }>).map((r) => r.owner);
    },
    firstAdmin() { return db.prepare("SELECT id, username, runtime FROM accounts WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get() as { id: number; username: string; runtime: string } | undefined; },
    accountById(id: number) { return db.prepare('SELECT id, username, runtime, active FROM accounts WHERE id=?').get(id) as { id: number; username: string; runtime: string; active: number } | undefined; },
    // ---- lessons --------------------------------------------------------------
    lessons(agentId: number, userId: number, status: string[] = ['verified']) {
      return db.prepare(`SELECT * FROM lessons WHERE agent_id=? AND (owner_id IS NULL OR owner_id=?) AND status IN (${status.map(() => '?').join(',')}) ORDER BY hits DESC, created_at DESC`).all(agentId, userId, ...status) as LessonRow[];
    },
    lessonById(id: number) { return db.prepare('SELECT * FROM lessons WHERE id=?').get(id) as LessonRow | undefined; },
    addLesson(l: { agentId: number; engine?: string | null; trigger: string; rule: string; evidenceRunId?: number | null; ownerId: number | null; status?: string }) {
      if (l.trigger.length < 5 || l.trigger.length > 1000) throw new Error('trigger must be 5-1000 characters');
      if (l.rule.length < 5 || l.rule.length > 2000) throw new Error('rule must be 5-2000 characters');
      const r = db.prepare('INSERT INTO lessons(agent_id,engine,trigger,rule,evidence_run_id,status,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(l.agentId, l.engine ?? null, l.trigger, l.rule, l.evidenceRunId ?? null, l.status ?? 'candidate', l.ownerId, Date.now());
      return Number(r.lastInsertRowid);
    },
    updateLesson(id: number, patch: Partial<{ status: string; hits: number; fails: number; promotedToPrompt: number; promotedVersion: number | null; verifiedBy: string | null; rule: string; trigger: string }>) {
      const cur = m.lessonById(id); if (!cur) throw new Error('Lesson not found');
      if (patch.status && !['verified', 'candidate', 'rejected'].includes(patch.status)) throw new Error('invalid status');
      db.prepare('UPDATE lessons SET status=?, hits=?, fails=?, promoted_to_prompt=?, promoted_version=?, verified_by=?, rule=?, trigger=? WHERE id=?')
        .run(patch.status ?? cur.status, patch.hits ?? cur.hits, patch.fails ?? cur.fails, patch.promotedToPrompt ?? cur.promoted_to_prompt,
          patch.promotedVersion === undefined ? cur.promoted_version : patch.promotedVersion, patch.verifiedBy === undefined ? cur.verified_by : patch.verifiedBy,
          patch.rule ?? cur.rule, patch.trigger ?? cur.trigger, id);
    },
    /** Route time: the lessons a command carried (trial = a candidate on probation). */
    recordInjectedLessons(decisionId: number, items: Array<{ id: number; trial: boolean }>) {
      const ins = db.prepare('INSERT OR IGNORE INTO decision_lessons(decision_id, lesson_id, trial) VALUES(?,?,?)');
      db.transaction(() => { for (const item of items) ins.run(decisionId, item.id, item.trial ? 1 : 0); })();
    },
    injectedLessons(decisionId: number) {
      return db.prepare('SELECT l.*, d.trial FROM decision_lessons d JOIN lessons l ON l.id=d.lesson_id WHERE d.decision_id=?').all(decisionId) as Array<LessonRow & { trial: number }>;
    },
    // ---- runs -------------------------------------------------------------------
    addRun(r: { userId: number; sessionId?: string | null; decisionId?: number | null; agentId?: number | null; agentVersion?: number | null; engine?: string | null; model?: string | null; effort?: string | null; depth?: number | null; taskKind?: string | null; risk?: number | null; targetId?: number | null; escalatedFromRun?: number | null }) {
      const res = db.prepare('INSERT INTO runs(user_id,session_id,decision_id,agent_id,agent_version,engine,model,effort,depth,task_kind,risk,target_id,started_at,escalated_from_run) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(r.userId, r.sessionId ?? null, r.decisionId ?? null, r.agentId ?? null, r.agentVersion ?? null, r.engine ?? null, r.model ?? null, r.effort ?? null, r.depth ?? null, r.taskKind ?? null, r.risk ?? null, r.targetId ?? null, Date.now(), r.escalatedFromRun ?? null);
      return Number(res.lastInsertRowid);
    },
    run(userId: number, id: number) { return db.prepare('SELECT * FROM runs WHERE id=? AND user_id=?').get(id, userId) as RunRow | undefined; },
    runs(userId: number, opts: { agentId?: number; limit?: number; sessionId?: string } = {}) {
      const where = ['user_id=?']; const args: unknown[] = [userId];
      if (opts.agentId) { where.push('agent_id=?'); args.push(opts.agentId); }
      if (opts.sessionId) { where.push('session_id=?'); args.push(opts.sessionId); }
      args.push(Math.min(opts.limit ?? 50, 500));
      return db.prepare(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args) as RunRow[];
    },
    /** Merge outcome signals; returns the row after the update so the caller can classify. */
    updateRun(userId: number, id: number, p: Partial<{ sessionId: string | null; finishedAt: number; exitCode: number | null; toolErrors: number; userFeedback: string | null; reverted: number; reasked: number; testResult: string | null; costTokens: number | null; outcome: string | null }>) {
      const cur = m.run(userId, id); if (!cur) throw new Error('Run not found');
      // session_id is only filled in later for runs routed before their session existed (first message of a new chat)
      db.prepare('UPDATE runs SET session_id=?, finished_at=?, exit_code=?, tool_errors=?, user_feedback=?, reverted=?, reasked=?, test_result=?, cost_tokens=?, outcome=? WHERE id=?')
        .run(cur.session_id ?? p.sessionId ?? null, p.finishedAt ?? cur.finished_at, p.exitCode === undefined ? cur.exit_code : p.exitCode, p.toolErrors ?? cur.tool_errors, p.userFeedback === undefined ? cur.user_feedback : p.userFeedback,
          p.reverted ?? cur.reverted, p.reasked ?? cur.reasked, p.testResult === undefined ? cur.test_result : p.testResult, p.costTokens === undefined ? cur.cost_tokens : p.costTokens, p.outcome === undefined ? cur.outcome : p.outcome, id);
      return m.run(userId, id)!;
    },
    recentEngineErrors(userId: number, engine: Engine, sinceMs: number) {
      return (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id=? AND engine=? AND outcome=\'fail\' AND started_at>?').get(userId, engine, Date.now() - sinceMs) as { n: number }).n;
    },
    // ---- decisions (all kinds) ------------------------------------------------
    logKindDecision(d: { userId: number; kind: string; command: string; answer: unknown; confidence?: number | null; probabilities?: unknown; latencyMs?: number | null; device?: string | null; fallback: boolean; state?: unknown }) {
      const r = db.prepare('INSERT INTO decision_log(user_id,kind,command,answer,confidence,probabilities,latency_ms,device,fallback,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(d.userId, d.kind, d.command.slice(0, 4000), json(d.answer), d.confidence ?? null, json(d.probabilities), d.latencyMs ?? null, d.device ?? null, d.fallback ? 1 : 0, d.state === undefined ? null : JSON.stringify(d.state).slice(0, 8000), Date.now());
      return Number(r.lastInsertRowid);
    },
    overrideDecision(userId: number, id: number, p: { finalAgent?: string | null; finalEngine?: string | null; finalModel?: string | null; finalTarget?: string | null; finalAnswer?: unknown }) {
      const r = db.prepare('UPDATE decision_log SET final_agent=COALESCE(?,final_agent), final_engine=COALESCE(?,final_engine), final_model=COALESCE(?,final_model), final_target=COALESCE(?,final_target), outcome=COALESCE(?,outcome) WHERE id=? AND user_id=?')
        .run(p.finalAgent ?? null, p.finalEngine ?? null, p.finalModel ?? null, p.finalTarget ?? null, p.finalAnswer === undefined ? null : JSON.stringify(p.finalAnswer), id, userId);
      if (!r.changes) throw new Error('Decision not found');
    },
    decisionStats(sinceMs: number) {
      return db.prepare('SELECT kind, COUNT(*) AS n, SUM(fallback) AS fallbacks, AVG(latency_ms) AS avg_ms FROM decision_log WHERE created_at>? GROUP BY kind').all(Date.now() - sinceMs) as Array<{ kind: string; n: number; fallbacks: number; avg_ms: number | null }>;
    },
    decisionExportKind(kind: string) {
      return db.prepare('SELECT command, state, answer, COALESCE(final_agent, agent) AS label, final_engine, final_model, probabilities, confidence, fallback, created_at FROM decision_log WHERE kind=? ORDER BY id').all(kind);
    },
    // ---- remote targets ---------------------------------------------------------
    targets(userId: number) { return db.prepare('SELECT * FROM targets WHERE user_id=? ORDER BY name').all(userId) as TargetRow[]; },
    target(userId: number, id: number) { return db.prepare('SELECT * FROM targets WHERE id=? AND user_id=?').get(id, userId) as TargetRow | undefined; },
    targetByTokenHash(hash: string) { return db.prepare('SELECT * FROM targets WHERE token_hash=?').get(hash) as TargetRow | undefined; },
    targetByPairingCode(code: string) { return db.prepare('SELECT * FROM targets WHERE pairing_code=? AND pairing_expires>?').get(code, Date.now()) as TargetRow | undefined; },
    addTarget(t: { userId: number; name: string; platform?: string | null; tags?: string[]; description?: string; policy?: string; pairingCode: string; pairingExpires: number }) {
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(t.name)) throw new Error('Target name: lowercase letters, digits and dashes, 2-41 chars');
      if (t.policy && !['auto', 'ask', 'deny'].includes(t.policy)) throw new Error('policy must be auto|ask|deny');
      const r = db.prepare('INSERT INTO targets(user_id,name,platform,tags,description,pairing_code,pairing_expires,policy,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(t.userId, t.name, t.platform ?? null, json(t.tags ?? []), (t.description ?? '').slice(0, 600), t.pairingCode, t.pairingExpires, t.policy ?? 'ask', Date.now());
      return Number(r.lastInsertRowid);
    },
    updateTarget(userId: number, id: number, p: Partial<{ name: string; description: string; tags: string[]; policy: string; allowedRoots: string[] | null; pairingCode: string | null; pairingExpires: number | null; tokenHash: string | null; platform: string | null; arch: string | null; capabilities: unknown; status: string; lastSeen: number | null }>) {
      const cur = m.target(userId, id); if (!cur) throw new Error('Target not found');
      if (p.policy && !['auto', 'ask', 'deny'].includes(p.policy)) throw new Error('policy must be auto|ask|deny');
      db.prepare('UPDATE targets SET name=?,description=?,tags=?,policy=?,allowed_roots=?,pairing_code=?,pairing_expires=?,token_hash=?,platform=?,arch=?,capabilities=?,status=?,last_seen=? WHERE id=?')
        .run(p.name ?? cur.name, p.description === undefined ? cur.description : p.description.slice(0, 600), p.tags === undefined ? cur.tags : json(p.tags), p.policy ?? cur.policy,
          p.allowedRoots === undefined ? cur.allowed_roots : json(p.allowedRoots), p.pairingCode === undefined ? cur.pairing_code : p.pairingCode, p.pairingExpires === undefined ? cur.pairing_expires : p.pairingExpires,
          p.tokenHash === undefined ? cur.token_hash : p.tokenHash, p.platform === undefined ? cur.platform : p.platform, p.arch === undefined ? cur.arch : p.arch,
          p.capabilities === undefined ? cur.capabilities : json(p.capabilities), p.status ?? cur.status, p.lastSeen === undefined ? cur.last_seen : p.lastSeen, id);
    },
    deleteTarget(userId: number, id: number) { db.prepare('DELETE FROM targets WHERE id=? AND user_id=?').run(id, userId); },
    addRemoteRun(r: { runId?: number | null; targetId: number; userId: number; kind: string; cmd?: string | null; cwd?: string | null; risk?: number | null; approvedBy?: string | null }) {
      const res = db.prepare('INSERT INTO remote_runs(run_id,target_id,user_id,kind,cmd,cwd,risk,approved_by,started_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(r.runId ?? null, r.targetId, r.userId, r.kind, r.cmd?.slice(0, 4000) ?? null, r.cwd ?? null, r.risk ?? null, r.approvedBy ?? null, Date.now());
      return Number(res.lastInsertRowid);
    },
    finishRemoteRun(id: number, p: { exitCode?: number | null; artifacts?: unknown; approvedBy?: string | null }) {
      db.prepare('UPDATE remote_runs SET finished_at=?, exit_code=COALESCE(?,exit_code), artifacts=COALESCE(?,artifacts), approved_by=COALESCE(?,approved_by) WHERE id=?').run(Date.now(), p.exitCode ?? null, json(p.artifacts), p.approvedBy ?? null, id);
    },
    remoteRuns(userId: number, targetId?: number, limit = 50) {
      return db.prepare(`SELECT * FROM remote_runs WHERE user_id=? ${targetId ? 'AND target_id=?' : ''} ORDER BY id DESC LIMIT ?`).all(...(targetId ? [userId, targetId, limit] : [userId, limit]));
    },
  };
  return m;
}

/** Laya sees "name: hint" per option in a ~192-token head shared by all options; keep hints short. */
export function routingHint(agent: { name: string; hint?: string | null; description: string }) {
  if (agent.hint && agent.hint.trim()) return agent.hint.trim().slice(0, 60);
  const english = agent.description.split(/[.。]/)[0].replace(/[^A-Za-z0-9 /+-]/g, ' ').replace(/\s+/g, ' ').trim();
  return english.split(' ').slice(0, 7).join(' ') || agent.name;
}

export { agentName };
