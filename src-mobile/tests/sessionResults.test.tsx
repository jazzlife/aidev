import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/** F-12: the chat's remote runs stay folded into one line until the user opens them, so the conversation stays readable. */
const run = (id: number, cmd: string, exit: number | null) => ({
  id, target_id: 4, target_name: 'm4pro', kind: 'exec', cmd, cwd: null, approved_by: 'auto',
  started_at: Date.now() - 2000, finished_at: exit === null ? null : Date.now(), exit_code: exit, artifacts: null,
});
vi.mock('@/modules/aidev-router', () => ({
  aidevApi: {
    sessionRemoteRuns: () => Promise.resolve({ runs: [run(3, 'npm test', 1), run(2, 'npm run build', 0), run(1, 'ls', 0)] }),
    remoteRun: (id: number) => Promise.resolve({ run: run(id, 'npm test', 1) }),
    remoteRunLog: () => Promise.resolve('ok\n'),
  },
}));
vi.mock('@m/lib/nav', () => ({ useGo: () => () => undefined }));

const { SessionResults } = await import('@m/components/SessionResults');

describe('SessionResults', () => {
  it('shows one summary line with the latest run and opens the cards on tap', async () => {
    render(<SessionResults sessionId="s1" refreshKey={0} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const summary = screen.getByRole('button', { expanded: false });
    expect(summary.textContent).toContain('원격 실행 3건');
    expect(summary.textContent).toContain('npm test');
    expect(summary.textContent).toContain('실패 · 1');
    expect(screen.queryByTestId('remote-run-card')).toBeNull();
    fireEvent.click(summary);
    expect(screen.getAllByTestId('remote-run-card')).toHaveLength(3);
  });
});
