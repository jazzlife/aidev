import { CheckCircle2, ExternalLink, KeyRound, Loader2, TerminalSquare } from 'lucide-react';

import { OPENCODE_KEY_PROVIDERS, OPENCODE_OTHER_PROVIDER, openCodeProviderLabel, useOpenCodeLogin } from '@/modules/aidev-router/hooks/useOpenCodeLogin';

/**
 * Used by provider-auth's login modal for OpenCode: pick the provider, paste its API key, and the runtime stores it as
 * OpenCode's sign-in — no terminal prompt. Account sign-ins that are not a key (ChatGPT, GitHub) go through
 * `onUseTerminal`, the terminal login.
 */
export function OpenCodeLoginPanel({ onClose, onDone, onUseTerminal }: { onClose?: () => void; onDone?: () => void; onUseTerminal?: () => void }) {
  const { choice, choose, otherId, setOtherId, key, setKey, connected, saving, error, saved, picked, canSave, save } = useOpenCodeLogin(onDone);
  const labelOf = openCodeProviderLabel;
  const button = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium disabled:opacity-50';
  const field = 'h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-primary';

  return (
    <div className="space-y-3 text-[13px]" data-testid="opencode-login-panel">
      <div className="flex items-center gap-2 font-medium"><KeyRound size={15} className="text-primary" /> OpenCode 로그인 (API 키)</div>
      <p className="text-muted-foreground">
        OpenCode는 공급자마다 API 키로 연결합니다. 공급자를 고르고 그곳에서 만든 키를 붙여 넣으면 서버의 OpenCode에 저장됩니다. 여러 공급자를 차례로 연결할 수 있습니다.
        {connected?.length ? ` 지금 연결된 공급자: ${connected.map(labelOf).join(', ')}.` : ''}
      </p>

      <label className="block space-y-1">
        <span className="text-muted-foreground">공급자</span>
        <select aria-label="OpenCode 공급자" className={field} value={choice} disabled={saving} onChange={(event) => choose(event.target.value)}>
          {OPENCODE_KEY_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{connected?.includes(provider.id) ? ' · 연결됨(키 교체)' : ''}</option>)}
          <option value={OPENCODE_OTHER_PROVIDER}>다른 공급자 (id 직접 입력)</option>
        </select>
      </label>
      {picked ? (
        <div className="space-y-1.5">
          <div className="text-[12px] text-muted-foreground">{picked.note}</div>
          <a href={picked.keyUrl} target="_blank" rel="noreferrer" className={`${button} border border-border hover:bg-accent`}><ExternalLink size={13} /> 키 만드는 페이지 열기</a>
        </div>
      ) : (
        <label className="block space-y-1">
          <span className="text-muted-foreground">공급자 id (OpenCode 모델 id의 앞부분, 예: groq, mistral)</span>
          <input aria-label="OpenCode 공급자 id" className={`${field} font-mono`} value={otherId} disabled={saving} autoComplete="off" spellCheck={false} onChange={(event) => setOtherId(event.target.value)} />
        </label>
      )}

      <label className="block space-y-1">
        <span className="text-muted-foreground">API 키</span>
        <div className="flex gap-2">
          <input aria-label="OpenCode API 키" type="password" className={`${field} min-w-0 flex-1 font-mono`} value={key} disabled={saving} placeholder="키 붙여넣기" autoComplete="off" spellCheck={false}
            onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void save(); }} />
          <button type="button" className={`${button} bg-primary text-primary-foreground`} disabled={!canSave} onClick={() => { void save(); }}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : null} 저장
          </button>
        </div>
      </label>

      {error ? <div className="text-red-600">{error}</div> : null}
      {saved ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-emerald-600"><CheckCircle2 size={15} /> {labelOf(saved)} 키를 저장했습니다. 모델 목록에 {saved}/… 모델이 나타납니다.</div>
          {onClose ? <button type="button" className={`${button} border border-border`} onClick={onClose}>닫기</button> : null}
        </div>
      ) : null}

      {onUseTerminal ? (
        <div className="border-t border-border pt-3">
          <button type="button" className={`${button} border border-border hover:bg-accent`} onClick={onUseTerminal}><TerminalSquare size={13} /> 터미널로 로그인</button>
          <div className="mt-1 text-[11px] text-muted-foreground">API 키가 아닌 계정 로그인(ChatGPT Pro/Plus, GitHub Copilot 등)은 OpenCode의 터미널 로그인으로 합니다.</div>
        </div>
      ) : null}
    </div>
  );
}
