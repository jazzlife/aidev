import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, ProviderUsageLimitsSnapshot, ProviderUsageWindow } from '@/shared/types.js';
import { isModelScopedUsageLimit } from '@/shared/utils.js';

/**
 * Account usage limits per engine (2026-10-09), for the drawers of both apps. The runtime learns them
 * from Claude's own turn events — the SDK reports a `rate_limit_event` per turn with the window's
 * utilization and reset time — and from the ChatGPT account's usage endpoint for Codex (whose turn
 * events only show a refusal). The last picture is kept here, persisted so a restart does not blank
 * the drawer until the next turn or read.
 */
type Store = Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>>;

/** A refusal with no reset time is assumed to hold for the shortest window (five hours). */
const UNKNOWN_RESET_HOLD_MS = 5 * 3600_000;
const file = () => path.join(os.homedir(), '.cloudcli', 'usage-limits.json');

/**
 * Codex gives no usage numbers in its turn events, but the CLI's own `/status` reads the ChatGPT
 * account's windows from this endpoint with the login in `$CODEX_HOME/auth.json` (the CLI refreshes
 * that token whenever it runs). Asked at most once a minute, when a drawer polls.
 */
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_USAGE_CACHE_MS = 60_000;
const CODEX_USAGE_TIMEOUT_MS = 8_000;
const codexAuthFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');

let store: Store | null = null;
let codexFetchedAt = 0;

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

function readCodexAuth(): { accessToken: string; accountId: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(codexAuthFile(), 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } };
    const accessToken = parsed.tokens?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    return { accessToken, accountId: typeof parsed.tokens?.account_id === 'string' ? parsed.tokens.account_id : '' };
  } catch {
    return null;
  }
}

/** One window of the usage API: `used_percent` 0–100, the window length, and its reset (epoch s or seconds from now). */
function codexWindow(raw: unknown, now: number): ProviderUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const window = raw as { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown; reset_after_seconds?: unknown };
  const usedPercent = Number(window.used_percent);
  if (!Number.isFinite(usedPercent)) return null;
  const seconds = Number(window.limit_window_seconds);
  const type = Number.isFinite(seconds) && seconds > 0 && seconds <= 6 * 3600 ? 'five_hour' : 'seven_day';
  const resetAfter = Number(window.reset_after_seconds);
  const resetsAt = toEpochMs(window.reset_at) ?? (Number.isFinite(resetAfter) && resetAfter > 0 ? now + resetAfter * 1000 : null);
  return { type, utilization: Math.max(0, Math.min(1, usedPercent / 100)), resetsAt, blocked: usedPercent >= 100 };
}

/** Replaces the Codex picture with the account's current windows; leaves it alone when the account cannot be read. */
async function refreshCodexUsage(now: number) {
  const auth = readCodexAuth();
  if (!auth) return;
  const response = await fetch(CODEX_USAGE_URL, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-Id': auth.accountId },
    signal: AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS),
  });
  if (!response.ok) return;
  const body = await response.json() as { rate_limit?: { allowed?: unknown; limit_reached?: unknown; primary_window?: unknown; secondary_window?: unknown } | null };
  const limit = body.rate_limit;
  if (!limit || typeof limit !== 'object') return;
  let windows: ProviderUsageWindow[] = [];
  for (const raw of [limit.primary_window, limit.secondary_window]) {
    const window = codexWindow(raw, now);
    if (window) windows = upsertWindow(windows, window);
  }
  const limitReached = limit.limit_reached === true || limit.allowed === false || windows.some((window) => window.blocked);
  // the block lifts when the earliest full window resets; a refusal without any reset is held five hours (snapshot)
  const resets = (windows.some((window) => window.blocked) ? windows.filter((window) => window.blocked) : windows).map((window) => window.resetsAt).filter((at): at is number => at !== null);
  const blockedUntil = limitReached ? (resets.length ? Math.min(...resets) : 0) : null;
  load().codex = { provider: 'codex', observedAt: now, windows, blockedUntil };
  save();
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
   * plus any `unifiedWindows` the CLI attaches. `status` says whether that window refuses runs. A
   * model's own window (`seven_day_fable` …) refusing marks that window only — the account stays
   * open (`blockedUntil` untouched) and the flag lives until its reset or its own allowed event.
   */
  recordClaude(info: Record<string, unknown> | null | undefined) {
    if (!info || typeof info !== 'object') return;
    const snapshot = current('claude');
    let windows = snapshot.windows;
    const now = Date.now();
    const blockedHere = info.status === 'rejected' && info.overageStatus !== 'allowed' && info.overageStatus !== 'allowed_warning';
    const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
    const scoped = isModelScopedUsageLimit(type);
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
    // an allowed status on an account window lifts the account block (the window reset, or an earlier
    // read was corrected) and the flags of the other account windows; model windows keep their own
    const blockedUntil = scoped ? snapshot.blockedUntil : blockedHere ? (toEpochMs(info.resetsAt) ?? toEpochMs(info.overageResetsAt) ?? 0) : null;
    if (!scoped && !blockedHere) windows = windows.map((window) => (isModelScopedUsageLimit(window.type) ? window : { ...window, blocked: false }));
    load().claude = { provider: 'claude', observedAt: now, windows, blockedUntil };
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

  /**
   * A run went through: no account block is in force any more (windows keep their last utilization).
   * A model's own window stays marked — the run may have used another model — until its reset.
   */
  recordClear(provider: LLMProvider) {
    const snapshot = current(provider);
    if (!snapshot.blockedUntil && !snapshot.windows.some((window) => window.blocked && !isModelScopedUsageLimit(window.type))) return;
    load()[provider] = { ...snapshot, observedAt: Date.now(), blockedUntil: null, windows: snapshot.windows.filter((window) => window.type !== 'unknown').map((window) => (isModelScopedUsageLimit(window.type) ? window : { ...window, blocked: false })) };
    save();
  },

  /** The picture per engine; a block (of the account, or of one window) whose reset has passed is reported as lifted. */
  snapshot(now = Date.now()): Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>> {
    const out: Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>> = {};
    for (const entry of Object.values(load())) {
      if (!entry) continue;
      const holdUntil = entry.blockedUntil === null ? null : (entry.blockedUntil > 0 ? entry.blockedUntil : entry.observedAt + UNKNOWN_RESET_HOLD_MS);
      const lifted = holdUntil !== null && holdUntil <= now;
      const windows = entry.windows.map((window) => (window.blocked && (lifted || (window.resetsAt !== null && window.resetsAt <= now)) ? { ...window, blocked: false } : window));
      out[entry.provider] = lifted ? { ...entry, blockedUntil: null, windows } : { ...entry, blockedUntil: holdUntil, windows };
    }
    return out;
  },

  /**
   * The providers route: the picture per engine, with Codex's read afresh from the ChatGPT account
   * at most once a minute. A failed read keeps the last picture (its observedAt says how old it is).
   */
  async snapshotLive(now = Date.now()): Promise<Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>>> {
    if (now - codexFetchedAt >= CODEX_USAGE_CACHE_MS) {
      codexFetchedAt = now;
      await refreshCodexUsage(now).catch(() => undefined);
    }
    return providerUsageLimitsService.snapshot(now);
  },

  /** Tests: forget everything (memory, file and the Codex read cache). */
  reset() {
    store = {};
    codexFetchedAt = 0;
    try { fs.unlinkSync(file()); } catch { /* none */ }
  },
};
