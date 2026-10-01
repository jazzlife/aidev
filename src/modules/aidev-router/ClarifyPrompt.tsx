import { useState } from 'react';
import { HelpCircle, X } from 'lucide-react';

type ClarifyPromptProps = {
  /** the question worded for this command (route `scope.clarify_question`); without one a generic ask is shown */
  question: string | null;
  /** sends the held command with the answer appended */
  onAnswer: (answer: string) => void;
  /** sends the held command unchanged */
  onProceed: () => void;
  /** drops the hold; the command stays in the composer */
  onDismiss: () => void;
};

/**
 * Used by ChatInterface (C-09, §3.1): a routed send the specialist judge says lacks essential detail waits here
 * for one line — or goes ahead as typed. The command itself stays in the composer.
 */
export function ClarifyPrompt({ question, onAnswer, onProceed, onDismiss }: ClarifyPromptProps) {
  // the one-line answer being typed
  const [answer, setAnswer] = useState('');
  const trimmed = answer.trim();
  return (
    <div className="border-t border-border bg-primary/5 px-4 py-2.5 text-[12px]" data-testid="clarify-prompt">
      <div className="flex items-start gap-2">
        <HelpCircle size={14} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{question || '조금 더 알려주시면 정확히 실행합니다'}</div>
          {question ? null : <div className="mt-0.5 text-muted-foreground">어떤 파일·프로젝트·PC인지, 무엇이 되면 완료인지 한 줄만 덧붙여 주세요.</div>}
        </div>
        <button type="button" aria-label="닫기" onClick={onDismiss} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"><X size={13} /></button>
      </div>
      <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (trimmed) onAnswer(trimmed); }}>
        <input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="답을 한 줄로"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 outline-none focus:border-primary" />
        <button type="submit" disabled={!trimmed} className="h-7 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50">덧붙여 보내기</button>
        <button type="button" onClick={onProceed} className="h-7 rounded-md border border-border px-3 hover:bg-accent">그대로 진행</button>
      </form>
    </div>
  );
}
