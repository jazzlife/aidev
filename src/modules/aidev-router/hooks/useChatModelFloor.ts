import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type Engine } from '@/modules/aidev-router/api';
import { routingStore, useRoutingState } from '@/modules/aidev-router/store';
import { useModelFloor } from '@/modules/aidev-router/hooks/useModelFloor';

/**
 * The open chat's own model floor (set from the chat: workbench router bar, mobile routing sheet).
 * Engines left on "default" follow the account floor from Settings. Same lifecycle as
 * useChatEffortCap: a new chat keeps its choice locally and sends it with the first message; once
 * the chat has an id the choice is stored server-side for that session.
 */
export function useChatModelFloor(sessionId: string | null) {
  const account = useModelFloor();
  const { chatFloor } = useRoutingState();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const current = routingStore.get().chatFloor;
    if (!sessionId) {
      if (current.sessionId !== null) routingStore.patch({ chatFloor: { sessionId: null, floor: null } });
      return;
    }
    if (current.sessionId === sessionId) return;
    let cancelled = false;
    // the chat just got its id: keep what was chosen before the first message
    const pending = current.sessionId === null && current.floor && Object.keys(current.floor).length ? current.floor : null;
    const load = pending
      ? aidevApi.setSessionModelFloor(sessionId, pending).then((r) => r.model_floor)
      : aidevApi.sessionSettings(sessionId).then((r) => r.model_floor ?? null);
    routingStore.patch({ chatFloor: { sessionId, floor: pending } });
    load.then((floor) => { if (!cancelled) routingStore.patch({ chatFloor: { sessionId, floor } }); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const floor = chatFloor.sessionId === sessionId ? chatFloor.floor : null;
  /** a model for one engine, or 'default' to follow the account setting */
  const set = useCallback(async (engine: Engine, model: string) => {
    setError(null);
    const next: Partial<Record<Engine, string>> = { ...(routingStore.get().chatFloor.sessionId === sessionId ? routingStore.get().chatFloor.floor ?? {} : {}) };
    if (model === 'default') delete next[engine]; else next[engine] = model;
    const value = Object.keys(next).length ? next : null;
    routingStore.patch({ chatFloor: { sessionId, floor: value } });
    if (!sessionId) return;
    try { const r = await aidevApi.setSessionModelFloor(sessionId, value); routingStore.patch({ chatFloor: { sessionId, floor: r.model_floor } }); }
    catch (e) { setError((e as Error).message); }
  }, [sessionId]);

  return { floor, defaults: account.floor, ladder: account.ladder, set, error: error ?? account.error };
}
