import { useEffect, useState } from 'react';
import { Check, ExternalLink, RefreshCw, X } from 'lucide-react';

import { refreshSummary, useKnowledgeRefresh, type KnowledgeProposal } from '@/modules/aidev-router';
import { BottomSheet } from '@m/components/BottomSheet';

/** One replacement waiting for review, phone-sized. */
function ProposalRow({ proposal, onDecide }: { proposal: KnowledgeProposal; onDecide: (accept: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-warn/40 bg-warn/10 p-3" data-testid="knowledge-proposal">
      <div className="text-[12px] text-muted">{proposal.agent_name}</div>
      <div className="text-[15px] font-medium">{proposal.title}</div>
      {proposal.replaces_item ? <div className="text-[12px] text-muted mt-0.5">대체 대상: {proposal.replaces_item.title}</div> : null}
      {proposal.check_note ? <div className="text-[13px] mt-1">{proposal.check_note}</div> : null}
      {proposal.source_url ? <a href={proposal.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-accent mt-1">{proposal.source_date ?? '출처'} <ExternalLink size={12} /></a> : null}
      <button type="button" className="block text-[12px] text-muted underline mt-1" onClick={() => setOpen(!open)}>{open ? '본문 접기' : '새 본문 보기'}</button>
      {open ? <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-elevated p-2 text-[12px]">{proposal.body}</pre> : null}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onDecide(true)} className="h-10 rounded-xl bg-accent text-accent-ink text-[14px] font-medium flex items-center justify-center gap-1"><Check size={16} /> 교체</button>
        <button type="button" onClick={() => onDecide(false)} className="h-10 rounded-xl border border-line text-[14px] flex items-center justify-center gap-1"><X size={16} /> 기존 유지</button>
      </div>
    </div>
  );
}

/**
 * Used by SettingsScreen: agent knowledge re-check (E-04) — check expired items now, and review
 * replacements the weekly job was unsure about. `/m/settings?review=knowledge` (the push
 * notification's link) opens the review sheet directly.
 */
export function KnowledgeSection() {
  const knowledge = useKnowledgeRefresh();
  const [sheet, setSheet] = useState(false);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('review') === 'knowledge') setSheet(true); }, []);
  const pending = knowledge.proposals?.length ?? 0;
  return (
    <section>
      <div className="text-[12px] uppercase tracking-wide text-muted mb-2">지식</div>
      <div className="rounded-xl2 border border-line bg-surface divide-y divide-line">
        <button type="button" className="w-full text-left px-4 py-3 flex items-center gap-3" onClick={() => setSheet(true)}>
          <span className="flex-1"><div className="text-[15px]">갱신 검토</div><div className="text-[12px] text-muted">출처가 바뀐 지식 중 자동으로 판단하지 못한 것</div></span>
          <span className={`text-[13px] ${pending ? 'text-warn font-medium' : 'text-muted'}`}>{knowledge.proposals === null ? '…' : pending ? `${pending}건` : '없음'}</span>
        </button>
        <button type="button" disabled={knowledge.running} className="w-full text-left px-4 py-3 flex items-center gap-3 disabled:opacity-60" onClick={() => { void knowledge.start(); }}>
          <RefreshCw size={16} className={knowledge.running ? 'animate-spin text-accent' : 'text-accent'} />
          <span className="flex-1 text-[15px] text-accent">{knowledge.running && knowledge.job ? `확인 중 ${knowledge.job.done}/${knowledge.job.total}` : '기한 지난 지식 지금 확인'}</span>
        </button>
      </div>
      <div className="text-[12px] text-muted mt-2">{knowledge.error ?? (!knowledge.running && knowledge.job?.finishedAt ? refreshSummary(knowledge.job) : '출처가 있는 지식은 90일마다 주 1회 작업이 다시 확인합니다 (구독 사용량 사용).')}</div>
      <BottomSheet open={sheet} onClose={() => setSheet(false)} title="지식 갱신 검토">
        <div className="space-y-3 max-h-[65dvh] overflow-auto">
          {pending === 0 ? <p className="text-[14px] text-muted">검토할 제안이 없습니다.</p> : null}
          {knowledge.proposals?.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} onDecide={(accept) => { void knowledge.decide(proposal.id, accept); }} />)}
        </div>
      </BottomSheet>
    </section>
  );
}
