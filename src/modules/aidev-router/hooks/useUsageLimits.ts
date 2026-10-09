import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { Engine } from '@/modules/aidev-router/api';
import type { ProviderUsageLimitsSnapshot, ProviderUsageWindow } from '@/shared/types';

/** Korean names of the usage windows the engines report. */
const WINDOW_LABEL: Record<string, string> = { five_hour: '5시간', seven_day: '주간', seven_day_opus: '주간 Opus', seven_day_sonnet: '주간 Sonnet', seven_day_fable: '주간 Fable', overage: '추가 사용', unknown: '한도' };

/** A window's name; a model's weekly window the list does not know yet still reads "주간 <Model>". */
function windowLabel(type: string): string {
  const scoped = /^seven_day_(.+)$/.exec(type);
  return WINDOW_LABEL[type] ?? (scoped ? `주간 ${scoped[1].charAt(0).toUpperCase()}${scoped[1].slice(1)}` : type);
}
/** The drawer asks again this often while open (the server reads the Codex account at most that often too). */
const POLL_MS = 60_000;

export type UsageWindowView = { type: string; label: string; percent: number | null; resetsAt: number | null; blocked: boolean };
export type UsageLimitView = {
  engine: Engine;
  /** no turn has reported anything yet */
  unknown: boolean;
  /** a refusal is in force until this time (0 = time unknown) */
  blockedUntil: number | null;
  observedAt: number | null;
  windows: UsageWindowView[];
};

/** "7일 3시간 남음" / "3시간 20분 남음" / "12분 남음" until a reset; "곧 초기화" once it is due. */
export function formatTimeLeft(resetsAt: number, now = Date.now()): string {
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return '곧 초기화';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const parts = days ? [`${days}일`, hours ? `${hours}시간` : ''] : hours ? [`${hours}시간`, minutes % 60 ? `${minutes % 60}분` : ''] : [`${minutes}분`];
  return `${parts.filter(Boolean).join(' ')} 남음`;
}

/** Used by the panel and tests: one engine's snapshot (or none) as the drawer draws it. */
export function usageLimitView(engine: Engine, snapshot: ProviderUsageLimitsSnapshot | null | undefined): UsageLimitView {
  if (!snapshot || !snapshot.observedAt) return { engine, unknown: true, blockedUntil: null, observedAt: null, windows: [] };
  const windows = snapshot.windows
    .filter((window: ProviderUsageWindow) => window.type !== 'unknown' || window.blocked)
    .map((window) => ({ type: window.type, label: windowLabel(window.type), percent: window.utilization === null ? null : Math.round(window.utilization * 100), resetsAt: window.resetsAt, blocked: window.blocked }));
  return { engine, unknown: false, blockedUntil: snapshot.blockedUntil, observedAt: snapshot.observedAt, windows };
}

/**
 * Used by UsageLimitPanel (the drawers of both apps): each engine's account usage as the runtime last
 * saw it, refreshed while the panel is open.
 */
export function useUsageLimits(enabled = true): { views: UsageLimitView[]; loaded: boolean } {
  // the runtime's last picture per engine; null until the first answer
  const [snapshots, setSnapshots] = useState<Partial<Record<Engine, ProviderUsageLimitsSnapshot>> | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const poll = () => {
      // a partial api (a test double) means "unknown", not an error
      if (typeof api.providers?.usageLimits !== 'function') return;
      api.providers.usageLimits().then(async (response) => {
        const body = await response.json() as { success?: boolean; data?: { providers?: Partial<Record<Engine, ProviderUsageLimitsSnapshot>> } };
        if (alive && body.success) setSnapshots(body.data?.providers ?? {});
      }).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') poll(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [enabled]);
  return { views: (['claude', 'codex'] as Engine[]).map((engine) => usageLimitView(engine, snapshots?.[engine])), loaded: snapshots !== null };
}
