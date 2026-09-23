import { useCallback, useRef } from 'react';

import { aidevApi, type DecideResult } from '@/modules/aidev-router/api';

const CACHE_TTL_MS = 30_000;

/**
 * Used by UI modules that need a Laya judgement (pane focus, notification level, artifact
 * pick — IMPLEMENTATION-PLAN §3.10). Identical (kind, state, options) calls within 30s reuse
 * the previous answer; failures resolve to null so callers fall back deterministically.
 */
export function useAidevDecide() {
  const cache = useRef(new Map<string, { value: DecideResult; expires: number }>());
  const decide = useCallback(async (kind: string, state: Record<string, unknown>, options?: Record<string, string>): Promise<DecideResult | null> => {
    const key = `${kind}:${JSON.stringify(state)}:${JSON.stringify(options ?? null)}`;
    const hit = cache.current.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.value;
    }
    try {
      const value = await aidevApi.decide(kind, state, options);
      if (cache.current.size > 200) {
        cache.current.clear();
      }
      cache.current.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
      return value;
    } catch {
      return null;
    }
  }, []);
  return { decide };
}
