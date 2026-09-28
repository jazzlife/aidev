import { useEffect, useSyncExternalStore } from 'react';

import { aidevApi, type ClaudeLoginStatus } from '@/modules/aidev-router/api';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * Claude subscription login state shared by the workbench router bar, the settings login modal and
 * the mobile app: current token/failure, whether the login dialog is open, and the reminder window.
 */
type ClaudeAuthState = { status: ClaudeLoginStatus | null; dialogOpen: boolean };

const RENEW_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
let state: ClaudeAuthState = { status: null, dialogOpen: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function patch(next: Partial<ClaudeAuthState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** Used by the login dialog, the router bar / mobile chip and provider-auth's login modal. */
export const claudeAuth = {
  refresh(): Promise<void> {
    loading ??= aidevApi.claudeLoginStatus()
      .then((status) => patch({ status }))
      .catch(() => undefined)   // not a platform runtime, or offline: nothing to show
      .finally(() => { loading = null; });
    return loading;
  },
  openDialog() { patch({ dialogOpen: true }); },
  closeDialog() { patch({ dialogOpen: false }); },
  /** After a successful login: new status, fresh engine probe at the gateway, stale warnings cleared. */
  async completed() {
    await claudeAuth.refresh();
    await aidevApi.engines(true).catch(() => undefined);
    const last = routingStore.get().last;
    if (last?.plan.engine_error) routingStore.patch({ last: { ...last, plan: { ...last.plan, engine_error: null } } });
  },
};

/** React binding: the shared state plus derived flags (loads the status once per page). */
export function useClaudeAuth() {
  const snapshot = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
    () => state,
  );
  useEffect(() => { if (!state.status) void claudeAuth.refresh(); }, []);
  const expiresAt = snapshot.status?.token?.expiresAt ?? null;
  const daysLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000)) : null;
  return {
    ...snapshot,
    expired: Boolean(snapshot.status?.failure) || (expiresAt !== null && Date.now() >= expiresAt),
    renewSoon: expiresAt !== null && expiresAt - Date.now() < RENEW_WARNING_MS,
    daysLeft,
  };
}
