import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';

import { askOpenCodeSideTurn } from '@/modules/aidev-tools/opencode-side-turn.client.js';
import { sessionsDb } from '@/modules/database/index.js';
import { claudeCliModel, codexCheckSandboxMode, codexSandboxConfig, currentCodexAuthFailure, noteCodexTurnError } from '@/shared/index.js';
import type { AidevSideEngine } from '@/shared/index.js';

/**
 * Independent verification of a finished run (2026-10-07, worker ≠ verifier). The worker agent's final
 * report is a set of claims — files changed, features added, checks passed. A separate headless turn,
 * on a model at least as strong as the worker's (and never below opus / sol or the user's model floor),
 * reads the repository and re-runs the checks before the run may count as a success. It never edits
 * files and never writes into the conversation; the gateway stores the verdict on the run, fails the
 * run when the report was wrong, and the apps show the card.
 *
 * Cross-engine (2026-10-09): the verifier runs on the other engine when the account has both (a Claude
 * worker is checked by Codex and the other way round), which also keeps the usage from piling up on one
 * engine. With a single engine it is a fresh thread on that engine acting as a different agent than the
 * worker — the gateway picks that agent and sends its prompt as the verifier's background.
 *
 * OpenCode (2026-10-13): a third engine for the check. Its models are the account's own, so without the gateway's
 * candidates it runs on the model OpenCode starts on, after Claude and Codex.
 */
export type VerifyInput = {
  sessionId: string;
  runId: number | null;
  /** when the gateway opened the run (ms): pins the check to the run's own turn, the chat may have gone on since */
  startedAt: number | null;
  agent: string | null;
  /** the worker's engine and model */
  engine: AidevSideEngine | null;
  workerModel: string | null;
  /** the engines this account may use, is signed in to and is not usage-limited on (D-05); the verifier stays inside them */
  engines: AidevSideEngine[];
  /** a different agent than the worker, chosen by the gateway: its prompt is the verifier's domain background */
  verifierAgent: { name: string; prompt: string } | null;
  command: string | null;
  depth: number | null;
  /** the user's model floor per engine (routing MODEL_LADDER names) */
  modelFloor: Partial<Record<'claude' | 'codex', string>>;
  /**
   * The gateway's verifier order once the account set a verification order or a provider policy (PROVIDER-ENGINE-PLAN
   * §2.4): tried in this order; a null model is this runtime's verifierModel (OpenCode: the model it starts on), a null
   * effort the engine's default. null = the runtime's own order (verifierEngineOrder).
   */
  candidates: Array<{ engine: AidevSideEngine; model: string | null; effort: string | null }> | null;
};

export type VerificationCheck = { claim: string; result: 'ok' | 'wrong' | 'unverified'; evidence: string };
export type Verification = { verdict: 'pass' | 'fail' | 'unclear'; summary: string; checked: VerificationCheck[]; issues: string[]; engine: string | null; model: string | null };

const VERIFIER_PROMPT = `당신은 독립 검증자다. 다른 agent(작업자)가 방금 끝낸 작업을 검증한다. 작업자의 보고를 믿지 말고, 저장소의 실제 상태와 직접 실행한 명령의 결과로만 판단한다.
## 절차
1. 작업자의 보고에서 검증 가능한 주장을 뽑는다: 수정·추가했다는 파일, 구현했다는 기능, 통과했다는 빌드·타입체크·린트·테스트.
2. 주장마다 파일을 직접 읽고(Read/Grep/Glob), 보고에 적힌 검사(빌드·타입체크·테스트)는 같은 명령을 직접 실행해 결과를 확인한다. 실행 결과는 종료 코드와 출력으로 판단한다.
3. 사용자의 원래 명령이 요구했는데 작업자가 끝냈다고 보고하고도 실제로는 되지 않은 것을 찾는다. 명령이 검토·분석·질문·계획만 요구했다면("수정하지 말고 검토만") 구현이 없는 것은 빠진 것이 아니다.
## 규칙
- 파일을 수정·생성·삭제하지 않는다. 확인용 명령(읽기, 빌드, 테스트, 린트, git status/diff)만 실행한다.
- 파괴적 명령(삭제, reset, push, 배포, 설치)은 실행하지 않는다.
- 확인하지 못한 주장은 ok가 아니라 unverified로 적는다. 추측으로 ok를 주지 않는다.
- 명령에 첨부된 이미지·파일은 브리프에 적힌 경로를 직접 열어 확인한다. 브리프에 경로가 없는 첨부는 볼 수 없는 것이니, 그것만을 이유로 fail이나 unclear를 주지 않는다.
- "작업자가 쓴 플랫폼 도구와 그 결과"는 플랫폼이 기록한 사실이다(서브에이전트 보고, 원격 PC 실행 결과 등). 다시 실행할 수 없으니 그 결과 자체를 근거로 받아들이고, 작업자의 보고가 그 결과와 맞는지를 확인한다.
- 아래 블록 하나만 출력한다. 블록 밖의 설명은 최소화한다.
<aidev-verify>
{"verdict":"pass"|"fail"|"unclear","summary":"<한두 문장: 보고가 실제와 맞는지>","checked":[{"claim":"<주장>","result":"ok"|"wrong"|"unverified","evidence":"<무엇을 읽거나 실행해 확인했는지, 한 줄>"}],"issues":["<작업자가 틀렸거나 빠뜨린 것, 사용자가 바로 알아야 할 순서로>"]}
</aidev-verify>
verdict 기준: 작업자가 한 일에 대한 주장(수정·구현·검사 통과)이 하나라도 wrong이거나, 작업자가 끝냈다고 한 핵심 요구가 실제로 되지 않았으면 fail. 모든 주장이 ok이면 pass. 핵심 주장을 확인할 수 없으면 unclear.
다음은 fail 사유가 아니다 — 필요하면 issues에만 적는다: 작업자가 하지 못했다거나 사용자 확인을 기다린다고 스스로 밝힌 것, 진단·설명의 표현이나 수치 해석의 차이, 사용자가 요구하지 않은 개선점. fail이면 issues가 그대로 작업자에게 다시 맡겨지므로, 사용자의 명령을 바꾸는 요구를 issues에 넣지 않는다.`;

/** Engine ladders as routing's MODEL_LADDER (weakest first); the verifier never runs below the third rung. */
const LADDER: Record<'claude' | 'codex', string[]> = { claude: ['haiku', 'sonnet', 'opus', 'best'], codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'] };
const VERIFIER_MIN_RUNG = 2;
const CLAUDE_ALIASES: Record<string, string> = { fable: 'best', 'opus[1m]': 'opus', 'sonnet[1m]': 'sonnet' };

/**
 * The verifier's model on `engine`: the strongest of the ladder's third rung (opus / sol), the worker's
 * model when it ran on the same engine, and the user's floor — a weaker checker than the worker would
 * trust what it cannot judge.
 */
export function verifierModel(engine: 'claude' | 'codex', input: { workerEngine: string | null; workerModel: string | null; floor: string | null | undefined }): string {
  const ladder = LADDER[engine];
  const rank = (model: string | null | undefined) => (model ? ladder.indexOf(CLAUDE_ALIASES[model] ?? model) : -1);
  const rung = Math.max(VERIFIER_MIN_RUNG, input.workerEngine === engine ? rank(input.workerModel) : -1, rank(input.floor));
  return ladder[Math.min(rung, ladder.length - 1)];
}

/**
 * Engines to try for the verifier, best first: the worker's other engine, then the worker's own (a different
 * thread / agent there); OpenCode last, since this runtime does not know how strong its model is (an OpenCode worker
 * is checked by Claude, then Codex). Only engines the gateway reported usable are kept, so a limited or signed-out engine
 * never gets the check. This runtime's own knowledge goes on top, since the gateway's view can be a minute old:
 * Codex whose sign-in stopped working (a lapsed subscription) is dropped, and Codex that was at capacity lately goes
 * last instead of first (a model at capacity cost run 274 3.5 min before the next engine started). Used by `verify`
 * and its test.
 */
export function verifierEngineOrder(
  workerEngine: AidevSideEngine | null,
  engines: AidevSideEngine[],
  codex: { signedOut?: boolean; busy?: boolean } = {},
): AidevSideEngine[] {
  const preferred: AidevSideEngine[] = workerEngine === 'claude' ? ['codex', 'claude', 'opencode'] : ['claude', 'codex', 'opencode'];
  const usable = preferred.filter((engine) => engines.includes(engine) && !(engine === 'codex' && codex.signedOut));
  return codex.busy ? [...usable.filter((engine) => engine !== 'codex'), ...usable.filter((engine) => engine === 'codex')] : usable;
}

/**
 * What the verifier tries, in order, with the model and effort of each: the gateway's candidates when it sent them
 * (Codex dropped when its sign-in stopped working, moved last while it is at capacity), else verifierEngineOrder with
 * verifierModel. Used by `verify` and its test.
 */
export function verifierCandidates(input: Pick<VerifyInput, 'candidates' | 'engine' | 'engines' | 'workerModel' | 'modelFloor'>, codex: { signedOut?: boolean; busy?: boolean } = {}): Array<{ engine: AidevSideEngine; model: string | null; effort: string | null }> {
  // OpenCode has no ladder here: without the gateway's model it runs on the one it starts on (null)
  const resolve = (engine: AidevSideEngine, model: string | null, effort: string | null) => ({ engine, model: model ?? (engine === 'opencode' ? null : verifierModel(engine, { workerEngine: input.engine, workerModel: input.workerModel, floor: input.modelFloor[engine] })), effort });
  if (!input.candidates) return verifierEngineOrder(input.engine, input.engines, codex).map((engine) => resolve(engine, null, null));
  const usable = input.candidates.filter((c) => !(c.engine === 'codex' && codex.signedOut)).map((c) => resolve(c.engine, c.model, c.effort));
  return codex.busy ? [...usable.filter((c) => c.engine !== 'codex'), ...usable.filter((c) => c.engine === 'codex')] : usable;
}

/** How long a Codex model at capacity sends the verifier to the other engine first. */
const CODEX_BUSY_MS = 15 * 60_000;
let codexBusyUntil = 0;

/** The verifier's instructions, with the reviewing agent's own prompt as background — the verification rules come first and win. */
function verifierSystemPrompt(agent: VerifyInput['verifierAgent']): string {
  if (!agent) return VERIFIER_PROMPT;
  return `${VERIFIER_PROMPT}\n## 검증자의 전문 분야 배경 ('${agent.name}' agent — 참고용이며 위 절차·규칙이 우선한다)\n${agent.prompt.slice(0, 8000)}`;
}

/** The platform's tools as each engine names them: Claude `mcp__aidev-tools__x`, OpenCode `aidev-tools_x`, Codex `aidev-tools.x`. */
const PLATFORM_TOOL = /^(mcp__aidev-tools__|aidev-tools[._])/;

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'edit', 'write']);
// Claude (Bash), Codex (shell, exec_command, local_shell) and OpenCode (bash; its file tools take `filePath`)
const COMMAND_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell', 'bash']);
/** The agents' own notes (plans, memory, skills): writing one is not work on the project. */
const AGENT_METADATA_PATH = /(^|[\\/])\.(claude|codex)[\\/]/;
/** A command that records work in git: the turn changed the project even when no edit tool shows it. */
const GIT_RECORDING_COMMAND = /\bgit\s+(commit|push|apply|am|merge|cherry-pick)\b/;

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { const parsed = JSON.parse(raw) as unknown; return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
  return {};
}

type HistoryMessage = { kind: string; role?: string; content?: string; text?: string; timestamp?: string; images?: unknown; files?: unknown; toolName?: string; toolInput?: unknown; toolResult?: { isError?: boolean; content?: unknown } | null };

/** A user turn's opening message: typed text, or attachments alone (an image-only turn has no text). */
const isUserTurn = (message: HistoryMessage): boolean => message.kind === 'text' && message.role === 'user'
  && Boolean(message.content || (Array.isArray(message.images) && message.images.length > 0));

/** The run row is written before its command is sent, so the command's message is later; this absorbs clock jitter. */
const TURN_CLOCK_SLACK_MS = 2_000;

/**
 * Pure part (exported for tests): the run's own turn — from the first user message written once the run had started
 * (`startedAt`) to the next user message — and whether the chat already went on past it (a next command, a queued one
 * the server sent). Without `startedAt`, or with no message that recent, the newest user message's turn.
 */
export function verifiedTurn(messages: HistoryMessage[], startedAt: number | null): { turn: HistoryMessage[]; movedOn: boolean } {
  let start = -1;
  if (startedAt !== null) {
    start = messages.findIndex((message) => isUserTurn(message) && Date.parse(message.timestamp ?? '') >= startedAt - TURN_CLOCK_SLACK_MS);
  }
  if (start < 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (isUserTurn(messages[index])) { start = index; break; }
    }
    return { turn: messages.slice(Math.max(start, 0)), movedOn: false };
  }
  const next = messages.findIndex((message, index) => index > start && isUserTurn(message));
  return next < 0 ? { turn: messages.slice(start), movedOn: false } : { turn: messages.slice(start, next), movedOn: true };
}

/** The attachments on the turn's command: images (Claude history keeps them inline as data URLs, Codex as paths) and files. */
function turnAttachments(turn: HistoryMessage[]): { images: Array<{ data?: string; path?: string }>; files: string[] } {
  const opening = turn[0] && isUserTurn(turn[0]) ? turn[0] : null;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object') : []);
  return {
    images: list(opening?.images).map((image) => ({ data: typeof image.data === 'string' ? image.data : undefined, path: typeof image.path === 'string' ? image.path : undefined })),
    files: list(opening?.files).flatMap((file) => (typeof file.path === 'string' ? [file.path] : [])),
  };
}

const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/;

/**
 * The command's images as files the verifier can open (Claude's Read, Codex's local image input), written under `dir`;
 * an image already on disk (a Codex turn) is used where it is. Images that cannot be had are left out.
 */
async function imageFilesFor(turn: HistoryMessage[], dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const [index, image] of turnAttachments(turn).images.entries()) {
    const inline = image.data ? DATA_URL.exec(image.data) : null;
    if (inline) {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `image-${index + 1}.${inline[1] === 'jpeg' ? 'jpg' : inline[1]}`);
      await fs.writeFile(file, Buffer.from(inline[2], 'base64'));
      files.push(file);
    } else if (image.path && path.isAbsolute(image.path) && await fs.access(image.path).then(() => true, () => false)) {
      files.push(image.path);
    }
  }
  return files;
}

/**
 * Pure part (exported for tests): the run's turn (verifiedTurn) as the brief the verifier checks: the command and its
 * attachments, files the worker touched, commands it ran, errors it saw, and its final report (the claims).
 */
export function buildVerificationBrief(messages: HistoryMessage[], input: { command: string | null; agent: string | null; engine: string | null; model: string | null; startedAt?: number | null; imageFiles?: string[] }): { text: string; files: string[]; claims: string; changedProject: boolean } {
  const { turn } = verifiedTurn(messages, input.startedAt ?? null);
  const attachedFiles = turnAttachments(turn).files;
  const imageFiles = input.imageFiles ?? [];
  const files = new Set<string>(); const commands: string[] = []; const errors: string[] = []; const reports: string[] = [];
  // the platform's own tools (a piece handed to OpenCode, a command on a user's PC): their results are claims' evidence
  // the verifier cannot reproduce from the repository, so it gets them as recorded (2026-10-16: a run that used
  // opencode_task was failed for "no record of the call")
  const platformCalls: string[] = [];
  for (const message of turn) {
    if (message.kind === 'text' && message.role === 'assistant' && message.content) reports.push(message.content);
    else if (message.kind === 'tool_use' && message.toolName) {
      const args = inputOf(message.toolInput);
      if (PLATFORM_TOOL.test(message.toolName)) {
        const result = message.toolResult ? `${message.toolResult.isError ? '오류: ' : ''}${clip(message.toolResult.content, 600)}` : '(결과 없음)';
        platformCalls.push(`${message.toolName.replace(PLATFORM_TOOL, '')} ${clip(args, 300)} → ${result}`);
      }
      const filePath = args.file_path ?? args.filePath ?? args.path;
      if (FILE_TOOLS.has(message.toolName) && typeof filePath === 'string' && !AGENT_METADATA_PATH.test(filePath)) files.add(filePath);
      // OpenCode records a patch as the list of files it touched
      if (message.toolName === 'Patch' && Array.isArray(args.files)) for (const file of args.files) if (typeof file === 'string' && !AGENT_METADATA_PATH.test(file)) files.add(file);
      if (COMMAND_TOOLS.has(message.toolName) && (typeof args.command === 'string' || Array.isArray(args.command))) commands.push(clip(Array.isArray(args.command) ? args.command.join(' ') : args.command, 200));
    } else if ((message.kind === 'tool_result' && message.toolResult?.isError) || message.kind === 'error') {
      errors.push(clip(message.kind === 'error' ? (message.content ?? message.text) : message.toolResult?.content, 300));
    }
  }
  const userText = turn[0]?.kind === 'text' && turn[0].role === 'user' ? turn[0].content ?? '' : '';
  // the final report carries the claims; earlier assistant text is progress narration
  const claims = clip(reports.slice(-3).join('\n\n'), 6000);
  const lines = [
    `## 사용자의 명령\n${clip(input.command ?? (userText || '(알 수 없음)'), 2000)}`,
    imageFiles.length ? `## 명령에 첨부된 이미지 (사용자가 명령과 함께 보낸 것 — 직접 열어 보고 판단한다)\n${imageFiles.map((file) => `- ${file}`).join('\n')}` : null,
    attachedFiles.length ? `## 명령에 첨부된 파일\n${attachedFiles.map((file) => `- ${file}`).join('\n')}` : null,
    `## 작업자\nagent ${input.agent ?? '(없음)'} · ${input.engine ?? '?'} ${input.model ?? ''}`.trim(),
    files.size ? `## 작업자가 수정했다고 기록된 파일\n${[...files].slice(-40).map((file) => `- ${file}`).join('\n')}` : '## 작업자가 수정했다고 기록된 파일\n(도구 기록 없음)',
    commands.length ? `## 작업자가 실행한 명령(최근)\n${commands.slice(-12).map((command) => `- ${command}`).join('\n')}` : null,
    platformCalls.length ? `## 작업자가 쓴 플랫폼 도구와 그 결과(최근 — 저장소로는 재현할 수 없는 근거: 서브에이전트 보고, 원격 PC 실행 등)\n${platformCalls.slice(-8).map((call) => `- ${call}`).join('\n')}` : null,
    errors.length ? `## 작업 중 보인 오류\n${errors.slice(-5).map((error) => `- ${error}`).join('\n')}` : null,
    `## 작업자의 최종 보고 (검증할 주장)\n${claims || '(보고 없음 — 명령의 요구가 저장소에 반영됐는지 직접 확인)'}`,
    '위 보고의 주장을 하나씩 실제로 확인하고 <aidev-verify> 블록을 출력하라.',
  ].filter((line): line is string => line !== null);
  // what there is to verify: a turn that changed no project file (a review, an analysis, an answer, a plan) has no work
  const changedProject = files.size > 0 || commands.some((command) => GIT_RECORDING_COMMAND.test(command));
  return { text: lines.join('\n\n'), files: [...files], claims, changedProject };
}

/** Accepts the tagged block, a ```json fence, or a bare object — models drop the tags now and then. */
export function parseVerification(text: string): Omit<Verification, 'engine' | 'model'> | null {
  const tagged = /<aidev-verify>\s*([\s\S]*?)\s*<\/aidev-verify>/.exec(text);
  const fenced = tagged ? null : /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const bare = tagged || fenced ? null : /\{[\s\S]*\}/.exec(text);
  const body = tagged?.[1] ?? fenced?.[1] ?? bare?.[0];
  if (!body) return null;
  try {
    const raw = JSON.parse(body.trim()) as Record<string, unknown>;
    const verdict = raw.verdict === 'pass' || raw.verdict === 'fail' || raw.verdict === 'unclear' ? raw.verdict : null;
    if (!verdict) return null;
    const checked = Array.isArray(raw.checked) ? (raw.checked as unknown[]).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const check = entry as Record<string, unknown>;
      const result: VerificationCheck['result'] = check.result === 'ok' || check.result === 'wrong' || check.result === 'unverified' ? check.result : 'unverified';
      return typeof check.claim === 'string' ? [{ claim: check.claim.slice(0, 500), result, evidence: typeof check.evidence === 'string' ? check.evidence.slice(0, 500) : '' }] : [];
    }).slice(0, 30) : [];
    const issues = Array.isArray(raw.issues) ? (raw.issues as unknown[]).filter((issue): issue is string => typeof issue === 'string' && issue.trim().length > 0).map((issue) => issue.slice(0, 600)).slice(0, 20) : [];
    return { verdict, summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 1000) : '', checked, issues };
  } catch {
    return null;
  }
}

/**
 * Reading a repository and re-running its checks: minutes, not the judge's seconds. One budget for the whole check,
 * shared by the engines tried in turn, so the answer reaches the gateway inside its 12 min wait (a Codex model at
 * capacity alone spent 3.5 min retrying before the Claude fallback started — run 274).
 */
const VERIFY_BUDGET_MS = 11 * 60_000;
/** Too little left to read anything: the next engine is not started. */
const MIN_ENGINE_MS = 60_000;
const VERIFIER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

async function askClaude(prompt: string, cwd: string, model: string, effort: string | null, systemPrompt: string, timeoutMs: number): Promise<string> {
  let output = '';
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const stream = query({
      prompt,
      options: {
        cwd, maxTurns: 25, model: claudeCliModel(model), ...(effort ? { effort: effort as 'high' } : {}), allowedTools: VERIFIER_TOOLS, tools: VERIFIER_TOOLS, permissionMode: 'bypassPermissions', systemPrompt,
        // an internal side turn: no transcript, so it never shows up as a conversation in the user's project
        settingSources: [], persistSession: false, abortController,
      },
    });
    for await (const message of stream) {
      const record = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
      if (record.type === 'assistant') for (const block of record.message?.content ?? []) if (block.type === 'text' && block.text) output += `${block.text}\n`;
      if (record.type === 'result' && typeof record.result === 'string' && !parseVerification(output)) output += `\n${record.result}`;
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/** Codex writes every exec as a rollout the runtime lists as a conversation; side turns are marked subagent so the
 *  session indexer skips them (see lesson-curator.service.ts). */
const SIDE_TURN_SOURCE = 'subagent';

async function askCodex(prompt: string, cwd: string, model: string, effort: string | null, systemPrompt: string, timeoutMs: number, images: string[]): Promise<string> {
  const codex = new Codex({ config: { ...codexSandboxConfig(), developer_instructions: systemPrompt } as never });
  // reads and runs checks in the project; write access (where the host's sandbox allows it) only so build/test caches
  // work — the prompt forbids edits
  const thread = codex.startThread({ threadSource: SIDE_TURN_SOURCE, workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: codexCheckSandboxMode(), approvalPolicy: 'never', model, modelReasoningEffort: (effort ?? 'high') as 'high', webSearchMode: 'disabled' });
  // the command's images go in as images: the model sees them without a tool call
  const input = images.length ? [{ type: 'text' as const, text: prompt }, ...images.map((file) => ({ type: 'local_image' as const, path: file }))] : prompt;
  const turn = await thread.run(input, { signal: AbortSignal.timeout(timeoutMs) }).catch((error: unknown) => { noteCodexTurnError(error); throw error; });
  return turn.finalResponse ?? '';
}

/** Runs the brief on the verifier engines in order until one answers. */
async function checkBrief(input: VerifyInput, cwd: string, brief: { text: string }, imageFiles: string[]): Promise<Verification & { briefChars: number }> {
  // the gateway's candidates (verification order / provider policy) or the worker's other engine first; on the same
  // engine the check runs as a different agent (verifierAgent). This runtime's own knowledge of Codex applies to both.
  const codexState = { signedOut: Boolean(currentCodexAuthFailure()), busy: codexBusyUntil > Date.now() };
  // OpenCode refusing on a usage limit (a chat or an earlier side turn saw it): passed over until its reset instead of
  // spending the check's budget on the same refusal. Lazy: the providers module imports this module's barrel.
  const { providerUsageLimitsService } = await import('@/modules/providers/index.js');
  const openCodeHeld = providerUsageLimitsService.snapshot().opencode?.blockedUntil;
  const order = verifierCandidates(input, codexState).filter((candidate) => candidate.engine !== 'opencode' || openCodeHeld === null || openCodeHeld === undefined);
  const systemPrompt = verifierSystemPrompt(input.verifierAgent);
  let lastError: unknown = null;
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  for (const { engine, model, effort } of order) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ENGINE_MS) break;
    try {
      const text = engine === 'opencode' ? await askOpenCodeSideTurn({ label: 'verify', instructions: systemPrompt, prompt: brief.text, cwd, model, effort, access: 'check', timeoutMs: remaining })
        : engine === 'claude' ? await askClaude(brief.text, cwd, model!, effort, systemPrompt, remaining) : await askCodex(brief.text, cwd, model!, effort, systemPrompt, remaining, imageFiles);
      const parsed = parseVerification(text);
      const result: Verification = parsed
        ? { ...parsed, engine, model }
        : { verdict: 'unclear', summary: `검증자가 판정 블록을 내지 않았습니다: ${clip(text.replace(/\s+/g, ' ').trim(), 300)}`, checked: [], issues: [], engine, model };
      console.log(`[aidev-tools] verify run=${input.runId ?? '-'} agent=${input.agent ?? '-'} by ${engine} ${model ?? '(default)'}${input.verifierAgent ? ` as ${input.verifierAgent.name}` : ''}: ${result.verdict} — ${clip(result.summary, 200)}`);
      return { ...result, briefChars: brief.text.length };
    } catch (error) {
      lastError = error;
      if (engine === 'codex' && /at capacity/i.test(error instanceof Error ? error.message : String(error))) codexBusyUntil = Date.now() + CODEX_BUSY_MS;
      console.warn(`[aidev-tools] verify run=${input.runId ?? '-'} ${engine} ${model ?? '(default)'} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { verdict: 'unclear', summary: `검증 턴을 실행하지 못했습니다: ${lastError instanceof Error ? lastError.message : '사용 가능한 엔진 없음'}`, checked: [], issues: [], engine: null, model: null, briefChars: brief.text.length };
}

export const runVerifierService = {
  /** Verifies the worker's last turn in `sessionId`; `unclear` when the verifier itself could not run or answer. */
  async verify(input: VerifyInput): Promise<Verification & { briefChars: number; skipped?: string }> {
    const session = sessionsDb.getSessionById(input.sessionId);
    const cwd = session?.project_path || process.cwd();
    // Lazy: the providers module imports this module's barrel (see lesson-curator.service.ts).
    const { sessionsService } = await import('@/modules/providers/index.js');
    const history = await sessionsService.fetchHistory(input.sessionId, { limit: 400, offset: 0 });
    const messages = history.messages as HistoryMessage[];
    const { turn, movedOn } = verifiedTurn(messages, input.startedAt);
    // the chat went on past this run (the user's next command, or one queued during the run): checking the old command
    // now only brings it back over the new one
    // Not checked (`skipped`: the gateway stores no verdict and the apps show no card): the chat went on past this run
    // (the user's next command, or one queued during the run) — checking the old command now only brings it back over
    // the new one; or the turn changed no project file — a review, an analysis, an answer or a plan has no work to
    // check, and a fail sent the command back with "fix these" until the worker implemented what was only to be
    // reviewed (2026-11-20, runs 2705–2707).
    const skip = (reason: string) => {
      console.log(`[aidev-tools] verify run=${input.runId ?? '-'}: not checked — ${reason}`);
      return { verdict: 'unclear' as const, summary: reason, checked: [], issues: [], engine: null, model: null, briefChars: 0, skipped: reason };
    };
    if (movedOn) return skip('the chat went on past this run');
    if (!buildVerificationBrief(messages, { command: input.command, agent: input.agent, engine: input.engine, model: input.workerModel, startedAt: input.startedAt }).changedProject) {
      return skip('the turn changed no project file');
    }
    const imageDir = path.join(os.tmpdir(), 'aidev-verify', `${input.runId ?? 'run'}-${Date.now()}`);
    try {
      const imageFiles = await imageFilesFor(turn, imageDir).catch((error: unknown) => {
        console.warn(`[aidev-tools] verify run=${input.runId ?? '-'}: the command's images were not written: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      return await checkBrief(input, cwd, buildVerificationBrief(messages, { command: input.command, agent: input.agent, engine: input.engine, model: input.workerModel, startedAt: input.startedAt, imageFiles }), imageFiles);
    } finally {
      await fs.rm(imageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};
