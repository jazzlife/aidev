import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ClarifyPrompt } from '@m/components/ClarifyPrompt';
import { DiffPeek } from '@m/components/DiffPeek';

describe('ClarifyPrompt', () => {
  it('sends the trimmed answer only once something is typed', () => {
    const onAnswer = vi.fn();
    render(<ClarifyPrompt text="로그인 고쳐줘" onAnswer={onAnswer} onProceed={() => undefined} />);
    const send = screen.getByRole('button', { name: '덧붙여 보내기' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  web/login.tsx, 버튼이 안 눌림 ' } });
    fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledWith('web/login.tsx, 버튼이 안 눌림');
  });

  it('asks the question worded for the command, or a generic ask without one', () => {
    const { unmount } = render(<ClarifyPrompt text="x" question="어느 화면의 버튼인가요?" onAnswer={() => undefined} onProceed={() => undefined} />);
    expect(screen.getByText('어느 화면의 버튼인가요?')).toBeTruthy();
    unmount();
    render(<ClarifyPrompt text="x" question={null} onAnswer={() => undefined} onProceed={() => undefined} />);
    expect(screen.getByText('조금 더 알려주시면 정확히 실행합니다')).toBeTruthy();
  });

  it('lets the command go as it is', () => {
    const onProceed = vi.fn();
    render(<ClarifyPrompt text="x" onAnswer={() => undefined} onProceed={onProceed} />);
    fireEvent.click(screen.getByRole('button', { name: '그대로 진행' }));
    expect(onProceed).toHaveBeenCalledOnce();
  });
});

describe('DiffPeek', () => {
  it('draws removed and added lines with counts and opens the file', () => {
    const onOpenFile = vi.fn();
    render(<DiffPeek edit={{ path: '/p/src/a.ts', hunks: [{ before: 'const a = 1;\nkeep();\n', after: 'const a = 2;\nkeep();\n' }], created: false, deleted: false }} onClose={() => undefined} onOpenFile={onOpenFile} />);
    const peek = screen.getByTestId('diff-peek');
    expect(peek.textContent).toContain('const a = 1;');
    expect(peek.textContent).toContain('const a = 2;');
    expect(peek.textContent).not.toContain('keep();');
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /파일 보기/ }));
    expect(onOpenFile).toHaveBeenCalledWith('/p/src/a.ts');
  });

  it('says so when a change carries no text (Codex summary-only change)', () => {
    render(<DiffPeek edit={{ path: '/p/a.ts', hunks: [{ before: '', after: '' }], created: false, deleted: false }} onClose={() => undefined} onOpenFile={() => undefined} />);
    expect(screen.getByText('기록된 변경 내용이 없습니다')).toBeTruthy();
  });

  it('renders nothing without an edit', () => {
    const { container } = render(<DiffPeek edit={null} onClose={() => undefined} onOpenFile={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });
});
