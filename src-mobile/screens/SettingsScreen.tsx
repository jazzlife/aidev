import { useEffect, useState } from 'react';

import { useAuth } from '@/modules/chat-core';
import { aidevApi, routingStore, useRoutingState, type EnginesResult, type RoutingMode } from '@/modules/aidev-router';
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
  useEffect(() => { aidevApi.engines().then(setEngines).catch(() => setEngines(null)); }, []);
  const switchToWorkbench = () => {
    document.cookie = 'aidev_ui=workbench; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
    window.location.href = '/';
  };
  return (
    <div className="m-app">
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
        <section>
          <div className="text-[12px] uppercase tracking-wide text-muted mb-2">엔진</div>
          <div className="rounded-xl2 border border-line bg-surface divide-y divide-line">
            {(['claude', 'codex'] as const).map((engine) => {
              const state = engines?.engines[engine];
              return (
                <div key={engine} className="px-4 py-3 flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${!state ? 'bg-line' : !state.allowed ? 'bg-line' : state.authenticated ? 'bg-ok' : 'bg-warn'}`} />
                  <span className="flex-1 text-[15px] capitalize">{engine}</span>
                  <span className="text-[12px] text-muted">{!state ? '…' : !state.allowed ? '이 계정에 없음' : state.authenticated ? '연결됨' : (state.error || '로그인 필요')}</span>
                </div>
              );
            })}
          </div>
          {engines ? <div className="text-[12px] text-muted mt-2">기본 엔진: {engines.default_engine ?? '자동 선택'}</div> : null}
        </section>
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
