import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, FolderPlus, GitBranch, Link2, Lock, Search } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { GithubLogin } from '@m/components/GithubLogin';
import type { CurrentProject } from '@m/lib/current';
import { failureText as failure } from '@m/lib/http';
import { relativeTime } from '@m/lib/format';
import { useWorkspacesRoot } from '@/shared/hooks/useWorkspacesRoot';
import { collapseWorkspacesRoot, expandWorkspacesRoot } from '@/shared/utils';

type Suggestion = { name: string; path: string };
type ServerProject = CurrentProject & { isArchived?: boolean };
type Tab = 'folder' | 'clone';

const parentOf = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed.startsWith('/') ? '/' : trimmed;
};
const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}`;
/** The folder a clone lands in: the server takes the URL's last part, without `.git` and trailing slashes. */
export const repoFolderName = (url: string) => url.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? '';

/** The runtime's folders: ↑ to the parent, tap to enter, a new folder in the one shown; the path can also be typed. */
function FolderBrowser({ path, onPath }: { path: string; onPath: (path: string) => void }) {
  // the projects home (~): where the list starts, how paths print, what a typed ~/x expands against
  const root = useWorkspacesRoot();
  const [shown, setShown] = useState<string | null>(null);
  const [folders, setFolders] = useState<Suggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const browse = useCallback(async (target: string | null) => {
    setFolders(null); setError(null);
    try {
      const response = await api.browseFilesystem(target);
      if (!response.ok) throw new Error(await failure(response));
      const body = await response.json() as { path?: string; suggestions?: Suggestion[] };
      const at = body.path || target || '';
      setShown(at);
      setFolders(body.suggestions ?? []);
      onPath(at);
    } catch (err) {
      setError(err instanceof Error ? err.message : '폴더를 불러오지 못했습니다');
      setFolders([]);
    }
  }, [onPath]);
  // the first look only: later moves come from taps
  const first = useRef(path);
  useEffect(() => { void browse(first.current || null); }, [browse]);
  const create = async () => {
    const name = newName?.trim();
    if (!name || !shown) return;
    try {
      const response = await api.createFolder(join(shown, name));
      if (!response.ok) throw new Error(await failure(response));
      const body = await response.json() as { path?: string };
      setNewName(null);
      await browse(body.path || join(shown, name));
    } catch (err) {
      setError(err instanceof Error ? err.message : '폴더를 만들지 못했습니다');
    }
  };
  return (
    <div className="space-y-2">
      <input value={collapseWorkspacesRoot(path, root)} onChange={(e) => onPath(expandWorkspacesRoot(e.target.value, root))} onBlur={() => { if (path && path !== shown) void browse(path); }} placeholder="~/폴더" aria-label="경로"
        className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] font-mono outline-none focus:border-accent" />
      <div className="rounded-xl border border-line">
        <div className="flex items-center border-b border-line">
          <button type="button" aria-label="상위 폴더" disabled={!shown || parentOf(shown) === shown} onClick={() => { if (shown) void browse(parentOf(shown)); }} className="m-touch flex items-center justify-center text-muted disabled:opacity-30"><ArrowUp size={18} /></button>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{shown ? collapseWorkspacesRoot(shown, root) : ''}</span>
          <button type="button" aria-label="새 폴더" onClick={() => setNewName('')} className="m-touch flex items-center justify-center text-muted"><FolderPlus size={18} /></button>
        </div>
        {newName !== null ? (
          <div className="flex gap-2 border-b border-line p-2">
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 폴더 이름" aria-label="새 폴더 이름" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 text-[15px] outline-none" />
            <button type="button" onClick={() => { void create(); }} disabled={!newName.trim()} className="h-10 rounded-lg bg-accent px-3 text-[14px] text-accent-ink disabled:opacity-40">만들기</button>
          </div>
        ) : null}
        <ul className="max-h-[32dvh] overflow-y-auto" data-testid="folder-list">
          {folders === null ? <li className="px-3 py-2 text-[13px] text-muted m-pulse">불러오는 중…</li> : null}
          {folders?.length === 0 && !error ? <li className="px-3 py-2 text-[13px] text-muted">하위 폴더가 없습니다</li> : null}
          {folders?.map((folder) => (
            <li key={folder.path}>
              <button type="button" onClick={() => { void browse(folder.path); }} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[14px] active:bg-elevated">
                <Folder size={16} className="shrink-0 text-muted" /><span className="truncate">{folder.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {error ? <div className="text-[13px] text-danger">{error}</div> : null}
    </div>
  );
}

type Repo = { fullName: string; name: string; private: boolean; description: string | null; cloneUrl: string; pushedAt: string | null; archived: boolean; fork: boolean };
type RepoPage = { account: { login: string }; tokenId: number; tokens: Array<{ id: number; name: string }>; repos: Repo[]; page: number; hasMore: boolean };
/** What is cloned: a repository picked from the account (with its token) or a typed address. */
type CloneSource = { url: string; label: string; tokenId: number | null; private: boolean };

/**
 * The repositories of the GitHub account connected on the runtime, newest pushed first, searchable; picking one moves
 * on to where it goes. Without a connected account it connects one here (the token is stored on the runtime like the
 * workbench's, and used for private repositories). A typed address stays available for anything else.
 */
function RepoPicker({ onPick }: { onPick: (source: CloneSource) => void }) {
  // the account and the repositories loaded so far (null: loading)
  const [data, setData] = useState<RepoPage | null>(null);
  // no GitHub account connected yet (show the connect form)
  const [notConnected, setNotConnected] = useState(false);
  // the typed address for "주소로 복제"
  const [typedUrl, setTypedUrl] = useState<string | null>(null);
  // the filter typed over the list
  const [filter, setFilter] = useState('');
  // a request in flight, and what went wrong
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (tokenId?: number, page = 1) => {
    setLoading(true); setError(null);
    try {
      const response = await api.githubRepos({ tokenId, page });
      const text = await response.text();
      let body: { success?: boolean; data?: RepoPage; error?: { code?: string; message?: string } | string };
      // not JSON: the runtime does not know this API yet (an update still waiting for its restart)
      try { body = JSON.parse(text) as typeof body; } catch { throw new Error('서버가 아직 이 기능을 모릅니다 — 업데이트가 적용되는 중일 수 있으니 잠시 뒤 다시 열어 주세요'); }
      const code = typeof body.error === 'object' ? body.error?.code : undefined;
      if (code === 'GITHUB_NOT_CONNECTED' || code === 'GITHUB_TOKEN_INVALID') {
        setNotConnected(true);
        if (code === 'GITHUB_TOKEN_INVALID') setError(typeof body.error === 'object' ? body.error?.message ?? null : null);
        return;
      }
      if (!response.ok || !body.data) throw new Error(typeof body.error === 'object' ? body.error?.message : body.error || `실패했습니다 (${response.status})`);
      const next = body.data;
      setNotConnected(false);
      setData((current) => (page > 1 && current ? { ...next, repos: [...current.repos, ...next.repos] } : next));
    } catch (err) {
      setError(err instanceof Error ? err.message : '저장소 목록을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);



  const field = 'w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent';
  if (typedUrl !== null) {
    const name = repoFolderName(typedUrl);
    return (
      <div className="space-y-2">
        <input autoFocus value={typedUrl} onChange={(e) => setTypedUrl(e.target.value)} placeholder="https://github.com/사용자/저장소" aria-label="저장소 주소" autoCapitalize="off" autoCorrect="off" inputMode="url" className={field} />
        <div className="flex gap-2">
          <button type="button" onClick={() => setTypedUrl(null)} className="h-11 flex-1 rounded-xl border border-line text-[15px]">목록으로</button>
          <button type="button" disabled={!name} onClick={() => onPick({ url: typedUrl.trim(), label: name, tokenId: data?.tokenId ?? null, private: false })} className="h-11 flex-1 rounded-xl bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-40">다음</button>
        </div>
      </div>
    );
  }
  if (notConnected) {
    return (
      <div className="space-y-2" data-testid="github-connect">
        <p className="text-[14px]">GitHub 계정을 연결하면 저장소 목록에서 골라 복제합니다.</p>
        {error ? <div className="text-[13px] text-danger" role="alert">{error}</div> : null}
        <GithubLogin returnTo="/m/projects?add=clone" onConnected={() => { void load(); }} />
        <button type="button" onClick={() => setTypedUrl('')} className="flex h-10 w-full items-center justify-center gap-1.5 text-[13px] text-muted"><Link2 size={14} /> 공개 저장소 주소로 복제</button>
      </div>
    );
  }
  const q = filter.trim().toLowerCase();
  const shown = (data?.repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q));
  return (
    <div className="space-y-2" data-testid="repo-picker">
      {data ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <GitBranch size={14} /> <span className="min-w-0 flex-1 truncate">@{data.account.login}</span>
          {data.tokens.length > 1 ? (
            <select value={data.tokenId} onChange={(e) => { setData(null); void load(Number(e.target.value)); }} aria-label="GitHub 계정" className="h-8 rounded-lg border border-line bg-bg px-2 text-[13px] text-ink">
              {data.tokens.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          ) : null}
        </div>
      ) : null}
      <div className="flex h-10 items-center gap-2 rounded-xl border border-line bg-bg px-3">
        <Search size={15} className="shrink-0 text-muted" />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="저장소 찾기" aria-label="저장소 찾기" autoCapitalize="off" autoCorrect="off" className="min-w-0 flex-1 bg-transparent text-[15px] outline-none" />
      </div>
      <ul className="max-h-[42dvh] overflow-y-auto rounded-xl border border-line" data-testid="repo-list">
        {!data && loading ? <li className="px-3 py-2 text-[13px] text-muted m-pulse">저장소 불러오는 중…</li> : null}
        {data && shown.length === 0 ? <li className="px-3 py-2 text-[13px] text-muted">{q ? '맞는 저장소가 없습니다' : '저장소가 없습니다'}</li> : null}
        {shown.map((repo) => (
          <li key={repo.fullName} className="border-b border-line last:border-b-0">
            <button type="button" onClick={() => onPick({ url: repo.cloneUrl, label: repo.fullName, tokenId: data?.tokenId ?? null, private: repo.private })} className="w-full px-3 py-2.5 text-left active:bg-elevated">
              <span className="flex items-center gap-1.5 text-[14px]"><span className="min-w-0 truncate">{repo.fullName}</span>{repo.private ? <Lock size={12} className="shrink-0 text-muted" aria-label="비공개" /> : null}{repo.archived ? <span className="shrink-0 text-[11px] text-muted">보관됨</span> : null}</span>
              {repo.description ? <span className="block truncate text-[12px] text-muted">{repo.description}</span> : null}
              {repo.pushedAt ? <span className="block text-[11px] text-muted">{relativeTime(repo.pushedAt)}</span> : null}
            </button>
          </li>
        ))}
        {data?.hasMore && !q ? <li><button type="button" disabled={loading} onClick={() => { void load(data.tokenId, data.page + 1); }} className="w-full py-2 text-[13px] text-accent disabled:text-muted">{loading ? '불러오는 중…' : '더 보기'}</button></li> : null}
      </ul>
      {error ? <div className="text-[13px] text-danger" role="alert">{error}</div> : null}
      <button type="button" onClick={() => setTypedUrl('')} className="flex h-9 w-full items-center justify-center gap-1.5 text-[13px] text-muted"><Link2 size={14} /> 다른 주소로 복제</button>
    </div>
  );
}

/**
 * Used by the projects tab (+): adds a project from a folder on the runtime (the server creates a missing one) or by
 * cloning a Git repository there. A path that was removed earlier comes back archived from the server, so it is
 * restored here. On success the project becomes the current one (`onAdded`).
 */
export function AddProjectSheet({ open, onClose, onAdded, initialTab = 'folder', notice }: {
  open: boolean; onClose: () => void; onAdded: (project: CurrentProject) => void;
  /** opened to a tab (back from GitHub login: the clone tab) */ initialTab?: Tab;
  /** a message to show on top (the GitHub login's outcome) */ notice?: { text: string; error: boolean } | null;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const workspacesRoot = useWorkspacesRoot();
  // the repository picked to clone (the clone tab's second step: where it goes)
  const [source, setSource] = useState<CloneSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const stopClone = () => { sourceRef.current?.close(); sourceRef.current = null; };
  // closing the sheet ends the stream, which cancels the clone on the server
  const close = () => { stopClone(); setBusy(false); setProgress(null); setError(null); setSource(null); onClose(); };
  useEffect(() => () => stopClone(), []);

  const finish = async (project: ServerProject | undefined) => {
    if (!project?.projectId) throw new Error('프로젝트 정보를 받지 못했습니다');
    if (project.isArchived) {
      const restored = await api.restoreProject(project.projectId);
      if (!restored.ok) throw new Error(await failure(restored));
    }
    setBusy(false);
    onAdded({ projectId: project.projectId, displayName: project.displayName, fullPath: project.fullPath });
  };

  const addFolder = async () => {
    if (!path.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await api.createProject({ path: path.trim(), ...(name.trim() ? { customName: name.trim() } : {}) });
      if (!response.ok) throw new Error(await failure(response));
      const body = await response.json() as { project?: ServerProject };
      await finish(body.project);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : '추가하지 못했습니다');
    }
  };

  const clone = () => {
    if (!path.trim() || !source) return;
    setBusy(true); setError(null); setProgress('복제를 시작합니다…');
    stopClone();
    const stream = new EventSource(api.cloneProjectProgressUrl({ path: path.trim(), githubUrl: source.url, githubTokenId: source.tokenId, newGithubToken: null }));
    sourceRef.current = stream;
    stream.onmessage = (event) => {
      let payload: { type?: string; message?: string; project?: ServerProject };
      try { payload = JSON.parse(event.data as string) as typeof payload; } catch { return; }
      if (payload.type === 'progress' && payload.message) setProgress(payload.message);
      else if (payload.type === 'complete') { stopClone(); void finish(payload.project).catch((err: Error) => { setBusy(false); setError(err.message); }); }
      else if (payload.type === 'error') { stopClone(); setBusy(false); setProgress(null); setError(payload.message || '복제하지 못했습니다'); }
    };
    stream.onerror = () => {
      if (sourceRef.current !== stream) return;
      stopClone(); setBusy(false); setProgress(null); setError('복제 중 연결이 끊겼습니다');
    };
  };

  const folderName = source ? repoFolderName(source.url) : '';
  const tabButton = (key: Tab, label: string, icon: React.ReactNode) => (
    <button type="button" role="tab" aria-selected={tab === key} disabled={busy} onClick={() => { setTab(key); setError(null); }}
      className={`flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg text-[14px] ${tab === key ? 'bg-surface font-medium shadow-sm' : 'text-muted'}`}>{icon}{label}</button>
  );
  return (
    <BottomSheet open={open} onClose={close} title="프로젝트 추가">
      <div className="space-y-3" data-testid="add-project">
        {notice ? <div className={`rounded-lg px-3 py-2 text-[13px] ${notice.error ? 'bg-danger/10 text-danger' : 'bg-ok/10 text-ok'}`} role="status">{notice.text}</div> : null}
        <div role="tablist" className="flex gap-1 rounded-xl bg-elevated p-1">{tabButton('folder', '폴더', <Folder size={15} />)}{tabButton('clone', 'Git 복제', <GitBranch size={15} />)}</div>
        {tab === 'clone' && !source ? <RepoPicker onPick={(picked) => { setSource(picked); setError(null); }} /> : null}
        {tab === 'clone' && source ? (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-bg px-3 py-2" data-testid="clone-source">
            <GitBranch size={15} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-[14px]">{source.label}</span>
            {source.private ? <Lock size={12} className="shrink-0 text-muted" /> : null}
            <button type="button" disabled={busy} onClick={() => setSource(null)} className="shrink-0 text-[13px] text-accent disabled:text-muted">바꾸기</button>
          </div>
        ) : null}
        {tab === 'clone' && source ? <div className="text-[12px] text-muted">어느 폴더에 둘까요? (들어가서 고르거나 새 폴더를 만드세요)</div> : null}
        {tab === 'folder' || source ? <FolderBrowser path={path} onPath={setPath} /> : null}
        {tab === 'folder' ? (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="표시 이름 (선택)" aria-label="표시 이름"
            className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent" />
        ) : source && folderName && path ? <div className="truncate text-[12px] text-muted font-mono" data-testid="clone-target">→ {collapseWorkspacesRoot(join(path, folderName), workspacesRoot)}</div> : null}
        {progress ? <div className="truncate text-[13px] text-muted m-pulse" role="status">{progress}</div> : null}
        {error ? <div className="text-[13px] text-danger" role="alert">{error}</div> : null}
        {tab === 'clone' && !source ? null : <button type="button" disabled={busy || !path.trim() || (tab === 'clone' && !folderName)} onClick={() => { if (tab === 'folder') void addFolder(); else clone(); }}
          className="w-full h-12 rounded-xl bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-40">
          {busy ? (tab === 'clone' ? '복제 중…' : '추가 중…') : tab === 'clone' ? '복제하고 추가' : '추가'}
        </button>}
      </div>
    </BottomSheet>
  );
}
