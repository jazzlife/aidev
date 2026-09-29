import { EFFORT_LABEL, useEffortCap } from '@/modules/aidev-router';

/**
 * Reasoning-effort ceiling per engine (routing never goes above it; the top tier runs at it).
 * Used by the settings screen and the chat's routing sheet, so it is reachable from where a run happens.
 */
export function EffortCapControl({ compact = false }: { compact?: boolean }) {
  const effort = useEffortCap();
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
      <div className="text-[12px] text-muted mt-2">{effort.error ?? (compact ? '가장 어려운 작업은 이 강도로, 나머지는 이 값을 넘지 않게 실행합니다. 높을수록 사용량이 늘어납니다.' : '가장 어려운 작업(D4)은 이 강도로 실행하고, 다른 등급도 이 값을 넘지 않습니다. 실패 후 이어서 시도할 때도 여기까지 올립니다. 높을수록 구독 사용량이 많이 듭니다.')}</div>
    </div>
  );
}
