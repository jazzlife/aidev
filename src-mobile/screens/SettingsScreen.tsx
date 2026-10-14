import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { aidevApi, claudeAuth, routingStore, useClaudeAuth, useRoutingState, type EnginesResult, type RoutingMode } from '@/modules/aidev-router';
import { OpenCodeLoginSheet } from '@m/components/OpenCodeLoginSheet';
import { AIDEV_ENGINES, ENGINE_LABELS, PROVIDER_MODELS_CHANGED_EVENT } from '@/shared/constants';
import type { AidevEngine } from '@/shared/types';
import { ProviderPolicySection } from '@m/components/ProviderPolicySection';
import { ClaudeLoginSheet } from '@m/components/ClaudeLoginSheet';
import { KnowledgeSection } from '@m/components/KnowledgeSection';
import { DefaultPermissionSection, GithubSection, PermissionRulesSection, VoiceSection } from '@m/components/SettingsSections';
import { takeGithubReturn } from '@m/lib/githubReturn';
import { disablePush, enablePush, pushState, type PushState } from '@m/lib/push';

const PUSH_LABEL: Record<PushState, string> = { on: '켜짐', off: '꺼짐', denied: '브라우저에서 차단됨 (설정에서 허용)', needs_install: '홈 화면에 추가한 앱에서 켤 수 있습니다', unsupported: '이 브라우저는 지원하지 않습니다' };
import { TopBar } from '@m/components/TopBar';
import { useParent } from '@m/lib/nav';

const MODES: Array<{ value: RoutingMode; label: string; hint: string }> = [
  { value: 'auto', label: '자동', hint: '명령마다 전문 agent·엔진·모델을 고르고 바로 적용' },
  { value: 'manual', label: '확인 후', hint: '판정 결과를 보여주고, 적용은 내가 선택' },
  { value: 'off', label: '끄기', hint: '라우팅 없이 기본 설정으로 전송' },
];

/** Mobile settings: routing mode, effort cap, engines, saved permission rules, voice, notifications, UI switch, sign out. */
export function SettingsScreen() {
  useParent('/');
  const routing = useRoutingState();
  // back from GitHub login started here: its outcome above the accounts
  const [githubNotice] = useState(takeGithubReturn);
  const [engines, setEngines] = useState<EnginesResult | null>(null);
  const auth = useClaudeAuth();
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  // the engine being signed out (its button waits) and why the last sign-out failed
  const [loggingOut, setLoggingOut] = useState<AidevEngine | null>(null);
  const [engineNote, setEngineNote] = useState<string | null>(null);
  // the OpenCode API-key login sheet
  const [openCodeLogin, setOpenCodeLogin] = useState(false);
  const logout = async (engine: AidevEngine) => {
    const name = ENGINE_LABELS[engine];
    if (!window.confirm(`${name}에서 로그아웃할까요? 실행 중인 작업이 멈출 수 있고, 다시 쓰려면 로그인해야 합니다.`)) return;
    setLoggingOut(engine); setEngineNote(null);
    try {
      const response = await api.providers.logout(engine);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      setEngineNote(`${name} 로그아웃 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoggingOut(null);
      if (engine === 'claude') void claudeAuth.refresh();
      aidevApi.engines(true).then(setEngines).catch(() => setEngines(null));
      // the drawer's usage drops the signed-out engine now
      window.dispatchEvent(new Event(PROVIDER_MODELS_CHANGED_EVENT));
    }
  };
  useEffect(() => { void pushState().then(setPush).catch(() => setPush('unsupported')); }, []);
  // Opened from a reminder notification (/m/settings?login=claude): go straight to the login sheet.
  useEffect(() => { if (new URLSearchParams(window.location.search).get('login') === 'claude') claudeAuth.openDialog(); }, []);
  const togglePush = async () => {
    setPushBusy(true); setPushNote(null);
    try { setPush(push === 'on' ? await disablePush() : await enablePush()); }
    catch (error) { setPushNote(error instanceof Error ? error.message : '알림 설정 실패'); }
    finally { setPushBusy(false); }
  };
  // re-probe after a login finished in the sheet (the dialog closes on completion)
  useEffect(() => { if (!auth.dialogOpen) aidevApi.engines(true).then(setEngines).catch(() => setEngines(null)); }, [auth.dialogOpen]);
  const switchToWorkbench = () => {
    document.cookie = 'aidev_ui=workbench; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
    window.location.href = '/';
  };
  return (
    <div className="m-app">
      <ClaudeLoginSheet />
      <TopBar title="설정" back />
      <main className="m-scroll flex-1 px-4 py-4 space-y-6 pb-safe-b">
        <section>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">라우팅</div>
          <div className="rounded-xl2 border border-line bg-surface divide-y divide-line">
            {MODES.map((mode) => (
              <button key={mode.value} type="button" className="w-full text-left px-4 py-3 flex items-center gap-3" onClick={() => routingStore.setMode(mode.value)}>
                <span className={`w-4 h-4 rounded-full border ${routing.mode === mode.value ? 'bg-accent border-accent' : 'border-line'}`} />
                <span className="flex-1"><div className="text-[15px]">{mode.label}</div><div className="text-[12px] text-muted">{mode.hint}</div></span>
              </button>
            ))}
          </div>
        </section>
        <section data-testid="effort-cap">
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">공급자 정책</div>
          <ProviderPolicySection />
        </section>
        <section>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">엔진</div>
          <div className="rounded-xl2 border border-line bg-surface divide-y divide-line">
            {/* OpenCode is listed for the accounts an administrator enabled it for */}
            {AIDEV_ENGINES.filter((engine) => engine !== 'opencode' || engines?.engines.opencode?.allowed).map((engine) => {
              const state = engines?.engines[engine];
              return (
                <div key={engine} className="px-4 py-3 flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${!state ? 'bg-line' : !state.allowed ? 'bg-line' : state.authenticated ? 'bg-ok' : 'bg-warn'}`} />
                  <span className="flex-1 text-[15px]">{ENGINE_LABELS[engine]}</span>
                  <span className="text-[12px] text-muted">{!state ? '…' : !state.allowed ? '이 계정에 없음' : state.authenticated ? (engine === 'claude' && auth.daysLeft !== null ? `연결됨 · D-${auth.daysLeft}` : '연결됨') : (state.error || '로그인 필요')}</span>
                  {engine === 'claude' && state?.allowed ? <button type="button" onClick={() => claudeAuth.openDialog()} className="text-[13px] text-accent">{state.authenticated && !auth.expired ? '다시 로그인' : '로그인'}</button> : null}
                  {engine === 'opencode' && state?.allowed ? <button type="button" onClick={() => setOpenCodeLogin(true)} className="text-[13px] text-accent">{state.authenticated ? '키 추가' : '로그인'}</button> : null}
                  {state?.allowed && state.authenticated ? <button type="button" disabled={loggingOut !== null} onClick={() => { void logout(engine); }} className="text-[13px] text-muted">{loggingOut === engine ? '로그아웃 중…' : '로그아웃'}</button> : null}
                </div>
              );
            })}
          </div>
          {engineNote ? <div className="text-[12px] text-muted mt-2">{engineNote}</div> : null}
          <OpenCodeLoginSheet open={openCodeLogin} onClose={() => setOpenCodeLogin(false)} onDone={() => { aidevApi.engines(true).then(setEngines).catch(() => undefined); }} />
        </section>
        <DefaultPermissionSection />
        <PermissionRulesSection />
        <GithubSection notice={githubNotice} />
        <VoiceSection />
        <section>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">알림</div>
          <div className="rounded-xl2 border border-line bg-surface divide-y divide-line">
            <div className="px-4 py-3 flex items-center gap-3">
              <span className="flex-1"><div className="text-[15px]">푸시 알림</div><div className="text-[12px] text-muted">Claude 로그인 만료 30·7·1일 전·만료 시, 지식 갱신 결과</div></span>
              {push === 'on' || push === 'off'
                ? <button type="button" role="switch" aria-checked={push === 'on'} aria-label="푸시 알림" disabled={pushBusy} onClick={() => { void togglePush(); }} className={`w-12 h-7 rounded-full p-0.5 transition-colors ${push === 'on' ? 'bg-accent' : 'bg-line'}`}><span className={`block w-6 h-6 rounded-full bg-surface shadow transition-transform ${push === 'on' ? 'translate-x-5' : ''}`} /></button>
                : <span className="text-[12px] text-muted text-right max-w-[45%]">{push ? PUSH_LABEL[push] : '…'}</span>}
            </div>
            {push === 'on' ? <button type="button" className="w-full text-left px-4 py-3 text-[15px] text-accent" onClick={() => { void aidevApi.pushTest().then((r) => setPushNote(r.delivered ? '테스트 알림을 보냈습니다' : '보낼 기기가 없습니다')).catch((error: Error) => setPushNote(error.message)); }}>테스트 알림 보내기</button> : null}
          </div>
          {pushNote ? <div className="text-[12px] text-muted mt-2">{pushNote}</div> : null}
        </section>
        <KnowledgeSection />
        <section>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">화면</div>
          <button type="button" onClick={switchToWorkbench} className="w-full rounded-xl2 border border-line bg-surface px-4 py-3 text-left text-[15px]">데스크탑 작업대(IDE)로 전환</button>
        </section>
      </main>
    </div>
  );
}
