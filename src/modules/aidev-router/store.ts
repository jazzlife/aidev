import { useSyncExternalStore } from 'react';

import type { AgentDraft, Engine, NextAction, RouteResult, RunVerification } from '@/modules/aidev-router/api';

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

/** Agent creation in progress (§3.7): architect turn → review card → optional self-check turn. */
export type PendingCreate = {
  stage: 'architect' | 'review' | 'selfcheck' | 'done';
  /** the command to re-send with the new agent; empty for a queued domain (its commands already ran — D-04) */
  originalText: string;
  sessionId: string | null;
  decisionId: number;
  /** D-04: the create-queue entry being created (marked created with the agent) */
  queueId?: number | null;
  draft: AgentDraft | null;
  agentId: number | null;
  agentName: string | null;
  selfCheckResult: { pass: boolean | null; confidence: number; note: string } | null;
  error: string | null;
};

export type RoutingState = {
  mode: RoutingMode;
  pendingCreate: PendingCreate | null;
  /** Agent forced for exactly the next send (creation re-send, self-check); consumed by beforeSend. */
  oneShotAgent: string | null;
  /** D-04: create-queue entry whose specialist the next send creates; consumed by beforeSend. */
  oneShotCreate: number | null;
  busy: boolean;
  last: RouteResult | null;
  lastText: string | null;
  error: string | null;
  overrides: RoutingOverrides;
  /** run id the gateway allocated for the send currently in flight or last sent */
  runId: number | null;
  /** when the last routed run completed (null while running / before any run) */
  runFinishedAt: number | null;
  /** session the last routed run belongs to (known once the run completes; new chats get their id late) */
  runSessionId: string | null;
  /** feedback already given for the finished run */
  runFeedback: 'up' | 'down' | null;
  /** E-03: settings forced for exactly the next send (escalated retry or engine handoff); consumed by beforeSend. */
  oneShotPlan: { engine?: Engine; model?: string | null; effort?: string | null; depth?: number | null; escalatedFromRun?: number } | null;
  /** E-03: the proposal for the last failed run, shown as a card until acted on or dismissed. */
  escalation: { next: NextAction; text: string; sessionId: string | null } | null;
  /** E-03: a handoff brief waiting to be sent once the new session (other engine) is open. */
  pendingHandoff: { sessionId: string; text: string } | null;
  /** The open chat's own effort ceiling (sessionId null = a new chat whose id is not known yet). */
  chatCap: { sessionId: string | null; cap: Partial<Record<Engine, string>> | null };
  /** The open chat's own model floor (same lifecycle as chatCap). */
  chatFloor: { sessionId: string | null; floor: Partial<Record<Engine, string>> | null };
  /**
   * Independent verification of the last routed run (worker ≠ verifier): pending while the gateway's
   * verifier reads the repository, then its verdict — shown as a card until dismissed or the next send.
   */
  verification: { runId: number; status: 'pending' | 'done'; result: RunVerification | null } | null;
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

let state: RoutingState = { mode: readMode(), pendingCreate: null, oneShotAgent: null, oneShotCreate: null, busy: false, last: null, lastText: null, error: null, overrides: {}, runId: null, runSessionId: null, runFinishedAt: null, runFeedback: null, oneShotPlan: null, escalation: null, pendingHandoff: null, chatCap: { sessionId: null, cap: null }, chatFloor: { sessionId: null, floor: null }, verification: null };
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
