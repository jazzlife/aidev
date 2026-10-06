import { act, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The mobile screens added 2026-10-02: projects (list → project → its conversations) and PC pairing. */
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const api = {
  projects: vi.fn(() => json([
    { projectId: 'p1', displayName: 'alpha', fullPath: '/w/alpha', isStarred: false, sessions: [{ lastActivity: '2026-10-01T00:00:00Z' }], sessionMeta: { total: 3 } },
    { projectId: 'p2', displayName: 'beta', fullPath: '/w/beta', isStarred: true, sessions: [], sessionMeta: { total: 0 } },
  ])),
  projectSessions: vi.fn(() => json({ sessions: [{ id: 's1', provider: 'claude', summary: '로그인 버그', lastActivity: '2026-10-01T00:00:00Z' }], sessionMeta: { hasMore: false } })),
  runningSessions: vi.fn(() => json({ data: { sessions: [{ sessionId: 's1' }, { sessionId: 's9' }] } })),
  browseFilesystem: vi.fn((path: string | null) => json({ path: path ?? '/w', suggestions: path === '/w/new' ? [] : [{ name: 'alpha', path: '/w/alpha' }, { name: 'new', path: '/w/new' }] })),
  createFolder: vi.fn(),
  createProject: vi.fn((_body: unknown) => json({ success: true, project: { projectId: 'p3', displayName: 'new', fullPath: '/w/new', isArchived: false } })),
  restoreProject: vi.fn(() => json({ success: true })),
  settings: { credentials: vi.fn(() => json({ credentials: [] })), createCredential: vi.fn((_body: unknown) => json({ success: true })) },
  githubOauth: {
    config: vi.fn(() => json({ configured: true, callbackUrl: 'https://dev.nado.work/_gateway/github/callback', homepageUrl: 'https://dev.nado.work', admin: false })),
    save: vi.fn((_body: unknown) => json({ configured: true })),
    startUrl: (returnTo: string) => `/api/aidev/github/oauth/start?return=${encodeURIComponent(returnTo)}`,
  },
  githubRepos: vi.fn((_params?: unknown) => json({ success: true, data: { account: { login: 'jazzlife' }, tokenId: 7, tokens: [{ id: 7, name: 'GitHub' }], page: 1, hasMore: false, repos: [
    { fullName: 'jazzlife/aidev', name: 'aidev', private: false, description: 'NadoVibe', cloneUrl: 'https://github.com/jazzlife/aidev.git', pushedAt: '2026-10-04T00:00:00Z', archived: false, fork: false },
    { fullName: 'jazzlife/secret-app', name: 'secret-app', private: true, description: null, cloneUrl: 'https://github.com/jazzlife/secret-app.git', pushedAt: null, archived: false, fork: false },
  ] } })),
  cloneProjectProgressUrl: vi.fn((params: Record<string, unknown>) => `/clone?${new URLSearchParams(params as Record<string, string>).toString()}`),
  targets: {
    list: vi.fn(() => json({ targets: [{ id: 7, name: 'my-pc', description: '', platform: null, online: false, paired: false, last_seen: null, pairing_code: 'AB12CD', pairing_expires: Date.now() + 9 * 60_000, capabilities: null }] })),
    runnerDownloads: vi.fn(() => json({ files: [{ name: 'aidev-runner-0.13.1-win-x64.exe', version: '0.13.1', platform: 'win-x64', size: 1, sha256: null }] })),
    create: vi.fn(), refreshPairing: vi.fn(), remove: vi.fn(),
  },
};
vi.mock('@/modules/chat-core', async () => {
  const shared = await vi.importActual<typeof import('@/shared/api')>('@/shared/api');
  return { api, readApiJson: shared.readApiJson, useAuth: () => ({ user: { username: 'jazzlife' } }) };
});
const uiQueue = vi.hoisted(() => ({ commands: [] as unknown[] }));
vi.mock('@/modules/aidev-router', async () => {
  const { useEffect } = await import('react');
  return {
    aidevApi: {
      targets: () => Promise.resolve({ targets: [{ id: 4, name: 'm4pro', online: true }, { id: 5, name: 'old-pc', online: false }] }),
      remoteRuns: () => Promise.resolve({ runs: [] }),
    },
    // the gateway queue, delivered once (the real hook long-polls it)
    useUiCommands: (onShow: (c: unknown) => void) => { useEffect(() => { for (const c of uiQueue.commands.splice(0)) onShow(c); }); },
  };
});

const { ProjectsScreen } = await import('@m/screens/ProjectsScreen');
const { ProjectScreen } = await import('@m/screens/ProjectScreen');
const { TargetsScreen } = await import('@m/screens/TargetsScreen');
const { DrawerProvider } = await import('@m/components/AppDrawer');
const { BackController } = await import('@m/lib/nav');
const { HomeTabs } = await import('@m/components/HomeTabs');
const { reloadCurrentForTests } = await import('@m/lib/current');
const { UiCommandBridge } = await import('@m/components/UiCommandBridge');
vi.mock('@m/components/FilePeek', () => ({ FilePeek: () => null }));

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}</div>; }
const at = (path: string) => {
  window.history.replaceState(null, '', path);
  return render(
    <BrowserRouter>
      <BackController />
      <DrawerProvider>
      <Where />
      <UiCommandBridge />
      <Routes>
        <Route path="/projects" element={<ProjectsScreen />} />
        <Route path="/projects/:projectId" element={<ProjectScreen />} />
        <Route path="/pcs" element={<TargetsScreen />} />
        <Route path="*" element={null} />
      </Routes>
      </DrawerProvider>
    </BrowserRouter>,
  );
};
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); reloadCurrentForTests(); });

describe('mobile projects', () => {
  it('lists projects, starred first, and opens one', async () => {
    at('/projects');
    await settle();
    const names = screen.getAllByText(/^(alpha|beta)$/).map((n) => n.textContent);
    expect(names).toEqual(['beta', 'alpha']);
    expect(screen.getByText(/대화 3개/)).toBeTruthy();
    fireEvent.click(screen.getByText('alpha'));
    expect(screen.getByTestId('where').textContent).toBe('/projects/p1');
  });

  it('a project shows its conversations; one opens its chat; + starts a new chat in it', async () => {
    at('/projects/p1');
    await settle();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(api.projectSessions).toHaveBeenCalledWith('p1', { limit: 30, offset: 0 });
    fireEvent.click(screen.getByText('로그인 버그'));
    expect(screen.getByTestId('where').textContent).toBe('/session/s1');
  });
});

describe('mobile PC pairing', () => {
  it('shows the code and the lines for the chosen OS, Windows first', async () => {
    at('/pcs');
    await settle();
    expect(screen.getByText('AB12CD')).toBeTruthy();
    const card = screen.getByTestId('pairing-card');
    expect(card.textContent).toContain('PowerShell');
    expect(card.textContent).toContain('aidev-runner-0.13.1-win-x64.exe');
    expect(card.textContent).toContain('pair AB12CD');
    fireEvent.click(screen.getByText('macOS'));
    expect(screen.getByTestId('pairing-card').textContent).toContain('~/.aidev/bin/aidev-runner pair AB12CD');
  });
});

describe('mobile common menu (drawer)', () => {
  it('shows the current work — the project and the running conversation — and the remote tools, no lists', async () => {
    localStorage.setItem('m.project', JSON.stringify({ projectId: 'p2', displayName: 'beta', fullPath: '/w/beta' }));
    localStorage.setItem('m.conversation', JSON.stringify({ sessionId: 's1', title: '로그인 버그', projectId: 'p1', projectName: 'alpha' }));
    reloadCurrentForTests();
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('메뉴'));
    await settle();
    const current = screen.getByTestId('drawer-current');
    expect(current.textContent).toContain('beta');
    expect(current.textContent).toContain('진행 중인 대화');
    expect(current.textContent).toContain('응답 중');
    // a conversation of another project names its project
    expect(current.textContent).toContain('alpha');
    expect(current.textContent).toContain('다른 대화 1개 실행 중');
    const drawer = screen.getByTestId('app-drawer');
    // fixed entries only: no list of PCs, projects or conversations
    expect(drawer.textContent).toContain('원격 제어');
    expect(drawer.textContent).not.toContain('m4pro');
    expect(drawer.textContent).not.toContain('모든 프로젝트');
    expect(drawer.textContent).not.toContain('새 대화');
    fireEvent.click(screen.getByText('로그인 버그'));
    await settle();
    expect(screen.getByTestId('where').textContent).toBe('/session/s1');
    expect(screen.queryByTestId('app-drawer')).toBeNull();
  });

  it('without a current project it says where to pick one; the project card opens the project', async () => {
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('메뉴'));
    await settle();
    expect(screen.getByTestId('drawer-current').textContent).toContain('선택된 프로젝트가 없습니다');
    fireEvent.click(screen.getByLabelText('메뉴 닫기'));
    // opening a project makes it the current one
    fireEvent.click(screen.getByText('alpha'));
    await settle();
    fireEvent.click(screen.getByLabelText('메뉴'));
    await settle();
    expect(screen.getByTestId('drawer-current').textContent).toContain('/w/alpha');
    fireEvent.click(screen.getByText('원격 제어'));
    expect(screen.getByTestId('where').textContent).toBe('/screen');
  });

  it('the back button closes the drawer before anything else', async () => {
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('메뉴'));
    await settle();
    expect(screen.getByTestId('app-drawer')).toBeTruthy();
    await act(async () => { window.history.back(); await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('app-drawer')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/projects');
  });
});

describe('home tabs', () => {
  it('reads "프로젝트 · 대화"', () => {
    render(<BrowserRouter><HomeTabs active="conversations" /></BrowserRouter>);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['프로젝트', '대화']);
  });
});

describe('adding a project', () => {
  it('adds the folder chosen in the browser, makes it current and opens it', async () => {
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('프로젝트 추가'));
    await settle();
    expect(api.browseFilesystem).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByText('new'));
    await settle();
    expect((screen.getByLabelText('경로') as HTMLInputElement).value).toBe('/w/new');
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await settle();
    expect(api.createProject).toHaveBeenCalledWith({ path: '/w/new' });
    expect(screen.getByTestId('where').textContent).toBe('/projects/p3');
    expect(JSON.parse(localStorage.getItem('m.project') ?? '{}').projectId).toBe('p3');
  });

  it("shows the server's message when the project already exists, and restores an archived path", async () => {
    api.createProject.mockImplementationOnce(() => json({ success: false, error: { code: 'PROJECT_EXISTS', message: '이미 있는 프로젝트입니다' } }, 409));
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('프로젝트 추가'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('이미 있는 프로젝트입니다');
    expect(screen.getByTestId('where').textContent).toBe('/projects');
    api.createProject.mockImplementationOnce(() => json({ success: true, project: { projectId: 'p4', displayName: 'old', fullPath: '/w', isArchived: true } }));
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await settle();
    expect(api.restoreProject).toHaveBeenCalledWith('p4');
    expect(screen.getByTestId('where').textContent).toBe('/projects/p4');
  });

  it("clones a repository picked from the connected GitHub account into a chosen folder", async () => {
    const { repoFolderName } = await import('@m/components/AddProjectSheet');
    expect(repoFolderName('https://github.com/a/b.git/')).toBe('b');
    expect(repoFolderName('git@github.com:a/c.git')).toBe('c');
    class FakeSource { static last: FakeSource | null = null; onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null; constructor(public url: string) { FakeSource.last = this; } close() {} }
    vi.stubGlobal('EventSource', FakeSource);
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('프로젝트 추가'));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Git 복제' }));
    await settle();
    expect(screen.getByTestId('repo-picker').textContent).toContain('@jazzlife');
    fireEvent.change(screen.getByLabelText('저장소 찾기'), { target: { value: 'secret' } });
    expect(screen.getByTestId('repo-list').textContent).not.toContain('jazzlife/aidev');
    fireEvent.click(screen.getByText('jazzlife/secret-app'));
    await settle();
    expect(screen.getByTestId('clone-source').textContent).toContain('jazzlife/secret-app');
    expect(screen.getByTestId('clone-target').textContent).toBe('→ /w/secret-app');
    fireEvent.click(screen.getByText('new'));
    await settle();
    expect(screen.getByTestId('clone-target').textContent).toBe('→ /w/new/secret-app');
    fireEvent.click(screen.getByRole('button', { name: '복제하고 추가' }));
    expect(api.cloneProjectProgressUrl).toHaveBeenCalledWith({ path: '/w/new', githubUrl: 'https://github.com/jazzlife/secret-app.git', githubTokenId: 7, newGithubToken: null });
    act(() => FakeSource.last!.onmessage!({ data: JSON.stringify({ type: 'complete', project: { projectId: 'p9', displayName: 'secret-app', fullPath: '/w/new/secret-app' } }) }));
    await settle();
    expect(screen.getByTestId('where').textContent).toBe('/projects/p9');
  });

  it('a runtime that does not know the repositories API yet (HTML back) says so instead of a vague failure', async () => {
    api.githubRepos.mockImplementationOnce(() => Promise.resolve(new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('프로젝트 추가'));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Git 복제' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('서버가 아직 이 기능을 모릅니다');
  });

  it('without a connected account: "GitHub로 로그인" goes to GitHub and comes back to the clone tab; a token still works', async () => {
    api.githubRepos.mockImplementationOnce(() => json({ success: false, error: { code: 'GITHUB_NOT_CONNECTED', message: '연결된 GitHub 계정이 없습니다' } }, 404));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, search: '', pathname: '/projects' });
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('프로젝트 추가'));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Git 복제' }));
    await settle();
    fireEvent.click(screen.getByText('GitHub로 로그인'));
    expect(assign).toHaveBeenCalledWith('/api/aidev/github/oauth/start?return=%2Fm%2Fprojects%3Fadd%3Dclone');
    vi.unstubAllGlobals();
    fireEvent.click(screen.getByText('토큰으로 연결'));
    fireEvent.change(screen.getByLabelText('GitHub 토큰'), { target: { value: 'ghp_test' } });
    fireEvent.click(screen.getByRole('button', { name: '토큰으로 연결' }));
    await settle();
    expect(api.settings.createCredential).toHaveBeenCalledWith({ credentialName: 'GitHub', credentialType: 'github_token', credentialValue: 'ghp_test', description: 'NadoVibe에서 연결' });
    expect(screen.getByTestId('repo-list').textContent).toContain('jazzlife/aidev');
  });

  it('back from GitHub, the clone tab opens with the outcome and the address is cleaned', async () => {
    at('/projects?add=clone&github=connected&account=jazzlife');
    await settle();
    expect(screen.getByTestId('add-project').textContent).toContain('GitHub 계정이 연결되었습니다 (@jazzlife)');
    expect(screen.getByRole('tab', { name: 'Git 복제' }).getAttribute('aria-selected')).toBe('true');
    expect(window.location.search).toBe('');
  });

  it('before an administrator sets up GitHub login, an administrator gets the setup', async () => {
    api.githubRepos.mockImplementationOnce(() => json({ success: false, error: { code: 'GITHUB_NOT_CONNECTED', message: '' } }, 404));
    api.githubOauth.config.mockImplementationOnce(() => json({ configured: false, callbackUrl: 'https://dev.nado.work/_gateway/github/callback', homepageUrl: 'https://dev.nado.work', admin: true, clientId: null }));
    at('/projects');
    await settle();
    fireEvent.click(screen.getByLabelText('프로젝트 추가'));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Git 복제' }));
    await settle();
    expect(screen.getByTestId('github-oauth-setup').textContent).toContain('https://dev.nado.work/_gateway/github/callback');
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'Ov23liAbCdEf12345678' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 's'.repeat(40) } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await settle();
    expect(api.githubOauth.save).toHaveBeenCalledWith({ clientId: 'Ov23liAbCdEf12345678', clientSecret: 's'.repeat(40) });
  });

});

describe('agent shows the user something (app control)', () => {
  it("opens the PC's whole screen with the agent's note, and back returns to where the user was", async () => {
    uiQueue.commands.push({ id: 1, at: 0, by: 'agent', action: 'show', view: 'screen', params: { target: 4, window: 'full' }, note: '로그인 창을 확인해 주세요' });
    at('/projects');
    await settle();
    expect(window.location.pathname + window.location.search).toBe('/screen/4?w=full');
    expect(screen.getByTestId('agent-ui-note').textContent).toContain('로그인 창을 확인해 주세요');
  });

  it('opens a project by name', async () => {
    uiQueue.commands.push({ id: 2, at: 0, by: 'agent', action: 'show', view: 'project', params: { project: 'beta' }, note: null });
    at('/');
    await settle();
    expect(screen.getByTestId('where').textContent).toBe('/projects/p2');
  });
});
