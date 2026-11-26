import { ChevronUp, Clock } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { formatTimeLeft, useUsageLimits, type UsageLimitView, type UsageWindowView } from '@/modules/aidev-router/hooks/useUsageLimits';
import { ENGINE_LABELS } from '@/shared/constants';
import { LLMProviderLogo } from '@/shared/ui';


/**
 * The two apps have different Tailwind themes: the workbench's shadcn tokens, the mobile app's `--m-*`
 * tokens (and its CSS only carries classes used under src-mobile plus this file). So the compact (mobile)
 * variant draws with the mobile tokens and the workbench variant with its own.
 */
type Palette = { muted: string; track: string; ok: string; warn: string; bad: string; warnText: string; badText: string };
const WORKBENCH: Palette = { muted: 'text-muted-foreground', track: 'bg-muted', ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', warnText: 'text-amber-500', badText: 'text-red-500' };
const MOBILE: Palette = { muted: 'text-muted', track: 'bg-line', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-danger', warnText: 'text-warn', badText: 'text-danger' };

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
        {/* the runtime reports signed-in engines only: green is connected and not refusing, red a limit in force */}
        <span className={`h-2 w-2 shrink-0 rounded-full ${blocked ? palette.bad : palette.ok}`} />
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

/** "4일 2시간", "3시간 20분", "12분" — the summary's time left, without the details' "남음". */
const shortTimeLeft = (at: number, now: number) => formatTimeLeft(at, now).replace(/ 남음$/, '');

/**
 * One engine in the summary line: its logo, how much of the fullest account window is used and the time left until
 * that window resets — or, during a refusal, the time left until it lifts. Amber from 70%, red from 90% or refused.
 */
function EngineSummary({ view, palette, now }: { view: UsageLimitView; palette: Palette; now: number }) {
  const blocked = view.blockedUntil !== null;
  // the account window that will refuse first; a window past its reset comes with no figure, so it never counts
  const fullest = view.windows.reduce<UsageWindowView | null>((top, window) => (isAccountWindow(window.type) && window.percent !== null && (top === null || window.percent > (top.percent ?? 0)) ? window : top), null);
  const percent = fullest?.percent ?? null;
  const usage = blocked ? '한도' : percent !== null ? `${percent}%` : '여유';
  const until = blocked ? view.blockedUntil || null : fullest?.resetsAt ?? null;
  const color = blocked || (percent ?? 0) >= 90 ? palette.badText : (percent ?? 0) >= 70 ? palette.warnText : '';
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums" title={ENGINE_LABELS[view.engine] ?? view.engine} data-testid={`usage-summary-${view.engine}`} data-blocked={blocked || undefined}>
      <LLMProviderLogo provider={view.engine} className="h-3.5 w-3.5 shrink-0" />
      <span className={`font-medium ${color}`}>{usage}</span>
      {until !== null && until > now ? <span className={`inline-flex items-center gap-0.5 ${palette.muted}`}><Clock size={10} />{shortTimeLeft(until, now)}</span> : null}
    </span>
  );
}

/**
 * Used by the mobile drawer (compact), the workbench sessions panel (desktop docked, tablet drawer) and
 * the legacy sidebar footer: each signed-in engine's account usage. One summary line by default — each
 * engine's logo with its fullest account window's use and time left, or the refusal in force — and "자세히" opens every window with its bar
 * and reset time (2026-11-26). Claude's comes from its turn events, Codex's from the account.
 * A signed-out engine is left out; with none signed in (or before the first answer) nothing is drawn,
 * not even the caller's frame — `frame` wraps the panel in the caller's divider and heading, and puts `collapse` (the
 * details' 접기 icon, null at rest) at the right of that heading rather than on a row of its own.
 */
export function UsageLimitPanel({ compact = false, frame = (panel) => panel }: { compact?: boolean; frame?: (panel: ReactNode, collapse: ReactNode) => ReactNode }) {
  const { views, loaded } = useUsageLimits();
  // the details are opened on request only: the summary line is what the drawer shows at rest
  const [expanded, setExpanded] = useState(false);
  if (!loaded || !views.length) return null;
  // one clock per render: the reset times are relative to it
  const now = Date.now();
  const palette = compact ? MOBILE : WORKBENCH;
  const text = compact ? 'text-[13px]' : 'text-xs';
  if (!expanded) {
    return frame(
      <div data-testid="usage-limit-panel" className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${text} ${compact ? 'rounded-xl border border-line bg-bg px-3 py-2' : 'px-2.5 py-1.5'}`}>
        {views.map((view) => <EngineSummary key={view.engine} view={view} palette={palette} now={now} />)}
        <button type="button" aria-expanded={false} onClick={() => setExpanded(true)} className={`ml-auto shrink-0 ${palette.muted} hover:underline`}>자세히</button>
      </div>,
      null,
    );
  }
  return frame(
    <div data-testid="usage-limit-panel" className={compact ? 'divide-y divide-line rounded-xl border border-line bg-bg' : 'px-1 py-1'}>
      {views.map((view) => <EngineUsage key={view.engine} view={view} compact={compact} now={now} />)}
    </div>,
    <button type="button" aria-label="접기" aria-expanded onClick={() => setExpanded(false)} className={`ml-auto shrink-0 rounded ${compact ? 'p-1' : 'p-0.5'} ${palette.muted} hover:opacity-70`}>
      <ChevronUp size={compact ? 16 : 14} />
    </button>,
  );
}
