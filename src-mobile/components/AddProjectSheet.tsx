import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, FolderPlus, GitBranch } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import type { CurrentProject } from '@m/lib/current';
import { failureText as failure } from '@m/lib/http';

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
      <input value={path} onChange={(e) => onPath(e.target.value)} onBlur={() => { if (path && path !== shown) void browse(path); }} placeholder="/경로/폴더" aria-label="경로"
        className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] font-mono outline-none focus:border-accent" />
      <div className="rounded-xl border border-line">
        <div className="flex items-center border-b border-line">
          <button type="button" aria-label="상위 폴더" disabled={!shown || parentOf(shown) === shown} onClick={() => { if (shown) void browse(parentOf(shown)); }} className="m-touch flex items-center justify-center text-muted disabled:opacity-30"><ArrowUp size={18} /></button>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{shown ?? ''}</span>
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

/**
 * Used by the projects tab (+): adds a project from a folder on the runtime (the server creates a missing one) or by
 * cloning a Git repository there. A path that was removed earlier comes back archived from the server, so it is
 * restored here. On success the project becomes the current one (`onAdded`).
 */
export function AddProjectSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (project: CurrentProject) => void }) {
  const [tab, setTab] = useState<Tab>('folder');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [tokens, setTokens] = useState<Array<{ id: number; credential_name: string }>>([]);
  const [tokenId, setTokenId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const stopClone = () => { sourceRef.current?.close(); sourceRef.current = null; };
  // closing the sheet ends the stream, which cancels the clone on the server
  const close = () => { stopClone(); setBusy(false); setProgress(null); setError(null); onClose(); };
  useEffect(() => () => stopClone(), []);
  useEffect(() => {
    if (!open || tab !== 'clone') return;
    api.settings.credentials('github_token').then(async (response) => {
      const body = await response.json() as { credentials?: Array<{ id: number; credential_name: string; is_active: boolean }> };
      const active = (body.credentials ?? []).filter((c) => c.is_active);
      setTokens(active);
      setTokenId((current) => current || (active[0] ? String(active[0].id) : ''));
    }).catch(() => setTokens([]));
  }, [open, tab]);

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
    if (!path.trim() || !repo.trim()) return;
    setBusy(true); setError(null); setProgress('복제를 시작합니다…');
    stopClone();
    const source = new EventSource(api.cloneProjectProgressUrl({ path: path.trim(), githubUrl: repo.trim(), githubTokenId: tokenId || null, newGithubToken: null }));
    sourceRef.current = source;
    source.onmessage = (event) => {
      let payload: { type?: string; message?: string; project?: ServerProject };
      try { payload = JSON.parse(event.data as string) as typeof payload; } catch { return; }
      if (payload.type === 'progress' && payload.message) setProgress(payload.message);
      else if (payload.type === 'complete') { stopClone(); void finish(payload.project).catch((err: Error) => { setBusy(false); setError(err.message); }); }
      else if (payload.type === 'error') { stopClone(); setBusy(false); setProgress(null); setError(payload.message || '복제하지 못했습니다'); }
    };
    source.onerror = () => {
      if (sourceRef.current !== source) return;
      stopClone(); setBusy(false); setProgress(null); setError('복제 중 연결이 끊겼습니다');
    };
  };

  const folderName = repoFolderName(repo);
  const tabButton = (key: Tab, label: string, icon: React.ReactNode) => (
    <button type="button" role="tab" aria-selected={tab === key} disabled={busy} onClick={() => { setTab(key); setError(null); }}
      className={`flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg text-[14px] ${tab === key ? 'bg-surface font-medium shadow-sm' : 'text-muted'}`}>{icon}{label}</button>
  );
  return (
    <BottomSheet open={open} onClose={close} title="프로젝트 추가">
      <div className="space-y-3" data-testid="add-project">
        <div role="tablist" className="flex gap-1 rounded-xl bg-elevated p-1">{tabButton('folder', '폴더', <Folder size={15} />)}{tabButton('clone', 'Git 복제', <GitBranch size={15} />)}</div>
        {tab === 'clone' ? (
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/사용자/저장소" aria-label="저장소 주소" autoCapitalize="off" autoCorrect="off" inputMode="url"
            className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent" />
        ) : null}
        {tab === 'clone' ? <div className="text-[12px] text-muted">복제할 위치</div> : null}
        <FolderBrowser path={path} onPath={setPath} />
        {tab === 'folder' ? (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="표시 이름 (선택)" aria-label="표시 이름"
            className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent" />
        ) : (
          <>
            {folderName && path ? <div className="truncate text-[12px] text-muted font-mono" data-testid="clone-target">→ {join(path, folderName)}</div> : null}
            {tokens.length ? (
              <label className="flex items-center gap-2 text-[13px] text-muted">GitHub 토큰
                <select value={tokenId} onChange={(e) => setTokenId(e.target.value)} className="h-9 flex-1 rounded-lg border border-line bg-bg px-2 text-[14px] text-ink">
                  <option value="">없음 (공개 저장소)</option>
                  {tokens.map((t) => <option key={t.id} value={String(t.id)}>{t.credential_name}</option>)}
                </select>
              </label>
            ) : <div className="text-[12px] text-muted">비공개 저장소는 작업대 설정에서 GitHub 토큰을 저장한 뒤 복제하세요.</div>}
          </>
        )}
        {progress ? <div className="truncate text-[13px] text-muted m-pulse" role="status">{progress}</div> : null}
        {error ? <div className="text-[13px] text-danger" role="alert">{error}</div> : null}
        <button type="button" disabled={busy || !path.trim() || (tab === 'clone' && !folderName)} onClick={() => { if (tab === 'folder') void addFolder(); else clone(); }}
          className="w-full h-12 rounded-xl bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-40">
          {busy ? (tab === 'clone' ? '복제 중…' : '추가 중…') : tab === 'clone' ? '복제하고 추가' : '추가'}
        </button>
      </div>
    </BottomSheet>
  );
}
