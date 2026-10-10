import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The workbench's add-project modal: the same folder / Git-clone flow as the mobile app's add-project sheet. */
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const api = {
  // the projects home: paths print as ~/… and the folder browser starts here
  system: { workspacesRoot: vi.fn(() => json({ success: true, data: { root: '/w' } })) },
  browseFilesystem: vi.fn((path: string | null) => json({ path: path ?? '/w', suggestions: path === '/w/new' ? [] : [{ name: 'alpha', path: '/w/alpha' }, { name: 'new', path: '/w/new' }, { name: '.git', path: '/w/.git' }] })),
  createFolder: vi.fn((body: string) => json({ success: true, path: body })),
  createProject: vi.fn((_body: unknown) => json({ success: true, project: { projectId: 'p3', displayName: 'new', fullPath: '/w/new', isArchived: false } })),
  restoreProject: vi.fn((_id: string) => json({ success: true })),
  settings: { createCredential: vi.fn((_body: unknown) => json({ success: true })) },
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
};
vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');
  return { ...actual, api };
});

const { ProjectCreationWizard } = await import('@/modules/project-creation-wizard');
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ProjectCreationWizard', () => {
  it('adds a folder picked from the projects home, printing paths as ~/…', async () => {
    const onProjectCreated = vi.fn();
    const onClose = vi.fn();
    render(<ProjectCreationWizard onClose={onClose} onProjectCreated={onProjectCreated} />);
    await settle();
    expect(api.browseFilesystem).toHaveBeenCalledWith(null);
    expect((screen.getByLabelText('경로') as HTMLInputElement).value).toBe('~');
    expect(screen.getByTestId('folder-list').textContent).not.toContain('.git');
    fireEvent.click(screen.getByText('new'));
    await settle();
    expect((screen.getByLabelText('경로') as HTMLInputElement).value).toBe('~/new');
    fireEvent.change(screen.getByLabelText('표시 이름'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await settle();
    expect(api.createProject).toHaveBeenCalledWith({ path: '/w/new', customName: 'New' });
    expect(onProjectCreated).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p3' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a typed ~/x is expanded against the projects home; a path removed earlier is restored', async () => {
    api.createProject.mockImplementationOnce(() => json({ success: true, project: { projectId: 'p4', displayName: 'old', fullPath: '/w/old', isArchived: true } }));
    render(<ProjectCreationWizard onClose={vi.fn()} />);
    await settle();
    fireEvent.change(screen.getByLabelText('경로'), { target: { value: '~/old' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await settle();
    expect(api.createProject).toHaveBeenCalledWith({ path: '/w/old' });
    expect(api.restoreProject).toHaveBeenCalledWith('p4');
  });

  it('clones a repository picked from the connected GitHub account into a chosen folder', async () => {
    class FakeSource { static last: FakeSource | null = null; onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null; constructor(public url: string) { FakeSource.last = this; } close() {} }
    vi.stubGlobal('EventSource', FakeSource);
    const onProjectCreated = vi.fn();
    render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={onProjectCreated} />);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Git 복제' }));
    await settle();
    expect(screen.getByTestId('repo-picker').textContent).toContain('@jazzlife');
    fireEvent.change(screen.getByLabelText('저장소 찾기'), { target: { value: 'secret' } });
    expect(screen.getByTestId('repo-list').textContent).not.toContain('jazzlife/aidev');
    fireEvent.click(screen.getByText('jazzlife/secret-app'));
    await settle();
    expect(screen.getByTestId('clone-source').textContent).toContain('jazzlife/secret-app');
    expect(screen.getByTestId('clone-target').textContent).toBe('→ ~/secret-app');
    fireEvent.click(screen.getByText('new'));
    await settle();
    expect(screen.getByTestId('clone-target').textContent).toBe('→ ~/new/secret-app');
    fireEvent.click(screen.getByRole('button', { name: '복제하고 추가' }));
    expect(api.cloneProjectProgressUrl).toHaveBeenCalledWith({ path: '/w/new', githubUrl: 'https://github.com/jazzlife/secret-app.git', githubTokenId: 7, newGithubToken: null });
    act(() => FakeSource.last!.onmessage!({ data: JSON.stringify({ type: 'progress', message: 'Receiving objects' }) }));
    expect(screen.getByRole('status').textContent).toBe('Receiving objects');
    act(() => FakeSource.last!.onmessage!({ data: JSON.stringify({ type: 'complete', project: { projectId: 'p9', fullPath: '/w/new/secret-app' } }) }));
    await settle();
    expect(onProjectCreated).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p9' }));
  });

  it('without a connected account: "GitHub로 로그인" comes back to this page\'s clone tab; a token still works', async () => {
    api.githubRepos.mockImplementationOnce(() => json({ success: false, error: { code: 'GITHUB_NOT_CONNECTED', message: '연결된 GitHub 계정이 없습니다' } }, 404));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, search: '', pathname: '/session/abc' });
    render(<ProjectCreationWizard onClose={vi.fn()} initialTab="clone" />);
    await settle();
    fireEvent.click(screen.getByText('GitHub로 로그인'));
    expect(assign).toHaveBeenCalledWith('/api/aidev/github/oauth/start?return=%2Fsession%2Fabc%3Fadd%3Dclone');
    fireEvent.click(screen.getByText('토큰으로 연결'));
    fireEvent.change(screen.getByLabelText('GitHub 토큰'), { target: { value: 'ghp_test' } });
    fireEvent.click(screen.getByRole('button', { name: '토큰으로 연결' }));
    await settle();
    expect(api.settings.createCredential).toHaveBeenCalledWith({ credentialName: 'GitHub', credentialType: 'github_token', credentialValue: 'ghp_test', description: 'NadoVibe에서 연결' });
    expect(screen.getByTestId('repo-list').textContent).toContain('jazzlife/aidev');
  });

  it('opened back from GitHub on the clone tab with the outcome on top', async () => {
    render(<ProjectCreationWizard onClose={vi.fn()} initialTab="clone" notice={{ text: 'GitHub 계정이 연결되었습니다 (@jazzlife)', error: false }} />);
    await settle();
    expect(screen.getByTestId('add-project').textContent).toContain('GitHub 계정이 연결되었습니다 (@jazzlife)');
    expect(screen.getByRole('tab', { name: 'Git 복제' }).getAttribute('aria-selected')).toBe('true');
  });

  it('before an administrator sets up GitHub login, an administrator gets the setup', async () => {
    api.githubRepos.mockImplementationOnce(() => json({ success: false, error: { code: 'GITHUB_NOT_CONNECTED', message: '' } }, 404));
    api.githubOauth.config.mockImplementationOnce(() => json({ configured: false, callbackUrl: 'https://dev.nado.work/_gateway/github/callback', homepageUrl: 'https://dev.nado.work', admin: true, clientId: null }));
    render(<ProjectCreationWizard onClose={vi.fn()} initialTab="clone" />);
    await settle();
    expect(screen.getByTestId('github-oauth-setup').textContent).toContain('https://dev.nado.work/_gateway/github/callback');
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'Ov23liAbCdEf12345678' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 's'.repeat(40) } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await settle();
    expect(api.githubOauth.save).toHaveBeenCalledWith({ clientId: 'Ov23liAbCdEf12345678', clientSecret: 's'.repeat(40) });
  });
});
