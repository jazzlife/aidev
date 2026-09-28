import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, Loader2 } from 'lucide-react';

import { useClaudeLoginFlow } from '@/modules/aidev-router/hooks/useClaudeLoginFlow';
import { claudeAuth, useClaudeAuth } from '@/modules/aidev-router/hooks/useClaudeAuth';

/**
 * Used by the workbench router bar (as a dialog) and provider-auth's login modal (inline) to sign the
 * runtime's Claude engine in with the user's subscription — no terminal, no copied tokens.
 */
export function ClaudeLoginPanel({ onClose, onDone }: { onClose?: () => void; onDone?: () => void }) {
  const flow = useClaudeLoginFlow();
  useEffect(() => { if (flow.stage === 'done') onDone?.(); }, [flow.stage, onDone]);
  const auth = useClaudeAuth();
  const [code, setCode] = useState('');
  const button = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium disabled:opacity-50';

  return (
    <div className="space-y-3 text-[13px]" data-testid="claude-login-panel">
      <div className="flex items-center gap-2 font-medium"><KeyRound size={15} className="text-primary" /> Claude 구독 로그인</div>
      <p className="text-muted-foreground">
        서버의 Claude 엔진을 내 구독 계정으로 연결합니다. 한 번 로그인하면 1년 동안 유지되고, 만료 30일 전부터 알려드립니다.
        {auth.status?.token && !auth.expired ? ` 현재 로그인: ${new Date(auth.status.token.expiresAt).toLocaleDateString()}까지.` : ''}
        {auth.expired ? ' 현재 로그인이 만료되었습니다.' : ''}
      </p>

      {flow.stage === 'idle' || flow.stage === 'error' ? (
        <div className="space-y-2">
          {flow.error ? <div className="text-red-600">{flow.error}</div> : null}
          <button type="button" className={`${button} bg-primary text-primary-foreground`} onClick={() => { void flow.start(); }}>{flow.stage === 'error' ? '다시 시작' : '로그인 시작'}</button>
        </div>
      ) : null}

      {flow.stage === 'starting' ? <div className="flex items-center gap-2 text-muted-foreground"><Loader2 size={14} className="animate-spin" /> 로그인 준비 중…</div> : null}

      {flow.stage === 'awaiting_code' || flow.stage === 'submitting' ? (
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            <a href={flow.url ?? '#'} target="_blank" rel="noreferrer" className={`${button} border border-border hover:bg-accent`}>
              <ExternalLink size={13} /> Claude 로그인 페이지 열기
            </a>
            <div className="mt-1 text-[11px] text-muted-foreground">구독 계정으로 로그인하고 승인하면 인증 코드가 표시됩니다.</div>
          </li>
          <li>
            <div className="flex gap-2">
              <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="인증 코드 붙여넣기" autoComplete="off" spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[12px] outline-none focus:border-primary"
                onKeyDown={(event) => { if (event.key === 'Enter') void flow.submit(code); }} />
              <button type="button" className={`${button} bg-primary text-primary-foreground`} disabled={!code.trim() || flow.stage === 'submitting'} onClick={() => { void flow.submit(code); }}>
                {flow.stage === 'submitting' ? <Loader2 size={13} className="animate-spin" /> : null} 확인
              </button>
            </div>
          </li>
        </ol>
      ) : null}

      {flow.stage === 'done' ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-emerald-600"><CheckCircle2 size={15} /> 로그인 완료 — {flow.expiresAt ? new Date(flow.expiresAt).toLocaleDateString() : ''}까지 유지됩니다.</div>
          {onClose ? <button type="button" className={`${button} border border-border`} onClick={onClose}>닫기</button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Used by the workbench router bar: the panel as a centered dialog, opened through claudeAuth.openDialog(). */
export function ClaudeLoginDialog() {
  const { dialogOpen } = useClaudeAuth();
  if (!dialogOpen) return null;
  return (
    <div className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/40 p-4" onClick={() => claudeAuth.closeDialog()}>
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <ClaudeLoginPanel onClose={() => claudeAuth.closeDialog()} />
      </div>
    </div>
  );
}
