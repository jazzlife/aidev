import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * PWA updates (2026-10-02): an installed app resumed from the background keeps running the release it loaded, so a
 * deploy never reached it until the app was killed. This watches the gateway's release id (GET /_gateway/release):
 *   - the app comes back to the foreground and a new release is out → it reloads at once, unless the user is in the
 *     middle of writing (a focused field with text: picked files and the cursor would go) — then the button instead;
 *   - a release lands while the user is on the page → `updateReady`, for a "새 버전" button; it is applied on the next
 *     return to the app.
 */
const POLL_MS = 3 * 60_000;

/** A focused field holds unsent text (an iPad returning to the browser keeps the composer focused). */
function isWriting(): boolean {
  const element = document.activeElement;
  if (element instanceof HTMLTextAreaElement) return element.value.trim() !== '';
  if (element instanceof HTMLInputElement) return ['text', 'search'].includes(element.type) && element.value.trim() !== '';
  return element instanceof HTMLElement && element.isContentEditable;
}

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
      if (resumed && !isWriting()) window.location.reload();
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
