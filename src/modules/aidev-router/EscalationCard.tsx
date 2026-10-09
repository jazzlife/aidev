import { ArrowUpRight, Loader2, RotateCcw, X } from 'lucide-react';

import type { NextAction } from '@/modules/aidev-router/api';

type EscalationCardProps = {
  next: NextAction;
  /** Button text for the proposed action; null when there is nothing to run (ask_user). */
  label: string | null;
  busy: boolean;
  error: string | null;
  onRun: () => void;
  onDismiss: () => void;
  /** Compact layout for the mobile app. */
  compact?: boolean;
};

/**
 * Used by ChatInterface (workbench) and the mobile ChatScreen: offers the gateway's next step for a
 * failed run (retry / stronger model / hand off to the other engine) as a single button (E-03).
 */
export function EscalationCard({ next, label, busy, error, onRun, onDismiss, compact }: EscalationCardProps) {
  const Icon = next.action === 'switch_engine' ? ArrowUpRight : RotateCcw;
  return (
    <div className={`border-t border-border bg-amber-500/10 ${compact ? 'p-3' : 'px-4 py-2.5'} text-[12px]`} data-testid="escalation-card">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{next.action === 'retry_worker' ? '검증 실패 — 작업자에게 다시 맡깁니다' : '실행이 실패했습니다'}{next.chain > 0 ? ` (이어서 ${next.chain}번째)` : ''}</div>
          <div className="mt-0.5 text-muted-foreground">{next.reason}</div>
          {error ? <div className="mt-1 text-red-600">{error}</div> : null}
        </div>
        <button type="button" aria-label="닫기" onClick={onDismiss} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"><X size={13} /></button>
      </div>
      {label ? (
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className={`mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground ${compact ? 'h-10 w-full justify-center px-4 text-[14px]' : 'h-7 px-3'} disabled:opacity-60`}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
          {busy ? '인계 준비 중…' : label}
        </button>
      ) : null}
    </div>
  );
}
