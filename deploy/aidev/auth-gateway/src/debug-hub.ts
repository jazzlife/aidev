import type { Duplex } from 'node:stream';
import type { openStore } from './store.js';
import { DapConnection, DapError, type DapMessage } from './dap-client.js';
import { RpcError } from './runner-hub.js';

/**
 * Remote debugging (IMPLEMENTATION-PLAN §3.12, F-09). The gateway is the DAP client: the runner starts a
 * debug adapter on the user's PC (`dap.start` → a DAP server on 127.0.0.1:<port>), the gateway reaches
 * it through a tunnel and drives it; the workbench's debug window and the agent's remote_debug_* tools
 * both work on the same session through this hub, so what the agent does is what the user sees.
 *
 * Adapters: js-debug (Node; its real session is a child connection opened on `startDebugging`),
 * debugpy (Python), codelldb (C/C++/Rust/Swift). A session: adapter + program + breakpoints → launch →
 * the program runs until it pauses (breakpoint, step, exception, pause) or ends. While paused the stack,
 * variables and expression evaluation are available; continue/next/stepIn/stepOut move on. Every
 * session is a remote_runs row (kind "debug", ended with the program's exit code).
 * Events (state changes, program output, breakpoint status) carry a sequence number: viewers and agents
 * long-poll them (`events(after, wait)`) or wait for the next pause (`waitForPause`).
 */
type Store = ReturnType<typeof openStore>;
type TargetRow = NonNullable<ReturnType<Store['target']>>;

export const DEBUG_ADAPTERS = ['js-debug', 'debugpy', 'codelldb'] as const;
export type DebugAdapter = typeof DEBUG_ADAPTERS[number];
export type DebugBreakpoint = { path: string; line: number; condition?: string | null };
export type DebugLaunch = {
  adapter: DebugAdapter;
  /** file to run (relative to cwd or absolute, inside the PC's allowed folders); optional with `module` / `runtimeExecutable` */
  program?: string | null;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  breakpoints?: DebugBreakpoint[];
  /** debugpy: run a module instead of a file (`python -m <module>`, e.g. pytest) */
  module?: string | null;
  /** js-debug: run through npm/npx/… instead of node <program> (e.g. npm test) */
  runtimeExecutable?: string | null;
  runtimeArgs?: string[];
};
export type DebugState = 'starting' | 'running' | 'paused' | 'ended' | 'failed';
type DebugEventBody =
  | { type: 'state'; state: DebugState; reason?: string | null; description?: string | null; location?: { path: string | null; line: number; name: string } | null }
  | { type: 'output'; category: string; text: string }
  | { type: 'breakpoints' };
export type DebugEvent = { seq: number; at: number } & DebugEventBody;

/** Runner side the hub needs (runner-hub in production, a stand-in in tests). */
export type DebugRunners = {
  online(targetId: number): boolean;
  requireFeature(targetId: number, feature: string, what: string, min: string): void;
  call<T = unknown>(targetId: number, method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  openTunnel(targetId: number, port: number): Promise<Duplex>;
  onNotification?(fn: (targetId: number, method: string, params: unknown) => void): () => void;
};

type Conn = { dap: DapConnection; name: string; child: boolean; configured: boolean; caps: Record<string, unknown>; bpIds: Map<number, { path: string; index: number }> };
type Frame = { id: number; name: string; path: string | null; line: number; column: number; internal: boolean };
type Variable = { name: string; value: string; type: string | null; ref: number };
type Session = {
  id: string; userId: number; targetId: number; targetName: string; adapter: DebugAdapter; version: string | null;
  runnerId: number | null; port: number | null; program: string | null; cwd: string | null; args: string[]; module: string | null;
  remoteRunId: number; runId: number | null; by: string; origin: 'user' | 'agent'; state: DebugState; error: string | null; exitCode: number | null;
  createdAt: number; endedAt: number | null; conns: Conn[]; active: Conn | null;
  stopped: { conn: Conn; threadId: number; reason: string; description: string | null; text: string | null; at: number; n: number } | null;
  stopCount: number; snapshotCache: { n: number; frames: Frame[]; locals: Variable[]; scope: string | null } | null;
  breakpoints: Map<string, DebugBreakpoint[]>; bpStatus: Map<string, Array<{ line: number; verified: boolean; message: string | null }>>;
  output: string; events: DebugEvent[]; seq: number; waiters: Set<() => void>;
};

const MAX_SESSIONS_PER_USER = 4;
const OUTPUT_KEEP = 64 * 1024;
const EVENTS_KEEP = 400;
const KEEP_ENDED_MS = 30 * 60_000;
const INTERNAL_PATH = /^<node_internals>|[\\/]node_modules[\\/]|^\/usr\/lib\/python|[\\/]lib[\\/]python3\.\d+[\\/]|runpy\.py$/;

const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('~');
/** A path as the PC sees it: relative paths are relative to the session's working folder. */
export function targetPath(cwd: string | null, p: string) {
  if (isAbs(p) || !cwd) return p;
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${p.replace(/^\.[\\/]/, '')}`;
}
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The shell command a debug launch amounts to (what the approval gate assesses and the run history shows). */
export function launchCommand(l: DebugLaunch) {
  const args = (l.args ?? []).map(quote).join(' ');
  if (l.adapter === 'js-debug') return [l.runtimeExecutable ?? 'node', ...(l.runtimeArgs ?? []).map(quote), l.program ? quote(l.program) : '', args].filter(Boolean).join(' ');
  if (l.adapter === 'debugpy') return ['python3', l.module ? `-m ${l.module}` : quote(l.program ?? ''), args].filter(Boolean).join(' ');
  return [quote(l.program ?? ''), args].filter(Boolean).join(' ');
}

/** The adapter's launch request for a checked launch (program/cwd as the runner resolved them). */
export function launchConfig(l: DebugLaunch, program: string | null, cwd: string) {
  const common = { name: 'aidev', request: 'launch', cwd, args: l.args ?? [], env: l.env ?? {}, stopOnEntry: Boolean(l.stopOnEntry) };
  if (l.adapter === 'js-debug') {
    return { ...common, type: 'pwa-node', program: program ?? undefined, runtimeExecutable: l.runtimeExecutable ?? undefined, runtimeArgs: l.runtimeArgs ?? undefined,
      console: 'internalConsole', outputCapture: 'std', skipFiles: ['<node_internals>/**'], sourceMaps: true, autoAttachChildProcesses: true };
  }
  if (l.adapter === 'debugpy') {
    return { ...common, type: 'python', ...(l.module ? { module: l.module } : { program: program ?? undefined }), console: 'internalConsole', redirectOutput: true, justMyCode: true, subProcess: false, showReturnValue: true };
  }
  return { ...common, type: 'lldb', program, terminal: 'console', sourceLanguages: ['cpp', 'c', 'rust', 'swift'] };
}

export function validateLaunch(raw: Record<string, unknown>): DebugLaunch {
  const adapter = String(raw.adapter ?? '') as DebugAdapter;
  if (!DEBUG_ADAPTERS.includes(adapter)) throw new Error(`adapter must be one of ${DEBUG_ADAPTERS.join(', ')}`);
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const strs = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, n).map((x) => x.slice(0, max)) : []);
  const program = str(raw.program, 2000);
  const module = str(raw.module, 200);
  const runtimeExecutable = str(raw.runtimeExecutable, 40);
  if (module && (adapter !== 'debugpy' || !/^[A-Za-z_][\w.]*$/.test(module))) throw new Error('module: a Python module name, debugpy only');
  if (runtimeExecutable && (adapter !== 'js-debug' || !['node', 'npm', 'npx', 'yarn', 'pnpm', 'tsx', 'ts-node'].includes(runtimeExecutable))) throw new Error('runtimeExecutable: node|npm|npx|yarn|pnpm|tsx|ts-node, js-debug only');
  if (!program && !module && !runtimeExecutable) throw new Error('program is required');
  let env: Record<string, string> | undefined;
  if (raw.env !== undefined && raw.env !== null) {
    if (typeof raw.env !== 'object' || Array.isArray(raw.env)) throw new Error('env must be an object');
    const entries = Object.entries(raw.env as Record<string, unknown>);
    if (entries.length > 50 || entries.some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) || typeof v !== 'string' || v.length > 8192)) throw new Error('env: up to 50 NAME=string pairs');
    env = Object.fromEntries(entries) as Record<string, string>;
  }
  const breakpoints = (Array.isArray(raw.breakpoints) ? raw.breakpoints : []).slice(0, 200).map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    const path = str(o.path ?? o.file, 2000); const line = Number(o.line);
    if (!path || !Number.isInteger(line) || line < 1) throw new Error('breakpoints: [{path, line, condition?}]');
    return { path, line, condition: str(o.condition, 500) };
  });
  return { adapter, program, module, runtimeExecutable, args: strs(raw.args, 100, 2000), runtimeArgs: strs(raw.runtimeArgs, 30, 500), cwd: str(raw.cwd, 1000), env, stopOnEntry: raw.stopOnEntry === true, breakpoints };
}

export function createDebugHub(deps: { store: Store; runners: DebugRunners }) {
  const { store, runners } = deps;
  const sessions = new Map<string, Session>();
  let counter = 0;

  function push(s: Session, ev: DebugEventBody) {
    s.seq += 1;
    s.events.push({ ...ev, seq: s.seq, at: Date.now() });
    if (s.events.length > EVENTS_KEEP) s.events.splice(0, s.events.length - EVENTS_KEEP);
    for (const fn of s.waiters) fn();
    s.waiters.clear();
  }
  function setState(s: Session, state: DebugState, extra: { reason?: string | null; description?: string | null; location?: { path: string | null; line: number; name: string } | null } = {}) {
    s.state = state;
    push(s, { type: 'state', state, ...extra });
  }
  function addOutput(s: Session, category: string, text: string) {
    if (!text) return;
    s.output = (s.output + text).slice(-OUTPUT_KEEP);
    push(s, { type: 'output', category, text: text.slice(0, 8000) });
  }

  function sweep() {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.endedAt && s.endedAt + KEEP_ENDED_MS < now) sessions.delete(id);
  }
  const timer = setInterval(sweep, 60_000); timer.unref();

  const unsubscribe = runners.onNotification?.((targetId, method, params) => {
    if (method !== 'dap.exited') return;
    const p = (params ?? {}) as { id?: number; code?: number | null; tail?: string };
    for (const s of sessions.values()) {
      if (s.targetId !== targetId || s.runnerId !== p.id || s.endedAt) continue;
      s.runnerId = null;   // gone already
      if (s.state === 'starting' && p.tail) s.error = `디버그 어댑터가 끝났습니다: ${String(p.tail).slice(-600)}`;
      void end(s, s.state === 'starting' ? 'failed' : 'ended');
    }
  });

  async function end(s: Session, state: 'ended' | 'failed') {
    if (s.endedAt) return;
    s.endedAt = Date.now();
    s.stopped = null;
    for (const c of s.conns) c.dap.close();
    if (s.runnerId !== null) { const id = s.runnerId; s.runnerId = null; void runners.call(s.targetId, 'dap.stop', { id }, 5000).catch(() => undefined); }
    try { store.finishRemoteRun(s.remoteRunId, { exitCode: s.exitCode, artifacts: { debug: true, adapter: s.adapter, error: s.error, output: s.output.slice(-4000) } }); } catch { /* target deleted */ }
    setState(s, state, { reason: s.error });
    console.log(`[debug] ${s.id} target #${s.targetId} ${state}${s.exitCode !== null ? ` (exit ${s.exitCode})` : ''}${s.error ? `: ${s.error}` : ''}`);
  }

  function frameOf(f: Record<string, unknown>): Frame {
    const source = (f.source ?? {}) as { path?: string; name?: string; presentationHint?: string; origin?: string };
    const path = source.path ?? null;
    const internal = !path || INTERNAL_PATH.test(path) || source.presentationHint === 'deemphasize' || f.presentationHint === 'subtle' || f.presentationHint === 'label';
    return { id: Number(f.id), name: String(f.name ?? '?'), path, line: Number(f.line ?? 0), column: Number(f.column ?? 0), internal };
  }
  const varOf = (v: Record<string, unknown>): Variable => ({ name: String(v.name), value: String(v.value ?? '').slice(0, 400), type: typeof v.type === 'string' ? v.type : null, ref: Number(v.variablesReference ?? 0) });

  async function sendBreakpoints(s: Session, c: Conn, path: string) {
    const list = s.breakpoints.get(path) ?? [];
    const r = await c.dap.request<{ breakpoints?: Array<Record<string, unknown>> }>('setBreakpoints', { source: { path }, breakpoints: list.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })), lines: list.map((b) => b.line) });
    const status = (r.breakpoints ?? []).map((b, i) => {
      if (typeof b.id === 'number') c.bpIds.set(b.id, { path, index: i });
      return { line: Number(b.line ?? list[i]?.line ?? 0), verified: b.verified !== false, message: typeof b.message === 'string' ? b.message : null };
    });
    return status;
  }

  /** Breakpoints and exception filters, then configurationDone — once per connection, after its `initialized`. */
  async function configure(s: Session, c: Conn) {
    for (const path of s.breakpoints.keys()) {
      try { const st = await sendBreakpoints(s, c, path); if (c === s.active || !s.bpStatus.has(path)) s.bpStatus.set(path, st); } catch (error) { s.bpStatus.set(path, (s.breakpoints.get(path) ?? []).map((b) => ({ line: b.line, verified: false, message: error instanceof Error ? error.message : String(error) }))); }
    }
    const filters = (Array.isArray(c.caps.exceptionBreakpointFilters) ? c.caps.exceptionBreakpointFilters as Array<{ filter: string; default?: boolean }> : []).filter((f) => f.default || f.filter === 'uncaught').map((f) => f.filter);
    await c.dap.request('setExceptionBreakpoints', { filters }).catch(() => undefined);
    if (c.caps.supportsConfigurationDoneRequest) await c.dap.request('configurationDone');
    c.configured = true;
    push(s, { type: 'breakpoints' });
  }

  function wire(s: Session, c: Conn) {
    c.dap.on('event', (e: DapMessage) => {
      const b = (e.body ?? {}) as Record<string, unknown>;
      switch (e.event) {
        case 'stopped': {
          s.stopCount += 1;
          s.stopped = { conn: c, threadId: Number(b.threadId ?? 0), reason: String(b.reason ?? 'pause'), description: typeof b.description === 'string' ? b.description : null, text: typeof b.text === 'string' ? b.text : null, at: Date.now(), n: s.stopCount };
          s.snapshotCache = null;
          // where it stopped, for the event (and the agent's wait) — best effort
          void c.dap.request<{ stackFrames?: Array<Record<string, unknown>> }>('stackTrace', { threadId: s.stopped.threadId, startFrame: 0, levels: 20 }).then((st) => {
            const frames = (st.stackFrames ?? []).map(frameOf);
            const top = frames.find((f) => !f.internal) ?? frames[0];
            setState(s, 'paused', { reason: String(b.reason ?? 'pause'), description: s.stopped?.description ?? null, location: top ? { path: top.path, line: top.line, name: top.name } : null });
          }, () => setState(s, 'paused', { reason: String(b.reason ?? 'pause') }));
          break;
        }
        case 'continued':
          if (s.stopped && (b.allThreadsContinued !== false || s.stopped.conn === c)) { s.stopped = null; s.snapshotCache = null; if (s.state === 'paused') setState(s, 'running'); }
          break;
        case 'output':
          if (b.category !== 'telemetry' && typeof b.output === 'string') addOutput(s, String(b.category ?? 'console'), b.output);
          break;
        case 'breakpoint': {
          const bp = (b.breakpoint ?? {}) as Record<string, unknown>;
          const ref = typeof bp.id === 'number' ? c.bpIds.get(bp.id) : undefined;
          const list = ref ? s.bpStatus.get(ref.path) : undefined;
          if (ref && list?.[ref.index]) { list[ref.index] = { line: Number(bp.line ?? list[ref.index].line), verified: bp.verified !== false, message: typeof bp.message === 'string' ? bp.message : null }; push(s, { type: 'breakpoints' }); }
          break;
        }
        case 'exited':
          if (typeof b.exitCode === 'number') s.exitCode = b.exitCode;
          break;
        case 'terminated':
          if (!c.child) void end(s, 'ended');
          else {
            s.conns = s.conns.filter((x) => x !== c);
            if (s.active === c) s.active = s.conns.filter((x) => x.child).at(-1) ?? s.conns[0] ?? null;
            if (s.stopped?.conn === c) s.stopped = null;
          }
          break;
        default:
      }
    });
    c.dap.on('reverse', (r: DapMessage, reply: (ok: boolean, body?: Record<string, unknown>, message?: string) => void) => {
      if (r.command === 'startDebugging') {
        reply(true, {});
        const a = (r.arguments ?? {}) as { request?: string; configuration?: Record<string, unknown> };
        void openChild(s, a.request === 'attach' ? 'attach' : 'launch', a.configuration ?? {}).catch((error) => addOutput(s, 'console', `[aidev] 하위 디버그 세션 실패: ${error instanceof Error ? error.message : String(error)}\n`));
      } else reply(false, undefined, `${r.command} is not supported by the platform`);
    });
    c.dap.on('close', () => { if (!c.child && !s.endedAt) void end(s, s.state === 'starting' ? 'failed' : 'ended'); });
  }

  async function connect(s: Session, name: string, child: boolean): Promise<Conn> {
    const stream = await runners.openTunnel(s.targetId, s.port!);
    const c: Conn = { dap: new DapConnection(stream, name), name, child, configured: false, caps: {}, bpIds: new Map() };
    s.conns.push(c);
    wire(s, c);
    c.caps = await c.dap.request('initialize', { clientID: 'aidev', clientName: 'Nado AI Dev', adapterID: s.adapter, pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsStartDebuggingRequest: true, supportsRunInTerminalRequest: false, locale: 'ko' }, 20_000);
    return c;
  }

  /** initialize → launch/attach (answered only after configurationDone by some adapters) ∥ initialized → configure. */
  async function launchOn(s: Session, c: Conn, request: 'launch' | 'attach', config: Record<string, unknown>) {
    const initialized = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new DapError('initialized', '디버그 어댑터가 30초 안에 준비되지 않았습니다')), 30_000);
      t.unref();
      c.dap.on('event', (e: DapMessage) => { if (e.event === 'initialized') { clearTimeout(t); resolve(); } });
      c.dap.on('close', (why: string) => { clearTimeout(t); reject(new DapError('initialized', why)); });
    });
    initialized.catch(() => undefined);   // the race below reports the first failure; a later one must not go unhandled
    const launched = c.dap.request(request, config, 120_000);
    launched.catch(() => undefined);
    await Promise.race([initialized, launched.then(() => initialized)]);
    await configure(s, c);
    await launched;
  }

  async function openChild(s: Session, request: 'launch' | 'attach', configuration: Record<string, unknown>) {
    if (s.endedAt) return;
    const c = await connect(s, `${s.id}/child${s.conns.length}`, true);
    s.active = c;
    await launchOn(s, c, request, configuration);
  }

  function own(userId: number, id: string) {
    const s = sessions.get(id);
    if (!s || s.userId !== userId) throw Object.assign(new Error('디버그 세션이 없습니다(끝났거나 다른 사용자의 세션)'), { status: 404 });
    return s;
  }
  function paused(s: Session) {
    if (!s.stopped) throw Object.assign(new Error(s.endedAt ? '디버그 세션이 끝났습니다' : '프로그램이 멈춰 있지 않습니다 (중단점에 멈췄을 때만 가능)'), { status: 409 });
    return s.stopped;
  }

  function view(s: Session) {
    return {
      id: s.id, targetId: s.targetId, targetName: s.targetName, adapter: s.adapter, version: s.version, state: s.state, error: s.error, exitCode: s.exitCode,
      program: s.program, module: s.module, cwd: s.cwd, args: s.args, by: s.by, origin: s.origin, remoteRunId: s.remoteRunId, runId: s.runId, createdAt: s.createdAt, endedAt: s.endedAt,
      stopped: s.stopped ? { reason: s.stopped.reason, description: s.stopped.description, threadId: s.stopped.threadId, at: s.stopped.at } : null,
      breakpoints: [...s.breakpoints.entries()].flatMap(([path, list]) => list.map((b, i) => ({ path, line: b.line, condition: b.condition ?? null, verified: s.bpStatus.get(path)?.[i]?.verified ?? null, message: s.bpStatus.get(path)?.[i]?.message ?? null }))),
      seq: s.seq,
    };
  }

  /** Frames of the paused thread and the variables of its top user frame (cached per pause). */
  async function pausedDetail(s: Session) {
    const st = s.stopped;
    if (!st) return null;
    if (s.snapshotCache?.n === st.n) return s.snapshotCache;
    const r = await st.conn.dap.request<{ stackFrames?: Array<Record<string, unknown>> }>('stackTrace', { threadId: st.threadId, startFrame: 0, levels: 30 });
    const frames = (r.stackFrames ?? []).map(frameOf);
    const top = frames.find((f) => !f.internal) ?? frames[0];
    let locals: Variable[] = []; let scope: string | null = null;
    if (top) {
      const sc = await st.conn.dap.request<{ scopes?: Array<Record<string, unknown>> }>('scopes', { frameId: top.id }).catch(() => ({ scopes: [] as Array<Record<string, unknown>> }));
      const first = (sc.scopes ?? []).find((x) => !/global|static|register/i.test(String(x.name))) ?? sc.scopes?.[0];
      if (first && Number(first.variablesReference)) {
        scope = String(first.name);
        const v = await st.conn.dap.request<{ variables?: Array<Record<string, unknown>> }>('variables', { variablesReference: Number(first.variablesReference) }).catch(() => ({ variables: [] as Array<Record<string, unknown>> }));
        locals = (v.variables ?? []).filter((x) => !/^(special variables|function variables|class variables)$/.test(String(x.name))).slice(0, 60).map(varOf);
      }
    }
    if (s.stopped?.n === st.n) s.snapshotCache = { n: st.n, frames, locals, scope };
    return { n: st.n, frames, locals, scope };
  }

  const hub = {
    /** Starts a debug session on a target (the caller has checked the user/agent may run it). */
    async start(userId: number, target: TargetRow, launch: DebugLaunch, meta: { by: string; origin?: 'user' | 'agent'; runId?: number | null; risk?: number | null }) {
      if (!runners.online(target.id)) throw new RpcError(-32010, `대상 ${target.name}이(가) 오프라인입니다`);
      runners.requireFeature(target.id, 'dap', '원격 디버깅', '0.8.0');
      sweep();
      if ([...sessions.values()].filter((x) => x.userId === userId && !x.endedAt).length >= MAX_SESSIONS_PER_USER) throw new RpcError(-32005, `디버그 세션은 동시에 ${MAX_SESSIONS_PER_USER}개까지입니다 — 끝난 세션을 정리하세요`);
      const cmd = `debug(${launch.adapter}) ${launchCommand(launch)}`;
      const remoteRunId = store.addRemoteRun({ runId: meta.runId ?? null, targetId: target.id, userId, kind: 'debug', cmd, cwd: launch.cwd ?? null, risk: meta.risk ?? null, approvedBy: meta.by });
      counter += 1;
      const s: Session = {
        id: `dbg${Date.now().toString(36)}${counter}`, userId, targetId: target.id, targetName: target.name, adapter: launch.adapter, version: null,
        runnerId: null, port: null, program: launch.program ?? null, cwd: launch.cwd ?? null, args: launch.args ?? [], module: launch.module ?? null,
        remoteRunId, runId: meta.runId ?? null, by: meta.by, origin: meta.origin ?? 'user', state: 'starting', error: null, exitCode: null, createdAt: Date.now(), endedAt: null,
        conns: [], active: null, stopped: null, stopCount: 0, snapshotCache: null, breakpoints: new Map(), bpStatus: new Map(), output: '', events: [], seq: 0, waiters: new Set(),
      };
      sessions.set(s.id, s);
      console.log(`[debug] ${s.id} target #${target.id} by ${meta.by}: ${cmd.slice(0, 160)}`);
      try {
        const r = await runners.call<{ id: number; port: number; version: string; cwd: string; program: string | null }>(target.id, 'dap.start', { adapter: launch.adapter, cwd: launch.cwd ?? undefined, program: launch.module || launch.runtimeExecutable ? undefined : launch.program ?? undefined }, 240_000);
        s.runnerId = r.id; s.port = r.port; s.version = r.version; s.cwd = r.cwd; if (r.program) s.program = r.program;
        for (const b of launch.breakpoints ?? []) {
          const p = targetPath(s.cwd, b.path);
          const list = s.breakpoints.get(p) ?? [];
          if (!list.some((x) => x.line === b.line)) list.push({ path: p, line: b.line, condition: b.condition ?? null });
          s.breakpoints.set(p, list);
        }
        const root = await connect(s, `${s.id}/root`, false);
        s.active = root;
        const config = launchConfig(launch, launch.module || launch.runtimeExecutable ? (launch.program ? targetPath(s.cwd, launch.program) : null) : s.program, s.cwd!);
        await launchOn(s, root, 'launch', config);
        if (s.state === 'starting') setState(s, 'running');
      } catch (error) {
        s.error = error instanceof Error ? error.message : String(error);
        await end(s, 'failed');
      }
      return hub.snapshot(userId, s.id);
    },

    list(userId: number) { sweep(); return [...sessions.values()].filter((s) => s.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map(view); },
    get(userId: number, id: string) { return view(own(userId, id)); },

    /** Session + (when paused) frames, top-frame variables and the output tail — what the agent reads after each step. */
    async snapshot(userId: number, id: string) {
      const s = own(userId, id);
      let detail: Awaited<ReturnType<typeof pausedDetail>> = null; let detailError: string | null = null;
      try { detail = await pausedDetail(s); } catch (error) { detailError = error instanceof Error ? error.message : String(error); }
      return {
        ...view(s),
        frames: detail?.frames ?? [], locals: detail?.locals ?? [], localsScope: detail?.scope ?? null, detailError,
        output: s.output.slice(-6000),
      };
    },

    events(userId: number, id: string, after: number, waitMs: number): Promise<{ events: DebugEvent[]; next: number; state: DebugState }> {
      const s = own(userId, id);
      const take = () => ({ events: s.events.filter((e) => e.seq > after), next: s.seq, state: s.state });
      if (s.seq > after || s.endedAt || waitMs <= 0) return Promise.resolve(take());
      return new Promise((resolve) => {
        const done = () => { clearTimeout(t); s.waiters.delete(done); resolve(take()); };
        const t = setTimeout(done, waitMs);
        s.waiters.add(done);
      });
    },

    /** Resolves once the program is paused or the session ended (or `timeoutMs` passed). */
    async waitForPause(userId: number, id: string, timeoutMs: number) {
      const s = own(userId, id);
      const deadline = Date.now() + timeoutMs;
      let after = s.seq;
      const settled = () => s.state === 'paused' || s.state === 'ended' || s.state === 'failed';
      while (!settled() && Date.now() < deadline) {
        const r = await hub.events(userId, id, after, Math.min(deadline - Date.now(), 25_000));
        after = r.next;
      }
      return settled();
    },

    async control(userId: number, id: string, action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') {
      const s = own(userId, id);
      if (s.endedAt) throw Object.assign(new Error('디버그 세션이 끝났습니다'), { status: 409 });
      if (action === 'pause') {
        if (s.stopped) return view(s);
        const c = s.active ?? s.conns[0];
        const th = await c.dap.request<{ threads?: Array<{ id: number }> }>('threads');
        await c.dap.request('pause', { threadId: th.threads?.[0]?.id ?? 0 });
        return view(s);
      }
      const st = paused(s);
      s.stopped = null; s.snapshotCache = null;
      setState(s, 'running');
      try { await st.conn.dap.request(action, { threadId: st.threadId }); } catch (error) { if (!s.stopped && !s.endedAt) { s.stopped = st; setState(s, 'paused', { reason: st.reason }); } throw error; }
      return view(s);
    },

    async setBreakpoints(userId: number, id: string, path: string, lines: Array<{ line: number; condition?: string | null }>) {
      const s = own(userId, id);
      const p = targetPath(s.cwd, path);
      const list = lines.filter((l) => Number.isInteger(l.line) && l.line > 0).slice(0, 100).map((l) => ({ path: p, line: l.line, condition: l.condition ?? null }));
      if (list.length) s.breakpoints.set(p, list); else s.breakpoints.delete(p);
      let status: Array<{ line: number; verified: boolean; message: string | null }> = list.map((b) => ({ line: b.line, verified: false, message: null }));
      for (const c of s.conns.filter((x) => x.configured && !x.dap.closed)) {
        try { const st = await sendBreakpoints(s, c, p); if (c === s.active || c === s.conns.at(-1)) status = st; } catch (error) { status = list.map((b) => ({ line: b.line, verified: false, message: error instanceof Error ? error.message : String(error) })); }
      }
      if (list.length) s.bpStatus.set(p, status); else s.bpStatus.delete(p);
      push(s, { type: 'breakpoints' });
      return view(s).breakpoints.filter((b) => b.path === p);
    },

    async evaluate(userId: number, id: string, expression: string, frameId?: number | null) {
      const s = own(userId, id);
      if (s.endedAt) throw Object.assign(new Error('디버그 세션이 끝났습니다'), { status: 409 });
      const c = s.stopped?.conn ?? s.active ?? s.conns[0];
      const frame = frameId ?? (s.stopped ? (await pausedDetail(s))?.frames.find((f) => !f.internal)?.id ?? null : null);
      // codelldb's repl context runs LLDB commands; 'watch' evaluates the expression in the program's language
      const r = await c.dap.request<{ result?: string; type?: string; variablesReference?: number }>('evaluate', { expression, ...(frame !== null ? { frameId: frame } : {}), context: s.adapter === 'codelldb' ? 'watch' : 'repl' }, 20_000);
      return { result: String(r.result ?? '').slice(0, 4000), type: r.type ?? null, ref: Number(r.variablesReference ?? 0) };
    },

    async variables(userId: number, id: string, ref: number) {
      const s = own(userId, id);
      const st = paused(s);
      const r = await st.conn.dap.request<{ variables?: Array<Record<string, unknown>> }>('variables', { variablesReference: ref });
      return (r.variables ?? []).slice(0, 200).map(varOf);
    },

    async scopes(userId: number, id: string, frameId: number) {
      const s = own(userId, id);
      const st = paused(s);
      const r = await st.conn.dap.request<{ scopes?: Array<Record<string, unknown>> }>('scopes', { frameId });
      return (r.scopes ?? []).map((x) => ({ name: String(x.name), ref: Number(x.variablesReference ?? 0), expensive: x.expensive === true }));
    },

    async stop(userId: number, id: string) {
      const s = own(userId, id);
      if (s.endedAt) return view(s);
      const root = s.conns.find((c) => !c.child);
      if (root && !root.dap.closed) {
        if (root.caps.supportsTerminateRequest) await root.dap.request('terminate', {}, 5000).catch(() => undefined);
        await root.dap.request('disconnect', { terminateDebuggee: true }, 5000).catch(() => undefined);
      }
      await end(s, 'ended');
      return view(s);
    },

    /** The runner went away: its adapters are gone, so are these sessions. */
    targetOffline(targetId: number) {
      for (const s of sessions.values()) if (s.targetId === targetId && !s.endedAt) { s.error = s.error ?? '원격 PC 연결이 끊겼습니다'; void end(s, 'ended'); }
    },
    count() { return [...sessions.values()].filter((s) => !s.endedAt).length; },
    close() { clearInterval(timer); unsubscribe?.(); for (const s of sessions.values()) if (!s.endedAt) void end(s, 'ended'); },
  };
  return hub;
}
export type DebugHub = ReturnType<typeof createDebugHub>;
