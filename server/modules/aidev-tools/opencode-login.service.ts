import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearOpenCodeAuthFailure } from '@/shared/index.js';

/**
 * In-app OpenCode sign-in with an API key (2026-10-13). `opencode auth login` in a terminal works, but its first row
 * "OpenCode (recommended)" is the pay-as-you-go gateway, the OpenCode Go subscription is a separate provider found
 * only by typing "go" into its search, and the key goes into a masked terminal prompt — a user with a Go key got
 * nowhere. The apps instead name the provider and send the key here, and this stores it the way the CLI does
 * (measured on opencode 1.19.0: `~/.local/share/opencode/auth.json`, `{"<providerID>": {"type": "api", "key": "…"}}`,
 * the file private to the runtime user). Sign-ins that are not an API key (a ChatGPT or GitHub account) stay with
 * the terminal login. Keys are never logged or returned.
 */
const authFile = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

/** OpenCode provider ids as its model ids spell them (`opencode-go/…` → `opencode-go`). */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function readAuth(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Used by aidev-tools.routes.ts for the in-app OpenCode login endpoints. */
export const openCodeLoginService = {
  /** The providers OpenCode holds a credential for (ids only), for the login panel's "연결됨" line. */
  providers(): string[] {
    return Object.keys(readAuth()).sort();
  },

  /**
   * Stores `key` as the API key of `provider`, replacing an earlier credential of that provider and leaving the
   * others as they are. A sign-in failure recorded for OpenCode ends here: the auth store is newer than it.
   */
  async saveApiKey(provider: string, key: string): Promise<{ provider: string; providers: string[] }> {
    const id = provider.trim().toLowerCase();
    if (!PROVIDER_ID.test(id)) throw new Error('공급자 id 형식이 올바르지 않습니다 (예: opencode-go, openai).');
    const trimmed = key.trim();
    if (trimmed.length < 8 || trimmed.length > 500 || /\s/.test(trimmed)) throw new Error('API 키 형식이 올바르지 않습니다.');
    const file = authFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ ...readAuth(), [id]: { type: 'api', key: trimmed } }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    clearOpenCodeAuthFailure();
    // a new sign-in: a refusal remembered under the earlier one does not carry over. Lazy: providers imports this
    // module's barrel (see lesson-curator.service.ts).
    (await import('@/modules/providers/index.js')).providerUsageLimitsService.forget('opencode');
    console.log(`[aidev-tools] OpenCode API key stored for ${id}`);
    return { provider: id, providers: openCodeLoginService.providers() };
  },
};
