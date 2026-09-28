import { useState } from 'react';

import { claudeAuth, useClaudeAuth, useClaudeLoginFlow } from '@/modules/aidev-router';
import { BottomSheet } from '@m/components/BottomSheet';

/** Mobile sheet body: the shared login flow in the mobile look (mounted only while the sheet is open). */
function ClaudeLoginBody() {
  const flow = useClaudeLoginFlow();
  const auth = useClaudeAuth();
  const [code, setCode] = useState('');
  const primary = 'w-full h-11 rounded-xl bg-accent text-accent-ink text-[15px] font-medium disabled:opacity-50';
  return (
    <div className="space-y-4 text-[14px]">
      <p className="text-muted text-[13px]">
        서버의 Claude 엔진을 내 구독 계정으로 연결합니다. 한 번 로그인하면 1년 동안 유지됩니다.
        {auth.status?.token && !auth.expired ? ` 현재 ${new Date(auth.status.token.expiresAt).toLocaleDateString()}까지 로그인됨.` : ''}
        {auth.expired ? ' 현재 로그인이 만료되었습니다.' : ''}
      </p>
      {flow.error ? <div className="text-danger text-[13px]">{flow.error}</div> : null}
      {flow.stage === 'idle' || flow.stage === 'error' ? <button type="button" className={primary} onClick={() => { void flow.start(); }}>{flow.stage === 'error' ? '다시 시작' : '로그인 시작'}</button> : null}
      {flow.stage === 'starting' ? <div className="text-muted m-pulse">로그인 준비 중…</div> : null}
      {flow.stage === 'awaiting_code' || flow.stage === 'submitting' ? (
        <div className="space-y-3">
          <a href={flow.url ?? '#'} target="_blank" rel="noreferrer" className="block w-full h-11 leading-[44px] text-center rounded-xl border border-line bg-surface text-[15px]">1. Claude 로그인 페이지 열기</a>
          <div className="text-[12px] text-muted">구독 계정으로 로그인하고 승인하면 인증 코드가 표시됩니다. 복사해서 아래에 붙여넣으세요.</div>
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="2. 인증 코드 붙여넣기" autoComplete="off" autoCapitalize="off" spellCheck={false}
            className="w-full h-11 rounded-xl border border-line bg-bg px-3 font-mono text-[13px] outline-none focus:border-accent" />
          <button type="button" className={primary} disabled={!code.trim() || flow.stage === 'submitting'} onClick={() => { void flow.submit(code); }}>{flow.stage === 'submitting' ? '확인 중…' : '확인'}</button>
        </div>
      ) : null}
      {flow.stage === 'done' ? (
        <div className="space-y-3">
          <div className="text-ok">로그인 완료 — {flow.expiresAt ? new Date(flow.expiresAt).toLocaleDateString() : ''}까지 유지됩니다.</div>
          <button type="button" className={primary} onClick={() => claudeAuth.closeDialog()}>닫기</button>
        </div>
      ) : null}
    </div>
  );
}

/** Used by ChatScreen (router chip) and SettingsScreen: opened through claudeAuth.openDialog(). */
export function ClaudeLoginSheet() {
  const { dialogOpen } = useClaudeAuth();
  return (
    <BottomSheet open={dialogOpen} onClose={() => claudeAuth.closeDialog()} title="Claude 구독 로그인">
      {dialogOpen ? <ClaudeLoginBody /> : null}
    </BottomSheet>
  );
}
