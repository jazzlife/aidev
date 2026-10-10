import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type * as AidevRouter from '@/modules/aidev-router';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { hydrateChatDrafts, readQueuedMessages, resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * While a turn is running the composer offers two ways to get a word in: Enter
 * puts the message at the back of the session's command queue (several can
 * wait, in order, and each can be edited or dropped), and the interrupt action
 * sends it at once with `interrupt: true`, which makes the server cut the
 * running turn short. The queue itself lives in the draft store, which the
 * server shortens as it sends — the cards only follow it.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

const server = vi.hoisted(() => ({ drafts: [] as unknown[] }));
vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: server.drafts }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

// Routing is off: the send goes out exactly as typed.
vi.mock('@/modules/aidev-router', async (importOriginal) => ({
  ...(await importOriginal<typeof AidevRouter>()),
  useAidevRouting: () => ({ beforeSend: async () => null }),
  usePrejudge: () => undefined,
}));

const submitEvent = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;

function renderComposer(sent: Array<Record<string, unknown>>, isLoading = true) {
  return renderHook(({ loading }: { loading: boolean }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: { id: 'session-a' },
    currentSessionId: 'session-a',
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: loading,
    canAbortSession: loading,
    tokenBudget: null,
    sendMessage: (message: unknown) => { sent.push(message as Record<string, unknown>); },
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }), { initialProps: { loading: isLoading } });
}

const typeAndSubmit = async (view: ReturnType<typeof renderComposer>, text: string) => {
  await act(async () => { view.result.current.setInput(text); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
};

beforeEach(() => {
  localStorage.clear();
  server.drafts = [];
  resetChatDrafts();
});

test('Enter during a run queues behind it, and several turns wait in order', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);

  await typeAndSubmit(view, 'first, fix the test');
  await typeAndSubmit(view, 'then update the docs');

  assert.deepEqual(sent, [], 'nothing is sent while the turn runs');
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['first, fix the test', 'then update the docs']);
  assert.equal(view.result.current.input, '', 'the composer is clear for the next message');
  assert.deepEqual(
    readQueuedMessages('session-a').map((turn) => turn.content),
    ['first, fix the test', 'then update the docs'],
    'the queue is persisted for the server to send',
  );
  assert.equal(readQueuedMessages('session-a')[0]?.options?.model, 'test-model', 'each turn keeps the settings it was queued with');
});

test('one queued turn can be dropped or taken back into the composer without touching the others', async () => {
  const view = renderComposer([]);
  await typeAndSubmit(view, 'one');
  await typeAndSubmit(view, 'two');
  await typeAndSubmit(view, 'three');

  const [one, two] = view.result.current.queuedDrafts;
  await act(async () => { view.result.current.deleteQueuedDraft(two.id); });
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['one', 'three']);

  await act(async () => { view.result.current.editQueuedDraft(one.id); });
  assert.equal(view.result.current.input, 'one');
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['three']);
  assert.deepEqual(readQueuedMessages('session-a').map((turn) => turn.content), ['three']);
});

test('the interrupt action sends at once with the interrupt flag instead of queueing', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);

  await act(async () => { view.result.current.setInput('stop, do it this way instead'); });
  await act(async () => { view.result.current.handleInterruptSubmit(submitEvent); });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'chat.send');
  assert.equal(sent[0].sessionId, 'session-a');
  assert.equal(sent[0].content, 'stop, do it this way instead');
  assert.equal(sent[0].interrupt, true);
  assert.deepEqual(view.result.current.queuedDrafts, []);
  assert.deepEqual(readQueuedMessages('session-a'), []);
});

test('an idle send carries no interrupt flag', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent, false);

  await typeAndSubmit(view, 'plain send');

  assert.equal(sent.length, 1);
  assert.equal('interrupt' in sent[0], false);
});

test('the cards follow the server as it sends the head of the queue', async () => {
  const view = renderComposer([]);
  await typeAndSubmit(view, 'goes first');
  await typeAndSubmit(view, 'goes second');
  const second = readQueuedMessages('session-a')[1];
  // Clearing the composer after queueing leaves a debounced draft write; a
  // hydrate leaves a scope alone while one is pending, so let it flush first.
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  // The server sent the head and left the rest in the column.
  server.drafts = [{ scope: 'session-a', text: '', queuedMessage: [second] }];
  await act(async () => { await hydrateChatDrafts(); });

  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['goes second']);
});

test('a queued turn can be moved up or down the line, and the server gets the new order', async () => {
  const view = renderComposer([]);
  await typeAndSubmit(view, 'a');
  await typeAndSubmit(view, 'b');
  await typeAndSubmit(view, 'c');
  const [a, , c] = view.result.current.queuedDrafts;

  await act(async () => { view.result.current.moveQueuedDraft(c.id, -1); });
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['a', 'c', 'b']);

  await act(async () => { view.result.current.moveQueuedDraft(a.id, -1); });
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['a', 'c', 'b'], 'the head cannot move further up');

  await act(async () => { view.result.current.moveQueuedDraft(a.id, 1); });
  assert.deepEqual(readQueuedMessages('session-a').map((turn) => turn.content), ['c', 'a', 'b']);
});

test('"send now" takes a queued turn out of the line and sends it with its own settings, keeping what is being typed', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  await typeAndSubmit(view, 'wait your turn');
  await typeAndSubmit(view, 'actually, this first');
  const [, urgent] = view.result.current.queuedDrafts;

  await act(async () => { view.result.current.setInput('half-typed thought'); });
  await act(async () => { view.result.current.sendQueuedDraftNow(urgent.id); });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'chat.send');
  assert.equal(sent[0].content, 'actually, this first');
  assert.equal(sent[0].interrupt, true);
  assert.equal(sent[0].queuedId, urgent.id, 'the server is told which queued turn went, so no older copy re-queues it');
  assert.equal((sent[0].options as { model: string }).model, 'test-model', 'the settings it was queued with travel with it');
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['wait your turn']);
  assert.equal(view.result.current.input, 'half-typed thought', 'the composer is left alone');
});

test('"send now" leaves the turn queued while the running turn cannot be interrupted', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: { id: 'session-a' },
    currentSessionId: 'session-a',
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: true,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message: unknown) => { sent.push(message as Record<string, unknown>); },
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  await act(async () => { view.result.current.setInput('later'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
  const [queued] = view.result.current.queuedDrafts;

  await act(async () => { view.result.current.sendQueuedDraftNow(queued.id); });

  assert.deepEqual(sent, []);
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['later']);
});
