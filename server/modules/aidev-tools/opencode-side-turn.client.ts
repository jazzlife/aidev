import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { describeOpenCodeError, noteOpenCodeRunError, OPENCODE_SIDE_TURN_TITLE } from '@/shared/index.js';

/**
 * A headless OpenCode turn for the platform's own work — verification, lesson curation, agent design, knowledge
 * checks — the OpenCode counterpart of the Claude `query` and Codex thread calls in those services
 * (PROVIDER-ENGINE-PLAN §3.3, measured on opencode 1.19.0). `opencode run` has no option for a turn without a
 * session, so the turn is titled with OPENCODE_SIDE_TURN_TITLE (the session synchronizer skips that title, so it never
 * shows up as a chat) and its session is deleted when the turn ends.
 */
export type OpenCodeSideTurn = {
  /** What the turn is for ("verify", "curate", …): the session title and the log line. */
  label: string;
  /** The role and rules of the turn; sent ahead of the prompt (OpenCode's own agents keep their system prompt). */
  instructions: string;
  prompt: string;
  cwd: string;
  /** `provider/model`; null = the model OpenCode starts on. */
  model: string | null;
  /** The model's variant (reasoning effort); null = its default. */
  effort: string | null;
  /**
   * 'read': OpenCode's `plan` agent — reads and searches, no edits and no writing commands.
   * 'check': the default agent with every permission, for a turn that runs builds and tests (the verifier; its
   * instructions forbid edits, as on Claude and Codex).
   */
  access: 'read' | 'check';
  timeoutMs: number;
};

/**
 * Ahead of a 'read' turn's message. OpenCode's plan agent adds its own "plan mode / read-only" reminder to the
 * conversation, and a model with little else to go on answered about that reminder instead of the task (a curation
 * turn returned "when the system announces Plan Mode…" as the lesson — 2026-10-13). Limiting a custom agent's
 * permissions instead is refused by OpenCode's free models (403), so the plan agent stays and this says what its
 * reminder is.
 */
const READ_TURN_NOTE = '(실행 환경 안내: 이 턴은 OpenCode의 읽기 전용(plan) 모드에서 실행된다. 시스템이 덧붙이는 Plan Mode·READ-ONLY 안내문은 실행 환경의 제약일 뿐 분석하거나 답할 대상이 아니다. 파일은 수정하지 말고, 아래 지시가 요구하는 출력(블록)은 계획이 아니라 최종 답으로 그대로 출력하라.)';

/** How long the turn's process gets to exit after SIGTERM before it is killed. */
const KILL_AFTER_MS = 5_000;

/** Removes the turn's session from OpenCode's own store; best effort, the title filter covers a failure. */
function deleteSession(sessionId: string, spawnFn: typeof spawn): void {
  try {
    const child = spawnFn('opencode', ['session', 'delete', sessionId], { stdio: 'ignore', env: process.env });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // opencode is gone: nothing lists the session either
  }
}

/**
 * Runs one side turn and returns the assistant's text (every text part, in order). Rejects when OpenCode reports an
 * error (a usage limit or a rejected sign-in is noted for the auth probe, as in a chat run), exits without an answer,
 * or runs past `timeoutMs`. Used by run-verifier, lesson-curator, agent-designer and knowledge-check; `spawnFn` is
 * their tests' stand-in for the CLI.
 */
export function askOpenCodeSideTurn(turn: OpenCodeSideTurn, spawnFn: typeof spawn = spawn): Promise<string> {
  const args = ['run', '--format', 'json', '--dir', turn.cwd, '--title', `${OPENCODE_SIDE_TURN_TITLE} ${turn.label}`];
  if (turn.model) args.push('--model', turn.model);
  if (turn.effort) args.push('--variant', turn.effort);
  args.push(...(turn.access === 'read' ? ['--agent', 'plan'] : ['--auto']));
  return new Promise<string>((resolve, reject) => {
    const child = spawnFn('opencode', args, { cwd: turn.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const texts: string[] = [];
    let sessionId: string | null = null;
    let failure: Error | null = null;
    let stderr = '';
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sessionId) deleteSession(sessionId, spawnFn);
      if (error) reject(error); else resolve(texts.join('\n'));
    };
    const timer = setTimeout(() => {
      failure = new Error(`OpenCode ${turn.label} turn timed out`);
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); finish(failure); }, KILL_AFTER_MS).unref();
    }, turn.timeoutMs);
    child.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-2000); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let event: { type?: string; sessionID?: string; part?: { text?: string }; error?: unknown; message?: unknown };
      try { event = JSON.parse(line) as typeof event; } catch { return; }
      if (typeof event.sessionID === 'string') sessionId ??= event.sessionID;
      if (event.type === 'text' && typeof event.part?.text === 'string') texts.push(event.part.text);
      else if (event.type === 'error') {
        const described = describeOpenCodeError(event.error ?? event.message);
        noteOpenCodeRunError(described);
        // a refusal on a usage limit holds for every OpenCode turn until its reset: the drawer shows it and the next
        // side turn passes OpenCode over instead of waiting for the same refusal. Lazy: providers imports this module's
        // barrel (see lesson-curator.service.ts).
        if (described.kind === 'usage_limit') {
          void import('@/modules/providers/index.js').then(({ providerUsageLimitsService }) => providerUsageLimitsService.recordBlock('opencode', { type: described.limitType ?? 'unknown', resetsAt: described.resetsAt ?? null })).catch(() => undefined);
        }
        failure ??= new Error(`OpenCode: ${described.message}`);
      }
    });
    child.on('close', (code) => {
      if (failure) finish(failure);
      else if (!texts.length) finish(new Error(`OpenCode ${turn.label} turn gave no answer (exit ${code ?? 'null'})${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}`));
      else finish(null);
    });
    // the message goes in on stdin: a brief with the agent's prompt is larger than one argument may be
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${turn.access === 'read' ? `${READ_TURN_NOTE}\n\n` : ''}${turn.instructions}\n\n---\n\n${turn.prompt}`);
  });
}
