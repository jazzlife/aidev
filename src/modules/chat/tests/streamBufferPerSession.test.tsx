import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ServerEvent, ProjectSession } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * Several chats stream at once — the one on screen and others left running (Cursor and OpenCode stream text in
 * deltas). Streamed text used to go into one buffer for the whole chat view: two chats' text was spliced into
 * whichever chat's flush fired first, a session switch emptied it under a stream still going, and a background
 * chat also got every delta as a row of its own.
 */
function renderHandlers(viewed: string) {
  let listener: ((event: ServerEvent) => void) | null = null;
  const streaming = new Map<string, string>();
  const finalized: string[] = [];
  const appended: Array<{ id: string; kind: unknown }> = [];
  const sessionStore = {
    updateStreaming: (id: string, text: string) => { streaming.set(id, text); },
    finalizeStreaming: (id: string) => { finalized.push(id); },
    appendRealtime: (id: string, message: { kind: unknown }) => { appended.push({ id, kind: message.kind }); },
  } as unknown as SessionStore;
  const view = { id: viewed };
  const hook = renderHook(({ session }) => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    provider: 'cursor',
    selectedSession: session as ProjectSession,
    currentSessionId: session.id,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore,
  }), { initialProps: { session: view } });
  const dispatch = (event: Record<string, unknown>) => act(() => { listener?.(event as ServerEvent); });
  const delta = (sessionId: string, content: string) => dispatch({ kind: 'stream_delta', sessionId, content, provider: 'cursor' });
  return { hook, dispatch, delta, streaming, finalized, appended };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('streamed text is buffered per session', () => {
  it("two chats streaming at once each get only their own text", () => {
    const { delta, dispatch, streaming, finalized } = renderHandlers('a');
    delta('a', 'Hello ');
    delta('b', 'Bonjour ');
    delta('a', 'world');
    delta('b', 'monde');
    act(() => { vi.advanceTimersByTime(100); });
    expect(streaming.get('a')).toBe('Hello world');
    expect(streaming.get('b')).toBe('Bonjour monde');

    // b ends first: a's stream goes on untouched
    dispatch({ kind: 'stream_end', sessionId: 'b' });
    delta('a', '!');
    dispatch({ kind: 'complete', sessionId: 'a' });
    expect(streaming.get('a')).toBe('Hello world!');
    expect(streaming.get('b')).toBe('Bonjour monde');
    expect(finalized).toEqual(['b', 'a']);
  });

  it('a background chat gets one streaming row, not a row per delta', () => {
    const { delta, appended, streaming } = renderHandlers('a');
    delta('b', 'one ');
    delta('b', 'two');
    act(() => { vi.advanceTimersByTime(100); });
    expect(appended).toEqual([]);
    expect(streaming.get('b')).toBe('one two');
  });

  it('switching chats mid-stream keeps the text already streamed', () => {
    const { hook, delta, dispatch, streaming } = renderHandlers('a');
    delta('a', 'first half, ');
    hook.rerender({ session: { id: 'b' } });
    delta('a', 'second half');
    dispatch({ kind: 'stream_end', sessionId: 'a' });
    expect(streaming.get('a')).toBe('first half, second half');
  });

  it('a frame without a session id does not land in the chat on screen', () => {
    const { dispatch, appended, streaming } = renderHandlers('a');
    dispatch({ kind: 'text', role: 'assistant', content: 'stray' });
    dispatch({ kind: 'stream_delta', content: 'stray' });
    act(() => { vi.advanceTimersByTime(100); });
    expect(appended).toEqual([]);
    expect(streaming.size).toBe(0);
    // a protocol error answers this view's own request, so it still shows here
    dispatch({ kind: 'protocol_error', code: 'x', error: 'bad request' });
    expect(appended).toEqual([{ id: 'a', kind: 'error' }]);
  });
});
