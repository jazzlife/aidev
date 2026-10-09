import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { Engine } from '@/modules/aidev-router/api';
import type { ProviderUsageLimitsSnapshot, ProviderUsageWindow } from '@/shared/types';

/** Korean names of the usage windows the engines report. */
const WINDOW_LABEL: Record<string, string> = { five_hour: '5시간', seven_day: '주간', seven_day_opus: '주간 Opus', seven_day_sonnet: '주간 Sonnet', overage: '추가 사용', unknown: '한도' };
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

/** "14:30" / "내일 09:00" for a reset time. */
export function formatResetTime(resetsAt: number, now = Date.now()): string {
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const dayDiff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `내일 ${time}`;
  return `${date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} ${time}`;
}

/** Used by the panel and tests: one engine's snapshot (or none) as the drawer draws it. */
export function usageLimitView(engine: Engine, snapshot: ProviderUsageLimitsSnapshot | null | undefined): UsageLimitView {
  if (!snapshot || !snapshot.observedAt) return { engine, unknown: true, blockedUntil: null, observedAt: null, windows: [] };
  const windows = snapshot.windows
    .filter((window: ProviderUsageWindow) => window.type !== 'unknown' || window.blocked)
    .map((window) => ({ type: window.type, label: WINDOW_LABEL[window.type] ?? window.type, percent: window.utilization === null ? null : Math.round(window.utilization * 100), resetsAt: window.resetsAt, blocked: window.blocked }));
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
