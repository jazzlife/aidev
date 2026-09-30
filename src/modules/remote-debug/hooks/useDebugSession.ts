import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { debugApi, readApiJson } from '@/shared/api';
import { debugStore } from '@/modules/remote-debug/debugStore';
import type { RemoteDebugEvent, RemoteDebugSession, RemoteDebugSnapshot, RemoteDebugState, RemoteDebugVariable } from '@/shared/types';

/** A session's state in words (workbench debug window, mobile debug screen). */
export const DEBUG_STATE_LABEL: Record<RemoteDebugState, string> = { starting: '시작 중', running: '실행 중', paused: '멈춤', ended: '끝남', failed: '실패' };

const OUTPUT_KEEP = 200_000;

/**
 * One debug session as the debug window shows it (F-09): the snapshot (state, stack and variables while
 * paused, breakpoints) and the program output, kept current by long-polling the session's events —
 * a state or breakpoint change refetches the snapshot, output is appended. Actions call the gateway;
 * their effect arrives through the events. Used by DebugPane and the mobile DebugScreen.
 */
export function useDebugSession(sessionId: string | null, active = true) {
  // the session as last fetched (null until loaded / no session)
  const [snapshot, setSnapshot] = useState<RemoteDebugSnapshot | null>(null);
  // program output since the window opened (starts with the snapshot's tail)
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  // an action in flight (buttons disable while it runs)
  const [busy, setBusy] = useState<string | null>(null);
  const idRef = useRef(sessionId);
  idRef.current = sessionId;

  const refresh = useCallback(async () => {
    const id = idRef.current;
    if (!id) return null;
    const r = await readApiJson<{ session: RemoteDebugSnapshot }>(await debugApi.get(id));
    if (idRef.current === id) setSnapshot(r.session);
    return r.session;
  }, []);

  useEffect(() => {
    setSnapshot(null); setOutput(''); setError(null);
    if (!sessionId || !active) return undefined;
    const abort = new AbortController();
    let stopped = false;
    void (async () => {
      let after = 0;
      try {
        const first = await refresh();
        if (!first || stopped) return;
        setOutput(first.output);
        after = first.seq;
        let ended = first.state === 'ended' || first.state === 'failed';
        while (!stopped && !ended) {
          let r: { events: RemoteDebugEvent[]; next: number; state: string };
          try {
            r = await readApiJson(await debugApi.events(sessionId, after, 20, { signal: abort.signal }));
          } catch (e) {
            if (stopped) return;
            setError(e instanceof Error ? e.message : String(e));
            await new Promise((res) => setTimeout(res, 3000));
            continue;
          }
          setError(null);
          after = r.next;
          const text = r.events.filter((e): e is Extract<RemoteDebugEvent, { type: 'output' }> => e.type === 'output').map((e) => e.text).join('');
          if (text) setOutput((o) => (o + text).slice(-OUTPUT_KEEP));
          if (r.events.some((e) => e.type !== 'output')) await refresh();
          ended = r.state === 'ended' || r.state === 'failed';
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { stopped = true; abort.abort(); };
  }, [sessionId, active, refresh]);

  const run = useCallback(async <T,>(label: string, fn: (id: string) => Promise<Response>): Promise<T | null> => {
    const id = idRef.current;
    if (!id) return null;
    setBusy(label); setError(null);
    try { return await readApiJson<T>(await fn(id)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(null); }
  }, []);

  return {
    snapshot, output, error, busy, refresh,
    control: (action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') => run(action, (id) => debugApi.control(id, action)),
    stop: () => run<{ session: RemoteDebugSession }>('stop', (id) => debugApi.stop(id)).then((r) => { void refresh(); return r; }),
    setBreakpoints: (path: string, lines: number[]) => run('breakpoints', (id) => debugApi.breakpoints(id, path, lines.map((line) => ({ line })))),
    evaluate: (expression: string, frameId?: number | null) => run<{ result: string; type: string | null; ref: number }>('evaluate', (id) => debugApi.evaluate(id, expression, frameId)),
    /** Children of an expandable variable (not "busy": the variables tree loads lazily as rows open). */
    variables: async (ref: number) => {
      const id = idRef.current;
      if (!id) return [];
      return (await readApiJson<{ variables: RemoteDebugVariable[] }>(await debugApi.variables(id, ref))).variables;
    },
    scopes: async (frameId: number) => {
      const id = idRef.current;
      if (!id) return [];
      return (await readApiJson<{ scopes: Array<{ name: string; ref: number; expensive: boolean }> }>(await debugApi.scopes(id, frameId))).scopes;
    },
  };
}

/** The user's debug sessions (newest first), reloaded every `intervalMs` while `enabled`. */
export function useDebugSessions(enabled: boolean, intervalMs = 5000) {
  const [sessions, setSessions] = useState<RemoteDebugSession[]>([]);
  const reload = useCallback(async () => {
    try { setSessions((await readApiJson<{ sessions: RemoteDebugSession[] }>(await debugApi.list())).sessions); } catch { /* keep the last list */ }
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    void reload();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, reload]);
  return { sessions, reload };
}

/** A debug session an agent started (remote_debug_start) is selected and `onNew` runs once — WorkbenchLayout opens the debug window with it. */
export function useAgentDebugSessions(enabled: boolean, onNew: (session: RemoteDebugSession) => void) {
  const { sessions } = useDebugSessions(enabled, 6000);
  const seenRef = useRef<number>(Date.now());
  const fresh = useMemo(() => sessions.find((s) => s.origin === 'agent' && s.createdAt > seenRef.current), [sessions]);
  useEffect(() => {
    if (!fresh) return;
    seenRef.current = Math.max(...sessions.map((s) => s.createdAt));
    debugStore.select(fresh.id);
    onNew(fresh);
  }, [fresh, sessions, onNew]);
}
