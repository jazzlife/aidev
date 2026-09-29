import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { RpcError, type RunnerHub } from './runner-hub.js';
import type { openStore } from './store.js';
import type { TargetRow } from './store-aidev.js';

/**
 * Dev-server preview (IMPLEMENTATION-PLAN §3.12, F-06): `https://<gateway>/p/<cap>/…` → a server listening on
 * the target PC's loopback, over a runner tunnel (HTTP and WebSocket, so Vite/webpack HMR works).
 *
 *   cap = <targetId>-<port>-<16 chars HMAC(gateway secret, user|target|port|runner token hash)>
 *         Stable while the runner stays paired (a dev server can be started with `--base /p/<cap>/`),
 *         useless for another user, target or port, and void after re-pairing or deleting the target.
 *         The URL itself is the credential (no cookie): it also opens on a phone.
 *
 * Isolation: every response carries `Content-Security-Policy: sandbox …` without allow-same-origin, so the
 * previewed app runs in an opaque origin even though it is served from the platform's host — it cannot
 * read the platform's localStorage token and its requests carry no session cookie (SameSite=Strict and
 * cross-site from an opaque origin). The browser's cookie/authorization headers are never forwarded.
 * Because the origin is opaque, responses allow CORS from anywhere (module scripts need it).
 *
 * Paths: a server started with base `/p/<cap>/` (Vite `--base`, Next `basePath`) gets the full path ("keep");
 * any other server gets the path without the prefix ("strip") and its HTML has absolute src/href/action
 * rewritten under the prefix, plus a small script that does the same for fetch/XHR/WebSocket/EventSource
 * and gives the page in-memory storage (opaque origins have none). Module imports inside JS cannot be
 * rewritten — hence the base advice. The mode is probed once per target+port and cached.
 */
type Store = ReturnType<typeof openStore>;
type Mode = 'keep' | 'strip';
type Resolved = { target: TargetRow; port: number; prefix: string; rest: string };
export type PreviewEntry = { targetId: number; targetName: string; port: number; url: string; base: string; mode: Mode | null; by: 'user' | 'agent'; label: string | null; createdAt: number; status: number | null; error: string | null };

const CAP = /^\/p\/(\d{1,9})-(\d{4,5})-([A-Za-z0-9_-]{16})(\/.*)?$/;
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox';
const HTML_LIMIT = 8 * 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization']);
const MAX_RECENT = 20;

function shim(prefix: string) {
  // runs first in the previewed page: prefix absolute same-host URLs and provide storage in the opaque origin
  return `<script data-aidev-preview>(function(){var P=${JSON.stringify(prefix)};function f(u){try{if(typeof u!=="string"&&!(u instanceof URL))return u;var s=String(u);if(s.charAt(0)==="/"&&s.charAt(1)!=="/"){return s.indexOf(P)===0?s:P+s.slice(1)}var x=new URL(s,location.href);if(x.host===location.host&&x.pathname.indexOf(P)!==0){x.pathname=P+x.pathname.slice(1);return x.toString()}return s}catch(e){return u}}
function mem(){var m=new Map();return{getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()},key:function(i){return Array.from(m.keys())[i]||null},get length(){return m.size}}}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(e2){}}});
try{var F=window.fetch;window.fetch=function(i,o){if(typeof i==="string"||i instanceof URL)i=f(i);return F.call(this,i,o)}}catch(e){}
try{var O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){arguments[1]=f(arguments[1]);return O.apply(this,arguments)}}catch(e){}
try{var W=window.WebSocket;var WS=function(u,p){return p===undefined?new W(f(u)):new W(f(u),p)};WS.prototype=W.prototype;["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){WS[k]=W[k]});window.WebSocket=WS}catch(e){}
try{var E=window.EventSource;if(E){var ES=function(u,o){return new E(f(u),o)};ES.prototype=E.prototype;window.EventSource=ES}}catch(e){}})();</script>`;
}

/** Absolute src/href/action/poster in HTML → under the prefix (strip mode). */
export function rewriteHtml(html: string, prefix: string, mode: Mode) {
  let out = html;
  if (mode === 'strip') {
    out = out.replace(/(\s(?:src|href|action|poster)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi, (whole, attr: string, q: string, rest: string) =>
      (`/${rest}`.startsWith(prefix) ? whole : `${attr}${q}${prefix}${rest}${q}`));
  }
  const tag = shim(prefix);
  const head = /<head[^>]*>/i.exec(out);
  if (head) return out.slice(0, head.index + head[0].length) + tag + out.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(out);
  if (htmlTag) return out.slice(0, htmlTag.index + htmlTag[0].length) + tag + out.slice(htmlTag.index + htmlTag[0].length);
  return tag + out;
}

/** Location / Set-Cookie of the dev server → valid under the prefix. */
export function rewriteLocation(location: string, prefix: string, port: number) {
  const local = location.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?(\/.*)?$/i);
  if (local && (!local[1] || Number(local[1]) === port)) location = local[2] ?? '/';
  if (location.startsWith('/') && !location.startsWith('//') && !location.startsWith(prefix)) return prefix + location.slice(1);
  return location;
}

export function createPreview(opts: { store: Store; runners: RunnerHub; secret: string }) {
  const { store, runners, secret } = opts;
  const modes = new Map<string, Mode>();                 // `${targetId}:${port}`
  const recent = new Map<number, PreviewEntry[]>();       // userId → newest first

  const sig = (t: TargetRow, port: number) => crypto.createHmac('sha256', secret).update(`preview|${t.user_id}|${t.id}|${port}|${t.token_hash ?? ''}`).digest('base64url').slice(0, 16);
  const capFor = (t: TargetRow, port: number) => `${t.id}-${port}-${sig(t, port)}`;
  const baseFor = (t: TargetRow, port: number) => `/p/${capFor(t, port)}/`;

  function resolve(pathname: string): Resolved | null {
    const m = CAP.exec(pathname);
    if (!m) return null;
    const target = store.targetById(Number(m[1]));
    const port = Number(m[2]);
    if (!target || !target.token_hash || port < 1024 || port > 65535) return null;
    const want = Buffer.from(sig(target, port)); const got = Buffer.from(m[3]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return { target, port, prefix: `/p/${m[1]}-${m[2]}-${m[3]}/`, rest: m[4] ?? '/' };
  }

  function upstreamHeaders(req: IncomingMessage, port: number) {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k) || k === 'host' || k === 'cookie' || k === 'authorization' || k === 'referer' || k.startsWith('x-forwarded-') || k === 'x-real-ip' || k === 'forwarded') continue;
      headers[k] = v;
    }
    headers.host = `localhost:${port}`;
    if (headers.origin) headers.origin = `http://localhost:${port}`;   // dev servers check Origin on HMR sockets
    headers['accept-encoding'] = 'identity';                             // HTML is rewritten; loopback needs no gzip
    return headers;
  }

  /** One HTTP exchange over a fresh tunnel (each request its own TCP connection: simple and HMR-safe). */
  async function exchange(target: TargetRow, port: number, method: string, path: string, headers: Record<string, string | string[]>, body?: IncomingMessage) {
    const tunnel = await runners.openTunnel(target.id, port);
    return new Promise<IncomingMessage>((resolveRes, reject) => {
      const upstream = http.request({ method, path, headers: { ...headers, connection: 'close' }, createConnection: () => tunnel as unknown as import('node:net').Socket });   // no agent: each request its own tunnel
      upstream.setTimeout(120_000, () => upstream.destroy(new Error('dev server did not answer in 120s')));
      upstream.on('response', resolveRes);
      upstream.on('error', (e) => { tunnel.destroy(); reject(e); });
      if (body) body.pipe(upstream); else upstream.end();
    });
  }

  const drain = (res: IncomingMessage, limit = 64 * 1024) => new Promise<string>((done) => {
    let n = 0; const parts: Buffer[] = [];
    res.on('data', (c: Buffer) => { if (n < limit) parts.push(c); n += c.length; });
    res.on('end', () => done(Buffer.concat(parts).toString('utf8')));
    res.on('error', () => done(''));
  });

  /** keep or strip: a base-configured server answers its prefix and 404s the bare root. */
  async function probeMode(target: TargetRow, port: number, prefix: string): Promise<{ mode: Mode; status: number }> {
    const cached = modes.get(`${target.id}:${port}`);
    if (cached) return { mode: cached, status: 200 };
    const h = { host: `localhost:${port}`, accept: 'text/html', 'accept-encoding': 'identity' };
    const root = await exchange(target, port, 'GET', '/', h);
    const rootBody = await drain(root);
    let mode: Mode = 'strip'; let status = root.statusCode ?? 0;
    if (status === 404 || rootBody.includes(prefix)) {
      const pre = await exchange(target, port, 'GET', prefix, h);
      await drain(pre);
      if ((pre.statusCode ?? 500) < 400) { mode = 'keep'; status = pre.statusCode ?? 200; }
    }
    modes.set(`${target.id}:${port}`, mode);
    return { mode, status };
  }

  function errorPage(res: ServerResponse, status: number, title: string, detail: string) {
    if (res.headersSent) return res.destroy();
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': SANDBOX, 'x-content-type-options': 'nosniff' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font:15px system-ui;padding:24px;color:#444;background:#fafafa"><h3 style="margin:0 0 8px">${esc(title)}</h3><p>${esc(detail)}</p></body>`);
  }

  function describe(error: unknown) {
    if (error instanceof RpcError) {
      if (error.code === -32010) return { status: 503, title: '원격 PC가 오프라인입니다', detail: '러너(aidev-runner)가 실행 중인지 확인하세요.' };
      if (error.code === -32021) return { status: 501, title: '러너 업데이트 필요', detail: error.message };
      if (error.code === -32020) return { status: 502, title: '개발 서버에 연결할 수 없습니다', detail: error.message };
    }
    return { status: 502, title: '미리보기 오류', detail: error instanceof Error ? error.message : String(error) };
  }

  const preview = {
    baseFor, capFor, resolve,

    /** Opened from the workbench (user) or the remote_preview tool (agent): probe and remember it. */
    async open(target: TargetRow, port: number, by: 'user' | 'agent', label: string | null, publicOrigin: string): Promise<PreviewEntry> {
      const base = baseFor(target, port);
      const entry: PreviewEntry = { targetId: target.id, targetName: target.name, port, url: `${publicOrigin}${base}`, base, mode: null, by, label, createdAt: Date.now(), status: null, error: null };
      modes.delete(`${target.id}:${port}`);   // the server may have been restarted with another base
      try { const p = await probeMode(target, port, base); entry.mode = p.mode; entry.status = p.status; }
      catch (error) { entry.error = describe(error).detail; }
      const list = (recent.get(target.user_id) ?? []).filter((e) => !(e.targetId === target.id && e.port === port));
      list.unshift(entry);
      recent.set(target.user_id, list.slice(0, MAX_RECENT));
      return entry;
    },
    list(userId: number) { return recent.get(userId) ?? []; },
    forget(userId: number, targetId: number, port: number) {
      recent.set(userId, (recent.get(userId) ?? []).filter((e) => !(e.targetId === targetId && e.port === port)));
      modes.delete(`${targetId}:${port}`);
    },

    /** HTTP `/p/<cap>/…`; false when the path is not a preview path. */
    async http(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (!url.pathname.startsWith('/p/')) return false;
      const r = resolve(url.pathname);
      if (!r) { errorPage(res, 404, '미리보기를 찾을 수 없습니다', '주소가 잘못되었거나, 원격 대상이 삭제·다시 페어링되어 만료된 주소입니다.'); return true; }
      if (r.target.policy === 'deny') { errorPage(res, 403, '미리보기가 허용되지 않은 대상입니다', `${r.target.name}의 실행 정책이 "실행 금지"입니다.`); return true; }
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '*'), 'access-control-max-age': '600' });
        res.end(); return true;
      }
      try {
        const { mode } = await probeMode(r.target, r.port, r.prefix);
        const path = (mode === 'keep' ? r.prefix + r.rest.slice(1) : r.rest) + url.search;
        const up = await exchange(r.target, r.port, req.method ?? 'GET', path, upstreamHeaders(req, r.port), req.method === 'GET' || req.method === 'HEAD' ? undefined : req);
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined || HOP.has(k) || k === 'content-security-policy-report-only') continue;
          headers[k] = v;
        }
        if (typeof headers.location === 'string') headers.location = rewriteLocation(headers.location, r.prefix, r.port);
        if (headers['set-cookie']) headers['set-cookie'] = ([] as string[]).concat(headers['set-cookie']).map((c) => c.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*path=\/(?=;|$)/i, `; Path=${r.prefix}`));
        headers['content-security-policy'] = headers['content-security-policy'] ? [...([] as string[]).concat(headers['content-security-policy']), SANDBOX] : SANDBOX;
        headers['access-control-allow-origin'] = '*';
        headers['referrer-policy'] = 'no-referrer';
        const isHtml = /text\/html/i.test(String(up.headers['content-type'] ?? '')) && !up.headers['content-encoding'] && req.method !== 'HEAD';
        if (!isHtml) {
          res.writeHead(up.statusCode ?? 502, headers);
          up.pipe(res);
          return true;
        }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of up) { size += (chunk as Buffer).length; if (size > HTML_LIMIT) { up.destroy(); throw new Error('HTML이 8MB를 넘습니다'); } chunks.push(chunk as Buffer); }
        const body = Buffer.from(rewriteHtml(Buffer.concat(chunks).toString('utf8'), r.prefix, mode), 'utf8');
        delete headers['content-length']; delete headers.etag;
        res.writeHead(up.statusCode ?? 200, { ...headers, 'content-length': String(body.length), 'cache-control': 'no-store' });
        res.end(body);
      } catch (error) {
        const d = describe(error);
        errorPage(res, d.status, d.title, d.detail);
      }
      return true;
    },

    /** WebSocket upgrade under `/p/<cap>/…` (HMR): raw bytes both ways over a tunnel. */
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
      if (!url.pathname.startsWith('/p/')) return false;
      const r = resolve(url.pathname);
      if (!r || r.target.policy === 'deny') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return true; }
      void (async () => {
        try {
          const { mode } = await probeMode(r.target, r.port, r.prefix);
          const path = (mode === 'keep' ? r.prefix + r.rest.slice(1) : r.rest) + url.search;
          const tunnel = await runners.openTunnel(r.target.id, r.port);
          if (socket.destroyed) { tunnel.destroy(); return; }
          const headers = upstreamHeaders(req, r.port);
          delete headers['accept-encoding'];
          const lines = [`GET ${path} HTTP/1.1`, `host: ${headers.host}`, 'connection: Upgrade', `upgrade: ${String(req.headers.upgrade ?? 'websocket')}`];
          for (const [k, v] of Object.entries(headers)) if (k !== 'host') for (const one of ([] as string[]).concat(v)) lines.push(`${k}: ${one}`);
          tunnel.write(`${lines.join('\r\n')}\r\n\r\n`);
          if (head.length) tunnel.write(head);
          socket.on('error', () => tunnel.destroy());
          tunnel.on('error', () => socket.destroy());
          socket.pipe(tunnel).pipe(socket);
        } catch {
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        }
      })();
      return true;
    },
  };
  return preview;
}
export type Preview = ReturnType<typeof createPreview>;
