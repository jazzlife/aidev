import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type Engine } from '@/modules/aidev-router/api';

/** Short Korean names for the tier models (the value itself is what the engines receive). */
export const MODEL_LABEL: Record<string, string> = {
  haiku: 'Haiku (D0)', sonnet: 'Sonnet (D1–D2)', opus: 'Opus (D3)', best: '최상위 · Fable (D4)',
  'gpt-5.6-luna': 'Luna (D0)', 'gpt-5.6-terra': 'Terra (D1–D2)', 'gpt-5.6-sol': 'Sol (D3)', 'gpt-6-astra': 'Astra (D4)',
};

/**
 * The user's model floor per engine: routing never runs below it, whatever depth Laya scored
 * (2026-10-07 — high-level work was landing on sonnet). Mirrors useEffortCap, which is the ceiling
 * on effort; this is the floor on the model. Shared by the workbench settings/router bar and the
 * mobile settings screen. An engine absent from `floor` has none.
 */
export function useModelFloor() {
  // the account floor and the engines' tier model ladders, from /engines (null until loaded)
  const [floor, setFloor] = useState<Partial<Record<Engine, string>> | null>(null);
  const [ladder, setLadder] = useState<Record<Engine, string[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    aidevApi.engines().then((response) => { setFloor(response.model_floor ?? {}); setLadder(response.model_ladder ?? null); }).catch(() => undefined);
  }, []);
  /** `''` clears the engine's floor. */
  const save = useCallback(async (engine: Engine, value: string) => {
    setError(null);
    const previous = floor;
    setFloor((current) => { const next = { ...(current ?? {}) }; if (value) next[engine] = value; else delete next[engine]; return next; });
    try { setFloor((await aidevApi.setModelFloor({ [engine]: value })).model_floor); }
    catch (failure) { setFloor(previous); setError(failure instanceof Error ? failure.message : '저장하지 못했습니다'); }
  }, [floor]);
  return { floor, ladder, error, save };
}
