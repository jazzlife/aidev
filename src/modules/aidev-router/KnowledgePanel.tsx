import { useState } from 'react';
import { BookOpen, Check, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';

import type { KnowledgeItem, KnowledgeProposal, KnowledgeRefreshJob } from '@/modules/aidev-router/api';
import { knowledgeLabel, refreshSummary } from '@/modules/aidev-router/hooks/useKnowledgeRefresh';

const day = (at: number | null | undefined) => (at ? new Date(at).toISOString().slice(0, 10) : null);
const tone = (status: string) => (status === 'verified' ? 'text-emerald-600' : status === 'sourced' ? 'text-foreground/80' : status === 'proposed' ? 'text-amber-600' : 'text-muted-foreground');

type RefreshControls = { job: KnowledgeRefreshJob | null; running: boolean; error: string | null; start: (id?: number) => Promise<void>; decide: (id: number, accept: boolean) => Promise<void> };

/** One replacement waiting for review: what it replaces, the new text, accept / reject. */
export function KnowledgeProposalCard({ proposal, onDecide, showAgent }: { proposal: KnowledgeProposal | (KnowledgeItem & { replaces_item?: KnowledgeItem | null; agent_name?: string }); onDecide: (accept: boolean) => void; showAgent?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2" data-testid="knowledge-proposal">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{showAgent && proposal.agent_name ? <span className="text-muted-foreground">{proposal.agent_name} · </span> : null}갱신 제안: {proposal.title}</div>
          {proposal.replaces_item ? <div className="text-muted-foreground">대체 대상: {proposal.replaces_item.title}{proposal.replaces_item.source_date ? ` (${proposal.replaces_item.source_date})` : ''}</div> : null}
          {proposal.check_note ? <div className="mt-0.5">{proposal.check_note}</div> : null}
          {proposal.source_url ? <a href={proposal.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary">{proposal.source_date ?? '출처'} <ExternalLink size={10} /></a> : null}
        </div>
      </div>
      <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-muted-foreground underline">{open ? '본문 접기' : '새 본문 보기'}</button>
      {open ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1.5 font-mono text-[11px]">{proposal.body}</pre> : null}
      <div className="mt-1.5 flex gap-1.5">
        <button type="button" onClick={() => onDecide(true)} className="inline-flex h-6 items-center gap-1 rounded bg-primary px-2 text-primary-foreground"><Check size={11} /> 교체</button>
        <button type="button" onClick={() => onDecide(false)} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2"><X size={11} /> 기존 유지</button>
      </div>
    </div>
  );
}

/**
 * Used by AgentCatalog's detail view: an agent's knowledge with its re-check state (last check,
 * next check, note), a per-item "지금 확인" and the replacements waiting for review (E-04).
 */
export function KnowledgePanel({ items, refresh }: { items: KnowledgeItem[]; refresh: RefreshControls }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const proposals = items.filter((item) => item.status === 'proposed');
  const active = items.filter((item) => item.status !== 'proposed');
  return (
    <section>
      <div className="mb-1 flex items-center gap-1 text-muted-foreground" title="출처가 있는 지식은 90일마다 출처를 다시 확인해 최신이면 연장, 바뀌었으면 교체(확신이 낮으면 검토 제안)합니다.">
        <BookOpen size={12} /> 지식 {active.length}{proposals.length ? ` · 검토 ${proposals.length}` : ''}
        {refresh.running && refresh.job ? <span className="ml-auto inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> 확인 중 {refresh.job.done}/{refresh.job.total}</span> : null}
      </div>
      {refresh.error ? <div className="mb-1 text-red-600">{refresh.error}</div> : null}
      {!refresh.running && refresh.job?.finishedAt ? <div className="mb-1 text-muted-foreground">최근 확인: {refreshSummary(refresh.job)}</div> : null}
      <div className="space-y-1.5">
        {proposals.map((proposal) => <KnowledgeProposalCard key={proposal.id} proposal={{ ...proposal, replaces_item: proposal.replaces ? byId.get(proposal.replaces) ?? null : null }} onDecide={(accept) => { void refresh.decide(proposal.id, accept); }} />)}
      </div>
      <ul className="mt-1 space-y-1">
        {active.map((item) => {
          const next = day(item.expires_at);
          return (
            <li key={item.id} className="group" title={item.check_note ?? undefined}>
              <div className="flex items-center gap-1">
                <span className={`shrink-0 ${tone(item.status)}`}>[{knowledgeLabel(item)}]</span>
                <span className="min-w-0 flex-1 truncate">{item.title}{item.source_date ? ` (${item.source_date})` : ''}</span>
                {item.source_url ? (
                  <button type="button" aria-label="출처 다시 확인" title="출처 다시 확인" disabled={refresh.running} onClick={() => { void refresh.start(item.id); }} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-40">
                    <RefreshCw size={11} />
                  </button>
                ) : null}
              </div>
              <div className="pl-2 text-[10px] text-muted-foreground">
                {item.checked_at ? `확인 ${day(item.checked_at)}` : '확인 전'}{next && item.source_url && item.status !== 'unverified' ? ` · 다음 ${next}` : ''}{item.check_note ? ` · ${item.check_note}` : ''}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
