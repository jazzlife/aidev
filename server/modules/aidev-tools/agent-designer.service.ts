import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';

import { sessionsDb } from '@/modules/database/index.js';

/**
 * Background agent design (2026-10-10): a command in an ongoing chat that needs a specialist the catalog lacks is
 * answered by the generalist right away, and the gateway asks for the specialist here — a headless agent-architect
 * turn out of band, no transcript, nothing written into the conversation. Running the architect inside the user's
 * chat did not work: resumed with the whole conversation it answered the user's question instead of designing
 * (server run #219), so the app found no design block. The gateway stores the draft as a new agent.
 */
export type AgentDesignInput = {
  command: string;
  /** the specialist the router says should exist; the architect designs exactly that domain */
  proposal: { name: string; domain: string; description: string; technologies: string[] } | null;
  /** current catalog as `name: routing hint` lines, so the design does not overlap an existing agent */
  catalog: string;
  /** agent-architect definition from the gateway catalog */
  prompt: string;
  tools: string[];
  maxTurns: number;
  engine: 'claude' | 'codex';
  model: string | null;
  /** the chat the command came from: the architect may read that project to fit the agent to its stack */
  sessionId: string | null;
};

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

/** Web research and a few project reads: minutes. The gateway waits a little longer than this. */
const HARD_TIMEOUT_MS = 9 * 60_000;

/**
 * Closes the brackets an LLM left open at the end of a long JSON block (the frontend's parser does the same — D-06:
 * a 3.3 KB design block lacked its final `}`). String-aware; null when the text ends inside a string.
 */
function closeOpenJson(text: string): string | null {
  const open: string[] = [];
  let inString = false; let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') open.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') open.pop();
  }
  if (inString) return null;
  return text.replace(/,\s*$/, '') + open.reverse().join('');
}

/** Reads the architect's `<aidev-agent>` block (same rules as the apps' parseAgentDraft). Exported for tests. */
export function parseAgentDraft(text: string): AgentDraft | null {
  const match = /<aidev-agent>\s*([\s\S]*?)\s*<\/aidev-agent>/.exec(text);
  if (!match) return null;
  const body = match[1].replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  const parse = (json: string | null) => { if (!json) return null; try { return JSON.parse(json) as Record<string, unknown>; } catch { return null; } };
  const raw = parse(body) ?? parse(closeOpenJson(body));
  if (!raw || typeof raw.name !== 'string' || typeof raw.prompt !== 'string') return null;
  const selfCheck = raw.self_check && typeof raw.self_check === 'object' ? raw.self_check as Record<string, unknown> : null;
  return {
    name: raw.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41),
    domain: typeof raw.domain === 'string' ? raw.domain.slice(0, 40) : '',
    hint: typeof raw.hint === 'string' ? raw.hint.slice(0, 60) : '',
    description: typeof raw.description === 'string' ? raw.description.slice(0, 600) : '',
    prompt: raw.prompt,
    tools: Array.isArray(raw.tools) ? raw.tools.map(String) : null,
    examples: Array.isArray(raw.examples) ? raw.examples.filter((e): e is string => typeof e === 'string' && e.trim().length > 3).slice(0, 50) : [],
    knowledge: Array.isArray(raw.knowledge)
      ? raw.knowledge.filter((k): k is Record<string, string> => Boolean(k && typeof k === 'object' && typeof (k as Record<string, unknown>).title === 'string' && typeof (k as Record<string, unknown>).body === 'string'))
        .map((k) => ({ title: k.title, body: k.body, source_url: k.source_url, source_date: k.source_date }))
      : [],
    self_check: selfCheck && typeof selfCheck.task === 'string' ? { task: selfCheck.task, expected: String(selfCheck.expected ?? '') } : null,
  };
}

/** The architect's request: the command is design material only — the generalist is already answering it. Exported for tests. */
export function buildDesignRequest(input: Pick<AgentDesignInput, 'command' | 'proposal' | 'catalog'>): string {
  const proposal = input.proposal;
  return [
    `## 사용자의 명령 (진행 중인 대화의 한 턴 — 범용 agent가 이미 처리 중이다. 설계의 근거로만 쓴다)\n${input.command.slice(0, 4000)}`,
    `## 현재 카탈로그 (name: routing hint)\n${input.catalog}`,
    proposal ? `## 라우터가 판단한 필요한 전문 분야\n- 이름 제안: ${proposal.name}\n- 분야: ${proposal.domain}\n- 설명: ${proposal.description}\n- 핵심 기술: ${proposal.technologies.join(', ')}\n이 분야를 정확히 전문으로 하는 agent를 설계할 것(기존 agent와 겹치지 않게).` : null,
    '원래 명령은 수행하지 않는다. 설계만 하고 <aidev-agent> 블록 하나를 출력한다.',
  ].filter((part): part is string => part !== null).join('\n\n');
}

async function askClaude(input: AgentDesignInput, prompt: string, cwd: string): Promise<string> {
  let output = '';
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), HARD_TIMEOUT_MS);
  try {
    const stream = query({
      prompt,
      options: {
        // `tools` is what limits the turn; `allowedTools` alone only skips the permission prompt
        cwd, maxTurns: input.maxTurns, model: input.model ?? 'opus', allowedTools: input.tools, tools: input.tools, permissionMode: 'bypassPermissions',
        systemPrompt: input.prompt, settingSources: [], persistSession: false, abortController,
      },
    });
    for await (const message of stream) {
      const record = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
      if (record.type === 'assistant') for (const block of record.message?.content ?? []) if (block.type === 'text' && block.text) output += `${block.text}\n`;
      if (record.type === 'result' && typeof record.result === 'string' && !parseAgentDraft(output)) output += `\n${record.result}`;
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/** Side turns are marked subagent so the session indexer does not list them as chats (see knowledge-check.service.ts). */
const SIDE_TURN_SOURCE = 'subagent';

async function askCodex(input: AgentDesignInput, prompt: string, cwd: string): Promise<string> {
  const codex = new Codex({ config: { developer_instructions: input.prompt } as never });
  const thread = codex.startThread({ threadSource: SIDE_TURN_SOURCE, workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'live', modelReasoningEffort: 'high', ...(input.model ? { model: input.model } : {}) });
  const turn = await thread.run(prompt);
  return turn.finalResponse ?? '';
}

/** Used by aidev-tools.routes.ts (`POST /design-agent`), called by the gateway after routing an ongoing chat's command. */
export const agentDesignerService = {
  async design(input: AgentDesignInput): Promise<{ draft: AgentDraft | null; note: string | null; engine: string; model: string | null }> {
    const session = input.sessionId ? sessionsDb.getSessionById(input.sessionId) : null;
    const cwd = session?.project_path || os.homedir();
    const prompt = buildDesignRequest(input);
    const text = input.engine === 'codex' ? await askCodex(input, prompt, cwd) : await askClaude(input, prompt, cwd);
    const draft = parseAgentDraft(text);
    // no block: the architect found the catalog sufficient (its step 1) or ran out of turns — the gateway logs the note
    const note = draft ? null : text.replace(/\s+/g, ' ').trim().slice(0, 300) || '(빈 응답)';
    console.log(`[aidev-tools] design-agent ${input.proposal?.name ?? '-'} via ${input.engine} ${input.model ?? ''}: ${draft ? `draft ${draft.name}` : `no draft — ${note}`}`);
    return { draft, note, engine: input.engine, model: input.model };
  },
};
