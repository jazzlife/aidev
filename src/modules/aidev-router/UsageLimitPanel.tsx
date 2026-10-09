import { formatResetTime, useUsageLimits, type UsageLimitView } from '@/modules/aidev-router/hooks/useUsageLimits';

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * The two apps have different Tailwind themes: the workbench's shadcn tokens, the mobile app's `--m-*`
 * tokens (and its CSS only carries classes used under src-mobile plus this file). So the compact (mobile)
 * variant draws with the mobile tokens and the workbench variant with its own.
 */
type Palette = { muted: string; track: string; ok: string; warn: string; bad: string; unknownDot: string };
const WORKBENCH: Palette = { muted: 'text-muted-foreground', track: 'bg-muted', ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', unknownDot: 'bg-muted-foreground/40' };
const MOBILE: Palette = { muted: 'text-muted', track: 'bg-line', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-danger', unknownDot: 'bg-muted/40' };

/** Bar colour by how full the window is. */
const tone = (palette: Palette, percent: number | null, blocked: boolean) => (blocked || (percent ?? 0) >= 90 ? palette.bad : (percent ?? 0) >= 70 ? palette.warn : palette.ok);

function EngineUsage({ view, compact, now }: { view: UsageLimitView; compact: boolean; now: number }) {
  const palette = compact ? MOBILE : WORKBENCH;
  const blocked = view.blockedUntil !== null;
  const small = compact ? 'text-[12px]' : 'text-[11px]';
  return (
    <div className={compact ? 'px-3 py-2' : 'px-2.5 py-1.5'} data-testid={`usage-${view.engine}`} data-blocked={blocked || undefined}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${view.unknown ? palette.unknownDot : blocked ? palette.bad : palette.ok}`} />
        <span className={`${compact ? 'text-[14px]' : 'text-xs'} font-medium`}>{ENGINE_LABEL[view.engine] ?? view.engine}</span>
        {/* a status only when there is something to say: no picture yet, or a refusal in force */}
        {view.unknown || blocked ? (
          <span className={`ml-auto ${small} ${palette.muted}`}>
            {view.unknown ? '아직 정보 없음' : `한도 도달 · ${view.blockedUntil ? `${formatResetTime(view.blockedUntil, now)} 해제` : '해제 시각 미정'}`}
          </span>
        ) : null}
      </div>
      {view.windows.length ? (
        <ul className={`mt-1 grid grid-cols-[auto_minmax(0,1fr)_2rem] items-center gap-x-2 gap-y-1 ${small} ${palette.muted}`}>
          {/* one line per window: "name (reset time)", the bar, how much is used — the grid keeps the bars aligned */}
          {view.windows.map((window) => (
            <li key={window.type} className="contents">
              <span className="whitespace-nowrap tabular-nums">{window.label}{window.resetsAt ? <span className="opacity-80"> ({formatResetTime(window.resetsAt, now)})</span> : null}</span>
              <div className={`h-1.5 overflow-hidden rounded-full ${palette.track}`}>
                {window.percent !== null ? <div className={`h-full rounded-full ${tone(palette, window.percent, window.blocked)}`} style={{ width: `${Math.min(100, window.percent)}%` }} /> : null}
              </div>
              <span className="text-right tabular-nums">{window.percent !== null ? `${window.percent}%` : '—'}</span>
            </li>
          ))}
        </ul>
      ) : view.unknown ? null : <div className={`mt-1 ${small} ${palette.muted}`}>사용량 수치 없음</div>}
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
  const palette = compact ? MOBILE : WORKBENCH;
  // one clock per render: the reset times are relative to it
  const now = Date.now();
  return (
    <div data-testid="usage-limit-panel" className={compact ? 'divide-y divide-line rounded-xl border border-line bg-bg' : 'px-1 py-1'}>
      {!loaded ? <div className={`${compact ? 'px-3 py-2 text-[12px]' : 'px-2.5 py-1 text-[11px]'} ${palette.muted}`}>불러오는 중…</div> : views.map((view) => <EngineUsage key={view.engine} view={view} compact={compact} now={now} />)}
    </div>
  );
}
