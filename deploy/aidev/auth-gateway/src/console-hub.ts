import type { ExecParams, StreamInfo, TargetEvent } from './runner-hub.js';
import type { TargetRow } from './store-aidev.js';
import { assessRules } from './remote-gate.js';

/**
 * Debugger consoles (F-09c): the universal fallback when no DAP adapter fits a program. Any command-line
 * debugger or REPL on the PC — gdb, lldb, cdb/windbg (+SOS for .NET Framework), jdb, pdb, dlv, node inspect,
 * adb shell / lldb-server platforms, openocd telnet, a serial monitor — runs in a pty through the runner's
 * exec stream, and the agent drives it line by line:
 *
 *   start(cmd)  → output up to the first prompt        send(line) → output until the next prompt / quiet
 *   read()      → output since the last read (a running program)       interrupt() → Ctrl-C     stop()
 *
 * "Done" = the last line looks like a prompt ((gdb) (lldb) (Pdb) (dlv) 0:000> main[1] > >>> $ # …, or the
 * session's own `prompt` regex) or the output was quiet for `quietMs`, or the program ended. Output is kept
 * as plain text (ANSI sequences and carriage-return overwrites resolved), 256 KB per session. The stream is
 * an ordinary remote run, so the user watches — and types into — the same console in the remote terminal.
 * Lines that escape to a shell (`shell …`, `!…`, `.shell`, `platform shell`, `system(…)`) are allowed only
 * when that shell command is read/build/test; anything else must go through remote_exec (the approval gate).
 */
export type ConsoleRunners = {
  online(targetId: number): boolean;
  exec(targetId: number, userId: number, p: ExecParams, meta: { approvedBy: string; runId?: number | null; risk?: number | null }): Promise<StreamInfo>;
  control(targetId: number, streamId: number, op: 'write' | 'resize' | 'signal', params: Record<string, unknown>): Promise<unknown>;
  subscribe(targetId: number, fn: (event: TargetEvent) => void): () => void;
  stream(targetId: number, streamId: number): StreamInfo | null;
};
export type ConsoleStart = { cmd: string; cwd?: string | null; env?: Record<string, string>; prompt?: string | null; quietMs?: number };
type Session = {
  id: string; userId: number; targetId: number; targetName: string; streamId: number; remoteRunId: number; cmd: string; cwd: string | null;
  by: string; origin: 'user' | 'agent'; createdAt: number; endedAt: number | null; exitCode: number | null;
  text: string; dropped: number; readPos: number; lastOutputAt: number; prompt: RegExp | null; quietMs: number;
  waiters: Set<() => void>; unsubscribe: () => void; line: string;
};

const KEEP = 256 * 1024;
const KEEP_ENDED_MS = 30 * 60_000;
const MAX_SESSIONS_PER_USER = 6;
/** Prompts of common debuggers and REPLs, matched against the last line. */
export const DEFAULT_PROMPT = /(?:\((?:gdb|lldb|Pdb|pdb|dlv|jdb|rr|udb)\)|\(com\)|\d+:\d+(?::[\w-]+)?>|\w[\w$.-]*\[\d+\]|>>>|debug>|ipdb>|mdb>|PS [^>]*>|\((?:y or n|y\/n|yes\/no)\)|\[[yY]\/[nN]\]|[?:]\s*\[[^\]]*\]|[$#%>])\s?$/;

/** Terminal bytes → plain text: ANSI/OSC sequences removed, `\r` overwrites applied, backspaces applied. */
export function plain(text: string, carry = ''): { text: string; carry: string } {
  const s = (carry + text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]|\x1b[=>78DEHMc]/g, '');
  // an escape sequence cut at the chunk end waits for the next chunk
  const cut = s.search(/\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[()])?$/);
  const body = cut >= 0 ? s.slice(0, cut) : s;
  const out = body.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const parts = line.split('\r');
    let l = parts.length > 1 ? parts.filter((p, i) => p || i === parts.length - 1).at(-1) ?? '' : line;
    while (l.includes('\x08')) l = l.replace(/[^\x08]\x08|^\x08/, '');
    return l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }).join('\n');
  return { text: out, carry: cut >= 0 ? s.slice(cut) : '' };
}

/** A console line that runs a shell command: the command, or null. */
export function shellEscape(line: string): string | null {
  const t = line.trim();
  const m = /^(?:(?:shell|platform\s+shell|\.shell|\.system|sh|system)(?:\s+|$)|!!?)(.*)$/i.exec(t)
    ?? /^(?:call|print|p|expr|expression|eval|evaluate)\b.*\b(?:system|popen|exec[lv]p?e?|posix_spawn|ShellExecute|CreateProcess|Runtime\.getRuntime\(\)\.exec|os\.system|subprocess\.\w+|child_process)\s*\(\s*["'`]?([^"'`)]*)/i.exec(t)
    ?? /^(?:python|script|py)\b.*\b(?:os\.system|subprocess\.\w+|os\.popen|os\.exec\w*)\s*\(\s*\[?["']([^"']*)/i.exec(t);
  if (!m) return null;
  return (m[1] ?? '').trim() || '(셸)';
}

export function createConsoleHub(deps: { runners: ConsoleRunners }) {
  const { runners } = deps;
  const sessions = new Map<string, Session>();
  let counter = 0;

  function wake(s: Session) { for (const fn of [...s.waiters]) fn(); }
  function append(s: Session, chunk: string) {
    const p = plain(chunk, s.line);
    s.line = p.carry;
    if (!p.text) return;
    s.text += p.text;
    s.lastOutputAt = Date.now();
    if (s.text.length > KEEP) { const cut = s.text.length - KEEP; s.text = s.text.slice(cut); s.dropped += cut; }
    wake(s);
  }
  function finish(s: Session, code: number | null) {
    if (s.endedAt) return;
    s.endedAt = Date.now(); s.exitCode = code;
    s.unsubscribe();
    wake(s);
  }
  function sweep() {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.endedAt && s.endedAt + KEEP_ENDED_MS < now) sessions.delete(id);
  }
  const timer = setInterval(sweep, 60_000); timer.unref();

  const abs = (s: Session) => s.dropped + s.text.length;
  const since = (s: Session, pos: number) => s.text.slice(Math.max(pos - s.dropped, 0));
  const lastLine = (s: Session) => { const t = s.text.replace(/\n+$/, (m) => (m.length > 1 ? '\n' : m)); return t.slice(t.lastIndexOf('\n') + 1); };
  const atPrompt = (s: Session) => { const l = lastLine(s); return Boolean(l) && (s.prompt ?? DEFAULT_PROMPT).test(l); };

  /** Resolves when the console waits for input (prompt + a short settle), was quiet for quietMs, ended, or at the deadline. */
  function settle(s: Session, from: number, waitMs: number, quietMs: number): Promise<'prompt' | 'quiet' | 'ended' | 'timeout'> {
    const deadline = Date.now() + waitMs;
    return new Promise((resolve) => {
      let t: NodeJS.Timeout | null = null;
      const done = (why: 'prompt' | 'quiet' | 'ended' | 'timeout') => { if (t) clearTimeout(t); s.waiters.delete(check); resolve(why); };
      const check = () => {
        if (t) clearTimeout(t);
        if (s.endedAt) return done('ended');
        const now = Date.now();
        if (now >= deadline) return done('timeout');
        const got = abs(s) > from;
        const idle = now - s.lastOutputAt;
        if (got && atPrompt(s) && idle >= 150) return done('prompt');
        if (got && idle >= quietMs) return done('quiet');
        t = setTimeout(check, Math.min(Math.max(got && atPrompt(s) ? 150 - idle : quietMs - (got ? idle : 0), 20), deadline - now));
      };
      s.waiters.add(check);
      check();
    });
  }

  function own(userId: number, id: string) {
    const s = sessions.get(id);
    if (!s || s.userId !== userId) throw Object.assign(new Error('콘솔 세션이 없습니다(끝났거나 다른 사용자의 세션)'), { status: 404 });
    return s;
  }
  const view = (s: Session) => ({
    id: s.id, targetId: s.targetId, targetName: s.targetName, streamId: s.streamId, remoteRunId: s.remoteRunId, cmd: s.cmd, cwd: s.cwd, by: s.by, origin: s.origin,
    state: s.endedAt ? 'ended' as const : 'running' as const, exitCode: s.exitCode, createdAt: s.createdAt, endedAt: s.endedAt, atPrompt: !s.endedAt && atPrompt(s),
  });

  const hub = {
    /** Starts the debugger/REPL in a pty on the target and returns what it printed up to its first prompt. */
    async start(userId: number, target: TargetRow, c: ConsoleStart, meta: { by: string; origin?: 'user' | 'agent'; runId?: number | null; risk?: number | null; waitMs?: number }) {
      if (!runners.online(target.id)) throw Object.assign(new Error(`대상 ${target.name}이(가) 오프라인입니다`), { status: 409 });
      if ([...sessions.values()].filter((x) => x.userId === userId && !x.endedAt).length >= MAX_SESSIONS_PER_USER) throw Object.assign(new Error(`콘솔은 동시에 ${MAX_SESSIONS_PER_USER}개까지입니다 — 끝난 콘솔을 정리하세요`), { status: 429 });
      let prompt: RegExp | null = null;
      if (c.prompt) { try { prompt = new RegExp(`(?:${c.prompt})\\s?$`); } catch { throw Object.assign(new Error('prompt: 올바른 정규식이 아닙니다'), { status: 400 }); } }
      const stream = await runners.exec(target.id, userId, { cmd: c.cmd, cwd: c.cwd ?? null, pty: true, cols: 200, rows: 50, env: { TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', ...(c.env ?? {}) }, timeoutSec: 4 * 3600 }, { approvedBy: meta.by, runId: meta.runId ?? null, risk: meta.risk ?? null });
      counter += 1;
      const s: Session = {
        id: `con${Date.now().toString(36)}${counter}`, userId, targetId: target.id, targetName: target.name, streamId: stream.streamId, remoteRunId: stream.remoteRunId, cmd: c.cmd, cwd: stream.cwd,
        by: meta.by, origin: meta.origin ?? 'user', createdAt: Date.now(), endedAt: null, exitCode: null, text: '', dropped: 0, readPos: 0, lastOutputAt: Date.now(),
        prompt, quietMs: Math.min(Math.max(c.quietMs ?? 2500, 300), 30_000), waiters: new Set(), line: '', unsubscribe: () => {},
      };
      s.unsubscribe = runners.subscribe(target.id, (e) => {
        if (e.type === 'data' && e.streamId === s.streamId) append(s, e.chunk.toString('utf8'));
        else if (e.type === 'exit' && e.stream.streamId === s.streamId) finish(s, e.stream.code);
        else if (e.type === 'offline') append(s, '\n[aidev] 대상 PC 연결이 끊겼습니다 — 다시 연결되면 콘솔이 이어집니다\n');
      });
      sessions.set(s.id, s);
      console.log(`[console] ${s.id} target #${target.id} by ${meta.by}: ${c.cmd.slice(0, 160)}`);
      const why = await settle(s, 0, meta.waitMs ?? 30_000, s.quietMs);
      s.readPos = abs(s);
      return { ...view(s), output: since(s, 0), waited: why };
    },

    /** Types one line (or raw keys) and returns the console's answer. */
    async send(userId: number, id: string, input: string, opts: { raw?: boolean; waitMs?: number; quietMs?: number } = {}) {
      const s = own(userId, id);
      if (s.endedAt) throw Object.assign(new Error(`콘솔이 끝났습니다 (exit ${s.exitCode ?? '?'})`), { status: 409 });
      const lines = opts.raw ? [] : input.split(/\r?\n/);
      for (const line of lines) {
        const sh = shellEscape(line);
        if (sh && !assessRules(sh).safe) throw Object.assign(new Error(`콘솔에서 셸 명령(${sh.slice(0, 80)})은 읽기·빌드·테스트만 됩니다 — 그 명령은 remote_exec로 실행하세요(승인 절차를 거칩니다)`), { status: 403 });
      }
      const from = abs(s);
      const data = opts.raw ? input : `${input.replace(/\r?\n/g, '\r')}\r`;
      await runners.control(s.targetId, s.streamId, 'write', { data });
      const why = await settle(s, from, opts.waitMs ?? 30_000, opts.quietMs ?? s.quietMs);
      let out = since(s, from);
      // the pty echoes what was typed: drop that first line
      if (!opts.raw) { const first = input.split(/\r?\n/)[0]!.trim(); const nl = out.indexOf('\n'); if (nl >= 0 && first && out.slice(0, nl).trim().endsWith(first)) out = out.slice(nl + 1); }
      s.readPos = abs(s);
      return { ...view(s), output: out, waited: why };
    },

    /** Output since the last read/send (waits up to waitMs for something new, then until prompt/quiet). */
    async read(userId: number, id: string, waitMs = 0) {
      const s = own(userId, id);
      const from = s.readPos;
      if (waitMs && abs(s) === from && !s.endedAt) await settle(s, from, waitMs, s.quietMs);
      s.readPos = abs(s);
      return { ...view(s), output: since(s, from) };
    },

    /** Ctrl-C (stops a running program inside the debugger, or the debugger's current command). */
    async interrupt(userId: number, id: string, waitMs = 5000) {
      const s = own(userId, id);
      if (s.endedAt) return { ...view(s), output: '' };
      const from = abs(s);
      await runners.control(s.targetId, s.streamId, 'write', { data: '\x03' });
      const why = await settle(s, from, waitMs, 1000);
      s.readPos = abs(s);
      return { ...view(s), output: since(s, from), waited: why };
    },

    async stop(userId: number, id: string) {
      const s = own(userId, id);
      if (!s.endedAt) {
        try { await runners.control(s.targetId, s.streamId, 'signal', { signal: 'kill' }); } catch { /* already gone */ }
        for (let i = 0; i < 30 && !s.endedAt; i++) await new Promise((r) => setTimeout(r, 100));
        if (!s.endedAt) finish(s, null);
      }
      return { ...view(s), output: since(s, s.readPos) };
    },

    get(userId: number, id: string) { return view(own(userId, id)); },
    /** The whole kept transcript (for the UI). */
    transcript(userId: number, id: string) { const s = own(userId, id); return { ...view(s), output: s.text, dropped: s.dropped }; },
    list(userId: number) { sweep(); return [...sessions.values()].filter((s) => s.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map(view); },
    close() { clearInterval(timer); for (const s of sessions.values()) s.unsubscribe(); },
  };
  return hub;
}
export type ConsoleHub = ReturnType<typeof createConsoleHub>;
