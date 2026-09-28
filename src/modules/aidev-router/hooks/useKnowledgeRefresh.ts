import { useCallback, useEffect, useRef, useState } from 'react';

import { aidevApi, type KnowledgeProposal, type KnowledgeRefreshJob } from '@/modules/aidev-router/api';

const POLL_MS = 2500;

/**
 * Knowledge refresh from the UI (IMPLEMENTATION-PLAN §3.8, E-04), shared by the workbench catalog and
 * the mobile settings screen: start a re-check (one item or every due item), follow its progress,
 * and answer the replacements waiting for review. `onFinished` runs once a started job ends.
 */
export function useKnowledgeRefresh(onFinished?: (job: KnowledgeRefreshJob) => void) {
  const [job, setJob] = useState<KnowledgeRefreshJob | null>(null);
  const [proposals, setProposals] = useState<KnowledgeProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const finished = useRef(onFinished);
  useEffect(() => { finished.current = onFinished; });

  const loadProposals = useCallback(() => {
    aidevApi.knowledgeProposals().then((response) => setProposals(response.proposals)).catch(() => setProposals([]));
  }, []);

  const poll = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      aidevApi.knowledgeRefreshStatus().then(({ job: next }) => {
        setJob(next);
        if (next?.running) poll();
        else if (next) { loadProposals(); finished.current?.(next); }
      }).catch(() => poll());
    }, POLL_MS);
  }, [loadProposals]);

  useEffect(() => {
    loadProposals();
    // a job started elsewhere (other tab, the phone) is picked up and followed
    aidevApi.knowledgeRefreshStatus().then(({ job: current }) => { setJob(current); if (current?.running) poll(); }).catch(() => undefined);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [loadProposals, poll]);

  const start = useCallback(async (id?: number) => {
    setError(null);
    try {
      const response = await aidevApi.knowledgeRefresh(id);
      setJob(response.job);
      if (response.job.running) poll();
      else finished.current?.(response.job);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '확인을 시작하지 못했습니다');
    }
  }, [poll]);

  const decide = useCallback(async (id: number, accept: boolean) => {
    setError(null);
    try {
      await aidevApi.decideKnowledge(id, accept);
      setProposals((list) => list?.filter((proposal) => proposal.id !== id) ?? null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '처리하지 못했습니다');
    }
  }, []);

  return { job, running: Boolean(job?.running), proposals, error, start, decide, loadProposals };
}

/** Korean label for an item's state, including what the last re-check found. */
export function knowledgeLabel(item: { status: string; check_fails?: number; replaces?: number | null }) {
  switch (item.status) {
    case 'verified': return '검증됨';
    case 'sourced': return item.check_fails ? `출처 확인 실패 ${item.check_fails}회` : '출처 있음';
    case 'unverified': return '미검증(주입 안 함)';
    case 'proposed': return '갱신 제안';
    case 'superseded': return '대체됨';
    default: return item.status;
  }
}

/** One-line summary of a finished job. */
export function refreshSummary(job: KnowledgeRefreshJob) {
  if (job.error) return job.error;
  if (!job.total) return '확인할 항목이 없습니다 (기한이 지난 지식 없음)';
  const count = (outcome: string) => job.results.filter((result) => result.outcome === outcome).length;
  const parts = [
    count('current') ? `최신 ${count('current')}` : null,
    count('superseded') ? `갱신 ${count('superseded')}` : null,
    count('proposed') ? `검토 필요 ${count('proposed')}` : null,
    count('kept') ? `유지 ${count('kept')}` : null,
    count('unreachable') + count('unverified') ? `출처 확인 실패 ${count('unreachable') + count('unverified')}` : null,
    count('error') ? `오류 ${count('error')}` : null,
  ].filter(Boolean);
  return `${job.done}/${job.total} 확인 · ${parts.join(' · ') || '변경 없음'}`;
}
