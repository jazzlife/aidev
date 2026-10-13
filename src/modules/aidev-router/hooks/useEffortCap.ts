import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type Engine, type EnginesResult } from '@/modules/aidev-router/api';

/** Short Korean names for the effort levels (the value itself is what the engines receive). */
export const EFFORT_LABEL: Record<string, string> = { none: '없음', minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', ultra: '울트라' };

/** The per-engine entries of the engines the account may use. Used by useEffortCap and useModelFloor for their ladders. */
export function allowedOnly<T>(perEngine: Partial<Record<Engine, T>>, engines: EnginesResult['engines']): Partial<Record<Engine, T>> {
  return Object.fromEntries(Object.entries(perEngine).filter(([engine]) => engines[engine as Engine]?.allowed !== false)) as Partial<Record<Engine, T>>;
}

/**
 * The user's reasoning-effort ceiling per engine (routing uses it for the top tier and never goes
 * above it; escalation climbs to it before switching engines). Shared by the workbench router bar
 * and the mobile settings screen.
 */
export function useEffortCap() {
  // per engine this account routes to (an engine it may not use has no ceiling to show)
  const [cap, setCap] = useState<Partial<Record<Engine, string>> | null>(null);
  const [ladder, setLadder] = useState<Partial<Record<Engine, string[]>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    aidevApi.engines().then((response) => { setCap(response.effort_cap ?? null); setLadder(response.effort_ladder ? allowedOnly(response.effort_ladder, response.engines) : null); }).catch(() => undefined);
  }, []);
  const save = useCallback(async (engine: Engine, value: string) => {
    setError(null);
    const previous = cap;
    setCap((current) => (current ? { ...current, [engine]: value } : current));
    try { setCap((await aidevApi.setEffortCap({ [engine]: value })).effort_cap); }
    catch (failure) { setCap(previous); setError(failure instanceof Error ? failure.message : '저장하지 못했습니다'); }
  }, [cap]);
  return { cap, ladder, error, save };
}
