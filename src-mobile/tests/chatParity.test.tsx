import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** C-12.2: the chat basics that used to block work on the phone. */
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const prefs = vi.hoisted(() => ({ claudePermissions: { allowedTools: ['Read'], disallowedTools: ['Bash(rm:*)'], skipPermissions: false } as unknown }));
const api = {
  providers: { capabilities: vi.fn(() => json({ success: true, data: { providers: [{ provider: 'claude', permissionModes: ['default', 'acceptEdits', 'plan'], defaultPermissionMode: 'default' }] } })) },
  assets: { uploadFiles: vi.fn((_form: FormData) => json({ attachments: [{ path: '/a/1.png', name: 'shot.png', mimeType: 'image/png', size: 3 }] })), image: vi.fn() },
};
vi.mock('@/modules/chat-core', async () => {
  const permissions = await vi.importActual<typeof import('@/modules/chat/utils/chatPermissions')>('@/modules/chat/utils/chatPermissions');
  return {
    api,
    parseToolPayload: (value: unknown) => value,
    buildClaudeToolPermissionEntry: permissions.buildClaudeToolPermissionEntry,
    readUserPreference: (key: string, fallback: unknown) => (prefs as Record<string, unknown>)[key] ?? fallback,
    // no Settings default in these tests: the engine's own default decides
    readDefaultPermissionMode: () => null,
  };
});

const { PermissionSheet } = await import('@m/components/PermissionSheet');
const { Composer } = await import('@m/components/Composer');
const { MessageList } = await import('@m/components/MessageList');
const { buildSendOptions, usePermissionMode, useCapsMap, uploadAttachments, adoptDraftPermissionMode } = await import('@m/lib/chatOptions');

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('questions from the agent (AskUserQuestion)', () => {
  const request = { requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [
    { question: '어느 DB?', header: '저장소', options: [{ label: 'SQLite' }, { label: 'Postgres', description: '서버' }] },
    { question: '무엇을 테스트?', multiSelect: true, options: [{ label: '단위' }, { label: '통합' }] },
  ] } };

  it('answers each question in turn — one option, several options, a typed answer — in the workbench shape', () => {
    const onDecide = vi.fn();
    render(<PermissionSheet request={request} provider="claude" onDecide={onDecide} onLater={vi.fn()} />);
    expect(screen.getByText('질문 1/2 · 저장소')).toBeTruthy();
    fireEvent.click(screen.getByText('SQLite'));
    fireEvent.click(screen.getByText('Postgres'));   // single choice: replaces
    fireEvent.click(screen.getByText('다음'));
    fireEvent.click(screen.getByText('단위'));
    fireEvent.click(screen.getByText('통합'));
    fireEvent.change(screen.getByLabelText('직접 입력'), { target: { value: 'e2e' } });
    fireEvent.click(screen.getByText('보내기'));
    expect(onDecide).toHaveBeenCalledWith('r1', { allow: true, updatedInput: { ...request.input, answers: { '어느 DB?': 'Postgres', '무엇을 테스트?': '단위, 통합, e2e' } } });
  });

  it('skip sends no answers; closing keeps the question waiting', () => {
    const onDecide = vi.fn(); const onLater = vi.fn();
    render(<PermissionSheet request={request} provider="claude" onDecide={onDecide} onLater={onLater} />);
    fireEvent.click(screen.getByLabelText('닫기'));
    expect(onLater).toHaveBeenCalled();
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('건너뛰기'));
    expect(onDecide).toHaveBeenCalledWith('r1', { allow: true, updatedInput: { ...request.input, answers: {} } });
  });
});

describe('tool permission', () => {
  it('offers "항상 허용" with the rule the workbench would save (Bash by command)', () => {
    const onAlwaysAllow = vi.fn();
    const request = { requestId: 'r2', toolName: 'Bash', input: { command: 'npm test -- --watch=false' } };
    render(<PermissionSheet request={request} provider="claude" onDecide={vi.fn()} onAlwaysAllow={onAlwaysAllow} onLater={vi.fn()} />);
    expect(screen.getByText('npm test -- --watch=false')).toBeTruthy();
    fireEvent.click(screen.getByText('항상 허용'));
    expect(onAlwaysAllow).toHaveBeenCalledWith(request, 'Bash(npm:*)');
  });

  it('git commands keep their subcommand; codex has no saved rules', () => {
    const { rerender } = render(<PermissionSheet request={{ requestId: 'r3', toolName: 'Bash', input: { command: 'git commit -m x' } }} provider="claude" onDecide={vi.fn()} onAlwaysAllow={vi.fn()} onLater={vi.fn()} />);
    expect(screen.getByText('Bash(git commit:*)')).toBeTruthy();
    rerender(<PermissionSheet request={{ requestId: 'r3', toolName: 'Bash', input: { command: 'git commit -m x' } }} provider="codex" onDecide={vi.fn()} onAlwaysAllow={vi.fn()} onLater={vi.fn()} />);
    expect(screen.queryByText('항상 허용')).toBeNull();
  });

  it('a plan shows as text, with "계속 계획" and "승인하고 실행"', () => {
    const onDecide = vi.fn();
    render(<PermissionSheet request={{ requestId: 'r4', toolName: 'ExitPlanMode', input: { plan: '## 단계\n1. 로그인 고치기' } }} provider="claude" onDecide={onDecide} onLater={vi.fn()} />);
    expect(screen.getByTestId('plan-body').textContent).toContain('로그인 고치기');
    fireEvent.click(screen.getByText('계속 계획'));
    expect(onDecide).toHaveBeenLastCalledWith('r4', { allow: false, message: 'User asked to revise the plan' });
    fireEvent.click(screen.getByText('승인하고 실행'));
    expect(onDecide).toHaveBeenLastCalledWith('r4', { allow: true });
  });
});

describe('composer', () => {
  it('keeps send while the agent answers (the send waits its turn) with stop next to it', () => {
    const onSend = vi.fn(() => true); const onAbort = vi.fn();
    render(<Composer busy onSend={onSend} onAbort={onAbort} />);
    fireEvent.change(screen.getByPlaceholderText('명령을 입력하세요'), { target: { value: '다음 할 일' } });
    fireEvent.click(screen.getByLabelText('대기열에 넣기'));
    expect(onSend).toHaveBeenCalledWith('다음 할 일', []);
    fireEvent.click(screen.getByLabelText('중지'));
    expect(onAbort).toHaveBeenCalled();
  });

  it('cuts in while the agent answers: ⚡ and ⌘/Ctrl+Shift+Enter send now, ⌘/Ctrl+Enter queues', () => {
    const onSend = vi.fn(() => true); const onInterrupt = vi.fn(() => true);
    const { rerender } = render(<Composer busy onSend={onSend} onInterrupt={onInterrupt} onAbort={vi.fn()} />);
    const box = screen.getByPlaceholderText('명령을 입력하세요');
    fireEvent.change(box, { target: { value: '멈추고 이렇게 해' } });
    fireEvent.click(screen.getByLabelText('지금 개입'));
    expect(onInterrupt).toHaveBeenCalledWith('멈추고 이렇게 해', []);
    fireEvent.change(box, { target: { value: '바로 이것' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, shiftKey: true });
    expect(onInterrupt).toHaveBeenLastCalledWith('바로 이것', []);
    fireEvent.change(box, { target: { value: '그 다음' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('그 다음', []);
    // idle: no cut-in button
    rerender(<Composer busy={false} onSend={onSend} onInterrupt={onInterrupt} onAbort={vi.fn()} />);
    expect(screen.queryByLabelText('지금 개입')).toBeNull();
  });

  it('attaches files (10 at most, 10MB each) and shows the permission-mode pill', () => {
    const onSend = vi.fn(() => true); const onMode = vi.fn();
    // jsdom has no object URLs
    const created = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    render(<Composer busy={false} onSend={onSend} onAbort={vi.fn()} mode={{ label: '편집 허용', onOpen: onMode }} />);
    const input = screen.getByTestId('composer-file-input');
    const shot = new File(['png'], 'shot.png', { type: 'image/png' });
    const huge = new File(['x'], 'huge.zip'); Object.defineProperty(huge, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [shot, huge] } });
    expect(screen.getByAltText('shot.png')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('huge.zip: 10MB를 넘습니다');
    expect(created).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('권한 모드: 편집 허용'));
    expect(onMode).toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('명령을 입력하세요'), { target: { value: '이 화면 봐' } });
    fireEvent.click(screen.getByLabelText('보내기'));
    expect(onSend).toHaveBeenCalledWith('이 화면 봐', [shot]);
    expect(screen.queryByTestId('composer-files')).toBeNull();
  });
});

describe('send options', () => {
  it('carry the mode and the saved rules like the workbench', () => {
    expect(buildSendOptions('claude', 'acceptEdits')).toEqual({ permissionMode: 'acceptEdits', toolsSettings: { allowedTools: ['Read'], disallowedTools: ['Bash(rm:*)'], skipPermissions: false }, skipPermissions: false });
  });

  it('the mode is per conversation, from the engine list; a new chat hands its draft mode to the session', async () => {
    let state: ReturnType<typeof usePermissionMode> | null = null;
    function Probe({ id }: { id: string | null }) { const caps = useCapsMap(); state = usePermissionMode(id, 'claude', caps); return null; }
    const { rerender } = render(<Probe id={null} />);
    await settle();
    expect(state!.modes).toEqual(['default', 'acceptEdits', 'plan']);
    expect(state!.mode).toBe('default');
    act(() => state!.choose('plan'));
    expect(state!.mode).toBe('plan');
    adoptDraftPermissionMode('s1');
    rerender(<Probe id="s1" />);
    expect(state!.mode).toBe('plan');
    rerender(<Probe id="s2" />);
    expect(state!.mode).toBe('default');
  });

  it('uploads the files as "files" and returns what the send names', async () => {
    const attachments = await uploadAttachments([new File(['png'], 'shot.png', { type: 'image/png' })]);
    expect((api.assets.uploadFiles.mock.calls[0]?.[0] as FormData).getAll('files')).toHaveLength(1);
    expect(attachments[0]?.path).toBe('/a/1.png');
  });
});

describe('long conversations', () => {
  it('"이전 메시지 보기" loads the earlier page', async () => {
    const onLoadOlder = vi.fn(() => Promise.resolve());
    const messages = [{ id: 'm1', sessionId: 's', timestamp: '', provider: 'claude' as const, kind: 'text' as const, role: 'user' as const, content: '안녕' }];
    render(<MessageList messages={messages} loading={false} hasMore onLoadOlder={onLoadOlder} />);
    fireEvent.click(screen.getByText('이전 메시지 보기'));
    await settle();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('a sent image shows in the bubble', () => {
    const messages = [{ id: 'm2', sessionId: 's', timestamp: '', provider: 'claude' as const, kind: 'text' as const, role: 'user' as const, content: '봐', images: [{ data: 'data:image/png;base64,AA', name: 'shot.png' }], files: [{ name: 'log.txt' }] }];
    render(<MessageList messages={messages} loading={false} />);
    expect(screen.getByAltText('shot.png')).toBeTruthy();
    expect(screen.getByTestId('sent-attachments').textContent).toContain('log.txt');
  });
});
