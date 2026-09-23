import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, Loader2, X, XCircle } from 'lucide-react';

import type { AgentDraft } from '@/modules/aidev-router/api';
import type { PendingCreate } from '@/modules/aidev-router/store';

type AgentCreateCardProps = {
  pending: PendingCreate;
  onApprove: (draft: AgentDraft) => void;
  onSelfCheck: () => void;
  onDismiss: () => void;
  /** Compact layout for narrow panes (mobile sheet). */
  compact?: boolean;
};

/**
 * Used by ChatInterface (workbench) and the mobile ChatScreen: shows the agent-architect's draft for
 * approval (name / hint / description / prompt editable, knowledge sources listed), the creation
 * result, and the optional self-check outcome (IMPLEMENTATION-PLAN §3.7).
 */
export function AgentCreateCard({ pending, onApprove, onSelfCheck, onDismiss, compact }: AgentCreateCardProps) {
  const [draft, setDraft] = useState<AgentDraft | null>(pending.draft);
  useEffect(() => { setDraft(pending.draft); }, [pending.draft]);
  const field = 'w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:border-primary';
  const label = 'block text-[11px] text-muted-foreground mt-2 mb-0.5';

  return (
    <div className={`border-t border-border bg-muted/30 ${compact ? 'p-3' : 'px-4 py-3'} text-[12px]`} data-testid="agent-create-card">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={14} className="text-primary" />
        <span className="font-medium">
          {pending.stage === 'architect' ? '맞는 전문 agent가 없어 설계 중입니다…' : pending.stage === 'review' ? '새 전문 agent 제안' : pending.stage === 'selfcheck' ? '자가 검증 실행 중…' : `agent ${pending.agentName} 생성됨`}
        </span>
        {pending.stage === 'architect' || pending.stage === 'selfcheck' ? <Loader2 size={13} className="animate-spin text-muted-foreground" /> : null}
        <button type="button" aria-label="닫기" onClick={onDismiss} className="ml-auto p-1 rounded hover:bg-accent text-muted-foreground"><X size={13} /></button>
      </div>
      <div className="text-muted-foreground line-clamp-2">명령: {pending.originalText}</div>
      {pending.error ? <div className="text-red-600 mt-1">{pending.error}</div> : null}

      {pending.stage === 'review' && draft ? (
        <div className="mt-1">
          <div className={compact ? '' : 'grid grid-cols-2 gap-x-3'}>
            <div><label className={label}>이름</label><input className={field} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div><label className={label}>라우팅 힌트 (4~7 영단어)</label><input className={field} value={draft.hint} onChange={(event) => setDraft({ ...draft, hint: event.target.value })} /></div>
          </div>
          <label className={label}>설명</label>
          <textarea className={`${field} h-14 resize-y`} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          <label className={label}>프롬프트</label>
          <textarea className={`${field} font-mono h-32 resize-y`} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
          {draft.knowledge.length ? (
            <div className="mt-2">
              <div className={label}>지식 ({draft.knowledge.length}, 출처 있음 = sourced)</div>
              <ul className="list-disc pl-4 text-muted-foreground">
                {draft.knowledge.map((item, index) => <li key={index} className="truncate">{item.title}{item.source_url ? ` — ${item.source_url}${item.source_date ? ` (${item.source_date})` : ''}` : ' (출처 없음: unverified)'}</li>)}
              </ul>
            </div>
          ) : null}
          {draft.self_check ? <div className="mt-2 text-muted-foreground">자가 검증 과제: {draft.self_check.task}</div> : null}
          <div className="flex gap-2 mt-3">
            <button type="button" onClick={() => onApprove(draft)} disabled={!draft.name || draft.prompt.length < 20 || draft.description.length < 10} className="h-8 px-3 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50">승인하고 원래 명령 실행</button>
            <button type="button" onClick={onDismiss} className="h-8 px-3 rounded-md border border-border">거절 (범용으로 진행)</button>
          </div>
        </div>
      ) : null}

      {pending.stage === 'done' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {pending.selfCheckResult ? (
            <span className={`inline-flex items-center gap-1 ${pending.selfCheckResult.pass ? 'text-emerald-600' : pending.selfCheckResult.pass === false ? 'text-red-600' : 'text-amber-600'}`}>
              {pending.selfCheckResult.pass ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {pending.selfCheckResult.note} ({Math.round(pending.selfCheckResult.confidence * 100)}%)
            </span>
          ) : pending.draft?.self_check ? (
            <button type="button" onClick={onSelfCheck} className="h-7 px-2 rounded-md border border-border">자가 검증 실행</button>
          ) : null}
          <span className="text-muted-foreground">다음부터 이 분야의 명령은 {pending.agentName}(으)로 라우팅됩니다.</span>
        </div>
      ) : null}
    </div>
  );
}
