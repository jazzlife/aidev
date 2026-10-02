import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useReleaseWatch } from '@/shared/hooks/useReleaseWatch';

/** PWA updates: a deploy reaches an open app — reload when it comes back to the foreground, a notice while in use. */
const releases: string[] = [];
const setVisibility = (state: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

afterEach(() => { vi.restoreAllMocks(); releases.length = 0; setVisibility('visible'); });

describe('useReleaseWatch', () => {
  it('reloads when the app returns to the foreground on a new release', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ release: releases.shift() ?? 'b' })));
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    releases.push('a');
    renderHook(() => useReleaseWatch());
    await settle();
    setVisibility('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    releases.push('b');
    setVisibility('visible'); document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('only shows a notice for a release that lands while the page is in use, and nothing for the same release', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ release: releases.shift() ?? 'a' })));
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
    releases.push('a');
    const { result } = renderHook(() => useReleaseWatch());
    await settle();
    expect(result.current.updateReady).toBe(false);
    releases.push('b');
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60_000 + 10); });
    expect(result.current.updateReady).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
