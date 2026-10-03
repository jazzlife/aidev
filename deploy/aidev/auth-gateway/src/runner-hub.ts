import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { WebSocket, type WebSocketServer } from 'ws';

import type { openStore } from './store.js';
import type { TargetRow } from './store-aidev.js';

/**
 * Runner hub (IMPLEMENTATION-PLAN §3.12, F-02): the gateway side of `aidev-runner`.
 *   POST /_runner/pair  {code, hostname, platform, arch, runner, name?} → {token, target_id, name}
 *        The one-time pairing code (10 min) from "원격 대상 → 등록" becomes a 32-byte token; only its
 *        SHA-256 is stored. Pairing again replaces the token and disconnects the old runner (4401).
 *   WS   /_runner/ws  Authorization: Bearer <token>
 *        One socket per target (a new one replaces the old). `runner.hello{capabilities}` marks the
 *        target online; JSON-RPC calls from the platform go out with call(); the runner's replies
 *        resolve them. Ping every 20 s; 45 s without any frame closes the socket.
 * Deleting a target or re-pairing closes its socket with 4401 (the runner stops and asks for pairing).
 * With a CDN-free address (`realtimeOrigin`, F-18) a runner that came in through the CDN gets `runner.realtime {url}`
 * after its hello and reconnects there (0.18.2+; it falls back to its own gateway address by itself).
 *
 * Streams (F-03): exec() allocates a stream id, records a remote_runs row and asks the runner to start
 * the command (`exec.start{…, streamId, tag:"rr:<id>"}`). Output arrives as binary frames
 * `[streamId u32 BE][bytes]` → a 256 KB ring per stream (replayed to late viewers), the log file
 * `<logDir>/<remoteRunId>.log` (≤20 MB) and the target's listeners (browser `/api/aidev/targets/:id/stream`).
 * `exec.exit` finishes the row. After a reconnect `exec.list` reconciles: finished/lost streams close,
 * missed output is fetched with `exec.tail`, and streams started before a gateway restart are adopted by tag.
 *
 * Tunnels (F-06): openTunnel() asks the runner to dial 127.0.0.1/::1:<port> on its PC (`tunnel.open`) and
 * returns a Duplex that carries raw TCP bytes as binary frames in both directions (same id space as
 * streams). The preview proxy speaks HTTP / WebSocket over it. `tunnel.closed` or a lost runner ends it.
 *
 * Screen (F-07/F-07b/F-07c): attachScreen() is the browser side of `/api/aidev/targets/:id/screen`. The unit is
 * one program window on the PC (runner ≥ 0.7, feature "windows"; 0.5/0.6 runners stream a whole display).
 * Viewers with the same options share one runner stream (`screen.start`): H.264 access units encoded inside the
 * runner (OpenH264, decoded with WebCodecs) or JPEG frames, both sent only when the window changes. Frames are
 * `[kind][flags][data]` (see runner screen.rs); the frames since the last keyframe are kept so a late viewer can
 * start decoding at once, and a viewer that falls behind skips to the next keyframe instead of buffering — the
 * gateway asks for one (`screen.key`), since an unchanged window sends nothing. The stream stops 8 s after its
 * last viewer. Remote control: a viewer turns control on ({op:"control", on:true}) — only with the owner's
 * consent on that PC (`consent control on`) and a policy other than deny — then its {op:"input", ev} messages
 * go to the runner as `input.event` notifications (≤ 300/s) with the stream's window added by the gateway, so
 * positions are relative to that window. Every control session is a remote_runs row (kind "control").
 * screenshot() is one `screen.shot`. Screen needs runner ≥ 0.5 (video, input ≥ 0.6) and the owner's consent.
 * P2P (F-18, runner 0.18+, feature "p2p"): a viewer may also take the frames straight from the runner over WebRTC —
 * its offer goes to the runner as `screen.rtc` ({op:"rtc"} → {type:"rtc", answer}); once frames arrive that way it
 * says {op:"p2p", on:true} and gets no more frames here (on:false: back to this path from the next keyframe). While
 * every viewer of a stream is direct, the runner sends its frames nowhere else (`screen.relay {on:false}`).
 * While a viewer has control, the runner knows it for that viewer's stream (`screen.control {streamId, on}`): runners
 * with "p2p-input" (0.18.1+) then also take that viewer's input straight over the channel (`started.p2pInput`). */
type Store = ReturnType<typeof openStore>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Conn = { ws: WebSocket; targetId: number; userId: number; connectedAt: number; lastFrame: number; pending: Map<number, Pending>; nextId: number; hello: boolean; version: string;
  /** came in through the CDN while a CDN-free address exists: the runner is told to move there (F-18) */ moveTo: string | null };

/** Semver-ish compare of runner versions ("0.7.1" > "0.3.0"); unknown versions sort lowest. */
export function compareVersions(a: string, b: string) {
  const p = (v: string) => (/^\d+(\.\d+){0,3}$/.test(v) ? v.split('.').map(Number) : [-1]);
  const x = p(a); const y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const PING_MS = 20_000;
const SILENCE_MS = 45_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_FRAME = 16 * 1024 * 1024;   // JSON-RPC text frames (a sync manifest of a large project is several MB)
const RING_BYTES = 256 * 1024;
const LOG_MAX = 20 * 1024 * 1024;
const KEEP_FINISHED = 20;
const BROWSER_BUFFER_MAX = 8 * 1024 * 1024;

export type StreamInfo = { streamId: number; targetId: number; remoteRunId: number; runId: number | null; cmd: string; cwd: string | null; pty: boolean; by: string | null; pid: number | null; startedAt: number; running: boolean; code: number | null; signal: string | null; durationMs: number | null; bytes: number; lastOutputAt: number | null };
export type TargetEvent =
  | { type: 'data'; streamId: number; chunk: Buffer }
  | { type: 'started'; stream: StreamInfo }
  | { type: 'exit'; stream: StreamInfo }
  | { type: 'online' } | { type: 'offline' };
type Stream = StreamInfo & { userId: number; ring: Buffer[]; ringBytes: number; log: fs.WriteStream | null; logPath: string | null; logBytes: number; finishedAt: number | null;
  /** the runner answered exec.start (or the stream was adopted from its exec.list): reconcile may judge it */
  confirmed: boolean };
export type ExecParams = { cmd: string; cwd?: string | null; pty?: boolean; cols?: number; rows?: number; env?: Record<string, string>; timeoutSec?: number;
  /** text written to the command's input, then closed (runner ≥ 0.9, feature "stdin"; no pty) */ stdin?: string | null;
  /** the shell that runs `cmd` (runner ≥ 0.12, feature "shell"): powershell | pwsh | cmd | bash | sh; default = the login shell / cmd.exe */
  shell?: ExecShell | null };
export const EXEC_SHELLS = ['powershell', 'pwsh', 'cmd', 'bash', 'sh'] as const;
export type ExecShell = typeof EXEC_SHELLS[number];

export const streamFrame = (streamId: number, chunk: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(streamId >>> 0, 0); return Buffer.concat([head, chunk]); };

/** Viewer options for a screen stream, clamped. video: 5-60 fps (default 30), 500-20000 kbps; jpeg: 0.5-10 fps (default 2).
 *  `window`: the program window (id from `screen.list`, runner ≥ 0.7); `display`: whole display (older runners). */
export type ScreenOpts = { mode: 'video' | 'jpeg'; window: number | null; display: number; fps: number; maxWidth: number; bitrate: number; codec: 'h264' | 'vp8'; codecs: string[] };
/** The video codecs a viewer decodes (`codecs=vp9,h264` or a list), known ones only, in a fixed order (F-18). */
const VIEWER_CODECS = ['vp9', 'h264'];
export function screenOpts(q: { mode?: unknown; window?: unknown; display?: unknown; fps?: unknown; maxWidth?: unknown; bitrate?: unknown; codec?: unknown; codecs?: unknown }): ScreenOpts {
  const n = (v: unknown, d: number, lo: number, hi: number) => { const x = v === null || v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d; };
  const mode = q.mode === 'jpeg' ? 'jpeg' : 'video';
  const win = n(q.window, NaN, 0, 0xffff_ffff);
  return {
    mode, window: Number.isFinite(win) ? Math.round(win) : null, display: Math.round(n(q.display, 1, 1, 16)),
    fps: mode === 'video' ? Math.round(n(q.fps, 30, 5, 60)) : n(q.fps, 2, 0.5, 10),
    maxWidth: Math.round(n(q.maxWidth, 1440, 320, 2560)), bitrate: Math.round(n(q.bitrate, 4000, 500, 20000)),
    codec: q.codec === 'vp8' ? 'vp8' : 'h264',
    codecs: (() => { const said = new Set((Array.isArray(q.codecs) ? q.codecs : String(q.codecs ?? '').split(',')).map((c) => String(c).trim())); return VIEWER_CODECS.filter((c) => said.has(c)); })(),
  };
}

export class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }

/** One TCP connection to a server on a runner's loopback, as a stream (http.request createConnection-compatible). */
export class RunnerTunnel extends Duplex {
  constructor(private sendBytes: (chunk: Buffer, done: (error?: Error | null) => void) => void, private onDestroy: () => void) {
    super({ allowHalfOpen: false });
  }
  _read() { /* bytes are pushed as frames arrive */ }
  _write(chunk: Buffer, _enc: BufferEncoding, done: (error?: Error | null) => void) { this.sendBytes(chunk, done); }
  _destroy(error: Error | null, done: (error?: Error | null) => void) { this.onDestroy(); done(error); }
  // net.Socket surface the http client may touch
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}

export function createRunnerHub(store: Store, wss: WebSocketServer, opts: { logDir?: string; realtimeOrigin?: string | null } = {}) {
  const conns = new Map<number, Conn>();
  const dupLogged = new Map<string, number>();   // refused old duplicates, logged once per 10 min
  const attempts = new Map<string, { count: number; until: number }>();
  const streams = new Map<string, Stream>();               // `${targetId}:${streamId}`
  const tunnels = new Map<string, RunnerTunnel>();         // `${targetId}:${streamId}` (F-06)
  /** A viewer of a screen stream. v2 viewers (session.ts with `v=2`) take numbered frames and ack each one they
   *  have shown; older pages get the frames without the number and are acked for when sent. */
  type ScreenViewer = { needKey: boolean; v2: boolean; inFlight: Array<[number, number]>; p2p: boolean };
  type ScreenStream = { targetId: number; streamId: number; config: string; window: number | null; viewers: Map<WebSocket, ScreenViewer>; gop: Buffer[]; gopBytes: number; format: { codec: string; width?: number; height?: number; reason?: string | null } | null; lastAt: number; frames: number; bytes: number; stopTimer: NodeJS.Timeout | null; keyAskedAt: number; acked: number; relay: boolean; loggedAt: number; controllers: number };
  const screens = new Map<string, ScreenStream>();          // `${targetId}:${streamId}` (F-07)
  // F-07d (2026-10-02): a viewer more than a second behind (or with 2 MB unsent) skips to the next keyframe — the
  // runner paces itself to the quickest viewer's acks, so one slow page never holds up the others
  const SCREEN_VIEWER_BUFFER = 2 * 1024 * 1024;
  const SCREEN_VIEWER_LAG_MS = 1000;
  /** A frame as an older page reads it: `[kind][flags][data]`, without the number. */
  const unnumbered = (frame: Buffer) => ((frame[1] & 2) === 2 ? Buffer.concat([Buffer.from([frame[0], frame[1] & ~2]), frame.subarray(6)]) : frame);
  const frameSeq = (frame: Buffer) => ((frame[1] & 2) === 2 && frame.length >= 6 ? frame.readUInt32BE(2) : 0);
  /** The newest frame some viewer has shown → the runner (it paces itself by it). */
  function ackRunner(sc: ScreenStream, seq: number) {
    if (seq <= sc.acked) return;
    sc.acked = seq;
    hub.notifyRunner(sc.targetId, 'screen.ack', { streamId: sc.streamId, seq });
  }
  /** One frame to one viewer, or skip it (behind: wait for the next keyframe). */
  function sendFrame(sc: ScreenStream, v: WebSocket, state: ScreenViewer, frame: Buffer, legacy: () => Buffer) {
    const isKey = (frame[1] & 1) === 1;
    const seq = frameSeq(frame);
    if (state.needKey && !isKey) return;
    const lag = state.inFlight.length ? Date.now() - state.inFlight[0][1] : 0;
    if (v.bufferedAmount > SCREEN_VIEWER_BUFFER || lag > SCREEN_VIEWER_LAG_MS) {
      state.needKey = true; state.inFlight = []; askKey(sc);
      return;
    }
    state.needKey = false;
    if (state.v2) {
      v.send(frame, { binary: true });
      if (seq) { state.inFlight.push([seq, Date.now()]); if (state.inFlight.length > 600) state.inFlight.shift(); }
    } else {
      v.send(legacy(), { binary: true });
      if (seq && v.bufferedAmount < 256 * 1024) ackRunner(sc, seq);   // an older page cannot ack: sent with room to spare counts
    }
  }
  /** The runner sends frames here only while some viewer takes them from here (the others are direct). */
  function relay(sc: ScreenStream) {
    const on = !sc.viewers.size || [...sc.viewers.values()].some((v) => !v.p2p);
    if (on === sc.relay) return;
    sc.relay = on;
    if (!on) { sc.gop = []; sc.gopBytes = 0; }   // frames stop arriving: what is kept would be stale
    hub.notifyRunner(sc.targetId, 'screen.relay', { streamId: sc.streamId, on });
    if (on) askKey(sc);
  }
  const GOP_MAX = 12 * 1024 * 1024;
  const controllers = new Map<number, Set<WebSocket>>();     // targetId → viewers with control on (input errors go to them)
  function stopScreen(sc: ScreenStream, notifyRunner: boolean) {
    if (sc.stopTimer) clearTimeout(sc.stopTimer);
    screens.delete(key(sc.targetId, sc.streamId));
    if (notifyRunner) void hub.call(sc.targetId, 'screen.stop', { streamId: sc.streamId }, 5000).catch(() => {});
  }
  const notificationListeners = new Set<(targetId: number, method: string, params: unknown) => void>();
  const screenCaps = (targetId: number) => { try { return JSON.parse(store.targetById(targetId)?.capabilities ?? '{}') as { runner?: string; features?: string[]; screen?: boolean; control?: boolean }; } catch { return {}; } };
  /** "This runner is too old" with the version that is actually connected: a new build only lands in dist/ —
   *  the running service keeps its old binary until it is replaced (Mac: ops/runner/install.sh). */
  const tooOld = (caps: { runner?: string }, what: string, min: string) =>
    `러너가 ${what}를 지원하지 않습니다 — 지금 연결된 러너는 ${caps.runner ?? '버전 미상'}이고 ${min} 이상이 필요합니다. 새로 빌드한 러너로 실행 중인 러너(서비스)를 교체하세요 (Mac: ops/runner/install.sh)`;
  /** A viewer needs a keyframe (joined late, fell behind): ask the runner, at most every 500 ms per stream. */
  function askKey(sc: ScreenStream) {
    const now = Date.now();
    if (now - sc.keyAskedAt < 500) return;
    sc.keyAskedAt = now;
    if (screenCaps(sc.targetId).features?.includes('windows')) void hub.call(sc.targetId, 'screen.key', { streamId: sc.streamId }, 5000).catch(() => {});
  }
  function screenReady(targetId: number) {
    const caps = screenCaps(targetId);
    if (!caps.features?.includes('screen')) throw new RpcError(-32021, tooOld(caps, '화면 보기', '0.7.0'));
    if (!caps.screen) throw new RpcError(-32030, '이 PC에서 화면 보기가 꺼져 있습니다 — 러너를 0.13.2 이상으로 업데이트하면 첫 실행에서 자동으로 켜집니다 (PC에서 직접 껐다면 `aidev-runner consent screen on`)');
  }
  const listeners = new Map<number, Set<(event: TargetEvent) => void>>();
  const finishListeners = new Set<(stream: StreamInfo, userId: number) => void>();
  let nextStream = crypto.randomInt(1, 0x3fff_ffff);        // runner-chosen ids live in 0x4000_0000+
  const key = (targetId: number, streamId: number) => `${targetId}:${streamId}`;

  function emit(targetId: number, event: TargetEvent) {
    for (const fn of listeners.get(targetId) ?? []) { try { fn(event); } catch { /* a broken listener must not stop the stream */ } }
  }
  const info = (st: Stream): StreamInfo => ({ streamId: st.streamId, targetId: st.targetId, remoteRunId: st.remoteRunId, runId: st.runId, cmd: st.cmd, cwd: st.cwd, pty: st.pty, by: st.by, pid: st.pid, startedAt: st.startedAt, running: st.running, code: st.code, signal: st.signal, durationMs: st.durationMs, bytes: st.bytes, lastOutputAt: st.lastOutputAt });

  function newStream(p: { targetId: number; userId: number; streamId: number; remoteRunId: number; runId?: number | null; cmd: string; cwd: string | null; pty: boolean; by: string | null; startedAt?: number }): Stream {
    const st: Stream = { ...p, runId: p.runId ?? null, lastOutputAt: null, pid: null, startedAt: p.startedAt ?? Date.now(), running: true, code: null, signal: null, durationMs: null, bytes: 0, ring: [], ringBytes: 0, log: null, logPath: null, logBytes: 0, finishedAt: null, confirmed: true };
    streams.set(key(p.targetId, p.streamId), st);
    return st;
  }

  function appendData(st: Stream, chunk: Buffer) {
    if (!chunk.length) return;
    st.bytes += chunk.length; st.lastOutputAt = Date.now();
    st.ring.push(chunk); st.ringBytes += chunk.length;
    while (st.ringBytes > RING_BYTES && st.ring.length > 1) st.ringBytes -= st.ring.shift()!.length;
    if (opts.logDir && st.logBytes < LOG_MAX) {
      if (!st.log) {
        try {
          fs.mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
          st.logPath = path.join(opts.logDir, `${st.remoteRunId}.log`);
          st.log = fs.createWriteStream(st.logPath, { flags: 'a', mode: 0o600 });
          st.log.on('error', () => { st.log = null; st.logBytes = LOG_MAX; });
        } catch { st.logBytes = LOG_MAX; }
      }
      const room = LOG_MAX - st.logBytes;
      st.log?.write(chunk.length > room ? Buffer.concat([chunk.subarray(0, room), Buffer.from('\n[aidev] 로그 20MB 초과 — 이후 출력은 저장하지 않습니다\n')]) : chunk);
      st.logBytes += Math.min(chunk.length, room);
    }
    emit(st.targetId, { type: 'data', streamId: st.streamId, chunk });
  }

  function finishStream(st: Stream, code: number | null, signal: string | null, durationMs: number | null) {
    if (!st.running) return;
    st.running = false; st.code = code; st.signal = signal; st.durationMs = durationMs ?? Date.now() - st.startedAt; st.finishedAt = Date.now();
    try { store.finishRemoteRun(st.remoteRunId, { exitCode: code, artifacts: { log: st.logPath, bytes: st.bytes, signal, duration_ms: st.durationMs } }); } catch { /* target deleted meanwhile */ }
    st.log?.end(); st.log = null;
    emit(st.targetId, { type: 'exit', stream: info(st) });
    console.log(`[runner] target #${st.targetId} run #${st.remoteRunId} ${st.by ?? '?'} exit=${code ?? '-'}${signal ? ` ${signal}` : ''} ${st.bytes}B ${st.durationMs}ms: ${st.cmd.slice(0, 120)}`);
    for (const fn of finishListeners) { try { fn(info(st), st.userId); } catch (error) { console.warn('[runner] finish listener:', error instanceof Error ? error.message : error); } }
    // keep the last few finished streams per target for late viewers; older ones live on in the log file
    const done = [...streams.values()].filter((s) => s.targetId === st.targetId && !s.running).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const old of done.slice(KEEP_FINISHED)) streams.delete(key(old.targetId, old.streamId));
  }

  /** After runner.hello: compare what the runner still has with what the gateway believes. */
  async function reconcile(targetId: number) {
    type Remote = { streamId: number; tag?: string | null; cmd: string; cwd: string; pty: boolean; pid: number | null; startedAt: number; running: boolean; code: number | null; signal: string | null; durationMs: number | null; bytes: number };
    let list: Remote[];
    try { list = ((await hub.call<{ streams: Remote[] }>(targetId, 'exec.list', {}, 10_000)).streams ?? []); }
    catch { return; }   // runner without exec (older build)
    const byId = new Map(list.map((r) => [r.streamId, r]));
    const catchUp = async (st: Stream, remote: Remote) => {
      const missed = remote.bytes - st.bytes;
      if (missed <= 0) return;
      try {
        const tail = await hub.call<{ b64: string }>(targetId, 'exec.tail', { streamId: st.streamId, bytes: Math.min(missed, 65536) }, 10_000);
        if (missed > 65536) appendData(st, Buffer.from(`\r\n[aidev] 연결이 끊긴 동안의 출력 ${missed - 65536}바이트는 생략됨\r\n`));
        appendData(st, Buffer.from(tail.b64, 'base64'));
        st.bytes = Math.max(st.bytes, remote.bytes);
      } catch { /* best effort */ }
    };
    // a command whose exec.start is still on its way is not in that list yet: not lost (CI 2026-10-02 — a command
    // started right as the runner connected was marked lost and its output dropped)
    for (const st of [...streams.values()].filter((s) => s.targetId === targetId && s.running && s.confirmed)) {
      const remote = byId.get(st.streamId);
      if (!remote) { finishStream(st, null, 'lost', null); continue; }
      await catchUp(st, remote);
      if (!remote.running) finishStream(st, remote.code, remote.signal, remote.durationMs);
    }
    // adopt streams started before a gateway restart (tag rr:<remote_runs id>), close rows nobody runs any more
    const unfinished = store.unfinishedRemoteRuns(targetId);
    for (const row of unfinished) {
      if ([...streams.values()].some((s) => s.remoteRunId === row.id)) continue;
      const remote = list.find((r) => r.tag === `rr:${row.id}`);
      if (!remote) { store.finishRemoteRun(row.id, { exitCode: null, artifacts: { lost: true } }); continue; }
      const st = newStream({ targetId, userId: row.user_id, streamId: remote.streamId, remoteRunId: row.id, runId: row.run_id, cmd: row.cmd ?? remote.cmd, cwd: remote.cwd, pty: remote.pty, by: row.approved_by, startedAt: row.started_at });
      st.pid = remote.pid;
      await catchUp(st, remote);
      emit(targetId, { type: 'started', stream: info(st) });
      if (!remote.running) finishStream(st, remote.code, remote.signal, remote.durationMs);
    }
  }

  function setStatus(target: TargetRow, patch: Parameters<Store['updateTarget']>[2]) {
    try { store.updateTarget(target.user_id, target.id, patch); } catch { /* target deleted meanwhile */ }
  }

  function drop(conn: Conn, reason: string) {
    for (const p of conn.pending.values()) { clearTimeout(p.timer); p.reject(new RpcError(-32000, reason)); }
    conn.pending.clear();
    for (const [k, t] of tunnels) if (k.startsWith(`${conn.targetId}:`)) { tunnels.delete(k); t.destroy(new Error(reason)); }
    for (const sc of [...screens.values()]) if (sc.targetId === conn.targetId) {
      for (const v of sc.viewers.keys()) if (v.readyState === WebSocket.OPEN) v.send(JSON.stringify({ type: 'offline' }));
      stopScreen(sc, false);
    }
    if (conns.get(conn.targetId) === conn) {
      conns.delete(conn.targetId);
      const t = store.targetById(conn.targetId);
      if (t) setStatus(t, { status: 'offline', lastSeen: Date.now() });
      emit(conn.targetId, { type: 'offline' });
    }
  }

  /** Closes a target's socket (4401 = token no longer valid: deleted / re-paired). */
  function disconnect(targetId: number, code = 4401, reason = 'revoked') {
    const conn = conns.get(targetId);
    if (!conn) return false;
    try { conn.ws.close(code, reason); } catch { /* already closing */ }
    setTimeout(() => { if (conn.ws.readyState !== WebSocket.CLOSED) conn.ws.terminate(); }, 2000).unref();
    drop(conn, 'runner disconnected');
    return true;
  }

  const hub = {
    /** POST /_runner/pair (no session: the pairing code is the credential). Throws {status,message}. */
    pair(body: Record<string, unknown>, ip: string) {
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
      const entry = attempts.get(ip) ?? { count: 0, until: now + 10 * 60_000 };
      if (++entry.count > 20) throw Object.assign(new Error('Too many pairing attempts; try again later'), { status: 429 });
      attempts.set(ip, entry);
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      if (!/^[A-Z0-9]{6,16}$/.test(code)) throw Object.assign(new Error('invalid pairing code'), { status: 400 });
      const target = store.targetByPairingCode(code);
      if (!target) throw Object.assign(new Error('pairing code not found or expired — issue a new one in 원격 대상'), { status: 404 });
      const token = crypto.randomBytes(32).toString('hex');
      const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
      store.updateTarget(target.user_id, target.id, {
        tokenHash: hashToken(token), pairingCode: null, pairingExpires: null,
        platform: text(body.platform, 20) ?? target.platform, arch: text(body.arch, 20) ?? target.arch,
      });
      disconnect(target.id);   // a runner still holding the old token is cut off
      attempts.delete(ip);
      console.log(`[runner] target #${target.id} ${target.name} paired (${text(body.platform, 20) ?? '?'}/${text(body.arch, 20) ?? '?'} ${text(body.hostname, 80) ?? ''}, runner ${text(body.runner, 20) ?? '?'})`);
      return { token, target_id: target.id, name: target.name };
    },

    /** WS upgrade for /_runner/ws. Returns false when the request is not for the runner endpoint. */
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, pathname: string): boolean {
      if (pathname !== '/_runner/ws') return false;
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const target = /^[0-9a-f]{64}$/.test(token) ? store.targetByTokenHash(hashToken(token)) : undefined;
      // runners are not browsers: a request carrying an Origin header is refused
      if (!target || req.headers.origin) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return true; }
      const version = String(req.headers['x-aidev-runner'] ?? '?').slice(0, 20);
      // two runners with the same token (an old copy left running somewhere) would take the connection from each
      // other forever: a newer runner that is connected keeps it, the older one is refused
      const current = conns.get(target.id);
      if (current && current.ws.readyState === WebSocket.OPEN && compareVersions(current.version, version) > 0) {
        const from = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim().slice(0, 60);
        const k = `${target.id}:${version}:${from}`;
        if ((dupLogged.get(k) ?? 0) < Date.now() - 600_000) { dupLogged.set(k, Date.now()); console.log(`[runner] target #${target.id} ${target.name}: refused an older runner ${version} from ${from} — ${current.version} is connected with the same token (stop the old one)`); }
        socket.end(`HTTP/1.1 409 Conflict\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nnewer runner ${current.version} is connected for this PC; stop this old runner (${version})`);
        return true;
      }
      // runners from 0.18.2 move to the CDN-free address when told (runner.realtime), and fall back by themselves
      const viaHost = String(req.headers.host ?? '').replace(/:\d+$/, '');
      const moveTo = opts.realtimeOrigin && new URL(opts.realtimeOrigin).hostname !== viaHost && compareVersions(version, '0.18.2') >= 0 ? opts.realtimeOrigin : null;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const previous = conns.get(target.id);
        if (previous) { try { previous.ws.close(4000, 'replaced by a new connection'); } catch { /* ignore */ } drop(previous, 'replaced'); }
        const conn: Conn = { ws, targetId: target.id, userId: target.user_id, connectedAt: Date.now(), lastFrame: Date.now(), pending: new Map(), nextId: 1, hello: false, version, moveTo };
        conns.set(target.id, conn);
        setStatus(target, { status: 'online', lastSeen: Date.now() });
        console.log(`[runner] target #${target.id} ${target.name} connected (runner ${version}${previous ? `, replacing ${previous.version}` : ''})`);
        const timer = setInterval(() => {
          if (Date.now() - conn.lastFrame > SILENCE_MS) { ws.terminate(); return; }
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, PING_MS);
        ws.on('pong', () => { conn.lastFrame = Date.now(); });
        ws.on('ping', () => { conn.lastFrame = Date.now(); });
        ws.on('message', (data, binary) => {
          conn.lastFrame = Date.now();
          if (binary) {
            const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
            if (buf.length < 4) return;
            const id = buf.readUInt32BE(0);
            const tunnel = tunnels.get(key(conn.targetId, id));
            if (tunnel) { tunnel.push(buf.subarray(4)); return; }
            const sc = screens.get(key(conn.targetId, id));
            if (sc) {
              const frame = buf.subarray(4);
              const isKey = (frame[1] & 1) === 1;
              sc.lastAt = Date.now(); sc.frames++; sc.bytes += frame.length;
              // frames since the last keyframe, for viewers that join mid-stream
              if (isKey) { sc.gop = [frame]; sc.gopBytes = frame.length; }
              else if (sc.gop.length) { sc.gop.push(frame); sc.gopBytes += frame.length; if (sc.gopBytes > GOP_MAX) { sc.gop = []; sc.gopBytes = 0; } }
              let legacy: Buffer | null = null;
              for (const [v, state] of sc.viewers) {
                if (v.readyState === WebSocket.OPEN && !state.p2p) sendFrame(sc, v, state, frame, () => (legacy ??= unnumbered(frame)));
              }
              return;
            }
            const st = streams.get(key(conn.targetId, id));
            if (st) appendData(st, buf.subarray(4));
            return;
          }
          const raw = String(data);
          if (raw.length > MAX_FRAME) return;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
          if (msg.method === 'runner.hello') {
            const params = (msg.params ?? {}) as { capabilities?: Record<string, unknown> };
            const caps = params.capabilities ?? {};
            conn.hello = true;
            const t = store.targetById(conn.targetId);
            if (t) setStatus(t, {
              capabilities: caps, status: 'online', lastSeen: Date.now(),
              platform: typeof caps.os === 'string' ? caps.os.slice(0, 20) : t.platform, arch: typeof caps.arch === 'string' ? caps.arch.slice(0, 20) : t.arch,
              allowedRoots: Array.isArray(caps.allowed_roots) ? (caps.allowed_roots as unknown[]).map(String).slice(0, 50) : null,
            });
            emit(conn.targetId, { type: 'online' });
            if (conn.moveTo) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.realtime', params: { url: conn.moveTo } }));
            if (Array.isArray(caps.features) && caps.features.includes('exec')) void reconcile(conn.targetId);
            return;
          }
          if (msg.method === 'screen.stats' && msg.params && typeof msg.params === 'object') {
            const p = msg.params as { streamId?: number } & Record<string, unknown>;
            const sc = typeof p.streamId === 'number' ? screens.get(key(conn.targetId, p.streamId)) : undefined;
            if (!sc) return;
            const out = JSON.stringify({ type: 'stats', ...p });
            // what the viewers get, every 10 s in the log: where the time goes on real PCs and networks (F-18)
            if (Date.now() - sc.loggedAt >= 10_000) {
              sc.loggedAt = Date.now();
              const direct = [...sc.viewers.values()].filter((v) => v.p2p).length;
              const n = (k: string) => (typeof p[k] === 'number' ? p[k] : '-');
              console.log(`[screen] target #${conn.targetId} stream ${sc.streamId} ${sc.format?.codec ?? '?'} ${sc.format?.width ?? '?'}x${sc.format?.height ?? '?'} fps ${n('fps')} capture ${n('captureMs')} scale ${n('scaleMs')} encode ${n('encodeMs')} loop ${n('loopMs')} base ${n('baseMs')} skipped ${n('skipped')} kbps ${n('kbps')}/${n('bitrate')} viewers ${sc.viewers.size} direct ${direct}`);
            }
            for (const [v, state] of sc.viewers) if (state.v2 && v.readyState === WebSocket.OPEN) v.send(out);
            return;
          }
          if ((msg.method === 'screen.error' || msg.method === 'screen.format') && msg.params && typeof msg.params === 'object') {
            const p = msg.params as { streamId?: number; error?: string; codec?: string; width?: number; height?: number; reason?: string | null; seq?: number };
            const sc = typeof p.streamId === 'number' ? screens.get(key(conn.targetId, p.streamId)) : undefined;
            if (!sc) return;
            const out = msg.method === 'screen.format'
              ? (sc.format = { codec: String(p.codec ?? 'jpeg'), ...(typeof p.width === 'number' && typeof p.height === 'number' ? { width: p.width, height: p.height } : {}), reason: p.reason ? String(p.reason).slice(0, 600) : null }, { type: 'format', ...sc.format, ...(typeof p.seq === 'number' ? { seq: p.seq } : {}) })
              : { type: 'error', message: String(p.error ?? 'capture failed').slice(0, 500) };
            if (msg.method === 'screen.format') { sc.gop = []; sc.gopBytes = 0; }
            for (const v of sc.viewers.keys()) if (v.readyState === WebSocket.OPEN) v.send(JSON.stringify(out));
            // the runner ended that stream (window closed, capture refused): the next viewer starts a new one
            if (msg.method === 'screen.error') stopScreen(sc, false);
            return;
          }
          if (msg.method === 'input.error' && msg.params && typeof msg.params === 'object') {
            const text = String((msg.params as { error?: string }).error ?? 'input failed').slice(0, 500);
            for (const v of controllers.get(conn.targetId) ?? []) if (v.readyState === WebSocket.OPEN) v.send(JSON.stringify({ type: 'error', message: text }));
            return;
          }
          if (msg.method === 'tunnel.closed' && msg.params && typeof msg.params === 'object') {
            const p = msg.params as { streamId?: number };
            const t = typeof p.streamId === 'number' ? tunnels.get(key(conn.targetId, p.streamId)) : undefined;
            if (t) { tunnels.delete(key(conn.targetId, p.streamId!)); t.push(null); }
            return;
          }
          if (msg.method === 'exec.exit' && msg.params && typeof msg.params === 'object') {
            const p = msg.params as { streamId?: number; code?: number | null; signal?: string | null; durationMs?: number | null };
            const st = typeof p.streamId === 'number' ? streams.get(key(conn.targetId, p.streamId)) : undefined;
            if (st) finishStream(st, typeof p.code === 'number' ? p.code : null, typeof p.signal === 'string' ? p.signal.slice(0, 40) : null, typeof p.durationMs === 'number' ? p.durationMs : null);
            return;
          }
          // other notifications (dap.exited, …) go to the modules that asked for them
          if (typeof msg.method === 'string' && msg.id === undefined) {
            for (const fn of notificationListeners) { try { fn(conn.targetId, msg.method, msg.params); } catch (error) { console.log(`[runner] ${msg.method} listener failed: ${error instanceof Error ? error.message : String(error)}`); } }
            return;
          }
          if (typeof msg.id === 'number' && conn.pending.has(msg.id)) {
            const p = conn.pending.get(msg.id)!; conn.pending.delete(msg.id); clearTimeout(p.timer);
            const err = msg.error as { code?: number; message?: string } | undefined;
            if (err) p.reject(new RpcError(err.code ?? -32000, err.message ?? 'runner error')); else p.resolve(msg.result);
          }
        });
        ws.on('close', (code) => {
          clearInterval(timer);
          drop(conn, 'runner disconnected');
          console.log(`[runner] target #${conn.targetId} disconnected (${code})`);
        });
        ws.on('error', () => ws.terminate());
      });
      return true;
    },

    /** Runner notifications not handled here (F-09 `dap.exited`). */
    onNotification(fn: (targetId: number, method: string, params: unknown) => void) { notificationListeners.add(fn); return () => { notificationListeners.delete(fn); }; },
    /** Throws RpcError(-32021) naming the connected runner version when it lacks `feature`. */
    requireFeature(targetId: number, feature: string, what: string, min: string) {
      const caps = screenCaps(targetId);
      if (!caps.features?.includes(feature)) throw new RpcError(-32021, tooOld(caps, what, min));
    },
    /** JSON-RPC call to a target's runner; rejects with RpcError when offline, on error or timeout. */
    call<T = unknown>(targetId: number, method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
      const conn = conns.get(targetId);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError(-32010, 'target is offline'));
      const id = conn.nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { conn.pending.delete(id); reject(new RpcError(-32011, `runner did not answer ${method} in ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
        conn.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        conn.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
      });
    },

    /** Starts `cmd` on the target and returns its stream (remote_runs row written first, finished on exit). */
    async exec(targetId: number, userId: number, p: ExecParams, meta: { approvedBy: string; runId?: number | null; risk?: number | null }) {
      if (!hub.online(targetId)) throw new RpcError(-32010, 'target is offline');
      const cmd = p.cmd.trim();
      if (p.stdin) hub.requireFeature(targetId, 'stdin', '명령 입력(stdin) 전달', '0.9.0');
      if (p.shell) hub.requireFeature(targetId, 'shell', `셸 선택(${p.shell})`, '0.12.0');
      const remoteRunId = store.addRemoteRun({ runId: meta.runId ?? null, targetId, userId, kind: 'exec', cmd, cwd: p.cwd ?? null, risk: meta.risk ?? null, approvedBy: meta.approvedBy });
      nextStream = nextStream >= 0x3fff_fff0 ? 1 : nextStream + 1;
      const st = newStream({ targetId, userId, streamId: nextStream, remoteRunId, runId: meta.runId ?? null, cmd, cwd: p.cwd ?? null, pty: Boolean(p.pty), by: meta.approvedBy });
      st.confirmed = false;
      try {
        const r = await hub.call<{ streamId: number; pid: number | null; cwd: string }>(targetId, 'exec.start', {
          cmd, cwd: p.cwd || undefined, pty: Boolean(p.pty), cols: p.cols, rows: p.rows, env: p.env, timeoutSec: p.timeoutSec, stdin: p.stdin || undefined, shell: p.shell || undefined, streamId: st.streamId, tag: `rr:${remoteRunId}`,
        }, 20_000);
        st.pid = r.pid ?? null; st.cwd = r.cwd ?? st.cwd; st.confirmed = true;
      } catch (error) {
        streams.delete(key(targetId, st.streamId));
        store.finishRemoteRun(remoteRunId, { exitCode: null, artifacts: { error: error instanceof Error ? error.message : String(error) } });
        console.log(`[runner] target #${targetId} run #${remoteRunId} failed to start (${meta.approvedBy}): ${error instanceof Error ? error.message : String(error)} :: ${cmd.slice(0, 120)}`);
        throw error;
      }
      emit(targetId, { type: 'started', stream: info(st) });
      console.log(`[runner] target #${targetId} run #${remoteRunId} started by ${meta.approvedBy}${meta.runId ? ` (chat run #${meta.runId})` : ''} cwd=${st.cwd ?? '-'}: ${cmd.slice(0, 120)}`);
      return info(st);
    },
    /** TCP to <port> on the target's loopback (F-06 preview). Rejects when offline, the runner is too old or nothing listens. */
    async openTunnel(targetId: number, port: number): Promise<RunnerTunnel> {
      const conn = conns.get(targetId);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) throw new RpcError(-32010, 'target is offline');
      const caps = screenCaps(targetId);
      if (!caps.features?.includes('tunnel')) throw new RpcError(-32021, tooOld(caps, '미리보기', '0.4.0'));
      nextStream = nextStream >= 0x3fff_fff0 ? 1 : nextStream + 1;
      const id = nextStream;
      const k = key(targetId, id);
      const tunnel = new RunnerTunnel(
        (chunk, done) => {
          const c = conns.get(targetId);
          if (!c || c.ws.readyState !== WebSocket.OPEN) return done(new Error('target is offline'));
          c.ws.send(streamFrame(id, chunk), { binary: true }, (error) => done(error ?? null));
        },
        () => { if (tunnels.delete(k)) void hub.call(targetId, 'tunnel.close', { streamId: id }, 5000).catch(() => {}); },
      );
      tunnels.set(k, tunnel);
      try {
        await hub.call(targetId, 'tunnel.open', { streamId: id, port }, 10_000);
      } catch (error) {
        tunnels.delete(k);
        tunnel.destroy();
        throw error;
      }
      return tunnel;
    },
    tunnelCount() { return tunnels.size; },
    /** One screenshot (JPEG, base64) of a program window (id, or first match of `query`, else the focused one;
     *  runner ≥ 0.7) or of a display (older runners). */
    async screenshot(targetId: number, opts: { window?: number; query?: string; display?: number; maxWidth?: number; quality?: number } = {}) {
      if (!hub.online(targetId)) throw new RpcError(-32010, 'target is offline');
      screenReady(targetId);
      return hub.call<{ b64: string; mime: string; width: number; height: number; bytes: number; ms: number; window?: Record<string, unknown> }>(targetId, 'screen.shot', opts, 30_000);
    },
    /** Attached phones, TVs and simulators (F-10, runner ≥ 0.10): adb / sdb / booted iOS simulators. */
    async deviceList(targetId: number) {
      if (!hub.online(targetId)) throw new RpcError(-32010, 'target is offline');
      hub.requireFeature(targetId, 'device', '기기 목록·화면', '0.10.0');
      return hub.call<{ devices: Array<{ tool: string; serial: string; state: string; name: string }>; errors: Record<string, string>; tools: Record<string, boolean> }>(targetId, 'device.list', {}, 30_000);
    },
    /** One screenshot (JPEG, base64) of an attached device; the only usable one when serial is omitted. */
    async deviceShot(targetId: number, opts: { tool?: string; serial?: string; maxWidth?: number; quality?: number } = {}) {
      if (!hub.online(targetId)) throw new RpcError(-32010, 'target is offline');
      hub.requireFeature(targetId, 'device', '기기 목록·화면', '0.10.0');
      return hub.call<{ b64: string; mime: string; width: number; height: number; bytes: number; ms: number; device: { tool: string; serial: string; name: string } }>(targetId, 'device.shot', opts, 60_000);
    },
    /** Program windows (runner ≥ 0.7: {windows}) or displays (older: {displays}). */
    async screenList(targetId: number) {
      if (!hub.online(targetId)) throw new RpcError(-32010, 'target is offline');
      screenReady(targetId);
      const r = await hub.call<{ windows?: Array<Record<string, unknown>>; displays?: Array<Record<string, unknown>> }>(targetId, 'screen.list', {}, 20_000);
      return { windows: r.windows ?? null, displays: r.displays ?? null, perWindow: Array.isArray(r.windows) };
    },
    screenCount() { return screens.size; },
    /** F-06b: listening ports (with their programs) and dev projects in the allowed folders, for the preview pane. */
    async devScan(targetId: number) {
      if (!hub.online(targetId)) throw new RpcError(-32010, '원격 PC가 오프라인입니다');
      const caps = screenCaps(targetId);
      if (!caps.features?.includes('dev')) throw new RpcError(-32021, tooOld(caps, '포트·프로젝트 찾기', '0.7.1'));
      return hub.call<{ ports: Array<{ port: number; pid: number | null; process: string | null; address: string; loopback: boolean }>; projects: Array<Record<string, unknown>> }>(targetId, 'dev.scan', {}, 20_000);
    },
    /** JSON-RPC notification to a runner (no reply): remote-control input. */
    notifyRunner(targetId: number, method: string, params: unknown) {
      const c = conns.get(targetId);
      if (!c || c.ws.readyState !== WebSocket.OPEN) return false;
      c.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
      return true;
    },
    /** Browser side of `/api/aidev/targets/:id/screen` (session and ownership checked by the caller).
     *  client → {op:"config", mode, window, display, fps, maxWidth, bitrate, codec, codecs} | {op:"control", on} | {op:"input", ev}
     *           | {op:"ack", seq} | {op:"rtc", offer} | {op:"p2p", on}
     *  server → {type:"started"|"format"|"control"|"error"|"offline"} + binary frames `[kind][flags][data]` */
    attachScreen(req: IncomingMessage, socket: Duplex, head: Buffer, targetId: number, userId: number, alive: () => boolean, initial: ScreenOpts, proto = 1) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        let current: ScreenStream | null = null;
        let control: { remoteRunId: number; events: number; startedAt: number; perWindow: boolean } | null = null;
        let windowStart = Date.now(); let windowCount = 0;
        const send = (obj: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
        // input over the direct channel: the runner takes it only for the stream a controlling viewer watches
        const controlStream = (sc: ScreenStream | null, on: boolean) => {
          if (!sc) return;
          sc.controllers = Math.max(0, sc.controllers + (on ? 1 : -1));
          hub.notifyRunner(targetId, 'screen.control', { streamId: sc.streamId, on: sc.controllers > 0 });
        };
        const leave = () => {
          const sc = current; current = null;
          if (!sc) return;
          if (control) controlStream(sc, false);
          sc.viewers.delete(ws);
          relay(sc);
          if (!sc.viewers.size && !sc.stopTimer) sc.stopTimer = setTimeout(() => { if (!sc.viewers.size) stopScreen(sc, true); }, 8000);
        };
        const controlOff = () => {
          if (!control) return;
          controlStream(current, false);
          hub.notifyRunner(targetId, 'input.end', {});
          store.finishRemoteRun(control.remoteRunId, { exitCode: 0, artifacts: { events: control.events, durationMs: Date.now() - control.startedAt } });
          control = null;
          controllers.get(targetId)?.delete(ws);
        };
        const join = async (o: ScreenOpts) => {
          leave();
          try {
            if (!hub.online(targetId)) throw new RpcError(-32010, '원격 PC가 오프라인입니다');
            screenReady(targetId);
            const caps = screenCaps(targetId);
            const perWindow = Boolean(caps.features?.includes('windows'));
            if (perWindow && o.window === null) throw new RpcError(-32602, '볼 프로그램 창을 고르세요 (창 목록: GET /api/aidev/targets/:id/windows)');
            const win = perWindow ? o.window : null;
            const mode = o.mode === 'video' && !caps.features?.includes('video') ? 'jpeg' : o.mode;   // runner < 0.6: JPEG only
            const codec = perWindow ? 'h264' : o.codec;   // the runner's own encoder is H.264 (0.6 used ffmpeg: h264/vp8)
            // viewers that decode different codecs get their own stream (the runner picks VP9 only when asked)
            const config = `${mode}|${win ?? `d${o.display}`}|${o.fps}|${o.maxWidth}|${o.bitrate}|${codec}|${o.codecs.join(',')}`;
            let sc = [...screens.values()].find((s) => s.targetId === targetId && s.config === config);
            if (!sc) {
              nextStream = nextStream >= 0x3fff_fff0 ? 1 : nextStream + 1;
              sc = { targetId, streamId: nextStream, config, window: win, viewers: new Map(), gop: [], gopBytes: 0, format: null, lastAt: 0, frames: 0, bytes: 0, stopTimer: null, keyAskedAt: 0, acked: 0, relay: true, loggedAt: 0, controllers: 0 };
              screens.set(key(targetId, sc.streamId), sc);
              // 0.15+ runners number their frames and pace themselves by the acks (F-07d)
              const acks = Boolean(caps.features?.includes('acks'));
              const params = perWindow
                ? { streamId: sc.streamId, mode, window: win, fps: o.fps, maxWidth: o.maxWidth, bitrate: o.bitrate, acks, codecs: o.codecs }
                : { streamId: sc.streamId, mode, display: o.display, fps: o.fps, maxWidth: o.maxWidth, bitrate: o.bitrate, codec };
              try { await hub.call(targetId, 'screen.start', params, 10_000); }
              catch (error) { screens.delete(key(targetId, sc.streamId)); throw error; }
            }
            if (sc.stopTimer) { clearTimeout(sc.stopTimer); sc.stopTimer = null; }
            if (ws.readyState !== WebSocket.OPEN) return;
            // a direct path is worth trying for numbered video (the page acks over it)
            const p2p = mode === 'video' && proto >= 2 && Boolean(caps.features?.includes('p2p') && caps.features.includes('acks'));
            const p2pInput = p2p && Boolean(caps.features?.includes('p2p-input'));
            send({ type: 'started', ...o, window: win, mode, codec, perWindow, control: Boolean(caps.control && caps.features?.includes('input')), streamId: sc.streamId, p2p, p2pInput });
            if (sc.format) send({ type: 'format', ...sc.format });
            const v2 = proto >= 2;
            for (const f of sc.gop) ws.send(v2 ? f : unnumbered(f), { binary: true });
            sc.viewers.set(ws, { needKey: sc.gop.length === 0, v2, inFlight: [], p2p: false });
            relay(sc);
            if (sc.gop.length === 0 && sc.format) askKey(sc);   // a running stream of an unchanged window sends nothing on its own
            current = sc;
            if (control) controlStream(sc, true);
          } catch (error) {
            send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
          }
        };
        void join(initial);
        const timer = setInterval(() => { if (!alive()) ws.close(1008, 'Session expired'); else if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 5000);
        ws.on('message', (data, binary) => {
          if (binary) return;
          let msg: { op?: string; on?: boolean; ev?: Record<string, unknown> } & Record<string, unknown>;
          try { msg = JSON.parse(String(data)); } catch { return; }
          if (msg.op === 'config') return void join(screenOpts(msg as Parameters<typeof screenOpts>[0]));
          if (msg.op === 'ack') {
            const sc = current; const state = sc?.viewers.get(ws);
            const seq = Number(msg.seq);
            if (!sc || !state || !Number.isInteger(seq) || seq <= 0) return;
            while (state.inFlight.length && state.inFlight[0][0] <= seq) state.inFlight.shift();
            return ackRunner(sc, seq);
          }
          if (msg.op === 'rtc') {
            const sc = current;
            if (!sc || typeof msg.offer !== 'string' || msg.offer.length > 20_000) return send({ type: 'rtc', error: '직접 연결을 시작할 수 없습니다' });
            hub.call<{ answer?: string }>(targetId, 'screen.rtc', { streamId: sc.streamId, offer: msg.offer }, 10_000)
              .then((r) => send({ type: 'rtc', streamId: sc.streamId, answer: r.answer }))
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.log(`[screen] target #${targetId} stream ${sc.streamId}: no direct connection (${message.slice(0, 200)})`);
                send({ type: 'rtc', streamId: sc.streamId, error: message });
              });
            return;
          }
          if (msg.op === 'p2p') {
            const sc = current; const state = sc?.viewers.get(ws);
            if (!sc || !state) return;
            state.p2p = Boolean(msg.on);
            console.log(`[screen] target #${targetId} stream ${sc.streamId}: a viewer is ${state.p2p ? 'direct (p2p)' : 'back on the gateway path'}`);
            // back on this path: from the next keyframe
            if (!state.p2p) { state.needKey = true; state.inFlight = []; askKey(sc); }
            return relay(sc);
          }
          if (msg.op === 'control') {
            if (!msg.on) { controlOff(); return send({ type: 'control', on: false }); }
            const caps = screenCaps(targetId);
            const target = store.targetById(targetId);
            if (!caps.features?.includes('input')) return send({ type: 'error', message: tooOld(caps, '원격 제어', '0.7.0') });
            if (!caps.control) return send({ type: 'error', message: '이 PC에서 원격 제어가 꺼져 있습니다 — 러너를 0.13.2 이상으로 업데이트하면 첫 실행에서 자동으로 켜집니다 (PC에서 직접 껐다면 `aidev-runner consent control on`)' });
            if (!target || target.policy === 'deny') return send({ type: 'error', message: '이 대상의 실행 정책이 "실행 금지"입니다' });
            if (!control) {
              const remoteRunId = store.addRemoteRun({ runId: null, targetId, userId, kind: 'control', cmd: current?.window != null ? `remote control (window #${current.window})` : 'remote control (mouse/keyboard)', cwd: null, risk: null, approvedBy: 'user' });
              control = { remoteRunId, events: 0, startedAt: Date.now(), perWindow: Boolean(caps.features?.includes('windows')) };
              if (!controllers.has(targetId)) controllers.set(targetId, new Set());
              controllers.get(targetId)!.add(ws);
              controlStream(current, true);
            }
            return send({ type: 'control', on: true });
          }
          if (msg.op === 'input' && control && msg.ev && typeof msg.ev === 'object') {
            const now = Date.now();
            if (now - windowStart > 1000) { windowStart = now; windowCount = 0; }
            if (++windowCount > 300) return;   // a stuck client cannot flood the PC
            control.events++;
            // positions are relative to the window this viewer watches (set here, never by the browser)
            const { win: _ignored, ...ev } = msg.ev;
            if (control.perWindow && current?.window == null) return;   // 0.7+: never the whole desktop
            hub.notifyRunner(targetId, 'input.event', current?.window != null ? { ...ev, win: current.window } : ev);
          }
        });
        ws.on('close', () => { clearInterval(timer); controlOff(); leave(); });
        ws.on('error', () => ws.terminate());
      });
    },
    /** Called once per finished stream (remote gate: test results → the chat run's outcome). */
    onFinish(fn: (stream: StreamInfo, userId: number) => void) { finishListeners.add(fn); return () => finishListeners.delete(fn); },
    /** Resolves when the remote run has finished (or after `timeoutMs`), with its current state. */
    waitRun(remoteRunId: number, timeoutMs: number): Promise<StreamInfo | null> {
      const st = [...streams.values()].find((s) => s.remoteRunId === remoteRunId);
      if (!st || !st.running) return Promise.resolve(st ? info(st) : null);
      return new Promise((resolve) => {
        let off = () => {};
        const t = setTimeout(() => { off(); resolve(info(st)); }, timeoutMs);
        off = hub.onFinish((s) => { if (s.remoteRunId === remoteRunId) { clearTimeout(t); off(); resolve(s); } });
      });
    },
    /** exec.write / exec.resize / exec.signal on a stream of this target. */
    async control(targetId: number, streamId: number, op: 'write' | 'resize' | 'signal', params: Record<string, unknown>) {
      if (!streams.get(key(targetId, streamId))?.running) throw new RpcError(-32005, 'stream is not running');
      return hub.call(targetId, `exec.${op}`, { ...params, streamId }, 10_000);
    },
    streams(targetId: number) { return [...streams.values()].filter((s) => s.targetId === targetId).sort((a, b) => a.startedAt - b.startedAt).map(info); },
    stream(targetId: number, streamId: number) { const st = streams.get(key(targetId, streamId)); return st ? info(st) : null; },
    streamByRun(remoteRunId: number) { const st = [...streams.values()].find((s) => s.remoteRunId === remoteRunId); return st ? info(st) : null; },
    /** What a late viewer needs: the ring (last ≤256 KB). */
    tail(targetId: number, streamId: number) { const st = streams.get(key(targetId, streamId)); return st ? Buffer.concat(st.ring) : null; },
    logPath(remoteRunId: number) { return opts.logDir ? path.join(opts.logDir, `${remoteRunId}.log`) : null; },
    subscribe(targetId: number, fn: (event: TargetEvent) => void) {
      if (!listeners.has(targetId)) listeners.set(targetId, new Set());
      listeners.get(targetId)!.add(fn);
      return () => { listeners.get(targetId)?.delete(fn); if (!listeners.get(targetId)?.size) listeners.delete(targetId); };
    },

    /** Browser side of `/api/aidev/targets/:id/stream` (session and ownership checked by the caller).
     *  client → {op:"attach"|"detach", streamId} | {op:"write", streamId, data} | {op:"resize", streamId, cols, rows} | {op:"signal", streamId, signal}
     *  server → {type:"hello", online, streams} | {type:"started"|"exit", stream} | {type:"attached", stream} | {type:"online"|"offline"} | {type:"error", message}
     *           + binary `[streamId u32 BE][bytes]` for attached streams (the ring is replayed on attach). */
    attachBrowser(req: IncomingMessage, socket: Duplex, head: Buffer, targetId: number, alive: () => boolean) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const attached = new Set<number>();
        const send = (obj: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
        const unsubscribe = hub.subscribe(targetId, (event) => {
          if (ws.bufferedAmount > BROWSER_BUFFER_MAX) { ws.terminate(); return; }
          if (event.type === 'data') { if (attached.has(event.streamId) && ws.readyState === WebSocket.OPEN) ws.send(streamFrame(event.streamId, event.chunk)); }
          else send(event);
        });
        send({ type: 'hello', online: hub.online(targetId), streams: hub.streams(targetId) });
        const timer = setInterval(() => { if (!alive()) ws.close(1008, 'Session expired'); else if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 5000);
        ws.on('message', (data, binary) => {
          if (binary) return;
          let msg: { op?: string; streamId?: number; data?: string; cols?: number; rows?: number; signal?: string };
          try { msg = JSON.parse(String(data)); } catch { return; }
          const streamId = Number(msg.streamId);
          if (!Number.isInteger(streamId)) return;
          const fail = (error: unknown) => send({ type: 'error', streamId, message: error instanceof Error ? error.message : String(error) });
          if (msg.op === 'attach') {
            const st = streams.get(key(targetId, streamId));
            if (!st) return send({ type: 'error', streamId, message: '스트림이 없습니다(오래되어 정리됨) — 로그를 여세요' });
            const replay = Buffer.concat(st.ring);
            for (let i = 0; i < replay.length; i += 64 * 1024) ws.send(streamFrame(streamId, replay.subarray(i, i + 64 * 1024)));
            attached.add(streamId);
            return send({ type: 'attached', stream: info(st) });
          }
          if (msg.op === 'detach') { attached.delete(streamId); return; }
          if (msg.op === 'write' && typeof msg.data === 'string' && msg.data.length <= 65536) return void hub.control(targetId, streamId, 'write', { data: msg.data }).catch(fail);
          if (msg.op === 'resize') return void hub.control(targetId, streamId, 'resize', { cols: msg.cols, rows: msg.rows }).catch(() => { /* resize races with exit */ });
          if (msg.op === 'signal' && typeof msg.signal === 'string') return void hub.control(targetId, streamId, 'signal', { signal: msg.signal }).catch(fail);
        });
        ws.on('close', () => { clearInterval(timer); unsubscribe(); });
        ws.on('error', () => ws.terminate());
      });
    },

    online(targetId: number) { const c = conns.get(targetId); return Boolean(c && c.ws.readyState === WebSocket.OPEN); },
    connection(targetId: number) { const c = conns.get(targetId); return c ? { connectedAt: c.connectedAt, lastFrame: c.lastFrame, hello: c.hello } : null; },
    disconnect,
    /** Startup: nothing is connected yet, so every target is offline. */
    resetStatuses() { store.db.prepare("UPDATE targets SET status='offline' WHERE status!='offline'").run(); },
    size: () => conns.size,
  };
  return hub;
}
export type RunnerHub = ReturnType<typeof createRunnerHub>;
