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
  agentExamples: (id: number) => authenticatedFetch(`/api/aidev/agents/${id}/examples`).then((response) => readJson<{ examples: Array<{ id: number; text: string; source: string }> }>(response)),
  addAgentExamples: (id: number, examples: string[]) => post(`/api/aidev/agents/${id}/examples`, { examples }).then((response) => readJson<{ added: number }>(response)),
  updateLesson: (id: number, patch: { status?: string; rule?: string; trigger?: string }) => post(`/api/aidev/lessons/${id}`, patch, 'PATCH').then((response) => readJson<{ lesson: Record<string, unknown> }>(response)),
  routeEval: () => post('/api/aidev/route/eval', {}).then((response) => readJson<Record<string, unknown>>(response)),
};
