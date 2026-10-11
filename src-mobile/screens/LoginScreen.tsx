import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '@/modules/chat-core';

/** Mobile sign-in against the gateway session (same account as the workbench). A new or reset account (gateway /admin)
 *  is asked for a new password after its initial one, and signs in with that. */
export function LoginScreen() {
  const { user, login, changePassword, isLoading } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the password was right but the account must choose a new one: the form asks for it instead
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  if (user) {
    return <Navigate to="/" replace />;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mustChange && newPassword.length < 8) { setError('새 비밀번호는 8자 이상이어야 합니다'); return; }
    if (mustChange && newPassword !== confirmPassword) { setError('비밀번호가 일치하지 않습니다'); return; }
    setBusy(true);
    const result = mustChange ? await changePassword(username.trim().toLowerCase(), password, newPassword) : await login(username.trim().toLowerCase(), password);
    setBusy(false);
    if (result.success) {
      navigate('/', { replace: true });
    } else if (result.passwordChangeRequired) {
      setMustChange(true);
    } else {
      setError(result.error || '로그인에 실패했습니다');
    }
  };
  const field = 'w-full h-12 rounded-xl border border-line bg-surface px-4 text-[16px] outline-none focus:border-accent';
  return (
    <div className="m-app justify-center px-6 pb-safe-b">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8">
          <img src="/logo-128.png" alt="" className="mb-4 h-16 w-16 rounded-full" />
          <div className="text-2xl font-semibold tracking-tight">NadoVibe</div>
          <div className="text-muted text-sm mt-1">모바일 채팅으로 명령하고, 전문 agent가 실행합니다.</div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {mustChange ? (
            <>
              <div className="text-[14px] font-semibold">새 비밀번호 정하기</div>
              <div className="text-muted text-sm">처음 로그인하거나 비밀번호가 초기화된 계정입니다. 사용할 비밀번호를 정하면 로그인됩니다.</div>
              <input className={field} placeholder="새 비밀번호 (8자 이상)" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              <input className={field} placeholder="새 비밀번호 확인" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </>
          ) : (
            <>
              <input className={field} placeholder="아이디" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
              <input className={field} placeholder="비밀번호" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </>
          )}
          {error ? <div className="text-danger text-sm">{error}</div> : null}
          <button type="submit" disabled={busy || isLoading || !username || !password || (mustChange && (!newPassword || !confirmPassword))} className="w-full h-12 rounded-xl bg-accent text-accent-ink font-semibold disabled:opacity-50">
            {busy ? '확인 중…' : mustChange ? '비밀번호 변경하고 로그인' : '로그인'}
          </button>
          {mustChange ? <button type="button" onClick={() => { setMustChange(false); setPassword(''); setNewPassword(''); setConfirmPassword(''); setError(null); }} className="block w-full text-center text-muted text-xs underline">로그인으로 돌아가기</button> : null}
        </form>
        <a href="/?ui=workbench" className="block text-center text-muted text-xs mt-6 underline">데스크탑 작업대로 열기</a>
      </div>
    </div>
  );
}
