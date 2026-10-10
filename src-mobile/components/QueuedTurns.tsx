import { ChevronDown, ChevronUp, Pencil, X, Zap } from 'lucide-react';

import type { StoredQueuedMessage } from '@/shared/chatDrafts';

type QueuedTurnsProps = {
  queue: StoredQueuedMessage[];
  onMove: (id: string, direction: -1 | 1) => void;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
};

/**
 * Used by ChatScreen: the session's command queue (the same one the workbench shows), oldest first. The server sends
 * the head each time the answer ends; each card can move earlier or later, go now (cutting into the running answer),
 * go back into the composer, or be dropped.
 */
export function QueuedTurns({ queue, onMove, onSendNow, onEdit, onDelete }: QueuedTurnsProps) {
  if (!queue.length) return null;
  const button = 'm-touch flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted disabled:opacity-30';
  return (
    <ul className="mx-3 mb-1 flex max-h-[30dvh] flex-col gap-1 overflow-y-auto" data-testid="chat-queue">
      {queue.map((turn, index) => {
        const id = turn.id ?? '';
        const files = turn.attachments?.length ?? 0;
        return (
          <li key={id || index} className="flex items-center gap-1 rounded-xl border border-line bg-surface py-1 pl-3 pr-1 text-[13px]" data-testid="chat-queued">
            <span className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[11px] text-muted">대기 {index + 1}/{queue.length}</span>
            <span className="min-w-0 flex-1 truncate pl-1">{turn.content}{files ? ` · 첨부 ${files}` : ''}</span>
            {queue.length > 1 ? (
              <>
                <button type="button" aria-label="먼저 보내기" disabled={index === 0} onClick={() => onMove(id, -1)} className={button}><ChevronUp size={16} /></button>
                <button type="button" aria-label="나중에 보내기" disabled={index === queue.length - 1} onClick={() => onMove(id, 1)} className={button}><ChevronDown size={16} /></button>
              </>
            ) : null}
            <button type="button" aria-label="지금 보내기" onClick={() => onSendNow(id)} className={`${button} text-warn`}><Zap size={16} /></button>
            <button type="button" aria-label="대기 메시지 수정" onClick={() => onEdit(id)} className={button}><Pencil size={15} /></button>
            <button type="button" aria-label="대기 메시지 삭제" onClick={() => onDelete(id)} className={button}><X size={16} /></button>
          </li>
        );
      })}
    </ul>
  );
}
