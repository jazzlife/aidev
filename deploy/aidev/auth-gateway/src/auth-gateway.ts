import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { openStore } from './store.js';
import { LayaClient } from './laya.js';
import { createAidevApi } from './aidev-api.js';
import { createPush } from './push.js';
import { createRemoteGate } from './remote-gate.js';
import { createRunnerHub, type RunnerHub } from './runner-hub.js';
import { createPreview } from './preview.js';
import { startTierPolicySchedule } from './tier-policy.js';
import { seedAgents } from './seed-agents.js';

const port = Number(process.env.PORT ?? 8080);
// The release this process was started from; differs from /srv/app/current/RELEASE until restarted.
const gatewayRelease = (() => { try { return fs.readFileSync(new URL('../../../RELEASE', import.meta.url), 'utf8').trim(); } catch { return 'unknown'; } })();
const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'https://dev.nado.work').origin;
const secret = readSecret(process.env.JWT_SECRET_FILE ?? '/run/secrets/gateway-jwt');
const managerToken = readSecret(process.env.RUNTIME_MANAGER_TOKEN_FILE ?? '/run/secrets/runtime-token');
const managerUrl = process.env.RUNTIME_MANAGER_URL ?? 'http://runtime-manager:8090';
const layaUrl = process.env.LAYA_URL ?? 'http://laya:8095';
const store = openStore(process.env.DATABASE_PATH ?? '/data/auth.db');
{ const added = store.seedAgents(seedAgents); if (added) console.log(`[gateway] seeded ${added} agents`); }
{ // routing examples for the lexical prior (control/gateway/data/agent-examples.jsonl in a release)
  try {
    const file = process.env.AIDEV_EXAMPLES_FILE ?? new URL('../data/agent-examples.jsonl', import.meta.url).pathname;
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { agent: string; text: string; lang?: string; task_kind?: string | null });
    const added = store.seedExamples(rows); if (added) console.log(`[gateway] seeded ${added} routing examples (${store.exampleCount()} total)`);
  } catch (error) { console.warn('[gateway] routing examples not loaded:', error instanceof Error ? error.message : error); }
}
const laya = new LayaClient(layaUrl);
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

const runtimeAuthCache = new Map<string, { session: Session; expires: number }>();
async function authenticateRuntime(req: IncomingMessage): Promise<Session | null> {
  const runtimeName = String(req.headers['x-aidev-runtime'] ?? '');
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  if (!/^[a-z0-9_.-]{3,64}$/.test(runtimeName) || !bearer) return null;
  const cacheKey = crypto.createHash('sha256').update(`${runtimeName}:${bearer}`).digest('hex');
  const hit = runtimeAuthCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.session;
  try {
    const r = await fetch(`${managerUrl}/v1/runtimes/${runtimeName}/verify`, { method: 'POST', headers: { 'x-runtime-token': managerToken, 'content-type': 'application/json' }, body: JSON.stringify({ token: bearer }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
  } catch { return null; }
  const user = store.accountByRuntime(runtimeName);
  if (!user || !user.active) return null;
  const session = { user, token: bearer, sid: `runtime:${runtimeName}` } as Session;
  if (runtimeAuthCache.size > 500) runtimeAuthCache.clear();
  runtimeAuthCache.set(cacheKey, { session, expires: Date.now() + 4 * 60_000 });
  return session;
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
// /api/aidev/* is answered by the gateway itself (routing, catalog, runs …); the runtime is only
// consulted for provider auth status. See aidev-api.ts.
// Web push for the mobile PWA + Claude login reminders (VAPID subject = the public origin).
const push = createPush(store, origin.startsWith('https:') ? origin : 'mailto:aidev@localhost');   // web-push requires https: or mailto:
push.startReminders();
// Remote PC runners (stage F): outbound WebSockets from `aidev-runner` on users' machines.
// Command output logs (remote_runs) live next to the database unless REMOTE_LOG_DIR says otherwise.
const remoteLogDir = process.env.REMOTE_LOG_DIR ?? path.join(path.dirname(process.env.DATABASE_PATH ?? '/data/auth.db'), 'remote-logs');
const runners: RunnerHub = createRunnerHub(store, new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 }), { logDir: remoteLogDir });
runners.resetStatuses();
// Agents' remote commands pass the gate (risk, policy, approvals); remote test results feed the chat run's outcome.
const gate = createRemoteGate({ store, laya, runners, push });
runners.onFinish((stream, userId) => gate.onFinished(stream, userId, stream.runId));
// Dev-server previews on the user's PCs (F-06): /p/<cap>/… over runner tunnels.
const preview = createPreview({ store, runners, secret });
const aidev = createAidevApi({
  runners, gate, preview, publicOrigin: origin,
  store, laya, json, push,
  async runtimeFetch(session, path, init, timeoutMs = 10_000) {
    const runtime = await ready(session.user.runtime);
    return fetch(`${runtime.target}${path}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(timeoutMs) });
  },
});
aidev.knowledgeRefresher.startSchedule();
startTierPolicySchedule(store);
// The SPA is served by the gateway for every user, signed in or not, from STATIC_ROOT.
// STATIC_ROOT is a shared volume whose `current` entry is swapped atomically by the
// release tooling, so a frontend release never rebuilds or restarts any container.
// Only /api, /health and the WebSocket endpoints reach a user's CloudCLI runtime.
const staticRoot = process.env.STATIC_ROOT ?? '/srv/app/current/dist';
const releaseFile = process.env.AIDEV_RELEASE_FILE ?? '/srv/app/current/RELEASE';
const staticMime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
// Two independent SPAs (IMPLEMENTATION-PLAN §3.11): the workbench at / (dist) and the mobile app at
// /m/ (dist-mobile). A phone landing on the root is redirected to /m/<same path> unless the
// `aidev_ui` cookie pins a choice; `?ui=mobile|workbench` sets that cookie from either app.
const mobileStaticRoot = process.env.MOBILE_STATIC_ROOT ?? path.join(path.dirname(staticRoot), 'dist-mobile');
const uiCookie = 'aidev_ui';
function readCookie(req: IncomingMessage, name: string) {
  return (req.headers.cookie ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
function isPhone(req: IncomingMessage) {
  const hint = req.headers['sec-ch-ua-mobile'];
  if (typeof hint === 'string') return hint.trim() === '?1';
  const ua = String(req.headers['user-agent'] ?? '');
  return /iPhone|iPod|Android.+Mobile|Windows Phone|Mobile Safari/i.test(ua) && !/iPad|Tablet/i.test(ua);
}
function uiRedirect(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!['GET', 'HEAD'].includes(req.method ?? '')) return false;
  const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
  const inMobile = url.pathname === '/m' || url.pathname.startsWith('/m/');
  const forced = url.searchParams.get('ui');
  if (forced === 'mobile' || forced === 'workbench') {
    url.searchParams.delete('ui');
    const target = forced === 'mobile' ? (inMobile ? url.pathname : `/m${url.pathname === '/' ? '' : url.pathname}`) : (inMobile ? url.pathname.slice(2) || '/' : url.pathname);
    res.writeHead(302, { location: `${target}${url.search}`, 'set-cookie': `${uiCookie}=${forced}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`, 'cache-control': 'no-store' });
    res.end(); return true;
  }
  if (!wantsHtml || inMobile || url.pathname.startsWith('/assets/') || url.pathname.includes('.')) return false;
  const pinned = readCookie(req, uiCookie);
  if (pinned === 'workbench') return false;
  if (pinned === 'mobile' || (pinned === null && isPhone(req))) {
    res.writeHead(302, { location: `/m${url.pathname === '/' ? '' : url.pathname}${url.search}`, vary: 'User-Agent, Sec-CH-UA-Mobile, Cookie', 'cache-control': 'no-store' });
    res.end(); return true;
  }
  return false;
}
async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (!['GET', 'HEAD'].includes(req.method ?? '')) return json(res, 405, { error: 'Method not allowed' });
  const url = new URL(req.url ?? '/', origin);
  if (uiRedirect(req, res, url)) return;
  const mobile = url.pathname === '/m' || url.pathname.startsWith('/m/');
  // Resolve the release symlink per request so a swap takes effect immediately.
  const root = await fs.promises.realpath(mobile ? mobileStaticRoot : staticRoot).catch(() => null);
  if (!root) return json(res, 503, { error: 'Frontend release missing' });
  const pathname = decodeURIComponent(mobile ? (url.pathname.slice(2) || '/') : url.pathname);
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}/`) && file !== root) return json(res, 404, { error: 'Not found' });
  let stat = await fs.promises.stat(file).catch(() => null);
  let target = stat?.isFile() ? file : null;
  const isAsset = pathname.startsWith('/assets/');
  // A tab loaded on release A may lazy-load /assets/<hash>.js after `current` moved to B.
  // Hashed asset names are unique, so serving the file from a retained older release is
  // safe and keeps every open tab working through a frontend release without a reload.
  if (!target && isAsset) target = await findAssetInOtherReleases(root, pathname, mobile ? 'dist-mobile' : 'dist');
  if (!target) target = path.join(root, 'index.html');
  const content = await fs.promises.readFile(target).catch(() => null);
  if (!content) return json(res, 503, { error: 'Frontend release missing' });
  res.writeHead(200, {
    'content-type': staticMime[path.extname(target)] ?? 'application/octet-stream',
    // Vite emits content-hashed files under /assets; everything else must revalidate.
    'cache-control': isAsset && target !== path.join(root, 'index.html') ? 'public, max-age=31536000, immutable' : 'no-store',
    'x-content-type-options': 'nosniff',
    ...(target.endsWith('sw.js') ? { 'service-worker-allowed': mobile ? '/m/' : '/' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}
/** Directory of the active release's runner binaries (release/control/runner, next to dist). */
function runnerDir() { return process.env.RUNNER_DIST_DIR ?? path.join(path.dirname(staticRoot), 'control', 'runner'); }
async function runnerFiles() {
  const dir = await fs.promises.realpath(runnerDir()).catch(() => null);
  if (!dir) return [];
  const names = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith('aidev-runner-')).sort();
  const sums = await fs.promises.readFile(path.join(dir, 'SHA256SUMS'), 'utf8').catch(() => '');
  return Promise.all(names.map(async (name) => {
    const m = name.match(/^aidev-runner-([0-9.]+)-(.+?)(\.exe)?$/);
    const sha256 = sums.split('\n').find((l) => l.trim().endsWith(` ${name}`) || l.trim().endsWith(`*${name}`))?.split(/\s+/)[0] ?? null;
    return { name, version: m?.[1] ?? null, platform: m?.[2] ?? null, size: (await fs.promises.stat(path.join(dir, name))).size, sha256 };
  }));
}
const assetFallback = new Map<string, string | null>();
async function findAssetInOtherReleases(currentRoot: string, pathname: string, distDir = 'dist') {
  const key = `${distDir}:${pathname}`;
  const hit = assetFallback.get(key);
  if (hit !== undefined) return hit && await fs.promises.stat(hit).then((s) => s.isFile()).catch(() => false) ? hit : null;
  const releases = path.resolve(currentRoot, '..', '..'); // /srv/app/releases/<sha>/dist -> /srv/app/releases
  let found: string | null = null;
  for (const entry of await fs.promises.readdir(releases).catch(() => [] as string[])) {
    const candidate = path.resolve(releases, entry, distDir, `.${pathname}`);
    if (!candidate.startsWith(`${path.resolve(releases, entry, distDir)}/`)) continue;
    if (await fs.promises.stat(candidate).then((s) => s.isFile()).catch(() => false)) { found = candidate; break; }
  }
  if (assetFallback.size > 2000) assetFallback.clear();
  assetFallback.set(key, found);
  return found;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return json(res, 400, { error: 'Invalid request path' });
    const url = new URL(req.url, origin);
    if (url.pathname === '/_gateway/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
    // Runner binaries shipped with the release (control/runner): list + download, no session needed.
    if (url.pathname === '/_runner/download' && req.method === 'GET') return json(res, 200, { files: await runnerFiles() });
    const dl = url.pathname.match(/^\/_runner\/download\/(aidev-runner-[0-9A-Za-z._-]+|SHA256SUMS)$/);
    if (dl && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = path.join(runnerDir(), dl[1]);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat?.isFile()) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': dl[1] === 'SHA256SUMS' ? 'text/plain; charset=utf-8' : 'application/octet-stream', 'content-length': String(stat.size), 'content-disposition': `attachment; filename="${dl[1].endsWith('.exe') ? 'aidev-runner.exe' : dl[1] === 'SHA256SUMS' ? 'SHA256SUMS' : 'aidev-runner'}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
    }
    // Previews carry their own capability in the path (no session, sandboxed, see preview.ts).
    if (await preview.http(req, res, url)) return;
    // Runner pairing: the one-time code is the credential (no session; runners send no Origin).
    if (url.pathname === '/_runner/pair' && req.method === 'POST') {
      if (req.headers.origin) return json(res, 403, { error: 'Origin rejected' });
      const ip = String(req.headers['x-real-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim() || req.socket.remoteAddress || 'unknown';
      try { return json(res, 200, runners.pair(await body(req), ip)); }
      catch (error) { return json(res, (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : 'pairing failed' }); }
    }
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
    if (await aidev.handle(req, res, url, session)) return;
    // Runtime → gateway calls (aidev-tools MCP inside a user's CloudCLI container). The runtime signs a
    // JWT with its own key; the runtime-manager verifies it; the account is derived from the runtime name.
    if (url.pathname.startsWith('/internal/aidev/')) {
      const runtimeSession = await authenticateRuntime(req);
      if (!runtimeSession) return json(res, 401, { error: 'Runtime authentication failed' });
      const rewritten = new URL(url); rewritten.pathname = url.pathname.replace('/internal/aidev/', '/api/aidev/');
      if (await aidev.handle(req, res, rewritten, runtimeSession)) return;
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
    if (runners.upgrade(req, socket, head, pathname)) return;
    if (preview.upgrade(req, socket, head, new URL(req.url ?? '/', origin))) return;
    // Remote run streams for the workbench (F-03): session cookie + same origin + the caller's own target.
    const streamMatch = pathname.match(/^\/api\/aidev\/targets\/(\d+)\/stream$/);
    if (streamMatch) {
      if (req.headers.origin !== origin) throw new Error('Origin rejected');
      const session = authenticate(req);
      if (!session || !store.target(session.user.id, Number(streamMatch[1]))) throw new Error('Authentication required');
      runners.attachBrowser(req, socket, head, Number(streamMatch[1]), () => Boolean(store.session(session.sid)));
      return;
    }
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
