import { authenticatedFetch } from '@/shared/api';

/**
 * Gateway `/api/aidev/*` client (IMPLEMENTATION-PLAN §3.3). Shared, non-visual: the
 * workbench and the mobile app both use it. Errors are thrown as Error with the
 * gateway's message so callers can degrade (routing is never allowed to block a send).
 */
export type Engine = 'claude' | 'codex';

export type RouteScope = {
  depth: number;
  depth_raw: number;
  task_kind: string;
  task_kind_probability: number;
  risk: number;
  multi_domain: number;
  clarify: number;
  remote_action: string;
  needs_llm_analysis: boolean;
  ask_clarify: boolean;
};

export type AgentDefinition = {
  prompt: string;
  tools: string[] | null;
  model: string | null;
  maxTurns: number | null;
  skills: string[] | null;
  mcpServers: Record<string, unknown> | null;
};

export type RouteTarget = { id: number; name: string; platform: string | null; tags: string[]; capabilities: unknown } | null;

export type ArchitectDefinition = { name: string; version: number; description: string; prompt: string; tools: string[] | null; maxTurns: number | null; model: string | null };

export type RouteResult = {
  decision_id: number;
  decision: 'use' | 'generalist' | 'create' | 'create_background';
  /** Present when no fitting agent exists: what to send to the agent-architect first (§3.7). */
  create: { architect: ArchitectDefinition; catalog: string; background: boolean } | null;
  fallback: boolean;
  laya_error: string | null;
  scope: RouteScope;
  agent: { id: number; name: string; version: number; domain: string; description: string; probability: number; confidence: number; definition: AgentDefinition };
  alternatives: Array<{ name: string; probability: number; description: string }>;
  needs_new: number;
  plan: { engine: Engine | null; engine_locked: boolean; engine_error?: string | null; model: string | null; effort: string | null; target: RouteTarget; reason: string[] };
  engines: Record<Engine, { allowed: boolean; authenticated: boolean; error?: string | null; score: number | null; notes: string[] }>;
  lessons: Array<{ id: number; trigger: string; rule: string; trial?: boolean }>;
  knowledge_digest: string | null;
  latency_ms: number | null;
  total_ms: number;
  device: string | null;
};

export type DecideResult = {
  decision_id: number;
  kind: string;
  answer: unknown;
  confidence: number;
  probabilities?: Record<string, number>;
  fallback: boolean;
  reason?: string;
  latency_ms: number | null;
};

export type EnginesResult = {
  engines: RouteResult['engines'];
  default_engine: Engine | null;
  role: string;
  /** the user's reasoning-effort ceiling per engine and the levels each engine accepts (weakest first) */
  effort_cap?: Record<Engine, string>;
  effort_ladder?: Record<Engine, string[]>;
  weights: Record<string, Record<Engine, number>>;
};

export type CatalogAgent = {
  id: number;
  name: string;
  domain: string;
  description: string;
  hint: string | null;
  prompt: string;
  tools: string[] | null;
  model: string | null;
  maxTurns: number | null;
  skills: string[] | null;
  mcpServers: Record<string, unknown> | null;
  ownerId: number | null;
  source: string;
  verified?: boolean;
  active: boolean;
  uses: number;
  version: number;
  /** lowest depth (D0-D4) this specialist runs at; null = no floor */
  minTier?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type RouteRequest = {
  /** this chat's own effort ceiling (a new chat sends it with its first message) */
  effortCap?: Partial<Record<Engine, string>> | null;
  text: string;
  sessionId?: string | null;
  sessionEngine?: Engine | null;
  preferEngine?: Engine | null;
  targetId?: number | null;
  projectHint?: string | null;
  recentFiles?: string[] | null;
  model?: string | null;
  effort?: string | null;
  forceAgent?: string | null;
};

/** Draft produced by the agent-architect (parsed from its <aidev-agent> block). */
export type AgentDraft = {
  name: string;
  domain: string;
  hint: string;
  description: string;
  prompt: string;
  tools: string[] | null;
  examples: string[];
  knowledge: Array<{ title: string; body: string; source_url?: string; source_date?: string }>;
  self_check: { task: string; expected: string } | null;
};

/** Used by the create-flow watcher (ChatInterface / mobile ChatScreen) to pull the architect's draft out of an assistant message. */
export function parseAgentDraft(text: string): AgentDraft | null {
  const match = /<aidev-agent>\s*([\s\S]*?)\s*<\/aidev-agent>/.exec(text);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1].replace(/^```(?:json)?/m, '').replace(/```$/m, '')) as Record<string, unknown>;
    if (typeof raw.name !== 'string' || typeof raw.prompt !== 'string') return null;
    return {
      name: raw.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41),
      domain: typeof raw.domain === 'string' ? raw.domain.slice(0, 40) : '',
      hint: typeof raw.hint === 'string' ? raw.hint.slice(0, 60) : '',
      description: typeof raw.description === 'string' ? raw.description.slice(0, 600) : '',
      prompt: raw.prompt,
      tools: Array.isArray(raw.tools) ? raw.tools.map(String) : null,
      examples: Array.isArray(raw.examples) ? raw.examples.filter((e): e is string => typeof e === 'string' && e.trim().length > 3).slice(0, 50) : [],
      knowledge: Array.isArray(raw.knowledge) ? raw.knowledge.filter((k): k is Record<string, string> => Boolean(k && typeof k === 'object' && typeof (k as Record<string, unknown>).title === 'string' && typeof (k as Record<string, unknown>).body === 'string')).map((k) => ({ title: k.title, body: k.body, source_url: k.source_url, source_date: k.source_date })) : [],
      self_check: raw.self_check && typeof raw.self_check === 'object' && typeof (raw.self_check as Record<string, unknown>).task === 'string' ? { task: String((raw.self_check as Record<string, unknown>).task), expected: String((raw.self_check as Record<string, unknown>).expected ?? '') } : null,
    };
  } catch {
    return null;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || `aidev request failed (${response.status})`);
  }
  return data;
}

const post = (url: string, body: unknown, method = 'POST') => authenticatedFetch(url, { method, body: JSON.stringify(body) });

/** Runtime endpoints answer `{success, data}`; the gateway's aidev endpoints answer the payload itself. */
async function readRuntimeData<T>(response: Response): Promise<T> {
  const body = await readJson<{ success?: boolean; data?: T; error?: string }>(response);
  if (body.success === false) throw new Error(body.error || 'request failed');
  return body.data as T;
}

/** What the gateway proposes after a routed run failed (E-03); offered to the user as a one-tap card. */
export type NextAction = {
  action: 'retry_same' | 'escalate_tier' | 'switch_engine' | 'ask_user';
  engine: Engine | null; model: string | null; effort: string | null; depth: number | null;
  from_run: number; chain: number; reason: string;
};

/** A stored knowledge item as the catalog shows it (E-04 adds the re-check fields). */
export type KnowledgeItem = { id: number; agent_id: number; title: string; body: string; source_url: string | null; source_date: string | null; status: string; expires_at: number | null; checked_at: number | null; check_fails: number; check_note: string | null; replaces: number | null; owner_id: number | null };
export type KnowledgeProposal = KnowledgeItem & { agent_name: string; replaces_item: KnowledgeItem | null };
export type KnowledgeRefreshJob = { running: boolean; total: number; done: number; results: Array<{ id: number; title: string; outcome: string; note: string; newId?: number }>; startedAt: number; finishedAt: number | null; error: string | null };

/** One learned tier cell (agent domain × depth × engine) and the change log (E-05). */
export type TierPolicyCell = { domain: string; depth: number; engine: Engine; model: string | null; effort: string | null; success_n: number; fail_n: number; avg_ms: number | null; level: number | null; pinned: number; updated_at: number | null };
export type EngineWeightRow = { task_kind: string; engine: Engine; weight: number; prior: number | null; pinned: number; success_n: number; fail_n: number; avg_ms: number | null; updated_at: number | null };
export type TierPolicyView = { downgrade?: boolean; cells: TierPolicyCell[]; log: Array<{ id: number; at: number; domain: string; depth: number; engine: string; from_model: string; to_model: string; reason: string; actor: string }>; last_run: number | null; table: Record<number, Record<Engine, { model: string; effort: string }>> };

/** An agent's remote command waiting for (or answered by) the user — gateway remote gate (F-05). */
export type RemoteApproval = {
  id: string; targetId: number; targetName: string; cmd: string; cwd: string | null; agent: string | null; runId: number | null;
  risk: number; reasons: string[]; destructive: boolean; policy: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired'; createdAt: number; expiresAt: number; decidedAt: number | null; decidedBy: string | null;
  remoteRunId: number | null; error: string | null;
};

/** A command run on a remote PC (remote_runs row + the live stream while the gateway holds it). */
export type RemoteRun = {
  id: number; target_id: number; target_name: string | null; kind: string; cmd: string | null; cwd: string | null; approved_by: string | null;
  started_at: number; finished_at: number | null; exit_code: number | null;
  artifacts: { signal?: string | null; lost?: boolean; error?: string; bytes?: number; duration_ms?: number } | null;
  live: { streamId: number; running: boolean; code: number | null; signal: string | null; durationMs: number | null; pty: boolean } | null;
};

/** GET/PUT /session-settings/:id — the chat's ceiling, the account default and what routing will use. */
export type SessionEffortCap = { effort_cap: Partial<Record<Engine, string>> | null; default: Record<Engine, string>; effective: Record<Engine, string> };

/** Platform-managed Claude subscription login state (runtime `/api/aidev-tools/claude-login`). */
export type ClaudeLoginStatus = { token: { issuedAt: number; expiresAt: number } | null; failure: { at: number; message: string } | null };

/** Used by the aidev-router hooks, the workbench router bar and the mobile router chip. */
export const aidevApi = {
  route: (input: RouteRequest) => post('/api/aidev/route', input).then((response) => readJson<RouteResult>(response)),
  decide: (kind: string, state: Record<string, unknown>, options?: Record<string, string>) =>
    post(`/api/aidev/decide/${encodeURIComponent(kind)}`, { state, options }).then((response) => readJson<DecideResult>(response)),
  overrideDecision: (id: number, patch: { final_agent?: string; final_engine?: Engine; final_model?: string; final_target?: string; final_answer?: unknown }) =>
    post(`/api/aidev/decisions/${id}`, patch, 'PATCH').then((response) => readJson<{ ok: boolean }>(response)),
  engines: (refresh = false) => authenticatedFetch(`/api/aidev/engines${refresh ? '?refresh=1' : ''}`).then((response) => readJson<EnginesResult>(response)),
  claudeLoginStatus: () => authenticatedFetch('/api/aidev-tools/claude-login').then((response) => readRuntimeData<ClaudeLoginStatus>(response)),
  claudeLoginStart: () => post('/api/aidev-tools/claude-login/start', {}).then((response) => readRuntimeData<{ loginId: string; url: string }>(response)),
  claudeLoginCode: (loginId: string, code: string) => post('/api/aidev-tools/claude-login/code', { login_id: loginId, code }).then((response) => readRuntimeData<{ issuedAt: number; expiresAt: number }>(response)),
  claudeLoginCancel: (loginId: string) => post('/api/aidev-tools/claude-login/cancel', { login_id: loginId }).then(() => undefined),
  agents: () => authenticatedFetch('/api/aidev/agents').then((response) => readJson<{ agents: CatalogAgent[] }>(response)),
  agent: (id: number) => authenticatedFetch(`/api/aidev/agents/${id}`).then((response) => readJson<Record<string, unknown>>(response)),
  createAgent: (input: Record<string, unknown>) => post('/api/aidev/agents', input).then((response) => readJson<{ agent: CatalogAgent }>(response)),
  updateAgent: (id: number, input: Record<string, unknown>) => post(`/api/aidev/agents/${id}`, input, 'PUT').then((response) => readJson<{ agent: CatalogAgent; version: number }>(response)),
  createRun: (input: Record<string, unknown>) => post('/api/aidev/runs', input).then((response) => readJson<{ run_id: number }>(response)),
  runOutcome: (runId: number, outcome: Record<string, unknown>) => post(`/api/aidev/runs/${runId}/outcome`, outcome, 'PATCH').then((response) => readJson<{ run: Record<string, unknown>; next?: NextAction | null }>(response)),
  handoffBrief: (sessionId: string, input: { from_engine?: string | null; to_engine?: string | null; reason?: string | null }) => post('/api/aidev-tools/handoff', { session_id: sessionId, ...input }).then((response) => readRuntimeData<{ text: string; files: string[]; userTurns: number }>(response)),
  targets: () => authenticatedFetch('/api/aidev/targets').then((response) => readJson<{ targets: Array<Record<string, unknown>> }>(response)),
  /** Remote runs (F-03) across targets, newest first — mobile result cards. */
  remoteRuns: (limit = 10) => authenticatedFetch(`/api/aidev/remote-runs?limit=${limit}`).then((response) => readJson<{ runs: RemoteRun[] }>(response)),
  remoteRun: (id: number) => authenticatedFetch(`/api/aidev/remote-runs/${id}`).then((response) => readJson<{ run: RemoteRun }>(response)),
  /** Last output as plain text (ANSI codes stripped). */
  remoteRunLog: (id: number, bytes = 16384) => authenticatedFetch(`/api/aidev/remote-runs/${id}/log?plain=1&bytes=${bytes}`).then(async (response) => { if (!response.ok) throw new Error(`log ${response.status}`); return response.text(); }),
  /** Agent commands waiting for the user's approval (F-05). */
  approvals: (all = false) => authenticatedFetch(`/api/aidev/approvals${all ? '?all=1' : ''}`).then((response) => readJson<{ approvals: RemoteApproval[] }>(response)),
  answerApproval: (id: string, allow: boolean, auto = false) => post(`/api/aidev/approvals/${id}`, { allow, auto }).then((response) => readJson<{ approval: RemoteApproval }>(response)),
  remoteRunSignal: (id: number, signal: 'INT' | 'KILL' = 'INT') => post(`/api/aidev/remote-runs/${id}/signal`, { signal }).then((response) => readJson<{ ok: boolean }>(response)),
  agentExamples: (id: number) => authenticatedFetch(`/api/aidev/agents/${id}/examples`).then((response) => readJson<{ examples: Array<{ id: number; text: string; source: string }> }>(response)),
  addAgentExamples: (id: number, examples: string[]) => post(`/api/aidev/agents/${id}/examples`, { examples }).then((response) => readJson<{ added: number }>(response)),
  updateLesson: (id: number, patch: { status?: string; rule?: string; trigger?: string; promote?: boolean }) => post(`/api/aidev/lessons/${id}`, patch, 'PATCH').then((response) => readJson<{ lesson: Record<string, unknown>; promoted: string | null }>(response)),
  pushKey: () => authenticatedFetch('/api/aidev/push/key').then((response) => readJson<{ publicKey: string }>(response)),
  pushSubscribe: (subscription: PushSubscriptionJSON) => post('/api/aidev/push/subscribe', { subscription }).then((response) => readJson<{ ok: boolean }>(response)),
  pushUnsubscribe: (endpoint: string) => post('/api/aidev/push/unsubscribe', { endpoint }).then((response) => readJson<{ removed: number }>(response)),
  pushTest: () => post('/api/aidev/push/test', {}).then((response) => readJson<{ subscriptions: number; delivered: number }>(response)),
  // E-04 knowledge refresh: start (one item or the caller's due items), progress, review proposals
  knowledgeRefresh: (id?: number) => post('/api/aidev/knowledge/refresh', id === undefined ? {} : { id }).then((response) => readJson<{ job: KnowledgeRefreshJob }>(response)),
  knowledgeRefreshStatus: () => authenticatedFetch('/api/aidev/knowledge/refresh').then((response) => readJson<{ job: KnowledgeRefreshJob | null }>(response)),
  knowledgeProposals: () => authenticatedFetch('/api/aidev/knowledge/proposals').then((response) => readJson<{ proposals: KnowledgeProposal[] }>(response)),
  decideKnowledge: (id: number, accept: boolean) => post(`/api/aidev/knowledge/${id}/decide`, { accept }).then((response) => readJson<{ accepted: number | null; superseded: number | null }>(response)),
  // E-05 learned tier policy (administrators)
  tierPolicy: () => authenticatedFetch('/api/aidev/tier-policy').then((response) => readJson<TierPolicyView>(response)),
  setTierPolicySettings: (settings: { downgrade: boolean }) => post('/api/aidev/tier-policy/settings', settings, 'PUT').then((response) => readJson<{ downgrade: boolean }>(response)),
  runTierPolicy: () => post('/api/aidev/tier-policy/run', {}).then((response) => readJson<{ cells: number; changes: Array<{ domain: string; depth: number; engine: string; fromModel: string; toModel: string; reason: string }>; weights?: { kinds: number; changes: unknown[] } }>(response)),
  engineWeights: () => authenticatedFetch('/api/aidev/engines/weights').then((response) => readJson<{ rows: EngineWeightRow[]; log: Array<{ id: number; at: number; task_kind: string; engine: string; from_weight: number | null; to_weight: number; reason: string; actor: string }> }>(response)),
  setEngineWeight: (row: { task_kind: string; engine: Engine; weight: number; pinned?: boolean }) => post('/api/aidev/engines/weights', row, 'PUT').then((response) => readJson<{ rows: EngineWeightRow[] }>(response)),
  setTierPolicy: (cell: { domain: string; depth: number; engine: string; level: number | null; pinned?: boolean }) => post('/api/aidev/tier-policy', cell, 'PUT').then((response) => readJson<{ cell: TierPolicyCell }>(response)),
  /** A chat's own effort ceiling (engines it leaves out follow the account default). */
  sessionSettings: (sessionId: string) => authenticatedFetch(`/api/aidev/session-settings/${encodeURIComponent(sessionId)}`).then((response) => readJson<SessionEffortCap>(response)),
  setSessionEffortCap: (sessionId: string, cap: Partial<Record<Engine, string>> | null) => (cap && Object.keys(cap).length
    ? post(`/api/aidev/session-settings/${encodeURIComponent(sessionId)}`, cap, 'PUT')
    : authenticatedFetch(`/api/aidev/session-settings/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })).then((response) => readJson<SessionEffortCap>(response)),
  setEffortCap: (cap: Partial<Record<Engine, string>>) => post('/api/aidev/settings/effort-cap', cap, 'PUT').then((response) => readJson<{ effort_cap: Record<Engine, string> }>(response)),
  routeEval: () => post('/api/aidev/route/eval', {}).then((response) => readJson<Record<string, unknown>>(response)),
};
