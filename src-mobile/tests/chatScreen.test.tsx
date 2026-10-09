import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useMemo, useReducer } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage, PendingPermissionRequest } from '@/modules/chat-core';

/** C-12.4: the chat screen as a whole — edit, fork here, the queued send, uploads, attachment-only sends. */
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const hoisted = vi.hoisted(() => ({
  messages: new Map<string, NormalizedMessage[]>(),
  listeners: new Set<() => void>(),
  realtime: null as null | { onSessionProcessing: (id: string) => void; onSessionIdle: (id: string) => void; setPendingPermissionRequests: (fn: (prev: PendingPermissionRequest[]) => PendingPermissionRequest[]) => void },
  sendMessage: null as unknown as ReturnType<typeof vi.fn>,
}));
const store = {
  set(id: string, list: NormalizedMessage[]) { hoisted.messages.set(id, list); for (const l of hoisted.listeners) l(); },
};
const api = {
  sessionDetails: vi.fn((id: string) => json({ data: { sessionId: id, provider: 'claude', summary: '로그인 버그', project: { projectId: 'p1', fullPath: '/w/alpha', displayName: 'alpha' } } })),
  providers: {
    capabilities: vi.fn(() => json({ success: true, data: { providers: [{ provider: 'claude', permissionModes: ['default', 'plan'], defaultPermissionMode: 'default', supportsMessageEditing: true, supportsSessionForking: true }] } })),
    createSession: vi.fn(),
    skills: vi.fn(() => json({ data: { skills: [] } })),
    sessionTokenUsage: vi.fn((_id: string) => json({ success: true, data: { used: 170_000, total: 200_000 } })),
  },
  scheduledMessages: {
    list: vi.fn((_id?: string) => json({ success: true, data: [{ id: 'm1', sessionId: 's1', content: '배포 확인', options: {}, scheduledFor: '2026-10-05T00:00:00.000Z', status: 'pending', failureReason: null, createdAt: '' }] })),
    create: vi.fn((_body: unknown) => json({ success: true, data: {} }, 201)),
    cancel: vi.fn((_id: string) => json({ success: true })),
  },
  voice: { health: vi.fn(() => json({ configured: false })) },
  commands: {
    list: vi.fn(() => json({ builtIn: [{ name: '/help', description: '도움말' }], custom: [] })),
    execute: vi.fn((_body: unknown) => json({ type: 'builtin', action: 'help', data: { content: '# 명령\n/help 도움말' } })),
  },
  forkSession: vi.fn((_id: string, _body?: unknown) => json({ success: true, data: { sessionId: 's9' } }, 201)),
  assets: { uploadFiles: vi.fn((_form: FormData) => json({ attachments: [{ path: '/assets/1-shot.png', name: 'shot.png', mimeType: 'image/png', size: 3 }] })), image: vi.fn(() => json({}, 404)) },
};

vi.mock('@/modules/chat-core', async () => {
  const permissions = await vi.importActual<typeof import('@/modules/chat/utils/chatPermissions')>('@/modules/chat/utils/chatPermissions');
  hoisted.sendMessage = vi.fn();
  return {
    api,
    parseToolPayload: (value: unknown) => value,
    buildClaudeToolPermissionEntry: permissions.buildClaudeToolPermissionEntry,
    // no Settings default in these tests: the engine's own default decides
    readDefaultPermissionMode: () => null,
    grantClaudeToolPermission: vi.fn(),
    readUserPreference: (_key: string, fallback: unknown) => fallback,
    writeUserPreference: vi.fn(),
    subscribeToUserPreferences: () => () => undefined,
    voicePlayer: { unlock: vi.fn(), toggle: vi.fn() },
    useWebSocket: () => ({ ws: {}, sendMessage: hoisted.sendMessage, subscribe: () => () => undefined, isConnected: true }),
    useChatRealtimeHandlers: (args: NonNullable<typeof hoisted.realtime>) => { hoisted.realtime = args; },
    useSessionStore: () => {
      const [, tick] = useReducer((n: number) => n + 1, 0);
      useEffect(() => { hoisted.listeners.add(tick); return () => { hoisted.listeners.delete(tick); }; }, []);
      return useMemo(() => ({
        setActiveSession: () => undefined, fetchFromServer: async () => undefined, refreshLatestFromServer: async () => undefined, fetchMore: async () => undefined,
        getMessages: (id: string) => hoisted.messages.get(id) ?? [],
        getSessionSlot: () => ({ status: 'idle', hasMore: false }),
        appendRealtime: (id: string, message: NormalizedMessage) => { hoisted.messages.set(id, [...(hoisted.messages.get(id) ?? []), message]); for (const l of hoisted.listeners) l(); },
      }), []);
    },
  };
});
vi.mock('@/modules/aidev-router', () => ({
  AgentCreateCard: () => null,
  aidevApi: { notifySeen: () => Promise.resolve() },
  routingStore: { patch: vi.fn() },
  shouldAskClarify: () => false,
  useAidevRouting: () => ({ beforeSend: vi.fn(async () => null), reportOutcome: vi.fn(async () => undefined) }),
  useAgentCreation: () => ({ pending: null, onRunComplete: vi.fn(), approve: vi.fn(), runSelfCheck: vi.fn(), dismiss: vi.fn() }),
  useEscalation: () => ({ escalation: null, takeHandoff: () => null, label: '', busy: false, error: null, run: vi.fn(), dismiss: vi.fn() }),
  usePrejudge: () => undefined,
  // no verification card in these tests
  useRoutingState: () => ({ verification: null }),
  VerificationCard: () => null,
  // not a handoff session in these tests: nothing to return to
  useReturnFromHandoff: () => ({ engine: null, label: null, limitedUntil: null, busy: false, error: null, returnNow: async () => undefined, dismiss: () => undefined }),
  ReturnCard: () => null,
}));
vi.mock('@/modules/remote-preview', () => ({ usePreviewList: () => ({ previews: [] }) }));
vi.mock('@/modules/remote-debug', () => ({ useDebugSessions: () => ({ sessions: [] }) }));
vi.mock('@m/components/RouterChip', () => ({ RouterChip: () => null }));
vi.mock('@m/components/SessionResults', () => ({ SessionResults: () => null }));
vi.mock('@m/components/FilePeek', () => ({ FilePeek: () => null }));
vi.mock('@m/components/DiffPeek', () => ({ DiffPeek: () => null }));

const { ChatScreen } = await import('@m/screens/ChatScreen');

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}</div>; }
const open = (id = 's1') => {
  window.history.replaceState(null, '', `/session/${id}`);
  return render(<BrowserRouter><Where /><Routes><Route path="/session/:sessionId" element={<ChatScreen />} /><Route path="*" element={null} /></Routes></BrowserRouter>);
};
const settle = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const sent = () => hoisted.sendMessage.mock.calls.map(([frame]) => frame as Record<string, unknown>).filter((frame) => frame.type === 'chat.send' || frame.type === 'chat.edit-send');
const type = (text: string) => fireEvent.change(screen.getByPlaceholderText('명령을 입력하세요'), { target: { value: text } });
const hold = async (element: Element) => { fireEvent.pointerDown(element, { pointerType: 'touch', clientX: 1, clientY: 1 }); await settle(520); };
const userTurn = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ id: 'u1', sessionId: 's1', timestamp: '2026-10-04T00:00:00Z', provider: 'claude', kind: 'text', role: 'user', content: '로그인 고쳐줘', transcriptAnchorId: 'anc-1', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  hoisted.messages.clear();
  // jsdom has no object URLs
  let made = 0;
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:${(made += 1)}`), revokeObjectURL: vi.fn() });
});

describe('chat screen', () => {
  it('a send typed while the agent answers waits, and goes when the answer ends, with the conversation mode', async () => {
    open();
    await settle();
    act(() => hoisted.realtime!.onSessionProcessing('s1'));
    type('테스트도 돌려');
    fireEvent.click(screen.getByLabelText('대기열에 넣기'));
    expect(screen.getByTestId('chat-queued').textContent).toContain('테스트도 돌려');
    expect(sent()).toHaveLength(0);
    act(() => hoisted.realtime!.onSessionIdle('s1'));
    await settle();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ type: 'chat.send', sessionId: 's1', content: '테스트도 돌려', options: { permissionMode: 'default', toolsSettings: { allowedTools: [] } } });
    expect(screen.queryByTestId('chat-queued')).toBeNull();
  });

  it('the queued send waits while a permission request is open', async () => {
    open();
    await settle();
    act(() => hoisted.realtime!.onSessionProcessing('s1'));
    type('다음');
    fireEvent.click(screen.getByLabelText('대기열에 넣기'));
    act(() => hoisted.realtime!.setPendingPermissionRequests(() => [{ requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } }]));
    act(() => hoisted.realtime!.onSessionIdle('s1'));
    await settle();
    expect(sent()).toHaveLength(0);
    fireEvent.click(screen.getByText('허용'));
    await settle();
    expect(sent()).toHaveLength(1);
  });

  it('edits a sent message: the composer takes it, and the send replaces it from its anchor', async () => {
    store.set('s1', [userTurn()]);
    open();
    await settle();
    await hold(screen.getByText('로그인 고쳐줘'));
    fireEvent.click(screen.getByText('수정 후 다시 보내기'));
    await settle();
    expect(screen.getByTestId('editing-bar')).toBeTruthy();
    expect((screen.getByPlaceholderText('명령을 입력하세요') as HTMLTextAreaElement).value).toBe('로그인 고쳐줘');
    type('로그인 버튼 고쳐줘');
    fireEvent.click(screen.getByLabelText('보내기'));
    await settle();
    expect(sent()[0]).toMatchObject({ type: 'chat.edit-send', anchorId: 'anc-1', content: '로그인 버튼 고쳐줘' });
    expect(hoisted.messages.get('s1')?.at(-1)?.replacesAnchorId).toBe('anc-1');
    expect(screen.queryByTestId('editing-bar')).toBeNull();
  });

  it('forks the conversation up to a message and opens the new one', async () => {
    store.set('s1', [userTurn()]);
    open();
    await settle();
    await hold(screen.getByText('로그인 고쳐줘'));
    fireEvent.click(screen.getByText('여기서 분기'));
    await settle();
    expect(api.forkSession).toHaveBeenCalledWith('s1', { upToAnchorId: 'anc-1' });
    expect(screen.getByTestId('where').textContent).toBe('/session/s9');
  });

  it('an upload that fails puts the text and the files back, with the server message', async () => {
    api.assets.uploadFiles.mockImplementationOnce(() => json({ error: '디스크가 가득 찼습니다' }, 500));
    open();
    await settle();
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    type('이 화면 봐');
    fireEvent.click(screen.getByLabelText('보내기'));
    await settle();
    expect(screen.getByText('디스크가 가득 찼습니다')).toBeTruthy();
    expect((screen.getByPlaceholderText('명령을 입력하세요') as HTMLTextAreaElement).value).toBe('이 화면 봐');
    expect(screen.getByTestId('composer-files')).toBeTruthy();
    expect(sent()).toHaveLength(0);
  });

  it('attachments alone can go; the preview is let go once the server copy replaces the echo', async () => {
    open();
    await settle();
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByLabelText('보내기'));
    await settle();
    expect(sent()[0]).toMatchObject({ type: 'chat.send', content: '', options: { sessionSummary: '첨부 1개 (shot.png)', attachments: [{ path: '/assets/1-shot.png' }] } });
    const echo = hoisted.messages.get('s1')?.at(-1);
    const preview = echo?.images?.[0]?.data;
    expect(preview).toMatch(/^blob:/);
    expect(echo?.images?.[0]?.path).toBe('/assets/1-shot.png');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(preview);
    // the attachments-only bubble can be held (fork here)
    await hold(screen.getByAltText('shot.png'));
    expect(screen.getByTestId('message-actions')).toBeTruthy();
    expect(screen.queryByText('복사')).toBeNull();
    act(() => store.set('s1', [userTurn({ id: 'server-1', content: '', images: [{ path: '/assets/1-shot.png', name: 'shot.png' }] })]));
    await settle();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(preview);
  });

  it('shows the context use in the conversation sheet and warns above the composer past 80%', async () => {
    open();
    await settle();
    expect(screen.getByTestId('context-warning').textContent).toContain('85%');
    fireEvent.click(screen.getByLabelText('대화 메뉴'));
    await settle();
    expect(screen.getByTestId('token-usage').textContent).toContain('170,000 / 200,000 (85%)');
    expect(screen.getByTestId('conversation-actions').textContent).toContain('예약된 메시지1');
  });

  it('the send button held down schedules the text with the send options; the list cancels one', async () => {
    open();
    await settle();
    type('배포 결과 알려줘');
    await hold(screen.getByLabelText('보내기'));
    expect(screen.getByTestId('schedule-create').textContent).toContain('배포 결과 알려줘');
    fireEvent.click(screen.getByText('1시간 뒤'));
    fireEvent.click(screen.getByText(/에 보내기$/));
    await settle();
    const body = api.scheduledMessages.create.mock.calls[0]?.[0] as { sessionId: string; content: string; scheduledFor: string; options: Record<string, unknown> };
    expect(body).toMatchObject({ sessionId: 's1', content: '배포 결과 알려줘', options: { permissionMode: 'default', skipPermissions: false } });
    expect(new Date(body.scheduledFor).getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect((screen.getByPlaceholderText('명령을 입력하세요') as HTMLTextAreaElement).value).toBe('');
    expect(sent()).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('대화 메뉴'));
    await settle();
    fireEvent.click(screen.getByText('예약된 메시지'));
    await settle();
    fireEvent.click(screen.getByLabelText('예약 취소'));
    await settle();
    expect(api.scheduledMessages.cancel).toHaveBeenCalledWith('m1');
  });

  it('a `/` command runs from the menu and its result shows in a sheet', async () => {
    open();
    await settle();
    type('/');
    await settle();
    fireEvent.click(screen.getByText('/help'));
    await settle();
    expect(api.commands.execute).toHaveBeenCalledWith({ commandName: '/help', commandPath: undefined, args: [], context: expect.objectContaining({ projectId: 'p1', projectPath: '/w/alpha', sessionId: 's1', provider: 'claude' }) });
    expect(screen.getByTestId('command-result').textContent).toContain('/help 도움말');
    expect((screen.getByPlaceholderText('명령을 입력하세요') as HTMLTextAreaElement).value).toBe('');
    expect(sent()).toHaveLength(0);
  });
});
