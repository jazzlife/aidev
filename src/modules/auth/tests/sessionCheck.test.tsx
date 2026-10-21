import assert from 'node:assert/strict';

import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { test, vi } from 'vitest';

/**
 * A token refresh (every 4 h with the gateway's 8 h token) rebuilt checkAuthStatus, which re-ran the session check:
 * isLoading went true, the auth gate swapped the whole app for the loading screen and mounted it again — the open
 * workbench and the phone app "closed and reopened" by themselves.
 */

const status = vi.fn(async () => ({ ok: true, json: async () => ({ needsSetup: false }) }));

vi.mock('@/shared/api', () => ({
  api: {
    auth: {
      status,
      user: vi.fn(async () => ({ ok: true, json: async () => ({ user: { id: 1, username: 'jazz' } }) })),
      refresh: vi.fn(),
    },
    user: { onboardingStatus: vi.fn(async () => ({ ok: true, json: async () => ({ hasCompletedOnboarding: true }) })) },
  },
}));
vi.mock('@/shared/userSettings', () => ({ hydrateUserPreferences: vi.fn(), resetUserPreferences: vi.fn() }));
vi.mock('@/shared/chatDrafts', () => ({ hydrateChatDrafts: vi.fn(), resetChatDrafts: vi.fn() }));
const t = (key: string) => key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const { AuthProvider, useAuth } = await import('@/modules/auth/context/AuthContext');
const { storeAuthToken } = await import('@/shared/authToken');

const jwt = (iat: number) => {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'HS256' })}.${encode({ iat, exp: iat + 8 * 3600 })}.sig`;
};

let mounts = 0;
function App() {
  useEffect(() => { mounts += 1; }, []);
  return <div data-testid="app" />;
}
function Gate() {
  const { isLoading, user } = useAuth();
  if (isLoading || !user) return <div data-testid="loading" />;
  return <App />;
}

test('a refreshed token keeps the app mounted and does not check the session again', async () => {
  const now = Math.floor(Date.now() / 1000);
  localStorage.setItem('auth-token', jwt(now));
  render(<AuthProvider><Gate /></AuthProvider>);
  await screen.findByTestId('app');
  assert.equal(mounts, 1);

  act(() => { storeAuthToken(jwt(now + 60)); });
  await waitFor(() => assert.equal(localStorage.getItem('auth-token'), jwt(now + 60)));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(screen.queryByTestId('app'));
  assert.equal(mounts, 1);
  assert.equal(status.mock.calls.length, 1);
});
