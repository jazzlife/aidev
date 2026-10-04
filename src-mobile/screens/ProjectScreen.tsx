import { useCallback, useEffect, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useLocation, useParams } from 'react-router-dom';

import { api } from '@/modules/chat-core';
import { FilePeek } from '@m/components/FilePeek';
import type { PickedProject } from '@m/components/ProjectPicker';
import { ListSkeleton } from '@m/components/Skeleton';
import { TopBar } from '@m/components/TopBar';
import { setCurrentProject } from '@m/lib/current';
import { relativeTime } from '@m/lib/format';
import type { FileRef } from '@m/lib/peek';
import { useGo, useParent } from '@m/lib/nav';

type SessionItem = { id: string; provider?: string; summary?: string; lastActivity?: string };
const PAGE = 30;

/**
 * One project: its conversations (newest first, more on demand), its files, and a new conversation in it.
 * The parent of every conversation of this project; its own parent is the project list.
 */
export function ProjectScreen() {
  const { projectId = '' } = useParams();
  const go = useGo();
  useParent('/projects');
  const passed = (useLocation().state as { project?: PickedProject } | null)?.project ?? null;
  const [project, setProject] = useState<PickedProject | null>(passed && passed.projectId === projectId ? passed : null);
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filePeek, setFilePeek] = useState<{ open: boolean; file: FileRef | null; fromSearch: boolean }>({ open: false, file: null, fromSearch: false });

  // opened from a conversation or a link: the name and path come from the project list
  useEffect(() => {
    if (project) return;
    api.projects().then(async (response) => {
      const data = await response.json() as PickedProject[];
      const hit = Array.isArray(data) ? data.find((p) => p.projectId === projectId) : undefined;
      if (hit) setProject({ projectId: hit.projectId, displayName: hit.displayName, fullPath: hit.fullPath });
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
        right={project ? <button type="button" aria-label="파일 찾기" onClick={() => setFilePeek({ open: true, file: null, fromSearch: false })} className="m-touch flex items-center justify-center rounded-full text-muted"><Search size={19} /></button> : null}
      />
      <main className="m-scroll flex-1 pb-24">
        {error ? <div className="p-4 text-danger text-sm">{error}</div> : null}
        {sessions === null && !error ? <ListSkeleton /> : null}
        {sessions && sessions.length === 0 ? <div className="p-6 text-center text-muted text-sm">이 프로젝트에 대화가 없습니다. 아래 + 로 시작하세요.</div> : null}
        <ul>
          {sessions?.map((s) => (
            <li key={s.id} className="border-b border-line">
              <button type="button" onClick={() => go(`/session/${encodeURIComponent(s.id)}`)} className="w-full text-left px-4 py-3 active:bg-elevated">
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 min-w-0 truncate text-[15px]">{s.summary || '(제목 없음)'}</span>
                  <span className="text-[11px] text-muted shrink-0">{relativeTime(s.lastActivity)}</span>
                </div>
                <div className="text-[12px] text-muted uppercase tracking-wide mt-0.5">{s.provider ?? ''}</div>
              </button>
            </li>
          ))}
        </ul>
        {hasMore ? <button type="button" onClick={() => { void load(sessions?.length ?? 0); }} className="m-touch w-full py-3 text-[14px] text-accent">더 보기</button> : null}
      </main>
      {project ? (
        <button type="button" aria-label="이 프로젝트에서 새 대화" onClick={newChat} className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom)+20px)] w-14 h-14 rounded-full bg-accent text-accent-ink shadow-lg flex items-center justify-center">
          <Plus size={26} />
        </button>
      ) : null}
      <FilePeek open={filePeek.open} onClose={() => setFilePeek({ open: false, file: null, fromSearch: false })} project={project ? { projectId: project.projectId, projectPath: project.fullPath } : null} file={filePeek.file} fromSearch={filePeek.fromSearch} onFile={(file) => setFilePeek({ open: true, file, fromSearch: file !== null })} />
    </div>
  );
}
