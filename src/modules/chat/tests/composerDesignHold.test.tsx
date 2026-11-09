import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type * as AidevRouter from '@/modules/aidev-router';
import type { AidevSendDecoration, BeforeSendContext } from '@/modules/aidev-router';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readQueuedMessages, resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * 2026-11-09 (user decision): a command that needs a specialist the catalog lacks is not sent — it waits in the
 * chat's queue, held for the specialist the gateway is designing, and runs on it once designed. Its card can run it
 * at once on the generalist instead; that command then stays the generalist's, and the specialist takes the next one.
 */
const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
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

const routing = vi.hoisted(() => ({ contexts: [] as Array<Record<string, unknown>>, released: [] as Array<{ scope: string; id: string; agent: string }> }));
const decoration = (design: boolean, forceAgent: string | null): AidevSendDecoration => ({
  aidev: { agent: { name: forceAgent ?? 'generalist' } }, model: null, effort: null, runId: 1, appResend: Boolean(forceAgent), switchBack: null,
  route: { decision: design ? 'create_background' : 'use', scope: { ask_clarify: false }, agent: { name: 'generalist' }, plan: { engine: 'claude' },
    create: design ? { design: true, background: true, proposal: { name: 'apple-sidecar-interop', domain: 'display protocols', description: '', technologies: [] } } : null } as unknown as AidevSendDecoration['route'],
});
vi.mock('@/modules/aidev-router', async (importOriginal) => ({
  ...(await importOriginal<typeof AidevRouter>()),
  useAidevRouting: () => ({ beforeSend: async (_text: string, context: BeforeSendContext) => { routing.contexts.push(context as unknown as Record<string, unknown>); return decoration(!context.forceAgent, context.forceAgent ?? null); } }),
  useDesignHolds: () => ({ release: async (scope: string, turn: { id: string }, agent: string) => { routing.released.push({ scope, id: turn.id, agent }); } }),
  usePrejudge: () => undefined,
}));

const submitEvent = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;

function renderComposer(sent: Array<Record<string, unknown>>, isLoading = false) {
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

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  routing.contexts = [];
  routing.released = [];
});

test('a command without its specialist waits in the queue, held for the one being designed', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  await act(async () => { view.result.current.setInput('mac sidecar를 윈도우에서 받게 해줘'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
  assert.equal(sent.length, 0, 'not sent to the generalist');
  const [held] = readQueuedMessages('session-a');
  assert.equal(held.content, 'mac sidecar를 윈도우에서 받게 해줘');
  assert.equal(held.hold?.design, 'apple-sidecar-interop');
  assert.equal(held.hold?.provider, 'claude');
  assert.equal(view.result.current.input, '', 'the composer is free for the next command');
  assert.equal(view.result.current.queuedDrafts[0].hold?.design, 'apple-sidecar-interop');
});

test('"범용 에이전트로 즉시 실행" sends it now on the generalist; while busy it is released into the queue instead', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  await act(async () => { view.result.current.setInput('sidecar 프로토콜 조사해줘'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
  const id = readQueuedMessages('session-a')[0].id!;
  await act(async () => { view.result.current.runHeldDraftNow(id); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'sidecar 프로토콜 조사해줘');
  assert.equal(routing.contexts.at(-1)?.forceAgent, 'generalist', 'routed on the generalist, not held again');
  assert.equal(((sent[0].options as Record<string, unknown>).aidev as { agent: { name: string } }).agent.name, 'generalist');
  assert.equal(readQueuedMessages('session-a').length, 0);

  // a busy chat: the held turn becomes an ordinary queued turn on the generalist (sent when the answer ends)
  await act(async () => { view.result.current.setInput('두 번째 sidecar 명령'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
  const second = readQueuedMessages('session-a')[0].id!;
  view.rerender({ loading: true });
  await act(async () => { view.result.current.runHeldDraftNow(second); });
  assert.deepEqual(routing.released, [{ scope: 'session-a', id: second, agent: 'generalist' }]);
  assert.equal(sent.length, 1);
});
