import { act, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** C-12.3: the conversation, project and message sheets, and the conversation search. */
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const caps = vi.hoisted(() => ({ forking: true }));
const api = {
  recentConversations: vi.fn(() => json({ data: { conversations: [
    { sessionId: 's1', provider: 'claude', projectDisplayName: 'alpha', sessionTitle: '로그인 버그', lastActivity: null },
    { sessionId: 's2', provider: 'codex', projectDisplayName: 'beta', sessionTitle: '결제', lastActivity: null },
  ] } })),
  getArchivedSessions: vi.fn(() => json({ data: { sessions: [] } })),
  renameSession: vi.fn((_id: string, _summary: string) => json({ success: true })),
  forkSession: vi.fn((_id: string) => json({ success: true, data: { sessionId: 's9' } }, 201)),
  deleteSession: vi.fn((_id: string, _hard?: boolean) => json({ success: true })),
  restoreSession: vi.fn(() => json({ success: true })),
  projects: vi.fn(() => json([
    { projectId: 'p1', displayName: 'alpha', fullPath: '/w/alpha', isStarred: false, sessions: [] },
    { projectId: 'p2', displayName: 'beta', fullPath: '/w/beta', isStarred: false, sessions: [] },
  ])),
  toggleProjectStar: vi.fn(() => json({ success: true, isStarred: true })),
  renameProject: vi.fn(() => json({ success: true })),
  deleteProject: vi.fn((_id: string, _hard?: boolean) => json({ success: true })),
  searchConversationsUrl: vi.fn((q: string) => `/search?q=${q}`),
  providers: { capabilities: vi.fn(() => json({ success: true, data: { providers: [
    { provider: 'claude', permissionModes: ['default'], defaultPermissionMode: 'default', supportsSessionForking: caps.forking, supportsMessageEditing: true },
    { provider: 'codex', permissionModes: ['default'], defaultPermissionMode: 'default', supportsSessionForking: false },
  ] } })) },
};
vi.mock('@/modules/chat-core', () => ({ api, readUserPreference: (_k: string, fallback: unknown) => fallback, voicePlayer: { unlock: vi.fn(), toggle: vi.fn() } }));
vi.mock('@/modules/aidev-router', () => ({
  aidevApi: { notifyUnread: () => Promise.resolve({ sessions: [] }) },
  useCreateProposals: () => ({ proposals: [], accept: vi.fn(), dismiss: vi.fn() }),
}));

/** The search stream, driven by the test. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, data: unknown) { for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
vi.stubGlobal('EventSource', FakeEventSource);

const { SessionsScreen } = await import('@m/screens/SessionsScreen');
const { ProjectsScreen } = await import('@m/screens/ProjectsScreen');
const { reloadCurrentForTests, readCurrentConversation, readCurrentProject } = await import('@m/lib/current');

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}</div>; }
const at = (path: string) => {
  window.history.replaceState(null, '', path);
  return render(<BrowserRouter><Where /><Routes><Route path="/" element={<SessionsScreen />} /><Route path="/projects" element={<ProjectsScreen />} /><Route path="*" element={null} /></Routes></BrowserRouter>);
};
const settle = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const menuOf = (title: string) => screen.getAllByLabelText('대화 메뉴')[title === '로그인 버그' ? 0 : 1]!;

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); caps.forking = true; reloadCurrentForTests(); });

describe('conversation sheet', () => {
  it('renames, and the drawer shows the new name when it is the current conversation', async () => {
    localStorage.setItem('m.conversation', JSON.stringify({ sessionId: 's1', title: '로그인 버그', projectId: 'p1', projectName: 'alpha' }));
    reloadCurrentForTests();
    at('/');
    await settle();
    fireEvent.click(menuOf('로그인 버그'));
    await settle();
    fireEvent.click(screen.getByText('이름 변경'));
    fireEvent.change(screen.getByLabelText('대화 이름'), { target: { value: '로그인 버튼 버그' } });
    fireEvent.click(screen.getByText('저장'));
    await settle();
    expect(api.renameSession).toHaveBeenCalledWith('s1', '로그인 버튼 버그');
    expect(screen.getByText('로그인 버튼 버그')).toBeTruthy();
    expect(readCurrentConversation()?.title).toBe('로그인 버튼 버그');
  });

  it('forks into a new conversation and opens it; delete asks first', async () => {
    at('/');
    await settle();
    fireEvent.click(menuOf('로그인 버그'));
    await settle();
    fireEvent.click(screen.getByText('분기'));
    await settle();
    expect(api.forkSession).toHaveBeenCalledWith('s1');
    expect(screen.getByTestId('where').textContent).toBe('/session/s9');
  });

  it('delete for good only after a confirmation, and the drawer forgets it', async () => {
    localStorage.setItem('m.conversation', JSON.stringify({ sessionId: 's1', title: '로그인 버그', projectId: 'p1', projectName: 'alpha' }));
    reloadCurrentForTests();
    at('/');
    await settle();
    fireEvent.click(menuOf('로그인 버그'));
    await settle();
    fireEvent.click(screen.getByText('삭제'));
    expect(api.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('영구 삭제'));
    await settle();
    expect(api.deleteSession).toHaveBeenCalledWith('s1', true);
    expect(screen.queryByText('로그인 버그')).toBeNull();
    expect(readCurrentConversation()).toBeNull();
  });

  it('no fork for an engine that cannot', async () => {
    at('/');
    await settle();
    fireEvent.click(menuOf('결제'));
    await settle();
    expect(screen.getByTestId('conversation-actions').textContent).not.toContain('분기');
    expect(screen.getByTestId('conversation-actions').textContent).toContain('숨기기');
  });
});

describe('project sheet', () => {
  it('stars a project (it moves first) and archives one, which stops being the current project', async () => {
    localStorage.setItem('m.project', JSON.stringify({ projectId: 'p2', displayName: 'beta', fullPath: '/w/beta' }));
    reloadCurrentForTests();
    at('/projects');
    await settle();
    fireEvent.click(screen.getAllByLabelText('프로젝트 메뉴')[1]!);
    await settle();
    fireEvent.click(screen.getByText('즐겨찾기'));
    await settle();
    expect(api.toggleProjectStar).toHaveBeenCalledWith('p2');
    expect(screen.getAllByText(/^(alpha|beta)$/).map((n) => n.textContent)).toEqual(['beta', 'alpha']);
    fireEvent.click(screen.getAllByLabelText('프로젝트 메뉴')[0]!);
    await settle();
    fireEvent.click(screen.getByText('제거'));
    expect(screen.getByTestId('project-actions').textContent).toContain('폴더와 파일은 그대로 둡니다');
    fireEvent.click(screen.getByText('목록에서 제거'));
    await settle();
    expect(api.deleteProject).toHaveBeenCalledWith('p2', false);
    expect(screen.queryByText('beta')).toBeNull();
    expect(readCurrentProject()).toBeNull();
  });

  it('removing with the history asks once more', async () => {
    at('/projects');
    await settle();
    fireEvent.click(screen.getAllByLabelText('프로젝트 메뉴')[0]!);
    await settle();
    fireEvent.click(screen.getByText('제거'));
    fireEvent.click(screen.getAllByText('대화 기록까지 삭제')[0]!);
    expect(api.deleteProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '대화 기록까지 삭제' }));
    await settle();
    expect(api.deleteProject).toHaveBeenCalledWith('p1', true);
  });
});

describe('conversation search', () => {
  it('searches titles and content, titles first, each conversation once, and opens one', async () => {
    at('/');
    await settle();
    fireEvent.click(screen.getByLabelText('대화 검색'));
    // the search's code loads on the first tap: wait for it rather than a fixed time (a loaded CI box is slower)
    fireEvent.change(await screen.findByLabelText('검색어', {}, { timeout: 5000 }), { target: { value: '로' } });
    await settle(350);
    expect(FakeEventSource.last).toBeNull();
    fireEvent.change(screen.getByLabelText('검색어'), { target: { value: '로그인' } });
    await settle(350);
    expect(api.searchConversationsUrl).toHaveBeenCalledWith('로그인', 50);
    const source = FakeEventSource.last!;
    act(() => {
      source.emit('result', { projectResult: { projectDisplayName: 'alpha', sessions: [
        { sessionId: 's1', sessionSummary: '로그인 버그', provider: 'claude', matches: [{ snippet: '로그인 버튼이 안 눌려요' }] },
        { sessionId: 's3', sessionSummary: '회원가입', provider: 'claude', matches: [{ snippet: '로그인 후 이동' }] },
      ] } });
      source.emit('title-results', { titleResults: [{ sessionId: 's1', provider: 'claude', projectDisplayName: 'alpha', sessionTitle: '로그인 버그' }] });
      source.emit('done', {});
    });
    const rows = screen.getByTestId('conversation-search').querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('로그인 버그');
    expect(rows[0]!.textContent).not.toContain('로그인 버튼이 안 눌려요');   // found by title: listed once, as a title hit
    expect(rows[1]!.textContent).toContain('회원가입');
    expect(rows[1]!.textContent).toContain('로그인 후 이동');
    expect(source.closed).toBe(true);
    fireEvent.click(screen.getByText('회원가입'));
    expect(screen.getByTestId('where').textContent).toBe('/session/s3');
  });
});

describe('message sheet', () => {
  it('copies; reads a reply aloud; offers edit and fork only when the chat allows them', async () => {
    const { MessageActions } = await import('@m/components/MessageActions');
    const chatCore = await import('@/modules/chat-core');
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const reply = { text: '고쳤습니다', message: { id: 'a1', sessionId: 's1', timestamp: '', provider: 'claude' as const, kind: 'text' as const, role: 'assistant' as const, content: '고쳤습니다' } };
    const onEdit = vi.fn(); const onFork = vi.fn();
    const { rerender } = render(<MessageActions target={reply} onClose={vi.fn()} canEdit={false} canFork={false} onEdit={onEdit} onFork={onFork} />);
    fireEvent.click(screen.getByText('복사'));
    await settle();
    expect(writeText).toHaveBeenCalledWith('고쳤습니다');
    fireEvent.click(screen.getByText('읽어 주기'));
    expect(chatCore.voicePlayer.toggle).toHaveBeenCalledWith('고쳤습니다');
    expect(screen.queryByText('수정 후 다시 보내기')).toBeNull();
    const sent = { text: '로그인 고쳐줘', message: { ...reply.message, id: 'u1', role: 'user' as const, transcriptAnchorId: 'anc-1' } };
    rerender(<MessageActions target={sent} onClose={vi.fn()} canEdit canFork onEdit={onEdit} onFork={onFork} />);
    expect(screen.queryByText('읽어 주기')).toBeNull();
    fireEvent.click(screen.getByText('수정 후 다시 보내기'));
    expect(onEdit).toHaveBeenCalledWith(sent);
    rerender(<MessageActions target={{ ...sent }} onClose={vi.fn()} canEdit canFork onEdit={onEdit} onFork={onFork} />);
    fireEvent.click(screen.getByText('여기서 분기'));
    expect(onFork).toHaveBeenCalled();
  });
});
