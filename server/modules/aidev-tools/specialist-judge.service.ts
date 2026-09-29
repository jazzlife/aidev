import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import os from 'node:os';

/**
 * Specialist judge (IMPLEMENTATION-PLAN §3.1 / §3.7): the gateway asks, for every routed command,
 * whether one of the existing agents is a TRUE specialist for it. Laya and the lexical prior rank the
 * catalog relative to each other, so their top pick always "wins" even when nothing fits (Unity shader →
 * testing, Verilog → docs); this small tool-less model turn makes the absolute call:
 *   agent   — an existing specialist whose declared domain covers the command's main technology/domain
 *   generalist — a trivial or domain-less request (a quick question, one shell command, a tiny edit)
 *   null    — no specialist exists → the platform creates one (`new` is the proposed domain)
 * Claude haiku first, Codex mini when Claude is unavailable. Nothing is written into any conversation.
 */
export type JudgeCandidate = { name: string; description: string };
export type JudgeInput = { command: string; candidates: JudgeCandidate[]; project?: string | null };
export type JudgeResult = {
  agent: string | null;
  fit: number;
  reason: string;
  new: { name: string; domain: string; description: string; technologies: string[] } | null;
  engine: string;
  ms: number;
};

const JUDGE_PROMPT = `You route developer commands to specialist AI agents. Decide whether an EXISTING agent is a true specialist for the command.

Rules:
- A true specialist's declared domain explicitly covers the command's MAIN technology or problem domain. Sharing a generic skill (writing code, "tests", "docs", "mobile", "frontend") is NOT enough.
  Not a fit: SwiftUI/iOS → a React agent; Unity shaders → a testing agent; Verilog → a docs agent; Kotlin Android app → a mobile-web/PWA agent when an Android agent exists (pick the Android one); a quant backtest engine → a testing agent; Solidity → a docs agent.
- "generalist" only when the command is trivial or domain-less: a quick factual question, running one or two ready-made shell commands the user spelled out (also on their own/remote machine, e.g. "run sw_vers on my Mac"), a tiny generic edit such as renaming. Do not create a specialist for such requests.
- Otherwise, if no listed agent is a true specialist, answer agent null and propose the specialist that SHOULD exist (kebab-case name, domain, one-line description, key technologies).
- Prefer the narrowest agent whose domain covers the command. Never choose META agents.

Output ONLY this JSON (no prose):
{"agent": "<existing name>" | "generalist" | null, "fit": <0..1 how precisely the chosen agent's domain covers the command>, "reason": "<short>", "new": null | {"name": "<kebab-case>", "domain": "<domain>", "description": "<one line>", "technologies": ["..."]}}`;

export function parseJudge(text: string, names: Set<string>): Omit<JudgeResult, 'engine' | 'ms'> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? /\{[\s\S]*\}/.exec(text)?.[0];
  if (!body) return null;
  try {
    const raw = JSON.parse(body.trim()) as Record<string, unknown>;
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
    return { agent, fit, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : '', new: agent ? null : proposal };
  } catch {
    return null;
  }
}

async function askClaude(prompt: string): Promise<string> {
  let output = '';
  const stream = query({
    prompt,
    options: { cwd: os.homedir(), maxTurns: 1, model: 'haiku', allowedTools: [], tools: [], permissionMode: 'bypassPermissions', systemPrompt: JUDGE_PROMPT, settingSources: [], persistSession: false },
  });
  for await (const message of stream) {
    const record = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
    if (record.type === 'assistant') for (const block of record.message?.content ?? []) if (block.type === 'text' && block.text) output += block.text;
    if (record.type === 'result' && typeof record.result === 'string' && !output) output = record.result;
  }
  return output;
}

async function askCodex(prompt: string): Promise<string> {
  const codex = new Codex({ config: { developer_instructions: JUDGE_PROMPT } as never });
  const thread = codex.startThread({ workingDirectory: os.homedir(), skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', model: 'gpt-5.4-mini' });
  const turn = await thread.run(prompt);
  return turn.finalResponse ?? '';
}

export const specialistJudgeService = {
  async judge(input: JudgeInput): Promise<JudgeResult> {
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
