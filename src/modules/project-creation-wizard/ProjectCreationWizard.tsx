import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Folder, FolderPlus, GitBranch, Lock, X } from 'lucide-react';

import ErrorBanner from '@/modules/project-creation-wizard/ErrorBanner';
import FolderBrowser from '@/modules/project-creation-wizard/FolderBrowser';
import RepoPicker from '@/modules/project-creation-wizard/RepoPicker';
import { api, readApiJson } from '@/shared/api';
import { useWorkspacesRoot } from '@/shared/hooks/useWorkspacesRoot';
import type { CloneSource } from '@/shared/types';
import { Button, Input } from '@/shared/ui';
import { cn, collapseWorkspacesRoot, joinFolderPath, repoFolderName } from '@/shared/utils';

type Tab = 'folder' | 'clone';
type ServerProject = { projectId?: string; isArchived?: boolean } & Record<string, unknown>;

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
  /** the tab it opens on (back from GitHub login: the clone tab) */
  initialTab?: Tab;
  /** a message on top (the GitHub login's outcome) */
  notice?: { text: string; error: boolean } | null;
};

/**
 * Rendered by the sidebar module's modal layer to add a project — the workbench's twin of the mobile app's add-project
 * sheet: a folder on the runtime (the server creates a missing one), or a clone of a repository picked from the
 * connected GitHub account (or a typed address) into a folder. A path removed earlier comes back archived from the
 * server, so it is restored here.
 */
export default function ProjectCreationWizard({ onClose, onProjectCreated, initialTab = 'folder', notice = null }: ProjectCreationWizardProps) {
  // which way the project is added
  const [tab, setTab] = useState<Tab>(initialTab);
  // the folder: added as is, or the one the clone goes into
  const [path, setPath] = useState('');
  // the folder tab's optional display name
  const [name, setName] = useState('');
  // the repository picked to clone (the clone tab's second step: where it goes)
  const [source, setSource] = useState<CloneSource | null>(null);
  // a request in flight, the clone's last progress line, and what went wrong
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspacesRoot = useWorkspacesRoot();
  const streamRef = useRef<EventSource | null>(null);

  const stopClone = () => {
    streamRef.current?.close();
    streamRef.current = null;
  };
  // closing ends the stream, which cancels the clone on the server
  const close = () => {
    stopClone();
    onClose();
  };
  useEffect(() => () => stopClone(), []);

  const finish = async (project: ServerProject | undefined) => {
    if (!project?.projectId) throw new Error('프로젝트 정보를 받지 못했습니다');
    if (project.isArchived) await readApiJson(await api.restoreProject(project.projectId));
    onProjectCreated?.(project);
    onClose();
  };

  const addFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await readApiJson<{ project?: ServerProject }>(
        await api.createProject({ path: path.trim(), ...(name.trim() ? { customName: name.trim() } : {}) }),
      );
      await finish(body.project);
    } catch (addError) {
      setBusy(false);
      setError(addError instanceof Error ? addError.message : '추가하지 못했습니다');
    }
  };

  const clone = () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    setProgress('복제를 시작합니다…');
    stopClone();
    const stream = new EventSource(api.cloneProjectProgressUrl({ path: path.trim(), githubUrl: source.url, githubTokenId: source.tokenId, newGithubToken: null }));
    streamRef.current = stream;
    const fail = (message: string) => {
      stopClone();
      setBusy(false);
      setProgress(null);
      setError(message);
    };
    stream.onmessage = (event) => {
      let payload: { type?: string; message?: string; project?: ServerProject };
      try {
        payload = JSON.parse(event.data as string) as typeof payload;
      } catch {
        return;
      }
      if (payload.type === 'progress' && payload.message) setProgress(payload.message);
      else if (payload.type === 'complete') {
        stopClone();
        void finish(payload.project).catch((finishError: Error) => fail(finishError.message));
      } else if (payload.type === 'error') fail(payload.message || '복제하지 못했습니다');
    };
    stream.onerror = () => {
      if (streamRef.current === stream) fail('복제 중 연결이 끊겼습니다');
    };
  };

  const folderName = source ? repoFolderName(source.url) : '';
  const canSubmit = !busy && Boolean(path.trim()) && (tab === 'folder' || Boolean(folderName));
  const tabButton = (key: Tab, label: string, icon: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      disabled={busy}
      onClick={() => { setTab(key); setError(null); }}
      className={cn(
        'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-sm transition-colors',
        tab === key ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="flex h-full w-full flex-col overflow-hidden border-border bg-card text-card-foreground shadow-xl sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <FolderPlus className="h-4 w-4 text-primary" />
            </div>
            <h3 className="text-lg font-semibold">프로젝트 추가</h3>
          </div>
          <button type="button" onClick={close} aria-label="닫기" className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5" data-testid="add-project">
          {notice ? (
            <div role="status" className={cn('rounded-lg px-3 py-2 text-sm', notice.error ? 'bg-destructive/10 text-destructive' : 'bg-green-500/10 text-green-600 dark:text-green-400')}>
              {notice.text}
            </div>
          ) : null}
          <div role="tablist" className="flex gap-1 rounded-lg bg-muted p-1">
            {tabButton('folder', '폴더', <Folder className="h-4 w-4" />)}
            {tabButton('clone', 'Git 복제', <GitBranch className="h-4 w-4" />)}
          </div>

          {tab === 'clone' && !source ? <RepoPicker onPick={(picked) => { setSource(picked); setError(null); }} /> : null}
          {tab === 'clone' && source ? (
            <>
              <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2" data-testid="clone-source">
                <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{source.label}</span>
                {source.private ? <Lock className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
                <button type="button" disabled={busy} onClick={() => setSource(null)} className="shrink-0 text-sm text-primary disabled:text-muted-foreground">바꾸기</button>
              </div>
              <div className="text-xs text-muted-foreground">어느 폴더에 둘까요? (들어가서 고르거나 새 폴더를 만드세요)</div>
            </>
          ) : null}
          {tab === 'folder' || source ? <FolderBrowser path={path} disabled={busy} onPath={setPath} /> : null}
          {tab === 'folder' ? (
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="표시 이름 (선택)" aria-label="표시 이름" disabled={busy} />
          ) : source && folderName && path ? (
            <div className="truncate font-mono text-xs text-muted-foreground" data-testid="clone-target" title={joinFolderPath(path, folderName)}>
              → {collapseWorkspacesRoot(joinFolderPath(path, folderName), workspacesRoot)}
            </div>
          ) : null}
          {progress ? <div className="truncate text-sm text-muted-foreground" role="status">{progress}</div> : null}
          {error ? <ErrorBanner message={error} /> : null}
        </div>

        {tab === 'clone' && !source ? null : (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={close}>취소</Button>
            <Button type="button" disabled={!canSubmit} onClick={() => { if (tab === 'folder') void addFolder(); else clone(); }}>
              {busy ? (tab === 'clone' ? '복제 중…' : '추가 중…') : tab === 'clone' ? '복제하고 추가' : '추가'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
