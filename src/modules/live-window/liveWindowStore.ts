import { useSyncExternalStore } from 'react';

/**
 * Where the workbench's live windows (preview, remote screen) are: open or not, floating / maximized /
 * minimized, their rectangle, and which is on top. Floating overlays instead of a bottom-panel tab, so a
 * page or a PC's window gets real room (IMPLEMENTATION-PLAN §3.11). Persisted per viewer in localStorage
 * (a convenience only; every access is guarded).
 */
export type LiveWindowMode = 'float' | 'max' | 'min';
export type LiveWindowState = { open: boolean; mode: LiveWindowMode; x: number; y: number; w: number; h: number; z: number };
type Store = Record<string, LiveWindowState>;

const KEY = 'aidev.liveWindows';
const MIN_W = 320;
const MIN_H = 220;
const listeners = new Set<() => void>();
let state: Store = load();
let topZ = Math.max(1, ...Object.values(state).map((s) => s.z));

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    // windows are never restored open after a reload: they open when the user (or an agent) asks
    return raw ? Object.fromEntries(Object.entries(JSON.parse(raw) as Store).map(([k, v]) => [k, { ...v, open: false }])) : {};
  } catch {
    return {};
  }
}

function commit(next: Store) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* per-viewer convenience */ }
  for (const listener of listeners) listener();
}

/** A sensible first rectangle: right part of the screen for a preview, centered for the rest. */
function defaultRect(id: string) {
  const vw = window.innerWidth; const vh = window.innerHeight;
  const w = Math.min(Math.max(Math.round(vw * (id === 'preview' ? 0.46 : 0.62)), MIN_W), vw - 16);
  const h = Math.min(Math.max(Math.round(vh * 0.72), MIN_H), vh - 16);
  const x = id === 'preview' ? vw - w - 16 : Math.round((vw - w) / 2);
  return { x: Math.max(8, x), y: Math.max(8, Math.round((vh - h) / 2)), w, h };
}

/** Keeps a floating window reachable after the browser window shrank (its title bar stays on screen). */
export function clampRect(r: { x: number; y: number; w: number; h: number }, vw = window.innerWidth, vh = window.innerHeight) {
  const w = Math.min(Math.max(r.w, MIN_W), Math.max(MIN_W, vw - 8));
  const h = Math.min(Math.max(r.h, MIN_H), Math.max(MIN_H, vh - 8));
  return { w, h, x: Math.min(Math.max(r.x, 8 - w + 120), vw - 120), y: Math.min(Math.max(r.y, 0), vh - 40) };
}

/** Used by the workbench (activity bar, tablet header, agent previews) and the live-window host. */
export const liveWindows = {
  /** Opens (or brings forward and restores) a window. */
  open(id: string, mode?: LiveWindowMode) {
    const cur = state[id] ?? { ...defaultRect(id), open: false, mode: 'float' as LiveWindowMode, z: 0 };
    topZ += 1;
    commit({ ...state, [id]: { ...cur, ...clampRect(cur), open: true, mode: mode ?? (cur.mode === 'min' ? 'float' : cur.mode), z: topZ } });
  },
  toggle(id: string) {
    const cur = state[id];
    if (cur?.open && cur.mode !== 'min') liveWindows.close(id); else liveWindows.open(id);
  },
  close(id: string) { if (state[id]) commit({ ...state, [id]: { ...state[id], open: false } }); },
  setMode(id: string, mode: LiveWindowMode) {
    if (!state[id]) return;
    topZ += 1;
    commit({ ...state, [id]: { ...state[id], mode, z: mode === 'min' ? state[id].z : topZ } });
  },
  focus(id: string) {
    if (!state[id] || state[id].z === topZ) return;
    topZ += 1;
    commit({ ...state, [id]: { ...state[id], z: topZ } });
  },
  setRect(id: string, r: { x: number; y: number; w: number; h: number }) {
    if (state[id]) commit({ ...state, [id]: { ...state[id], ...clampRect(r) } });
  },
  get: (id: string): LiveWindowState | undefined => state[id],
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

/** React binding: the state of every live window. */
export function useLiveWindows(): Store {
  return useSyncExternalStore(liveWindows.subscribe, () => state, () => state);
}
