import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';


/**
 * F-09: the debug window keeps the editor's breakpoints and the session's in step for the mapped project
 * (workspace /ws/app ↔ PC /pc/work/app), shows where the session is paused and reads the file from the PC.
 */
const { json, session, breakpoints, file } = vi.hoisted(() => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const session = {
    id: 'dbgs1', targetId: 7, targetName: 'm4pro', adapter: 'js-debug', version: '1.112.0', state: 'paused', error: null, exitCode: null,
    program: '/pc/work/app/src/a.js', module: null, cwd: '/pc/work/app', args: [], by: 'auto', origin: 'agent', remoteRunId: 3, runId: null,
    createdAt: Date.now(), endedAt: null, stopped: { reason: 'breakpoint', description: null, threadId: 0, at: 1 },
    breakpoints: [{ path: '/pc/work/app/src/a.js', line: 2, condition: null, verified: true, message: null }], seq: 4,
    frames: [{ id: 1, name: 'add', path: '/pc/work/app/src/a.js', line: 2, column: 1, internal: false }],
    locals: [{ name: 'total', value: '41', type: 'number', ref: 0 }], localsScope: 'Local', detailError: null, output: 'hello\n',
  };
  const breakpoints = vi.fn(async (_id: string, _path: string, _lines: unknown) => json({ breakpoints: [] }));
  const file = vi.fn(async (_t: number, _p: string) => json({ path: '/pc/work/app/src/a.js', text: 'function add(a, b) {\n  return a + b;\n}\n', size: 40, truncated: false }));
  return { json, session, breakpoints, file };
});

vi.mock('@/shared/api', async (original) => {
  const real = await original<typeof SharedApi>();
  return {
    ...real,
    debugApi: {
      list: async () => json({ sessions: [session] }),
      get: async () => json({ session }),
      events: () => new Promise(() => undefined),
      breakpoints: (id: string, path: string, lines: unknown) => breakpoints(id, path, lines),
      control: async () => json({ session }), evaluate: async () => json({ result: '42', type: 'number', ref: 0 }),
      variables: async () => json({ variables: [] }), scopes: async () => json({ scopes: [] }), stop: async () => json({ session }),
    },
    api: { ...real.api, targets: { ...real.api.targets, file: (t: number, p: string) => file(t, p), list: async () => json({ targets: [] }) } },
  };
});
const { DebugPane } = await import('@/modules/remote-target/DebugPane');
const { debugStore } = await import('@/modules/remote-debug');

class RO { observe() {} disconnect() {} }
beforeEach(() => { (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO; debugStore.select(null); });
afterAll(() => { debugStore.setLines('/ws/app/src/a.js', []); });

describe('DebugPane (F-09)', () => {
  it('pulls the session breakpoints into the editor, pushes editor changes to the session, marks the paused line', async () => {
    debugStore.setLines('/ws/app/src/a.js', [9]);   // stale editor breakpoint: the running session wins
    render(<DebugPane isVisible project={{ path: '/ws/app', name: 'app' }} />);
    await waitFor(() => expect(debugStore.lines('/ws/app/src/a.js')).toEqual([2]));
    expect(debugStore.get().paused).toMatchObject({ sessionId: 'dbgs1', runtimePath: '/ws/app/src/a.js', line: 2 });
    await waitFor(() => expect(screen.getByText('total')).toBeTruthy());
    await waitFor(() => expect(file).toHaveBeenCalledWith(7, '/pc/work/app/src/a.js'));
    expect(breakpoints).not.toHaveBeenCalled();
    act(() => debugStore.toggle('/ws/app/src/a.js', 3));
    await waitFor(() => expect(breakpoints).toHaveBeenCalledWith('dbgs1', '/pc/work/app/src/a.js', [{ line: 2 }, { line: 3 }]));
  });
});
