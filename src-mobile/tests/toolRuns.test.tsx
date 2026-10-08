import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/modules/chat-core';
import { describeToolRun, groupToolRuns, isToolRun } from '@m/lib/toolRuns';
import { summarizeToolInput } from '@m/lib/format';

vi.mock('@/modules/chat-core', async () => {
  const actual = await vi.importActual<typeof import('@/modules/chat/utils/messageTransforms')>('@/modules/chat/utils/messageTransforms');
  return { api: {}, parseToolPayload: actual.parseToolPayload };
});

const { MessageList } = await import('@m/components/MessageList');

let seq = 0;
const base = () => ({ id: `m${seq += 1}`, sessionId: 's', timestamp: '', provider: 'claude' as const });
const tool = (toolName: string, toolInput: unknown): NormalizedMessage => ({ ...base(), kind: 'tool_use', toolName, toolInput, toolId: `t${seq}` });
const result = (of: NormalizedMessage, isError = false): NormalizedMessage => ({ ...base(), kind: 'tool_result', toolId: of.toolId, toolResult: { content: 'ok', isError } });
const text = (content: string, role: 'user' | 'assistant' = 'assistant'): NormalizedMessage => ({ ...base(), kind: 'text', role, content });

/**
 * The phone's transcript used to be a wall of Bash / PowerShell / Read cards (2026-10-09): stretches of
 * tool calls fold into one row, shell rows never print the command, and file paths read relative to the
 * project.
 */
describe('tool runs', () => {
  it('folds two or more worker tools, with reasoning and one-line captions inside, and keeps prose apart', () => {
    const rows = groupToolRuns([
      text('먼저 설정을 봅니다.'),
      tool('Bash', { command: 'ls', description: '폴더 목록' }),
      { ...base(), kind: 'thinking', content: '…' },
      text('이제 파일을 읽습니다.'),
      tool('Read', { file_path: '/p/a.ts' }),
      tool('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }),
      text('설정 파일을 고쳤습니다. 테스트가 통과했으니 다음 단계로 넘어갑니다.'),
      tool('Bash', { command: 'npm test' }),
    ]);
    expect(rows.map((row) => (isToolRun(row) ? `run:${row.toolCount}` : row.kind))).toEqual(['text', 'run:3', 'text', 'tool_use']);
    const run = rows[1];
    expect(isToolRun(run) && run.messages.length).toBe(5);
    expect(isToolRun(run) && describeToolRun(run)).toBe('Bash · Read · Edit');
  });

  it('a user-facing card (checklist, question) is never folded and ends the run', () => {
    const rows = groupToolRuns([tool('Bash', { command: 'a' }), tool('TodoWrite', { todos: [] }), tool('Bash', { command: 'b' }), tool('Bash', { command: 'c' })]);
    expect(rows.map((row) => (isToolRun(row) ? `run:${row.toolCount}` : row.toolName))).toEqual(['Bash', 'TodoWrite', 'run:2']);
  });

  it('a shell row shows the description, never the command; a file row shows the project-relative path', () => {
    expect(summarizeToolInput({ command: 'rm -rf build && npm ci', description: '빌드 폴더 정리' }, 'Bash')).toBe('빌드 폴더 정리');
    expect(summarizeToolInput({ command: 'Get-Content log.txt' }, 'PowerShell')).toBe('명령 실행');
    expect(summarizeToolInput({ file_path: '/w/alpha/src/app.ts' }, 'Read', '/w/alpha')).toBe('src/app.ts');
    expect(summarizeToolInput({ file_path: '/elsewhere/x.ts' }, 'Read', '/w/alpha')).toBe('/elsewhere/x.ts');
  });

  it('the list renders a run as one collapsed row that expands to the cards', () => {
    const a = tool('Bash', { command: 'ls', description: '폴더 목록' });
    const b = tool('Read', { file_path: '/w/alpha/src/app.ts' });
    render(<MessageList messages={[text('시작'), a, result(a), b, result(b), text('끝났습니다. 모두 정상입니다.')]} loading={false} projectPath="/w/alpha" />);
    const run = screen.getByTestId('tool-run');
    expect(run.getAttribute('data-count')).toBe('2');
    expect(run.textContent).toContain('작업 2단계');
    expect(run.textContent).toContain('Bash · Read');
    expect(run.textContent).not.toContain('ls');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('폴더 목록')).toBeTruthy();
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.queryByText('/w/alpha/src/app.ts')).toBeNull();
  });
});
