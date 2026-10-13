import { OPENCODE_KEY_PROVIDERS, OPENCODE_OTHER_PROVIDER, openCodeProviderLabel, useOpenCodeLogin } from '@/modules/aidev-router';
import { BottomSheet } from '@m/components/BottomSheet';

/** Mobile sheet body: the shared OpenCode API-key login in the mobile look (mounted only while the sheet is open). */
function OpenCodeLoginBody({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const login = useOpenCodeLogin(onDone);
  const primary = 'w-full h-11 rounded-xl bg-accent text-accent-ink text-[15px] font-medium disabled:opacity-50';
  const field = 'w-full h-11 rounded-xl border border-line bg-bg px-3 text-[14px] outline-none focus:border-accent';
  return (
    <div className="space-y-4 text-[14px]" data-testid="opencode-login-sheet">
      <p className="text-muted text-[13px]">
        OpenCode는 공급자마다 API 키로 연결합니다. 공급자를 고르고 그곳에서 만든 키를 붙여 넣으면 서버의 OpenCode에 저장됩니다.
        {login.connected?.length ? ` 지금 연결됨: ${login.connected.map(openCodeProviderLabel).join(', ')}.` : ''}
      </p>
      <select aria-label="OpenCode 공급자" className={field} value={login.choice} disabled={login.saving} onChange={(event) => login.choose(event.target.value)}>
        {OPENCODE_KEY_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{login.connected?.includes(provider.id) ? ' · 연결됨(키 교체)' : ''}</option>)}
        <option value={OPENCODE_OTHER_PROVIDER}>다른 공급자 (id 직접 입력)</option>
      </select>
      {login.picked ? (
        <div className="space-y-2">
          <div className="text-[12px] text-muted">{login.picked.note}</div>
          <a href={login.picked.keyUrl} target="_blank" rel="noreferrer" className="block w-full h-11 leading-[44px] text-center rounded-xl border border-line bg-surface text-[15px]">키 만드는 페이지 열기</a>
        </div>
      ) : (
        <input aria-label="OpenCode 공급자 id" className={`${field} font-mono`} value={login.otherId} disabled={login.saving} placeholder="공급자 id (예: groq)" autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => login.setOtherId(event.target.value)} />
      )}
      <input aria-label="OpenCode API 키" type="password" className={`${field} font-mono`} value={login.key} disabled={login.saving} placeholder="API 키 붙여넣기" autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => login.setKey(event.target.value)} />
      {login.error ? <div className="text-danger text-[13px]">{login.error}</div> : null}
      {login.saved ? <div className="text-ok">{openCodeProviderLabel(login.saved)} 키를 저장했습니다.</div> : null}
      {login.saved
        ? <button type="button" className={primary} onClick={onClose}>닫기</button>
        : <button type="button" className={primary} disabled={!login.canSave} onClick={() => { void login.save(); }}>{login.saving ? '저장 중…' : '저장'}</button>}
      <div className="text-[12px] text-muted">ChatGPT·GitHub 같은 계정 로그인은 작업대의 설정 → OpenCode → 로그인 → 「터미널로 로그인」에서 합니다.</div>
    </div>
  );
}

/** Used by SettingsScreen: OpenCode's sign-in with a provider API key; `onDone` refreshes the engine rows. */
export function OpenCodeLoginSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="OpenCode 로그인 (API 키)">
      {open ? <OpenCodeLoginBody onClose={onClose} onDone={onDone} /> : null}
    </BottomSheet>
  );
}
