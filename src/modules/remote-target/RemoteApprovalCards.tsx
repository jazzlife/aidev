import { useEffect, useState } from 'react';
import { Check, ExternalLink, ShieldAlert, X, Zap } from 'lucide-react';

import { focusRemoteRun, useRemoteApprovals, type RemoteApproval } from '@/modules/aidev-router';

/**
 * Agent remote commands waiting for the user (F-05), shown above the chat in the workbench.
 * Allow / deny / allow and switch the PC to automatic runs; an allowed card stays briefly with a
 * link to its live output in the "원격 실행" panel.
 */
function riskTone(a: RemoteApproval) {
  if (a.destructive || a.risk >= 1.5) return { label: '위험', cls: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40' };
  if (a.risk >= 0.75) return { label: '변경', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40' };
  return { label: '낮음', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40' };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ApprovalCard({ approval, onAnswer }: { approval: RemoteApproval; onAnswer: (allow: boolean, auto?: boolean) => void }) {
  const tone = riskTone(approval);
  const now = useNow(true);
  const left = Math.max(0, Math.round((approval.expiresAt - now) / 1000));
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-2.5 text-xs shadow-sm" data-testid="approval-card">
      <div className="flex items-center gap-1.5">
        <ShieldAlert size={14} className="text-amber-600" />
        <span className="font-medium">{approval.kind === 'debug' ? '원격 디버그 실행 승인 요청' : approval.kind === 'console' ? '원격 디버거 콘솔 승인 요청' : '원격 실행 승인 요청'}</span>
        <span className="text-muted-foreground">· {approval.targetName}{approval.agent ? ` · ${approval.agent}` : ''}</span>
        <span className={`ml-auto rounded border px-1.5 py-px text-[10px] ${tone.cls}`}>위험도 {tone.label} {approval.risk.toFixed(1)}</span>
      </div>
      <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 px-2 py-1.5 font-mono text-[12px]">{approval.cmd}</pre>
      {approval.input ? (
        <div className="mt-1.5">
          <div className="text-[11px] text-muted-foreground">{/^(claude|codex|gemini)\b/.test(approval.cmd) ? '이 PC의 agent CLI에 맡길 작업' : '명령에 넣을 입력'}</div>
          <pre className="aidev-selectable max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1.5 text-[12px]">{approval.input}</pre>
        </div>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        {approval.cwd ? <span className="font-mono">{approval.cwd}</span> : <span>기본 작업 폴더</span>}
        {approval.reasons.map((r) => <span key={r} className="rounded bg-muted px-1.5 py-px">{r}</span>)}
        <span className="ml-auto whitespace-nowrap">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} 후 자동 거부</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" onClick={() => onAnswer(true)} className="flex h-7 items-center gap-1 rounded bg-primary px-3 text-primary-foreground"><Check size={13} /> 허용</button>
        <button type="button" onClick={() => onAnswer(false)} className="flex h-7 items-center gap-1 rounded border border-border px-3"><X size={13} /> 거부</button>
        {!approval.destructive && approval.policy !== 'auto' ? (
          <button type="button" title="이번 명령을 허용하고, 이 PC는 앞으로 위험한 명령만 묻도록 바꿉니다" onClick={() => onAnswer(true, true)} className="ml-auto flex h-7 items-center gap-1 rounded px-2 text-muted-foreground hover:bg-muted"><Zap size={12} /> 허용 + 이 PC 자동 실행</button>
        ) : null}
      </div>
    </div>
  );
}

function AnsweredCard({ approval, onClose }: { approval: RemoteApproval; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 60_000); return () => clearTimeout(t); }, [onClose]);
  const allowed = approval.status === 'allowed' && !approval.error;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-xs" data-testid="approval-answered">
      {allowed ? <Check size={13} className="text-emerald-600" /> : <X size={13} className="text-rose-600" />}
      <span className="min-w-0 flex-1 truncate"><span className="text-muted-foreground">{allowed ? '허용함' : approval.error ? `시작 실패: ${approval.error}` : '거부함'} · </span><span className="font-mono">{approval.cmd}</span></span>
      {allowed && approval.remoteRunId ? (
        <button type="button" onClick={() => focusRemoteRun({ remoteRunId: approval.remoteRunId!, targetId: approval.targetId })} className="flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-primary hover:bg-muted"><ExternalLink size={12} /> 출력 보기</button>
      ) : null}
      <button type="button" aria-label="닫기" onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:bg-muted"><X size={12} /></button>
    </div>
  );
}

export function RemoteApprovalCards() {
  const { pending, answered, answer, dismiss, error } = useRemoteApprovals();
  if (!pending.length && !answered.length) return null;
  return (
    <div className="aidev-chrome shrink-0 space-y-1.5 border-b border-border bg-background px-3 py-2" data-testid="remote-approvals">
      {pending.map((a) => <ApprovalCard key={a.id} approval={a} onAnswer={(allow, auto) => { void answer(a.id, allow, auto); }} />)}
      {answered.map((a) => <AnsweredCard key={a.id} approval={a} onClose={() => dismiss(a.id)} />)}
      {error ? <div className="text-[11px] text-rose-600">{error}</div> : null}
    </div>
  );
}
