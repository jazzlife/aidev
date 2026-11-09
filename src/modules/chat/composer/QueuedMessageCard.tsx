import { useTranslation } from 'react-i18next';
import { BotIcon, ChevronDownIcon, ChevronUpIcon, PencilIcon, XIcon, ZapIcon } from 'lucide-react';

import { holdLabel } from '@/modules/aidev-router';
import type { QueuedTurnHold } from '@/shared/types';

type QueuedMessageCardProps = {
  content: string;
  attachmentCount?: number;
  /** 1-based place in the session's queue; shown only when there is more than one turn. */
  position: number;
  total: number;
  /** False while the running turn cannot be interrupted, which disables "send now". */
  canSendNow: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** Absent at the top / bottom of the queue, where the arrow is hidden. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onSendNow: () => void;
  /** Waiting for the specialist being designed for it: shown as such, with "범용 에이전트로 즉시 실행" instead of "send now". */
  hold?: QueuedTurnHold;
  onRunHeldNow?: () => void;
};

/**
 * Rendered by chat's ChatComposer, once per turn queued behind a busy
 * session's running turn, with edit and delete actions before it is sent.
 */
export default function QueuedMessageCard({
  content,
  attachmentCount = 0,
  position,
  total,
  canSendNow,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  onSendNow,
  hold,
  onRunHeldNow,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');
  const moveUpLabel = t('input.queue.moveUp', { defaultValue: 'Send earlier' });
  const moveDownLabel = t('input.queue.moveDown', { defaultValue: 'Send later' });
  const sendNowLabel = t('input.queue.sendNow', { defaultValue: 'Send now (interrupts the running turn)' });
  const arrowClassName = 'rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
          {hold ? (
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary/80" data-testid="held-turn">
              <BotIcon className="h-3 w-3 shrink-0 animate-pulse" />
              <span>{holdLabel(hold)}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
              <span>
                {t('input.queue.label', { defaultValue: 'Queued' })}
                {total > 1 && <span className="tabular-nums"> {position}/{total}</span>}
              </span>
              <span className="normal-case text-muted-foreground/60">
                · {position === 1
                  ? t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })
                  : t('input.queue.afterPrevious', { defaultValue: 'Sent after the one above' })}
              </span>
            </div>
          )}
          <p className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90">{content}</p>
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {attachmentCount} {attachmentCount === 1 ? 'file' : 'files'} attached
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {total > 1 && (
            <div className="mr-1 flex flex-col">
              <button type="button" onClick={onMoveUp} disabled={!onMoveUp} aria-label={moveUpLabel} title={moveUpLabel} className={arrowClassName}>
                <ChevronUpIcon className="h-3 w-3" />
              </button>
              <button type="button" onClick={onMoveDown} disabled={!onMoveDown} aria-label={moveDownLabel} title={moveDownLabel} className={arrowClassName}>
                <ChevronDownIcon className="h-3 w-3" />
              </button>
            </div>
          )}
          {hold ? (
            <button type="button" onClick={onRunHeldNow} className="mr-1 whitespace-nowrap rounded-md border border-primary/40 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10" data-testid="run-held-now">
              범용 에이전트로 즉시 실행
            </button>
          ) : (
            <button
              type="button"
              onClick={onSendNow}
              disabled={!canSendNow}
              aria-label={sendNowLabel}
              title={sendNowLabel}
              className="rounded-md p-1.5 text-amber-600 transition-colors hover:bg-amber-500/10 hover:text-amber-700 disabled:opacity-30 disabled:hover:bg-transparent dark:text-amber-400 dark:hover:text-amber-300"
            >
              <ZapIcon className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
