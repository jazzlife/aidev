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

/**
 * Claude's turn events are its only report, so a drawer opened (or a sign-in made) before the next turn showed the
 * picture of a day ago, or none. The platform's 1-year token cannot read `/api/oauth/usage` (scope user:profile), but
 * any Messages reply carries the account's windows in `anthropic-ratelimit-unified-*` headers (measured 2026-10-14):
 * the smallest request — one output token of Haiku, about 23 tokens of the subscription — is sent at most every ten
 * minutes while a drawer is open, and at once after a sign-in.
 */
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_USAGE_MODEL = 'claude-haiku-4-5';
const CLAUDE_USAGE_CACHE_MS = 10 * 60_000;
/** The unified headers' window names → the windows the turn events use. */
const CLAUDE_HEADER_WINDOWS: Record<string, string> = { '5h': 'five_hour', '7d': 'seven_day' };

/** The engines the drawers show; only the signed-in ones are reported (2026-10-13). */
const USAGE_ENGINES: LLMProvider[] = ['claude', 'codex', 'opencode'];
const SIGNED_IN_CACHE_MS = 60_000;

let store: Store | null = null;
let codexFetchedAt = 0;
let claudeFetchedAt = 0;
let signedIn: Set<LLMProvider> | null = null;
let signedInAt = 0;

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

/**
 * The `anthropic-ratelimit-unified-*` headers of a Messages reply as a `rate_limit_event` (the form recordClaude
 * reads): the representative window with the overall status, and every window the headers name. Exported for the test.
 */
export function claudeUsageFromHeaders(headers: Headers): Record<string, unknown> | null {
  const get = (name: string) => headers.get(`anthropic-ratelimit-unified-${name}`);
  const unifiedWindows: Record<string, { utilization: number; resetsAt: number }> = {};
  for (const [short, type] of Object.entries(CLAUDE_HEADER_WINDOWS)) {
    const utilization = Number(get(`${short}-utilization`));
    const resetsAt = Number(get(`${short}-reset`));
    if (Number.isFinite(utilization) && get(`${short}-utilization`) !== null) unifiedWindows[type] = { utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : 0 };
  }
  if (!Object.keys(unifiedWindows).length) return null;
  const claim = get('representative-claim');
  const representative = claim && unifiedWindows[claim] ? claim : Object.keys(unifiedWindows)[0];
  return {
    status: get('status') ?? 'allowed',
    rateLimitType: representative,
    utilization: unifiedWindows[representative].utilization,
    resetsAt: Number(get('reset')) || unifiedWindows[representative].resetsAt,
    overageStatus: get('overage-status'),
    unifiedWindows,
  };
}

/** Asks Claude for the account's windows with the platform token; leaves the picture alone when it cannot. */
async function refreshClaudeUsage() {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!token) return;
  const response = await fetch(CLAUDE_USAGE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    // a subscription token answers requests that present themselves as Claude Code
    body: JSON.stringify({ model: CLAUDE_USAGE_MODEL, max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS),
  });
  // a refusal on a limit still carries the headers; anything else (a sign-in problem) says nothing about usage
  if (!response.ok && response.status !== 429) return;
  const info = claudeUsageFromHeaders(response.headers);
  if (info) providerUsageLimitsService.recordClaude(info);
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
      // a window past its reset: its old figure no longer holds (Claude's next turn reports the new one)
      const windows = entry.windows.map((window) => (window.resetsAt !== null && window.resetsAt <= now ? { ...window, utilization: null, blocked: false }
        : window.blocked && lifted ? { ...window, blocked: false } : window));
      out[entry.provider] = lifted ? { ...entry, blockedUntil: null, windows } : { ...entry, blockedUntil: holdUntil, windows };
    }
    return out;
  },

  /**
   * The providers route: the picture per signed-in engine only (an engine signed in but not yet seen
   * comes back empty), with Codex's read afresh from the ChatGPT account at most once a minute. A
   * failed read keeps the last picture (its observedAt says how old it is). An engine found signed
   * out loses its stored picture, so a later sign-in — perhaps another account — starts blank.
   * `isSignedIn` answers null when it cannot tell; the engine then keeps its last standing.
   */
  async snapshotLive(isSignedIn: (provider: LLMProvider) => Promise<boolean | null>, now = Date.now(), refresh = false): Promise<Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>>> {
    // `refresh`: a sign-in just changed (the apps say so) — ask about the sign-ins and Codex's account now
    if (refresh) { signedInAt = 0; codexFetchedAt = 0; claudeFetchedAt = 0; }
    if (!signedIn || now - signedInAt >= SIGNED_IN_CACHE_MS) {
      const previous = signedIn;
      const next = new Set<LLMProvider>();
      for (const provider of USAGE_ENGINES) {
        const state = await isSignedIn(provider).catch(() => null);
        if (state === true || (state === null && previous?.has(provider))) next.add(provider);
        if (state === false && load()[provider]) {
          delete load()[provider];
          save();
        }
      }
      signedIn = next;
      signedInAt = now;
    }
    if (signedIn.has('codex') && now - codexFetchedAt >= CODEX_USAGE_CACHE_MS) {
      codexFetchedAt = now;
      await refreshCodexUsage(now).catch(() => undefined);
    }
    if (signedIn.has('claude') && now - claudeFetchedAt >= CLAUDE_USAGE_CACHE_MS) {
      claudeFetchedAt = now;
      await refreshClaudeUsage().catch(() => undefined);
    }
    const all = providerUsageLimitsService.snapshot(now);
    const out: Partial<Record<LLMProvider, ProviderUsageLimitsSnapshot>> = {};
    for (const provider of signedIn) out[provider] = all[provider] ?? { provider, observedAt: 0, windows: [], blockedUntil: null };
    return out;
  },

  /**
   * A sign-out (the providers route) or a new sign-in (the in-app Claude and OpenCode logins — perhaps another
   * account): drop the engine and its picture, and ask about the sign-ins afresh.
   */
  forget(provider: LLMProvider) {
    signedIn?.delete(provider);
    signedInAt = 0;
    codexFetchedAt = 0;
    claudeFetchedAt = 0;
    if (!load()[provider]) return;
    delete load()[provider];
    save();
  },

  /** Tests: forget everything (memory, file, the Codex read cache and the sign-ins). */
  reset() {
    store = {};
    codexFetchedAt = 0;
    claudeFetchedAt = 0;
    signedIn = null;
    signedInAt = 0;
    try { fs.unlinkSync(file()); } catch { /* none */ }
  },
};
