import { useSyncExternalStore } from 'react';

import type { Engine, RouteResult } from '@/modules/aidev-router/api';

/**
 * Small external store for routing state shared between the composer hook and the
 * router UI (bar / chip). `mode` is remembered per browser; everything else is per page load.
 *   auto   — route every send and apply the plan (model/effort) when the user has not pinned one
 *   manual — route and show the result, but only apply it when the user confirms in the bar
 *   off    — never call the router
 */
export type RoutingMode = 'auto' | 'manual' | 'off';

export type RoutingOverrides = {
  agent?: string;
  engine?: Engine;
  model?: string;
  effort?: string;
  targetId?: number | null;
};

export type RoutingState = {
  mode: RoutingMode;
  busy: boolean;
  last: RouteResult | null;
  lastText: string | null;
  error: string | null;
  overrides: RoutingOverrides;
  /** run id the gateway allocated for the send currently in flight or last sent */
  runId: number | null;
};

const MODE_KEY = 'aidev.routing.mode';

function readMode(): RoutingMode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === 'manual' || value === 'off' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

let state: RoutingState = { mode: readMode(), busy: false, last: null, lastText: null, error: null, overrides: {}, runId: null };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Used by useAidevRouting and the router UI components to read and update routing state. */
export const routingStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(patch: Partial<RoutingState>) {
    state = { ...state, ...patch };
    emit();
  },
  setMode(mode: RoutingMode) {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // per-viewer convenience only
    }
    routingStore.patch({ mode });
  },
  setOverrides(overrides: RoutingOverrides) {
    routingStore.patch({ overrides: { ...state.overrides, ...overrides } });
  },
  clearOverrides() {
    routingStore.patch({ overrides: {} });
  },
};

/** React binding for routingStore. Used by the router bar/chip and the composer hook. */
export function useRoutingState(): RoutingState {
  return useSyncExternalStore(routingStore.subscribe, routingStore.get, routingStore.get);
}
