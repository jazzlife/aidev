import { act, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The mobile screens added 2026-10-02: projects (list → project → its conversations) and PC pairing. */
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const api = {
  projects: vi.fn(() => json([
    { projectId: 'p1', displayName: 'alpha', fullPath: '/w/alpha', isStarred: false, sessions: [{ lastActivity: '2026-10-01T00:00:00Z' }], sessionMeta: { total: 3 } },
    { projectId: 'p2', displayName: 'beta', fullPath: '/w/beta', isStarred: true, sessions: [], sessionMeta: { total: 0 } },
  ])),
  projectSessions: vi.fn(() => json({ sessions: [{ id: 's1', provider: 'claude', summary: '로그인 버그', lastActivity: '2026-10-01T00:00:00Z' }], sessionMeta: { hasMore: false } })),
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
vi.mock('@/modules/aidev-router', () => ({
  aidevApi: {
    targets: () => Promise.resolve({ targets: [{ id: 4, name: 'm4pro', online: true }, { id: 5, name: 'old-pc', online: false }] }),
    remoteRuns: () => Promise.resolve({ runs: [] }),
  },
}));

const { ProjectsScreen } = await import('@m/screens/ProjectsScreen');
const { ProjectScreen } = await import('@m/screens/ProjectScreen');
const { TargetsScreen } = await import('@m/screens/TargetsScreen');
const { DrawerProvider } = await import('@m/components/AppDrawer');
const { BackController } = await import('@m/lib/nav');
vi.mock('@m/components/FilePeek', () => ({ FilePeek: () => null }));

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}</div>; }
const at = (path: string) => {
  window.history.replaceState(null, '', path);
  return render(
    <BrowserRouter>
      <BackController />
      <DrawerProvider>
      <Where />
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

beforeEach(() => { vi.clearAllMocks(); });

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
  it('opens from ☰ on any screen and switches project or opens a remote tool directly', async () => {
    at('/projects/p1');
    await settle();
    fireEvent.click(screen.getByLabelText('메뉴'));
    await settle();
    const drawer = screen.getByTestId('app-drawer');
    expect(drawer.textContent).toContain('m4pro 화면·제어');
    expect(drawer.textContent).not.toContain('old-pc 화면');   // offline PCs have no screen entry
    fireEvent.click(screen.getAllByText('beta').at(-1)!);
    await settle();
    expect(screen.getByTestId('where').textContent).toBe('/projects/p2');
    expect(screen.queryByTestId('app-drawer')).toBeNull();
    fireEvent.click(screen.getByLabelText('메뉴'));
    await settle();
    fireEvent.click(screen.getByText('원격 실행'));
    expect(screen.getByTestId('where').textContent).toBe('/runs');
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
