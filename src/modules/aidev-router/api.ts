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

export type RouteResult = {
  decision_id: number;
  decision: 'use' | 'generalist' | 'create' | 'create_background';
  fallback: boolean;
  laya_error: string | null;
  scope: RouteScope;
  agent: { id: number; name: string; version: number; domain: string; description: string; probability: number; confidence: number; definition: AgentDefinition };
  alternatives: Array<{ name: string; probability: number; description: string }>;
  needs_new: number;
  plan: { engine: Engine | null; engine_locked: boolean; model: string | null; effort: string | null; target: RouteTarget; reason: string[] };
  engines: Record<Engine, { allowed: boolean; authenticated: boolean; error?: string | null; score: number | null; notes: string[] }>;
  lessons: Array<{ id: number; trigger: string; rule: string }>;
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
  weights: Record<string, Record<Engine, number>>;
};

export type CatalogAgent = {
  id: number;
  name: string;
  domain: string;
  description: string;
  prompt: string;
  tools: string[] | null;
  model: string | null;
  maxTurns: number | null;
  skills: string[] | null;
  mcpServers: Record<string, unknown> | null;
  ownerId: number | null;
  source: string;
  active: boolean;
  uses: number;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type RouteRequest = {
  text: string;
  sessionId?: string | null;
  sessionEngine?: Engine | null;
  preferEngine?: Engine | null;
  targetId?: number | null;
  projectHint?: string | null;
  recentFiles?: string[] | null;
  model?: string | null;
  effort?: string | null;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || `aidev request failed (${response.status})`);
  }
  return data;
}

const post = (url: string, body: unknown, method = 'POST') => authenticatedFetch(url, { method, body: JSON.stringify(body) });

/** Used by the aidev-router hooks, the workbench router bar and the mobile router chip. */
export const aidevApi = {
  route: (input: RouteRequest) => post('/api/aidev/route', input).then((response) => readJson<RouteResult>(response)),
  decide: (kind: string, state: Record<string, unknown>, options?: Record<string, string>) =>
    post(`/api/aidev/decide/${encodeURIComponent(kind)}`, { state, options }).then((response) => readJson<DecideResult>(response)),
  overrideDecision: (id: number, patch: { final_agent?: string; final_engine?: Engine; final_model?: string; final_target?: string; final_answer?: unknown }) =>
    post(`/api/aidev/decisions/${id}`, patch, 'PATCH').then((response) => readJson<{ ok: boolean }>(response)),
  engines: () => authenticatedFetch('/api/aidev/engines').then((response) => readJson<EnginesResult>(response)),
  agents: () => authenticatedFetch('/api/aidev/agents').then((response) => readJson<{ agents: CatalogAgent[] }>(response)),
  agent: (id: number) => authenticatedFetch(`/api/aidev/agents/${id}`).then((response) => readJson<Record<string, unknown>>(response)),
  createAgent: (input: Record<string, unknown>) => post('/api/aidev/agents', input).then((response) => readJson<{ agent: CatalogAgent }>(response)),
  updateAgent: (id: number, input: Record<string, unknown>) => post(`/api/aidev/agents/${id}`, input, 'PUT').then((response) => readJson<{ agent: CatalogAgent; version: number }>(response)),
  createRun: (input: Record<string, unknown>) => post('/api/aidev/runs', input).then((response) => readJson<{ run_id: number }>(response)),
  runOutcome: (runId: number, outcome: Record<string, unknown>) => post(`/api/aidev/runs/${runId}/outcome`, outcome, 'PATCH').then((response) => readJson<{ run: Record<string, unknown> }>(response)),
  targets: () => authenticatedFetch('/api/aidev/targets').then((response) => readJson<{ targets: Array<Record<string, unknown>> }>(response)),
};
