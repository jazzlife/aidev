import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteScreenSource, RemoteWindow } from '@/shared/types';
import { readUserPreference, resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/** What each PC lists: target id → its windows. */
const listed: Record<number, RemoteWindow[]> = {};
const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data } as Response);

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: {
    user: { preferences: () => okJson({ preferences: {} }), savePreferences: () => okJson({}) },
    targets: {
      windows: (id: number) => okJson({ windows: listed[id] ?? [], displays: null, perWindow: true }),
      runs: () => okJson({ runs: [] }),
    },
  },
}));

const { useScreenSources } = await import('@/modules/remote-screen/useScreenSources');

const win = (id: number, app: string, title: string, focused = false): RemoteWindow =>
  ({ id, pid: 1, app, title, x: 0, y: 0, width: 800, height: 600, focused } as RemoteWindow);

type Props = { targetId: number; chosen: RemoteScreenSource | null };
const render = (props: Props) => renderHook((p: Props) => useScreenSources(p.targetId, true, p.chosen), { initialProps: props });

describe('useScreenSources — the last window per PC', () => {
  beforeEach(() => {
    localStorage.clear();
    resetUserPreferences();
    listed[1] = [win(10, 'Chrome', 'docs', true), win(11, 'Code', 'main.ts')];
    listed[2] = [win(20, 'Terminal', 'zsh', true), win(21, 'Code', 'other.ts')];
  });

  it('opens on the focused window when nothing was picked before', async () => {
    const { result } = render({ targetId: 1, chosen: null });
    await waitFor(() => expect(result.current.source).toEqual({ kind: 'window', id: 10 }));
  });

  it('remembers a pick per PC and opens on it next time', async () => {
    const first = render({ targetId: 1, chosen: null });
    await waitFor(() => expect(first.result.current.source).not.toBeNull());
    first.rerender({ targetId: 1, chosen: { kind: 'window', id: 11 } });
    await waitFor(() => expect(readUserPreference<Record<string, unknown>>('remoteScreenLast', {})['1']).toEqual({ kind: 'window', id: 11, app: 'Code', title: 'main.ts' }));
    first.unmount();

    const again = render({ targetId: 1, chosen: null });
    await waitFor(() => expect(again.result.current.source).toEqual({ kind: 'window', id: 11 }));
    // another PC is not affected
    const other = render({ targetId: 2, chosen: null });
    await waitFor(() => expect(other.result.current.source).toEqual({ kind: 'window', id: 20 }));
  });

  it('finds the remembered window by app and title when the program restarted with a new id', async () => {
    writeUserPreference('remoteScreenLast', { 1: { kind: 'window', id: 11, app: 'Code', title: 'main.ts' } });
    listed[1] = [win(10, 'Chrome', 'docs', true), win(12, 'Code', 'readme.md'), win(13, 'Code', 'main.ts')];
    const { result } = render({ targetId: 1, chosen: null });
    await waitFor(() => expect(result.current.source).toEqual({ kind: 'window', id: 13 }));
  });

  it('does not take an id that now belongs to another program', async () => {
    writeUserPreference('remoteScreenLast', { 1: { kind: 'window', id: 11, app: 'Slack', title: 'general' } });
    const { result } = render({ targetId: 1, chosen: null });
    await waitFor(() => expect(result.current.source).toEqual({ kind: 'window', id: 10 }));
  });

  it('does not save one PC\'s pick under another PC while its list is still loading', async () => {
    const view = render({ targetId: 1, chosen: null });
    await waitFor(() => expect(view.result.current.source).not.toBeNull());
    const pick: RemoteScreenSource = { kind: 'window', id: 11 };
    view.rerender({ targetId: 1, chosen: pick });
    await act(async () => { view.rerender({ targetId: 2, chosen: pick }); });
    await waitFor(() => expect(view.result.current.source).toEqual({ kind: 'window', id: 20 }));
    expect(readUserPreference<Record<string, unknown>>('remoteScreenLast', {})['2']).toBeUndefined();
  });
});
