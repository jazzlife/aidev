/**
 * "Show this PC's screen" from outside the screen pane (an agent through app control): kept until the pane takes it,
 * since the pane may only mount when its live window opens. `window` is a window id or "full" (the whole screen).
 */
export type ScreenRequest = { targetId: number; window: number | 'full' };

export const SCREEN_REQUEST_EVENT = 'aidev:screen-request';
let pending: ScreenRequest | null = null;

/** Used by the workbench's app-control handler: opens the request in the screen pane (now or when it mounts). */
export function requestScreen(request: ScreenRequest) {
  pending = request;
  window.dispatchEvent(new CustomEvent(SCREEN_REQUEST_EVENT));
}

/** Used by ScreenPane: the request waiting for it, once. */
export function takeScreenRequest(): ScreenRequest | null {
  const r = pending;
  pending = null;
  return r;
}
