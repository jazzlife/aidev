import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** C-12.8: the project's changes, commit and push from the phone. */
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const git = {
  status: vi.fn((_id: string) => json({ branch: 'main', hasCommits: true, modified: ['src/login.ts'], added: [], deleted: ['old.txt'], untracked: ['notes.md'], staged: [] })),
  remoteStatus: vi.fn((_id: string) => json({ hasRemote: true, hasUpstream: true, branch: 'main', ahead: 2, behind: 0 })),
  diff: vi.fn((_id: string, _file: string) => json({ diff: '@@ -1,3 +1,3 @@\n import a\n-const x = 1;\n+const x = 2;\n end\n' })),
  generateCommitMessage: vi.fn((_id: string, _files: string[], _provider: string) => json({ message: 'fix(login): x is 2\n' })),
  commit: vi.fn((_id: string, _message: string, _files: string[]) => json({ success: true })),
  push: vi.fn((_id: string) => json({ error: 'Push rejected', details: 'The remote has newer commits. Pull first to merge changes before pushing.' }, 500)),
  pull: vi.fn(), fetch: vi.fn(() => json({ success: true })),
  discard: vi.fn((_id: string, _file: string) => json({ success: true })),
  deleteUntracked: vi.fn((_id: string, _file: string) => json({ success: true })),
  init: vi.fn(() => json({ success: true })),
};
vi.mock('@/modules/chat-core', () => ({ api: { git }, calculateDiff: (a: string, b: string) => {
  const before = a.split('\n'); const after = b.split('\n');
  return [...before.filter((l) => !after.includes(l)).map((content) => ({ type: 'removed', content })), ...after.filter((l) => !before.includes(l)).map((content) => ({ type: 'added', content }))];
}, summarizeDiff: (lines: Array<{ type: string }>) => ({ added: lines.filter((l) => l.type === 'added').length, removed: lines.filter((l) => l.type === 'removed').length }) }));

const { GitSheet } = await import('@m/components/GitSheet');
const { fileEditFromUnifiedDiff } = await import('@m/lib/peek');

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const project = { projectId: 'p1', displayName: 'alpha' };
beforeEach(() => { vi.clearAllMocks(); });

describe('unified diff for the diff peek', () => {
  it('one hunk per @@ block, old side = context and −, new side = context and +', () => {
    const edit = fileEditFromUnifiedDiff('a.ts', '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n@@ -9 +9,2 @@\n x\n+y\n\\ No newline at end of file\n');
    expect(edit.hunks).toEqual([{ before: 'keep\nold', after: 'keep\nnew' }, { before: 'x', after: 'x\ny' }]);
  });
});

describe('git sheet', () => {
  it('shows the branch, ahead/behind and the changed files; a tap shows the diff', async () => {
    render(<GitSheet open onClose={vi.fn()} project={project} provider="codex" />);
    await settle();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByTestId('git-ahead-behind').textContent).toBe('↑2 ↓0');
    expect(screen.getByTestId('git-files').textContent).toContain('src/login.ts');
    expect(screen.getByTestId('git-files').textContent).toContain('새 파일notes.md');
    fireEvent.click(screen.getByText('src/login.ts'));
    await settle();
    expect(git.diff).toHaveBeenCalledWith('p1', 'src/login.ts');
    expect(screen.getByTestId('diff-peek').textContent).toContain('const x = 2;');
  });

  it('commits the checked files with a generated message', async () => {
    render(<GitSheet open onClose={vi.fn()} project={project} provider="codex" />);
    await settle();
    fireEvent.click(screen.getByLabelText('notes.md 커밋에 넣기'));
    fireEvent.click(screen.getByLabelText('커밋 메시지 만들기'));
    await settle();
    // a Codex chat asks Claude (the route takes claude or cursor)
    expect(git.generateCommitMessage).toHaveBeenCalledWith('p1', ['src/login.ts', 'old.txt'], 'claude');
    expect((screen.getByLabelText('커밋 메시지') as HTMLTextAreaElement).value).toBe('fix(login): x is 2');
    fireEvent.click(screen.getByText('커밋 (2개 파일)'));
    await settle();
    expect(git.commit).toHaveBeenCalledWith('p1', 'fix(login): x is 2', ['src/login.ts', 'old.txt']);
    expect(screen.getByRole('status').textContent).toBe('커밋했습니다');
  });

  it("a failed push shows the server's words", async () => {
    render(<GitSheet open onClose={vi.fn()} project={project} provider="claude" />);
    await settle();
    fireEvent.click(screen.getByText(/푸시/));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('The remote has newer commits. Pull first to merge changes before pushing.');
  });

  it('throwing changes away asks first; a new file is deleted, a changed one discarded', async () => {
    render(<GitSheet open onClose={vi.fn()} project={project} provider="claude" />);
    await settle();
    fireEvent.click(screen.getByLabelText('notes.md 변경 버리기'));
    expect(git.deleteUntracked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('파일 지우기'));
    await settle();
    expect(git.deleteUntracked).toHaveBeenCalledWith('p1', 'notes.md');
    fireEvent.click(screen.getByLabelText('src/login.ts 변경 버리기'));
    fireEvent.click(screen.getByText('변경 버리기'));
    await settle();
    expect(git.discard).toHaveBeenCalledWith('p1', 'src/login.ts');
  });

  it('a folder without git offers git init', async () => {
    git.status.mockImplementationOnce(() => json({ error: 'Not a git repository', details: 'Not a git repository', notGitRepository: true }));
    render(<GitSheet open onClose={vi.fn()} project={project} provider="claude" />);
    await settle();
    fireEvent.click(screen.getByText('git init'));
    await settle();
    expect(git.init).toHaveBeenCalledWith('p1');
  });
});
