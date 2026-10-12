import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

/**
 * The Codex judge on one long-lived `codex app-server` (2026-10-13): the SDK path (`codex exec` per verdict) boots the
 * CLI and a thread every time, 12–28 s per verdict on the server; the app-server is up in ~0.2 s once and each verdict
 * is an ephemeral thread (~5 ms) plus the model turn. Used by specialist-judge.service.ts, which falls back to the SDK
 * path when this transport itself fails (not when the turn does).
 */
type Rpc = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
type Server = { child: ChildProcessWithoutNullStreams; call: (method: string, params: unknown) => Promise<unknown>; listeners: Set<(message: Rpc) => void>; idle: NodeJS.Timeout | null };

/** The app-server stays up this long after its last verdict (env AIDEV_JUDGE_CODEX_IDLE_MS). */
const IDLE_MS = Number(process.env.AIDEV_JUDGE_CODEX_IDLE_MS ?? 10 * 60_000);
const REQUEST_TIMEOUT_MS = 15_000;

/** A failure of the model turn (sign-in, usage limit): the SDK path would fail the same way, so no fallback. */
export class CodexJudgeTurnError extends Error {}

let server: Promise<Server> | null = null;

function start(): Promise<Server> {
  const launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
  const child = spawn(process.execPath, [launcher, 'app-server'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (message: Rpc) => void>();
  const listeners = new Set<(message: Rpc) => void>();
  let nextId = 1;
  let exited: string | null = null;
  const fail = (reason: string) => {
    exited = reason;
    for (const resolve of pending.values()) resolve({ error: { message: reason } });
    pending.clear();
    for (const listener of listeners) listener({ method: 'aidev/exit', params: { reason } });
  };
  child.on('error', (error) => fail(error.message));
  child.on('exit', (code, signal) => fail(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`));
  child.stdin.on('error', (error) => fail(error.message));
  child.stdout.on('error', (error) => fail(error.message));
  child.stderr.on('data', () => undefined);
  child.stderr.on('error', () => undefined);
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Rpc;
    try { message = JSON.parse(line) as Rpc; } catch { return; }
    if (typeof message.id === 'number' && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); return; }
    if (message.method) for (const listener of listeners) listener(message);
  });
  const call = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (exited) { reject(new Error(exited)); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`codex app-server did not answer ${method}`)); }, REQUEST_TIMEOUT_MS);
    pending.set(id, (message) => { clearTimeout(timer); if (message.error) reject(new Error(message.error.message || `${method} failed`)); else resolve(message.result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready: Server = { child, call, listeners, idle: null };
  return call('initialize', { clientInfo: { name: 'aidev-judge', title: 'aidev judge', version: '1' }, capabilities: {} })
    .then(() => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`); return ready; })
    .catch((error: unknown) => { child.kill(); throw error; });
}

function current(): Promise<Server> {
  if (!server) {
    const starting = start();
    server = starting;
    starting.then((s) => s.child.on('exit', () => { if (server === starting) server = null; }), () => { if (server === starting) server = null; });
  }
  return server;
}

/**
 * One verdict: an ephemeral read-only thread with the judge's instructions, a low-effort turn, the answer streamed
 * until `isComplete` says it is whole (the judge stops at the first complete JSON object) or the turn ends.
 */
export async function askCodexJudge(input: { instructions: string; prompt: string; model: string; cwd: string; config: Record<string, unknown>; timeoutMs: number; isComplete: (text: string) => boolean }): Promise<string> {
  const s = await current();
  if (s.idle) clearTimeout(s.idle);
  try {
    const started = await s.call('thread/start', { model: input.model, cwd: input.cwd, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: input.instructions, ephemeral: true, config: input.config, threadSource: 'subagent' }) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    if (!threadId) throw new Error('codex app-server started no thread');
    let text = '';
    let stop = () => undefined as void;
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { s.listeners.delete(listener); reject(new Error('codex judge timed out')); }, input.timeoutMs);
      const finish = (fn: () => void) => { clearTimeout(timer); s.listeners.delete(listener); fn(); };
      function listener(message: Rpc) {
        const params = message.params ?? {};
        if (message.method === 'aidev/exit') { finish(() => reject(new Error(String(params.reason)))); return; }
        if (params.threadId !== threadId) return;
        if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          text += params.delta;
          if (input.isComplete(text)) finish(() => resolve(text));
        } else if (message.method === 'error' && params.willRetry === false) {
          const error = params.error as { message?: string } | undefined;
          finish(() => reject(new CodexJudgeTurnError(error?.message || 'codex judge turn failed')));
        } else if (message.method === 'turn/completed') {
          const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
          if (turn?.status === 'failed') finish(() => reject(new CodexJudgeTurnError(turn.error?.message || 'codex judge turn failed')));
          else finish(() => resolve(text));
        }
      }
      s.listeners.add(listener);
      stop = () => finish(() => undefined);
    });
    // it may settle while turn/start is still pending: handled here, rethrown where it is awaited
    answer.catch(() => undefined);
    try {
      await s.call('turn/start', { threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }], effort: 'low' });
    } catch (error) {
      stop();
      throw error;
    }
    return await answer;
  } finally {
    s.idle = setTimeout(() => s.child.kill(), IDLE_MS);
    s.idle.unref();
  }
}
