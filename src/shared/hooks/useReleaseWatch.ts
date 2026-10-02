import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * PWA updates (2026-10-02): an installed app resumed from the background keeps running the release it loaded, so a
 * deploy never reached it until the app was killed. This watches the gateway's release id (GET /_gateway/release):
 *   - the app comes back to the foreground and a new release is out → it reloads at once (the user was not typing);
 *   - a release lands while the user is on the page → `updateReady`, for a "새 버전" button; it is applied on the next
 *     return to the app.
 */
const POLL_MS = 3 * 60_000;

async function currentRelease(): Promise<string | null> {
  try {
    const r = await fetch('/_gateway/release', { cache: 'no-store' });
    if (!r.ok) return null;
    const body = await r.json() as { release?: string };
    return typeof body.release === 'string' && body.release ? body.release : null;
  } catch {
    return null;
  }
}

/** Used by the workbench app shell and the mobile app shell. */
export function useReleaseWatch() {
  const loaded = useRef<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const reload = useCallback(() => { window.location.reload(); }, []);

  useEffect(() => {
    let stopped = false;
    const check = async (resumed: boolean) => {
      const now = await currentRelease();
      if (stopped || !now) return;
      if (!loaded.current) { loaded.current = now; return; }
      if (now === loaded.current) return;
      if (resumed) window.location.reload();
      else setUpdateReady(true);
    };
    void check(false);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(true); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void check(false); }, POLL_MS);
    return () => { stopped = true; document.removeEventListener('visibilitychange', onVisible); window.clearInterval(timer); };
  }, []);

  return { updateReady, reload };
}
