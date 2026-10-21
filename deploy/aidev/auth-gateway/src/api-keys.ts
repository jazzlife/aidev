/**
 * Scoped API keys: a long-lived credential for a program that only needs Laya decisions — a game,
 * a tool, a device — where an 8-hour session token cannot work.
 *
 * A key is deliberately NOT a session. It is resolved in its own branch of the gateway and may only
 * reach the decision endpoints below; it never becomes a `Session`, so it cannot touch the runtime
 * proxy, the chat sockets, the agent catalog or anything else under /api. The allowlist here is
 * positive by construction: a new route is unreachable with a key until it is named in `allows`.
 */
import crypto from 'node:crypto';

export const API_KEY_PREFIX = 'aidk_';
/** The only scope so far. Keep one scope = one explicit route list. */
export const API_KEY_SCOPES = ['decide'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const isApiKey = (token: string | undefined): boolean => Boolean(token?.startsWith(API_KEY_PREFIX));

/** `aidk_` + 32 random bytes, base64url. Shown once, stored only as a SHA-256 hash. */
export function mintApiKey() {
  const token = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  return { token, hash: hashApiKey(token), prefix: token.slice(0, API_KEY_PREFIX.length + 6) };
}

/** Lookup is by hash, so there is nothing to compare in non-constant time. */
export const hashApiKey = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** May a key with `scope` make this request? Everything not listed is refused. */
export function allows(scope: string, method: string, pathname: string): boolean {
  if (scope !== 'decide') return false;
  if (method === 'GET') return pathname === '/api/aidev/laya/health';
  if (method !== 'POST') return false;
  // raw predict (typed questions, as the Unreal/Unity clients send) and the registered kinds
  return pathname === '/api/aidev/decide' || /^\/api\/aidev\/decide\/[a-z][a-z0-9_.]*$/.test(pathname);
}

/** Requests per minute per key. A game asks per decision tick, not per frame. */
export const RATE_PER_MINUTE = Math.max(1, Number(process.env.API_KEY_RPM ?? 600));
/** A decision state is ~1 KB of text (Laya truncates at 1024 tokens); keys get a much tighter cap than a session. */
export const MAX_BODY_BYTES = 32 * 1024;

const windows = new Map<number, { count: number; until: number }>();

/** True while the key is under its per-minute budget. */
export function rateOk(keyId: number, now = Date.now()): boolean {
  for (const [id, w] of windows) if (w.until <= now) windows.delete(id);
  const w = windows.get(keyId) ?? { count: 0, until: now + 60_000 };
  windows.set(keyId, w);
  return ++w.count <= RATE_PER_MINUTE;
}

export function resetRateLimits() { windows.clear(); }
