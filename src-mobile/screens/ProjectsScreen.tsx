import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowLeft, FolderGit2, MoreHorizontal, Plus, Star } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { AddProjectSheet } from '@m/components/AddProjectSheet';
import { HomeTabs } from '@m/components/HomeTabs';
import { ProjectActions, type ProjectChange } from '@m/components/ProjectActions';
import { ListSkeleton } from '@m/components/Skeleton';
import { TopBar } from '@m/components/TopBar';
import { setCurrentProject } from '@m/lib/current';
import { relativeTime } from '@m/lib/format';
import { failureText, okJson } from '@m/lib/http';
import { useBackOverlay, useGo, useParent } from '@m/lib/nav';
import { takeGithubReturn } from '@m/lib/githubReturn';
import { useLongPress } from '@m/lib/useLongPress';
import { useRunningSessions } from '@m/lib/runningSessions';

type ProjectItem = { projectId: string; displayName: string; fullPath: string; isStarred?: boolean; sessions?: Array<{ lastActivity?: string }>; sessionMeta?: { total?: number } };

/** Latest activity of a project: its newest conversation. */
const lastActivity = (p: ProjectItem) => p.sessions?.reduce((max, s) => (s.lastActivity && s.lastActivity > max ? s.lastActivity : max), '') ?? '';
const byStarThenActivity = (a: ProjectItem, b: ProjectItem) => Number(Boolean(b.isStarred)) - Number(Boolean(a.isStarred)) || lastActivity(b).localeCompare(lastActivity(a));

/** One row: tap opens the project; long-press or ⋯ opens its sheet. */
function ProjectRow({ item, running, onOpen, onActions }: { item: ProjectItem; /** conversations of this project the runtime is answering now */ running: number; onOpen: () => void; onActions: () => void }) {
  const press = useLongPress(onActions);
  return (
    <li className="border-b border-line flex items-stretch" data-running={running || undefined}>
      <button type="button" onClick={onOpen} {...press} className="flex-1 min-w-0 flex items-center gap-3 pl-4 pr-1 py-3 text-left active:bg-elevated">
        <FolderGit2 size={20} className={`shrink-0 ${running ? 'text-accent' : 'text-muted'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px]">{item.displayName}</span>
            {item.isStarred ? <Star size={13} className="shrink-0 text-accent" fill="currentColor" /> : null}
            {running ? <span role="status" aria-label={`응답 중인 대화 ${running}개`} className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-accent"><span className="h-1.5 w-1.5 rounded-full bg-accent m-pulse" />응답 중{running > 1 ? ` ${running}` : ''}</span> : null}
          </div>
          <div className="text-[12px] text-muted truncate">
            대화 {item.sessionMeta?.total ?? item.sessions?.length ?? 0}개{lastActivity(item) ? ` · ${relativeTime(lastActivity(item))}` : ''}
          </div>
        </div>
      </button>
      <button type="button" aria-label="프로젝트 메뉴" onClick={onActions} className="m-touch shrink-0 flex items-center justify-center px-2 text-muted active:bg-elevated"><MoreHorizontal size={18} /></button>
    </li>
  );
}

/** One hidden (archived) project in the 보관함 list, with the button that puts it back in the projects tab. */
function HiddenProjectRow({ item, onRestore }: { item: ProjectItem; onRestore: () => Promise<void> }) {
  // one restore request at a time
  const [busy, setBusy] = useState(false);
  return (
    <li className="border-b border-line flex items-center gap-3 pl-4 pr-3 py-3">
      <FolderGit2 size={20} className="shrink-0 text-muted" />
      <div className="flex-1 min-w-0">
        <div className="truncate text-[15px]">{item.displayName}</div>
        <div className="text-[12px] text-muted truncate">{item.fullPath}</div>
      </div>
      <button type="button" disabled={busy} onClick={() => { setBusy(true); void onRestore().finally(() => setBusy(false)); }} className="h-9 shrink-0 rounded-xl border border-line px-3 text-[14px] disabled:opacity-40">복원</button>
    </li>
  );
}

/**
 * Home tab "프로젝트": the runtime's projects, starred first, then by latest conversation; + adds one; the archive
 * button lists hidden projects to restore. Back goes to "대화" (the hidden list closes first).
 */
export function ProjectsScreen() {
  const go = useGo();
  useParent('/');
  // the projects tab itself, or its 보관함 of hidden projects
  const [view, setView] = useState<'active' | 'hidden'>('active');
  useBackOverlay(view === 'hidden', () => setView('active'));
  const [items, setItems] = useState<ProjectItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // back from GitHub login (?add=clone&github=…): reopen the clone tab with the outcome
  const [cloneRequested] = useState(() => new URLSearchParams(window.location.search).get('add') === 'clone');
  const [githubNotice] = useState(takeGithubReturn);
  const [adding, setAdding] = useState(() => cloneRequested || Boolean(githubNotice));
  const [addTab] = useState<'folder' | 'clone'>(() => (adding ? 'clone' : 'folder'));
  // the project whose sheet is open (long-press or ⋯)
  const [target, setTarget] = useState<ProjectItem | null>(null);
  // projects with a conversation the runtime is answering now (polled while this screen is open)
  const running = useRunningSessions();
  const load = useCallback((which: 'active' | 'hidden') => {
    setItems(null); setError(null);
    const request = which === 'active'
      ? api.projects().then(async (response) => {
        if (!response.ok) throw new Error(`프로젝트를 불러오지 못했습니다 (${response.status})`);
        const data = await response.json() as ProjectItem[];
        return (Array.isArray(data) ? data : []).sort(byStarThenActivity);
      })
      : api.archivedProjects().then((response) => okJson<{ data?: { projects?: ProjectItem[] } }>(response)).then((body) => body.data?.projects ?? []);
    request.then(setItems).catch((err: Error) => setError(err.message));
  }, []);
  useEffect(() => { load(view); }, [load, view]);
  const restore = async (projectId: string) => {
    const response = await api.restoreProject(projectId);
    if (!response.ok) { setError(await failureText(response)); return; }
    setItems((list) => list?.filter((p) => p.projectId !== projectId) ?? null);
  };
  const changed = (change: ProjectChange) => setItems((list) => {
    if (!list) return list;
    if (change.kind === 'removed') return list.filter((p) => p.projectId !== change.projectId);
    return list.map((p) => (p.projectId === change.project.projectId ? { ...p, ...change.project } : p)).sort(byStarThenActivity);
  });
  const hidden = view === 'hidden';
  return (
    <div className="m-app">
      <TopBar
        title={hidden ? '숨긴 프로젝트' : <HomeTabs active="projects" />}
        left={hidden ? <button type="button" aria-label="프로젝트 목록" onClick={() => setView('active')} className="m-touch flex items-center justify-center rounded-full"><ArrowLeft size={20} /></button> : undefined}
        right={hidden ? null : <button type="button" aria-label="숨긴 프로젝트" onClick={() => setView('hidden')} className="m-touch flex items-center justify-center rounded-full text-muted"><Archive size={19} /></button>}
      />
      <main className="m-scroll flex-1 pb-24">
        {error ? <div className="p-4 text-danger text-sm">{error}</div> : null}
        {items === null && !error ? <ListSkeleton /> : null}
        {items && items.length === 0 ? <div className="p-6 text-center text-muted text-sm">{hidden ? '숨긴 프로젝트가 없습니다.' : '프로젝트가 없습니다. 아래 + 로 추가하세요.'}</div> : null}
        <ul>
          {hidden ? items?.map((p) => <HiddenProjectRow key={p.projectId} item={p} onRestore={() => restore(p.projectId)} />) : items?.map((p) => <ProjectRow key={p.projectId} item={p} running={running.byProject.get(p.projectId) ?? 0} onOpen={() => go(`/projects/${encodeURIComponent(p.projectId)}`, { state: { project: p } })} onActions={() => setTarget(p)} />)}
        </ul>
      </main>
      {!hidden ? (
        <button type="button" onClick={() => setAdding(true)} aria-label="프로젝트 추가" className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom)+20px)] w-14 h-14 rounded-full bg-accent text-accent-ink shadow-lg flex items-center justify-center">
          <Plus size={26} />
        </button>
      ) : null}
      <ProjectActions target={target} onClose={() => setTarget(null)} onChange={changed} />
      <AddProjectSheet open={adding} initialTab={addTab} notice={githubNotice} onClose={() => setAdding(false)} onAdded={(project) => { setAdding(false); setCurrentProject(project); go(`/projects/${encodeURIComponent(project.projectId)}`, { state: { project } }); }} />
    </div>
  );
}
