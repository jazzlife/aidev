import path from 'node:path';
import fs from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { LOCAL_AGENTS, localAgentCommand, localAgentPrompt, parseLocalAgentOutput, pickLocalAgent, type LocalAgent, type LocalAgentMode } from '@/modules/aidev-tools/local-agent.js';
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

export async function callGateway(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', apiPath: string, body?: unknown, timeoutMs = GATEWAY_TIMEOUT_MS): Promise<GatewayResponse> {
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({})) as GatewayResponse;
  if (!response.ok) {
    throw new Error(data.error || `aidev gateway request failed (${response.status})`);
  }
  return data;
}

export type RemoteExecInput = { target?: string | number; cmd: string; cwd?: string; timeoutSec?: number; waitSec?: number; background?: boolean; env?: Record<string, string>; outputBytes?: number;
  /** text for the command's input (runner ≥ 0.9) */ stdin?: string };
export type RemoteTurn = { runId?: number | null; targetId?: number | null; agent?: string | null };
export type RemoteExecResult = {
  target: string; cmd: string; status: string; message?: string; remoteRunId?: number; running?: boolean; exitCode?: number | null; signal?: string | null;
  durationMs?: number | null; output?: string; approvedBy?: string; risk?: number; reasons?: string[];
};
export type TargetInfo = { id: number; name: string; online: boolean; platform: string | null; policy: string; allowed_roots?: string[];
  capabilities?: { runner?: string; features?: string[]; tools?: Record<string, string> } | null };

/** A target by id or name (case-insensitive); else the routed target; else the only online one. */
export async function resolveTarget(requested: string | number | undefined, routed: number | null): Promise<TargetInfo> {
  const list = ((await callGateway('GET', '/targets')).targets ?? []) as TargetInfo[];
  const names = list.map((t) => `${t.name}${t.online ? '' : ' (offline)'}`).join(', ') || '없음';
  if (requested !== undefined && requested !== null && String(requested).trim()) {
    const key = String(requested).trim().toLowerCase();
    const hit = list.find((t) => String(t.id) === key || t.name.toLowerCase() === key);
    if (!hit) throw new Error(`원격 대상 "${requested}"이(가) 없습니다. 등록된 대상: ${names}`);
    return hit;
  }
  if (routed) {
    const hit = list.find((t) => t.id === routed);
    if (hit) return hit;
  }
  const online = list.filter((t) => t.online);
  if (online.length === 1) return online[0];
  if (!list.length) throw new Error('등록된 원격 대상이 없습니다. 사용자에게 작업대 "원격 대상"에서 PC를 등록하고 aidev-runner를 실행하도록 안내하세요.');
  throw new Error(`대상을 지정하세요(target). 등록된 대상: ${names}`);
}

/** Debug adapters the platform can start on a target (the gateway's debug-hub DEBUG_ADAPTERS). */
export const DEBUG_ADAPTERS = ['js-debug', 'debugpy', 'codelldb', 'gdb', 'lldb-dap', 'netcoredbg', 'delve', 'jvm', 'dart', 'flutter', 'probe-rs', 'mono', 'clrdbg', 'custom'] as const;
export type DebugAdapterName = (typeof DEBUG_ADAPTERS)[number];
export type DebugStartInput = {
  target?: string | number; adapter: DebugAdapterName; request?: 'launch' | 'attach'; program?: string; module?: string; runtimeExecutable?: string; runtimeArgs?: string[];
  args?: string[]; cwd?: string; env?: Record<string, string>; stopOnEntry?: boolean; waitSec?: number;
  breakpoints?: Array<{ file: string; line: number; condition?: string }>;
  pid?: number; address?: string; debugger?: string; mainClass?: string; classPath?: string[]; chip?: string; probe?: string; device?: string;
  command?: string; commandArgs?: string[]; transport?: 'stdio' | 'tcp'; config?: Record<string, unknown>;
  mobile?: 'android' | 'ios-sim'; appId?: string; activity?: string; server?: string[]; arch?: 'x86' | 'x64';
};
type DebugSnapshot = {
  id: string; state: string; error: string | null; exitCode: number | null; program: string | null; cwd: string | null; version: string | null;
  stopped: { reason: string; description: string | null } | null;
  frames: Array<{ id: number; name: string; path: string | null; line: number; internal: boolean }>;
  locals: Array<{ name: string; value: string; type: string | null; ref: number }>; localsScope: string | null;
  breakpoints: Array<{ path: string; line: number; condition: string | null; verified: boolean | null; message: string | null }>;
  output: string;
};
type ConsoleView = { id: string; state: 'running' | 'ended'; exitCode: number | null; atPrompt: boolean; output: string; waited?: string; cmd: string };
const CONSOLE_OUTPUT_MAX = 12_000;
/** A console answer for the agent: the new output (tail-trimmed), whether it waits for input, and what to do next. */
export function consoleSummary(c: ConsoleView) {
  const out = c.output.length > CONSOLE_OUTPUT_MAX ? `…(앞 ${c.output.length - CONSOLE_OUTPUT_MAX}자 생략)\n${c.output.slice(-CONSOLE_OUTPUT_MAX)}` : c.output;
  const hint = c.state === 'ended' ? `콘솔이 끝났습니다 (exit ${c.exitCode ?? '?'}). 다시 보려면 remote_console_start.`
    : c.atPrompt ? '입력 대기(프롬프트): remote_console_send로 다음 명령을 보내세요. 끝나면 remote_console_stop.'
      : c.waited === 'timeout' || c.waited === 'quiet' ? '아직 실행 중이거나 프롬프트를 못 알아봤습니다: remote_console_read로 더 기다리거나, 멈추려면 remote_console_send interrupt=true.'
        : '실행 중: remote_console_read로 출력을 더 보세요.';
  return { session: c.id, state: c.state, exitCode: c.exitCode, waitingForInput: c.atPrompt, output: out, hint };
}

/** A delegated agent run (remote_exec result) → its parsed report and what to do next. */
function agentResult(r: RemoteExecResult, agent?: LocalAgent) {
  const { output, ...rest } = r;
  if (r.status !== 'finished' && r.status !== 'running') return { ...rest, output: output?.slice(-4000) };
  const rep = parseLocalAgentOutput(output ?? '', agent);
  const hint = r.running
    ? `아직 작업 중입니다: remote_agent_result{remoteRunId: ${r.remoteRunId}}로 기다렸다 결과를 받으세요(사용자는 원격 실행 창에서 진행을 봅니다). 멈추려면 remote_stop.`
    : rep.isError || r.exitCode !== 0 ? `로컬 agent가 실패했습니다: error·output을 보고, 로그인·권한 문제면 사용자에게 알리세요.${rep.sessionId ? ` 이어서 시키려면 remote_agent{resume: "${rep.sessionId}"}.` : ''}`
      : `끝났습니다. result를 검토하고(주장만 믿지 말고 필요하면 remote_exec로 재확인), 추가 작업은 remote_agent{resume: "${rep.sessionId ?? ''}", task: …}로 이어서 시키세요.`;
  return {
    ...rest, localAgent: rep.agent, sessionId: rep.sessionId, result: rep.result ? rep.result.slice(-8000) : null, error: rep.error, steps: rep.steps,
    turns: rep.turns, costUsd: rep.costUsd,
    output: rep.result === null && !rep.steps.length ? (output ?? '').slice(-4000) : undefined, hint,
  };
}

/** What an agent needs after each debugger step: where it is, the stack, the variables, the recent output. */
export function debugSummary(s: DebugSnapshot) {
  const frames = s.frames.filter((f) => !f.internal);
  const top = frames[0] ?? s.frames[0];
  const hint = s.state === 'paused'
    ? '멈춤: locals를 보고, remote_debug_eval로 식을 계산하거나 ref로 객체를 펼치고, remote_debug_step(next/stepIn/continue)으로 진행하세요. 끝나면 remote_debug_stop.'
    : s.state === 'running' ? '실행 중(아직 멈추지 않음): remote_debug_step action=pause 또는 중단점을 더 두고 다시 기다리세요.'
      : s.state === 'failed' ? '디버깅을 시작하지 못했습니다: error를 보고 경로(허용 폴더)·어댑터·언어 런타임을 확인하세요.'
        : '프로그램이 끝났습니다(output과 exitCode 확인). 다시 보려면 remote_debug_start.';
  return {
    session: s.id, state: s.state, error: s.error ?? undefined, exitCode: s.exitCode, adapterVersion: s.version,
    pausedAt: s.stopped && top ? { reason: s.stopped.reason, description: s.stopped.description, function: top.name, file: top.path, line: top.line } : undefined,
    stack: s.stopped ? frames.slice(0, 10).map((f) => `${f.name} (${f.path ?? '?'}:${f.line}) #frame ${f.id}`) : undefined,
    locals: s.stopped ? s.locals.slice(0, 40).map((v) => ({ name: v.name, value: v.value, type: v.type ?? undefined, ref: v.ref || undefined })) : undefined,
    breakpoints: s.breakpoints.map((b) => ({ file: b.path, line: b.line, verified: b.verified, message: b.message ?? undefined, condition: b.condition ?? undefined })),
    output: s.output.slice(-3000),
    hint,
  };
}

/** Long-polls the gateway (25 s per request) until the run ends or `waitSec` passes. */
const QUIET_MS = 90_000;
async function waitRemoteRun(remoteRunId: number, waitSec: number, outputBytes = 12_000) {
  const callStart = Date.now();
  const deadline = Date.now() + waitSec * 1000;
  const bytes = Math.min(Math.max(outputBytes, 1000), 60_000);
  for (;;) {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const asked = Math.min(left, 25);
    const t0 = Date.now();
    const r = await callGateway('GET', `/remote-runs/${remoteRunId}/wait?timeout=${asked}&bytes=${bytes}`, undefined, 45_000) as {
      run: { id: number; finished_at: number | null; exit_code: number | null; started_at: number; artifacts: { signal?: string | null; duration_ms?: number } | null; live: { running: boolean; signal: string | null; lastOutputAt?: number | null } | null };
      output: string;
    };
    const running = Boolean(r.run.live?.running) || !r.run.finished_at;
    // silent for a long time: tell the agent instead of waiting out waitSec (it may be waiting for input)
    const quietMs = running ? Date.now() - (r.run.live?.lastOutputAt ?? r.run.started_at) : 0;
    const quiet = running && quietMs > QUIET_MS && Date.now() - callStart > QUIET_MS;
    const done = !running || left <= 0 || Date.now() >= deadline - 250 || quiet;
    if (running && !done && Date.now() - t0 < (asked - 1) * 1000) {
      // the gateway answered early without an end (stream not in memory, e.g. right after a restart): don't spin
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    if (done) {
      return {
        status: running ? 'running' : 'finished',
        remoteRunId,
        running,
        exitCode: running ? null : r.run.exit_code,
        signal: r.run.live?.signal ?? r.run.artifacts?.signal ?? null,
        durationMs: r.run.artifacts?.duration_ms ?? (running ? Date.now() - r.run.started_at : null),
        output: r.output,
        ...(running ? { message: quiet
          ? `${Math.round(quietMs / 1000)}초 동안 출력이 없습니다 — 입력을 기다리거나 멈췄을 수 있습니다. remote_stop{remoteRunId:${remoteRunId}}으로 멈추고 비대화형 옵션(예: --yes, CI=1)으로 다시 실행하거나, 오래 걸리는 작업이면 remote_logs로 계속 확인하세요.`
          : `아직 실행 중입니다. remote_logs{remoteRunId:${remoteRunId}}로 이어서 보거나 remote_stop으로 멈추세요.` } : {}),
      };
    }
  }
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
  /** F-08: the attached phone/TV/emulator on the target the router picked (adb/sdb serial), or null */
  device: { serial: string; tool: 'adb' | 'sdb' } | null;
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
    device: (() => {
      const device = value.device && typeof value.device === 'object' ? value.device as Record<string, unknown> : null;
      const serial = clip(device?.serial, 80);
      return serial && /^[A-Za-z0-9._:-]+$/.test(serial) && (device?.tool === 'adb' || device?.tool === 'sdb') ? { serial, tool: device.tool } : null;
    })(),
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
    parts.push(`## 이전 실행에서 얻은 교훈 (반드시 지킬 것; [시험 적용]은 이번 결과로 검증 중인 규칙)\n${aidev.lessons.map((lesson) => `- ${lesson}`).join('\n')}`);
  }
  if (aidev.knowledgeDigest) {
    parts.push(`## 검증된 최신 지식\n${aidev.knowledgeDigest.trim()}`);
  }
  if (aidev.target) {
    const capabilities = aidev.target.capabilities ? JSON.stringify(aidev.target.capabilities).slice(0, 1500) : 'unknown';
    parts.push(`## 원격 실행 대상\n이 작업의 실행·테스트·디버깅은 사용자의 원격 PC \`${aidev.target.name}\` (${aidev.target.platform ?? 'unknown'}; tags ${aidev.target.tags.join(', ') || 'none'})에서 remote_* 도구로 수행한다.${aidev.scope.remoteAction && aidev.scope.remoteAction !== 'none' ? ` 요청된 원격 작업: ${aidev.scope.remoteAction}.` : ''}${aidev.device ? `\n대상 기기: ${aidev.device.tool} serial \`${aidev.device.serial}\` — 기기 명령은 \`${aidev.device.tool} -s ${aidev.device.serial} …\`로 이 기기를 지정한다(연결된 기기가 여럿).` : ''}\n대상 capabilities: ${capabilities}`);
  }
  parts.push('## 판단 도구\n여러 후보(수정안·파일·접근법·위험도) 중 골라야 하면 추측 대신 `aidev_decide` 도구(kind agent.pick / agent.score / agent.yesno)로 판정한다.');
  parts.push('## 사용자 PC에서 실행\n사용자가 자기 PC·Mac·원격 머신에서 실행·빌드·테스트·확인을 요청하면 이 작업공간의 셸이 아니라 `remote_targets`로 대상을 확인하고 `remote_exec`로 실행한다(허용 폴더 안에서, 결과의 종료 코드·출력을 근거로 판단). 이 작업공간의 프로젝트를 대상에서 돌려야 하면 먼저 `remote_sync`로 복사하고(돌려준 `dest`를 cwd로), 여기서 파일을 고친 뒤에는 다시 `remote_sync` 후 실행한다. 의존성은 복사되지 않으므로 대상에서 설치(npm ci 등)한다. 테스트가 실패하면 원인을 고치고 다시 실행해 통과를 확인한다. 개발 서버처럼 계속 도는 명령은 `background:true` 후 `remote_logs`로 확인하고, 끝나면 `remote_stop`. 웹 앱을 사용자에게 보여줘야 하면 `remote_preview{port}`를 먼저 호출해 `base`를 받고, 개발 서버를 그 base로 실행(Vite: `npm run dev -- --base <base> --port <port>`)한 뒤 `remote_preview`를 다시 호출하면 작업대 미리보기 패널에 열린다(HMR 포함). 돌려준 url을 사용자에게 알려준다. 실행 중 오류·잘못된 값의 원인을 찾을 때는 로그로 추측하기보다 `remote_debug_start`(언어·런타임에 맞는 어댑터: Node js-debug, Python debugpy, C/C++/Rust codelldb·gdb, Apple lldb-dap, .NET netcoredbg·.NET Framework clrdbg, Mono/Unity mono, Go delve, Java/Kotlin jvm, Dart/Flutter, MCU probe-rs·gdb+OpenOCD, attach(pid·주소)로 실행 중인 것·Android JDWP 포함 — 디버그 빌드 먼저)로 의심 줄에 중단점을 두고 멈춘 곳의 locals·`remote_debug_eval`로 값을 확인하며 `remote_debug_step`으로 진행하고, 끝나면 `remote_debug_stop`(사용자도 같은 세션을 디버그 창에서 본다). 맞는 어댑터가 없거나 디버거 고유 명령이 필요하면 `remote_console_start`로 그 PC의 CLI 디버거(gdb·lldb·cdb+SOS·jdb·pdb·dlv·adb shell·openocd 등)를 열어 `remote_console_send`로 한 줄씩 조작하고 `remote_console_stop`으로 끝낸다. 그 PC의 IDE·SDK·시뮬레이터/기기·GUI 디버거가 꼭 필요하거나 그 PC에서 긴 조사(빌드→실행→디버그→수정→재실행)가 필요하면 `remote_agent`로 그 PC에 설치된 agent CLI(Claude Code·Codex·Gemini)에 작업을 맡기고, 돌려준 보고는 직접 재확인한다(`resume`으로 이어서 지시). 데스크탑 앱·에뮬레이터 창처럼 화면을 직접 봐야 확인할 수 있는 것은 `remote_windows`로 창을 찾고 `remote_screenshot{window|query}`로 그 창을 보고 판단한다(그 PC에서 화면 캡처를 허용한 경우만, 보기 전용). 그 PC에 연결된 휴대폰·TV·시뮬레이터(adb·sdb·iOS 시뮬레이터)의 화면은 `remote_devices`로 기기를 확인하고 `remote_device_shot{serial}`로 본다. 파일 삭제·sudo·설치·강제 push 같은 명령은 사용자 승인이 필요하므로 꼭 필요할 때만 쓰고, 거부되면 같은 명령을 반복하지 않는다.');
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
  getMcpServerConfig(turn?: { runId?: number | null; targetId?: number | null; agent?: string | null }): { command: string; args: string[]; env: Record<string, string> } | null {
    if (!runtimeName) {
      return null;
    }
    const { command, args } = getMcpCommand();
    const env: Record<string, string> = {
      CLOUDCLI_AIDEV_TOOLS_API_URL: getMcpApiUrl(),
      CLOUDCLI_AIDEV_TOOLS_MCP_TOKEN: getMcpToken(),
    };
    // per-turn context: remote runs are tied to the chat run (outcome) and default to the routed target
    if (turn?.runId) env.AIDEV_RUN_ID = String(turn.runId);
    if (turn?.targetId) env.AIDEV_TARGET_ID = String(turn.targetId);
    if (turn?.agent) env.AIDEV_AGENT = turn.agent;
    return { command, args, env };
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
    const data = await callGateway('GET', '/targets');
    const targets = (data.targets ?? []) as Array<Record<string, unknown> & { capabilities?: Record<string, unknown> | null }>;
    // what an agent needs to pick a machine and a folder — not pairing state or raw capability dumps
    return {
      targets: targets.map((t) => ({
        id: t.id, name: t.name, description: t.description, online: t.online, platform: t.platform, arch: t.arch, policy: t.policy,
        allowed_roots: t.allowed_roots, shell: t.capabilities?.shell ?? null, hostname: t.capabilities?.hostname ?? null,
        tools: t.capabilities?.tools ?? {}, devices: t.capabilities?.devices ?? null, runner: t.capabilities?.runner ?? null,
      })),
      policy_meaning: { ask: 'read/build/test commands run; anything else waits for the user', auto: 'runs unless risky; destructive commands still ask', deny: 'no remote execution' },
    };
  },

  /**
   * remote_exec (F-05): run a shell command on one of the user's machines through the gateway gate.
   * Safe commands start at once; risky ones wait for the user's approval (≤10 min, long-polled);
   * then the call waits for the result up to `waitSec` (default 300 s). `background` returns after
   * a few seconds with the first output — for dev servers and watchers (read on with remote_logs).
   */
  async remoteExec(input: RemoteExecInput, turn: RemoteTurn = {}): Promise<RemoteExecResult> {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const started = await callGateway('POST', `/targets/${target.id}/exec`, {
      cmd: input.cmd, cwd: input.cwd, timeoutSec: input.timeoutSec, env: input.env, stdin: input.stdin, runId: turn.runId ?? undefined, agent: turn.agent ?? undefined,
    }) as GatewayResponse & { status?: string; stream?: { remoteRunId: number }; approval?: { id: string; risk: number; reasons: string[] }; reason?: string; error?: string };
    const base = { target: target.name, cmd: input.cmd };
    if (started.status === 'offline') return { ...base, status: 'offline', message: String(started.error ?? 'target offline') };
    if (started.status === 'error') {
      const roots = Array.isArray((started as { allowed_roots?: unknown }).allowed_roots) ? ((started as { allowed_roots: string[] }).allowed_roots).join(', ') : '';
      return { ...base, status: 'error', message: `${String(started.error ?? 'could not start')}${roots && !String(started.error ?? '').includes('허용 폴더') ? ` — 허용 폴더: ${roots}` : ''}. cwd는 허용 폴더 안의 절대 경로로 지정하세요(없는 폴더는 먼저 만들어야 합니다).` };
    }
    if (started.status === 'denied') return { ...base, status: 'denied', message: String(started.reason ?? 'denied by policy') };
    let remoteRunId = started.stream?.remoteRunId ?? null;
    let approvedBy: string = 'auto';
    if (started.status === 'pending' && started.approval) {
      const approvalId = started.approval.id;
      const deadline = Date.now() + 11 * 60_000;
      let decision: { status: string; remoteRunId: number | null; error: string | null } | null = null;
      while (Date.now() < deadline) {
        const r = await callGateway('GET', `/approvals/${approvalId}/wait?timeout=25`, undefined, 40_000) as { approval?: { status: string; remoteRunId: number | null; error: string | null } };
        if (r.approval && r.approval.status !== 'pending') { decision = r.approval; break; }
      }
      if (!decision || decision.status === 'expired') return { ...base, status: 'expired', message: '사용자가 10분 안에 승인하지 않았습니다. 명령을 실행하지 않았습니다.', risk: started.approval.risk, reasons: started.approval.reasons };
      if (decision.status === 'denied') return { ...base, status: 'denied', message: '사용자가 이 명령을 거부했습니다. 같은 명령을 다시 시도하지 말고, 필요하면 이유를 설명하고 다른 방법을 제안하세요.', risk: started.approval.risk, reasons: started.approval.reasons };
      if (decision.error || !decision.remoteRunId) return { ...base, status: 'error', message: decision.error ?? 'approved but could not start' };
      remoteRunId = decision.remoteRunId; approvedBy = 'user';
    }
    if (!remoteRunId) return { ...base, status: 'error', message: String(started.error ?? 'could not start') };
    const waitSec = input.background ? 5 : Math.min(Math.max(input.waitSec ?? 300, 1), 1800);
    const result = await waitRemoteRun(remoteRunId, waitSec, input.outputBytes);
    return { ...base, ...result, approvedBy };
  },

  /** remote_logs: current state and the last output of a remote run (optionally waiting for it to end). */
  async remoteLogs(remoteRunId: number, waitSec = 0, outputBytes?: number) {
    return waitRemoteRun(remoteRunId, Math.min(Math.max(waitSec, 0), 1800), outputBytes);
  },

  /**
   * remote_preview (F-06): show a dev server running on the target in the user's workbench. Returns the
   * preview URL and `base` (the path prefix the server should be started with so module/HMR paths work).
   */
  async remotePreview(input: { target?: string | number; port: number; label?: string }, turn: { targetId?: number | null } = {}) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const r = await callGateway('POST', `/targets/${target.id}/preview`, { port: input.port, label: input.label }) as { preview: Record<string, unknown>; hint: string };
    return { target: target.name, ...r.preview, hint: r.hint };
  },

  /** remote_windows (F-07c): the program windows on a target (runner ≥ 0.7; older runners list displays). */
  async remoteWindows(input: { target?: string | number }, turn: { targetId?: number | null } = {}) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const r = await callGateway('GET', `/targets/${target.id}/windows`) as { windows?: Array<Record<string, unknown>> | null; displays?: unknown };
    const windows = (r.windows ?? []).map((w) => ({ id: w.id, app: w.app, title: w.title, width: w.width, height: w.height, focused: w.focused }));
    return r.windows ? { target: target.name, windows } : { target: target.name, displays: r.displays, hint: '이 러너는 창 단위 캡처를 지원하지 않습니다 (aidev-runner 0.7.0 이상)' };
  },

  /** remote_screenshot (F-07/F-07c): one capture of a program window (id, or first `query` match, else the
   *  focused one), JPEG base64 (`image`) + size + which window. */
  async remoteScreenshot(input: { target?: string | number; window?: number; query?: string; display?: number; maxWidth?: number }, turn: { targetId?: number | null; runId?: number | null } = {}) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const r = await callGateway('POST', `/targets/${target.id}/screenshot`, { window: input.window, query: input.query, display: input.display, maxWidth: input.maxWidth, runId: turn.runId ?? undefined }) as Record<string, unknown>;
    return { target: target.name, ...r };
  },

  /** remote_devices (F-10): phones, TVs and simulators attached to a target (adb / sdb / booted iOS simulators). */
  async remoteDevices(input: { target?: string | number }, turn: { targetId?: number | null } = {}) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const r = await callGateway('GET', `/targets/${target.id}/devices`) as Record<string, unknown>;
    return { target: target.name, ...r };
  },

  /** remote_device_shot (F-10): one screenshot of an attached device (the only usable one without serial). */
  async remoteDeviceShot(input: { target?: string | number; tool?: string; serial?: string; maxWidth?: number }, turn: { targetId?: number | null; runId?: number | null } = {}) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const r = await callGateway('POST', `/targets/${target.id}/devices/shot`, { tool: input.tool, serial: input.serial, maxWidth: input.maxWidth, runId: turn.runId ?? undefined }) as Record<string, unknown>;
    return { target: target.name, ...r };
  },

  /**
   * remote_debug_start (F-09): run a program under a debugger on one of the user's machines (js-debug for
   * Node, debugpy for Python, codelldb for C/C++/Rust/Swift) with breakpoints, and wait until it pauses or
   * ends. Like remote_exec it passes the gateway gate (a program that is not read/build/test waits for the
   * user's approval). Returns the session id and where it stopped: stack, local variables, output.
   */
  async remoteDebugStart(input: DebugStartInput, turn: RemoteTurn = {}) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const waitSec = Math.min(Math.max(input.waitSec ?? 60, 0), 120);
    const body = {
      adapter: input.adapter, request: input.request, program: input.program, module: input.module, runtimeExecutable: input.runtimeExecutable, runtimeArgs: input.runtimeArgs,
      args: input.args, cwd: input.cwd, env: input.env, stopOnEntry: input.stopOnEntry,
      pid: input.pid, address: input.address, debugger: input.debugger, mainClass: input.mainClass, classPath: input.classPath, chip: input.chip, probe: input.probe, device: input.device,
      command: input.command, commandArgs: input.commandArgs, transport: input.transport, config: input.config,
      mobile: input.mobile, appId: input.appId, activity: input.activity, server: input.server, arch: input.arch,
      breakpoints: (input.breakpoints ?? []).map((b) => ({ path: b.file, line: b.line, condition: b.condition })),
      waitSec, runId: turn.runId ?? undefined, agent: turn.agent ?? undefined,
    };
    const started = await callGateway('POST', `/targets/${target.id}/debug`, body, (waitSec + 300) * 1000) as GatewayResponse & { status?: string; debug?: DebugSnapshot; approval?: { id: string; risk: number; reasons: string[] }; reason?: string; error?: string; allowed_roots?: string[] };
    const base = { target: target.name, adapter: input.adapter };
    if (started.status === 'offline') return { ...base, status: 'offline', message: String(started.error ?? 'target offline') };
    if (started.status === 'error') return { ...base, status: 'error', message: `${String(started.error ?? 'could not start')}${started.allowed_roots?.length ? ` — 허용 폴더: ${started.allowed_roots.join(', ')}` : ''}` };
    if (started.status === 'denied') return { ...base, status: 'denied', message: String(started.reason ?? 'denied by policy') };
    let sessionId = started.debug?.id ?? null;
    if (started.status === 'pending' && started.approval) {
      const deadline = Date.now() + 11 * 60_000;
      let decision: { status: string; debugSessionId: string | null; error: string | null } | null = null;
      while (Date.now() < deadline) {
        const r = await callGateway('GET', `/approvals/${started.approval.id}/wait?timeout=25`, undefined, 40_000) as { approval?: { status: string; debugSessionId: string | null; error: string | null } };
        if (r.approval && r.approval.status !== 'pending') { decision = r.approval; break; }
      }
      if (!decision || decision.status === 'expired') return { ...base, status: 'expired', message: '사용자가 10분 안에 승인하지 않았습니다. 디버깅을 시작하지 않았습니다.' };
      if (decision.status === 'denied') return { ...base, status: 'denied', message: '사용자가 이 디버그 실행을 거부했습니다. 같은 요청을 반복하지 마세요.' };
      if (decision.error || !decision.debugSessionId) return { ...base, status: 'error', message: decision.error ?? 'approved but could not start' };
      sessionId = decision.debugSessionId;
      const r = await callGateway('GET', `/debug/${sessionId}?wait=${waitSec}`, undefined, (waitSec + 30) * 1000) as { session: DebugSnapshot };
      return { ...base, ...debugSummary(r.session), approvedBy: 'user' };
    }
    if (!sessionId || !started.debug) return { ...base, status: 'error', message: String(started.error ?? 'could not start') };
    return { ...base, ...debugSummary(started.debug), approvedBy: 'auto' };
  },

  /** remote_debug_step: continue / next / stepIn / stepOut / pause, then wait for the next pause or the end. */
  async remoteDebugStep(session: string, action: string, waitSec = 30) {
    const r = await callGateway('POST', `/debug/${session}/control`, { action, waitSec: Math.min(Math.max(waitSec, 0), 120) }, (Math.min(Math.max(waitSec, 0), 120) + 30) * 1000) as { session: DebugSnapshot };
    return debugSummary(r.session);
  },

  /** remote_debug_eval: an expression in the paused frame (or the top one), or the children of a variable (`ref`). */
  async remoteDebugEval(session: string, input: { expression?: string; ref?: number; frameId?: number }) {
    if (input.ref) {
      const r = await callGateway('GET', `/debug/${session}/variables?ref=${input.ref}`) as { variables: Array<{ name: string; value: string; type: string | null; ref: number }> };
      return { variables: r.variables.slice(0, 80) };
    }
    if (!input.expression) throw new Error('expression or ref is required.');
    return callGateway('POST', `/debug/${session}/evaluate`, { expression: input.expression, frameId: input.frameId });
  },

  /** remote_debug_breakpoints: replaces the breakpoints of one file (empty list clears them). */
  async remoteDebugBreakpoints(session: string, file: string, lines: Array<number | { line: number; condition?: string }>) {
    return callGateway('POST', `/debug/${session}/breakpoints`, { path: file, lines });
  },

  /** remote_debug_stop: ends the program and the debugger. */
  async remoteDebugStop(session: string) {
    const r = await callGateway('DELETE', `/debug/${session}`) as { session: DebugSnapshot };
    return debugSummary(r.session);
  },

  /**
   * remote_console_start (F-09c): a command-line debugger or REPL (gdb, lldb, cdb, jdb, pdb, dlv, adb shell …)
   * in a pty on the target, through the same approval gate as remote_exec. Returns its output up to the first prompt.
   */
  async remoteConsoleStart(input: { target?: string | number; command: string; cwd?: string; env?: Record<string, string>; prompt?: string; waitSec?: number }, turn: RemoteTurn = {}) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const waitSec = Math.min(Math.max(input.waitSec ?? 30, 0), 120);
    const started = await callGateway('POST', `/targets/${target.id}/console`, {
      cmd: input.command, cwd: input.cwd, env: input.env, prompt: input.prompt, waitSec, runId: turn.runId ?? undefined, agent: turn.agent ?? undefined,
    }, (waitSec + 60) * 1000) as GatewayResponse & { status?: string; console?: ConsoleView; approval?: { id: string }; reason?: string; error?: string; allowed_roots?: string[] };
    const base = { target: target.name, command: input.command };
    if (started.status === 'offline') return { ...base, status: 'offline', message: String(started.error ?? 'target offline') };
    if (started.status === 'error') return { ...base, status: 'error', message: `${String(started.error ?? 'could not start')}${started.allowed_roots?.length ? ` — 허용 폴더: ${started.allowed_roots.join(', ')}` : ''}` };
    if (started.status === 'denied') return { ...base, status: 'denied', message: String(started.reason ?? 'denied by policy') };
    if (started.status === 'pending' && started.approval) {
      const deadline = Date.now() + 11 * 60_000;
      let decision: { status: string; debugSessionId: string | null; error: string | null } | null = null;
      while (Date.now() < deadline) {
        const r = await callGateway('GET', `/approvals/${started.approval.id}/wait?timeout=25`, undefined, 40_000) as { approval?: { status: string; debugSessionId: string | null; error: string | null } };
        if (r.approval && r.approval.status !== 'pending') { decision = r.approval; break; }
      }
      if (!decision || decision.status === 'expired') return { ...base, status: 'expired', message: '사용자가 10분 안에 승인하지 않았습니다. 콘솔을 시작하지 않았습니다.' };
      if (decision.status === 'denied') return { ...base, status: 'denied', message: '사용자가 이 콘솔 실행을 거부했습니다. 같은 요청을 반복하지 마세요.' };
      if (decision.error || !decision.debugSessionId) return { ...base, status: 'error', message: decision.error ?? 'approved but could not start' };
      const r = await callGateway('GET', `/console/${decision.debugSessionId}/transcript`) as { console: ConsoleView };
      return { ...base, ...consoleSummary(r.console), approvedBy: 'user' };
    }
    if (!started.console) return { ...base, status: 'error', message: String(started.error ?? 'could not start') };
    return { ...base, ...consoleSummary(started.console), approvedBy: 'auto' };
  },

  /** remote_console_send: one line (or several) to the console, or Ctrl-C; returns its answer. */
  async remoteConsoleSend(session: string, input: { input?: string; interrupt?: boolean; waitSec?: number; quietMs?: number }) {
    const waitSec = Math.min(Math.max(input.waitSec ?? 30, 0), 120);
    if (input.interrupt) return consoleSummary((await callGateway('POST', `/console/${session}/interrupt`, {}) as { console: ConsoleView }).console);
    if (typeof input.input !== 'string') throw new Error('input (or interrupt: true) is required.');
    const r = await callGateway('POST', `/console/${session}/send`, { input: input.input, waitSec, quietMs: input.quietMs }, (waitSec + 30) * 1000) as { console: ConsoleView };
    return consoleSummary(r.console);
  },

  /** remote_console_read: output that arrived since the last call (a program running inside the debugger). */
  async remoteConsoleRead(session: string, waitSec = 10) {
    const w = Math.min(Math.max(waitSec, 0), 120);
    const r = await callGateway('GET', `/console/${session}/read?wait=${w}`, undefined, (w + 30) * 1000) as { console: ConsoleView };
    return consoleSummary(r.console);
  },

  /** remote_console_stop: ends the debugger/REPL (and what runs under it). */
  async remoteConsoleStop(session: string) {
    const r = await callGateway('DELETE', `/console/${session}`) as { console: ConsoleView };
    return consoleSummary(r.console);
  },

  /**
   * remote_agent (F-09d): the task goes to an agent CLI on the target (Claude Code / Codex / Gemini CLI) —
   * for work that needs that PC's own IDE, SDKs, debuggers, simulators or attached devices.
   */
  async remoteAgent(input: { target?: string | number; task: string; agent?: string; mode?: LocalAgentMode; cwd?: string; resume?: string; model?: string; waitSec?: number; background?: boolean }, turn: RemoteTurn = {}) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    const tools = target.capabilities?.tools ?? null;
    const agent = pickLocalAgent(input.agent, tools);
    const installed = LOCAL_AGENTS.filter((a) => tools?.[a]);
    if (!agent) {
      return { target: target.name, status: 'unavailable', message: `${target.name}에 agent CLI가 없습니다${input.agent && input.agent !== 'auto' ? ` (${input.agent})` : ''}. 설치된 것: ${installed.join(', ') || '없음'}. 사용자에게 그 PC에서 Claude Code(npm i -g @anthropic-ai/claude-code 후 claude 로그인) 또는 Codex CLI(npm i -g @openai/codex 후 codex login)를 설치·로그인하도록 안내하거나, remote_exec/remote_debug_start/remote_console_start로 직접 진행하세요.` };
    }
    if (tools && !tools[agent]) return { target: target.name, status: 'unavailable', message: `${target.name}에 ${agent} CLI가 없습니다. 설치된 것: ${installed.join(', ') || '없음'}` };
    if (!target.capabilities?.features?.includes('stdin')) return { target: target.name, status: 'unavailable', message: `${target.name}의 러너(${target.capabilities?.runner ?? '?'})가 오래됐습니다 — aidev-runner 0.9.0 이상이 필요합니다(사용자에게 러너 업데이트 안내).` };
    const mode: LocalAgentMode = input.mode === 'readonly' ? 'readonly' : 'full';
    const cmd = localAgentCommand(agent, mode, { resume: input.resume, model: input.model });
    const stdin = localAgentPrompt(input.task, { machine: target.name, platform: target.platform, cwd: input.cwd ?? null, mode, resume: Boolean(input.resume) });
    const waitSec = Math.min(Math.max(input.waitSec ?? 900, 5), 1800);
    const r = await aidevToolsService.remoteExec({ target: target.id, cmd, cwd: input.cwd, stdin, timeoutSec: 4 * 3600, waitSec, background: input.background, outputBytes: 60_000 }, turn);
    return { agent, mode, ...agentResult(r, agent) };
  },

  /** remote_agent_result: waits for (or re-reads) a delegated agent run and parses its report. */
  async remoteAgentResult(remoteRunId: number, waitSec = 600, agent?: LocalAgent) {
    const r = await waitRemoteRun(remoteRunId, Math.min(Math.max(waitSec, 0), 1800), 60_000);
    return agentResult({ target: '', cmd: '', ...r }, agent);
  },

  /** remote_stop: interrupt (INT) or kill a running remote command. */
  async remoteStop(remoteRunId: number, signal: 'INT' | 'TERM' | 'KILL' = 'INT') {
    await callGateway('POST', `/remote-runs/${remoteRunId}/signal`, { signal });
    return waitRemoteRun(remoteRunId, 5);
  },

  /** Remote-target RPC (stage F: exec, sync, preview, screenshot, debug). */
  async targetRpc(targetId: number, method: string, params: Record<string, unknown>) {
    return callGateway('POST', `/targets/${targetId}/rpc`, { method, params });
  },

  /** Records an outcome signal for a run (used by the run watcher and tests). */
  /**
   * Tells the gateway about the Claude subscription login (expiry after an in-app login, or a turn
   * refused for authentication) so it can push reminders without waking this runtime. Best effort:
   * no-op outside the platform, errors are logged only.
   */
  async reportClaudeAuth(report: { expires_at?: number | null; failure_at?: number | null }) {
    if (!runtimeName) return;
    try {
      await callGateway('POST', '/claude-auth', report);
    } catch (error) {
      console.warn('[aidev-tools] claude auth report failed:', error instanceof Error ? error.message : error);
    }
  },

  async runOutcome(runId: number, outcome: Record<string, unknown>) {
    return callGateway('PATCH', `/runs/${runId}/outcome`, outcome);
  },
};
