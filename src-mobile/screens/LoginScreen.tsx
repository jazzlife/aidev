import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '@/modules/chat-core';

/** Mobile sign-in against the gateway session (same account as the workbench). */
export function LoginScreen() {
  const { user, login, isLoading } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user) {
    return <Navigate to="/" replace />;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    const result = await login(username.trim().toLowerCase(), password);
    setBusy(false);
    if (result.success) {
      navigate('/', { replace: true });
    } else {
      setError(result.error || '로그인에 실패했습니다');
    }
  };
  return (
    <div className="m-app justify-center px-6 pb-safe-b">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8">
          <div className="text-2xl font-semibold tracking-tight">Nado AI Dev</div>
          <div className="text-muted text-sm mt-1">모바일 채팅으로 명령하고, 전문 agent가 실행합니다.</div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input className="w-full h-12 rounded-xl border border-line bg-surface px-4 text-[16px] outline-none focus:border-accent" placeholder="아이디" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
          <input className="w-full h-12 rounded-xl border border-line bg-surface px-4 text-[16px] outline-none focus:border-accent" placeholder="비밀번호" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          {error ? <div className="text-danger text-sm">{error}</div> : null}
          <button type="submit" disabled={busy || isLoading || !username || !password} className="w-full h-12 rounded-xl bg-accent text-accent-ink font-semibold disabled:opacity-50">
            {busy ? '확인 중…' : '로그인'}
          </button>
        </form>
        <a href="/?ui=workbench" className="block text-center text-muted text-xs mt-6 underline">데스크탑 작업대로 열기</a>
      </div>
    </div>
  );
}
