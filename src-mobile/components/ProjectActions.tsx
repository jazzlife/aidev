import { useEffect, useState } from 'react';
import { Archive, BookmarkMinus, FolderX, Pencil, Star, Trash2 } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { sheetButton } from '@m/components/ConversationActions';
import { forgetProject, readCurrentProject, setCurrentProject } from '@m/lib/current';
import { failureText, okJson } from '@m/lib/http';

/** The project a sheet acts on (the projects tab, or the project screen's ⋯). */
export type ProjectTarget = { projectId: string; displayName: string; fullPath: string; isStarred?: boolean };

/** What changed: the project as it is now, or that it left the list. */
export type ProjectChange = { kind: 'updated'; project: ProjectTarget } | { kind: 'removed'; projectId: string };

type View = 'menu' | 'rename' | 'remove' | 'folder';

/**
 * The one project sheet (C-12.3): star, rename (empty = the folder's name), hide (archived; the projects tab's 보관함
 * restores it), and delete — the bookmark only (the server's `force`: the project row, its session rows and Claude's
 * transcript files; the folder and its repository stay) or the folder too (`deleteFolder`, behind a second step).
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
  const remove = (mode: 'archive' | 'bookmark' | 'folder') => run(async () => {
    const response = await api.deleteProject(id, mode !== 'archive', mode === 'folder');
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
            <button type="button" className={sheetButton} disabled={busy} onClick={() => { void remove('archive'); }}>
              <Archive size={18} /><span className="flex-1">숨기기<span className="block text-[12px] text-muted">보관함에서 언제든 복원합니다</span></span>
            </button>
            <button type="button" className={`${sheetButton} text-danger`} disabled={busy} onClick={() => setView('remove')}><Trash2 size={18} /> 삭제</button>
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
            <p className="text-[13px] text-muted">무엇을 지울까요?</p>
            <button type="button" className={sheetButton} disabled={busy} onClick={() => { void remove('bookmark'); }}>
              <BookmarkMinus size={18} /><span className="flex-1">북마크만 삭제<span className="block text-[12px] text-muted">목록과 대화 기록만 지웁니다. 폴더와 저장소는 그대로 둡니다</span></span>
            </button>
            <button type="button" className={`${sheetButton} text-danger`} disabled={busy} onClick={() => setView('folder')}>
              <FolderX size={18} /><span className="flex-1">폴더까지 삭제<span className="block text-[12px] text-muted">디스크에서 폴더를 지웁니다. 되돌릴 수 없습니다</span></span>
            </button>
            <button type="button" className="w-full h-11 rounded-xl border border-line text-[15px]" onClick={() => setView('menu')}>취소</button>
          </div>
        ) : null}
        {view === 'folder' ? (
          <div className="space-y-3">
            <p className="text-[14px] text-muted">이 폴더와 그 안의 모든 파일을 디스크에서 영구 삭제합니다. 커밋·푸시하지 않은 변경은 되돌릴 수 없습니다. GitHub 같은 원격 저장소는 지우지 않습니다.</p>
            <p className="break-all font-mono text-[12px] text-muted">{target.fullPath}</p>
            <button type="button" className="w-full h-12 rounded-xl bg-danger text-white text-[15px] font-medium disabled:opacity-50" disabled={busy} onClick={() => { void remove('folder'); }}>{busy ? '삭제 중…' : '폴더 삭제'}</button>
            <button type="button" className="w-full h-12 rounded-xl border border-line text-[15px]" onClick={() => setView('remove')}>취소</button>
          </div>
        ) : null}
        {error ? <div className="mt-2 text-[13px] text-danger" role="alert">{error}</div> : null}
      </div>
    </BottomSheet>
  );
}
