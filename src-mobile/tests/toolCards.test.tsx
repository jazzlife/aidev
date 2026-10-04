import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/modules/chat-core';

vi.mock('@/modules/chat-core', () => ({ parseToolPayload: (value: unknown) => (typeof value === 'string' ? JSON.parse(value) as unknown : value), api: {} }));
const { MessageBubble } = await import('@m/components/MessageBubble');
const { TodoProgress, latestTodos, resultText } = await import('@m/components/ToolCards');

/** C-12.7: tool calls with their own cards. */
const tool = (toolName: string, toolInput: unknown, over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ id: `t-${toolName}`, sessionId: 's', timestamp: '', provider: 'claude', kind: 'tool_use', toolName, toolInput, ...over });
const todos = [
  { content: '로그인 폼 찾기', status: 'completed', activeForm: '로그인 폼 찾는 중' },
  { content: '버튼 고치기', status: 'in_progress', activeForm: '버튼 고치는 중' },
  { content: '테스트', status: 'pending' },
];

describe('tool cards', () => {
  it('a checklist names the step in flight and how far along', () => {
    render(<MessageBubble message={tool('TodoWrite', { todos })} />);
    expect(screen.getByTestId('todo-card').textContent).toContain('버튼 고치는 중 — 1/3');
    expect(screen.getByTestId('todo-list').querySelectorAll('li')).toHaveLength(3);
  });

  it('a subagent: "서브에이전트 / type: description", its tools and its answer as text', () => {
    const message = tool('Task', { subagent_type: 'explorer', description: '로그인 코드 찾기', prompt: '...' }, {
      subagent: { id: 'a', status: 'completed' }, subagentTools: [{ kind: 'tool', toolName: 'Grep', toolInput: { pattern: 'login' } }],
    });
    const result = { id: 'r', sessionId: 's', timestamp: '', provider: 'claude' as const, kind: 'tool_result' as const, toolId: 't', toolResult: { content: JSON.stringify([{ type: 'text', text: '**src/login.ts**에 있습니다' }]), isError: false } };
    render(<MessageBubble message={message} result={result} />);
    const card = screen.getByTestId('subagent-card');
    expect(card.textContent).toContain('서브에이전트 / explorer: 로그인 코드 찾기');
    fireEvent.click(screen.getByText(/서브에이전트/));
    expect(screen.getByTestId('subagent-activity').textContent).toContain('Grep login');
    expect(card.textContent).toContain('src/login.ts에 있습니다');
  });

  it('a plan shows its text; a question shows the answer chosen', () => {
    render(<>
      <MessageBubble message={tool('ExitPlanMode', { plan: '1. 폼 고치기\\n2. 테스트' })} />
      <MessageBubble message={tool('AskUserQuestion', { questions: [{ question: '어느 DB?', header: '저장소', options: [] }], answers: { '어느 DB?': 'SQLite' } })} />
    </>);
    expect(screen.getByTestId('plan-card').textContent).toContain('폼 고치기');
    expect(screen.getByTestId('question-card').textContent).toContain('저장소 — SQLite');
  });

  it('other tools keep the generic card', () => {
    render(<MessageBubble message={tool('Bash', { command: 'npm test' })} />);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.queryByTestId('todo-card')).toBeNull();
  });

  it('agent results in block arrays read as text', () => {
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\n\nb');
    expect(resultText('plain')).toBe('plain');
  });
});

describe('checklist progress above the composer', () => {
  it("is the conversation's latest checklist, one line until tapped, gone when all is done", () => {
    const messages = [tool('TodoWrite', { todos: [{ content: 'old', status: 'pending' }] }, { id: 'a' }), tool('TodoWrite', { todos }, { id: 'b' })];
    const { rerender } = render(<TodoProgress todos={latestTodos(messages)} />);
    expect(screen.getByTestId('todo-progress').textContent).toContain('버튼 고치는 중 — 1/3');
    expect(screen.queryByTestId('todo-list')).toBeNull();
    fireEvent.click(screen.getByText(/버튼 고치는 중/));
    expect(screen.getByTestId('todo-list')).toBeTruthy();
    rerender(<TodoProgress todos={todos.map((t) => ({ ...t, status: 'completed' }))} />);
    expect(screen.queryByTestId('todo-progress')).toBeNull();
  });
});
