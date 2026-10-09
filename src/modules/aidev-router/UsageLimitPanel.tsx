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
        <span className={`ml-auto ${small} ${palette.muted}`}>
          {view.unknown ? '아직 정보 없음' : blocked ? `한도 도달 · ${view.blockedUntil ? `${formatResetTime(view.blockedUntil, now)} 해제` : '해제 시각 미정'}` : '한도 내'}
        </span>
      </div>
      {view.windows.length ? (
        <ul className="mt-1 space-y-1">
          {/* one line per window: name, how much is used, and when it resets */}
          {view.windows.map((window) => (
            <li key={window.type} className={`flex items-center gap-2 ${small} ${palette.muted}`}>
              <span className="w-12 shrink-0 truncate">{window.label}</span>
              <div className={`h-1.5 min-w-0 flex-1 overflow-hidden rounded-full ${palette.track}`}>
                {window.percent !== null ? <div className={`h-full rounded-full ${tone(palette, window.percent, window.blocked)}`} style={{ width: `${Math.min(100, window.percent)}%` }} /> : null}
              </div>
              <span className="w-8 shrink-0 text-right tabular-nums">{window.percent !== null ? `${window.percent}%` : '—'}</span>
              <span className="w-[4.5rem] shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums opacity-80">{window.resetsAt ? formatResetTime(window.resetsAt, now) : ''}</span>
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
