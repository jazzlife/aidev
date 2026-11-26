import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { formatTimeLeft, useUsageLimits, type UsageLimitView, type UsageWindowView } from '@/modules/aidev-router/hooks/useUsageLimits';
import { ENGINE_LABELS } from '@/shared/constants';
import { LLMProviderLogo } from '@/shared/ui';


/**
 * The two apps have different Tailwind themes: the workbench's shadcn tokens, the mobile app's `--m-*`
 * tokens (and its CSS only carries classes used under src-mobile plus this file). So the compact (mobile)
 * variant draws with the mobile tokens and the workbench variant with its own.
 */
type Palette = { muted: string; track: string; ok: string; warn: string; bad: string; off: string; warnText: string; badText: string };
const WORKBENCH: Palette = { muted: 'text-muted-foreground', track: 'bg-muted', ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', off: 'bg-muted-foreground/50', warnText: 'text-amber-500', badText: 'text-red-500' };
const MOBILE: Palette = { muted: 'text-muted', track: 'bg-line', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-danger', off: 'bg-muted', warnText: 'text-warn', badText: 'text-danger' };

/** Bar colour by how full the window is. */
const tone = (palette: Palette, percent: number | null, blocked: boolean) => (blocked || (percent ?? 0) >= 90 ? palette.bad : (percent ?? 0) >= 70 ? palette.warn : palette.ok);

/** Figures older than this say when they were read. */
const STALE_AFTER_MS = 10 * 60_000;

/** "14:16" today, "어제 14:16", else "10/12 14:16" — when the runtime last heard the engine's figures. */
export function formatObservedAt(observedAt: number, now = Date.now()): string {
  const at = new Date(observedAt);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  return daysAgo <= 0 ? time : daysAgo === 1 ? `어제 ${time}` : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

function EngineUsage({ view, compact, now }: { view: UsageLimitView; compact: boolean; now: number }) {
  const palette = compact ? MOBILE : WORKBENCH;
  const blocked = view.blockedUntil !== null;
  const small = compact ? 'text-[12px]' : 'text-[11px]';
  return (
    <div className={compact ? 'px-3 py-2' : 'px-2.5 py-1.5'} data-testid={`usage-${view.engine}`} data-blocked={blocked || undefined}>
      <div className="flex items-center gap-2">
        {/* the runtime reports signed-in engines only: green is connected and not refusing, red a limit in force,
            grey signed in but the account could not be reached */}
        <span className={`h-2 w-2 shrink-0 rounded-full ${blocked ? palette.bad : view.disconnected ? palette.off : palette.ok}`} title={view.disconnected ? '연결 끊김' : undefined} />
        <span className={`${compact ? 'text-[14px]' : 'text-xs'} font-medium`}>{ENGINE_LABELS[view.engine] ?? view.engine}</span>
        {/* a status only when there is something to say: no picture yet, or a refusal in force; otherwise how old the
            figures are when they are not fresh — Claude's come with its runs only, so they can be a day old */}
        {view.windows.length > 0 && !blocked && view.observedAt && now - view.observedAt > STALE_AFTER_MS ? (
          <span className={`ml-auto ${small} ${palette.muted}`} data-testid={`usage-age-${view.engine}`}>{formatObservedAt(view.observedAt, now)} 기준</span>
        ) : null}
        {/* no figures (OpenCode reports only a refusal; Claude before its first read): no limit is known to hold */}
        {!view.windows.length || blocked ? (
          <span className={`ml-auto ${small} ${palette.muted}`}>
            {!blocked ? '한도 여유' : `한도 도달 · ${view.blockedUntil ? `해제까지 ${formatTimeLeft(view.blockedUntil, now)}` : '해제 시각 미정'}`}
          </span>
        ) : null}
      </div>
      {view.windows.length ? (
        <ul className={`mt-1 grid grid-cols-[auto_minmax(0,1fr)_2rem] items-center gap-x-2 gap-y-1 ${small} ${palette.muted}`}>
          {/* one line per window: "name (time left until reset)", the bar, how much is used — the grid keeps the bars aligned */}
          {view.windows.map((window) => (
            <li key={window.type} className="contents">
              <span className="whitespace-nowrap tabular-nums">{window.label}{window.resetsAt ? <span className="opacity-80"> ({window.resetsAt <= now ? '초기화됨 · 다음 실행 때 갱신' : formatTimeLeft(window.resetsAt, now)})</span> : null}</span>
              <div className={`h-1.5 overflow-hidden rounded-full ${palette.track}`}>
                {window.percent !== null ? <div className={`h-full rounded-full ${tone(palette, window.percent, window.blocked)}`} style={{ width: `${Math.min(100, window.percent)}%` }} /> : null}
              </div>
              <span className="text-right tabular-nums">{window.percent !== null ? `${window.percent}%` : '—'}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A model's own weekly window (`seven_day_<model>`, Fable's …) does not limit the account: the summary leaves it to the details. */
const isAccountWindow = (type: string) => !/^seven_day_.+/.test(type);

/** Claude Code's mascot (the asset the user supplied, 2026-11-26): the summary names Claude by it rather than the company logo. */
function ClaudeCodeMascot({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Claude" className={className} xmlns="http://www.w3.org/2000/svg">
      <path fill="#D97757" fillRule="evenodd" clipRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
    </svg>
  );
}

/** "3d21h", "3h20m", "12m" — the summary's time left, the two largest units; a zero second unit is dropped ("2d"). */
export function shortTimeLeft(at: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  const [days, hours] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60)];
  if (days) return `${days}d${hours ? `${hours}h` : ''}`;
  return hours ? `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}` : `${minutes}m`;
}

/** An engine's mark in the summary: Claude by its mascot, the others by their logos. */
const engineIcon = (engine: string, className = '') => (engine === 'claude'
  ? <ClaudeCodeMascot className={`h-4 w-4 shrink-0 ${className}`} />
  : <LLMProviderLogo provider={engine} className={`h-3.5 w-3.5 shrink-0 ${className}`} />);

/**
 * One engine in the summary line: its logo, a bar of the fullest account window filling the room between, then how
 * much is used and the time left until that window resets — or, during a refusal, a full red bar and the time left
 * until it lifts. Amber from 70%, red from 90% or refused. Signed in but cut off (the account could not be reached):
 * the logo and the bar greyed out, the last figures kept.
 */
function EngineSummary({ view, palette, now }: { view: UsageLimitView; palette: Palette; now: number }) {
  const { engine } = view;
  const label = `${ENGINE_LABELS[engine] ?? engine}${view.disconnected ? ' · 연결 끊김' : ''}`;
  const blocked = view.blockedUntil !== null;
  // the account window that will refuse first; a window past its reset comes with no figure, so it never counts
  const fullest = view.windows.reduce<UsageWindowView | null>((top, window) => (isAccountWindow(window.type) && window.percent !== null && (top === null || window.percent > (top.percent ?? 0)) ? window : top), null);
  const percent = fullest?.percent ?? null;
  const usage = blocked ? '한도' : percent !== null ? `${percent}%` : '여유';
  const until = blocked ? view.blockedUntil || null : fullest?.resetsAt ?? null;
  const color = blocked || (percent ?? 0) >= 90 ? palette.badText : (percent ?? 0) >= 70 ? palette.warnText : '';
  // a refusal fills the bar; no figure ("여유") leaves the track empty
  const fill = blocked ? 100 : Math.min(100, percent ?? 0);
  return (
    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap tabular-nums" title={label} data-testid={`usage-summary-${engine}`} data-blocked={blocked || undefined} data-disconnected={view.disconnected || undefined}>
      {/* one icon slot for the 16px mascot and the 14px logos, so the bars start together too */}
      <span className="flex w-4 shrink-0 justify-center">{engineIcon(engine, view.disconnected ? 'opacity-40 grayscale' : '')}</span>
      <div className={`h-1.5 min-w-6 flex-1 overflow-hidden rounded-full ${palette.track}`}>
        {fill > 0 ? <div data-testid={`usage-summary-bar-${engine}`} className={`h-full rounded-full transition-[width] ${view.disconnected ? palette.off : tone(palette, percent, blocked)}`} style={{ width: `${fill}%` }} /> : null}
      </div>
      {/* the use sits right against its bar; one fixed width ("100% (6d23h)") keeps stacked engines' bars ending together,
          the room left over goes after the time, not between the bar and its figure */}
      <span className="min-w-[5.5rem] shrink-0">
        <span className={`font-medium ${color}`}>{usage}</span>
        {until !== null && until > now ? <span className={palette.muted}> ({shortTimeLeft(until, now)})</span> : null}
      </span>
    </div>
  );
}

/**
 * Used by the mobile drawer (compact), the workbench sessions panel (desktop docked, tablet drawer) and
 * the legacy sidebar footer: each signed-in engine's account usage. One summary line by default — each
 * engine's logo with its fullest account window's use and time left, or the refusal in force — and the chevron
 * opens every window with its bar and reset time (2026-11-26). Claude's comes from its turn events, Codex's from
 * the account. A signed-out engine is left out; with none signed in (or before the first answer) nothing is drawn,
 * not even the caller's frame — `frame` wraps the panel in the caller's divider and heading, and puts `toggle`
 * (the 자세히/접기 chevron) at the right of that heading so neither takes a place of its own.
 */
export function UsageLimitPanel({ compact = false, frame = (panel) => panel }: { compact?: boolean; frame?: (panel: ReactNode, toggle: ReactNode) => ReactNode }) {
  const { views, loaded } = useUsageLimits();
  // the details are opened on request only: the summary line is what the drawer shows at rest
  const [expanded, setExpanded] = useState(false);
  if (!loaded || !views.length) return null;
  // one clock per render: the reset times are relative to it
  const now = Date.now();
  const palette = compact ? MOBILE : WORKBENCH;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  const toggle = (
    <button type="button" aria-label={expanded ? '접기' : '자세히'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className={`ml-auto shrink-0 rounded ${compact ? 'p-1' : 'p-0.5'} ${palette.muted} hover:opacity-70`}>
      <Chevron size={compact ? 16 : 14} />
    </button>
  );
  return frame(
    expanded ? (
      <div data-testid="usage-limit-panel" className={compact ? 'divide-y divide-line rounded-xl border border-line bg-bg' : 'px-1 py-1'}>
        {views.map((view) => <EngineUsage key={view.engine} view={view} compact={compact} now={now} />)}
      </div>
    ) : (
      // as many equal columns as fit (an engine needs about 10rem): side by side when wide, one per row when narrow,
      // the bars aligned either way
      <div data-testid="usage-limit-panel" className={`grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-4 gap-y-1.5 ${compact ? 'rounded-xl border border-line bg-bg px-3 py-2 text-[13px]' : 'px-2.5 py-1.5 text-xs'}`}>
        {views.map((view) => <EngineSummary key={view.engine} view={view} palette={palette} now={now} />)}
      </div>
    ),
    toggle,
  );
}
