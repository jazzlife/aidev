import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type Engine } from '@/modules/aidev-router/api';
import { routingStore, useRoutingState } from '@/modules/aidev-router/store';
import { useEffortCap } from '@/modules/aidev-router/hooks/useEffortCap';

/**
 * The open chat's own effort ceiling (set from the chat: workbench router bar, mobile routing sheet).
 * Engines left on "default" follow the account default from Settings. A new chat keeps its choice
 * locally and sends it with the first message; once the chat has an id the choice is stored
 * server-side for that session (so the phone and the workbench agree).
 */
export function useChatEffortCap(sessionId: string | null) {
  const account = useEffortCap();
  const { chatCap } = useRoutingState();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const current = routingStore.get().chatCap;
    if (!sessionId) {
      // a new chat starts from the default unless a choice was already made for it
      if (current.sessionId !== null) routingStore.patch({ chatCap: { sessionId: null, cap: null } });
      return;
    }
    if (current.sessionId === sessionId) return;
    let cancelled = false;
    // the chat just got its id: keep what was chosen before the first message
    const pending = current.sessionId === null && current.cap && Object.keys(current.cap).length ? current.cap : null;
    const load = pending ? aidevApi.setSessionEffortCap(sessionId, pending) : aidevApi.sessionSettings(sessionId);
    routingStore.patch({ chatCap: { sessionId, cap: pending } });
    load.then((r) => { if (!cancelled) routingStore.patch({ chatCap: { sessionId, cap: r.effort_cap } }); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const cap = chatCap.sessionId === sessionId ? chatCap.cap : null;
  /** level for one engine, or 'default' to follow the account setting */
  const set = useCallback(async (engine: Engine, level: string) => {
    setError(null);
    const next: Partial<Record<Engine, string>> = { ...(routingStore.get().chatCap.sessionId === sessionId ? routingStore.get().chatCap.cap ?? {} : {}) };
    if (level === 'default') delete next[engine]; else next[engine] = level;
    const value = Object.keys(next).length ? next : null;
    routingStore.patch({ chatCap: { sessionId, cap: value } });
    if (!sessionId) return;
    try { const r = await aidevApi.setSessionEffortCap(sessionId, value); routingStore.patch({ chatCap: { sessionId, cap: r.effort_cap } }); }
    catch (e) { setError((e as Error).message); }
  }, [sessionId]);

  const effective = account.cap ? { claude: cap?.claude ?? account.cap.claude, codex: cap?.codex ?? account.cap.codex } : null;
  return { cap, defaults: account.cap, ladder: account.ladder, effective, set, error: error ?? account.error };
}
