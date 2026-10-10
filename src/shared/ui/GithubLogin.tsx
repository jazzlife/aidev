import { useCallback, useEffect, useState } from 'react';
import { Copy, Github, KeyRound } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui/Button';
import { Input } from '@/shared/ui/Input';
import { copyTextToClipboard } from '@/shared/utils';

type OauthConfig = { configured: boolean; callbackUrl: string; homepageUrl: string; admin: boolean; clientId?: string | null };

type GithubLoginProps = {
  /** where GitHub sends the browser back (an app path on this origin, with the marker that reopens the caller) */
  returnTo: string;
  /** a token was connected without leaving the page */
  onConnected?: () => void;
  /** offer "토큰으로 연결" too (off where the caller has its own token form) */
  withTokenFallback?: boolean;
};

/**
 * Used by the project-creation-wizard module (clone tab) and the settings module (GitHub credentials): connects a
 * GitHub account — "GitHub로 로그인" (OAuth through the gateway; GitHub sends the browser back to `returnTo`), or a
 * pasted token as the fallback. Until an administrator registers the OAuth App, administrators get its setup here and
 * everyone else is told login is not set up yet. The workbench's twin of the mobile app's GithubLogin.
 */
export function GithubLogin({ returnTo, onConnected, withTokenFallback = true }: GithubLoginProps) {
  // whether OAuth login is set up (null: loading); decides which of the three blocks renders
  const [config, setConfig] = useState<OauthConfig | null>(null);
  // the fallback token form: open or not, and the token typed into it
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState('');
  // the administrator's OAuth App form
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // a request in flight, and the server's words when one failed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = (await (await api.githubOauth.config()).json()) as OauthConfig;
      setConfig(loaded);
      setClientId(loaded.clientId ?? '');
    } catch {
      setConfig({ configured: false, callbackUrl: '', homepageUrl: '', admin: false });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<Response>, after: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await readApiJson(await action());
      after();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : '실패했습니다');
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return <div className="text-sm text-muted-foreground">불러오는 중…</div>;
  }
  return (
    <div className="space-y-2" data-testid="github-login">
      {config.configured ? (
        <Button type="button" className="w-full" onClick={() => window.location.assign(api.githubOauth.startUrl(returnTo))}>
          <Github /> GitHub로 로그인
        </Button>
      ) : config.admin ? (
        <div className="space-y-2 rounded-lg border border-border p-3" data-testid="github-oauth-setup">
          <div className="text-sm font-medium">GitHub 로그인 설정 (관리자, 한 번)</div>
          <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
            <li>GitHub → Settings → Developer settings → OAuth Apps → New OAuth App</li>
            <li>Homepage URL: <button type="button" onClick={() => void copyTextToClipboard(config.homepageUrl)} className="inline-flex items-center gap-1 font-mono text-foreground">{config.homepageUrl} <Copy className="h-3 w-3" /></button></li>
            <li>Authorization callback URL: <button type="button" onClick={() => void copyTextToClipboard(config.callbackUrl)} className="inline-flex items-center gap-1 break-all text-left font-mono text-foreground">{config.callbackUrl} <Copy className="h-3 w-3" /></button></li>
            <li>만든 앱의 Client ID와 새로 만든 Client secret을 아래에 넣으세요.</li>
          </ol>
          <Input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Client ID" aria-label="Client ID" autoComplete="off" />
          <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="Client secret" aria-label="Client secret" autoComplete="off" />
          <Button
            type="button"
            className="w-full"
            disabled={busy || !clientId.trim() || !clientSecret.trim()}
            onClick={() => void run(
              () => api.githubOauth.save({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
              () => { setClientSecret(''); void load(); },
            )}
          >
            {busy ? '저장 중…' : '저장'}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          GitHub 로그인은 관리자가 설정하면 쓸 수 있습니다.{withTokenFallback ? ' 그동안은 토큰으로 연결하세요.' : ''}
        </div>
      )}
      {!withTokenFallback ? null : tokenOpen ? (
        <div className="space-y-2">
          <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ghp_… 또는 github_pat_…" aria-label="GitHub 토큰" autoComplete="off" />
          <div className="text-xs text-muted-foreground">GitHub → Settings → Developer settings → Personal access tokens에서 repo 권한으로 만든 토큰. 이 서버에만 저장됩니다.</div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy || !token.trim()}
            onClick={() => {
              const value = token.trim();
              void run(
                () => api.settings.createCredential({ credentialName: 'GitHub', credentialType: 'github_token', credentialValue: value, description: 'NadoVibe에서 연결' }),
                () => { setToken(''); setTokenOpen(false); onConnected?.(); },
              );
            }}
          >
            {busy ? '연결 중…' : '토큰으로 연결'}
          </Button>
        </div>
      ) : (
        <button type="button" onClick={() => setTokenOpen(true)} className="flex h-8 w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <KeyRound className="h-3.5 w-3.5" /> 토큰으로 연결
        </button>
      )}
      {error ? <div className="text-sm text-destructive" role="alert">{error}</div> : null}
    </div>
  );
}
