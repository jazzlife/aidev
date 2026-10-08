import { useCallback, useEffect, useState } from 'react';
import { GitBranch, MoreHorizontal, Plus, Search } from 'lucide-react';
import { useLocation, useParams } from 'react-router-dom';

import { api } from '@/modules/chat-core';
import { FilePeek } from '@m/components/FilePeek';
import { ConversationActions, type ConversationChange } from '@m/components/ConversationActions';
import { ProjectActions, type ProjectTarget } from '@m/components/ProjectActions';
import { GitSheet } from '@m/components/GitSheet';
import { ListSkeleton } from '@m/components/Skeleton';
import { TopBar } from '@m/components/TopBar';
import { setCurrentProject } from '@m/lib/current';
import { relativeTime } from '@m/lib/format';
import type { FileRef } from '@m/lib/peek';
import { useGo, useParent } from '@m/lib/nav';
import { useLongPress } from '@m/lib/useLongPress';
import { useRunningSessions } from '@m/lib/runningSessions';

type SessionItem = { id: string; provider?: string; summary?: string; lastActivity?: string };
const PAGE = 30;

/** One conversation row: tap opens it; long-press or ⋯ opens the conversation sheet. */
function SessionRow({ item, running, onOpen, onActions }: { item: SessionItem; /** the runtime is answering this conversation now */ running: boolean; onOpen: () => void; onActions: () => void }) {
  const press = useLongPress(onActions);
  return (
    <li className="border-b border-line flex items-stretch" data-running={running || undefined}>
      <button type="button" onClick={onOpen} {...press} className="flex-1 min-w-0 text-left pl-4 pr-1 py-3 active:bg-elevated">
        <div className="flex items-baseline gap-2">
          {running ? <span role="status" aria-label="응답 중" className="w-2 h-2 shrink-0 rounded-full self-center bg-accent m-pulse" /> : null}
          <span className="flex-1 min-w-0 truncate text-[15px]">{item.summary || '(제목 없음)'}</span>
          {running ? <span className="text-[11px] text-accent shrink-0">응답 중</span> : <span className="text-[11px] text-muted shrink-0">{relativeTime(item.lastActivity)}</span>}
        </div>
        <div className="text-[12px] text-muted uppercase tracking-wide mt-0.5">{item.provider ?? ''}</div>
      </button>
      <button type="button" aria-label="대화 메뉴" onClick={onActions} className="m-touch shrink-0 flex items-center justify-center px-2 text-muted active:bg-elevated"><MoreHorizontal size={18} /></button>
    </li>
  );
}

/**
 * One project: its conversations (newest first, more on demand), its files, and a new conversation in it.
 * The parent of every conversation of this project; its own parent is the project list.
 */
export function ProjectScreen() {
  const { projectId = '' } = useParams();
  const go = useGo();
  useParent('/projects');
  const passed = (useLocation().state as { project?: ProjectTarget } | null)?.project ?? null;
  const [project, setProject] = useState<ProjectTarget | null>(passed && passed.projectId === projectId ? passed : null);
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the conversation whose sheet is open, and whether the project's own sheet is
  const [conversationTarget, setConversationTarget] = useState<SessionItem | null>(null);
  const [projectSheet, setProjectSheet] = useState(false);
  // the git sheet (the project's changes, commit, push)
  const [gitSheet, setGitSheet] = useState(false);
  const [filePeek, setFilePeek] = useState<{ open: boolean; file: FileRef | null; fromSearch: boolean }>({ open: false, file: null, fromSearch: false });
  // conversations the runtime is answering now (polled while this screen is open)
  const running = useRunningSessions();

  // opened from a conversation or a link: the name and path come from the project list
  useEffect(() => {
    if (project) return;
    api.projects().then(async (response) => {
      const data = await response.json() as ProjectTarget[];
      const hit = Array.isArray(data) ? data.find((p) => p.projectId === projectId) : undefined;
      if (hit) setProject({ projectId: hit.projectId, displayName: hit.displayName, fullPath: hit.fullPath, isStarred: hit.isStarred });
      else setError('프로젝트를 찾지 못했습니다');
    }).catch(() => setError('프로젝트를 불러오지 못했습니다'));
  }, [project, projectId]);

  // the project on show is the one a new conversation starts in (the drawer's "현재 작업")
  useEffect(() => { if (project) setCurrentProject(project); }, [project]);

  const load = useCallback(async (offset: number) => {
    try {
      const response = await api.projectSessions(projectId, { limit: PAGE, offset });
      if (!response.ok) throw new Error(`대화를 불러오지 못했습니다 (${response.status})`);
      const page = await response.json() as { sessions?: SessionItem[]; sessionMeta?: { hasMore?: boolean } };
      setSessions((prev) => [...(offset ? prev ?? [] : []), ...(page.sessions ?? [])]);
      setHasMore(Boolean(page.sessionMeta?.hasMore));
    } catch (err) {
      setError(err instanceof Error ? err.message : '대화를 불러오지 못했습니다');
    }
  }, [projectId]);
  useEffect(() => { void load(0); }, [load]);

  const conversationChanged = (change: ConversationChange) => {
    if (change.kind === 'renamed') setSessions((list) => list?.map((s) => (s.id === change.sessionId ? { ...s, summary: change.title } : s)) ?? null);
    else if (change.kind === 'forked') go(`/session/${encodeURIComponent(change.forkId)}`);
    else setSessions((list) => list?.filter((s) => s.id !== change.sessionId) ?? null);
  };

  const newChat = () => {
    if (!project) return;
    go('/new', { state: { project } });
  };

  return (
    <div className="m-app">
      <TopBar
        title={project?.displayName ?? '프로젝트'}
        subtitle={project?.fullPath}
        back
        right={project ? (
          <>
            <button type="button" aria-label="파일 찾기" onClick={() => setFilePeek({ open: true, file: null, fromSearch: false })} className="m-touch flex items-center justify-center rounded-full text-muted"><Search size={19} /></button>
            <button type="button" aria-label="변경 사항" onClick={() => setGitSheet(true)} className="m-touch flex items-center justify-center rounded-full text-muted"><GitBranch size={19} /></button>
            <button type="button" aria-label="프로젝트 메뉴" onClick={() => setProjectSheet(true)} className="m-touch flex items-center justify-center rounded-full text-muted"><MoreHorizontal size={20} /></button>
          </>
        ) : null}
      />
      <main className="m-scroll flex-1 pb-24">
        {error ? <div className="p-4 text-danger text-sm">{error}</div> : null}
        {sessions === null && !error ? <ListSkeleton /> : null}
        {sessions && sessions.length === 0 ? <div className="p-6 text-center text-muted text-sm">이 프로젝트에 대화가 없습니다. 아래 + 로 시작하세요.</div> : null}
        <ul>
          {sessions?.map((s) => <SessionRow key={s.id} item={s} running={running.ids.has(s.id)} onOpen={() => go(`/session/${encodeURIComponent(s.id)}`)} onActions={() => setConversationTarget(s)} />)}
        </ul>
        {hasMore ? <button type="button" onClick={() => { void load(sessions?.length ?? 0); }} className="m-touch w-full py-3 text-[14px] text-accent">더 보기</button> : null}
      </main>
      {project ? (
        <button type="button" aria-label="이 프로젝트에서 새 대화" onClick={newChat} className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom)+20px)] w-14 h-14 rounded-full bg-accent text-accent-ink shadow-lg flex items-center justify-center">
          <Plus size={26} />
        </button>
      ) : null}
      <ConversationActions target={conversationTarget ? { sessionId: conversationTarget.id, title: conversationTarget.summary ?? '', provider: conversationTarget.provider } : null} onClose={() => setConversationTarget(null)} onChange={conversationChanged} />
      <ProjectActions target={projectSheet ? project : null} onClose={() => setProjectSheet(false)} onChange={(change) => { if (change.kind === 'removed') go('/projects'); else setProject(change.project); }} />
      <GitSheet open={gitSheet} onClose={() => setGitSheet(false)} project={project} provider="claude" />
      <FilePeek open={filePeek.open} onClose={() => setFilePeek({ open: false, file: null, fromSearch: false })} project={project ? { projectId: project.projectId, projectPath: project.fullPath } : null} file={filePeek.file} fromSearch={filePeek.fromSearch} onFile={(file) => setFilePeek({ open: true, file, fromSearch: file !== null })} />
    </div>
  );
}
