import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type Engine } from '@/modules/aidev-router/api';

/** Short Korean names for the effort levels (the value itself is what the engines receive). */
export const EFFORT_LABEL: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', ultra: '울트라' };

/**
 * The user's reasoning-effort ceiling per engine (routing uses it for the top tier and never goes
 * above it; escalation climbs to it before switching engines). Shared by the workbench router bar
 * and the mobile settings screen.
 */
export function useEffortCap() {
  const [cap, setCap] = useState<Record<Engine, string> | null>(null);
  const [ladder, setLadder] = useState<Record<Engine, string[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    aidevApi.engines().then((response) => { setCap(response.effort_cap ?? null); setLadder(response.effort_ladder ?? null); }).catch(() => undefined);
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
