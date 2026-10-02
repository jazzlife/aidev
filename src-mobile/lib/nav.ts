import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Back means "up", never "the previous page" (Android back button, gesture, the top bar's ‹):
 *   1. an open overlay (sheet, viewer, an in-screen view) closes first,
 *   2. otherwise the screen's parent opens (each screen names it with `useParent`),
 *   3. at a root (parent null) the app is left.
 * How: the browser history is kept at exactly two entries, a trap and the current screen. Every in-app move replaces
 * the current entry (`useGo`), so the only back step lands on the trap; `BackController` catches that popstate before
 * the router sees it, puts the screen's entry back on top and then closes the overlay or replaces it with the parent.
 */
const overlays: Array<{ close: () => void }> = [];
let parentPath: string | null = null;

/** Used by every screen: its parent for back and the top bar's ‹ (null at a root). */
export function useParent(path: string | null) {
  useLayoutEffect(() => { parentPath = path; }, [path]);
}

/** Used by sheets, viewers and in-screen views: while `open`, back calls `close` instead of leaving the screen. */
export function useBackOverlay(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    if (!open) return undefined;
    const entry = { close: () => closeRef.current() };
    overlays.push(entry);
    return () => {
      const index = overlays.indexOf(entry);
      if (index >= 0) overlays.splice(index, 1);
    };
  }, [open]);
}

type GoOptions = { state?: Record<string, unknown> };

/** Used for every in-app move (instead of useNavigate / Link): replaces the current entry; the new screen gets
 *  `from` (the screen it was opened from) for screens whose parent is their opener. */
export function useGo() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return useCallback((to: string, options: GoOptions = {}) => {
    navigate(to, { replace: true, state: { from: `${pathname}${search}`, ...options.state } });
  }, [navigate, pathname, search]);
}

/** Used by the top bar's ‹: the same as the back button. */
export function useGoUp() {
  const navigate = useNavigate();
  return useCallback(() => {
    const overlay = overlays[overlays.length - 1];
    if (overlay) overlay.close();
    else if (parentPath !== null) navigate(parentPath, { replace: true });
  }, [navigate]);
}

/** The opener a screen was reached from (`useGo` puts it in the state), for screens whose parent is their opener. */
export function useOpener(fallback: string) {
  const state = useLocation().state as { from?: string } | null;
  return state?.from || fallback;
}

type Entry = { state: unknown; url: string };

/** Mounted once inside the router: sets up the trap and turns every back step into "up". */
export function BackController() {
  const navigate = useNavigate();
  const location = useLocation();
  const top = useRef<Entry | null>(null);
  // the router hands out a new navigate on every move: the trap is set up once, with the latest one in a ref
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; });

  // the current screen's entry, to put back on top after a back step
  useEffect(() => {
    const state = window.history.state as { aidevTrap?: boolean } | null;
    if (!state?.aidevTrap) top.current = { state: window.history.state, url: window.location.href };
  }, [location]);

  useEffect(() => {
    const history = window.history;
    const current = history.state as Record<string, unknown> | null;
    // the entry the app opened on becomes the trap; the screen goes on top of it
    history.replaceState({ ...current, aidevTrap: true }, '');
    history.pushState(current, '');
    top.current = { state: current, url: window.location.href };

    const onPop = (event: PopStateEvent) => {
      if (!(event.state as { aidevTrap?: boolean } | null)?.aidevTrap) return;   // not the trap: the router's business
      event.stopImmediatePropagation();
      const overlay = overlays[overlays.length - 1];
      if (!overlay && parentPath === null) {
        history.back();   // a root: leave the app
        return;
      }
      if (top.current) history.pushState(top.current.state, '', top.current.url);
      if (overlay) overlay.close();
      else if (parentPath !== null) navigateRef.current(parentPath, { replace: true });
    };
    // capture: runs before the router's own popstate listener, which then never sees the trap
    window.addEventListener('popstate', onPop, true);
    return () => window.removeEventListener('popstate', onPop, true);
  }, []);

  return null;
}
