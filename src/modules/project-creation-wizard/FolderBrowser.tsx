import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, FolderPlus } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { useWorkspacesRoot } from '@/shared/hooks/useWorkspacesRoot';
import { Button, Input } from '@/shared/ui';
import { collapseWorkspacesRoot, expandWorkspacesRoot, joinFolderPath } from '@/shared/utils';

type FolderSuggestion = { name: string; path: string };

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
 * `~/x` expanded against the projects home. The folder shown is the chosen one.
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

  const browse = useCallback(async (target: string | null) => {
    setFolders(null);
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
          <button type="button" aria-label="새 폴더" title="새 폴더" disabled={disabled || !shown} onClick={() => setNewName('')} className="flex h-9 w-9 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30">
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
        <ul className="max-h-56 overflow-y-auto" data-testid="folder-list">
          {folders === null ? <li className="px-3 py-2 text-sm text-muted-foreground">불러오는 중…</li> : null}
          {folders?.length === 0 && !error ? <li className="px-3 py-2 text-sm text-muted-foreground">하위 폴더가 없습니다</li> : null}
          {folders?.map((folder) => (
            <li key={folder.path}>
              <button type="button" disabled={disabled} onClick={() => void browse(folder.path)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50">
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{folder.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
    </div>
  );
}
