import { useEffect, useState } from 'react';
import { ChevronRight, FolderGit2, Settings, Star } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { HomeTabs } from '@m/components/HomeTabs';
import { RemoteMenu } from '@m/components/RemoteMenu';
import { TopBar } from '@m/components/TopBar';
import { relativeTime } from '@m/lib/format';
import { useGo, useParent } from '@m/lib/nav';

type ProjectItem = { projectId: string; displayName: string; fullPath: string; isStarred?: boolean; sessions?: Array<{ lastActivity?: string }>; sessionMeta?: { total?: number } };

/** Latest activity of a project: its newest conversation. */
const lastActivity = (p: ProjectItem) => p.sessions?.reduce((max, s) => (s.lastActivity && s.lastActivity > max ? s.lastActivity : max), '') ?? '';

/** Home tab "프로젝트": the runtime's projects, starred first, then by latest conversation. Back goes to "대화". */
export function ProjectsScreen() {
  const go = useGo();
  useParent('/');
  const [items, setItems] = useState<ProjectItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.projects().then(async (response) => {
      if (!response.ok) throw new Error(`프로젝트를 불러오지 못했습니다 (${response.status})`);
      const data = await response.json() as ProjectItem[];
      const list = Array.isArray(data) ? data : [];
      list.sort((a, b) => Number(Boolean(b.isStarred)) - Number(Boolean(a.isStarred)) || lastActivity(b).localeCompare(lastActivity(a)));
      setItems(list);
    }).catch((err: Error) => setError(err.message));
  }, []);
  return (
    <div className="m-app">
      <TopBar
        title={<HomeTabs active="projects" />}
        right={<div className="flex items-center"><RemoteMenu /><button type="button" aria-label="설정" onClick={() => go('/settings')} className="m-touch flex items-center justify-center rounded-full text-muted"><Settings size={20} /></button></div>}
      />
      <main className="m-scroll flex-1 pb-8">
        {error ? <div className="p-4 text-danger text-sm">{error}</div> : null}
        {items === null && !error ? <div className="p-4 text-muted text-sm m-pulse">불러오는 중…</div> : null}
        {items && items.length === 0 ? <div className="p-6 text-center text-muted text-sm">프로젝트가 없습니다. 작업대에서 먼저 만들어 주세요.</div> : null}
        <ul>
          {items?.map((p) => (
            <li key={p.projectId} className="border-b border-line">
              <button type="button" onClick={() => go(`/projects/${encodeURIComponent(p.projectId)}`, { state: { project: p } })} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-elevated">
                <FolderGit2 size={20} className="shrink-0 text-muted" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[15px]">{p.displayName}</span>
                    {p.isStarred ? <Star size={13} className="shrink-0 text-accent" fill="currentColor" /> : null}
                  </div>
                  <div className="text-[12px] text-muted truncate">
                    대화 {p.sessionMeta?.total ?? p.sessions?.length ?? 0}개{lastActivity(p) ? ` · ${relativeTime(lastActivity(p))}` : ''}
                  </div>
                </div>
                <ChevronRight size={18} className="shrink-0 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
