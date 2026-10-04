import type { ReactNode } from 'react';

import { BottomSheet } from '@m/components/BottomSheet';
import { Prose } from '@m/lib/markdown';

/** What `/api/commands/execute` answered: a built-in's result to show, or a project command's text to send. */
export type CommandResult =
  | { type: 'builtin'; action: string; data?: Record<string, unknown> }
  | { type: 'custom'; command: string; content: string; hasBashCommands?: boolean };

const num = (value: unknown) => (typeof value === 'number' ? value.toLocaleString() : '—');
const str = (value: unknown) => (typeof value === 'string' && value ? value : '—');

function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-line rounded-xl border border-line">
      {rows.map(([label, value]) => <div key={label} className="flex gap-3 px-3 py-2 text-[14px]"><dt className="w-24 shrink-0 text-muted">{label}</dt><dd className="min-w-0 flex-1 break-words">{value}</dd></div>)}
    </dl>
  );
}

function Builtin({ action, data = {} }: { action: string; data?: Record<string, unknown> }) {
  if (action === 'help') return <Prose text={str(data.content)} />;
  if (action === 'models') {
    const current = (data.current ?? {}) as { providerLabel?: string; provider?: string; model?: string };
    const available = Array.isArray(data.availableModels) ? data.availableModels as string[] : [];
    return (
      <div className="space-y-2">
        <Rows rows={[['엔진', current.providerLabel ?? current.provider ?? '—'], ['모델', str(current.model)]]} />
        {available.length ? <div className="text-[12px] text-muted">사용 가능: {available.join(', ')}</div> : null}
        <div className="text-[12px] text-muted">모델은 라우터가 명령마다 고릅니다.</div>
      </div>
    );
  }
  if (action === 'cost') {
    const usage = (data.tokenUsage ?? {}) as { used?: number; total?: number };
    const breakdown = (data.tokenBreakdown ?? {}) as { input?: number; output?: number };
    return <Rows rows={[['사용', `${num(usage.used)} / ${num(usage.total)}`], ['입력', num(breakdown.input)], ['출력', num(breakdown.output)], ['모델', str(data.model)]]} />;
  }
  if (action === 'status') {
    const memory = (data.memoryUsage ?? {}) as { rssMb?: number };
    return <Rows rows={[['버전', str(data.version)], ['가동', str(data.uptime)], ['엔진', str(data.provider)], ['모델', str(data.model)], ['Node', str(data.nodeVersion)], ['메모리', typeof memory.rssMb === 'number' ? `${memory.rssMb} MB` : '—']]} />;
  }
  if (action === 'memory') {
    return <div className="space-y-1 text-[14px]"><div className={data.error ? 'text-warn' : ''}>{str(data.message)}</div>{typeof data.path === 'string' ? <code className="block break-all text-[12px] text-muted">{data.path}</code> : null}</div>;
  }
  return <pre className="whitespace-pre-wrap break-words text-[12px]">{JSON.stringify(data, null, 1)}</pre>;
}

const TITLES: Record<string, string> = { help: '도움말', models: '모델', cost: '사용량', status: '상태', memory: '메모리 (CLAUDE.md)' };

/**
 * Used by ChatScreen after a `/` command ran: a built-in's result (help, models, cost, status, memory), or — for a
 * project command that runs shell lines — a confirmation before its text is sent.
 */
export function CommandResultSheet({ result, onClose, onSend }: { result: CommandResult | null; onClose: () => void; onSend: (content: string) => void }) {
  if (!result) return null;
  if (result.type === 'custom') {
    return (
      <BottomSheet open onClose={onClose} title={`${result.command} 실행`}>
        <p className="mb-2 text-[14px] text-warn">이 명령은 셸 명령을 실행합니다. 계속할까요?</p>
        <pre className="max-h-[40dvh] overflow-auto rounded-xl border border-line bg-elevated p-2 text-[12px] whitespace-pre-wrap break-words">{result.content}</pre>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-line text-[15px]">취소</button>
          <button type="button" onClick={() => { onSend(result.content); onClose(); }} className="h-11 flex-1 rounded-xl bg-accent text-[15px] font-semibold text-accent-ink">실행</button>
        </div>
      </BottomSheet>
    );
  }
  return (
    <BottomSheet open onClose={onClose} title={TITLES[result.action] ?? result.action}>
      <div data-testid="command-result"><Builtin action={result.action} data={result.data} /></div>
    </BottomSheet>
  );
}
