import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** C-12.6: `/` commands, `@` files and dictation in the composer. */
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const prefs = vi.hoisted(() => ({ uiPreferences: { voiceEnabled: true } as Record<string, unknown> }));
const api = {
  commands: { list: vi.fn((_path?: string) => json({ builtIn: [{ name: '/help', description: '도움말' }, { name: '/cost', description: '사용량' }], custom: [{ name: '/deploy', description: '배포', path: '/w/.claude/commands/deploy.md' }] })) },
  providers: { skills: vi.fn(() => json({ data: { skills: [{ command: '/review', description: '리뷰', sourcePath: 'a' }, { command: '/review', description: '중복' }] } })) },
  getFiles: vi.fn(() => json([{ name: 'src', type: 'directory', children: [{ name: 'login.ts', type: 'file' }, { name: 'app.tsx', type: 'file' }] }, { name: 'README.md', type: 'file' }])),
  voice: { health: vi.fn(() => json({ configured: true })) },
};
vi.mock('@/modules/chat-core', () => ({
  api,
  readUserPreference: (key: string, fallback: unknown) => (prefs as Record<string, unknown>)[key] ?? fallback,
  writeUserPreference: vi.fn(),
  subscribeToUserPreferences: () => () => undefined,
}));
const transcribe = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/shared/api')>()), transcribeVoice: transcribe }));

const assist = await import('@m/lib/composerAssist');
const { ComposerAssist } = await import('@m/components/ComposerAssist');
const { MicButton } = await import('@m/components/MicButton');

const settle = (ms = 20) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const project = { projectId: 'p1', fullPath: '/w/alpha' };
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); prefs.uiPreferences = { voiceEnabled: true }; });

describe('what the text asks for', () => {
  it('a command only at the start, a file after @ (start or after a space)', () => {
    expect(assist.assistQuery('/he', 3)).toEqual({ kind: 'command', query: 'he', start: 0 });
    expect(assist.assistQuery('/help me', 8)).toBeNull();
    expect(assist.assistQuery('fix @src/lo', 11)).toEqual({ kind: 'file', query: 'src/lo', start: 4 });
    expect(assist.assistQuery('mail@host', 9)).toBeNull();
  });

  it('files: the tree flattened, fuzzy matched with name hits first', () => {
    const files = assist.flattenFileTree([{ name: 'src', type: 'directory', children: [{ name: 'login.ts', type: 'file' }, { name: 'list.ts', type: 'file' }] }, { name: 'lib', type: 'directory', children: [] }]);
    expect(files.map((f) => f.path)).toEqual(['src/login.ts', 'src/list.ts']);
    expect(assist.matchFiles(files, 'lgn').map((f) => f.path)).toEqual(['src/login.ts']);
    // equal hits: the shorter path first
    expect(assist.matchFiles(files, 'src').map((f) => f.path)).toEqual(['src/list.ts', 'src/login.ts']);
    expect(assist.matchFiles(files, 'li').map((f) => f.path)).toEqual(['src/list.ts', 'src/login.ts']);
  });

  it('commands: name prefix first, most used first (the workbench history key)', () => {
    const commands = [{ name: '/cost', type: 'built-in' as const }, { name: '/compact', type: 'built-in' as const }, { name: '/deploy', description: 'cost check', type: 'custom' as const }];
    assist.trackCommandUse('p1', '/compact');
    expect(JSON.parse(localStorage.getItem('command_history_p1') ?? '{}')).toEqual({ '/compact': 1 });
    // a description hit comes after the name prefixes
    expect(assist.filterCommands(commands, 'co', assist.readCommandHistory('p1')).map((c) => c.name)).toEqual(['/compact', '/cost', '/deploy']);
    expect(assist.filterCommands(commands, 'cost', {}).map((c) => c.name)).toEqual(['/cost', '/deploy']);
  });
});

describe('the suggestion list', () => {
  it('lists built-ins, skills (once) and project commands; a skill is inserted, a command runs', async () => {
    const onInsert = vi.fn(); const onCommand = vi.fn();
    render(<ComposerAssist draft="/" cursor={1} project={project} provider="claude" onInsert={onInsert} onCommand={onCommand} />);
    await settle();
    expect(api.commands.list).toHaveBeenCalledWith('/w/alpha');
    const menu = screen.getByTestId('command-menu');
    expect(menu.textContent).toContain('/help');
    expect(menu.textContent).toContain('/deploy');
    expect(screen.getAllByText('/review')).toHaveLength(1);
    fireEvent.click(screen.getByText('/review'));
    expect(onInsert).toHaveBeenCalledWith('/review ');
    fireEvent.click(screen.getByText('/help'));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: '/help', type: 'built-in' }));
  });

  it('puts @path in place of what was typed after @', async () => {
    const onInsert = vi.fn();
    render(<ComposerAssist draft="고쳐줘 @log 지금" cursor={8} project={project} provider="claude" onInsert={onInsert} onCommand={vi.fn()} />);
    await settle();
    expect(screen.getByTestId('file-menu').textContent).toContain('src/login.ts');
    fireEvent.click(screen.getByText('login.ts'));
    expect(onInsert).toHaveBeenCalledWith('고쳐줘 @src/login.ts  지금');
  });
});

describe('dictation', () => {
  it('is hidden while voice is off', async () => {
    prefs.uiPreferences = { voiceEnabled: false };
    render(<MicButton onText={vi.fn()} onError={vi.fn()} />);
    await settle();
    expect(screen.queryByLabelText('음성 입력')).toBeNull();
  });

  it('records on a tap, stops on the next, and hands over the words', async () => {
    const stop = vi.fn();
    Object.assign(navigator, { mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [{ stop }] })) } });
    class FakeRecorder {
      static isTypeSupported = () => true;
      state = 'inactive'; mimeType = 'audio/webm';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)]) }); void this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    transcribe.mockImplementation(() => json({ text: '로그인 버튼 고쳐줘' }));
    const onText = vi.fn();
    render(<MicButton onText={onText} onError={vi.fn()} />);
    await settle();
    fireEvent.click(screen.getByLabelText('음성 입력'));
    await settle();
    expect(screen.getByLabelText('녹음 멈추기')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('녹음 멈추기'));
    await settle();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob), 'recording.webm');
    expect(onText).toHaveBeenCalledWith('로그인 버튼 고쳐줘');
    expect(stop).toHaveBeenCalled();
    expect(screen.getByLabelText('음성 입력')).toBeTruthy();
  });
});
