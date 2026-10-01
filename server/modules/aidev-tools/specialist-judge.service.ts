import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { createHash } from 'node:crypto';
import os from 'node:os';

/**
 * Specialist judge (IMPLEMENTATION-PLAN §3.1 / §3.7): the gateway asks, for every routed command,
 * whether one of the existing agents is a TRUE specialist for it. Laya and the lexical prior rank the
 * catalog relative to each other, so their top pick always "wins" even when nothing fits (Unity shader →
 * testing, Verilog → docs); this small tool-less model turn makes the absolute call:
 *   agent   — an existing specialist whose declared domain covers the command's main technology/domain
 *   generalist — a trivial or domain-less request (a quick question, one shell command, a tiny edit)
 *   null    — no specialist exists → the platform creates one (`new` is the proposed domain)
 * It also writes the one question to ask when the command lacks something essential (`question`); the gateway
 * shows it only when Laya's `clarify` says to ask (§3.1), so Laya decides and the model only words it.
 * Claude haiku first, Codex mini when Claude is unavailable. Nothing is written into any conversation.
 */
export type JudgeCandidate = { name: string; description: string };
export type JudgeInput = { command: string; candidates: JudgeCandidate[]; project?: string | null };
export type JudgeResult = {
  agent: string | null;
  fit: number;
  reason: string;
  new: { name: string; domain: string; description: string; technologies: string[] } | null;
  /** the single clarifying question for this command (its language), or null when nothing essential is missing */
  question: string | null;
  engine: string;
  ms: number;
};

const JUDGE_PROMPT = `You route developer commands to specialist AI agents. Decide whether an EXISTING agent is a true specialist for the command.

Rules:
- A true specialist's declared domain explicitly covers the command's MAIN technology or problem domain. Sharing a generic skill (writing code, "tests", "docs", "mobile", "frontend") is NOT enough.
  Not a fit: SwiftUI/iOS → a React agent; Unity shaders → a testing agent; Verilog → a docs agent; Kotlin Android app → a mobile-web/PWA agent when an Android agent exists (pick the Android one); a quant backtest engine → a testing agent; Solidity → a docs agent.
- "generalist" only when the command is trivial or domain-less: a quick factual question, running one or two ready-made shell commands the user spelled out (also on their own/remote machine, e.g. "run sw_vers on my Mac", "m4pro에서 npm test 돌려서 결과 알려줘"), a tiny generic edit such as renaming. Do not create a specialist for such requests.
- Running commands — locally, on a named PC, or on a remote machine — is something every agent can do through its tools; it is never a specialist domain. Never propose a specialist for command execution, remote machines or reporting command output.
- Otherwise, if no listed agent is a true specialist, answer agent null and propose the specialist that SHOULD exist (kebab-case name, domain, one-line description, key technologies).
- Prefer the narrowest agent whose domain covers the command. Never choose META agents.
- question: if information ESSENTIAL to start is missing and cannot be inferred (which file or screen, which project, which target machine, what the expected behavior is), write the ONE most important question to ask, in the command's language, short and concrete. Otherwise null.

Output ONLY this JSON (no prose):
{"agent": "<existing name>" | "generalist" | null, "fit": <0..1 how precisely the chosen agent's domain covers the command>, "reason": "<short>", "new": null | {"name": "<kebab-case>", "domain": "<domain>", "description": "<one line>", "technologies": ["..."]}, "question": null | "<one short question>"}`;

/** The first balanced `{…}` in `text` once it is complete and parses (strings and escapes respected), else null. */
export function firstCompleteJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inString = false; let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { const value = JSON.parse(text.slice(start, i + 1)) as unknown; return value && typeof value === 'object' ? value as Record<string, unknown> : null; } catch { return null; }
      }
    }
  }
  return null;
}

export function parseJudge(text: string, names: Set<string>): Omit<JudgeResult, 'engine' | 'ms'> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? /\{[\s\S]*\}/.exec(text)?.[0];
  if (!body) return null;
  try {
    const raw = (firstCompleteJson(body) ?? JSON.parse(body.trim())) as Record<string, unknown>;
    let agent = typeof raw.agent === 'string' ? raw.agent.trim() : null;
    if (agent && agent !== 'generalist' && !names.has(agent)) agent = null;   // an invented name is "none fits"
    const fit = typeof raw.fit === 'number' && Number.isFinite(raw.fit) ? Math.max(0, Math.min(1, raw.fit)) : agent ? 0.7 : 0;
    const n = raw.new && typeof raw.new === 'object' ? raw.new as Record<string, unknown> : null;
    const proposal = n && typeof n.name === 'string' && typeof n.domain === 'string'
      ? {
          name: n.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40),
          domain: String(n.domain).slice(0, 80),
          description: typeof n.description === 'string' ? n.description.slice(0, 300) : '',
          technologies: Array.isArray(n.technologies) ? (n.technologies as unknown[]).map(String).slice(0, 12) : [],
        }
      : null;
    const question = typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim().slice(0, 300) : null;
    return { agent, fit, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : '', new: agent ? null : proposal, question };
  } catch {
    return null;
  }
}

/**
 * Latency (server bench 2026-09-29, 12 specialists, 18 commands): with the CLI's default adaptive thinking the
 * judge took median 7.7 s and up to 74 s (a thinking blow-up) — two of twelve server calls passed the 30 s route
 * timeout. Thinking off + streaming + stopping at the first complete JSON object: median 2.8 s, max 4.1 s, same
 * 18/18 accuracy (the decision is a lookup against declared domains, not a reasoning task).
 */
const HARD_TIMEOUT_MS = 45_000;

async function askClaude(prompt: string): Promise<string> {
  let output = '';
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), HARD_TIMEOUT_MS);
  try {
    const stream = query({
      prompt,
      options: {
        cwd: os.homedir(), maxTurns: 1, model: 'haiku', allowedTools: [], tools: [], permissionMode: 'bypassPermissions', systemPrompt: JUDGE_PROMPT,
        settingSources: [], persistSession: false, thinking: { type: 'disabled' }, includePartialMessages: true, abortController,
      },
    });
    let streamed = '';
    for await (const message of stream) {
      const record = message as { type?: string; event?: { type?: string; delta?: { text?: string } }; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
      if (record.type === 'stream_event' && record.event?.type === 'content_block_delta' && record.event.delta?.text) {
        streamed += record.event.delta.text;
        // the verdict is complete: stop here instead of waiting for any prose the model adds after it
        if (firstCompleteJson(streamed)) { output = streamed; abortController.abort(); break; }
      }
      if (record.type === 'assistant') for (const block of record.message?.content ?? []) if (block.type === 'text' && block.text) output += block.text;
      if (record.type === 'result' && typeof record.result === 'string' && !output) output = record.result;
    }
    return output || streamed;
  } catch (error) {
    if (output) return output;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function askCodex(prompt: string): Promise<string> {
  const codex = new Codex({ config: { developer_instructions: JUDGE_PROMPT } as never });
  const thread = codex.startThread({ workingDirectory: os.homedir(), skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', model: 'gpt-5.4-mini', modelReasoningEffort: 'low' });
  const turn = await thread.run(prompt, { signal: AbortSignal.timeout(HARD_TIMEOUT_MS) });
  return turn.finalResponse ?? '';
}

/** The same command against the same catalog is judged once at a time (the typing-time pre-judge and the send share it). */
const inflight = new Map<string, Promise<JudgeResult>>();

export const specialistJudgeService = {
  judge(input: JudgeInput): Promise<JudgeResult> {
    const key = createHash('sha1').update(JSON.stringify([input.command.trim(), input.project ?? null, input.candidates.map((c) => [c.name, c.description])])).digest('hex');
    const running = inflight.get(key);
    if (running) return running;
    const promise = this.judgeOnce(input).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  },

  async judgeOnce(input: JudgeInput): Promise<JudgeResult> {
    const t0 = Date.now();
    const candidates = input.candidates.filter((c) => c.name && c.name !== 'generalist').slice(0, 60);
    const names = new Set(candidates.map((c) => c.name));
    const prompt = [
      'Classify the developer command below for routing. Do NOT carry it out or answer it — you have no tools and nobody expects its result. Reply with the JSON object only.',
      '',
      `<command>\n${input.command.slice(0, 2000)}\n</command>`,
      input.project ? `Project: ${input.project.slice(0, 200)}` : null,
      '',
      'Existing agents (name: declared domain):',
      ...candidates.map((c) => `- ${c.name}: ${c.description.replace(/\s+/g, ' ').slice(0, 260)}`),
    ].filter((line) => line !== null).join('\n');
    let engine = 'claude';
    let text = '';
    try {
      text = await askClaude(prompt);
    } catch (error) {
      engine = 'codex';
      try { text = await askCodex(prompt); } catch { throw error; }
    }
    const parsed = parseJudge(text, names);
    if (!parsed) throw new Error(`judge answer not understood: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    const result = { ...parsed, engine, ms: Date.now() - t0 };
    console.log(`[aidev-tools] judge ${result.ms}ms ${engine}: ${input.command.slice(0, 60)} → ${result.agent ?? `NEW ${result.new?.name ?? '?'}`} fit=${result.fit} (${result.reason.slice(0, 80)})`);
    return result;
  },
};
