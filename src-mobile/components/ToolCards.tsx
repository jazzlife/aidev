import { useState, type ReactNode } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, ClipboardList, ListChecks, Loader2, MessageCircleQuestion } from 'lucide-react';

import { parseToolPayload, type NormalizedMessage } from '@/modules/chat-core';
import { summarizeToolInput } from '@m/lib/format';
import { Prose } from '@m/lib/markdown';

/**
 * Tool calls that read better as their own card (C-12.7), titled like the workbench's tool configs: the checklist
 * (TodoWrite — Codex's update_plan and todo_list arrive under this name too), a subagent (Task), a plan (ExitPlanMode)
 * and a question with the answers chosen (AskUserQuestion — the server folds the answers into the input).
 */
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' | string; activeForm?: string };

const record = (value: unknown): Record<string, unknown> => {
  const parsed = parseToolPayload(value);
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
};

export function readTodos(input: unknown): Todo[] {
  const todos = record(input).todos;
  return Array.isArray(todos) ? todos.filter((t): t is Todo => Boolean(t) && typeof (t as Todo).content === 'string') : [];
}

/** The workbench's collapsed title: the step in flight and how far along, or that it is done. */
export function todoTitle(todos: Todo[]): string {
  if (!todos.length) return '체크리스트 갱신';
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  if (active) return `${active.activeForm || active.content} — ${done}/${todos.length}`;
  return done === todos.length ? `완료 — ${done}/${todos.length}` : `${done}/${todos.length} 완료`;
}

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="space-y-1" data-testid="todo-list">
      {todos.map((todo, index) => (
        <li key={`${index}-${todo.content}`} className="flex items-start gap-2 text-[13px]">
          {todo.status === 'completed' ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
            : todo.status === 'in_progress' ? <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin text-accent" />
              : <Circle size={15} className="mt-0.5 shrink-0 text-muted" />}
          <span className={todo.status === 'completed' ? 'text-muted line-through' : todo.status === 'in_progress' ? 'font-medium' : ''}>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** The agent's answer as text: subagent results sometimes arrive as `[{type:'text', text}]`, raw or serialized. */
export function resultText(content: unknown): string {
  if (Array.isArray(content)) return content.filter((part) => (part as { type?: string })?.type === 'text').map((part) => String((part as { text?: string }).text ?? '')).join('\n\n');
  const text = typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content);
  if (text.trim().startsWith('[')) { try { return resultText(JSON.parse(text.trim())); } catch { /* plain text */ } }
  return text;
}

function Card({ icon, title, defaultOpen = false, tone = 'border-line', children, testId }: { icon: ReactNode; title: ReactNode; defaultOpen?: boolean; tone?: string; children: ReactNode; testId: string }) {
  // the card's body is shown
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="px-3 py-0.5" data-testid={testId}>
      <div className={`rounded-xl border bg-surface ${tone}`}>
        <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-start gap-2 px-3 py-2 text-left">
          <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
          <span className="min-w-0 flex-1 text-[13px] font-medium">{title}</span>
          {open ? <ChevronDown size={16} className="shrink-0 text-muted" /> : <ChevronRight size={16} className="shrink-0 text-muted" />}
        </button>
        {open ? <div className="border-t border-line px-3 py-2">{children}</div> : null}
      </div>
    </div>
  );
}

function SubagentCard({ message, result }: { message: NormalizedMessage; result?: NormalizedMessage | null }) {
  const input = record(message.toolInput);
  const kind = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'Agent';
  const description = typeof input.description === 'string' && input.description ? input.description : '작업 중';
  const running = message.subagent?.status === 'running' || (!result && message.subagent?.status !== 'completed' && message.subagent?.status !== 'failed');
  const answer = result?.toolResult ? resultText(result.toolResult.content) : '';
  const activity = message.subagentTools ?? [];
  return (
    <Card testId="subagent-card" tone={message.subagent?.status === 'failed' || result?.toolResult?.isError ? 'border-danger/50' : 'border-line'}
      icon={running ? <Loader2 size={14} className="animate-spin text-accent" /> : <Bot size={14} />}
      title={<>서브에이전트 / {kind}: {description}</>}>
      {activity.length ? (
        <ul className="mb-2 space-y-0.5 text-[12px] text-muted" data-testid="subagent-activity">
          {activity.filter((a) => a.kind === 'tool').slice(-12).map((a, index) => <li key={a.toolId ?? index} className="truncate">· <span className="text-ink">{a.toolName}</span> {summarizeToolInput(a.toolInput)}</li>)}
        </ul>
      ) : null}
      {answer ? <Prose text={answer} /> : <div className="text-[13px] text-muted">{running ? '진행 중…' : '결과가 없습니다'}</div>}
    </Card>
  );
}

function QuestionCard({ input }: { input: Record<string, unknown> }) {
  const questions = (Array.isArray(input.questions) ? input.questions : []) as Array<{ question: string; header?: string }>;
  const answers = (input.answers && typeof input.answers === 'object' ? input.answers : {}) as Record<string, string>;
  const answered = questions.filter((q) => answers[q.question]).length;
  const title = questions.length === 1
    ? `${questions[0]?.header || '질문'}${answers[questions[0]?.question ?? ''] ? ` — ${answers[questions[0]?.question ?? '']}` : ''}`
    : `질문 ${questions.length}개${answered ? ` — ${answered}개 답함` : ''}`;
  return (
    <Card testId="question-card" defaultOpen icon={<MessageCircleQuestion size={14} />} title={title}>
      <dl className="space-y-2">
        {questions.map((q) => (
          <div key={q.question}>
            <dt className="text-[13px] text-muted">{q.question}</dt>
            <dd className="text-[14px]">{answers[q.question] ?? <span className="text-muted">답하지 않음</span>}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Used by MessageBubble: the card for this tool call, or null for the generic one. */
export function toolCardFor(message: NormalizedMessage, result?: NormalizedMessage | null): ReactNode {
  const name = message.toolName;
  if (name === 'TodoWrite') {
    const todos = readTodos(message.toolInput);
    return <Card testId="todo-card" defaultOpen icon={<ListChecks size={14} />} title={todoTitle(todos)}><TodoList todos={todos} /></Card>;
  }
  if (name === 'Task' || name === 'Agent') return <SubagentCard message={message} result={result} />;
  if (name === 'ExitPlanMode' || name === 'exit_plan_mode') {
    const plan = record(message.toolInput).plan;
    return <Card testId="plan-card" defaultOpen icon={<ClipboardList size={14} />} title="실행 계획"><Prose text={typeof plan === 'string' ? plan.replace(/\\n/g, '\n') : ''} /></Card>;
  }
  if (name === 'AskUserQuestion') return <QuestionCard input={record(message.toolInput)} />;
  return null;
}

/** Used by ChatScreen above the composer: the conversation's latest checklist as one line, the full list on a tap. */
export function TodoProgress({ todos }: { todos: Todo[] }) {
  // the checklist is unfolded
  const [open, setOpen] = useState(false);
  if (!todos.length || todos.every((t) => t.status === 'completed')) return null;
  return (
    <div className="mx-3 mb-1 rounded-xl border border-line bg-surface" data-testid="todo-progress">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]">
        <ListChecks size={14} className="shrink-0 text-accent" /><span className="min-w-0 flex-1 truncate">{todoTitle(todos)}</span>
        {open ? <ChevronDown size={15} className="text-muted" /> : <ChevronRight size={15} className="text-muted" />}
      </button>
      {open ? <div className="max-h-[30dvh] overflow-y-auto border-t border-line px-3 py-2"><TodoList todos={todos} /></div> : null}
    </div>
  );
}

/** The latest checklist in the conversation (the newest TodoWrite), for the progress line. */
export function latestTodos(messages: NormalizedMessage[]): Todo[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === 'tool_use' && message.toolName === 'TodoWrite') return readTodos(message.toolInput);
  }
  return [];
}
