import path from 'node:path';
import fs from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { appConfigDb } from '@/modules/database/index.js';

/**
 * aidev-tools: the runtime side of the Nado AI Dev platform integration.
 *
 * - Talks to the aidev gateway's internal API on behalf of this runtime's user
 *   (decisions via Laya, runs, remote targets). The runtime authenticates with a
 *   short-lived JWT signed by its own runtime key; the gateway verifies it through
 *   the runtime-manager.
 * - Provides the MCP server definition that the Claude/Codex providers inject so the
 *   AI agent can call `aidev_decide` and the `remote_*` tools.
 *
 * Outside the platform (no AIDEV_RUNTIME) every call reports "not available"
 * instead of failing the chat turn.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_TOKEN_KEY = 'aidev_tools_mcp_token';
const runtimeName = process.env.AIDEV_RUNTIME || '';
const gatewayUrl = (process.env.AIDEV_GATEWAY_URL || 'http://aidev-auth-gateway:8080').replace(/\/$/, '');
const GATEWAY_TIMEOUT_MS = Number.parseInt(process.env.AIDEV_GATEWAY_TIMEOUT_MS || '30000', 10);

type GatewayResponse = Record<string, unknown> & { error?: string };

function gatewayToken(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Runtime key is not configured (JWT_SECRET).');
  }
  // HS256 JWT signed by hand (no typed jsonwebtoken dependency in the runtime build).
  const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ userId: 1, username: runtimeName, aud: 'aidev-gateway', iat: now, exp: now + 300 }));
  const signature = createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url');
  return `${head}.${payload}.${signature}`;
}

function getMcpToken(): string {
  const existing = appConfigDb.get(MCP_TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(MCP_TOKEN_KEY, token);
  return token;
}

function getMcpCommand(): { command: string; args: string[] } {
  const script = path.join(__dirname, 'aidev-tools-mcp.js');
  if (fs.existsSync(script)) {
    return { command: process.execPath, args: [script] };
  }
  return { command: 'cloudcli', args: ['aidev-tools-mcp'] };
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/aidev-tools-mcp`;
}

async function callGateway(method: 'GET' | 'POST' | 'PATCH', apiPath: string, body?: unknown): Promise<GatewayResponse> {
  if (!runtimeName) {
    throw new Error('aidev platform is not available in this runtime (AIDEV_RUNTIME unset).');
  }
  const response = await fetch(`${gatewayUrl}/internal/aidev${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${gatewayToken()}`,
      'x-aidev-runtime': runtimeName,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({})) as GatewayResponse;
  if (!response.ok) {
    throw new Error(data.error || `aidev gateway request failed (${response.status})`);
  }
  return data;
}

/** Input accepted by the `aidev_decide` MCP tool (kind + Laya state, optional options). */
export type DecideToolInput = {
  kind: string;
  question?: string;
  state?: Record<string, unknown>;
  options?: Record<string, string>;
  levels?: string[];
};

/**
 * Per-turn routing payload sent by the frontend as `chat.send options.aidev`
 * (IMPLEMENTATION-PLAN §3.5). Only whitelisted, size-bounded fields survive
 * `sanitizeAidevOptions`; anything else from the client is dropped.
 */
export type AidevTurnOptions = {
  runId: number | null;
  agent: {
    name: string;
    version: number | null;
    description: string;
    prompt: string;
    tools: string[] | null;
    model: string | null;
    maxTurns: number | null;
    skills: string[] | null;
    mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> } | { url: string }> | null;
  };
  lessons: string[];
  knowledgeDigest: string | null;
  engine: 'claude' | 'codex' | null;
  model: string | null;
  effort: string | null;
  target: { id: number; name: string; platform: string | null; tags: string[]; capabilities: unknown } | null;
  scope: { depth: number | null; taskKind: string | null; risk: number | null; remoteAction: string | null };
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_:*.-]{0,80}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9._\[\]-]{0,80}$/i;
const clip = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.slice(0, max) : null);
const strings = (value: unknown, max: number, re?: RegExp): string[] | null => (Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === 'string' && (!re || re.test(entry))).slice(0, max)
  : null);

/**
 * Validates the raw `options.aidev` object from the chat client. Returns null when the
 * payload is absent or unusable so providers simply run without routing context.
 */
export function sanitizeAidevOptions(raw: unknown): AidevTurnOptions | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const agent = value.agent && typeof value.agent === 'object' ? value.agent as Record<string, unknown> : null;
  const name = clip(agent?.name, 41);
  const prompt = clip(agent?.prompt, 32000);
  if (!agent || !name || !NAME_RE.test(name) || !prompt) {
    return null;
  }
  const mcpServersRaw = agent.mcpServers && typeof agent.mcpServers === 'object' ? agent.mcpServers as Record<string, unknown> : null;
  const mcpServers: AidevTurnOptions['agent']['mcpServers'] = {};
  for (const [serverName, spec] of Object.entries(mcpServersRaw ?? {}).slice(0, 5)) {
    if (!NAME_RE.test(serverName) || !spec || typeof spec !== 'object') {
      continue;
    }
    const entry = spec as Record<string, unknown>;
    if (typeof entry.url === 'string' && /^https?:\/\//.test(entry.url)) {
      mcpServers[serverName] = { url: entry.url.slice(0, 500) };
    } else if (typeof entry.command === 'string' && entry.command.trim()) {
      const env = entry.env && typeof entry.env === 'object'
        ? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).filter(([key, entryValue]) => /^[A-Z_][A-Z0-9_]{0,60}$/.test(key) && typeof entryValue === 'string').slice(0, 20)) as Record<string, string>
        : undefined;
      mcpServers[serverName] = { command: entry.command.slice(0, 300), args: strings(entry.args, 30) ?? undefined, env };
    }
  }
  const target = value.target && typeof value.target === 'object' ? value.target as Record<string, unknown> : null;
  const scope = value.scope && typeof value.scope === 'object' ? value.scope as Record<string, unknown> : {};
  const numberOrNull = (entry: unknown) => (typeof entry === 'number' && Number.isFinite(entry) ? entry : null);
  return {
    runId: numberOrNull(value.runId),
    agent: {
      name,
      version: numberOrNull(agent.version),
      description: clip(agent.description, 600) ?? '',
      prompt,
      tools: strings(agent.tools, 40, TOOL_RE),
      model: clip(agent.model, 80) && MODEL_RE.test(String(agent.model)) ? String(agent.model) : null,
      maxTurns: numberOrNull(agent.maxTurns),
      skills: strings(agent.skills, 20, NAME_RE),
      mcpServers: Object.keys(mcpServers).length ? mcpServers : null,
    },
    lessons: (strings(value.lessons, 20) ?? []).map((lesson) => lesson.slice(0, 2000)),
    knowledgeDigest: clip(value.knowledgeDigest, 32000),
    engine: value.engine === 'claude' || value.engine === 'codex' ? value.engine : null,
    model: clip(value.model, 80) && MODEL_RE.test(String(value.model)) ? String(value.model) : null,
    effort: clip(value.effort, 20),
    target: target && typeof target.id === 'number' && typeof target.name === 'string'
      ? { id: target.id, name: target.name.slice(0, 41), platform: clip(target.platform, 20), tags: strings(target.tags, 20) ?? [], capabilities: target.capabilities ?? null }
      : null,
    scope: { depth: numberOrNull(scope.depth), taskKind: clip(scope.taskKind, 40), risk: numberOrNull(scope.risk), remoteAction: clip(scope.remoteAction, 20) },
  };
}

/**
 * Builds the engine-neutral specialist instructions appended to the engine's own system
 * prompt (Claude: preset append; Codex: developer_instructions). Same text for both engines
 * so lessons/knowledge behave identically.
 */
export function composeAgentInstructions(aidev: AidevTurnOptions): string {
  const parts: string[] = [];
  parts.push(`# 전문 agent: ${aidev.agent.name}${aidev.agent.version ? ` (v${aidev.agent.version})` : ''}`);
  parts.push(aidev.agent.prompt.trim());
  if (aidev.lessons.length) {
    parts.push(`## 이전 실행에서 검증된 교훈 (반드시 지킬 것)\n${aidev.lessons.map((lesson) => `- ${lesson}`).join('\n')}`);
  }
  if (aidev.knowledgeDigest) {
    parts.push(`## 검증된 최신 지식\n${aidev.knowledgeDigest.trim()}`);
  }
  if (aidev.target) {
    const capabilities = aidev.target.capabilities ? JSON.stringify(aidev.target.capabilities).slice(0, 1500) : 'unknown';
    parts.push(`## 원격 실행 대상\n이 작업의 실행·테스트·디버깅은 사용자의 원격 PC \`${aidev.target.name}\` (${aidev.target.platform ?? 'unknown'}; tags ${aidev.target.tags.join(', ') || 'none'})에서 remote_* 도구로 수행한다.${aidev.scope.remoteAction && aidev.scope.remoteAction !== 'none' ? ` 요청된 원격 작업: ${aidev.scope.remoteAction}.` : ''}\n대상 capabilities: ${capabilities}`);
  }
  parts.push('## 판단 도구\n여러 후보(수정안·파일·접근법·위험도) 중 골라야 하면 추측 대신 `aidev_decide` 도구(kind agent.pick / agent.score / agent.yesno)로 판정한다.');
  return parts.join('\n\n');
}

export const aidevToolsService = {
  /** Whether this runtime runs inside the aidev platform (gateway reachable in principle). */
  isPlatformRuntime(): boolean {
    return Boolean(runtimeName);
  },

  // getMcpToken: used by aidev-tools-mcp.routes.ts to authenticate the stdio MCP process.
  getMcpToken,

  /**
   * MCP server definition injected by the providers (`sdkOptions.mcpServers['aidev-tools']`
   * for Claude, `mcp_servers.aidev-tools` config for Codex). Null outside the platform.
   */
  getMcpServerConfig(): { command: string; args: string[]; env: Record<string, string> } | null {
    if (!runtimeName) {
      return null;
    }
    const { command, args } = getMcpCommand();
    return {
      command,
      args,
      env: {
        CLOUDCLI_AIDEV_TOOLS_API_URL: getMcpApiUrl(),
        CLOUDCLI_AIDEV_TOOLS_MCP_TOKEN: getMcpToken(),
      },
    };
  },

  /** Laya decision through the gateway registry (`/api/aidev/decide/:kind`). */
  async decide(input: DecideToolInput) {
    const kind = input.kind.trim();
    const state: Record<string, unknown> = { ...(input.state ?? {}) };
    if (input.question) {
      state.question = input.question;
    }
    if (input.levels) {
      state.levels = input.levels;
    }
    return callGateway('POST', `/decide/${encodeURIComponent(kind)}`, { state, options: input.options });
  },

  /** Registered remote targets of this runtime's user. */
  async listTargets() {
    return callGateway('GET', '/targets');
  },

  /** Remote-target RPC (stage F: exec, sync, preview, screenshot, debug). */
  async targetRpc(targetId: number, method: string, params: Record<string, unknown>) {
    return callGateway('POST', `/targets/${targetId}/rpc`, { method, params });
  },

  /** Records an outcome signal for a run (used by the run watcher and tests). */
  async runOutcome(runId: number, outcome: Record<string, unknown>) {
    return callGateway('PATCH', `/runs/${runId}/outcome`, outcome);
  },
};
