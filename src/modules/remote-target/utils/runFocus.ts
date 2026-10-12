/**
 * "Show this run" requests (approval cards, chat) for RunOutputPane, kept apart from the pane so asking for a run does
 * not download the pane's terminal (xterm): the pane picks a request up when it is (or becomes) mounted.
 */
type RunFocusRequest = { remoteRunId: number; targetId: number };

let focusRequest: RunFocusRequest | null = null;
const focusListeners = new Set<() => void>();

/** Used by the workbench (through the barrel): show this run in the run output pane, now or when it mounts. */
export function requestRunFocus(request: RunFocusRequest) {
  focusRequest = request;
  for (const fn of focusListeners) fn();
}

/** Used by RunOutputPane: the request waiting for it, once. */
export function takeRunFocus(): RunFocusRequest | null {
  const request = focusRequest;
  focusRequest = null;
  return request;
}

/** Used by RunOutputPane: called on every new request while the pane is mounted; returns the unsubscribe. */
export function subscribeRunFocus(listener: () => void) {
  focusListeners.add(listener);
  return () => { focusListeners.delete(listener); };
}
