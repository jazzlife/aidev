import { useMemo } from 'react';
import { FileText } from 'lucide-react';

import { calculateDiff, summarizeDiff } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import type { FileEdit } from '@m/lib/peek';

// a new file this long is summarised instead of drawn line by line (the file peek shows it whole)
const MAX_ROWS = 1500;

type DiffPeekProps = {
  edit: FileEdit | null;
  onClose: () => void;
  /** opens the edited file in the file peek */
  onOpenFile: (path: string) => void;
};

/**
 * Used by ChatScreen (C-05): what one file tool call changed, as a single column of −/+ lines (own renderer —
 * no @codemirror/merge on the phone). Multi-edits show one block per edit.
 */
export function DiffPeek({ edit, onClose, onOpenFile }: DiffPeekProps) {
  const blocks = useMemo(() => (edit ? edit.hunks.map((hunk) => calculateDiff(hunk.before, hunk.after)) : []), [edit]);
  const stats = useMemo(() => summarizeDiff(blocks.flat()), [blocks]);
  // the rows each block may draw: blocks share one MAX_ROWS budget, in order
  const shownCounts = useMemo(() => blocks.map((block, index) => {
    const before = blocks.slice(0, index).reduce((total, previous) => total + previous.length, 0);
    return Math.max(0, Math.min(block.length, MAX_ROWS - before));
  }), [blocks]);
  const name = edit ? edit.path.split('/').pop() : '';
  return (
    <BottomSheet open={edit !== null} onClose={onClose} title={<span className="flex min-w-0 items-center gap-2"><span className="min-w-0 truncate">{name}</span><span className="shrink-0 text-[12px] font-normal"><span className="text-ok">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span></span></span>}>
      {edit ? (
        <div className="space-y-3" data-testid="diff-peek">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <span className="min-w-0 flex-1 truncate">{edit.deleted ? '삭제됨 · ' : edit.created ? '새 파일 · ' : ''}{edit.path}</span>
            {!edit.deleted ? <button type="button" onClick={() => onOpenFile(edit.path)} className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-line px-2 text-[13px] text-ink"><FileText size={14} /> 파일 보기</button> : null}
          </div>
          {blocks.every((block) => block.length === 0) ? <div className="py-4 text-center text-[13px] text-muted">기록된 변경 내용이 없습니다</div> : null}
          {blocks.map((block, index) => {
            if (!block.length) return null;
            const shown = block.slice(0, shownCounts[index]);
            return (
              <div key={index} className="overflow-x-auto rounded-lg border border-line bg-elevated font-mono text-[12px] leading-[18px]">
                {blocks.length > 1 ? <div className="border-b border-line px-2 py-1 font-sans text-[11px] text-muted">변경 {index + 1}/{blocks.length}</div> : null}
                <div className="min-w-max py-1">
                  {shown.map((line, row) => (
                    <div key={row} className={`flex whitespace-pre pr-3 ${line.type === 'added' ? 'bg-ok/10' : 'bg-danger/10'}`}>
                      {/* an edit's line numbers count within the replaced snippet, not the file — only a new file's are real */}
                      {edit.created ? <span className="w-10 shrink-0 select-none pr-2 text-right text-muted">{line.lineNum}</span> : null}
                      <span className={`w-4 shrink-0 pl-1 select-none ${line.type === 'added' ? 'text-ok' : 'text-danger'}`}>{line.type === 'added' ? '+' : '−'}</span>
                      <span>{line.content || ' '}</span>
                    </div>
                  ))}
                  {shown.length < block.length ? <div className="px-3 py-1 font-sans text-[12px] text-muted">… {block.length - shown.length}줄 더 있음 — 파일 보기에서 전체를 확인하세요</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </BottomSheet>
  );
}
