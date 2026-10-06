/** Back from "GitHub로 로그인" the gateway adds ?github=connected&account=… or ?github=error&reason=…; read once, then removed. */
export function takeGithubReturn(): { text: string; error: boolean } | null {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('github');
  if (!result) return null;
  const notice = result === 'connected'
    ? { text: `GitHub 계정이 연결되었습니다${params.get('account') ? ` (@${params.get('account')})` : ''}`, error: false }
    : { text: `GitHub 로그인 실패: ${params.get('reason') || '알 수 없는 오류'}`, error: true };
  for (const key of ['github', 'account', 'reason', 'add']) params.delete(key);
  const query = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  return notice;
}
