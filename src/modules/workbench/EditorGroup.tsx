import { useCallback, useMemo, useState } from 'react';
import { FileCode2, X } from 'lucide-react';

import { CodeEditor } from '@/modules/code-editor';
import type { CodeEditorDiffInfo, CodeEditorFile } from '@/shared/types';

export type EditorGroupApi = {
  open: (filePath: string, diffInfo?: CodeEditorDiffInfo | null, line?: number | null) => void;
  close: (path: string) => void;
  closeAll: () => void;
};

/**
 * Used by WorkbenchLayout: multi-tab editor group. Every open file keeps its own CodeEditor
 * instance mounted (hidden when inactive) so unsaved edits survive tab switches.
 */
export function useEditorGroup(projectId: string | undefined) {
  const [tabs, setTabs] = useState<CodeEditorFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const open = useCallback<EditorGroupApi['open']>((filePath, diffInfo = null, line = null) => {
    const normalized = filePath.replace(/\\/g, '/');
    const name = normalized.split('/').pop() || filePath;
    setTabs((previous) => {
      const existing = previous.find((tab) => tab.path === filePath);
      if (existing) return previous.map((tab) => (tab.path === filePath ? { ...tab, diffInfo: diffInfo ?? tab.diffInfo, line: line ?? null } : tab));
      return [...previous, { name, path: filePath, projectId, diffInfo, line }];
    });
    setActive(filePath);
  }, [projectId]);
  const close = useCallback((path: string) => {
    setTabs((previous) => {
      const next = previous.filter((tab) => tab.path !== path);
      setActive((current) => (current === path ? (next[next.length - 1]?.path ?? null) : current));
      return next;
    });
  }, []);
  const closeAll = useCallback(() => { setTabs([]); setActive(null); }, []);
  const api = useMemo<EditorGroupApi>(() => ({ open, close, closeAll }), [open, close, closeAll]);
  return { tabs, active, setActive, api };
}

type EditorGroupProps = { tabs: CodeEditorFile[]; active: string | null; onActivate: (path: string) => void; onClose: (path: string) => void; projectPath?: string };

export function EditorGroup({ tabs, active, onActivate, onClose, projectPath }: EditorGroupProps) {
  if (tabs.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-sm gap-2 select-none">
        <FileCode2 size={28} className="opacity-60" />
        <div>탐색기에서 파일을 열거나 채팅의 파일 링크를 클릭하세요</div>
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-stretch overflow-x-auto border-b border-border bg-muted/30 text-xs shrink-0" role="tablist">
        {tabs.map((tab) => (
          <div key={tab.path} role="tab" aria-selected={tab.path === active} className={`flex items-center gap-1 pl-3 pr-1 h-8 border-r border-border cursor-pointer max-w-[220px] ${tab.path === active ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => onActivate(tab.path)} title={tab.path}>
            <span className="truncate">{tab.name}</span>
            <button type="button" aria-label={`${tab.name} 닫기`} className="p-0.5 rounded hover:bg-muted" onClick={(event) => { event.stopPropagation(); onClose(tab.path); }}><X size={12} /></button>
          </div>
        ))}
      </div>
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div key={tab.path} className={`absolute inset-0 ${tab.path === active ? '' : 'hidden'}`}>
            <CodeEditor file={tab} onClose={() => onClose(tab.path)} projectPath={projectPath} isSidebar />
          </div>
        ))}
      </div>
    </div>
  );
}
