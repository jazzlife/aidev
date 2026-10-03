import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { RemoteConsoleSource, RemoteScreenSource, RemoteWindow } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

type Display = { id: number; name?: string; resolution?: string };
type RunRow = { id: number; cmd: string | null; live: { streamId: number; pty: boolean; running: boolean } | null };
/** Runner ≥ 0.13.3 lists each whole screen (display) as a "window" with an id from this reserved range. */
const WHOLE_SCREEN_BASE = 0xffff_ff00;

/** Used by the workbench ScreenPane and the mobile screen view to put whole screens in their own group. */
export function isWholeScreen(id: number) {
  return id >= WHOLE_SCREEN_BASE;
}

/** `of`: the PC the lists came from — while another PC's lists are still loading, they are not this one's. */
type Sources = { of: number | null; windows: RemoteWindow[]; displays: Display[]; perWindow: boolean; consoles: RemoteConsoleSource[] };
const EMPTY: Sources = { of: null, windows: [], displays: [], perWindow: true, consoles: [] };

/** What the user last watched on a PC; a window also by app and title, since its id changes when the program restarts. */
type LastSource = RemoteScreenSource & { app?: string; title?: string };

/** The `remoteScreenLast` preference: PC id → its last source. A server preference, so it follows the user to the phone. */
function lastSources(): Record<string, LastSource | undefined> {
  const all = readUserPreference<unknown>('remoteScreenLast', {});
  return all && typeof all === 'object' && !Array.isArray(all) ? all as Record<string, LastSource | undefined> : {};
}

/**
 * `want` among what the PC lists now, null when it is gone. A user's pick is returned as is; a remembered
 * window whose id is gone (or now another program's) falls back to the same app's window with that title,
 * then to any window of that app.
 */
function findSource({ windows, consoles, perWindow }: Sources, want: LastSource | null | undefined): RemoteScreenSource | null {
  if (want?.kind === 'window') {
    if (windows.some((w) => w.id === want.id && (want.app === undefined || w.app === want.app))) return want.app === undefined ? want : { kind: 'window', id: want.id };
    const sameApp = want.app ? windows.filter((w) => w.app === want.app && !isWholeScreen(w.id)) : [];
    const moved = sameApp.find((w) => w.title === want.title) ?? sameApp[0];
    return moved ? { kind: 'window', id: moved.id } : null;
  }
  if (want?.kind === 'console') return consoles.some((c) => c.streamId === want.streamId && c.remoteRunId === want.remoteRunId) ? want : null;
  if (want?.kind === 'display') return perWindow ? null : want;
  return null;
}

/**
 * What a remote screen view can show on a PC (F-07c): its program windows (focused first; the runner
 * lists them) and the commands running there through the runner (their consoles). Runners before 0.7
 * list displays instead (`perWindow` false). Loaded when enabled/target changes and on `refresh()`.
 * `source` is what to show: the user's `chosen` one while it still exists, otherwise what was last chosen on
 * this PC (remembered per PC, on any device), the focused window (listed first), a console, or display 1 —
 * derived, so a closed window falls back by itself.
 * Used by the workbench ScreenPane and the mobile remote screen.
 */
export function useScreenSources(targetId: number | null, enabled: boolean, chosen: RemoteScreenSource | null) {
  const [sources, setSources] = useState<Sources>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the PC shown now: a list that arrives after the user switched to another PC is dropped
  const shownTarget = useRef(targetId);
  useEffect(() => { shownTarget.current = targetId; }, [targetId]);

  const refresh = useCallback(async () => {
    if (!targetId) { setSources(EMPTY); return; }
    setLoading(true);
    // windows need the screen consent; consoles do not — one failing must not hide the other
    const [win, runs] = await Promise.allSettled([
      api.targets.windows(targetId).then((res) => readApiJson<{ windows: RemoteWindow[] | null; displays: Display[] | null; perWindow?: boolean }>(res)),
      api.targets.runs(targetId, 30).then((res) => readApiJson<{ runs: RunRow[] }>(res)),
    ]);
    if (shownTarget.current !== targetId) return;
    const consoles = runs.status === 'fulfilled'
      ? runs.value.runs.filter((r) => r.live?.running).map((r) => ({ remoteRunId: r.id, streamId: r.live!.streamId, cmd: r.cmd ?? '', pty: r.live!.pty }))
      : [];
    if (win.status === 'fulfilled') {
      setSources({ of: targetId, windows: win.value.windows ?? [], displays: win.value.displays ?? [], perWindow: win.value.perWindow ?? Array.isArray(win.value.windows), consoles });
      setError(null);
    } else {
      setSources({ ...EMPTY, of: targetId, consoles });
      setError(win.reason instanceof Error ? win.reason.message : '창 목록을 가져오지 못했습니다');
    }
    setLoading(false);
  }, [targetId]);

  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  // the default: the focused program window, not a whole screen (runner ≥ 0.13.3 lists those last)
  const source = useMemo<RemoteScreenSource | null>(() => {
    if (!targetId || sources.of !== targetId) return null;
    const { windows, consoles, displays, perWindow } = sources;
    const picked = findSource(sources, chosen) ?? findSource(sources, lastSources()[targetId]);
    if (picked) return picked;
    const first = windows.find((w) => !isWholeScreen(w.id)) ?? windows[0];
    if (first) return { kind: 'window', id: first.id };
    if (consoles[0]) return { kind: 'console', streamId: consoles[0].streamId, remoteRunId: consoles[0].remoteRunId, pty: consoles[0].pty };
    return perWindow ? null : { kind: 'display', id: displays[0]?.id ?? 1 };
  }, [sources, chosen, targetId]);

  // the user's pick (shown, so it exists) is what this PC opens on next time
  useEffect(() => {
    if (!targetId || !chosen || source !== chosen) return;
    const w = chosen.kind === 'window' ? sources.windows.find((x) => x.id === chosen.id) : undefined;
    writeUserPreference('remoteScreenLast', { ...lastSources(), [targetId]: w ? { ...chosen, app: w.app, title: w.title } : chosen });
  }, [targetId, chosen, source, sources.windows]);

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
