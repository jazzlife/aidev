/**
 * "GitHub로 로그인" (2026-10-06): connecting a GitHub account by OAuth instead of pasting a token. The gateway owns the
 * public callback: /api/aidev/github/oauth/start sends the browser to GitHub with a one-time state, GitHub returns to
 * /_gateway/github/callback, the code becomes a token and the token is stored as the user's `github_token` credential
 * in their runtime (where cloning and the repository list read it). The OAuth App's client id and secret are set by an
 * administrator in the app (gateway DB, app_kv) — no server file to edit.
 */
import crypto from 'node:crypto';

type Kv = { kvGet: (k: string) => string | null; kvSet: (k: string, v: string) => void };
type Deps = {
  store: Kv;
  publicOrigin: string;
  /** a request to one runtime's API (runtime-manager starts it if needed) */
  runtimeFetch: (runtimeName: string, path: string, init?: RequestInit) => Promise<Response>;
  /** the runtime of an account (null: no such active account) */
  runtimeOf: (userId: number) => string | null;
  fetch?: typeof fetch;
};
type OauthConfig = { clientId: string; clientSecret: string };

export class GithubOauthError extends Error { constructor(public status: number, message: string) { super(message); } }

const KV_KEY = 'github.oauth';
const STATE_TTL_MS = 10 * 60_000;
const SCOPE = 'repo read:user';
/** Where a finished login may send the browser back: an app path on this origin. */
export const safeReturn = (value: string | null) => (value && /^\/(m\/)?[A-Za-z0-9/_\-?=&.%]*$/.test(value) && !value.startsWith('//') ? value : '/m/projects');
const withParams = (path: string, params: Record<string, string>) => `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(params).toString()}`;

export function createGithubOauth(deps: Deps) {
  const http = deps.fetch ?? fetch;
  const states = new Map<string, { userId: number; returnTo: string; at: number }>();
  const callbackUrl = `${deps.publicOrigin}/_gateway/github/callback`;
  const config = (): OauthConfig | null => {
    try { const v = JSON.parse(deps.store.kvGet(KV_KEY) ?? 'null') as OauthConfig | null; return v?.clientId && v.clientSecret ? v : null; } catch { return null; }
  };

  /** What the app shows: whether login is available; administrators also see the client id they set. */
  function publicConfig(isAdmin: boolean) {
    const c = config();
    return { configured: Boolean(c), callbackUrl, homepageUrl: deps.publicOrigin, ...(isAdmin ? { clientId: c?.clientId ?? null, admin: true } : { admin: false }) };
  }

  function setConfig(input: { clientId?: unknown; clientSecret?: unknown }) {
    const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
    const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
    if (!clientId && !clientSecret) { deps.store.kvSet(KV_KEY, 'null'); return; }
    if (!/^[A-Za-z0-9._-]{8,64}$/.test(clientId)) throw new GithubOauthError(400, 'Client ID 형식이 아닙니다');
    // an empty secret keeps the one already saved (the form never shows it back)
    const secret = clientSecret || config()?.clientSecret || '';
    if (!/^[A-Za-z0-9._-]{20,100}$/.test(secret)) throw new GithubOauthError(400, 'Client secret 형식이 아닙니다');
    deps.store.kvSet(KV_KEY, JSON.stringify({ clientId, clientSecret: secret }));
  }

  /** The GitHub authorize URL for this user; the state ties the callback to them (cookies do not come back from github.com). */
  function start(userId: number, returnTo: string | null) {
    const c = config();
    if (!c) throw new GithubOauthError(409, 'GitHub 로그인이 아직 설정되지 않았습니다');
    const now = Date.now();
    for (const [key, value] of states) if (now - value.at > STATE_TTL_MS) states.delete(key);
    const state = crypto.randomBytes(24).toString('hex');
    states.set(state, { userId, returnTo: safeReturn(returnTo), at: now });
    const params = new URLSearchParams({ client_id: c.clientId, redirect_uri: callbackUrl, scope: SCOPE, state, allow_signup: 'false' });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /** GitHub came back: exchange the code, store the token in the user's runtime; the URL to send the browser to. */
  async function callback(code: string | null, state: string | null, githubError: string | null) {
    const pending = state ? states.get(state) : undefined;
    if (state) states.delete(state);
    if (!pending || Date.now() - pending.at > STATE_TTL_MS) return withParams('/m/projects', { github: 'error', reason: '로그인 요청이 만료되었습니다. 다시 시도하세요' });
    const back = (params: Record<string, string>) => withParams(pending.returnTo, params);
    if (githubError || !code) return back({ github: 'error', reason: githubError === 'access_denied' ? 'GitHub에서 승인하지 않았습니다' : 'GitHub 로그인이 끝나지 않았습니다' });
    const c = config();
    const runtime = deps.runtimeOf(pending.userId);
    if (!c || !runtime) return back({ github: 'error', reason: 'GitHub 로그인 설정이 없습니다' });
    try {
      const exchanged = await http('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: callbackUrl }), signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json() as Promise<{ access_token?: string; error_description?: string }>);
      const token = exchanged.access_token;
      if (!token) throw new Error(exchanged.error_description || '토큰을 받지 못했습니다');
      const user = await http('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'nadovibe' }, signal: AbortSignal.timeout(15_000) })
        .then((r) => r.json() as Promise<{ login?: string }>);
      const name = `GitHub @${user.login ?? 'account'}`;
      // logging in again replaces that account's earlier token
      const listed = await deps.runtimeFetch(runtime, '/api/settings/credentials?type=github_token').then((r) => r.json() as Promise<{ credentials?: Array<{ id: number; credential_name: string }> }>).catch(() => ({ credentials: [] }));
      for (const old of listed.credentials ?? []) if (old.credential_name === name) await deps.runtimeFetch(runtime, `/api/settings/credentials/${old.id}`, { method: 'DELETE' }).catch(() => undefined);
      const saved = await deps.runtimeFetch(runtime, '/api/settings/credentials', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credentialName: name, credentialType: 'github_token', credentialValue: token, description: 'GitHub 로그인(OAuth)' }),
      });
      if (!saved.ok) throw new Error(`계정을 저장하지 못했습니다 (${saved.status})`);
      return back({ github: 'connected', account: user.login ?? '' });
    } catch (error) {
      return back({ github: 'error', reason: error instanceof Error ? error.message.slice(0, 120) : 'GitHub 로그인 실패' });
    }
  }

  return { publicConfig, setConfig, start, callback, callbackUrl };
}
export type GithubOauth = ReturnType<typeof createGithubOauth>;
