import { useTranslation } from 'react-i18next';
import { PencilIcon, XIcon } from 'lucide-react';

type QueuedMessageCardProps = {
  content: string;
  attachmentCount?: number;
  /** 1-based place in the session's queue; shown only when there is more than one turn. */
  position: number;
  total: number;
  onEdit: () => void;
  onDelete: () => void;
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
  onEdit,
  onDelete,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
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
          <p className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90">{content}</p>
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {attachmentCount} {attachmentCount === 1 ? 'file' : 'files'} attached
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
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
