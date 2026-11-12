import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, test, vi } from 'vitest';

import type * as AidevRouter from '@/modules/aidev-router';
import type { AidevSendDecoration } from '@/modules/aidev-router';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, resetChatDrafts } from '@/shared/chatDrafts';
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
      providers: { createSession: () => okJson({ data: { sessionId: 'session-new', sessionName: '새 채팅' } }) },
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

type ComposerArgs = Parameters<typeof useChatComposerState>[0];

function renderComposer(
  sent: Array<Record<string, unknown>>,
  extra: Partial<ComposerArgs> = {},
  initialProps: { project: Project; sessionId: string | null } = { project: PROJECT, sessionId: 'session-a' },
) {
  return renderHook(({ project, sessionId }: { project: Project; sessionId: string | null }) => useChatComposerState({
    selectedProject: project,
    selectedSession: sessionId ? { id: sessionId } : null,
    currentSessionId: sessionId,
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
    ...extra,
  }), { initialProps });
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

test('no hold when the router does not ask, or for the app\'s own re-sends', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  for (const [text, result] of [
    ['web/src/Login.tsx 버튼 고쳐줘', decoration(false)],
    ['[다시 시도] 셰이더 컴파일', decoration(true, { appResend: true })],
  ] as const) {
    routing.beforeSend = async () => result;
    await act(async () => { view.result.current.setInput(text); });
    await act(async () => { await view.result.current.handleSubmit(submitEvent); });
    assert.equal(view.result.current.clarify, null, text);
  }
  assert.deepEqual(sent.map((message) => message.content), ['web/src/Login.tsx 버튼 고쳐줘', '[다시 시도] 셰이더 컴파일']);
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

test('a command still routing stays with its own chat when another project\'s chat is opened meanwhile', async () => {
  // switching chats between Enter and the send used to show the command as sending in the other chat, and a held
  // command was put back into whichever composer was open — the other chat's, where it then stayed as its draft
  let finish: (value: unknown) => void = () => undefined;
  routing.beforeSend = () => new Promise((resolve) => { finish = resolve; });
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  const other: Project = { projectId: 'project-2', displayName: 'Project Two', fullPath: '/tmp/project-two' };

  await act(async () => { view.result.current.setInput('로그인 버튼 고쳐줘'); });
  let first: Promise<void> = Promise.resolve();
  await act(async () => { first = view.result.current.handleSubmit(submitEvent); });
  view.rerender({ project: other, sessionId: 'session-b' });
  assert.equal(view.result.current.sending, null, 'the other chat does not show it as sending');

  await act(async () => { finish(decoration(true)); await first; });
  assert.equal(sent.length, 0);
  assert.equal(view.result.current.input, '', 'the other chat\'s composer stays as it was');
  assert.equal(readDraftText('session-b'), '');
  // read through a call: an assertion on the property would narrow it to null for the rest of the test
  const clarifyQuestion = () => view.result.current.clarify?.question;
  assert.equal(clarifyQuestion(), undefined, 'the question belongs to the chat it was asked in');

  view.rerender({ project: PROJECT, sessionId: 'session-a' });
  await vi.waitFor(() => assert.equal(view.result.current.input, '로그인 버튼 고쳐줘'));
  assert.equal(clarifyQuestion(), '어느 화면의 로그인 버튼인가요?');
});

test('each chat keeps its own attachments, message being replaced, and send lock', async () => {
  // a command routing in one chat used to block Enter in every other chat (nothing happened), and the files and the
  // sent message being edited in one chat followed the user into the next
  const finishes: Array<(value: unknown) => void> = [];
  routing.beforeSend = () => new Promise((resolve) => { finishes.push(resolve); });
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  const other: Project = { projectId: 'project-2', displayName: 'Project Two', fullPath: '/tmp/project-two' };
  const file = new File(['x'], 'a.txt', { type: 'text/plain' });

  await act(async () => {
    view.result.current.setAttachedFiles([file]);
    view.result.current.beginEditMessage({ type: 'user', content: '고칠 메시지', timestamp: new Date(), transcriptAnchorId: 'anchor-a' });
  });
  assert.equal(view.result.current.editingAnchorId, 'anchor-a');
  view.rerender({ project: other, sessionId: 'session-b' });
  assert.deepEqual(view.result.current.attachedFiles, [], 'chat B does not show chat A\'s files');
  assert.equal(view.result.current.editingAnchorId, null, 'nor the message chat A is replacing');

  view.rerender({ project: PROJECT, sessionId: 'session-a' });
  assert.deepEqual(view.result.current.attachedFiles, [file]);
  await act(async () => { view.result.current.setAttachedFiles([]); view.result.current.cancelEditMessage(); });
  await act(async () => { view.result.current.setInput('A 명령'); });
  let sendA: Promise<void> = Promise.resolve();
  await act(async () => { sendA = view.result.current.handleSubmit(submitEvent); });

  view.rerender({ project: other, sessionId: 'session-b' });
  await act(async () => { view.result.current.setInput('B 명령'); });
  let sendB: Promise<void> = Promise.resolve();
  await act(async () => { sendB = view.result.current.handleSubmit(submitEvent); });
  assert.equal(finishes.length, 2, 'chat B sends while chat A is still routing');
  assert.equal(view.result.current.sending, 'B 명령');

  await act(async () => { finishes[1](decoration(false)); await sendB; });
  assert.deepEqual(sent.map((message) => [message.sessionId, message.content]), [['session-b', 'B 명령']]);
  view.rerender({ project: PROJECT, sessionId: 'session-a' });
  assert.equal(view.result.current.sending, 'A 명령', 'chat A still shows its own send');

  await act(async () => { finishes[0](decoration(false)); await sendA; });
  assert.deepEqual(sent.map((message) => [message.sessionId, message.content]), [['session-b', 'B 명령'], ['session-a', 'A 명령']]);
  assert.equal(view.result.current.sending, null);
});

test('a new chat\'s session being created does not pull back a user who moved to another chat', async () => {
  // the new session used to open by force the moment it was created, and its first message was added to the
  // transcript on screen — the other chat's
  for (const moveAway of [true, false]) {
    let finish: (value: unknown) => void = () => undefined;
    routing.beforeSend = () => new Promise((resolve) => { finish = resolve; });
    const sent: Array<Record<string, unknown>> = [];
    const established: Array<[string, unknown]> = [];
    const added: Array<[unknown, unknown]> = [];
    const view = renderComposer(sent, {
      onSessionEstablished: (sessionId, _context, options) => { established.push([sessionId, options]); },
      addMessage: (message, sessionId) => { added.push([message.content, sessionId]); },
    }, { project: PROJECT, sessionId: null });

    await act(async () => { view.result.current.setInput('새 기능 만들어줘'); });
    let send: Promise<void> = Promise.resolve();
    await act(async () => { send = view.result.current.handleSubmit(submitEvent); });
    if (moveAway) view.rerender({ project: { ...PROJECT, projectId: 'project-2' }, sessionId: 'session-b' });
    await act(async () => { finish(decoration(false)); await send; });

    assert.deepEqual(established, [['session-new', { open: !moveAway }]], moveAway ? 'moved away: stays put' : 'still there: opens it');
    assert.deepEqual(added, [['새 기능 만들어줘', 'session-new']], 'the message goes into the new session');
    assert.equal(sent[0]?.sessionId, 'session-new');
    view.unmount();
  }
});
