import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Subscription login for the runtime's Claude engine (Nado AI Dev). The browser `/login`
 * credentials renew themselves through a refresh token and die for good when that refresh
 * fails ("OAuth session expired and could not be refreshed"). The platform instead keeps a
 * long-lived (1-year) subscription token from `claude setup-token`, obtained by the in-app
 * login flow (aidev-tools claude-login.service.ts), and exposes it to every Claude process through
 * CLAUDE_CODE_OAUTH_TOKEN. A live-turn auth failure is remembered so the auth probe — and so
 * the gateway router and the UI — report "expired" instead of a stale "connected".
 */
type StoredToken = { token: string; issuedAt: number };
type AuthFailure = { at: number; message: string };

const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/;

let failure: AuthFailure | null = null;

const tokenFile = () => path.join(os.homedir(), '.cloudcli', 'aidev-claude-token.json');
const claudeSettingsFile = () => path.join(os.homedir(), '.claude', 'settings.json');
const credentialsFile = () => path.join(os.homedir(), '.claude', '.credentials.json');

function readStored(): StoredToken | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFile(), 'utf8')) as Partial<StoredToken>;
    return typeof parsed.token === 'string' && TOKEN_PATTERN.test(parsed.token) && typeof parsed.issuedAt === 'number'
      ? { token: parsed.token, issuedAt: parsed.issuedAt }
      : null;
  } catch {
    return null;
  }
}

/** Writes JSON readable only by the runtime user (the token grants subscription access). */
function writePrivateJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Used by the Claude auth probe and runtime provider (this module), aidev-tools' in-app login flow
 * and server startup: the single owner of the platform-managed Claude subscription token.
 */
export const claudeAuthStore = {
  /** Startup: expose a stored token to this process (and so to every SDK/CLI child). */
  loadIntoEnv() {
    const stored = readStored();
    if (stored && !process.env.CLAUDE_CODE_OAUTH_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = stored.token;
  },

  isValidToken(token: string) {
    return TOKEN_PATTERN.test(token);
  },

  /**
   * Persists a freshly issued token: private file (source of truth), this process's env (effective
   * immediately, no restart), and ~/.claude/settings.json env so a `claude` started from the
   * terminal uses the same login. Clears any recorded auth failure.
   */
  save(token: string) {
    if (!TOKEN_PATTERN.test(token)) throw new Error('Not a Claude subscription token');
    const issuedAt = Date.now();
    writePrivateJson(tokenFile(), { token, issuedAt });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(fs.readFileSync(claudeSettingsFile(), 'utf8')) as Record<string, unknown>; } catch { /* new file */ }
    const env = settings.env && typeof settings.env === 'object' ? settings.env as Record<string, unknown> : {};
    writePrivateJson(claudeSettingsFile(), { ...settings, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token } });
    failure = null;
    return { issuedAt, expiresAt: issuedAt + TOKEN_LIFETIME_MS };
  },

  /** Issue/expiry of the platform-managed token, or null when the login came from elsewhere. */
  info(): { issuedAt: number; expiresAt: number } | null {
    const stored = readStored();
    if (!stored || process.env.CLAUDE_CODE_OAUTH_TOKEN !== stored.token) return null;
    return { issuedAt: stored.issuedAt, expiresAt: stored.issuedAt + TOKEN_LIFETIME_MS };
  },

  /** Runtime provider: a real turn was refused for authentication; remembered until a new login. */
  recordFailure(message: string) {
    failure = { at: Date.now(), message: message.slice(0, 300) };
  },

  /**
   * The recorded failure, unless a newer login happened since (a token saved here clears it; a
   * terminal `/login` rewrites .credentials.json, whose mtime is then newer than the failure).
   */
  currentFailure(): AuthFailure | null {
    if (!failure) return null;
    try {
      if (fs.statSync(credentialsFile()).mtimeMs > failure.at) { failure = null; return null; }
    } catch {
      // no credentials file: the failure stands
    }
    return failure;
  },
};

/** Used by the Claude runtime provider to tell an authentication failure from any other turn error. */
export function isClaudeAuthFailure(message: string) {
  return /failed to authenticate|oauth session expired|could not be refreshed|invalid[_ ]grant|authentication_error|invalid api key|oauth token has expired/i.test(message);
}
