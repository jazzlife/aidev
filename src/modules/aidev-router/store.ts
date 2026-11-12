import { useSyncExternalStore } from 'react';

import type { Engine, NextAction, RouteResult, RunVerification } from '@/modules/aidev-router/api';

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

/** The last routed send in one chat: the run it opened, its command and its agent (E-03 follow-ups read these). */
export type SentRun = { runId: number | null; text: string; agent: string | null; reported: boolean };
/** E-03: the gateway's proposal for a chat's failed run; `text` is the command a retry sends. */
export type Escalation = { next: NextAction; text: string; sessionId: string | null; agent: string | null };
/** Independent verification of a chat's last routed run: pending while the verifier reads the repository, then its verdict. */
export type Verification = { runId: number; status: 'pending' | 'done'; result: RunVerification | null };
/**
 * A chat's last routing decision as its router bar shows it: the route, the command it was made for, the run it opened
 * and that run's end and rating.
 */
export type ChatRoute = { route: RouteResult; text: string; runId: number | null; finishedAt: number | null; feedback: 'up' | 'down' | null };
/** The per-chat maps below; their key is the session id ('' = a new chat whose id is not known yet). */
type SessionKeyed = 'sent' | 'escalations' | 'verifications' | 'routes' | 'savedOverrides';

export const sessionKey = (sessionId: string | null | undefined): string => sessionId ?? '';

export type RoutingState = {
  mode: RoutingMode;
  /** Agent forced for exactly the next send (the catalog's "다음 명령에 사용", an escalated retry or handoff); consumed by beforeSend. */
  oneShotAgent: string | null;
  busy: boolean;
  /**
   * Each chat's last routing decision (2026-11-12: one page-wide slot showed the last routed chat's agent, engine and
   * scope in every chat's bar).
   */
  routes: Record<string, ChatRoute>;
  error: string | null;
  overrides: RoutingOverrides;
  /**
   * The chat `overrides` were picked in (null = a new chat without an id). Another chat starts on automatic routing
   * again (2026-10-17: a model picked once used to pin every later chat of the page); a chat the app continues in —
   * a new chat's id, a handoff — keeps them (adoptSession).
   */
  overridesSessionId: string | null;
  /** The picks of the chats the user left (targetId aside), restored when that chat is opened again. */
  savedOverrides: Record<string, RoutingOverrides>;
  /**
   * E-03: settings forced for exactly the next send (escalated retry or engine handoff); consumed by beforeSend.
   * `forText`: the retry command they were made for — a command sent before it (the retry was queued behind a running
   * turn, or dropped while busy) runs routed instead, and the plan and its agent are dropped.
   */
  oneShotPlan: { engine?: Engine; model?: string | null; effort?: string | null; depth?: number | null; escalatedFromRun?: number; forText?: string } | null;
  /**
   * Per chat, because runs go on in several chats at once while one is on screen: a run's outcome, verdict and
   * follow-up stay with the chat it ran in (2026-11-09: one global slot sent a MyDrives verifier retry into the
   * NewHyOn-Web chat that was open when the verdict came — server run #1736).
   */
  sent: Record<string, SentRun>;
  /** E-03: each chat's proposal for its last failed run, shown in that chat until acted on or dismissed. */
  escalations: Record<string, Escalation>;
  /** E-03: a handoff brief waiting to be sent once the new session (other engine) is open. */
  pendingHandoff: { sessionId: string; text: string } | null;
  /** The open chat's own effort ceiling (sessionId null = a new chat whose id is not known yet). */
  chatCap: { sessionId: string | null; cap: Partial<Record<Engine, string>> | null };
  /** The open chat's own model floor (same lifecycle as chatCap). */
  chatFloor: { sessionId: string | null; floor: Partial<Record<Engine, string>> | null };
  /** Each chat's verification of its last routed run (worker ≠ verifier), shown there until dismissed or its next send. */
  verifications: Record<string, Verification>;
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

let state: RoutingState = { mode: readMode(), oneShotAgent: null, busy: false, routes: {}, error: null, overrides: {}, overridesSessionId: null, savedOverrides: {}, oneShotPlan: null, sent: {}, escalations: {}, pendingHandoff: null, chatCap: { sessionId: null, cap: null }, chatFloor: { sessionId: null, floor: null }, verifications: {} };
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
  /** Sets (or with null, clears) one chat's entry of a per-chat map. */
  setFor<K extends SessionKeyed>(key: K, sessionId: string | null | undefined, value: RoutingState[K][string] | null) {
    const next = { ...state[key] } as RoutingState[K];
    if (value) next[sessionKey(sessionId)] = value as RoutingState[K][string];
    else delete next[sessionKey(sessionId)];
    routingStore.patch({ [key]: next } as Partial<RoutingState>);
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
  /**
   * The open chat became `sessionId`: the picks of the chat left are kept for it and that chat's own are restored, so
   * none leaks into another chat (the PC pick follows useTargetChoice).
   */
  followSession(sessionId: string | null) {
    if (state.overridesSessionId === sessionId) return;
    const { targetId, ...left } = state.overrides;
    const { [sessionKey(state.overridesSessionId)]: _left, [sessionKey(sessionId)]: restored, ...others } = state.savedOverrides;
    const savedOverrides = Object.keys(left).length ? { ...others, [sessionKey(state.overridesSessionId)]: left } : others;
    routingStore.patch({ overridesSessionId: sessionId, savedOverrides, overrides: { ...restored, ...(targetId === undefined ? {} : { targetId }) } });
  },
  /**
   * The conversation continues in `sessionId` (a new chat's id, a handoff, the way back): the overrides go with it, and
   * a new chat's route (sent before its id existed) becomes that chat's. With `open` false the user is on another
   * chat by then: the overrides on screen are that chat's, so they stay with it.
   */
  adoptSession(sessionId: string, open = true) {
    // what a new chat sent, was routed, verified, offered or picked before its id existed is that chat's now
    const adopted: Partial<RoutingState> = {};
    for (const key of ['sent', 'escalations', 'verifications', 'routes', 'savedOverrides'] as const) {
      const map = state[key] as Record<string, unknown>;
      if (!('' in map) || sessionId in map) continue;
      const { '': entry, ...rest } = map;
      adopted[key] = { ...rest, [sessionId]: entry } as never;
    }
    routingStore.patch({ ...(open ? { overridesSessionId: sessionId } : {}), ...adopted });
  },
  /** Applies `update` to every chat's route (a fact about the account, not one chat: a login, the default PC). */
  updateRoutes(update: (route: RouteResult) => RouteResult) {
    routingStore.patch({ routes: Object.fromEntries(Object.entries(state.routes).map(([key, chat]) => [key, { ...chat, route: update(chat.route) }])) });
  },
  /** Drops one override (the engine chip's "자동": back to priority / routing for the next sends). */
  clearOverride(key: keyof RoutingOverrides) {
    const next = { ...state.overrides };
    delete next[key];
    routingStore.patch({ overrides: next });
  },
};

/** The chat's own last routing decision, or null when nothing was routed there on this page. */
export const chatRouteOf = (current: RoutingState, sessionId: string | null | undefined): ChatRoute | null => current.routes[sessionKey(sessionId)] ?? null;

/** React binding for routingStore. Used by the router bar/chip and the composer hook. */
export function useRoutingState(): RoutingState {
  return useSyncExternalStore(routingStore.subscribe, routingStore.get, routingStore.get);
}
