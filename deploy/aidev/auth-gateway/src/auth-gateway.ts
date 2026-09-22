import fs from 'node:fs';
import path from 'node:path';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { openStore } from './store.js';

const port = Number(process.env.PORT ?? 8080);
// The release this process was started from; differs from /srv/app/current/RELEASE until restarted.
const gatewayRelease = (() => { try { return fs.readFileSync(new URL('../../../RELEASE', import.meta.url), 'utf8').trim(); } catch { return 'unknown'; } })();
const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'https://dev.nado.work').origin;
const secret = readSecret(process.env.JWT_SECRET_FILE ?? '/run/secrets/gateway-jwt');
const managerToken = readSecret(process.env.RUNTIME_MANAGER_TOKEN_FILE ?? '/run/secrets/runtime-token');
const managerUrl = process.env.RUNTIME_MANAGER_URL ?? 'http://runtime-manager:8090';
const store = openStore(process.env.DATABASE_PATH ?? '/data/auth.db');
const cookieName = '__Host-aidev-session';
const ttl = 8 * 3600;
const inflight = new Map<string, Promise<{ target: string; token: string }>>();
const readyCache = new Map<string, { value: { target: string; token: string }; expires: number }>();
const limits = new Map<string, { count: number; until: number }>();
const dummyHash = `dummy:${'0'.repeat(128)}`;

type Session = NonNullable<ReturnType<typeof authenticate>>;
function readSecret(file: string) {
  const value = fs.readFileSync(file, 'utf8').trim();
  if (value.length < 32) throw new Error(`Secret too short: ${file}`);
  return value;
}
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function authenticate(req: IncomingMessage) {
  const url = new URL(req.url ?? '/', origin);
  const cookie = (req.headers.cookie ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  const token = bearer ?? url.searchParams.get('token') ?? cookie;
  if (!token) return null;
  try {
    const claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'aidev', audience: origin });
    if (typeof claims === 'string' || typeof claims.sid !== 'string') return null;
    const user = store.session(claims.sid);
    return user ? { user, token, sid: claims.sid } : null;
  } catch { return null; }
}
function setCookie(token: string, age = ttl) {
  return `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new Error('Body exceeds 4KB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as { username?: unknown; password?: unknown };
}
async function managerRequest(runtimeName: string, operation: 'provision' | 'start' | 'delete') {
  if (!/^[a-z0-9_.-]{3,64}$/.test(runtimeName)) throw new Error('Invalid runtime');
  const response = await fetch(`${managerUrl}/v1/runtimes/${runtimeName}/${operation}`, {
    method: 'POST', headers: { 'x-runtime-token': managerToken }, signal: AbortSignal.timeout(125_000),
  });
  if (!response.ok) throw new Error(`Runtime ${operation} failed`);
  return await response.json() as { target?: string; token?: string };
}
function ready(runtimeName: string) {
  const cached = readyCache.get(runtimeName);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
  const prior = inflight.get(runtimeName); if (prior) return prior;
  const pending = (async () => {
    const result = await managerRequest(runtimeName, 'start');
    if (typeof result.target !== 'string' || typeof result.token !== 'string') throw new Error('Invalid runtime response');
    const check = await fetch(`${result.target}/api/auth/user`, { headers: { authorization: `Bearer ${result.token}` }, signal: AbortSignal.timeout(5000) });
    if (!check.ok) throw new Error('Runtime identity health check failed');
    const identity = await check.json() as { user?: { id?: number; username?: string } };
    if (identity.user?.id !== 1 || identity.user.username !== runtimeName) throw new Error('Unexpected runtime identity');
    const value = { target: result.target, token: result.token };
    readyCache.set(runtimeName, { value, expires: Date.now() + 30_000 }); return value;
  })().finally(() => inflight.delete(runtimeName));
  inflight.set(runtimeName, pending); return pending;
}

function upstreamPath(req: IncomingMessage, target: string, token: string) {
  // Never resolve an attacker-supplied //host or absolute URL against the target.
  const input = new URL(req.url ?? '/', origin);
  const url = new URL(target);
  url.pathname = input.pathname;
  url.search = input.search;
  if (url.searchParams.has('token')) url.searchParams.set('token', token);
  return url;
}
async function proxyHttp(req: IncomingMessage, res: ServerResponse, session: Session, authorized = true) {
  const runtime = await ready(session.user.runtime);
  if (session.sid && !store.session(session.sid)) return json(res, 401, { error: 'Session expired' });
  const url = upstreamPath(req, runtime.target, authorized ? runtime.token : '');
  const headers = { ...req.headers };
  for (const key of Object.keys(headers)) if (/^(cookie|authorization|connection|proxy-|x-forwarded-|x-real-ip|x-admin-|x-runtime-)/.test(key)) delete headers[key];
  headers.host = url.host;
  if (authorized) headers.authorization = `Bearer ${runtime.token}`;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = new URL(origin).host;
  const upstream = http.request(url, { method: req.method, headers }, (response) => {
    const out = { ...response.headers };
    // A downstream refresh token is valid only inside one container, never at the gateway.
    delete out['x-refreshed-token'];
    delete out['set-cookie'];
    delete out['access-control-allow-origin'];
    out['cache-control'] = 'no-store';
    res.writeHead(response.statusCode ?? 502, out);
    response.pipe(res);
  });
  upstream.setTimeout(3600_000, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => json(res, 502, { error: 'Runtime unavailable' }));
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
// The SPA is served by the gateway for every user, signed in or not, from STATIC_ROOT.
// STATIC_ROOT is a shared volume whose `current` entry is swapped atomically by the
// release tooling, so a frontend release never rebuilds or restarts any container.
// Only /api, /health and the WebSocket endpoints reach a user's CloudCLI runtime.
const staticRoot = process.env.STATIC_ROOT ?? '/srv/app/current/dist';
const releaseFile = process.env.AIDEV_RELEASE_FILE ?? '/srv/app/current/RELEASE';
const staticMime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (!['GET', 'HEAD'].includes(req.method ?? '')) return json(res, 405, { error: 'Method not allowed' });
  // Resolve the release symlink per request so a swap takes effect immediately.
  const root = await fs.promises.realpath(staticRoot).catch(() => null);
  if (!root) return json(res, 503, { error: 'Frontend release missing' });
  const pathname = decodeURIComponent(new URL(req.url ?? '/', origin).pathname);
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}/`) && file !== root) return json(res, 404, { error: 'Not found' });
  let stat = await fs.promises.stat(file).catch(() => null);
  let target = stat?.isFile() ? file : null;
  const isAsset = pathname.startsWith('/assets/');
  // A tab loaded on release A may lazy-load /assets/<hash>.js after `current` moved to B.
  // Hashed asset names are unique, so serving the file from a retained older release is
  // safe and keeps every open tab working through a frontend release without a reload.
  if (!target && isAsset) target = await findAssetInOtherReleases(root, pathname);
  if (!target) target = path.join(root, 'index.html');
  const content = await fs.promises.readFile(target).catch(() => null);
  if (!content) return json(res, 503, { error: 'Frontend release missing' });
  res.writeHead(200, {
    'content-type': staticMime[path.extname(target)] ?? 'application/octet-stream',
    // Vite emits content-hashed files under /assets; everything else must revalidate.
    'cache-control': isAsset && target !== path.join(root, 'index.html') ? 'public, max-age=31536000, immutable' : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}
const assetFallback = new Map<string, string | null>();
async function findAssetInOtherReleases(currentRoot: string, pathname: string) {
  const hit = assetFallback.get(pathname);
  if (hit !== undefined) return hit && await fs.promises.stat(hit).then((s) => s.isFile()).catch(() => false) ? hit : null;
  const releases = path.resolve(currentRoot, '..', '..'); // /srv/app/releases/<sha>/dist -> /srv/app/releases
  let found: string | null = null;
  for (const entry of await fs.promises.readdir(releases).catch(() => [] as string[])) {
    const candidate = path.resolve(releases, entry, 'dist', `.${pathname}`);
    if (!candidate.startsWith(`${path.resolve(releases, entry, 'dist')}/`)) continue;
    if (await fs.promises.stat(candidate).then((s) => s.isFile()).catch(() => false)) { found = candidate; break; }
  }
  if (assetFallback.size > 2000) assetFallback.clear();
  assetFallback.set(pathname, found);
  return found;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return json(res, 400, { error: 'Invalid request path' });
    const url = new URL(req.url, origin);
    if (url.pathname === '/_gateway/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Origin rejected' });
    if (url.pathname.startsWith('/admin')) return json(res, 404, { error: 'Not found' });
    if (url.pathname === '/api/auth/status') return json(res, 200, { needsSetup: false, isAuthenticated: Boolean(authenticate(req)) });
    if (url.pathname === '/api/auth/register') return json(res, 403, { error: 'Contact the administrator to create an account' });
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const data = await body(req);
      const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
      const password = typeof data.password === 'string' ? data.password : '';
      const key = username.slice(0, 64);
      const now = Date.now();
      for (const [key, value] of limits) if (value.until < now) limits.delete(key);
      const entry = limits.get(key) ?? { count: 0, until: now + 15 * 60_000 };
      // Bound aggregate hashing work as well as per-account attempts.
      const global = limits.get(':global') ?? { count: 0, until: now + 60_000 };
      if (++entry.count > 10 || ++global.count > 60) return json(res, 429, { error: 'Too many attempts. Try again later.' }, { 'retry-after': '60' });
      limits.set(key, entry); limits.set(':global', global);
      const user = store.account(username);
      const valid = password.length <= 256 && await store.check(password, user?.password_hash ?? dummyHash);
      if (!user?.active || !valid) return json(res, 401, { error: 'Invalid username or password' });
      await ready(user.runtime);
      if (!store.account(username)?.active) return json(res, 401, { error: 'Account disabled' });
      const sid = store.issue(user.id, now + ttl * 1000);
      const token = jwt.sign({ sid, userId: user.id, username }, secret, { expiresIn: ttl, issuer: 'aidev', audience: origin, algorithm: 'HS256' });
      limits.delete(key);
      return json(res, 200, { success: true, user: { id: user.id, username }, token }, { 'set-cookie': setCookie(token) });
    }
    const session = authenticate(req);
    if (url.pathname.startsWith('/api/auth/')) {
      if (!session) return json(res, 401, { error: 'Session expired' }, { 'x-auth-error': 'invalid-token' });
      if (url.pathname === '/api/auth/user' && req.method === 'GET') return json(res, 200, { user: { id: session.user.id, username: session.user.username } });
      if (url.pathname === '/api/auth/refresh' && req.method === 'POST') return json(res, 200, { token: session.token });
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        store.revoke(session.sid);
        return json(res, 200, { success: true }, { 'set-cookie': setCookie('', 0) });
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/health') {
      if (!session) return json(res, 401, { error: 'Authentication required' }, { 'x-auth-error': 'invalid-token' });
      return await proxyHttp(req, res, session);
    }
    if (url.pathname === '/_gateway/release' && req.method === 'GET') {
      const release = await fs.promises.readFile(releaseFile, 'utf8').then((v) => v.trim()).catch(() => 'unknown');
      return json(res, 200, { release, gateway: gatewayRelease });
    }
    return await serveStatic(req, res);
  } catch (error) {
    console.error('[gateway]', error instanceof Error ? error.message : 'Request failed');
    json(res, 503, { error: 'Environment unavailable. Please retry shortly.' });
  }
});

const wsServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
server.on('upgrade', async (req, socket, head) => {
  let upstream: WebSocket | undefined;
  try {
    const pathname = new URL(req.url ?? '/', origin).pathname;
    if (!['/ws', '/shell', '/desktop-notifications'].includes(pathname) && !/^\/plugin-ws\/[a-zA-Z0-9_-]+$/.test(pathname)) throw new Error('Unknown WS endpoint');
    if (req.headers.origin !== origin) throw new Error('Origin rejected');
    const session = authenticate(req);
    if (!session) throw new Error('Authentication required');
    const runtime = await ready(session.user.runtime);
    if (!store.session(session.sid) || socket.destroyed) throw new Error('Session closed');
    const url = upstreamPath(req, runtime.target, runtime.token);
    url.protocol = 'ws:';
    url.searchParams.set('token', runtime.token);
    upstream = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 });
    const remote = upstream;
    socket.on('close', () => remote.terminate());
    remote.on('error', () => socket.destroy());
    remote.once('open', () => {
      if (socket.destroyed || !store.session(session.sid)) return remote.terminate();
      wsServer.handleUpgrade(req, socket, head, (client) => {
        const timer = setInterval(() => {
          if (!store.session(session.sid)) { client.close(1008, 'Session expired'); remote.terminate(); }
          else client.ping();
        }, 5000);
        const forward = (to: WebSocket, data: WebSocket.RawData, binary: boolean) => {
          if (to.bufferedAmount > 16 * 1024 * 1024) return to.terminate();
          if (to.readyState === WebSocket.OPEN) to.send(data, { binary });
        };
        client.on('message', (data, binary) => forward(remote, data, binary));
        remote.on('message', (data, binary) => forward(client, data, binary));
        client.on('error', () => remote.terminate());
        client.on('close', () => { clearInterval(timer); remote.terminate(); });
        remote.on('close', () => { clearInterval(timer); client.close(1001, 'Upstream closed'); });
      });
    });
  } catch { upstream?.terminate(); socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
});
server.requestTimeout = 60_000;
server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`Gateway listening on ${port}`));
