import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, ProviderUsageLimitsSnapshot, ProviderUsageWindow } from '@/shared/types.js';

/**
 * Account usage limits per engine (2026-10-09), for the drawers of both apps. The runtime learns them
 * from the engines' own turn events — Claude's SDK reports a `rate_limit_event` per turn with the
 * window's utilization and reset time; Codex only shows a refusal — and keeps the last picture here,
 * persisted so a restart does not blank the drawer until the next turn.
 */
type Store = Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>>;

/** A refusal with no reset time is assumed to hold for the shortest window (five hours). */
const UNKNOWN_RESET_HOLD_MS = 5 * 3600_000;
const file = () => path.join(os.homedir(), '.cloudcli', 'usage-limits.json');

let store: Store | null = null;

function load(): Store {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(file(), 'utf8')) as Store; } catch { store = {}; }
  return store;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file(), JSON.stringify(store ?? {}), { mode: 0o600 });
  } catch { /* the in-memory copy still serves the drawer */ }
}

/** Seconds or milliseconds, as the SDK sends either → epoch ms, or null. */
function toEpochMs(value: unknown): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

function current(provider: LLMProvider): ProviderUsageLimitsSnapshot {
  return load()[provider] ?? { provider, observedAt: 0, windows: [], blockedUntil: null };
}

function upsertWindow(windows: ProviderUsageWindow[], next: ProviderUsageWindow): ProviderUsageWindow[] {
  const rest = windows.filter((window) => window.type !== next.type);
  return [...rest, next].sort((a, b) => a.type.localeCompare(b.type));
}

/** Used by the providers routes (GET /usage-limits) and the Claude/Codex runtime providers. */
export const providerUsageLimitsService = {
  /**
   * Claude's `rate_limit_event`: the window named by `rateLimitType` with its utilization and reset,
   * plus any `unifiedWindows` the CLI attaches. `status` says whether that window refuses runs.
   */
  recordClaude(info: Record<string, unknown> | null | undefined) {
    if (!info || typeof info !== 'object') return;
    const snapshot = current('claude');
    let windows = snapshot.windows;
    const now = Date.now();
    const blockedHere = info.status === 'rejected' && info.overageStatus !== 'allowed' && info.overageStatus !== 'allowed_warning';
    const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
    if (type) {
      windows = upsertWindow(windows, { type, utilization: typeof info.utilization === 'number' ? Math.max(0, Math.min(1, info.utilization)) : null, resetsAt: toEpochMs(info.resetsAt), blocked: blockedHere });
    }
    const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows as Record<string, { utilization?: unknown; resetsAt?: unknown }> : null;
    if (unified) {
      for (const [key, value] of Object.entries(unified)) {
        if (!value || typeof value !== 'object') continue;
        const existing = windows.find((window) => window.type === key);
        windows = upsertWindow(windows, { type: key, utilization: typeof value.utilization === 'number' ? Math.max(0, Math.min(1, value.utilization)) : existing?.utilization ?? null, resetsAt: toEpochMs(value.resetsAt) ?? existing?.resetsAt ?? null, blocked: key === type ? blockedHere : existing?.blocked ?? false });
      }
    }
    // an allowed status lifts a block (the window reset, or an earlier read was corrected)
    const blockedUntil = blockedHere ? (toEpochMs(info.resetsAt) ?? toEpochMs(info.overageResetsAt) ?? 0) : null;
    load().claude = { provider: 'claude', observedAt: now, windows: blockedHere ? windows : windows.map((window) => ({ ...window, blocked: false })), blockedUntil };
    save();
  },

  /** A run the engine refused on a usage limit (any engine): remembered until the reset. */
  recordBlock(provider: LLMProvider, limit: { type?: string | null; resetsAt?: number | null } | null | undefined) {
    const snapshot = current(provider);
    const type = limit?.type && limit.type !== 'unknown' ? limit.type : 'unknown';
    const resetsAt = limit?.resetsAt ?? null;
    load()[provider] = { provider, observedAt: Date.now(), blockedUntil: resetsAt ?? 0, windows: upsertWindow(snapshot.windows, { type, utilization: type === 'unknown' ? null : 1, resetsAt, blocked: true }) };
    save();
  },

  /** A run went through: no block is in force any more (windows keep their last utilization). */
  recordClear(provider: LLMProvider) {
    const snapshot = current(provider);
    if (!snapshot.blockedUntil && !snapshot.windows.some((window) => window.blocked)) return;
    load()[provider] = { ...snapshot, observedAt: Date.now(), blockedUntil: null, windows: snapshot.windows.filter((window) => window.type !== 'unknown').map((window) => ({ ...window, blocked: false })) };
    save();
  },

  /** The picture per engine; a block whose window has passed is reported as lifted. */
  snapshot(now = Date.now()): Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>> {
    const out: Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>> = {};
    for (const entry of Object.values(load())) {
      if (!entry) continue;
      const holdUntil = entry.blockedUntil === null ? null : (entry.blockedUntil > 0 ? entry.blockedUntil : entry.observedAt + UNKNOWN_RESET_HOLD_MS);
      const lifted = holdUntil !== null && holdUntil <= now;
      out[entry.provider] = lifted ? { ...entry, blockedUntil: null, windows: entry.windows.map((window) => ({ ...window, blocked: false })) } : { ...entry, blockedUntil: holdUntil };
    }
    return out;
  },

  /** Tests: forget everything (memory and file). */
  reset() {
    store = {};
    try { fs.unlinkSync(file()); } catch { /* none */ }
  },
};
