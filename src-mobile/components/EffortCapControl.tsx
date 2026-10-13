import { EFFORT_LABEL, MODEL_LABEL, useChatEffortCap, useChatModelFloor } from '@/modules/aidev-router';

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
