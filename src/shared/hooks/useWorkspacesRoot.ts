import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * Cached at module scope because the workspace root is static for the life of
 * the server process and more than one path display needs it. Without this,
 * every sidebar/wizard mount would refetch it.
 */
let cachedRoot: string | null = null;
let inFlightRequest: Promise<string | null> | null = null;

async function loadWorkspacesRoot(): Promise<string | null> {
  if (cachedRoot !== null) {
    return cachedRoot;
  }
  if (inFlightRequest) {
    return inFlightRequest;
  }

  inFlightRequest = (async () => {
    try {
      const response = await api.system.workspacesRoot();
      const body = (await response.json()) as { success?: boolean; data?: { root?: string } };
      const root = body.success && typeof body.data?.root === 'string' ? body.data.root : null;
      cachedRoot = root;
      return root;
    } catch (error) {
      console.error('Error loading workspaces root:', error);
      return null;
    } finally {
      inFlightRequest = null;
    }
  })();

  return inFlightRequest;
}

/** The server's workspace root directory, for collapsing project paths to `~` in display. Null until loaded. */
export function useWorkspacesRoot(): string | null {
  const [root, setRoot] = useState<string | null>(cachedRoot);

  useEffect(() => {
    let cancelled = false;

    void loadWorkspacesRoot().then((loadedRoot) => {
      if (!cancelled) {
        setRoot(loadedRoot);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return root;
}
