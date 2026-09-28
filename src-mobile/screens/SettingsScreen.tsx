import { useEffect, useState } from 'react';

import { useAuth } from '@/modules/chat-core';
import { aidevApi, claudeAuth, EFFORT_LABEL, routingStore, useClaudeAuth, useEffortCap, useRoutingState, type EnginesResult, type RoutingMode } from '@/modules/aidev-router';
import { ClaudeLoginSheet } from '@m/components/ClaudeLoginSheet';
import { KnowledgeSection } from '@m/components/KnowledgeSection';
import { disablePush, enablePush, pushState, type PushState } from '@m/lib/push';

const PUSH_LABEL: Record<PushState, string> = { on: '켜짐', off: '꺼짐', denied: '브라우저에서 차단됨 (설정에서 허용)', needs_install: '홈 화면에 추가한 앱에서 켤 수 있습니다', unsupported: '이 브라우저는 지원하지 않습니다' };
import { TopBar } from '@m/components/TopBar';

const MODES: Array<{ value: RoutingMode; label: string; hint: string }> = [
  { value: 'auto', label: '자동', hint: '명령마다 전문 agent·엔진·모델을 고르고 바로 적용' },
  { value: 'manual', label: '확인 후', hint: '판정 결과를 보여주고, 적용은 내가 선택' },
  { value: 'off', label: '끄기', hint: '라우팅 없이 기본 설정으로 전송' },
];

/** Mobile settings: routing mode, engine status, UI switch, sign out. */
export function SettingsScreen() {
  const { user, logout } = useAuth();
  const routing = useRoutingState();
  const [engines, setEngines] = useState<EnginesResult | null>(null);
  const auth = useClaudeAuth();
  const effort = useEffortCap();
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
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
      <TopBar title="설정" back="/" />
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
        {effort.cap && effort.ladder ? (
          <section data-testid="effort-cap">
            <div className="text-[12px] uppercase tracking-wide text-muted mb-2">추론 강도(effort) 상한</div>
            <div className="rounded-xl2 border border-line bg-surface divide-y divide-line">
              {(['claude', 'codex'] as const).map((engine) => (
                <label key={engine} className="px-4 py-3 flex items-center gap-3">
                  <span className="flex-1 text-[15px] capitalize">{engine}</span>
                  <select aria-label={`${engine} effort 상한`} value={effort.cap![engine]} onChange={(event) => { void effort.save(engine, event.target.value); }} className="h-9 rounded-lg border border-line bg-elevated px-2 text-[14px]">
                    {effort.ladder![engine].map((level) => <option key={level} value={level}>{level} · {EFFORT_LABEL[level] ?? level}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <div className="text-[12px] text-muted mt-2">{effort.error ?? '가장 어려운 작업(D4)은 이 강도로 실행하고, 다른 등급도 이 값을 넘지 않습니다. 실패 후 이어서 시도할 때도 여기까지 올립니다. 높을수록 구독 사용량이 많이 듭니다.'}</div>
          </section>
        ) : null}
        <section>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">엔진</div>
          <div className="rounded-xl2 border border-line bg-surface divide-y divide-line">
            {(['claude', 'codex'] as const).map((engine) => {
              const state = engines?.engines[engine];
              return (
                <div key={engine} className="px-4 py-3 flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${!state ? 'bg-line' : !state.allowed ? 'bg-line' : state.authenticated ? 'bg-ok' : 'bg-warn'}`} />
                  <span className="flex-1 text-[15px] capitalize">{engine}</span>
                  <span className="text-[12px] text-muted">{!state ? '…' : !state.allowed ? '이 계정에 없음' : state.authenticated ? (engine === 'claude' && auth.daysLeft !== null ? `연결됨 · D-${auth.daysLeft}` : '연결됨') : (state.error || '로그인 필요')}</span>
                  {engine === 'claude' && state?.allowed ? <button type="button" onClick={() => claudeAuth.openDialog()} className="text-[13px] text-accent">{state.authenticated && !auth.expired ? '다시 로그인' : '로그인'}</button> : null}
                </div>
              );
            })}
          </div>
          {engines ? <div className="text-[12px] text-muted mt-2">기본 엔진: {engines.default_engine ?? '자동 선택'}</div> : null}
        </section>
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
        <section>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">계정</div>
          <div className="rounded-xl2 border border-line bg-surface px-4 py-3 flex items-center">
            <span className="flex-1 text-[15px]">{user?.username}</span>
            <button type="button" onClick={logout} className="text-danger text-[14px]">로그아웃</button>
          </div>
        </section>
      </main>
    </div>
  );
}
