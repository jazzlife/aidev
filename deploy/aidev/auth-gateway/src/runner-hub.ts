import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
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
 *
 * Streams (F-03): exec() allocates a stream id, records a remote_runs row and asks the runner to start
 * the command (`exec.start{…, streamId, tag:"rr:<id>"}`). Output arrives as binary frames
 * `[streamId u32 BE][bytes]` → a 256 KB ring per stream (replayed to late viewers), the log file
 * `<logDir>/<remoteRunId>.log` (≤20 MB) and the target's listeners (browser `/api/aidev/targets/:id/stream`).
 * `exec.exit` finishes the row. After a reconnect `exec.list` reconciles: finished/lost streams close,
 * missed output is fetched with `exec.tail`, and streams started before a gateway restart are adopted by tag.
 */
type Store = ReturnType<typeof openStore>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Conn = { ws: WebSocket; targetId: number; userId: number; connectedAt: number; lastFrame: number; pending: Map<number, Pending>; nextId: number; hello: boolean };

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const PING_MS = 20_000;
const SILENCE_MS = 45_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_FRAME = 1024 * 1024;   // JSON-RPC text frames
const RING_BYTES = 256 * 1024;
const LOG_MAX = 20 * 1024 * 1024;
const KEEP_FINISHED = 20;
const BROWSER_BUFFER_MAX = 8 * 1024 * 1024;

export type StreamInfo = { streamId: number; targetId: number; remoteRunId: number; cmd: string; cwd: string | null; pty: boolean; by: string | null; pid: number | null; startedAt: number; running: boolean; code: number | null; signal: string | null; durationMs: number | null; bytes: number };
export type TargetEvent =
  | { type: 'data'; streamId: number; chunk: Buffer }
  | { type: 'started'; stream: StreamInfo }
  | { type: 'exit'; stream: StreamInfo }
  | { type: 'online' } | { type: 'offline' };
type Stream = StreamInfo & { userId: number; ring: Buffer[]; ringBytes: number; log: fs.WriteStream | null; logPath: string | null; logBytes: number; finishedAt: number | null };
export type ExecParams = { cmd: string; cwd?: string | null; pty?: boolean; cols?: number; rows?: number; env?: Record<string, string>; timeoutSec?: number };

export const streamFrame = (streamId: number, chunk: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(streamId >>> 0, 0); return Buffer.concat([head, chunk]); };

export class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }

export function createRunnerHub(store: Store, wss: WebSocketServer, opts: { logDir?: string } = {}) {
  const conns = new Map<number, Conn>();
  const attempts = new Map<string, { count: number; until: number }>();
  const streams = new Map<string, Stream>();               // `${targetId}:${streamId}`
  const listeners = new Map<number, Set<(event: TargetEvent) => void>>();
  let nextStream = crypto.randomInt(1, 0x3fff_ffff);        // runner-chosen ids live in 0x4000_0000+
  const key = (targetId: number, streamId: number) => `${targetId}:${streamId}`;

  function emit(targetId: number, event: TargetEvent) {
    for (const fn of listeners.get(targetId) ?? []) { try { fn(event); } catch { /* a broken listener must not stop the stream */ } }
  }
  const info = (st: Stream): StreamInfo => ({ streamId: st.streamId, targetId: st.targetId, remoteRunId: st.remoteRunId, cmd: st.cmd, cwd: st.cwd, pty: st.pty, by: st.by, pid: st.pid, startedAt: st.startedAt, running: st.running, code: st.code, signal: st.signal, durationMs: st.durationMs, bytes: st.bytes });

  function newStream(p: { targetId: number; userId: number; streamId: number; remoteRunId: number; cmd: string; cwd: string | null; pty: boolean; by: string | null; startedAt?: number }): Stream {
    const st: Stream = { ...p, pid: null, startedAt: p.startedAt ?? Date.now(), running: true, code: null, signal: null, durationMs: null, bytes: 0, ring: [], ringBytes: 0, log: null, logPath: null, logBytes: 0, finishedAt: null };
    streams.set(key(p.targetId, p.streamId), st);
    return st;
  }

  function appendData(st: Stream, chunk: Buffer) {
    if (!chunk.length) return;
    st.bytes += chunk.length;
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
    for (const st of [...streams.values()].filter((s) => s.targetId === targetId && s.running)) {
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
      const st = newStream({ targetId, userId: row.user_id, streamId: remote.streamId, remoteRunId: row.id, cmd: row.cmd ?? remote.cmd, cwd: remote.cwd, pty: remote.pty, by: row.approved_by, startedAt: row.started_at });
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
      wss.handleUpgrade(req, socket, head, (ws) => {
        const previous = conns.get(target.id);
        if (previous) { try { previous.ws.close(4000, 'replaced by a new connection'); } catch { /* ignore */ } drop(previous, 'replaced'); }
        const conn: Conn = { ws, targetId: target.id, userId: target.user_id, connectedAt: Date.now(), lastFrame: Date.now(), pending: new Map(), nextId: 1, hello: false };
        conns.set(target.id, conn);
        setStatus(target, { status: 'online', lastSeen: Date.now() });
        console.log(`[runner] target #${target.id} ${target.name} connected (runner ${String(req.headers['x-aidev-runner'] ?? '?').slice(0, 20)})`);
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
            const st = streams.get(key(conn.targetId, buf.readUInt32BE(0)));
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
            if (Array.isArray(caps.features) && caps.features.includes('exec')) void reconcile(conn.targetId);
            return;
          }
          if (msg.method === 'exec.exit' && msg.params && typeof msg.params === 'object') {
            const p = msg.params as { streamId?: number; code?: number | null; signal?: string | null; durationMs?: number | null };
            const st = typeof p.streamId === 'number' ? streams.get(key(conn.targetId, p.streamId)) : undefined;
            if (st) finishStream(st, typeof p.code === 'number' ? p.code : null, typeof p.signal === 'string' ? p.signal.slice(0, 40) : null, typeof p.durationMs === 'number' ? p.durationMs : null);
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
      const remoteRunId = store.addRemoteRun({ runId: meta.runId ?? null, targetId, userId, kind: 'exec', cmd, cwd: p.cwd ?? null, risk: meta.risk ?? null, approvedBy: meta.approvedBy });
      nextStream = nextStream >= 0x3fff_fff0 ? 1 : nextStream + 1;
      const st = newStream({ targetId, userId, streamId: nextStream, remoteRunId, cmd, cwd: p.cwd ?? null, pty: Boolean(p.pty), by: meta.approvedBy });
      try {
        const r = await hub.call<{ streamId: number; pid: number | null; cwd: string }>(targetId, 'exec.start', {
          cmd, cwd: p.cwd || undefined, pty: Boolean(p.pty), cols: p.cols, rows: p.rows, env: p.env, timeoutSec: p.timeoutSec, streamId: st.streamId, tag: `rr:${remoteRunId}`,
        }, 20_000);
        st.pid = r.pid ?? null; st.cwd = r.cwd ?? st.cwd;
      } catch (error) {
        streams.delete(key(targetId, st.streamId));
        store.finishRemoteRun(remoteRunId, { exitCode: null, artifacts: { error: error instanceof Error ? error.message : String(error) } });
        throw error;
      }
      emit(targetId, { type: 'started', stream: info(st) });
      return info(st);
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
