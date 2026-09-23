import { useEffect, useState } from 'react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';

export type PickedProject = { projectId: string; displayName: string; fullPath: string };
const KEY = 'm.project';

/** Used by ChatScreen to remember the project a new conversation starts in. */
export function readLastProject(): PickedProject | null {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) as PickedProject : null; } catch { return null; }
}

/** Used by ChatScreen: sheet listing the runtime's projects for a new conversation. */
export function ProjectPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (project: PickedProject) => void }) {
  const [projects, setProjects] = useState<PickedProject[] | null>(null);
  useEffect(() => {
    if (!open) return;
    api.projects().then(async (response) => {
      const data = await response.json() as Array<{ projectId: string; displayName: string; fullPath: string }>;
      setProjects(Array.isArray(data) ? data.map((project) => ({ projectId: project.projectId, displayName: project.displayName, fullPath: project.fullPath })) : []);
    }).catch(() => setProjects([]));
  }, [open]);
  return (
    <BottomSheet open={open} onClose={onClose} title="프로젝트">
      {projects === null ? <div className="text-muted m-pulse">불러오는 중…</div> : projects.length === 0 ? <div className="text-muted">프로젝트가 없습니다. 작업대에서 먼저 만들어 주세요.</div> : (
        <ul className="divide-y divide-line">
          {projects.map((project) => (
            <li key={project.projectId}>
              <button type="button" className="w-full text-left py-3" onClick={() => { try { localStorage.setItem(KEY, JSON.stringify(project)); } catch { /* ignore */ } onPick(project); }}>
                <div className="text-[15px]">{project.displayName}</div>
                <div className="text-[12px] text-muted truncate">{project.fullPath}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}
