import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';

/**
 * Knowledge refresh (IMPLEMENTATION-PLAN §3.8, E-04): re-checks one stored knowledge item against its
 * source and current official docs with a headless web-enabled turn (Claude WebSearch/WebFetch, or
 * Codex live web search), out of band — no transcript is kept and nothing reaches a conversation.
 * The gateway schedules it, judges a proposed replacement with Laya (`knowledge.stale`) and applies
 * the result.
 */
export type KnowledgeCheckInput = {
  title: string;
  body: string;
  sourceUrl: string | null;
  sourceDate: string | null;
  agent: string | null;
  engine: 'claude' | 'codex';
  model: string | null;
  /** knowledge-refresher agent prompt (from the gateway catalog); a built-in copy is used when absent */
  prompt: string | null;
};

export type KnowledgeReplacement = { title: string; body: string; source_url: string | null; source_date: string | null };
export type KnowledgeCheck = { status: 'current' | 'changed' | 'unreachable'; summary: string; replacement: KnowledgeReplacement | null };

const DEFAULT_PROMPT = `당신은 기술 지식 검증자다. 지식 항목(제목, 본문, 출처 URL, 출처 날짜)을 받아 출처와 최신 공식 문서를 다시 확인하고, 내용이 여전히 맞는지 판정한다.
출력은 아래 블록 하나만.
<aidev-knowledge-check>
{"status":"current"|"changed"|"unreachable","summary":"<변경 요지 1~3문장>","replacement":{"title":"...","body":"...","source_url":"...","source_date":"YYYY-MM-DD"}|null}
</aidev-knowledge-check>`;

const RULES = `규칙:
- 반드시 웹에서 출처 URL과 최신 공식 문서를 직접 확인한다. 기억에 의존하지 않는다.
- 내용이 여전히 맞으면 status "current", replacement null.
- 버전·API·권장 방식이 바뀌었으면 status "changed"; replacement.body는 기존 항목을 대체할 완결된 본문(마크다운, 핵심만)이고 source_url은 확인한 공식 문서, source_date는 그 문서의 날짜(모르면 오늘 날짜).
- 출처와 대체 문서 모두 확인할 수 없으면 status "unreachable".`;

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildRequest(input: KnowledgeCheckInput) {
  return [
    `오늘 날짜: ${new Date().toISOString().slice(0, 10)}`,
    input.agent ? `이 지식을 쓰는 agent: ${input.agent}` : null,
    `제목: ${input.title}`,
    `출처: ${input.sourceUrl ?? '(없음)'}${input.sourceDate ? ` (${input.sourceDate})` : ''}`,
    '--- 본문 ---',
    clip(input.body, 12000),
    '---',
    RULES,
  ].filter((line): line is string => line !== null).join('\n');
}

const str = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** Reads the `<aidev-knowledge-check>` block (or a ```json fence / bare object) from the model's answer. */
export function parseKnowledgeCheck(text: string): KnowledgeCheck | null {
  const tagged = /<aidev-knowledge-check>\s*([\s\S]*?)\s*<\/aidev-knowledge-check>/.exec(text);
  const fenced = tagged ? null : /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  let raw = tagged?.[1] ?? fenced?.[1] ?? null;
  if (!raw) {
    const start = text.indexOf('{"status"');
    const end = text.lastIndexOf('}');
    raw = start >= 0 && end > start ? text.slice(start, end + 1) : null;
  }
  if (!raw) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const status = value.status;
  if (status !== 'current' && status !== 'changed' && status !== 'unreachable') return null;
  const summary = str(value.summary, 1000) ?? '';
  const rep = value.replacement && typeof value.replacement === 'object' ? value.replacement as Record<string, unknown> : null;
  const title = rep ? str(rep.title, 200) : null;
  const body = rep ? str(rep.body, 60000) : null;
  const replacement = rep && title && title.length >= 3 && body && body.length >= 10
    ? { title, body, source_url: str(rep.source_url, 2000), source_date: str(rep.source_date, 40) }
    : null;
  // "changed" without a usable replacement cannot be applied: treat as current-with-note for the gateway
  return { status, summary, replacement: status === 'changed' ? replacement : null };
}

async function askClaude(system: string, prompt: string, model: string | null): Promise<string> {
  let output = '';
  const stream = query({
    prompt,
    options: {
      cwd: os.homedir(), maxTurns: 8, model: model ?? 'sonnet', allowedTools: ['WebSearch', 'WebFetch'], tools: ['WebSearch', 'WebFetch'],
      permissionMode: 'bypassPermissions', systemPrompt: system, settingSources: [],
      // an internal one-shot job: no transcript, so it never shows up as a conversation
      persistSession: false,
    },
  });
  for await (const message of stream) {
    const record = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
    if (record.type === 'assistant') for (const block of record.message?.content ?? []) if (block.type === 'text' && block.text) output += block.text;
    if (record.type === 'result' && typeof record.result === 'string') output += `\n${record.result}`;
  }
  return output;
}

async function askCodex(system: string, prompt: string, model: string | null): Promise<string> {
  const codex = new Codex({ config: { developer_instructions: system } as never });
  const thread = codex.startThread({ workingDirectory: os.homedir(), skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'live', ...(model ? { model } : {}) });
  const turn = await thread.run(prompt);
  return turn.finalResponse ?? '';
}

/** Used by aidev-tools.routes.ts (`POST /knowledge-check`). */
export const knowledgeCheckService = {
  async check(input: KnowledgeCheckInput): Promise<KnowledgeCheck & { engine: string }> {
    const system = input.prompt?.trim() || DEFAULT_PROMPT;
    const prompt = buildRequest(input);
    const text = input.engine === 'codex' ? await askCodex(system, prompt, input.model) : await askClaude(system, prompt, input.model);
    const parsed = parseKnowledgeCheck(text);
    console.log(`[aidev-tools] knowledge-check "${clip(input.title, 60)}" via ${input.engine} → ${parsed?.status ?? 'unparsed'}`);
    if (!parsed) throw new Error(`검증 결과를 읽지 못했습니다: ${clip(text.replace(/\s+/g, ' ').trim(), 200)}`);
    return { ...parsed, engine: input.engine };
  },
};
