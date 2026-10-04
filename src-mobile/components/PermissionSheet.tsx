import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';

import { buildClaudeToolPermissionEntry, type PendingPermissionRequest, type Question } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { clampText } from '@m/lib/format';
import { Prose } from '@m/lib/markdown';

/** What goes back for one request (`chat.permission-response`), the workbench's shape. */
export type PermissionDecision = { allow: boolean; message?: string; updatedInput?: unknown; rememberEntry?: string | null };

type PermissionSheetProps = {
  request: PendingPermissionRequest | null;
  provider: string;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  /** Claude: allow now and from now on (`entry` is the saved rule, e.g. `Bash(npm:*)`) */
  onAlwaysAllow?: (request: PendingPermissionRequest, entry: string) => void;
  /** the sheet closed without an answer: the request stays pending (a banner reopens it) */
  onLater: () => void;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
};

/** AskUserQuestion: one question at a time — tap options (one or several), or type an answer; skip sends no answers. */
function QuestionForm({ request, onDecide }: { request: PendingPermissionRequest; onDecide: PermissionSheetProps['onDecide'] }) {
  const input = asRecord(request.input);
  const questions = (Array.isArray(input.questions) ? input.questions : []) as Question[];
  // which question is shown (one per step on a small screen)
  const [step, setStep] = useState(0);
  // the options picked per question, by label
  const [picked, setPicked] = useState<Array<Set<string>>>(() => questions.map(() => new Set()));
  // a typed answer per question (the "직접 입력" option)
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ''));
  const question = questions[step];
  if (!question) return null;
  const multi = Boolean(question.multiSelect);
  const toggle = (label: string) => setPicked((all) => all.map((set, index) => {
    if (index !== step) return set;
    const next = new Set(multi ? set : []);
    if (set.has(label)) next.delete(label); else next.add(label);
    return next;
  }));
  const answers = () => {
    const result: Record<string, string> = {};
    questions.forEach((q, index) => {
      const values = [...(picked[index] ?? [])];
      const own = typed[index]?.trim();
      if (own) values.push(own);
      if (values.length) result[q.question] = values.join(', ');
    });
    return result;
  };
  const hasAnswer = (picked[step]?.size ?? 0) > 0 || Boolean(typed[step]?.trim());
  const last = step === questions.length - 1;
  return (
    <div className="space-y-3" data-testid="question-form">
      {questions.length > 1 ? <div className="text-[12px] text-muted">질문 {step + 1}/{questions.length}{question.header ? ` · ${question.header}` : ''}</div> : question.header ? <div className="text-[12px] text-muted">{question.header}</div> : null}
      <div className="text-[15px] font-medium">{question.question}</div>
      {multi ? <div className="text-[12px] text-muted">여러 개 고를 수 있습니다</div> : null}
      <ul className="space-y-1.5">
        {question.options.map((option) => {
          const on = picked[step]?.has(option.label) ?? false;
          return (
            <li key={option.label}>
              <button type="button" aria-pressed={on} onClick={() => toggle(option.label)}
                className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-left ${on ? 'border-accent bg-accent/10' : 'border-line'}`}>
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${multi ? 'rounded' : 'rounded-full'} border ${on ? 'border-accent bg-accent text-accent-ink' : 'border-line'}`}>{on ? <Check size={11} /> : null}</span>
                <span className="min-w-0 flex-1"><span className="block text-[15px]">{option.label}</span>{option.description ? <span className="block text-[12px] text-muted">{option.description}</span> : null}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <input value={typed[step] ?? ''} onChange={(e) => { const value = e.target.value; setTyped((all) => all.map((text, index) => (index === step ? value : text))); if (!multi && value.trim()) setPicked((all) => all.map((set, index) => (index === step ? new Set() : set))); }}
        placeholder="직접 입력" aria-label="직접 입력" className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent" />
      <div className="flex gap-2">
        <button type="button" onClick={() => onDecide(request.requestId, { allow: true, updatedInput: { ...input, answers: {} } })} className="h-11 rounded-xl border border-line px-4 text-[15px] text-muted">건너뛰기</button>
        {step > 0 ? <button type="button" onClick={() => setStep(step - 1)} className="h-11 rounded-xl border border-line px-4 text-[15px]">이전</button> : null}
        <button type="button" disabled={!hasAnswer} onClick={() => { if (last) onDecide(request.requestId, { allow: true, updatedInput: { ...input, answers: answers() } }); else setStep(step + 1); }}
          className="h-11 flex-1 rounded-xl bg-accent text-[15px] font-semibold text-accent-ink disabled:opacity-40">{last ? '보내기' : '다음'}</button>
      </div>
    </div>
  );
}

/**
 * Used by ChatScreen: what the agent waits on, as a sheet — a question to answer (AskUserQuestion), a plan to approve
 * (ExitPlanMode) or a tool to allow, deny or always allow (Claude: the rule is saved to the server-synced allow-list the
 * workbench uses too).
 */
export function PermissionSheet({ request, provider, onDecide, onAlwaysAllow, onLater }: PermissionSheetProps) {
  const entry = useMemo(() => (request && provider === 'claude' ? buildClaudeToolPermissionEntry(request.toolName, request.input) : null), [provider, request]);
  if (!request) return null;
  const tool = request.toolName;
  if (tool === 'AskUserQuestion') {
    return (
      <BottomSheet open onClose={onLater} title="agent의 질문">
        <QuestionForm key={request.requestId} request={request} onDecide={onDecide} />
      </BottomSheet>
    );
  }
  if (tool === 'ExitPlanMode' || tool === 'exit_plan_mode') {
    const plan = asRecord(request.input).plan;
    return (
      <BottomSheet open onClose={onLater} title="계획 승인">
        <div className="max-h-[50dvh] overflow-y-auto rounded-xl border border-line bg-bg p-3" data-testid="plan-body"><Prose text={typeof plan === 'string' ? plan : ''} /></div>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => onDecide(request.requestId, { allow: false, message: 'User asked to revise the plan' })} className="h-11 flex-1 rounded-xl border border-line text-[15px]">계속 계획</button>
          <button type="button" onClick={() => onDecide(request.requestId, { allow: true })} className="h-11 flex-1 rounded-xl bg-accent text-[15px] font-semibold text-accent-ink">승인하고 실행</button>
        </div>
      </BottomSheet>
    );
  }
  const input = asRecord(request.input);
  const shown = typeof input.command === 'string' ? input.command : request.input && typeof request.input === 'object' ? JSON.stringify(request.input, null, 1) : String(request.input ?? '');
  return (
    <BottomSheet open onClose={onLater} title={`도구 허용: ${tool}`}>
      {typeof input.description === 'string' ? <div className="mb-2 text-[13px] text-muted">{input.description}</div> : null}
      <pre className="rounded-xl bg-elevated border border-line p-2 text-[12px] whitespace-pre-wrap break-words max-h-60 overflow-auto">{clampText(shown, 3000)}</pre>
      <div className="flex gap-2 mt-3">
        <button type="button" onClick={() => onDecide(request.requestId, { allow: false })} className="flex-1 h-11 rounded-xl border border-line">거부</button>
        <button type="button" onClick={() => onDecide(request.requestId, { allow: true })} className="flex-1 h-11 rounded-xl bg-accent text-accent-ink font-semibold">허용</button>
      </div>
      {entry && onAlwaysAllow ? (
        <button type="button" onClick={() => onAlwaysAllow(request, entry)} className="mt-2 flex w-full items-center justify-center gap-1.5 h-11 rounded-xl text-[14px] text-accent">
          항상 허용 <code className="rounded bg-elevated px-1.5 py-0.5 text-[12px] text-ink">{entry}</code>
        </button>
      ) : null}
    </BottomSheet>
  );
}
