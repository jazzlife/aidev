import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { clearOpenCodeAuthFailure, currentOpenCodeAuthFailure, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type OpenCodeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const OPENCODE_ENV_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
];

/** Set once `opencode --version` answered (see checkInstalled). */
let openCodeInstalled = false;

export class OpenCodeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the OpenCode CLI is available to the server process.
   */
  private checkInstalled(): boolean {
    // The CLI comes with the runtime image and does not change while this process runs; starting its large binary
    // synchronously on every sign-in probe (the gateway's, the drawers', the settings') held the server's event loop
    // each time. A missing CLI is asked again: it may be installed later.
    if (openCodeInstalled) return true;
    try {
      const result = spawn.sync('opencode', ['--version'], { stdio: 'ignore', timeout: 5000 });
      openCodeInstalled = !result.error && result.status === 0;
      return openCodeInstalled;
    } catch {
      return false;
    }
  }

  /**
   * Returns OpenCode CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();
    // a run the provider refused for the sign-in itself (a rejected key, an expired login): the stored credentials are
    // there but do not work, so the provider is not usable until a new sign-in rewrites the auth store
    const failure = credentials.authenticated ? currentOpenCodeAuthFailure() : null;
    if (failure) {
      return { installed, provider: 'opencode', authenticated: false, email: credentials.email, method: credentials.method, error: `sign-in rejected: ${failure.message}` };
    }

    return {
      installed,
      provider: 'opencode',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Removes OpenCode's auth store (every provider it signed in to; `opencode auth logout` only asks which one
   * interactively). Provider API keys in the environment stay.
   */
  async logout(): Promise<void> {
    await rm(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'), { force: true });
    clearOpenCodeAuthFailure();
  }

  /**
   * Reads OpenCode's auth store or falls back to provider API key environment variables.
   */
  private async checkCredentials(): Promise<OpenCodeCredentialsStatus> {
    try {
      const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      for (const [providerId, providerAuth] of Object.entries(auth)) {
        const providerRecord = readObjectRecord(providerAuth);
        if (!providerRecord) {
          continue;
        }

        const hasCredential = Object.values(providerRecord).some(
          (value) => readOptionalString(value) !== undefined || Boolean(readObjectRecord(value)),
        );
        if (hasCredential) {
          return {
            authenticated: true,
            email: `${providerId} credentials`,
            method: 'credentials_file',
          };
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: error instanceof Error ? error.message : 'Failed to read OpenCode auth',
        };
      }
    }

    const envCredential = OPENCODE_ENV_CREDENTIAL_KEYS.find((key) => process.env[key]?.trim());
    if (envCredential) {
      return {
        authenticated: true,
        email: envCredential,
        method: 'environment',
      };
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'OpenCode not configured',
    };
  }
}
