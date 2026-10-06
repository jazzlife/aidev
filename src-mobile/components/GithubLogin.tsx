import { useEffect, useState } from 'react';
import { Copy, GitBranch, KeyRound } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { failureText } from '@m/lib/http';

type OauthConfig = { configured: boolean; callbackUrl: string; homepageUrl: string; admin: boolean; clientId?: string | null };

const field = 'w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent';

/**
 * Used by the clone tab and the settings screen: connects a GitHub account — "GitHub로 로그인" (OAuth through the
 * gateway; GitHub sends the browser back to `returnTo`), or a pasted token as the fallback. Before an administrator
 * has registered the OAuth App, administrators get its setup here and everyone else is told login is not set up yet.
 */
export function GithubLogin({ returnTo, onConnected }: { returnTo: string; onConnected: () => void }) {
  // whether OAuth login is set up (null: loading)
  const [config, setConfig] = useState<OauthConfig | null>(null);
  // the token form (fallback) and the administrator's OAuth App form
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // a request in flight, and the server's words when one failed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.githubOauth.config().then(async (r) => {
    const c = await r.json() as OauthConfig;
    setConfig(c); setClientId(c.clientId ?? '');
  }).catch(() => setConfig({ configured: false, callbackUrl: '', homepageUrl: '', admin: false }));
  useEffect(() => { void load(); }, []);

  const run = async (action: () => Promise<Response>, after: () => void) => {
    setBusy(true); setError(null);
    try { const r = await action(); if (!r.ok) throw new Error(await failureText(r)); after(); }
    catch (err) { setError(err instanceof Error ? err.message : '실패했습니다'); }
    finally { setBusy(false); }
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); };

  if (!config) return <div className="text-[13px] text-muted m-pulse">불러오는 중…</div>;
  return (
    <div className="space-y-2" data-testid="github-login">
      {config.configured ? (
        <button type="button" onClick={() => window.location.assign(api.githubOauth.startUrl(returnTo))}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[15px] font-medium text-bg"><GitBranch size={18} /> GitHub로 로그인</button>
      ) : config.admin ? (
        <div className="space-y-2 rounded-xl border border-line p-3" data-testid="github-oauth-setup">
          <div className="text-[14px] font-medium">GitHub 로그인 설정 (관리자, 한 번)</div>
          <ol className="list-decimal space-y-1 pl-4 text-[12px] text-muted">
            <li>GitHub → Settings → Developer settings → OAuth Apps → New OAuth App</li>
            <li>Homepage URL: <button type="button" onClick={() => copy(config.homepageUrl)} className="inline-flex items-center gap-1 font-mono text-ink">{config.homepageUrl} <Copy size={11} /></button></li>
            <li>Authorization callback URL: <button type="button" onClick={() => copy(config.callbackUrl)} className="inline-flex items-center gap-1 break-all text-left font-mono text-ink">{config.callbackUrl} <Copy size={11} /></button></li>
            <li>만든 앱의 Client ID와 새로 만든 Client secret을 아래에 넣으세요.</li>
          </ol>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" aria-label="Client ID" autoCapitalize="off" autoCorrect="off" className={field} />
          <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client secret" aria-label="Client secret" autoCapitalize="off" autoCorrect="off" className={field} />
          <button type="button" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={() => { void run(() => api.githubOauth.save({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }), () => { setClientSecret(''); void load(); }); }}
            className="h-11 w-full rounded-xl bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-40">{busy ? '저장 중…' : '저장'}</button>
        </div>
      ) : (
        <div className="rounded-xl bg-elevated px-3 py-2 text-[13px] text-muted">GitHub 로그인은 관리자가 설정하면 쓸 수 있습니다. 그동안은 토큰으로 연결하세요.</div>
      )}
      {tokenOpen ? (
        <div className="space-y-2">
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… 또는 github_pat_…" aria-label="GitHub 토큰" autoCapitalize="off" autoCorrect="off" className={field} />
          <div className="text-[12px] text-muted">GitHub → Settings → Developer settings → Personal access tokens에서 repo 권한으로 만든 토큰. 이 서버에만 저장됩니다.</div>
          <button type="button" disabled={busy || !token.trim()} onClick={() => { const v = token.trim(); void run(() => api.settings.createCredential({ credentialName: 'GitHub', credentialType: 'github_token', credentialValue: v, description: 'NadoVibe에서 연결' }), () => { setToken(''); setTokenOpen(false); onConnected(); }); }}
            className="h-11 w-full rounded-xl border border-line text-[15px] disabled:opacity-40">{busy ? '연결 중…' : '토큰으로 연결'}</button>
        </div>
      ) : (
        <button type="button" onClick={() => setTokenOpen(true)} className="flex h-9 w-full items-center justify-center gap-1.5 text-[13px] text-muted"><KeyRound size={14} /> 토큰으로 연결</button>
      )}
      {error ? <div className="text-[13px] text-danger" role="alert">{error}</div> : null}
    </div>
  );
}
