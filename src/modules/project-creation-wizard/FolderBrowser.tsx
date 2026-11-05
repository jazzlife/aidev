import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, FolderPlus, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { useWorkspacesRoot } from '@/shared/hooks/useWorkspacesRoot';
import { Button, Input } from '@/shared/ui';
import { collapseWorkspacesRoot, expandWorkspacesRoot, joinFolderPath } from '@/shared/utils';

type FolderSuggestion = { name: string; path: string };

// how long a finger rests on a folder before its menu opens (touch has no right-click)
const LONG_PRESS_MS = 500;

const parentOf = (folderPath: string) => {
  const trimmed = folderPath.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed.startsWith('/') ? '/' : trimmed;
};

type FolderBrowserProps = {
  path: string;
  disabled?: boolean;
  onPath: (path: string) => void;
};

/**
 * Rendered by ProjectCreationWizard for the folder a project is added from or cloned into: the runtime's folders from
 * the projects home (↑ to the parent, click to enter, a new folder in the one shown), paths printed as `~/…` and a typed
 * `~/x` expanded against the projects home. The folder shown is the chosen one. A folder's context menu (right-click,
 * or a long press on touch) deletes it after a confirmation.
 */
export default function FolderBrowser({ path, disabled = false, onPath }: FolderBrowserProps) {
  // the projects home (~): how paths print and what a typed ~/x expands against
  const root = useWorkspacesRoot();
  // the folder whose children are listed (null until the first look answers)
  const [shown, setShown] = useState<string | null>(null);
  // its subfolders (null: loading)
  const [folders, setFolders] = useState<FolderSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the new folder's name while one is being made (null: the form is closed)
  const [newName, setNewName] = useState<string | null>(null);
  // the folder whose context menu is open and where it opened (null: closed)
  const [menu, setMenu] = useState<{ folder: FolderSuggestion; x: number; y: number } | null>(null);
  // the folder waiting for its deletion to be confirmed (null: nothing asked)
  const [deleteCandidate, setDeleteCandidate] = useState<FolderSuggestion | null>(null);
  // the pending long press, and whether it already opened the menu (so the lift does not also enter the folder)
  const longPress = useRef<{ timer: number; fired: boolean } | null>(null);

  const browse = useCallback(async (target: string | null) => {
    setFolders(null);
    setDeleteCandidate(null);
    setError(null);
    try {
      const body = await readApiJson<{ path?: string; suggestions?: FolderSuggestion[] }>(await api.browseFilesystem(target));
      const at = body.path || target || '';
      setShown(at);
      setFolders((body.suggestions ?? []).filter((folder) => !folder.name.startsWith('.')));
      onPath(at);
    } catch (browseError) {
      setError(browseError instanceof Error ? browseError.message : '폴더를 불러오지 못했습니다');
      setFolders([]);
    }
  }, [onPath]);
  // the first look only (no path: the server starts at the projects home); later moves come from clicks
  const firstPath = useRef(path);
  useEffect(() => { void browse(firstPath.current || null); }, [browse]);

  const createFolder = async () => {
    const name = newName?.trim();
    if (!name || !shown) return;
    try {
      const body = await readApiJson<{ path?: string }>(await api.createFolder(joinFolderPath(shown, name)));
      setNewName(null);
      await browse(body.path || joinFolderPath(shown, name));
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '폴더를 만들지 못했습니다');
    }
  };

  const deleteFolder = async () => {
    if (!deleteCandidate || !shown) return;
    const target = deleteCandidate;
    setDeleteCandidate(null);
    try {
      await readApiJson(await api.deleteFolder(target.path));
      await browse(shown);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '폴더를 지우지 못했습니다');
    }
  };

  const openMenu = (folder: FolderSuggestion, x: number, y: number) => {
    if (disabled) return;
    setMenu({ folder, x: Math.min(x, window.innerWidth - 168), y: Math.min(y, window.innerHeight - 48) });
  };

  const cancelLongPress = () => {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
  };

  return (
    <div className="space-y-2">
      <Input
        value={collapseWorkspacesRoot(path, root)}
        onChange={(event) => onPath(expandWorkspacesRoot(event.target.value, root))}
        onBlur={() => { if (path && path !== shown) void browse(path); }}
        onKeyDown={(event) => { if (event.key === 'Enter' && path && path !== shown) void browse(path); }}
        placeholder="~/폴더"
        aria-label="경로"
        className="font-mono"
        disabled={disabled}
      />
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center border-b border-border bg-muted/40">
          <button type="button" aria-label="상위 폴더" title="상위 폴더" disabled={disabled || !shown || parentOf(shown) === shown} onClick={() => { if (shown) void browse(parentOf(shown)); }} className="flex h-9 w-9 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30">
            <ArrowUp className="h-4 w-4" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={shown ?? ''}>{shown ? collapseWorkspacesRoot(shown, root) : ''}</span>
          <button type="button" aria-label="새 폴더" title="새 폴더" disabled={disabled || !shown} onClick={() => { setNewName(''); setDeleteCandidate(null); }} className="flex h-9 w-9 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30">
            <FolderPlus className="h-4 w-4" />
          </button>
        </div>
        {newName !== null ? (
          <div className="flex gap-2 border-b border-border p-2">
            <Input
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createFolder();
                if (event.key === 'Escape') setNewName(null);
              }}
              placeholder="새 폴더 이름"
              aria-label="새 폴더 이름"
            />
            <Button type="button" size="sm" onClick={() => void createFolder()} disabled={!newName.trim()}>만들기</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNewName(null)}>취소</Button>
          </div>
        ) : null}
        {deleteCandidate ? (
          <div className="flex items-center gap-2 border-b border-border p-2" data-testid="folder-delete-confirm">
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{deleteCandidate.name}</span> 폴더와 그 안의 모든 파일을 지울까요?
            </span>
            <Button type="button" size="sm" variant="destructive" autoFocus onClick={() => void deleteFolder()}>삭제</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDeleteCandidate(null)}>취소</Button>
          </div>
        ) : null}
        <ul className="max-h-56 overflow-y-auto" data-testid="folder-list">
          {folders === null ? <li className="px-3 py-2 text-sm text-muted-foreground">불러오는 중…</li> : null}
          {folders?.length === 0 && !error ? <li className="px-3 py-2 text-sm text-muted-foreground">하위 폴더가 없습니다</li> : null}
          {folders?.map((folder) => (
            <li key={folder.path}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (longPress.current?.fired) return;
                  void browse(folder.path);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(folder, event.clientX, event.clientY);
                }}
                onPointerDown={(event) => {
                  cancelLongPress();
                  longPress.current = null;
                  if (event.pointerType === 'mouse') return;
                  const { clientX, clientY } = event;
                  const press = { fired: false, timer: window.setTimeout(() => { press.fired = true; openMenu(folder, clientX, clientY); }, LONG_PRESS_MS) };
                  longPress.current = press;
                }}
                onPointerUp={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onPointerLeave={cancelLongPress}
                className="flex w-full select-none items-center gap-2 px-3 py-2 text-left text-sm [-webkit-touch-callout:none] hover:bg-accent disabled:opacity-50"
              >
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{folder.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {menu ? (
        <>
          {/* anywhere else closes the menu */}
          <div className="fixed inset-0 z-10" onPointerDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }} />
          <div role="menu" aria-label={`${menu.folder.name} 폴더 메뉴`} style={{ left: menu.x, top: menu.y }} className="fixed z-10 min-w-40 rounded-lg border border-border bg-popover p-1 shadow-lg">
            <button
              type="button"
              role="menuitem"
              autoFocus
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); } }}
              onClick={() => { setDeleteCandidate(menu.folder); setNewName(null); setMenu(null); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
            >
              <Trash2 className="h-4 w-4" />
              삭제
            </button>
          </div>
        </>
      ) : null}
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
    </div>
  );
}
