import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';

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
  engine: 'claude' | 'codex' | null;
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

async function askClaude(prompt: string, cwd: string): Promise<string> {
  let output = '';
  const stream = query({
    prompt,
    options: { cwd, maxTurns: 1, model: 'haiku', allowedTools: [], tools: [], permissionMode: 'bypassPermissions', systemPrompt: CURATOR_PROMPT, settingSources: [] },
  });
  for await (const message of stream) {
    const record = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
    if (record.type === 'assistant') for (const block of record.message?.content ?? []) if (block.type === 'text' && block.text) output += block.text;
    if (record.type === 'result' && typeof record.result === 'string' && !output) output = record.result;
  }
  return output;
}

async function askCodex(prompt: string, cwd: string): Promise<string> {
  const codex = new Codex({ config: { developer_instructions: CURATOR_PROMPT } as never });
  const thread = codex.startThread({ workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', model: 'gpt-5.4-mini' });
  const turn = await thread.run(prompt);
  return turn.finalResponse ?? '';
}

export const lessonCuratorService = {
  /** Produces a lesson candidate for a failed run, or null when the curator finds nothing reusable. */
  async curate(input: CurateInput): Promise<{ candidate: LessonCandidate | null; summaryChars: number; engine: string }> {
    const session = sessionsDb.getSessionById(input.sessionId);
    const cwd = session?.project_path || process.cwd();
    const summary = await buildSummary(input);
    const prompt = `다음 실패한 실행을 분석해 규칙 후보를 만들어라.\n\n${summary}`;
    const preferCodex = input.engine === 'codex';
    let text = '';
    let engine = preferCodex ? 'codex' : 'claude';
    try {
      text = preferCodex ? await askCodex(prompt, cwd) : await askClaude(prompt, cwd);
    } catch (error) {
      // the session's engine is unavailable for a side turn: try the other one
      engine = preferCodex ? 'claude' : 'codex';
      try { text = preferCodex ? await askClaude(prompt, cwd) : await askCodex(prompt, cwd); }
      catch { throw error; }
    }
    const candidate = parseLesson(text);
    console.log(`[aidev-tools] curate run=${input.runId ?? '-'} agent=${input.agent ?? '-'} engine=${engine} summary=${summary.length}ch → ${candidate ? `${candidate.trigger} → ${candidate.rule}` : `none (${clip(text.replace(/\s+/g, ' '), 240)})`}`);
    return { candidate, summaryChars: summary.length, engine };
  },
};
