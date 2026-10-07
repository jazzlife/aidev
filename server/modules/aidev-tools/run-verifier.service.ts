import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';

import { sessionsDb } from '@/modules/database/index.js';

/**
 * Independent verification of a finished run (2026-10-07, worker ≠ verifier). The worker agent's final
 * report is a set of claims — files changed, features added, checks passed. A separate headless turn,
 * on a model at least as strong as the worker's (and never below opus / sol or the user's model floor),
 * reads the repository and re-runs the checks before the run may count as a success. It never edits
 * files and never writes into the conversation; the gateway stores the verdict on the run, fails the
 * run when the report was wrong, and the apps show the card.
 */
export type VerifyInput = {
  sessionId: string;
  runId: number | null;
  agent: string | null;
  /** the worker's engine and model */
  engine: 'claude' | 'codex' | null;
  workerModel: string | null;
  /** the engines this account may use and is signed in to (D-05); the verifier stays inside them */
  engines: Array<'claude' | 'codex'>;
  command: string | null;
  depth: number | null;
  /** the user's model floor per engine (routing MODEL_LADDER names) */
  modelFloor: Partial<Record<'claude' | 'codex', string>>;
};

export type VerificationCheck = { claim: string; result: 'ok' | 'wrong' | 'unverified'; evidence: string };
export type Verification = { verdict: 'pass' | 'fail' | 'unclear'; summary: string; checked: VerificationCheck[]; issues: string[]; engine: string | null; model: string | null };

const VERIFIER_PROMPT = `당신은 독립 검증자다. 다른 agent(작업자)가 방금 끝낸 작업을 검증한다. 작업자의 보고를 믿지 말고, 저장소의 실제 상태와 직접 실행한 명령의 결과로만 판단한다.
## 절차
1. 작업자의 보고에서 검증 가능한 주장을 뽑는다: 수정·추가했다는 파일, 구현했다는 기능, 통과했다는 빌드·타입체크·린트·테스트.
2. 주장마다 파일을 직접 읽고(Read/Grep/Glob), 보고에 적힌 검사(빌드·타입체크·테스트)는 같은 명령을 직접 실행해 결과를 확인한다. 실행 결과는 종료 코드와 출력으로 판단한다.
3. 사용자의 원래 명령이 요구한 것 중 보고에 없거나 빠진 것을 찾는다.
## 규칙
- 파일을 수정·생성·삭제하지 않는다. 확인용 명령(읽기, 빌드, 테스트, 린트, git status/diff)만 실행한다.
- 파괴적 명령(삭제, reset, push, 배포, 설치)은 실행하지 않는다.
- 확인하지 못한 주장은 ok가 아니라 unverified로 적는다. 추측으로 ok를 주지 않는다.
- 아래 블록 하나만 출력한다. 블록 밖의 설명은 최소화한다.
<aidev-verify>
{"verdict":"pass"|"fail"|"unclear","summary":"<한두 문장: 보고가 실제와 맞는지>","checked":[{"claim":"<주장>","result":"ok"|"wrong"|"unverified","evidence":"<무엇을 읽거나 실행해 확인했는지, 한 줄>"}],"issues":["<작업자가 틀렸거나 빠뜨린 것, 사용자가 바로 알아야 할 순서로>"]}
</aidev-verify>
verdict 기준: 주장 중 하나라도 wrong이거나 명령의 핵심 요구가 빠졌으면 fail. 모든 주장이 ok이고 빠진 것이 없으면 pass. 핵심 주장을 확인할 수 없으면 unclear.`;

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

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'edit', 'write']);
const COMMAND_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell']);

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { const parsed = JSON.parse(raw) as unknown; return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
  return {};
}

type HistoryMessage = { kind: string; role?: string; content?: string; text?: string; toolName?: string; toolInput?: unknown; toolResult?: { isError?: boolean; content?: unknown } | null };

/**
 * Pure part (exported for tests): the worker's last turn — everything after the newest user message — as
 * the brief the verifier checks: the command, files the worker touched, commands it ran, errors it saw,
 * and its final report (the claims).
 */
export function buildVerificationBrief(messages: HistoryMessage[], input: { command: string | null; agent: string | null; engine: string | null; model: string | null }): { text: string; files: string[]; claims: string } {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].kind === 'text' && messages[index].role === 'user' && messages[index].content) { start = index; break; }
  }
  const turn = messages.slice(start);
  const files = new Set<string>(); const commands: string[] = []; const errors: string[] = []; const reports: string[] = [];
  for (const message of turn) {
    if (message.kind === 'text' && message.role === 'assistant' && message.content) reports.push(message.content);
    else if (message.kind === 'tool_use' && message.toolName) {
      const args = inputOf(message.toolInput);
      if (FILE_TOOLS.has(message.toolName) && typeof (args.file_path ?? args.path) === 'string') files.add(String(args.file_path ?? args.path));
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
    `## 작업자\nagent ${input.agent ?? '(없음)'} · ${input.engine ?? '?'} ${input.model ?? ''}`.trim(),
    files.size ? `## 작업자가 수정했다고 기록된 파일\n${[...files].slice(-40).map((file) => `- ${file}`).join('\n')}` : '## 작업자가 수정했다고 기록된 파일\n(도구 기록 없음)',
    commands.length ? `## 작업자가 실행한 명령(최근)\n${commands.slice(-12).map((command) => `- ${command}`).join('\n')}` : null,
    errors.length ? `## 작업 중 보인 오류\n${errors.slice(-5).map((error) => `- ${error}`).join('\n')}` : null,
    `## 작업자의 최종 보고 (검증할 주장)\n${claims || '(보고 없음 — 명령의 요구가 저장소에 반영됐는지 직접 확인)'}`,
    '위 보고의 주장을 하나씩 실제로 확인하고 <aidev-verify> 블록을 출력하라.',
  ].filter((line): line is string => line !== null);
  return { text: lines.join('\n\n'), files: [...files], claims };
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

/** Reading a repository and re-running its checks: minutes, not the judge's seconds. */
const HARD_TIMEOUT_MS = 10 * 60_000;
const VERIFIER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

async function askClaude(prompt: string, cwd: string, model: string): Promise<string> {
  let output = '';
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), HARD_TIMEOUT_MS);
  try {
    const stream = query({
      prompt,
      options: {
        cwd, maxTurns: 25, model, allowedTools: VERIFIER_TOOLS, tools: VERIFIER_TOOLS, permissionMode: 'bypassPermissions', systemPrompt: VERIFIER_PROMPT,
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

async function askCodex(prompt: string, cwd: string, model: string): Promise<string> {
  const codex = new Codex({ config: { developer_instructions: VERIFIER_PROMPT } as never });
  // reads and runs checks in the project; write access only so build/test caches work — the prompt forbids edits
  const thread = codex.startThread({ threadSource: SIDE_TURN_SOURCE, workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'workspace-write', approvalPolicy: 'never', model, modelReasoningEffort: 'high', webSearchMode: 'disabled' });
  const turn = await thread.run(prompt);
  return turn.finalResponse ?? '';
}

export const runVerifierService = {
  /** Verifies the worker's last turn in `sessionId`; `unclear` when the verifier itself could not run or answer. */
  async verify(input: VerifyInput): Promise<Verification & { briefChars: number }> {
    const session = sessionsDb.getSessionById(input.sessionId);
    const cwd = session?.project_path || process.cwd();
    // Lazy: the providers module imports this module's barrel (see lesson-curator.service.ts).
    const { sessionsService } = await import('@/modules/providers/index.js');
    const history = await sessionsService.fetchHistory(input.sessionId, { limit: 400, offset: 0 });
    const brief = buildVerificationBrief(history.messages as HistoryMessage[], { command: input.command, agent: input.agent, engine: input.engine, model: input.workerModel });
    // Claude checks when the account can use it (a different engine than a Codex worker is a plus); Codex otherwise.
    const order: Array<'claude' | 'codex'> = input.engines.includes('claude') ? ['claude', 'codex'] : ['codex', 'claude'];
    let lastError: unknown = null;
    for (const engine of order) {
      if (!input.engines.includes(engine)) continue;
      const model = verifierModel(engine, { workerEngine: input.engine, workerModel: input.workerModel, floor: input.modelFloor[engine] });
      try {
        const text = engine === 'claude' ? await askClaude(brief.text, cwd, model) : await askCodex(brief.text, cwd, model);
        const parsed = parseVerification(text);
        const result: Verification = parsed
          ? { ...parsed, engine, model }
          : { verdict: 'unclear', summary: `검증자가 판정 블록을 내지 않았습니다: ${clip(text.replace(/\s+/g, ' ').trim(), 300)}`, checked: [], issues: [], engine, model };
        console.log(`[aidev-tools] verify run=${input.runId ?? '-'} agent=${input.agent ?? '-'} by ${engine} ${model}: ${result.verdict} — ${clip(result.summary, 200)}`);
        return { ...result, briefChars: brief.text.length };
      } catch (error) {
        lastError = error;
        console.warn(`[aidev-tools] verify run=${input.runId ?? '-'} ${engine} ${model} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { verdict: 'unclear', summary: `검증 턴을 실행하지 못했습니다: ${lastError instanceof Error ? lastError.message : '사용 가능한 엔진 없음'}`, checked: [], issues: [], engine: null, model: null, briefChars: brief.text.length };
  },
};
