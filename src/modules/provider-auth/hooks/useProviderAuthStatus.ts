import { useCallback, useState } from 'react';

import { aidevApi, claudeAuth } from '@/modules/aidev-router';
import { api } from '@/shared/api';
import { AIDEV_ENGINES, PROVIDER_MODELS_CHANGED_EVENT } from '@/shared/constants';
import type { LLMProvider, ProviderAuthStatus, ProviderAuthStatusMap } from '@/shared/types';

// the providers whose sign-in is probed by default (Cursor is hidden: no probe unless asked for by name)
const CLI_PROVIDERS: LLMProvider[] = [...AIDEV_ENGINES];

const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { authenticated: false, email: null, method: null, error: null, loading },
  cursor: { authenticated: false, email: null, method: null, error: null, loading },
  codex: { authenticated: false, email: null, method: null, error: null, loading },
  opencode: { authenticated: false, email: null, method: null, error: null, loading },
});

type ProviderAuthStatusPayload = {
  authenticated?: boolean;
  email?: string | null;
  method?: string | null;
  error?: string | null;
};

type ProviderAuthStatusApiResponse = {
  success: boolean;
  data: ProviderAuthStatusPayload;
};

const FALLBACK_STATUS_ERROR = 'Failed to check authentication status';
const FALLBACK_UNKNOWN_ERROR = 'Unknown error';

const toErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : FALLBACK_UNKNOWN_ERROR
);

const toProviderAuthStatus = (
  payload: ProviderAuthStatusPayload,
  fallbackError: string | null = null,
): ProviderAuthStatus => ({
  authenticated: Boolean(payload.authenticated),
  email: payload.email ?? null,
  method: payload.method ?? null,
  error: payload.error ?? fallbackError,
  loading: false,
});

type UseProviderAuthStatusOptions = {
  initialLoading?: boolean;
};

export function useProviderAuthStatus(
  { initialLoading = true }: UseProviderAuthStatusOptions = {},
) {
  const [providerAuthStatus, setProviderAuthStatus] = useState<ProviderAuthStatusMap>(() => (
    createInitialProviderAuthStatusMap(initialLoading)
  ));

  const setProviderLoading = useCallback((provider: LLMProvider) => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: {
        ...previous[provider],
        loading: true,
        error: null,
      },
    }));
  }, []);

  const setProviderStatus = useCallback((provider: LLMProvider, status: ProviderAuthStatus) => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: status,
    }));
  }, []);

  const checkProviderAuthStatus = useCallback(async (provider: LLMProvider): Promise<ProviderAuthStatus> => {
    setProviderLoading(provider);

    try {
      const response = await api.providers.authStatus(provider);

      if (!response.ok) {
        const status: ProviderAuthStatus = {
          authenticated: false,
          email: null,
          method: null,
          loading: false,
          error: FALLBACK_STATUS_ERROR,
        };
        setProviderStatus(provider, status);
        return status;
      }

      const payload = (await response.json()) as ProviderAuthStatusApiResponse;
      const status = toProviderAuthStatus(payload.data);
      setProviderStatus(provider, status);
      return status;
    } catch (caughtError) {
      console.error(`Error checking ${provider} auth status:`, caughtError);
      const status: ProviderAuthStatus = {
        authenticated: false,
        email: null,
        method: null,
        loading: false,
        error: toErrorMessage(caughtError),
      };
      setProviderStatus(provider, status);
      return status;
    }
  }, [setProviderLoading, setProviderStatus]);

  /** Signs the runtime out of one provider; resolves with its status afterwards, rejects when it failed. */
  const logoutProvider = useCallback(async (provider: LLMProvider): Promise<ProviderAuthStatus> => {
    setProviderLoading(provider);
    try {
      const response = await api.providers.logout(provider);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as ProviderAuthStatusApiResponse;
      const status = toProviderAuthStatus(payload.data);
      setProviderStatus(provider, status);
      return status;
    } catch (caughtError) {
      // the sign-out may have half happened: show what the runtime reports now
      await checkProviderAuthStatus(provider);
      throw caughtError;
    } finally {
      // the gateway routes by its own cached engine status, and the router bar shows the Claude login: both learn
      // of the sign-out now (outside the platform these calls fail quietly)
      void aidevApi.engines(true).catch(() => undefined);
      if (provider === 'claude') void claudeAuth.refresh();
      // the drawer's usage and the composer's models drop the signed-out provider now
      window.dispatchEvent(new Event(PROVIDER_MODELS_CHANGED_EVENT));
    }
  }, [checkProviderAuthStatus, setProviderLoading, setProviderStatus]);

  const refreshProviderAuthStatuses = useCallback(async (providers: LLMProvider[] = CLI_PROVIDERS) => {
    await Promise.all(providers.map((provider) => checkProviderAuthStatus(provider)));
  }, [checkProviderAuthStatus]);

  return {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
    logoutProvider,
  };
}
