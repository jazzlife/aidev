import { useSyncExternalStore } from 'react';

import type { DebugPathMap } from '@/modules/remote-debug/pathMap';

/**
 * Debugging state the editor and the debug window share (F-09): breakpoints set in the editor gutter (by
 * workspace file path, kept per viewer in localStorage), the session the debug window shows, how each
 * session's PC folder maps to a workspace project, and where the selected session is paused (the
 * editor highlights that line). The session itself lives in the gateway (debugApi).
 */
type State = {
  /** workspace file path → 1-based lines, sorted */
  breakpoints: Record<string, number[]>;
  /** the session the debug window shows */
  selected: string | null;
  /** session id → workspace project ↔ PC folder */
  maps: Record<string, DebugPathMap>;
  /** where the selected session is paused, as a workspace path when it maps */
  paused: { sessionId: string; runtimePath: string | null; targetPath: string | null; line: number } | null;
};

const KEY = 'aidev.debug';
const listeners = new Set<() => void>();
let state: State = load();

function load(): State {
  const empty: State = { breakpoints: {}, selected: null, maps: {}, paused: null };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const saved = JSON.parse(raw) as Partial<State>;
    return { ...empty, breakpoints: saved.breakpoints ?? {}, maps: saved.maps ?? {} };
  } catch {
    return empty;
  }
}

function commit(next: State) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify({ breakpoints: state.breakpoints, maps: state.maps })); } catch { /* per-viewer convenience */ }
  for (const listener of listeners) listener();
}

const sameLines = (a: number[] | undefined, b: number[]) => (a ?? []).length === b.length && (a ?? []).every((x, i) => x === b[i]);

/** Used by the editor gutter (debugGutter), DebugPane and the mobile debug screen. */
export const debugStore = {
  get: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  lines: (path: string) => state.breakpoints[path] ?? [],
  /** Adds or removes the breakpoint on `line` of a workspace file. */
  toggle(path: string, line: number) {
    const cur = state.breakpoints[path] ?? [];
    debugStore.setLines(path, cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line]);
  },
  setLines(path: string, lines: number[]) {
    const next = [...new Set(lines.filter((l) => Number.isInteger(l) && l > 0))].sort((a, b) => a - b);
    if (sameLines(state.breakpoints[path], next)) return;
    const breakpoints = { ...state.breakpoints };
    if (next.length) breakpoints[path] = next; else delete breakpoints[path];
    commit({ ...state, breakpoints });
  },
  select(id: string | null) { if (state.selected !== id) commit({ ...state, selected: id, paused: state.paused?.sessionId === id ? state.paused : null }); },
  setMap(id: string, map: DebugPathMap) { commit({ ...state, maps: { ...state.maps, [id]: map } }); },
  setPaused(paused: State['paused']) {
    const p = state.paused;
    if (p === paused || (p && paused && p.sessionId === paused.sessionId && p.line === paused.line && p.runtimePath === paused.runtimePath && p.targetPath === paused.targetPath)) return;
    commit({ ...state, paused });
  },
};

/** React binding. */
export function useDebugStore(): State {
  return useSyncExternalStore(debugStore.subscribe, () => state, () => state);
}
