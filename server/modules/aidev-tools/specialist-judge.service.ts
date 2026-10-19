import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codexSandboxConfig, noteCodexTurnError } from '@/shared/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { sessionsDb } from '@/modules/database/index.js';
import { askCodexJudge, CodexJudgeTurnError } from '@/modules/aidev-tools/codex-judge.client.js';

/**
 * Specialist judge (IMPLEMENTATION-PLAN §3.1 / §3.7): the gateway asks, for every routed command, which existing
 * agent is closest to it and how well its declared domain covers the command (`fit`). Laya and the lexical prior
 * rank the catalog relative to each other, so their top pick always "wins" even when nothing fits (Unity shader →
 * testing, Verilog → docs); this small tool-less model turn scores the fit on an absolute scale:
 *   agent + fit — the closest existing specialist; the gateway uses it unless the fit is too low (routing.ts
 *                 JUDGE_USE_FIT, 0.6 — 2026-10-10: a new agent only when the current ones fit too poorly)
 *   generalist  — a trivial or domain-less request (a quick question, one shell command, a tiny edit)
 *   new         — the specialist that should exist, proposed only when the closest fit is below 0.6
 *   current_fit — inside a chat, how well the chat's current agent carries the command as its next turn; below
 *                 JUDGE_USE_FIT the gateway hands the chat off to the agent that fits (or a new one), and above it moves
 *                 the chat only to an agent that clearly fits better (routing.ts SESSION_SWITCH_MARGIN, 2026-10-13)
 *   level       — the model tier (0–4) that carries the command out comfortably, judged against each tier's reliable
 *                 range; the gateway runs the command at that tier (routing.ts TIER_TABLE). Laya's depth score is the
 *                 fallback only: its 0–4 expectation never left 0.04–2.60 on the server (475 decisions), so D4 was
 *                 unreachable and the strongest models never ran (2026-10-13)
 * It also writes the one question to ask when the command lacks something essential (`question`); the gateway
 * shows it only when Laya's `clarify` says to ask (§3.1), so Laya decides and the model only words it.
 * Claude sonnet first (JUDGE_CLAUDE_MODEL), Codex terra (JUDGE_CODEX_MODEL) when Claude is unavailable or not allowed. Nothing is written into any conversation.
 *
 * Context (2026-10-19): the judge reads the chat a command continues (its goal, the latest requests, the assistant's last
 * report, the agent doing the work) and the project's technology detected from its files, and says first whether the
 * command `continues` that work. With the command and the agents' names alone it matched words: follow-ups went to
 * whichever specialist they resembled ("같은 ap에 wifi로…" → a signage-sync agent) or to the "ongoing work" it imagined,
 * and every rule added for one phrasing missed the next.
 */
export type JudgeCandidate = { name: string; description: string };
export type JudgeInput = { command: string; candidates: JudgeCandidate[];
  /** the agent the command's chat is with (one of the candidates), when the command continues a chat */
  current?: string | null;
  /** the chat the command continues: its transcript and project are read from this runtime's session */
  sessionId?: string | null;
  /** the project a new chat starts in (an existing chat's own project wins) */
  projectPath?: string | null;
  /** the context as already built (tests, replays); loaded from `sessionId`/`projectPath` when absent */
  context?: JudgeChatContext | null;
  /** the engines this account may use (D-05: a Codex-only account never gets a Claude turn); default both */
  engines?: Array<'claude' | 'codex'>;
  /** the command starts a new conversation, the only place a clarifying question is shown (default true) */
  ask?: boolean };
export type JudgeResult = {
  agent: string | null;
  fit: number;
  reason: string;
  new: { name: string; domain: string; description: string; technologies: string[] } | null;
  /** the single clarifying question for this command (its language), or null when nothing essential is missing */
  question: string | null;
  /** how well the chat's current agent (JudgeInput.current) carries the command as its next turn; null without one */
  current_fit: number | null;
  /** the model tier (0–4) that carries the command out comfortably; null when the answer has none */
  level: number | null;
  /** in a chat: the command goes on with the chat's work (the gateway keeps the chat's agent); null for a new chat */
  continues: boolean | null;
  engine: string;
  ms: number;
};

/** What the judge reads besides the command; every part is optional (a new chat has no transcript, a folder no manifest). */
export type JudgeChatContext = {
  /** the chat's first request — what the chat is for */
  goal: string | null;
  /** the requests between the goal and the command, oldest first (the last few) */
  recent: string[];
  /** the assistant's last answer — what the chat is doing now */
  lastReply: string | null;
  /** the project's technology as detected from its manifests */
  stack: string | null;
};

const CONTEXT_REQUESTS = 4;
const clipText = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat; };

/**
 * Pure part (exported for tests): a transcript → the chat as the judge reads it. `asOf` (epoch ms) keeps only what came
 * before it, so a replay sees the chat as it was when the command was sent. Null when there is nothing to read.
 */
export function buildChatContext(messages: NormalizedMessage[], command: string, asOf?: number): Omit<JudgeChatContext, 'stack'> | null {
  const requests: string[] = [];
  let lastReply: string | null = null;
  for (const message of messages) {
    if (asOf && Date.parse(message.timestamp) >= asOf) break;
    if (message.kind !== 'text' || !message.content || message.isCompactSummary || message.isLocalCommand) continue;
    if (message.role === 'user') requests.push(message.content);
    else if (message.role === 'assistant') lastReply = message.content;
  }
  // a command already in the transcript (sent while the judge was asked again) is not one of the requests before it
  if (requests.length && clipText(requests[requests.length - 1], 2000) === clipText(command, 2000)) requests.pop();
  if (!requests.length && !lastReply) return null;
  return { goal: requests[0] ?? null, recent: requests.slice(1).slice(-CONTEXT_REQUESTS), lastReply };
}

const MANIFEST_NAMES = new Set(['package.json', 'pubspec.yaml', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Dockerfile', 'docker-compose.yml', 'compose.yaml']);
const MANIFEST_SKIP = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor', 'venv', 'Pods', 'packages']);
const isManifest = (name: string) => MANIFEST_NAMES.has(name) || /\.(csproj|fsproj|vcxproj)$/i.test(name);

/**
 * Pure part (exported for tests): manifest files (path relative to the project, content) → one line naming the
 * technology per folder, e.g. "dashboard: Node/JS (react, vite, ws); player: .NET net10.0-windows WPF (LibVLCSharp)".
 */
export function stackFromManifests(files: Array<{ path: string; content: string }>): string | null {
  const parts: string[] = [];
  for (const { path: rel, content } of files) {
    const name = path.basename(rel);
    const dir = path.dirname(rel) === '.' ? '' : `${path.dirname(rel)}: `;
    const few = (items: string[], n = 10) => (items.length ? ` (${items.slice(0, n).join(', ')}${items.length > n ? ', …' : ''})` : '');
    if (name === 'package.json') {
      let deps: string[] = [];
      try { const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }; deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter((d) => !d.startsWith('@types/')); } catch { /* not JSON */ }
      parts.push(`${dir}Node/JS${few(deps)}`);
    } else if (/\.(csproj|fsproj)$/i.test(name)) {
      const framework = /<TargetFrameworks?>([^<]+)</i.exec(content)?.[1] ?? '';
      const ui = [/<UseWPF>\s*true/i.test(content) ? 'WPF' : null, /<UseWindowsForms>\s*true/i.test(content) ? 'WinForms' : null, /Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(content) ? 'ASP.NET Core' : null].filter(Boolean).join(' ');
      const packages = [...content.matchAll(/<PackageReference\s+Include="([^"]+)"/gi)].map((m) => m[1]);
      parts.push(`${dir}.NET${framework ? ` ${framework}` : ''}${ui ? ` ${ui}` : ''}${few(packages, 8)}`);
    } else if (name === 'pubspec.yaml') {
      const block = /^dependencies:\s*\n((?:[ \t]+.*\n?)*)/m.exec(content)?.[1] ?? '';
      const deps = [...block.matchAll(/^ {2}([a-z0-9_]+):/gm)].map((m) => m[1]).filter((d) => d !== 'flutter');
      parts.push(`${dir}${/sdk:\s*flutter/.test(content) ? 'Flutter/Dart' : 'Dart'}${few(deps, 8)}`);
    } else if (name.startsWith('build.gradle')) parts.push(`${dir}${/com\.android\.(application|library)/.test(content) ? 'Android (Gradle)' : 'Gradle/JVM'}`);
    else if (name === 'Cargo.toml') parts.push(`${dir}Rust`);
    else if (name === 'go.mod') parts.push(`${dir}Go`);
    else if (name === 'pyproject.toml' || name === 'requirements.txt') parts.push(`${dir}Python`);
    else if (name === 'CMakeLists.txt' || /\.vcxproj$/i.test(name)) parts.push(`${dir}C/C++`);
    else parts.push(`${dir}Docker`);
  }
  const unique = [...new Set(parts)];
  return unique.length ? clipText(unique.join('; '), 700) : null;
}

/** The project's manifests: the folder and three levels below it (a solution's projects sit in src/<Name>/), build output and dependencies skipped. */
function readManifests(root: string): Array<{ path: string; content: string }> {
  const found: Array<{ path: string; content: string }> = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= 40) return;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && isManifest(entry.name)) {
        try { if (fs.statSync(full).size <= 256 * 1024) found.push({ path: path.relative(root, full), content: fs.readFileSync(full, 'utf8') }); } catch { /* unreadable */ }
      } else if (entry.isDirectory() && depth < 3 && !entry.name.startsWith('.') && !MANIFEST_SKIP.has(entry.name)) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

const STACK_TTL_MS = 10 * 60_000;
const stacks = new Map<string, { at: number; stack: string | null }>();
function projectStack(projectPath: string): string | null {
  const known = stacks.get(projectPath);
  if (known && Date.now() - known.at < STACK_TTL_MS) return known.stack;
  const stack = stackFromManifests(readManifests(projectPath));
  stacks.set(projectPath, { at: Date.now(), stack });
  return stack;
}

/** The chat (from this runtime's transcript) and the project's technology for one judge call; never throws. */
async function loadChatContext(input: JudgeInput): Promise<JudgeChatContext | null> {
  let projectPath = input.projectPath ?? null;
  let chat: Omit<JudgeChatContext, 'stack'> | null = null;
  if (input.sessionId) {
    try {
      const session = sessionsDb.getSessionById(input.sessionId);
      projectPath = session?.project_path || projectPath;
      // Lazy: the providers module imports this module's barrel (see lesson-curator.service.ts).
      const { sessionsService } = await import('@/modules/providers/index.js');
      const history = await sessionsService.fetchHistory(input.sessionId, { limit: null, offset: 0 });
      chat = buildChatContext(history.messages, input.command);
    } catch (error) {
      console.warn('[aidev-tools] judge: chat context unavailable:', error instanceof Error ? error.message : error);
    }
  }
  const stack = projectPath ? projectStack(projectPath) : null;
  return chat || stack ? { goal: chat?.goal ?? null, recent: chat?.recent ?? [], lastReply: chat?.lastReply ?? null, stack } : null;
}

/** An agent as the judge sees it: its declared domain, without the keyword list generated agents append (word bait). */
const declaredDomain = (description: string) => clipText(description.replace(/\s*(키워드|Keywords?)\s*:[\s\S]*$/i, ''), 260);

/** Pure part (exported for tests): the judge's prompt for one command. */
export function buildJudgePrompt(input: JudgeInput, context: JudgeChatContext | null): string {
  const candidates = input.candidates.filter((c) => c.name && c.name !== 'generalist').slice(0, 60);
  const names = new Set(candidates.map((c) => c.name));
  const current = input.current && names.has(input.current) ? input.current : null;
  const continuing = input.ask === false;
  const chat = continuing && context && (context.goal || context.recent.length || context.lastReply) ? [
    '<chat>',
    context.goal ? `Goal (the chat's first request): ${clipText(context.goal, 500)}` : null,
    context.recent.length ? `Latest requests (oldest first):\n${context.recent.map((r) => `- ${clipText(r, 240)}`).join('\n')}` : null,
    context.lastReply ? `The assistant's last answer (excerpt): ${clipText(context.lastReply, 800)}` : null,
    `Agent doing the work in this chat: ${current ?? 'the generalist (no specialist)'}`,
    '</chat>',
  ] : [];
  // the catalog first: it is the same for every command of an account, so the prompt's prefix stays the same
  return [
    'Existing agents (name: declared domain):',
    ...candidates.map((c) => `- ${c.name}: ${declaredDomain(c.description)}`),
    '',
    'Classify the developer command below for routing. Do NOT carry it out or answer it — you have no tools and nobody expects its result. Reply with the JSON object only.',
    '',
    ...chat,
    context?.stack ? `Project technology (detected from its files): ${context.stack}` : null,
    `<command>\n${input.command.slice(0, 2000)}\n</command>`,
    continuing ? (chat.length ? 'This command continues the chat above: "question" is null.' : `This command continues a chat whose transcript is not available${current ? '' : ' (the generalist\'s)'}: "question" is null.`) : 'This command starts a new chat: "continues" is false.',
    !chat.length && current ? `Agent doing the work in this chat: ${current}` : null,
  ].filter((line): line is string => line !== null).join('\n');
}

const JUDGE_PROMPT = `You route a developer's command in an AI coding-agent chat to the agent that should carry it out. The question is whether an agent can carry the work out with real expertise — the best result, not the nearest name.

You get the existing agents (name: declared domain), the command, the project's technology as detected from its files and — when the command continues a chat — that chat: its goal, the latest requests, the assistant's last answer and the agent doing the work. Read the command in that context and decide what work it actually asks for, in which technology. Words alone mislead: a short reply, an objection or a question means whatever the chat makes it mean. The project's or the product's name is never evidence of a technology; its files are.

Step 1 — continues (true/false). A new chat: false. In a chat: true when the command goes on with the work the chat is doing — carry on, correct or object to it, answer the assistant, add facts about the situation, ask about what was done or why something happened, test, fix, undo, commit or push it, or refine the same feature in the same technology. false when it asks for work of another kind or in another technology than the chat has been doing (a different component, another part of the stack, a new problem). Without a transcript you cannot see the chat's work: a command with no work of its own continues; a command asking for work in a technology does not, and is judged by that technology.

Step 2 — work: name, in a few words, the technology the work touches (for "SignalR 서버를 다른 걸로 바꿔" in a video player project: "SignalR messaging hub", not "the player"). fit and current_fit are scored against THAT technology, never against what the product is (a player, a dashboard, a signage system).

Step 3 — the agent for the work: for a continuation, the chat's work as it now stands — what the latest requests and the assistant's last answer are about, not the goal (chats drift: a chat begun for a user manual may now be building an installer); otherwise the command's own work.
- agent: the existing specialist whose declared expertise best covers the technology that work touches in this project. null only when no listed agent shares that domain at all.
- fit (0..1) — how expertly that agent can carry the command out: how much of what the work requires lies inside its declared expertise (an agent that would only manage it as a generalist would is not a fit):
  0.9-1.0 its domain is exactly the command's technology.
  0.6-0.8 it covers the command's main technology; the command is a sub-area or a neighbouring tool of it (Node SEA bytecode builds → a binary release/source protection agent).
  0.4-0.5 adjacent: the same platform or tool-chain family, most of its knowledge still applies.
  below 0.4 it shares only a generic skill (writing code, "tests", "docs", "mobile", "frontend"). For example: SwiftUI/iOS → a React agent; Unity shaders → a testing agent; Verilog → a docs agent; Kotlin Android app → a mobile-web/PWA agent; a quant backtest engine → a testing agent; Solidity → a docs agent.
  When two agents cover the command, choose the narrowest one (Kotlin Android → the Android agent, not the mobile-web one).
- "generalist" (fit = how clearly the request is domain-less) only when the command is trivial or domain-less: a quick factual question, running one or two ready-made shell commands the user spelled out (also on their own/remote machine, e.g. "run sw_vers on my Mac", "m4pro에서 npm test 돌려서 결과 알려줘"), a tiny generic edit such as renaming.
- A continuation of a chat the generalist is doing (no specialist named) stays the generalist's: agent "generalist", fit 0.9 — unless the chat's work itself is clearly inside one specialist's declared technology.
- Running commands — locally, on a named PC, or on a remote machine — is something every agent can do through its tools; it is never a specialist domain. Never propose a specialist for command execution, remote machines or reporting command output.
- "generalist" also for work of any size that has no specific technology or problem domain: reading, searching or summarizing many files or logs (e.g. "이 로그 5만 줄에서 오류 패턴 요약", "src 전체를 읽고 구조를 요약"), general code review or explanation. Size alone never makes a specialist.
- new: ONLY when no listed agent has the expertise (fit below 0.6, or agent null) and the command has a concrete technology or problem domain (a language, framework, platform, protocol, hardware or tool chain), propose the specialist with that expertise that SHOULD exist (kebab-case name, domain, one-line description, key technologies). Otherwise null — an agent with the expertise is used, not duplicated.
- Never choose META agents.
- current_fit: REQUIRED (a number) whenever the chat names a specialist doing the work, also when you pick another agent or propose one; null otherwise — how well the agent named as doing the work in this chat (NOT the agent you pick) carries this command, scored like fit against the technology of the work as it now stands (the command and the latest requests): inside its declared technology ≥ 0.8; outside it on the fit scale above, even when the command continues the chat — being the agent of the chat is no expertise (a user-manual agent in a chat that now builds an installer's console menus → 0.2). Every agent commits, pushes, tags and answers questions about its own work, so git chores, working rules, answers to its questions and questions about what it did keep it at 0.8 or more.
- level (0..4): the model tier that carries this command out COMFORTABLY — with capacity to spare, not a model that would barely manage it. What each tier does reliably, and where it starts to fail:
  0 small fast model (Haiku / Luna): a factual answer, a lookup, one or two ready-made shell commands, a one-line edit. Fails once the work needs a plan or several files.
  1 mid model, light reasoning (Sonnet / Terra medium): a well-specified change inside one file, a short procedure in known code, explaining code. Shaky once a cause is unknown or several parts must agree.
  2 mid model, deep reasoning (Sonnet / Terra high): a clearly specified feature or fix across several files of a familiar codebase. Shaky on unknown causes, unfamiliar stacks and design trade-offs.
  3 strong model (Opus / Sol): debugging an unknown or intermittent cause (a CI-only test failure, a leak after hours of uptime), refactoring a cross-cutting concern (swapping the state library, changing how errors are handled everywhere), design, unfamiliar technology, packaging or porting software to other platforms, setting up and wiring one tool chain or environment. Shaky on long autonomous work where early mistakes compound.
  4 strongest model (Fable / Astra): architecture and migrations; long multi-step autonomous work across several tools, services or machines (install, configure and integrate several tools, build a pipeline, automate end to end without check-ins); research-level or high-stakes work where a mistake is expensive.
  Choose the lowest tier whose RELIABLE range clearly contains the command. When the command sits at a tier's upper edge, or it is unclear between two tiers, choose the higher one — a tier that would only barely manage is too low. Anything that names a cause to be found, or a change of approach across a codebase, is never below 3. Destructive or hard-to-undo work (deleting data, rewriting history, production changes) goes one tier up. A follow-up ("진행해", "계속해", a correction) is judged by the chat's work as it now stands, read from the chat.
- question: ONLY when the request says the command starts a new conversation (otherwise null): if information ESSENTIAL to start is missing and cannot be inferred (which file or screen, which project, which target machine, what the expected behavior is), write the ONE most important question to ask, in the command's language, short and concrete. Otherwise null.

Output ONLY this JSON (no prose):
Keep it short — the verdict is awaited before the work starts: "reason" is at most eight words, and "new" is null unless no listed agent has the expertise.
{"work": "<the technology, a few words>", "continues": true | false, "agent": "<existing name>" | "generalist" | null, "fit": <0..1>, "reason": "<at most eight words>", "new": null | {"name": "<kebab-case>", "domain": "<domain>", "description": "<one line>", "technologies": ["..."]}, "question": null | "<one short question>", "current_fit": <0..1 when the chat names a specialist, else null>, "level": <0..4>}`;

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

export function parseJudge(text: string, names: Set<string>, current: string | null = null): Omit<JudgeResult, 'engine' | 'ms'> | null {
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
    // only asked for with a current agent; the closest agent being that agent is its fit, whatever the model wrote
    const currentFit = !current ? null : agent === current ? fit
      : typeof raw.current_fit === 'number' && Number.isFinite(raw.current_fit) ? Math.max(0, Math.min(1, raw.current_fit)) : null;
    const level = typeof raw.level === 'number' && Number.isFinite(raw.level) ? Math.max(0, Math.min(4, Math.round(raw.level))) : null;
    // the proposal is kept next to a low-fit closest agent: the gateway decides by the fit (routing.ts JUDGE_USE_FIT)
    const continues = typeof raw.continues === 'boolean' ? raw.continues : null;
    return { agent, fit, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : '', new: agent === 'generalist' ? null : proposal, question, current_fit: currentFit, level, continues };
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
/**
 * The Claude model of the judge turn (env AIDEV_JUDGE_MODEL). Sonnet since the judge also sets the model tier and the
 * chat handoff (2026-10-13): on the labelled set (auth-gateway data/judge-eval.jsonl, three runs each) haiku placed
 * 0.79–0.93 of the commands at their tier and once kept a git agent on UI work (0.82) and nearly handed off "진행해봐"
 * (0.2); sonnet got every row in every run, at 3.7 s on average (max 6.8 s) against haiku's ~3 s.
 */
const JUDGE_CLAUDE_MODEL = process.env.AIDEV_JUDGE_MODEL || 'sonnet';

/**
 * One judge process, started before its command is known: the CLI boots (~0.6 s measured) while it waits for the
 * prompt it is streamed later. After every judge turn the next one is started, so a send after a typing-time
 * pre-judge finds a booted process; an unused one is stopped after WARM_IDLE_MS (env AIDEV_JUDGE_PREWARM=off: none).
 */
type JudgeProcess = { messages: AsyncIterator<unknown>; send: (prompt: string) => void; abortController: AbortController; idle: NodeJS.Timeout };
const WARM_IDLE_MS = Number(process.env.AIDEV_JUDGE_WARM_IDLE_MS ?? 5 * 60_000);
const PREWARM = process.env.AIDEV_JUDGE_PREWARM !== 'off';
let warmJudge: JudgeProcess | null = null;

/**
 * A judge process. Without `prompt` it boots now and takes its prompt later (streamed input: the warm process); with
 * one it is the plain single-prompt call. Streamed input left a fresh process without a single message once in nine
 * concurrent calls (2026-10-13, local), which the plain call never did in 132 — so only the warm process streams, and
 * an empty answer from it is asked again the plain way.
 */
function startJudgeProcess(fixedPrompt?: string): JudgeProcess {
  let send!: (prompt: string) => void;
  const prompt = new Promise<string>((resolve) => { send = resolve; });
  async function* input() {
    yield { type: 'user' as const, message: { role: 'user' as const, content: await prompt }, parent_tool_use_id: null, session_id: '' };
  }
  const abortController = new AbortController();
  const stream = query({
    prompt: fixedPrompt ?? input(),
    options: {
      cwd: os.homedir(), maxTurns: 1, model: JUDGE_CLAUDE_MODEL, allowedTools: [], tools: [], permissionMode: 'bypassPermissions', systemPrompt: JUDGE_PROMPT,
      settingSources: [], persistSession: false, thinking: { type: 'disabled' }, includePartialMessages: true, abortController,
    },
  });
  const judgeProcess: JudgeProcess = { messages: stream[Symbol.asyncIterator](), send, abortController,
    idle: setTimeout(() => { if (warmJudge === judgeProcess) warmJudge = null; abortController.abort(); }, WARM_IDLE_MS) };
  judgeProcess.idle.unref();
  return judgeProcess;
}

async function askClaude(prompt: string): Promise<string> {
  const warm = warmJudge;
  warmJudge = null;
  if (warm) {
    // a warm process that died while waiting (a CLI update, a sign-out) or streamed nothing: ask the plain way
    const answer = await askClaudeOn(warm, prompt).catch(() => '');
    if (answer) return answer;
    console.warn('[aidev-tools] warm judge process answered nothing; asking on a fresh one');
  }
  return askClaudeOn(startJudgeProcess(prompt), prompt);
}

async function askClaudeOn(judgeProcess: JudgeProcess, prompt: string): Promise<string> {
  let output = '';
  clearTimeout(judgeProcess.idle);
  const { abortController } = judgeProcess;
  const timer = setTimeout(() => abortController.abort(), HARD_TIMEOUT_MS);
  try {
    judgeProcess.send(prompt);
    let streamed = '';
    for (let step = await judgeProcess.messages.next(); !step.done; step = await judgeProcess.messages.next()) {
      const record = step.value as { type?: string; event?: { type?: string; delta?: { text?: string } }; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string };
      if (record.type === 'stream_event' && record.event?.type === 'content_block_delta' && record.event.delta?.text) {
        streamed += record.event.delta.text;
        // the verdict is complete: stop here instead of waiting for any prose the model adds after it
        if (firstCompleteJson(streamed)) { output = streamed; break; }
      }
      if (record.type === 'assistant') for (const block of record.message?.content ?? []) if (block.type === 'text' && block.text) output += block.text;
      if (record.type === 'result') { if (typeof record.result === 'string' && !output) output = record.result; break; }
    }
    return output || streamed;
  } catch (error) {
    if (output) return output;
    throw error;
  } finally {
    clearTimeout(timer);
    abortController.abort();
    // the next verdict starts on a booted process
    if (PREWARM && !warmJudge) warmJudge = startJudgeProcess();
  }
}

/**
 * The Codex model of the judge turn (env AIDEV_JUDGE_CODEX_MODEL): terra, the D1–D2 tier — the judge sets the model tier
 * and the chat handoff, which the D0 luna was not trusted with (user decision 2026-10-13, as sonnet for Claude).
 * gpt-5.4-mini is refused for ChatGPT-account logins (server 2026-10-01).
 */
const JUDGE_CODEX_MODEL = process.env.AIDEV_JUDGE_CODEX_MODEL || 'gpt-5.6-terra';

// Codex is an agent: left alone it searches the web or looks around the folder before answering (server bench:
// median 13 s, up to 45 s). The judge is a lookup — no search, an empty folder, and an explicit "answer only".
const CODEX_JUDGE_RULE = '\n\nAnswer directly from the text above. Do not run commands, read files or search the web.';

/** Codex writes every exec as a rollout the runtime lists as a conversation; side turns are marked subagent so the
 *  session indexer skips them (they appeared as "aidev-judge-…" chats with JSON titles — 2026-10-01). */
const SIDE_TURN_SOURCE = 'subagent';

async function askCodex(prompt: string): Promise<string> {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-judge-'));
  try {
    return await askCodexJudge({ instructions: JUDGE_PROMPT, prompt: `${prompt}${CODEX_JUDGE_RULE}`, model: JUDGE_CODEX_MODEL, cwd: empty,
      config: { ...codexSandboxConfig(), web_search: 'disabled' }, timeoutMs: HARD_TIMEOUT_MS, isComplete: (text) => Boolean(firstCompleteJson(text)) });
  } catch (error) {
    // the turn itself failed (sign-in, usage limit): the SDK path would fail the same way
    if (error instanceof CodexJudgeTurnError) { noteCodexTurnError(error); throw error; }
    console.warn(`[aidev-tools] codex judge app-server failed (${error instanceof Error ? error.message : String(error)}); asking through codex exec`);
    return askCodexExec(prompt);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

/** The SDK path (`codex exec` per verdict): the fallback when the app-server transport fails. */
async function askCodexExec(prompt: string): Promise<string> {
  const codex = new Codex({ config: { ...codexSandboxConfig(), developer_instructions: JUDGE_PROMPT } as never });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-judge-'));
  try {
    const thread = codex.startThread({ threadSource: SIDE_TURN_SOURCE, workingDirectory: empty, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', model: JUDGE_CODEX_MODEL, modelReasoningEffort: 'low', webSearchMode: 'disabled' });
    const turn = await thread.run(`${prompt}${CODEX_JUDGE_RULE}`, { signal: AbortSignal.timeout(HARD_TIMEOUT_MS) }).catch((error: unknown) => { noteCodexTurnError(error); throw error; });
    return turn.finalResponse ?? '';
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

/** The same command against the same catalog is judged once at a time (the typing-time pre-judge and the send share it). */
const inflight = new Map<string, Promise<JudgeResult>>();

export const specialistJudgeService = {
  judge(input: JudgeInput): Promise<JudgeResult> {
    const key = createHash('sha1').update(JSON.stringify([input.command.trim(), input.sessionId ?? null, input.projectPath ?? null, input.candidates.map((c) => [c.name, c.description]), input.engines ?? null, input.current ?? null, input.ask ?? true])).digest('hex');
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
    const current = input.current && names.has(input.current) ? input.current : null;
    const context = input.context !== undefined ? input.context : await loadChatContext(input);
    const prompt = buildJudgePrompt(input, context);
    // in the order the gateway sent (the account's work order), the second when the first fails — only among the
    // engines the account may use; an older gateway sends none: Claude first
    const order = (input.engines?.length ? [...new Set(input.engines)] : ['claude', 'codex'] as const).filter((e): e is 'claude' | 'codex' => e === 'claude' || e === 'codex');
    if (!order.length) throw new Error('no engine available for the judge');
    let engine: string = order[0];
    let text = '';
    const ask = (which: 'claude' | 'codex') => (which === 'claude' ? askClaude(prompt) : askCodex(prompt));
    try {
      text = await ask(order[0]);
    } catch (error) {
      if (order.length < 2) throw error;
      engine = order[1];
      try { text = await ask(order[1]); } catch { throw error; }
    }
    const parsed = parseJudge(text, names, current);
    if (!parsed) throw new Error(`judge answer not understood: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    // whether it continues is asked only of a chat; a new chat never continues
    const result = { ...parsed, continues: input.ask === false ? parsed.continues : null, engine, ms: Date.now() - t0 };
    console.log(`[aidev-tools] judge ${result.ms}ms ${engine}: ${input.command.slice(0, 60)} → ${result.agent ?? '-'} fit=${result.fit} L${result.level ?? '?'}${result.continues ? ' continues' : ''}${current ? ` (chat ${current} ${result.current_fit ?? '?'})` : ''}${context ? ` ctx${context.goal || context.lastReply ? '+chat' : ''}${context.stack ? '+stack' : ''}` : ''}${result.new ? ` NEW ${result.new.name}` : ''} (${result.reason.slice(0, 80)})`);
    return result;
  },
};
