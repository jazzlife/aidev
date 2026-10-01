import { useState } from 'react';
import { HelpCircle } from 'lucide-react';

type ClarifyPromptProps = {
  /** the command being held back */
  text: string;
  /** the question worded for this command (route `scope.clarify_question`); without one a generic ask is shown */
  question?: string | null;
  /** sends the command with the user's answer appended */
  onAnswer: (answer: string) => void;
  /** sends the command as it is */
  onProceed: () => void;
};

/**
 * Used by ChatScreen (C-05, §3.1): when the router judges that essential information is missing from a deeper
 * command (clarify > 0.7, depth ≥ 2), the send waits here for one line of detail — or goes ahead unchanged.
 */
export function ClarifyPrompt({ text, question, onAnswer, onProceed }: ClarifyPromptProps) {
  // the one-line answer being typed
  const [answer, setAnswer] = useState('');
  const trimmed = answer.trim();
  return (
    <div className="mx-3 mb-2 rounded-xl border border-accent/40 bg-surface p-3" data-testid="clarify-prompt">
      <div className="flex items-start gap-2 text-[13px]">
        <HelpCircle size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="font-medium">{question || '조금 더 알려주시면 정확히 실행합니다'}</div>
          {question ? null : <div className="text-[12px] text-muted">어떤 파일·프로젝트·PC인지, 무엇이 되면 완료인지 한 줄만 덧붙여 주세요.</div>}
          <div className="mt-1 line-clamp-2 text-[12px] text-muted">“{text}”</div>
        </div>
      </div>
      <textarea autoFocus rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={question ? '답을 한 줄로' : '예: frontend 폴더의 로그인 화면, 버튼을 누르면 홈으로 이동'}
        className="mt-2 w-full resize-none rounded-lg border border-line bg-elevated px-3 py-2 text-[16px] leading-6 outline-none placeholder:text-muted" />
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onProceed} className="h-10 flex-1 rounded-xl border border-line text-[14px]">그대로 진행</button>
        <button type="button" disabled={!trimmed} onClick={() => onAnswer(trimmed)} className="h-10 flex-1 rounded-xl bg-accent text-[14px] font-medium text-accent-ink disabled:opacity-40">덧붙여 보내기</button>
      </div>
    </div>
  );
}
