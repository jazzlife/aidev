import { useEffect, useState } from 'react';
import { Archive, Pencil, Star, Trash2 } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { sheetButton } from '@m/components/ConversationActions';
import { forgetProject, readCurrentProject, setCurrentProject } from '@m/lib/current';
import { failureText, okJson } from '@m/lib/http';

/** The project a sheet acts on (the projects tab, or the project screen's ⋯). */
export type ProjectTarget = { projectId: string; displayName: string; fullPath: string; isStarred?: boolean };

/** What changed: the project as it is now, or that it left the list. */
export type ProjectChange = { kind: 'updated'; project: ProjectTarget } | { kind: 'removed'; projectId: string };

type View = 'menu' | 'rename' | 'remove' | 'purge';

/**
 * The one project sheet (C-12.3): star, rename (empty = the folder's name), and remove — from the list only (archived;
 * adding the same folder again brings it back) or with its conversation history. Neither deletes the folder: the
 * server's `force` removes the project row, its session rows and Claude's transcript files only.
 */
export function ProjectActions({ target, onClose, onChange }: { target: ProjectTarget | null; onClose: () => void; onChange: (change: ProjectChange) => void }) {
  // which part of the sheet is shown
  const [view, setView] = useState<View>('menu');
  // the name being typed in the rename view
  const [name, setName] = useState('');
  // one request at a time
  const [busy, setBusy] = useState(false);
  // the server's message when an action failed
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setView('menu'); setError(null); setBusy(false); setName(target?.displayName ?? ''); }, [target]);
  if (!target) return null;
  const id = target.projectId;

  const run = async (action: () => Promise<ProjectChange>) => {
    setBusy(true); setError(null);
    try {
      const change = await action();
      if (change.kind === 'removed') forgetProject(change.projectId);
      else if (readCurrentProject()?.projectId === id) setCurrentProject(change.project);
      onChange(change);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '실패했습니다');
    } finally {
      setBusy(false);
    }
  };
  const star = () => run(async () => {
    const body = await okJson<{ isStarred?: boolean }>(await api.toggleProjectStar(id));
    return { kind: 'updated', project: { ...target, isStarred: typeof body.isStarred === 'boolean' ? body.isStarred : !target.isStarred } };
  });
  const rename = () => run(async () => {
    const typed = name.trim();
    const response = await api.renameProject(id, typed);
    if (!response.ok) throw new Error(await failureText(response));
    const folder = target.fullPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || target.fullPath;
    return { kind: 'updated', project: { ...target, displayName: typed || folder } };
  });
  const remove = (purge: boolean) => run(async () => {
    const response = await api.deleteProject(id, purge);
    if (!response.ok) throw new Error(await failureText(response));
    return { kind: 'removed', projectId: id };
  });

  return (
    <BottomSheet open onClose={onClose} title={<span className="block truncate">{target.displayName}</span>}>
      <div data-testid="project-actions">
        {view === 'menu' ? (
          <div className="space-y-1">
            <button type="button" className={sheetButton} disabled={busy} onClick={() => { void star(); }}><Star size={18} fill={target.isStarred ? 'currentColor' : 'none'} /> {target.isStarred ? '즐겨찾기 해제' : '즐겨찾기'}</button>
            <button type="button" className={sheetButton} disabled={busy} onClick={() => setView('rename')}><Pencil size={18} /> 이름 변경</button>
            <button type="button" className={`${sheetButton} text-danger`} disabled={busy} onClick={() => setView('remove')}><Trash2 size={18} /> 제거</button>
          </div>
        ) : null}
        {view === 'rename' ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="프로젝트 이름" placeholder="비우면 폴더 이름" className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent" />
            <div className="flex gap-2">
              <button type="button" className="h-11 flex-1 rounded-xl border border-line text-[15px]" onClick={() => setView('menu')}>취소</button>
              <button type="submit" disabled={busy} className="h-11 flex-1 rounded-xl bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-40">저장</button>
            </div>
          </form>
        ) : null}
        {view === 'remove' ? (
          <div className="space-y-2">
            <p className="text-[13px] text-muted">폴더와 파일은 그대로 둡니다.</p>
            <button type="button" className={sheetButton} disabled={busy} onClick={() => { void remove(false); }}>
              <Archive size={18} /><span className="flex-1">목록에서 제거<span className="block text-[12px] text-muted">같은 폴더를 다시 추가하면 돌아옵니다</span></span>
            </button>
            <button type="button" className={`${sheetButton} text-danger`} disabled={busy} onClick={() => setView('purge')}>
              <Trash2 size={18} /><span className="flex-1">대화 기록까지 삭제<span className="block text-[12px] text-muted">되돌릴 수 없습니다</span></span>
            </button>
            <button type="button" className="w-full h-11 rounded-xl border border-line text-[15px]" onClick={() => setView('menu')}>취소</button>
          </div>
        ) : null}
        {view === 'purge' ? (
          <div className="space-y-3">
            <p className="text-[14px] text-muted">이 프로젝트의 대화 기록을 모두 영구 삭제합니다. 폴더는 지우지 않습니다.</p>
            <button type="button" className="w-full h-12 rounded-xl bg-danger text-white text-[15px] font-medium disabled:opacity-50" disabled={busy} onClick={() => { void remove(true); }}>{busy ? '삭제 중…' : '대화 기록까지 삭제'}</button>
            <button type="button" className="w-full h-12 rounded-xl border border-line text-[15px]" onClick={() => setView('remove')}>취소</button>
          </div>
        ) : null}
        {error ? <div className="mt-2 text-[13px] text-danger" role="alert">{error}</div> : null}
      </div>
    </BottomSheet>
  );
}
