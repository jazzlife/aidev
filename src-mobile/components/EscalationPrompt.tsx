import { ArrowUpRight, Loader2, RotateCcw, X } from 'lucide-react';

type NextLike = { action: string; reason: string; chain: number };

/** Used by ChatScreen: the gateway's next step for a failed run as one full-width button (E-03). */
export function EscalationPrompt({ next, label, busy, error, onRun, onDismiss }: { next: NextLike; label: string | null; busy: boolean; error: string | null; onRun: () => void; onDismiss: () => void }) {
  const Icon = next.action === 'switch_engine' ? ArrowUpRight : RotateCcw;
  return (
    <div className="mx-3 mb-2 rounded-xl border border-warn/40 bg-warn/10 p-3" data-testid="escalation-card">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-medium">실행이 실패했습니다{next.chain > 0 ? ` (이어서 ${next.chain}번째)` : ''}</div>
          <div className="text-[12px] text-muted mt-0.5">{next.reason}</div>
          {error ? <div className="text-[12px] text-danger mt-1">{error}</div> : null}
        </div>
        <button type="button" aria-label="닫기" onClick={onDismiss} className="m-touch -mr-2 -mt-2 flex items-center justify-center rounded-full text-muted"><X size={16} /></button>
      </div>
      {label ? (
        <button type="button" onClick={onRun} disabled={busy} className="mt-2 w-full h-11 rounded-xl bg-accent text-accent-ink text-[14px] font-medium flex items-center justify-center gap-2 disabled:opacity-60">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
          {busy ? '인계 준비 중…' : label}
        </button>
      ) : null}
    </div>
  );
}
