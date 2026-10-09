import { Loader2, Undo2, X } from 'lucide-react';

import type { ReturnFromHandoff } from '@/modules/aidev-router/hooks/useReturnFromHandoff';

/**
 * Used by ChatInterface (workbench) and the mobile ChatScreen: in a chat that was handed off because of a
 * usage limit, one button back to the original engine's session once its limit has reset. While the limit
 * still holds it only says when the window resets.
 */
export function ReturnCard({ back, compact }: { back: ReturnFromHandoff; compact?: boolean }) {
  if (!back.label && !back.limitedUntil) return null;
  const pad = compact ? 'mx-3 mb-2 rounded-xl border p-3' : 'border-t px-4 py-2.5';
  if (!back.label && back.limitedUntil) {
    return (
      <div className={`${pad} border-border bg-muted/30 text-[12px] text-muted-foreground`} data-testid="return-card" data-state="limited">
        원래 엔진의 사용량 한도는 {new Date(back.limitedUntil).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}에 풀립니다. 풀리면 여기서 돌아갈 수 있습니다.
      </div>
    );
  }
  return (
    <div className={`${pad} border-emerald-500/40 bg-emerald-500/10 text-[12px]`} data-testid="return-card" data-state="ready">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 font-medium">{back.label}</div>
        <button type="button" aria-label="닫기" onClick={back.dismiss} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"><X size={13} /></button>
      </div>
      {back.error ? <div className="mt-1 text-red-600">{back.error}</div> : null}
      <button type="button" onClick={() => { void back.returnNow(); }} disabled={back.busy} className={`mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground ${compact ? 'h-10 w-full justify-center px-4 text-[14px]' : 'h-7 px-3'} disabled:opacity-60`}>
        {back.busy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
        {back.busy ? '요약 준비 중…' : '원래 대화로 돌아가기'}
      </button>
    </div>
  );
}
