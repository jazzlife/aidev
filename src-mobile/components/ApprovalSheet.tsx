import { useEffect, useState } from 'react';
import { Check, ShieldAlert, X, Zap } from 'lucide-react';

import { aidevApi, useRemoteApprovals, type RemoteApproval, type RemoteRun } from '@/modules/aidev-router';
import { BottomSheet } from '@m/components/BottomSheet';
import { RemoteRunCard } from '@m/components/RemoteRunCard';

/**
 * Mobile: an agent wants to run a risky command on one of the user's PCs (F-05). Rendered for every
 * signed-in screen; opens by itself while approvals are pending (the web push links here too) and,
 * after "허용", follows the run as a result card.
 */
function tone(a: RemoteApproval) {
  if (a.destructive || a.risk >= 1.5) return 'text-danger';
  if (a.risk >= 0.75) return 'text-warn';
  return 'text-ok';
}

function Pending({ approval, onAnswer }: { approval: RemoteApproval; onAnswer: (allow: boolean, auto?: boolean) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((approval.expiresAt - now) / 1000));
  return (
    <div className="rounded-xl border border-warn/50 bg-warn/10 p-3" data-testid="approval-card">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <ShieldAlert size={15} className="text-warn" />
        <span className="truncate">{approval.targetName}{approval.agent ? ` · ${approval.agent}` : ''}</span>
        <span className={`ml-auto font-medium ${tone(approval)}`}>위험도 {approval.risk.toFixed(1)}</span>
      </div>
      {approval.kind === 'debug' ? <div className="mt-2 text-[12px] text-warn">디버거로 실행 (중단점에서 멈춤)</div> : null}
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-elevated p-2 font-mono text-[13px]">{approval.cmd}</pre>
      <div className="mt-1.5 flex flex-wrap gap-1 text-[12px] text-muted">
        {approval.reasons.map((r) => <span key={r} className="rounded-md bg-elevated px-1.5 py-0.5">{r}</span>)}
      </div>
      <div className="mt-1 text-[12px] text-muted">{approval.cwd ?? '기본 작업 폴더'} · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} 후 자동 거부</div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onAnswer(true)} className="flex h-11 items-center justify-center gap-1 rounded-xl bg-accent text-[15px] font-medium text-accent-ink"><Check size={17} /> 허용</button>
        <button type="button" onClick={() => onAnswer(false)} className="flex h-11 items-center justify-center gap-1 rounded-xl border border-line text-[15px]"><X size={17} /> 거부</button>
      </div>
      {!approval.destructive && approval.policy !== 'auto' ? (
        <button type="button" onClick={() => onAnswer(true, true)} className="mt-2 flex w-full items-center justify-center gap-1 text-[13px] text-muted"><Zap size={14} /> 허용하고 이 PC는 위험한 명령만 묻기</button>
      ) : null}
    </div>
  );
}

function Answered({ approval }: { approval: RemoteApproval }) {
  const [run, setRun] = useState<RemoteRun | null>(null);
  useEffect(() => {
    if (approval.status !== 'allowed' || !approval.remoteRunId) return;
    aidevApi.remoteRun(approval.remoteRunId).then((r) => setRun(r.run)).catch(() => undefined);
  }, [approval]);
  if (run) return <RemoteRunCard run={run} lines={10} />;
  return <div className="rounded-xl border border-line bg-surface px-3 py-2 text-[14px] text-muted">{approval.status === 'denied' ? '거부함' : approval.error ? `시작 실패: ${approval.error}` : '허용함'} · <code>{approval.cmd}</code></div>;
}

export function ApprovalSheet() {
  const { pending, answered, answer, dismiss } = useRemoteApprovals();
  const [closedFor, setClosedFor] = useState<string>('');
  const key = pending.map((a) => a.id).join(',');
  const open = (pending.length > 0 && closedFor !== key) || answered.length > 0;
  const close = () => { setClosedFor(key); for (const a of answered) dismiss(a.id); };
  return (
    <BottomSheet open={open} onClose={close} title={pending.length ? `원격 실행 승인 ${pending.length}건` : '원격 실행'}>
      <div className="space-y-2" data-testid="approval-sheet">
        {pending.map((a) => <Pending key={a.id} approval={a} onAnswer={(allow, auto) => { void answer(a.id, allow, auto); }} />)}
        {answered.map((a) => <Answered key={a.id} approval={a} />)}
      </div>
    </BottomSheet>
  );
}
