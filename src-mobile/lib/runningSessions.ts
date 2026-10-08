import { useEffect, useMemo, useState } from 'react';

import { api } from '@/modules/chat-core';

/** One conversation the runtime is answering right now, with its project when the session has one. */
export type RunningSession = { sessionId: string; projectId: string | null };

/** How often the lists ask the runtime which conversations are running (the workbench sidebar polls at the same rate). */
const POLL_MS = 5_000;

async function fetchRunning(): Promise<RunningSession[]> {
  const response = await api.runningSessions();
  const body = await response.json() as { data?: { sessions?: Array<{ sessionId?: unknown; projectId?: unknown }> } };
  return (body.data?.sessions ?? [])
    .filter((entry) => typeof entry.sessionId === 'string' && entry.sessionId)
    .map((entry) => ({ sessionId: entry.sessionId as string, projectId: typeof entry.projectId === 'string' ? entry.projectId : null }));
}

/**
 * Used by the conversation list, the project list, a project's conversations and the drawer: which conversations
 * are being answered right now (the runtime's running runs, polled while the screen is open), as a set of session
 * ids and a count per project. The list screens had no running indicator at all (2026-10-09).
 */
export function useRunningSessions(enabled = true) {
  // the runtime's running runs as last fetched; empty until the first answer
  const [list, setList] = useState<RunningSession[]>([]);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const poll = () => { fetchRunning().then((next) => { if (alive) setList(next); }).catch(() => undefined); };
    poll();
    // a backgrounded tab does not poll; coming back refreshes at once
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') poll(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled]);
  return useMemo(() => {
    const byProject = new Map<string, number>();
    for (const entry of list) if (entry.projectId) byProject.set(entry.projectId, (byProject.get(entry.projectId) ?? 0) + 1);
    return { list, ids: new Set(list.map((entry) => entry.sessionId)), byProject };
  }, [list]);
}
