import { useSyncExternalStore } from 'react';

import type { DeviceTier } from '@/modules/workbench/hooks/useDeviceTier';

/**
 * Persisted workbench arrangement, one record per tier (IMPLEMENTATION-PLAN §3.11):
 * which side view is open, pane sizes, bottom panel tab, and the tablet's single tool pane.
 * localStorage only (per viewer); every read/write is guarded.
 */
export type SideView = 'explorer' | 'git' | 'targets' | 'catalog';
export type BottomTab = 'terminal' | 'browser' | 'tasks' | 'run_output' | 'preview' | 'screen' | 'debug';
export type TabletPane = 'files' | 'terminal' | 'browser' | 'git';

export type WorkbenchLayoutState = {
  sideView: SideView | null;
  sideWidth: number;
  chatOpen: boolean;
  chatWidth: number;
  bottomOpen: boolean;
  bottomHeight: number;
  bottomTab: BottomTab;
  tabletPane: TabletPane;
  /** Tablet only: chat visible (true) or tool pane visible (false). */
  tabletShowChat: boolean;
};

const DEFAULTS: Record<Exclude<DeviceTier, 'mobile'>, WorkbenchLayoutState> = {
  desktop: { sideView: 'explorer', sideWidth: 280, chatOpen: true, chatWidth: 440, bottomOpen: true, bottomHeight: 260, bottomTab: 'terminal', tabletPane: 'files', tabletShowChat: true },
  tablet: { sideView: null, sideWidth: 260, chatOpen: true, chatWidth: 380, bottomOpen: false, bottomHeight: 240, bottomTab: 'terminal', tabletPane: 'files', tabletShowChat: true },
};

const key = (tier: string) => `aidev.workbench.${tier}`;
const listeners = new Set<() => void>();
const cache = new Map<string, WorkbenchLayoutState>();

function load(tier: 'desktop' | 'tablet'): WorkbenchLayoutState {
  const hit = cache.get(tier);
  if (hit) return hit;
  let state = DEFAULTS[tier];
  try {
    const raw = localStorage.getItem(key(tier));
    if (raw) state = { ...DEFAULTS[tier], ...(JSON.parse(raw) as Partial<WorkbenchLayoutState>) };
  } catch {
    // ignore
  }
  cache.set(tier, state);
  return state;
}

function save(tier: 'desktop' | 'tablet', state: WorkbenchLayoutState) {
  cache.set(tier, state);
  try {
    localStorage.setItem(key(tier), JSON.stringify(state));
  } catch {
    // ignore
  }
  for (const listener of listeners) listener();
}

/** Used by WorkbenchLayout and its bars to read and update the persisted arrangement. */
export const layoutStore = {
  get: (tier: 'desktop' | 'tablet') => load(tier),
  patch(tier: 'desktop' | 'tablet', patch: Partial<WorkbenchLayoutState>) {
    save(tier, { ...load(tier), ...patch });
  },
  reset(tier: 'desktop' | 'tablet') {
    save(tier, DEFAULTS[tier]);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** React binding for layoutStore. */
export function useWorkbenchLayout(tier: 'desktop' | 'tablet'): WorkbenchLayoutState {
  return useSyncExternalStore(layoutStore.subscribe, () => load(tier), () => load(tier));
}
