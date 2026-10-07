import { EFFORT_LABEL, MODEL_LABEL, useChatEffortCap, useChatModelFloor, useEffortCap, useModelFloor } from '@/modules/aidev-router';

/**
 * Settings: the account's default reasoning-effort ceiling per engine (routing never goes above it;
 * the top tier runs at it). A chat can set its own with ChatEffortCapControl.
 */
export function EffortCapControl({ compact = false }: { compact?: boolean }) {
  const effort = useEffortCap();
  const floor = useModelFloor();
  if (!effort.cap || !effort.ladder) return compact ? null : <div className="rounded-xl2 border border-line bg-surface px-4 py-3 text-[14px] text-muted">{effort.error ?? '불러오는 중…'}</div>;
  return (
    <div data-testid="effort-cap-control">
      <div className={compact ? 'grid grid-cols-2 gap-2' : 'rounded-xl2 border border-line bg-surface divide-y divide-line'}>
        {(['claude', 'codex'] as const).map((engine) => (
          <label key={engine} className={compact ? 'flex flex-col gap-1 rounded-xl border border-line px-3 py-2' : 'px-4 py-3 flex items-center gap-3'}>
            <span className={compact ? 'text-[12px] text-muted capitalize' : 'flex-1 text-[15px] capitalize'}>{engine}</span>
            <select aria-label={`${engine} effort 상한`} value={effort.cap![engine]} onChange={(event) => { void effort.save(engine, event.target.value); }} className="h-9 rounded-lg border border-line bg-elevated px-2 text-[14px]">
              {effort.ladder![engine].map((level) => <option key={level} value={level}>{level} · {EFFORT_LABEL[level] ?? level}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="text-[12px] text-muted mt-2">{effort.error ?? (compact ? '가장 어려운 작업은 이 강도로, 나머지는 이 값을 넘지 않게 실행합니다. 높을수록 사용량이 늘어납니다.' : '모든 채팅의 기본값입니다(채팅의 라우팅 칩에서 그 채팅만 따로 정할 수 있습니다). 가장 어려운 작업(D4)은 이 강도로 실행하고, 다른 등급도 이 값을 넘지 않습니다. 높을수록 구독 사용량이 많이 듭니다.')}</div>
      <div className={`${compact ? 'text-[12px]' : 'text-[12px] uppercase tracking-wide'} text-muted mt-4 mb-2`}>최소 모델 (모델 하한)</div>
      {floor.floor && floor.ladder ? (
        <div className={compact ? 'grid grid-cols-2 gap-2' : 'rounded-xl2 border border-line bg-surface divide-y divide-line'} data-testid="model-floor-control">
          {(['claude', 'codex'] as const).map((engine) => (
            <label key={engine} className={compact ? 'flex flex-col gap-1 rounded-xl border border-line px-3 py-2' : 'px-4 py-3 flex items-center gap-3'}>
              <span className={compact ? 'text-[12px] text-muted capitalize' : 'flex-1 text-[15px] capitalize'}>{engine}</span>
              <select aria-label={`${engine} 최소 모델`} value={floor.floor![engine] ?? ''} onChange={(event) => { void floor.save(engine, event.target.value); }} className="h-9 rounded-lg border border-line bg-elevated px-2 text-[14px]">
                <option value="">하한 없음</option>
                {floor.ladder![engine].map((model) => <option key={model} value={model}>{MODEL_LABEL[model] ?? model}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : null}
      <div className="text-[12px] text-muted mt-2">{floor.error ?? '라우터가 어떤 깊이로 판정하든 이 모델보다 약한 모델로는 실행하지 않습니다. 고차원 작업이 Sonnet에 배정되지 않게 하려면 Opus 이상으로 두세요.'}</div>
    </div>
  );
}

/** Chat routing sheet: this chat's own ceiling; "기본값" follows the account default from Settings. */
export function ChatEffortCapControl({ sessionId }: { sessionId: string | null }) {
  const chat = useChatEffortCap(sessionId);
  const chatFloor = useChatModelFloor(sessionId);
  if (!chat.defaults || !chat.ladder) return null;
  return (
    <div data-testid="chat-effort-cap">
      <div className="grid grid-cols-2 gap-2">
        {(['claude', 'codex'] as const).map((engine) => (
          <label key={engine} className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2">
            <span className="text-[12px] text-muted capitalize">{engine}</span>
            <select aria-label={`${engine} 이 채팅 effort 상한`} value={chat.cap?.[engine] ?? 'default'} onChange={(event) => { void chat.set(engine, event.target.value); }} className="h-9 rounded-lg border border-line bg-elevated px-2 text-[14px]">
              <option value="default">기본값 ({chat.defaults![engine]})</option>
              {chat.ladder![engine].map((level) => <option key={level} value={level}>{level} · {EFFORT_LABEL[level] ?? level}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="text-[12px] text-muted mt-2">{chat.error ?? '이 채팅에만 적용됩니다. 기본값은 설정에서 바꿉니다.'}</div>
      {chatFloor.defaults && chatFloor.ladder ? (
        <div className="mt-3" data-testid="chat-model-floor">
          <div className="text-[12px] text-muted mb-1">이 채팅의 최소 모델</div>
          <div className="grid grid-cols-2 gap-2">
            {(['claude', 'codex'] as const).map((engine) => (
              <label key={engine} className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2">
                <span className="text-[12px] text-muted capitalize">{engine}</span>
                <select aria-label={`${engine} 이 채팅 최소 모델`} value={chatFloor.floor?.[engine] ?? 'default'} onChange={(event) => { void chatFloor.set(engine, event.target.value); }} className="h-9 rounded-lg border border-line bg-elevated px-2 text-[14px]">
                  <option value="default">기본값 ({chatFloor.defaults![engine] ? MODEL_LABEL[chatFloor.defaults![engine]!] ?? chatFloor.defaults![engine] : '하한 없음'})</option>
                  {chatFloor.ladder![engine].map((model) => <option key={model} value={model}>{MODEL_LABEL[model] ?? model}</option>)}
                </select>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
