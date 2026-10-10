import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Link2, Lock, Search } from 'lucide-react';

import { api } from '@/shared/api';
import { Button, GithubLogin, Input } from '@/shared/ui';
import type { CloneSource } from '@/shared/types';
import { repoFolderName } from '@/shared/utils';

type Repo = { fullName: string; name: string; private: boolean; description: string | null; cloneUrl: string; pushedAt: string | null; archived: boolean; fork: boolean };
type RepoPage = { account: { login: string }; tokenId: number; tokens: Array<{ id: number; name: string }>; repos: Repo[]; page: number; hasMore: boolean };

const relativeTime = (value: string) => {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}일 전` : new Date(value).toLocaleDateString();
};

/**
 * Rendered by ProjectCreationWizard's clone tab: the repositories of the GitHub account connected on the runtime, newest
 * pushed first, searchable; picking one moves on to where it goes. Without a connected account it connects one here
 * (GitHub login, back to this tab). A typed address stays available for anything else.
 */
export default function RepoPicker({ onPick }: { onPick: (source: CloneSource) => void }) {
  // the account and the repositories loaded so far (null: not loaded yet)
  const [data, setData] = useState<RepoPage | null>(null);
  // no GitHub account connected yet: the connect block replaces the list
  const [notConnected, setNotConnected] = useState(false);
  // the typed address for "주소로 복제" (null: the list is shown)
  const [typedUrl, setTypedUrl] = useState<string | null>(null);
  // the filter typed over the list
  const [filter, setFilter] = useState('');
  // a request in flight, and what went wrong
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (tokenId?: number, page = 1) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.githubRepos({ tokenId, page });
      const text = await response.text();
      let body: { success?: boolean; data?: RepoPage; error?: { code?: string; message?: string } | string };
      // not JSON: the runtime does not know this API yet (an update still waiting for its restart)
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new Error('서버가 아직 이 기능을 모릅니다 — 업데이트가 적용되는 중일 수 있으니 잠시 뒤 다시 열어 주세요');
      }
      const code = typeof body.error === 'object' ? body.error?.code : undefined;
      if (code === 'GITHUB_NOT_CONNECTED' || code === 'GITHUB_TOKEN_INVALID') {
        setNotConnected(true);
        if (code === 'GITHUB_TOKEN_INVALID') setError(typeof body.error === 'object' ? body.error?.message ?? null : null);
        return;
      }
      if (!response.ok || !body.data) {
        throw new Error(typeof body.error === 'object' ? body.error?.message : body.error || `실패했습니다 (${response.status})`);
      }
      const next = body.data;
      setNotConnected(false);
      setData((current) => (page > 1 && current ? { ...next, repos: [...current.repos, ...next.repos] } : next));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '저장소 목록을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (typedUrl !== null) {
    const name = repoFolderName(typedUrl);
    return (
      <div className="space-y-2">
        <Input autoFocus value={typedUrl} onChange={(event) => setTypedUrl(event.target.value)} placeholder="https://github.com/사용자/저장소" aria-label="저장소 주소" autoComplete="off" />
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={() => setTypedUrl(null)}>목록으로</Button>
          <Button type="button" className="flex-1" disabled={!name} onClick={() => onPick({ url: typedUrl.trim(), label: name, tokenId: data?.tokenId ?? null, private: false })}>다음</Button>
        </div>
      </div>
    );
  }
  if (notConnected) {
    return (
      <div className="space-y-2" data-testid="github-connect">
        <p className="text-sm">GitHub 계정을 연결하면 저장소 목록에서 골라 복제합니다.</p>
        {error ? <div className="text-sm text-destructive" role="alert">{error}</div> : null}
        <GithubLogin returnTo={`${window.location.pathname}?add=clone`} onConnected={() => void load()} />
        <button type="button" onClick={() => setTypedUrl('')} className="flex h-8 w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <Link2 className="h-3.5 w-3.5" /> 공개 저장소 주소로 복제
        </button>
      </div>
    );
  }
  const query = filter.trim().toLowerCase();
  const shown = (data?.repos ?? []).filter((repo) => !query || repo.fullName.toLowerCase().includes(query) || repo.description?.toLowerCase().includes(query));
  return (
    <div className="space-y-2" data-testid="repo-picker">
      {data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <GitBranch className="h-4 w-4" /> <span className="min-w-0 flex-1 truncate">@{data.account.login}</span>
          {data.tokens.length > 1 ? (
            <select value={data.tokenId} onChange={(event) => { setData(null); void load(Number(event.target.value)); }} aria-label="GitHub 계정" className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground">
              {data.tokens.map((token) => <option key={token.id} value={token.id}>{token.name}</option>)}
            </select>
          ) : null}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="저장소 찾기" aria-label="저장소 찾기" autoComplete="off" className="pl-9" />
      </div>
      <ul className="max-h-72 overflow-y-auto rounded-lg border border-border" data-testid="repo-list">
        {!data && loading ? <li className="px-3 py-2 text-sm text-muted-foreground">저장소 불러오는 중…</li> : null}
        {data && shown.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">{query ? '맞는 저장소가 없습니다' : '저장소가 없습니다'}</li> : null}
        {shown.map((repo) => (
          <li key={repo.fullName} className="border-b border-border last:border-b-0">
            <button type="button" onClick={() => onPick({ url: repo.cloneUrl, label: repo.fullName, tokenId: data?.tokenId ?? null, private: repo.private })} className="w-full px-3 py-2 text-left hover:bg-accent">
              <span className="flex items-center gap-1.5 text-sm">
                <span className="min-w-0 truncate">{repo.fullName}</span>
                {repo.private ? <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="비공개" /> : null}
                {repo.archived ? <span className="shrink-0 text-[11px] text-muted-foreground">보관됨</span> : null}
              </span>
              {repo.description ? <span className="block truncate text-xs text-muted-foreground">{repo.description}</span> : null}
              {repo.pushedAt ? <span className="block text-[11px] text-muted-foreground">{relativeTime(repo.pushedAt)}</span> : null}
            </button>
          </li>
        ))}
        {data?.hasMore && !query ? (
          <li>
            <button type="button" disabled={loading} onClick={() => void load(data.tokenId, data.page + 1)} className="w-full py-2 text-sm text-primary disabled:text-muted-foreground">
              {loading ? '불러오는 중…' : '더 보기'}
            </button>
          </li>
        ) : null}
      </ul>
      {error ? <div className="text-sm text-destructive" role="alert">{error}</div> : null}
      <button type="button" onClick={() => setTypedUrl('')} className="flex h-8 w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <Link2 className="h-3.5 w-3.5" /> 다른 주소로 복제
      </button>
    </div>
  );
}
