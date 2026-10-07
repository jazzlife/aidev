import { CheckCircle2, Loader2, ShieldAlert, ShieldQuestion, X } from 'lucide-react';

import type { RunVerification } from '@/modules/aidev-router/api';

type VerificationCardProps = {
  status: 'pending' | 'done';
  result: RunVerification | null;
  onDismiss: () => void;
  /** Compact layout for the mobile app. */
  compact?: boolean;
};

const VERDICT = {
  pass: { Icon: CheckCircle2, tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', title: '검증 통과 — 보고가 실제와 맞습니다' },
  fail: { Icon: ShieldAlert, tone: 'bg-red-500/10 text-red-700 dark:text-red-300', title: '검증 실패 — 작업자의 보고가 실제와 다릅니다' },
  unclear: { Icon: ShieldQuestion, tone: 'bg-amber-500/10 text-amber-800 dark:text-amber-200', title: '검증 미확정' },
} as const;

/**
 * Used by ChatInterface (workbench) and the mobile ChatScreen: the independent verifier's verdict on
 * the last routed run (worker ≠ verifier). While pending it says a second model is checking the work;
 * a failed verdict lists what was wrong or missing, and the escalation card below it carries those
 * findings into the retry.
 */
export function VerificationCard({ status, result, onDismiss, compact }: VerificationCardProps) {
  const pad = compact ? 'mx-3 mb-2 rounded-xl border border-border p-3' : 'border-t border-border px-4 py-2.5';
  if (status === 'pending' || !result) {
    return (
      <div className={`${pad} flex items-center gap-2 bg-muted/30 text-[12px] text-muted-foreground`} role="status" data-testid="verification-card">
        <Loader2 size={13} className="shrink-0 animate-spin" />
        <span className="min-w-0 flex-1">독립 검증 중 — 다른 모델이 파일과 테스트로 보고를 확인하고 있습니다</span>
        <button type="button" aria-label="닫기" onClick={onDismiss} className="shrink-0 rounded p-1 hover:bg-accent"><X size={13} /></button>
      </div>
    );
  }
  const { Icon, tone, title } = VERDICT[result.verdict];
  const wrong = result.checked.filter((check) => check.result !== 'ok');
  return (
    <div className={`${pad} ${tone} text-[12px]`} data-testid="verification-card" data-verdict={result.verdict}>
      <div className="flex items-start gap-2">
        <Icon size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}{result.model ? <span className="ml-1 font-normal opacity-70">· {result.engine} {result.model}</span> : null}</div>
          {result.summary ? <div className="mt-0.5 opacity-90">{result.summary}</div> : null}
          {result.issues.length ? <ul className="mt-1 list-disc space-y-0.5 pl-4">{result.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
          {result.verdict !== 'fail' && wrong.length ? <div className="mt-1 opacity-80">확인 못 한 주장 {wrong.length}건: {wrong.map((check) => check.claim).join(' · ')}</div> : null}
        </div>
        <button type="button" aria-label="닫기" onClick={onDismiss} className="shrink-0 rounded p-1 hover:bg-accent"><X size={13} /></button>
      </div>
    </div>
  );
}
