import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ServerEvent, ProjectSession } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * A run this tab did not send (the server sending the next queued turn, a
 * scheduled message, another device) used to stream in while the composer
 * still saw the session idle, so "interrupt and send now" went out as a plain
 * send and the server refused it with RUN_IN_PROGRESS. `run_started` is how
 * the composer learns the session is busy and can be cut into.
 */

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const processing: Array<{ sessionId: string | null | undefined; activity: unknown }> = [];
  const appended: unknown[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: { appendRealtime: (...args: unknown[]) => appended.push(args) } as unknown as SessionStore,
    onSessionProcessing: (sessionId, activity) => processing.push({ sessionId, activity }),
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { processing, appended, dispatch };
};

test('a run started elsewhere marks its session busy and interruptible', () => {
  const { processing, appended, dispatch } = renderHandlers();

  dispatch({ kind: 'run_started', sessionId: 'viewed-session' });

  assert.deepEqual(processing, [{ sessionId: 'viewed-session', activity: { statusText: null, canInterrupt: true } }]);
  // A lifecycle signal, not a transcript row.
  assert.equal(appended.length, 0);
});

test('a run started in another watched session marks that session, not the one on screen', () => {
  const { processing, dispatch } = renderHandlers();

  dispatch({ kind: 'run_started', sessionId: 'background-session' });

  assert.equal(processing.length, 1);
  assert.equal(processing[0]?.sessionId, 'background-session');
});
