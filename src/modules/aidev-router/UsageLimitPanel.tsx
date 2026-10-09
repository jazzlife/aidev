import { formatResetTime, useUsageLimits, type UsageLimitView } from '@/modules/aidev-router/hooks/useUsageLimits';

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** Bar colour by how full the window is. */
const tone = (percent: number | null, blocked: boolean) => (blocked || (percent ?? 0) >= 90 ? 'bg-red-500' : (percent ?? 0) >= 70 ? 'bg-amber-500' : 'bg-emerald-500');

function EngineUsage({ view, compact }: { view: UsageLimitView; compact: boolean }) {
  const now = Date.now();
  const blocked = view.blockedUntil !== null;
  return (
    <div className={compact ? 'px-3 py-2' : 'px-2.5 py-1.5'} data-testid={`usage-${view.engine}`} data-blocked={blocked || undefined}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${view.unknown ? 'bg-muted-foreground/40' : blocked ? 'bg-red-500' : 'bg-emerald-500'}`} />
        <span className={`${compact ? 'text-[14px]' : 'text-xs'} font-medium`}>{ENGINE_LABEL[view.engine] ?? view.engine}</span>
        <span className={`ml-auto ${compact ? 'text-[12px]' : 'text-[11px]'} text-muted-foreground`}>
          {view.unknown ? '아직 정보 없음' : blocked ? `한도 도달 · ${view.blockedUntil ? `${formatResetTime(view.blockedUntil, now)} 해제` : '해제 시각 미정'}` : '한도 내'}
        </span>
      </div>
      {view.windows.length ? (
        <ul className="mt-1.5 space-y-1">
          {view.windows.map((window) => (
            <li key={window.type} className={`${compact ? 'text-[12px]' : 'text-[11px]'} text-muted-foreground`}>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0">{window.label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  {window.percent !== null ? <div className={`h-full rounded-full ${tone(window.percent, window.blocked)}`} style={{ width: `${Math.min(100, window.percent)}%` }} /> : null}
                </div>
                <span className="w-14 shrink-0 text-right tabular-nums">{window.percent !== null ? `${window.percent}% 사용` : '—'}</span>
              </div>
              {window.resetsAt ? <div className="pl-[4.5rem] text-[10px] opacity-80">{window.blocked ? '해제' : '초기화'} {formatResetTime(window.resetsAt, now)}</div> : null}
            </li>
          ))}
        </ul>
      ) : view.unknown ? null : <div className={`mt-1 ${compact ? 'text-[12px]' : 'text-[11px]'} text-muted-foreground`}>사용량 수치 없음</div>}
    </div>
  );
}

/**
 * Used by the mobile drawer (compact), the workbench sessions panel (desktop docked, tablet drawer) and
 * the legacy sidebar footer: each connected engine's account usage — the five-hour / weekly windows
 * with how much of each is used and when they reset, or that the engine is refusing until a time.
 * Claude's comes from its turn events (so before the first turn it says so), Codex's from the account.
 */
export function UsageLimitPanel({ compact = false }: { compact?: boolean }) {
  const { views, loaded } = useUsageLimits();
  return (
    <div data-testid="usage-limit-panel" className={compact ? 'rounded-xl border border-line bg-bg divide-y divide-line' : 'px-1 py-1'}>
      {!loaded ? <div className={`${compact ? 'px-3 py-2 text-[12px]' : 'px-2.5 py-1 text-[11px]'} text-muted-foreground`}>불러오는 중…</div> : views.map((view) => <EngineUsage key={view.engine} view={view} compact={compact} />)}
    </div>
  );
}
