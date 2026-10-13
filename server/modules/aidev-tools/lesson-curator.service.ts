import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';

import { askOpenCodeSideTurn } from '@/modules/aidev-tools/opencode-side-turn.client.js';
import { sessionsDb } from '@/modules/database/index.js';
import { codexSandboxConfig, noteCodexTurnError } from '@/shared/index.js';
import type { AidevSideEngine } from '@/shared/index.js';

/**
 * Lesson curation for failed runs (IMPLEMENTATION-PLAN §3.8 / E-01): summarises the session's
 * last turns and asks a headless, tool-less model turn (Claude haiku, or Codex when that is the
 * session's engine) for a reusable {trigger, rule} candidate. Runs out of band — nothing is
 * written into the user's conversation. The gateway judges the candidate with Laya
 * (`lesson.accept`) before storing it.
 */
export type CurateInput = {
  sessionId: string;
  runId: number | null;
  agent: string | null;
  engine: AidevSideEngine | null;
  /** the engines this account may use (D-05); the fallback stays inside them. Default Claude and Codex. */
  engines?: AidevSideEngine[];
  /**
   * The gateway's order once the account set a work order or a provider policy (PROVIDER-ENGINE-PLAN §2.5): tried in
   * this order; a null model is the engine's light side-turn model (OpenCode: the model it starts on). Absent = the
   * session's engine first (curatorOrder).
   */
  candidates?: Array<{ engine: AidevSideEngine; model: string | null }> | null;
  command: string | null;
  signals: Record<string, unknown>;
};

export type LessonCandidate = { trigger: string; rule: string; engine: string | null; generalizable: boolean };

const CURATOR_PROMPT = `당신은 실패 분석가다. 실패한 실행의 요약(명령, 사용 agent·엔진, 오류·되돌림·피드백 신호, 대화 발췌)을 받아, 같은 실패를 다음에 피하게 할 규칙 후보를 만든다.
규칙은 일반화 가능해야 한다: 일회성 오타, 특정 파일 이름, 환경 특이 문제는 제외한다. 이미 당연한 상식도 제외한다.
출력은 아래 블록 하나만. 만들 규칙이 없으면 {"none":true}.
<aidev-lesson>
{"trigger":"<어떤 상황에서 (1문장)>","rule":"<다음에 무엇을 할 것 (1~2문장, 명령형)>","engine":null,"generalizable":true}
</aidev-lesson>`;

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function buildSummary(input: CurateInput): Promise<string> {
  // Lazy: the providers module imports this module's barrel (runtime providers), so a top-level
  // import would close a cycle and break module initialisation order.
  const { sessionsService } = await import('@/modules/providers/index.js');
  const history = await sessionsService.fetchHistory(input.sessionId, { limit: 40, offset: 0 });
  const lines: string[] = [];
  for (const message of history.messages.slice(-40)) {
    if (message.kind === 'text' && message.content) lines.push(`${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(message.content, 600)}`);
    else if (message.kind === 'tool_use') lines.push(`TOOL ${message.toolName}: ${clip(message.toolInput, 200)}`);
    else if (message.kind === 'tool_result' && message.toolResult?.isError) lines.push(`TOOL ERROR: ${clip(message.toolResult.content, 400)}`);
    else if (message.kind === 'error') lines.push(`ERROR: ${clip(message.content ?? message.text, 400)}`);
  }
  return [
    `명령: ${input.command ?? '(unknown)'}`,
    `agent: ${input.agent ?? '(none)'} / engine: ${input.engine ?? '(unknown)'}`,
    `실패 신호: ${JSON.stringify(input.signals)}`,
    '--- 대화 발췌 (최근) ---',
    ...lines.slice(-30),
  ].join('\n');
}

/** Accepts the tagged block, a ```json fence, or a bare object — small models drop the tags now and then. */
export function parseLesson(text: string): LessonCandidate | null {
  const tagged = /<aidev-lesson>\s*([\s\S]*?)\s*<\/aidev-lesson>/.exec(text);
  const fenced = tagged ? null : /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const bare = tagged || fenced ? null : /\{[\s\S]*\}/.exec(text);
  const body = tagged?.[1] ?? fenced?.[1] ?? bare?.[0];
  if (!body) return null;
  try {
    const raw = JSON.parse(body.trim()) as Record<string, unknown>;
    if (raw.none === true) return null;
    if (typeof raw.trigger !== 'string' || typeof raw.rule !== 'string') return null;
    return { trigger: raw.trigger.slice(0, 1000), rule: raw.rule.slice(0, 2000), engine: typeof raw.engine === 'string' ? raw.engine : null, generalizable: raw.generalizable !== false };
  } catch {
    return null;
  }
}

/** Light Claude model for side turns (the D0 tier). */
const CLAUDE_SIDE_MODEL = 'haiku';

async function askClaude(prompt: string, cwd: string, model: string): Promise<string> {
  let output = '';
  const stream = query({
    prompt,
    options: { cwd, maxTurns: 1, model, allowedTools: [], tools: [], permissionMode: 'bypassPermissions', systemPrompt: CURATOR_PROMPT, settingSources: [],
      // an internal one-shot call: no transcript, so it never shows up as a conversation in the user's project
      persistSession: false },
  });
  for await (const message of stream) {
    const record = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
    if (record.type === 'assistant') for (const block of record.message?.content ?? []) if (block.type === 'text' && block.text) output += block.text;
    if (record.type === 'result' && typeof record.result === 'string' && !output) output = record.result;
  }
  return output;
}

/** Light Codex model for side turns: gpt-5.4-mini is refused for ChatGPT-account logins (server 2026-10-01); luna is the D0 tier. */
const CODEX_SIDE_MODEL = 'gpt-5.6-luna';

/** Codex writes every exec as a rollout the runtime lists as a conversation; side turns are marked subagent so the
 *  session indexer skips them (they appeared as "aidev-judge-…" chats with JSON titles — 2026-10-01). */
const SIDE_TURN_SOURCE = 'subagent';

async function askCodex(prompt: string, cwd: string, model: string): Promise<string> {
  const codex = new Codex({ config: { ...codexSandboxConfig(), developer_instructions: CURATOR_PROMPT } as never });
  // a tool-less side turn (the summary is in the prompt): no web search, low effort — as the judge
  const thread = codex.startThread({ threadSource: SIDE_TURN_SOURCE, workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', model, modelReasoningEffort: 'low', webSearchMode: 'disabled' });
  const turn = await thread.run(prompt).catch((error: unknown) => { noteCodexTurnError(error); throw error; });
  return turn.finalResponse ?? '';
}

/** How long an OpenCode curation turn may take (Claude and Codex answer a tool-less turn in seconds). */
const OPENCODE_CURATE_TIMEOUT_MS = 3 * 60_000;

/**
 * The engines the curator tries, in order, with their models: the gateway's candidates when it sent them, else the
 * session's engine first (Codex when that ran the session or Claude is not among the account's engines) and the
 * others as the fallback when the account may use them — OpenCode only when the gateway named it among the account's
 * engines or it ran the session. Used by `curate` and its test.
 */
export function curatorOrder(input: Pick<CurateInput, 'engine' | 'engines' | 'candidates'>): Array<{ engine: AidevSideEngine; model: string | null }> {
  const light = (engine: AidevSideEngine) => (engine === 'claude' ? CLAUDE_SIDE_MODEL : engine === 'codex' ? CODEX_SIDE_MODEL : null);
  if (input.candidates) return input.candidates.map((c) => ({ engine: c.engine, model: c.model ?? light(c.engine) }));
  const named = input.engines?.length ? input.engines : null;
  const preferCodex = input.engine === 'codex' || Boolean(named && !named.includes('claude'));
  const order: AidevSideEngine[] = input.engine === 'opencode' || (named && !named.includes('claude') && !named.includes('codex')) ? ['opencode', 'claude', 'codex']
    : preferCodex ? ['codex', 'claude', 'opencode'] : ['claude', 'codex', 'opencode'];
  const fallback = order.slice(1).filter((engine) => (named ? named.includes(engine) : engine !== 'opencode'));
  return [order[0], ...fallback].map((engine) => ({ engine, model: light(engine) }));
}

export const lessonCuratorService = {
  /** Produces a lesson candidate for a failed run, or null when the curator finds nothing reusable. */
  async curate(input: CurateInput): Promise<{ candidate: LessonCandidate | null; summaryChars: number; engine: string }> {
    const session = sessionsDb.getSessionById(input.sessionId);
    const cwd = session?.project_path || process.cwd();
    const summary = await buildSummary(input);
    const prompt = `다음 실패한 실행을 분석해 규칙 후보를 만들어라.\n\n${summary}`;
    const order = curatorOrder(input);
    if (!order.length) throw new Error('no engine available for the curator');
    let text = '';
    let engine: string = order[0].engine;
    let firstError: unknown = null;
    // an engine unavailable for a side turn: the next one in the order takes it; the first failure is the one reported
    for (const candidate of order) {
      try {
        text = candidate.engine === 'opencode' ? await askOpenCodeSideTurn({ label: 'curate', instructions: CURATOR_PROMPT, prompt, cwd, model: candidate.model, effort: null, access: 'read', timeoutMs: OPENCODE_CURATE_TIMEOUT_MS })
          : candidate.engine === 'claude' ? await askClaude(prompt, cwd, candidate.model!) : await askCodex(prompt, cwd, candidate.model!);
        engine = candidate.engine; firstError = null;
        break;
      } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
    const candidate = parseLesson(text);
    console.log(`[aidev-tools] curate run=${input.runId ?? '-'} agent=${input.agent ?? '-'} engine=${engine} summary=${summary.length}ch → ${candidate ? `${candidate.trigger} → ${candidate.rule}` : `none (${clip(text.replace(/\s+/g, ' '), 240)})`}`);
    return { candidate, summaryChars: summary.length, engine };
  },
};
