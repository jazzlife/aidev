import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { RemoteConsoleSource, RemoteScreenSource, RemoteWindow } from '@/shared/types';

type Display = { id: number; name?: string; resolution?: string };
type RunRow = { id: number; cmd: string | null; live: { streamId: number; pty: boolean; running: boolean } | null };
/** Runner ≥ 0.13.3 lists each whole screen (display) as a "window" with an id from this reserved range. */
const WHOLE_SCREEN_BASE = 0xffff_ff00;

/** Used by the workbench ScreenPane and the mobile screen view to put whole screens in their own group. */
export function isWholeScreen(id: number) {
  return id >= WHOLE_SCREEN_BASE;
}

type Sources = { windows: RemoteWindow[]; displays: Display[]; perWindow: boolean; consoles: RemoteConsoleSource[] };
const EMPTY: Sources = { windows: [], displays: [], perWindow: true, consoles: [] };

/**
 * What a remote screen view can show on a PC (F-07c): its program windows (focused first; the runner
 * lists them) and the commands running there through the runner (their consoles). Runners before 0.7
 * list displays instead (`perWindow` false). Loaded when enabled/target changes and on `refresh()`.
 * `source` is what to show: the user's `chosen` one while it still exists, otherwise the focused window
 * (listed first), a console, or display 1 — derived, so a closed window falls back by itself.
 * Used by the workbench ScreenPane and the mobile remote screen.
 */
export function useScreenSources(targetId: number | null, enabled: boolean, chosen: RemoteScreenSource | null) {
  const [sources, setSources] = useState<Sources>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!targetId) { setSources(EMPTY); return; }
    setLoading(true);
    // windows need the screen consent; consoles do not — one failing must not hide the other
    const [win, runs] = await Promise.allSettled([
      api.targets.windows(targetId).then((res) => readApiJson<{ windows: RemoteWindow[] | null; displays: Display[] | null; perWindow?: boolean }>(res)),
      api.targets.runs(targetId, 30).then((res) => readApiJson<{ runs: RunRow[] }>(res)),
    ]);
    const consoles = runs.status === 'fulfilled'
      ? runs.value.runs.filter((r) => r.live?.running).map((r) => ({ remoteRunId: r.id, streamId: r.live!.streamId, cmd: r.cmd ?? '', pty: r.live!.pty }))
      : [];
    if (win.status === 'fulfilled') {
      setSources({ windows: win.value.windows ?? [], displays: win.value.displays ?? [], perWindow: win.value.perWindow ?? Array.isArray(win.value.windows), consoles });
      setError(null);
    } else {
      setSources({ ...EMPTY, consoles });
      setError(win.reason instanceof Error ? win.reason.message : '창 목록을 가져오지 못했습니다');
    }
    setLoading(false);
  }, [targetId]);

  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  // the default: the focused program window, not a whole screen (runner ≥ 0.13.3 lists those last)
  const source = useMemo<RemoteScreenSource | null>(() => {
    const { windows, consoles, displays, perWindow } = sources;
    if (chosen?.kind === 'window' && windows.some((w) => w.id === chosen.id)) return chosen;
    if (chosen?.kind === 'console' && consoles.some((c) => c.streamId === chosen.streamId)) return chosen;
    if (chosen?.kind === 'display' && !perWindow) return chosen;
    const first = windows.find((w) => !isWholeScreen(w.id)) ?? windows[0];
    if (first) return { kind: 'window', id: first.id };
    if (consoles[0]) return { kind: 'console', streamId: consoles[0].streamId, remoteRunId: consoles[0].remoteRunId, pty: consoles[0].pty };
    return perWindow ? null : { kind: 'display', id: displays[0]?.id ?? 1 };
  }, [sources, chosen]);

  /** The picker's value → a source (`w:<window>`, `c:<streamId>`, `d:<display>`), null when unknown. */
  const parse = useCallback((value: string): RemoteScreenSource | null => {
    const [kind, raw] = value.split(':'); const id = Number(raw);
    if (kind === 'w') return { kind: 'window', id };
    if (kind === 'd') return { kind: 'display', id };
    const c = kind === 'c' ? sources.consoles.find((x) => x.streamId === id) : undefined;
    return c ? { kind: 'console', streamId: c.streamId, remoteRunId: c.remoteRunId, pty: c.pty } : null;
  }, [sources.consoles]);

  return { ...sources, loading, error, refresh, source, parse };
}
