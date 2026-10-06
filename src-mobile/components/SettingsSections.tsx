import { useEffect, useState } from 'react';
import { GitBranch, Volume2, X } from 'lucide-react';

import { api, getClaudeSettings, subscribeToUserPreferences, voicePlayer, writeUserPreference } from '@/modules/chat-core';
import { readVoiceConfig } from '@/shared/voiceConfig';
import { GithubLogin } from '@m/components/GithubLogin';
import { failureText } from '@m/lib/http';
import { useVoiceStatus, writeVoiceConfig, writeVoiceEnabled } from '@m/lib/voice';

const sectionTitle = 'text-[12px] uppercase tracking-wide text-muted mb-2';
const card = 'rounded-xl2 border border-line bg-surface';

/**
 * Used by the settings screen (C-12.9): Claude's saved rules — "항상 허용" from a chat adds to them — listed with a
 * remove each. They live in the server-synced `claudePermissions`, so the workbench's list changes too. Codex keeps no
 * rules: each conversation's permission mode decides.
 */
export function PermissionRulesSection() {
  // the saved rules, re-read when they change (here, in a chat, or from the server)
  const [settings, setSettings] = useState(getClaudeSettings);
  useEffect(() => subscribeToUserPreferences(() => setSettings(getClaudeSettings())), []);
  const remove = (list: 'allowedTools' | 'disallowedTools', entry: string) => {
    const next = { allowedTools: settings.allowedTools, disallowedTools: settings.disallowedTools, skipPermissions: settings.skipPermissions, [list]: settings[list].filter((rule) => rule !== entry) };
    writeUserPreference('claudePermissions', next);
    setSettings(getClaudeSettings());
  };
  const rows = [
    ...settings.allowedTools.map((rule) => ({ list: 'allowedTools' as const, rule, label: '허용' })),
    ...settings.disallowedTools.map((rule) => ({ list: 'disallowedTools' as const, rule, label: '거부' })),
  ];
  return (
    <section data-testid="permission-rules">
      <div className={sectionTitle}>허용 규칙</div>
      <div className={`${card} divide-y divide-line`}>
        {rows.length === 0 ? <div className="px-4 py-3 text-[13px] text-muted">저장된 규칙이 없습니다. 채팅의 권한 요청에서 "항상 허용"을 누르면 여기에 쌓입니다.</div> : null}
        {rows.map(({ list, rule, label }) => (
          <div key={`${list}:${rule}`} className="flex items-center gap-2 pl-4 pr-1 py-1.5">
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${list === 'allowedTools' ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>{label}</span>
            <code className="min-w-0 flex-1 truncate text-[13px]">{rule}</code>
            <button type="button" aria-label={`${rule} 규칙 지우기`} onClick={() => remove(list, rule)} className="m-touch flex shrink-0 items-center justify-center text-muted"><X size={16} /></button>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[12px] text-muted">Claude 대화에 적용되고 작업대와 같이 씁니다. Codex는 대화마다 권한 모드로 정합니다.</div>
    </section>
  );
}

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const BACKEND_LABEL = { own: '내 엔드포인트(이 기기)', server: '서버 음성 연결됨', none: '음성 백엔드 없음 — 작업대 설정에서 연결하세요', checking: '확인 중…' } as const;

/** Used by the settings screen (C-12.9): voice on or off (shared with the workbench), what answers, and the read-aloud voice. */
export function VoiceSection() {
  const status = useVoiceStatus();
  // the read-aloud voice on this device ('' = the backend's default)
  const [voice, setVoice] = useState(() => readVoiceConfig().ttsVoice);
  const choose = (next: string) => { setVoice(next); writeVoiceConfig({ ttsVoice: next }); };
  const voices = voice && !VOICES.includes(voice) ? [voice, ...VOICES] : VOICES;
  const usable = status.backend === 'own' || status.backend === 'server';
  return (
    <section data-testid="voice-settings">
      <div className={sectionTitle}>음성</div>
      <div className={`${card} divide-y divide-line`}>
        <div className="px-4 py-3 flex items-center gap-3">
          <span className="flex-1"><div className="text-[15px]">음성 입력·읽어 주기</div><div className="text-[12px] text-muted">{BACKEND_LABEL[status.backend]}</div></span>
          <button type="button" role="switch" aria-checked={status.enabled} aria-label="음성" onClick={() => writeVoiceEnabled(!status.enabled)} className={`w-12 h-7 rounded-full p-0.5 transition-colors ${status.enabled ? 'bg-accent' : 'bg-line'}`}><span className={`block w-6 h-6 rounded-full bg-surface shadow transition-transform ${status.enabled ? 'translate-x-5' : ''}`} /></button>
        </div>
        <label className="px-4 py-3 flex items-center gap-3">
          <span className="flex-1 text-[15px]">읽어 주기 목소리</span>
          <select value={voice} onChange={(e) => choose(e.target.value)} aria-label="읽어 주기 목소리" className="h-9 rounded-lg border border-line bg-bg px-2 text-[14px]">
            <option value="">기본</option>
            {voices.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        {status.enabled && usable ? (
          <button type="button" className="w-full px-4 py-3 text-left text-[15px] text-accent flex items-center gap-2" onClick={() => { voicePlayer.unlock(); voicePlayer.toggle('안녕하세요. 읽어 주기 목소리입니다.'); }}><Volume2 size={17} /> 들어 보기</button>
        ) : null}
      </div>
    </section>
  );
}

type GithubToken = { id: number; credential_name: string; is_active: boolean | number; created_at?: string };

/**
 * Used by the settings screen: the GitHub accounts connected on this runtime (stored `github_token` credentials, the
 * workbench's too). Adding a project by clone lists the first active one's repositories and clones private ones with it.
 */
export function GithubSection({ notice }: { /** the GitHub login's outcome, back from github.com */ notice?: { text: string; error: boolean } | null }) {
  // the connected tokens (null: loading)
  const [tokens, setTokens] = useState<GithubToken[] | null>(null);
  // a request in flight, and the server's words when one failed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.settings.credentials('github_token').then(async (r) => setTokens(((await r.json()) as { credentials?: GithubToken[] }).credentials ?? [])).catch(() => setTokens([]));
  useEffect(() => { void load(); }, []);
  const run = async (action: () => Promise<Response>) => {
    setBusy(true); setError(null);
    try { const r = await action(); if (!r.ok) throw new Error(await failureText(r)); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '실패했습니다'); }
    finally { setBusy(false); }
  };
  return (
    <section data-testid="github-settings">
      <div className={sectionTitle}>GitHub 계정</div>
      <div className={`${card} divide-y divide-line`}>
        {tokens === null ? <div className="px-4 py-3 text-[13px] text-muted m-pulse">불러오는 중…</div> : null}
        {tokens?.map((t) => (
          <div key={t.id} className="flex items-center gap-2 pl-4 pr-1 py-1.5">
            <GitBranch size={15} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-[15px]">{t.credential_name}{t.is_active ? '' : ' (꺼짐)'}</span>
            <button type="button" aria-label={`${t.credential_name} 연결 해제`} disabled={busy} onClick={() => { void run(() => api.settings.deleteCredential(String(t.id))); }} className="m-touch flex shrink-0 items-center justify-center text-muted"><X size={16} /></button>
          </div>
        ))}
        <div className="space-y-2 px-4 py-3">
          {tokens && tokens.length === 0 ? <div className="text-[13px] text-muted">연결된 계정이 없습니다. 프로젝트 추가의 Git 복제가 이 계정의 저장소를 보여 줍니다.</div> : null}
          {notice ? <div className={`rounded-lg px-3 py-2 text-[13px] ${notice.error ? 'bg-danger/10 text-danger' : 'bg-ok/10 text-ok'}`} role="status">{notice.text}</div> : null}
          <GithubLogin returnTo="/m/settings" onConnected={() => { void load(); }} />
          {error ? <div className="text-[13px] text-danger" role="alert">{error}</div> : null}
        </div>
      </div>
    </section>
  );
}
