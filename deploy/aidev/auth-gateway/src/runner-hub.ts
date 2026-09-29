import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
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
 */
type Store = ReturnType<typeof openStore>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Conn = { ws: WebSocket; targetId: number; userId: number; connectedAt: number; lastFrame: number; pending: Map<number, Pending>; nextId: number; hello: boolean };

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const PING_MS = 20_000;
const SILENCE_MS = 45_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_FRAME = 1024 * 1024;   // JSON-RPC text frames; streams get their own limits in F-03+

export class RpcError extends Error { constructor(public code: number, message: string) { super(message); } }

export function createRunnerHub(store: Store, wss: WebSocketServer) {
  const conns = new Map<number, Conn>();
  const attempts = new Map<string, { count: number; until: number }>();

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
          if (binary) return;   // streams arrive in F-03
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
