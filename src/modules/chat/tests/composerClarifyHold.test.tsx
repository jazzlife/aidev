import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type * as AidevRouter from '@/modules/aidev-router';
import type { AidevSendDecoration } from '@/modules/aidev-router';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * C-09 (§3.1): a routed send the router says lacks essential detail is held — nothing goes out and the command stays
 * in the composer — until the user answers (sent as "command + (추가 정보) answer") or lets it go. The release reuses
 * the held routing, so the gateway is asked once per command and the run it allocated is the one that runs.
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

const routing = vi.hoisted(() => ({ beforeSend: null as unknown as (...args: unknown[]) => Promise<unknown> }));
vi.mock('@/modules/aidev-router', async (importOriginal) => ({
  ...(await importOriginal<typeof AidevRouter>()),
  useAidevRouting: () => ({ beforeSend: (...args: unknown[]) => routing.beforeSend(...args) }),
  usePrejudge: () => undefined,
}));

const decoration = (askClarify: boolean, extra: Partial<AidevSendDecoration> = {}) => ({
  aidev: { runId: 7, decisionId: 3 },
  model: 'sonnet',
  effort: 'high',
  route: { decision: 'generalist', decision_id: 3, scope: { ask_clarify: askClarify, clarify_question: askClarify ? '어느 화면의 로그인 버튼인가요?' : null }, plan: { engine: 'claude' } },
  runId: 7,
  appResend: false,
  ...extra,
}) as unknown as AidevSendDecoration;

const submitEvent = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;

function renderComposer(sent: Array<Record<string, unknown>>) {
  return renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: { id: 'session-a' },
    currentSessionId: 'session-a',
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message: unknown) => { sent.push(message as Record<string, unknown>); },
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
}

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
});

test('a command missing detail is held, then sent with the answer on its original routing', async () => {
  const calls: unknown[] = [];
  routing.beforeSend = async (...args) => { calls.push(args); return decoration(true); };
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);

  await act(async () => { view.result.current.setInput('로그인 버튼 고쳐줘'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
  assert.equal(sent.length, 0, 'nothing goes out while held');
  assert.equal(view.result.current.clarify?.question, '어느 화면의 로그인 버튼인가요?');
  assert.equal(view.result.current.input, '로그인 버튼 고쳐줘', 'the command stays in the composer');

  await act(async () => { view.result.current.releaseClarify('웹 로그인 화면, 눌러도 반응이 없음'); });
  await vi.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].content, '로그인 버튼 고쳐줘\n\n(추가 정보) 웹 로그인 화면, 눌러도 반응이 없음');
  assert.deepEqual((sent[0].options as Record<string, unknown>).aidev, { runId: 7, decisionId: 3 });
  assert.equal(calls.length, 1, 'the release reuses the held routing');
  assert.equal(view.result.current.clarify, null);
});

test('"그대로 진행" sends the command unchanged; dismissing keeps it in the composer', async () => {
  routing.beforeSend = async () => decoration(true);
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);

  await act(async () => { view.result.current.setInput('그 버그 고쳐줘'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
  await act(async () => { view.result.current.dismissClarify(); });
  assert.equal(view.result.current.clarify, null);
  assert.equal(view.result.current.input, '그 버그 고쳐줘');
  assert.equal(sent.length, 0);

  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
  await act(async () => { view.result.current.releaseClarify(null); });
  await vi.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].content, '그 버그 고쳐줘');
});

test('no hold when the router does not ask, for agent creation, or for the app\'s own re-sends', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  for (const [text, result] of [
    ['web/src/Login.tsx 버튼 고쳐줘', decoration(false)],
    ['결제 기능 추가해줘', decoration(true, { route: { ...decoration(true).route, decision: 'create' } as AidevSendDecoration['route'] })],
    ['[자가 검증] 셰이더 컴파일', decoration(true, { appResend: true })],
  ] as const) {
    routing.beforeSend = async () => result;
    await act(async () => { view.result.current.setInput(text); });
    await act(async () => { await view.result.current.handleSubmit(submitEvent); });
    assert.equal(view.result.current.clarify, null, text);
  }
  assert.deepEqual(sent.map((message) => message.content), ['web/src/Login.tsx 버튼 고쳐줘', '결제 기능 추가해줘', '[자가 검증] 셰이더 컴파일']);
});

test('Enter clears the composer at once and shows the command as sending; a repeated Enter is not a second send', async () => {
  // routing that takes a while (the specialist judge): Enter used to leave the text in place with no sign of life,
  // so people pressed it again — and the command went out twice
  let finish: (value: unknown) => void = () => undefined;
  let calls = 0;
  routing.beforeSend = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);

  await act(async () => { view.result.current.setInput('테스트 돌려줘'); });
  let first: Promise<void> = Promise.resolve();
  await act(async () => { first = view.result.current.handleSubmit(submitEvent); });
  assert.equal(view.result.current.input, '', 'the composer clears as soon as Enter is pressed');
  assert.equal(view.result.current.sending, '테스트 돌려줘', 'the command shows as sending');

  await act(async () => { view.result.current.setInput('테스트 돌려줘'); });
  await act(async () => { await view.result.current.handleSubmit(submitEvent); });
  assert.equal(calls, 1, 'the repeated Enter neither routes nor sends again');
  assert.equal(view.result.current.input, '테스트 돌려줘', 'what was typed meanwhile stays');

  await act(async () => { finish(decoration(false)); await first; });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '테스트 돌려줘');
  assert.equal(view.result.current.sending, null);
  assert.equal(view.result.current.input, '테스트 돌려줘', 'the send finishing does not wipe what was typed meanwhile');
});
