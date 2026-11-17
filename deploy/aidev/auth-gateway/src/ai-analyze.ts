/**
 * AI analysis contract v1 at the gateway: `POST /ai/v1/analyze` and `GET /ai/v1/analyze/{jobId}` (docs: the contract
 * "AI 분석 계약 v1"). The gateway only authenticates and forwards; the contract itself — validation, idempotency, the
 * model turn on the account's Claude subscription — lives in the account's runtime (server/modules/ai-analyze).
 *
 * Kept away from everything else the gateway does:
 * - the request body (a drawing, up to ~30 MB) is streamed to the runtime, never parsed or buffered here, so a large
 *   upload cannot stall the one process every user's chats go through; its size is checked from Content-Length first;
 * - the caller is a NadoVibe account: an `analyze`-scoped API key (a long-lived credential a server can hold) or a
 *   session token, in the Authorization header only. The account decides which runtime — and so which Claude
 *   subscription and which model settings — the analysis runs on;
 * - `app_kv ai_analyze=off` turns the whole path off at once (503) without a release.
 * Every answer is the contract's envelope `{ ok, ... }`, including the gateway's own refusals.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { isApiKey, rateOk } from './api-keys.js';

/** A request of at most ~22 MB of PDF (base64 4/3) plus the task, schema and JSON around it. */
export const AI_ANALYZE_MAX_BODY_BYTES = 34 * 1024 * 1024;
/** A reply is the job ticket or the answer (JSON, kilobytes); more than this is not a contract reply. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
/** The runtime answers a submit once it has the body and checked it (no model call yet), a poll at once. */
const UPSTREAM_TIMEOUT_MS = 120_000;
const JOB_PATH = /^\/ai\/v1\/analyze\/(job_[A-Za-z0-9_-]{6,64})$/;

type Deps = {
  kvGet(key: string): string | null;
  useApiKey(token: string): { keyId: number; scope: string; user: { runtime: string } } | undefined;
  authenticate(req: IncomingMessage): { user: { runtime: string } } | null;
  ready(runtime: string): Promise<{ target: string; token: string }>;
};

/** Is this one of the contract's paths (all of /ai/v1 is answered here, in the contract's envelope)? */
export const isAiAnalyzePath = (pathname: string) => pathname === '/ai/v1' || pathname.startsWith('/ai/v1/');

/**
 * Cloudflare replaces a 502/504 body with its own HTML page, so the caller would lose the envelope and its message:
 * those go out as 503 with the envelope's `code` (upstream_error, timeout) unchanged — as proxyHttp does for the app.
 */
function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return void res.destroy();
  if (status === 502 || status === 504) status = 503;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function fail(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  send(res, status, { ok: false, error: { code, message, ...extra } });
}
/** The contract code for a runtime status that came without the contract's envelope. */
const codeFor = (status: number) => (status === 413 ? 'too_large' : status === 400 ? 'bad_request' : status === 404 ? 'not_found' : 'upstream_error');

/** The /ai/v1 handler. Used by auth-gateway.ts for every request under /ai/v1. */
export function createAiAnalyze(deps: Deps) {
  /** Every failure here — the key store, the runtime start — still answers in the envelope, never the gateway's own error page. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try { await forward(req, res, url); }
    catch (error) {
      console.error('[ai-analyze]', error instanceof Error ? error.message : error);
      fail(res, 503, 'upstream_error', 'NadoVibe 게이트웨이 내부 오류다. 잠시 후 같은 requestId 로 다시 보내라', { retryAfterSec: 30 });
    }
  }
  async function forward(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const job = JOB_PATH.exec(url.pathname);
    const submit = url.pathname === '/ai/v1/analyze' && req.method === 'POST';
    if (!submit && !(job && req.method === 'GET')) {
      return fail(res, 404, 'not_found', `${req.method} ${url.pathname} 은(는) AI 분석 계약 v1 에 없다 (POST /ai/v1/analyze, GET /ai/v1/analyze/{jobId})`);
    }
    if (deps.kvGet('ai_analyze') === 'off') {
      return fail(res, 503, 'unavailable', 'NadoVibe 의 AI 분석이 관리자에 의해 잠시 꺼져 있다. 잠시 후 같은 requestId 로 다시 보내라', { retryAfterSec: 300 });
    }

    // ---- who is calling: a NadoVibe account, by key or session (header only — a token in a URL ends up in logs)
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!bearer) return fail(res, 401, 'unauthenticated', 'NadoVibe 토큰이 없다. Authorization: Bearer <토큰> 헤더에 NadoVibe 계정의 analyze 키를 넣어 보내라');
    let runtime: string;
    if (isApiKey(bearer)) {
      const key = deps.useApiKey(bearer);
      if (!key) return fail(res, 401, 'unauthenticated', 'NadoVibe 키가 없거나 폐기·만료됐다(또는 계정이 꺼졌다). NadoVibe 관리자에게 새 analyze 키를 받아 설정을 바꿔라');
      if (key.scope !== 'analyze') return fail(res, 403, 'forbidden', `이 NadoVibe 키의 범위는 "${key.scope}" 다. AI 분석에는 analyze 범위의 키가 필요하다`);
      if (!rateOk(key.keyId)) return fail(res, 429, 'rate_limited', '이 NadoVibe 키의 분당 요청 한도를 넘었다. 1분 뒤 다시 보내라', { retryAfterSec: 60 });
      runtime = key.user.runtime;
    } else {
      const session = deps.authenticate(req);
      if (!session) return fail(res, 401, 'unauthenticated', 'NadoVibe 로그인 토큰이 만료됐거나 틀렸다. 다시 로그인해 새 토큰을 받거나 analyze 키를 써라');
      runtime = session.user.runtime;
    }

    // ---- the body's size, before a byte of it is read
    let length = 0;
    if (submit) {
      length = Number(req.headers['content-length']);
      if (req.headers['content-length'] === undefined || !Number.isInteger(length) || length < 0) return fail(res, 411, 'bad_request', 'Content-Length 헤더가 필요하다 (본문을 한 번에 보내라)');
      if (length > AI_ANALYZE_MAX_BODY_BYTES) {
        return fail(res, 413, 'too_large', `요청이 ${(length / 1048576).toFixed(1)}MB 로 상한 ${AI_ANALYZE_MAX_BODY_BYTES / 1048576}MB 를 넘는다. 도면은 22MB 이하로 보내거나 목차만 보내는 모드로 낮춰라`);
      }
    }

    // ---- the account's runtime
    let target: { target: string; token: string };
    try { target = await deps.ready(runtime); }
    catch { return fail(res, 503, 'upstream_error', 'NadoVibe 런타임을 시작하지 못했다. 잠시 후 같은 requestId 로 다시 보내라', { retryAfterSec: 30 }); }
    // /ai/v1/… → /api/ai-analyze/v1/… on the runtime (appended to its address, as runtimeFetch does); the path was
    // matched above, so it carries nothing but the fixed route and a checked job id
    const upstreamUrl = new URL(`${target.target.replace(/\/$/, '')}/api/ai-analyze${url.pathname.slice('/ai'.length)}`);
    const headers: Record<string, string> = { host: upstreamUrl.host, authorization: `Bearer ${target.token}`, accept: 'application/json' };
    if (submit) { headers['content-type'] = 'application/json'; headers['content-length'] = String(length); }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (status: number, body: unknown) => { if (settled) return; settled = true; send(res, status, body); resolve(); };
      const upstream = http.request(upstreamUrl, { method: req.method, headers }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= MAX_REPLY_BYTES) chunks.push(chunk); });
        response.on('end', () => {
          const status = response.statusCode ?? 502;
          let body: unknown = null;
          if (size <= MAX_REPLY_BYTES) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not the envelope */ } }
          // the runtime's own reply passes as is; anything else (an old runtime, a proxy page) becomes the envelope
          if (body && typeof body === 'object' && typeof (body as { ok?: unknown }).ok === 'boolean') return finish(status, body);
          const code = status < 400 ? 'upstream_error' : codeFor(status);
          finish(status < 400 || status === 401 || status === 403 ? 502 : status, { ok: false, error: { code,
            message: status === 404 ? '이 NadoVibe 런타임에는 아직 AI 분석이 없다 (배포 전이다). 잠시 후 다시 보내라' : `NadoVibe 런타임이 계약 밖의 응답을 줬다 (HTTP ${status}). 잠시 후 같은 requestId 로 다시 보내라` } });
        });
        response.on('error', () => finish(502, { ok: false, error: { code: 'upstream_error', message: 'NadoVibe 런타임의 응답이 끊겼다. 잠시 후 같은 requestId 로 다시 보내라' } }));
      });
      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')));
      upstream.on('error', () => finish(502, { ok: false, error: { code: 'upstream_error', message: 'NadoVibe 런타임이 응답하지 않았다. 잠시 후 같은 requestId 로 다시 보내라' } }));
      // the caller hung up: stop forwarding (the runtime drops a half-sent body)
      res.on('close', () => { if (!settled) { settled = true; upstream.destroy(); resolve(); } });
      if (submit) req.pipe(upstream);
      else upstream.end();
    });
  }
  return { handle };
}
