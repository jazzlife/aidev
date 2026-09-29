import { useCallback, useEffect, useRef, useState } from 'react';

import { aidevApi, type RemoteApproval } from '@/modules/aidev-router/api';

/**
 * Agent commands waiting for the user (F-05), shared by the workbench cards and the mobile sheet.
 * Polls the gateway's in-memory approval list every 2.5 s while the page is visible (a cheap call)
 * and remembers what this client answered, so a card can turn into "running → exit code".
 */
const POLL_MS = 2500;
export const REMOTE_RUN_FOCUS_EVENT = 'aidev:remote-run-focus';

/** Asks the workbench to show a remote run (opens the "원격 실행" panel on it). */
export function focusRemoteRun(detail: { remoteRunId: number; targetId: number }) {
  window.dispatchEvent(new CustomEvent(REMOTE_RUN_FOCUS_EVENT, { detail }));
}

export function useRemoteApprovals(enabled = true) {
  const [pending, setPending] = useState<RemoteApproval[]>([]);
  const [answered, setAnswered] = useState<RemoteApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await aidevApi.approvals();
      setPending(r.approvals);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, refresh]);

  const answer = useCallback(async (id: string, allow: boolean, auto = false) => {
    try {
      const r = await aidevApi.answerApproval(id, allow, auto);
      setPending((cur) => cur.filter((a) => a.id !== id));
      setAnswered((cur) => [r.approval, ...cur.filter((a) => a.id !== id)].slice(0, 5));
      return r.approval;
    } catch (e) {
      setError((e as Error).message);
      void refresh();
      return null;
    }
  }, [refresh]);

  const dismiss = useCallback((id: string) => setAnswered((cur) => cur.filter((a) => a.id !== id)), []);
  return { pending, answered, answer, dismiss, error, refresh };
}
