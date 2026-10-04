import { lazy, useSyncExternalStore, type ComponentType } from 'react';

/**
 * A screen that loads when it is first opened (C-06), plus `preload()` for the idle prefetch (C-12.1). Only a download
 * a render is waiting for counts as "loading" (the top bar's progress line); a prefetch in the background does not.
 */
let waiting = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export type LazyScreen<P> = ComponentType<P> & { preload: () => Promise<unknown> };

export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>): LazyScreen<P> {
  let promise: Promise<ComponentType<P>> | null = null;
  let done = false;
  const start = () => {
    promise ??= load().then((component) => { done = true; return component; }, (error: unknown) => { promise = null; throw error; });
    return promise;
  };
  // React calls this once, on the first render that needs the screen
  const Screen = lazy(async () => {
    const pending = start();
    if (done) return { default: await pending };
    waiting += 1; notify();
    try { return { default: await pending }; } finally { waiting -= 1; notify(); }
  }) as unknown as LazyScreen<P>;
  Screen.preload = start;
  return Screen;
}

/** Used by RouteProgress: true while a render waits for a screen's code. */
export function useScreenLoading() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => waiting > 0);
}
