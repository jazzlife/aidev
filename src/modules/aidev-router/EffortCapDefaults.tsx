import { EFFORT_LABEL, useEffortCap } from '@/modules/aidev-router/hooks/useEffortCap';

/**
 * Settings → Agents: the account's default reasoning-effort ceiling per engine. Every chat uses it
 * unless that chat sets its own ceiling (router bar / mobile routing sheet).
 */
export function EffortCapDefaults() {
  const effort = useEffortCap();
  return (
    <section className="rounded-lg border border-border p-3 text-sm" data-testid="effort-cap-defaults">
      <div className="font-medium">기본 추론 강도(effort) 상한</div>
      <div className="mt-0.5 text-xs text-muted-foreground">모든 채팅에 적용되는 기본값입니다. 채팅 안(라우터 바 → 모드 메뉴)에서 정한 상한은 그 채팅에만 적용됩니다. 가장 어려운 작업(D4)은 이 강도로 실행하고, 다른 등급도 이 값을 넘지 않습니다. 높을수록 구독 사용량이 많이 듭니다.</div>
      {effort.cap && effort.ladder ? (
        <div className="mt-2 grid max-w-md grid-cols-2 gap-2">
          {(['claude', 'codex'] as const).map((engine) => (
            <label key={engine} className="flex flex-col gap-1">
              <span className="text-xs capitalize text-muted-foreground">{engine}</span>
              <select aria-label={`${engine} 기본 effort 상한`} value={effort.cap![engine]} onChange={(event) => { void effort.save(engine, event.target.value); }} className="h-8 rounded border border-border bg-background px-2">
                {effort.ladder![engine].map((level) => <option key={level} value={level}>{level} · {EFFORT_LABEL[level] ?? level}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : <div className="mt-2 text-xs text-muted-foreground">불러오는 중…</div>}
      {effort.error ? <div className="mt-1 text-xs text-red-600">{effort.error}</div> : null}
    </section>
  );
}
