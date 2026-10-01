import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Bot, CheckCircle2, ChevronLeft, ListChecks, Plus, RefreshCw, Sparkles } from 'lucide-react';

import { aidevApi, type AgentDetail, type CatalogAgent } from '@/modules/aidev-router/api';
import { KnowledgePanel, KnowledgeProposalCard } from '@/modules/aidev-router/KnowledgePanel';
import { TierPolicyPanel } from '@/modules/aidev-router/TierPolicyPanel';
import { refreshSummary, useKnowledgeRefresh } from '@/modules/aidev-router/hooks/useKnowledgeRefresh';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * Used by the workbench side view "Agent 카탈로그" (C-09): the catalog list, an agent's detail
 * (prompt, versions, knowledge, lessons, run statistics, routing examples), inline edits that
 * create a new version, and example curation for the lexical router.
 */
export function AgentCatalog() {
  const [agents, setAgents] = useState<CatalogAgent[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [examples, setExamples] = useState<Array<{ id: number; text: string; source: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ prompt: string; description: string; hint: string; changelog: string } | null>(null);
  const [newExample, setNewExample] = useState('');

  const loadList = useCallback(() => { aidevApi.agents().then((response) => setAgents(response.agents)).catch((err: Error) => setError(err.message)); }, []);
  const loadDetail = useCallback((id: number) => {
    setDetail(null); setEditing(null);
    aidevApi.agent(id).then((response) => setDetail(response)).catch((err: Error) => setError(err.message));
    aidevApi.agentExamples(id).then((response) => setExamples(response.examples)).catch(() => setExamples([]));
  }, []);
  // E-04: re-checks refresh the open agent when they finish; proposals are listed above the catalog
  const selectedRef = useRef<number | null>(null);
  useEffect(() => { selectedRef.current = selected; });
  const knowledge = useKnowledgeRefresh(() => { if (selectedRef.current !== null) loadDetail(selectedRef.current); });
  // E-05: the learned tier policy is shown to administrators only
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { aidevApi.engines().then((response) => setIsAdmin(response.role === 'admin')).catch(() => setIsAdmin(false)); }, []);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (selected !== null) loadDetail(selected); }, [selected, loadDetail]);

  const save = async () => {
    if (!detail || !editing) return;
    try {
      await aidevApi.updateAgent(detail.agent.id, { prompt: editing.prompt, description: editing.description, hint: editing.hint, changelog: editing.changelog || 'edited in catalog' });
      loadDetail(detail.agent.id); loadList();
    } catch (err) { setError(err instanceof Error ? err.message : '저장 실패'); }
  };
  const addExample = async () => {
    if (!detail || newExample.trim().length < 4) return;
    try { await aidevApi.addAgentExamples(detail.agent.id, [newExample.trim()]); setNewExample(''); const response = await aidevApi.agentExamples(detail.agent.id); setExamples(response.examples); }
    catch (err) { setError(err instanceof Error ? err.message : '예시 추가 실패'); }
  };

  if (selected === null || !agents) {
    return (
      <div className="flex h-full flex-col text-[12px]">
        <div className="flex h-8 items-center gap-2 border-b border-border px-3 text-muted-foreground">
          <span>{agents ? `${agents.length}개` : '불러오는 중…'}</span>
          <button type="button" onClick={loadList} aria-label="새로고침" className="ml-auto rounded p-1 hover:bg-accent"><RefreshCw size={12} /></button>
        </div>
        {error ? <div className="px-3 py-2 text-red-600">{error}</div> : null}
        <div className="flex-1 overflow-auto">
          <div className="space-y-1.5 border-b border-border px-3 py-2" data-testid="knowledge-review">
            <div className="flex items-center gap-1 text-muted-foreground">
              <BookOpen size={12} /> 지식 갱신{knowledge.proposals?.length ? ` · 검토 ${knowledge.proposals.length}` : ''}
              <button type="button" disabled={knowledge.running} onClick={() => { void knowledge.start(); }} title="기한(90일)이 지난 출처 지식을 지금 다시 확인합니다" className="ml-auto inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent disabled:opacity-50">
                <RefreshCw size={11} className={knowledge.running ? 'animate-spin' : ''} /> {knowledge.running && knowledge.job ? `확인 중 ${knowledge.job.done}/${knowledge.job.total}` : '기한 지난 지식 확인'}
              </button>
            </div>
            {knowledge.error ? <div className="text-red-600">{knowledge.error}</div> : null}
            {!knowledge.running && knowledge.job?.finishedAt ? <div className="text-muted-foreground">{refreshSummary(knowledge.job)}</div> : null}
            {knowledge.proposals?.map((proposal) => <KnowledgeProposalCard key={proposal.id} proposal={proposal} showAgent onDecide={(accept) => { void knowledge.decide(proposal.id, accept); }} />)}
          </div>
          {isAdmin ? <TierPolicyPanel /> : null}
          {agents?.map((agent) => (
            <button key={agent.id} type="button" onClick={() => setSelected(agent.id)} className="w-full border-b border-border/60 px-3 py-2 text-left hover:bg-accent/50">
              <div className="flex items-center gap-1.5">
                <Bot size={13} className={agent.domain === 'meta' ? 'text-muted-foreground' : 'text-primary'} />
                <span className="font-medium">{agent.name}</span>
                <span className="text-muted-foreground">v{agent.version}</span>
                {agent.ownerId !== null ? <span className="ml-auto rounded bg-muted px-1 text-[10px]">개인</span> : null}
                {agent.verified ? <CheckCircle2 size={12} className="text-emerald-600" /> : null}
              </div>
              <div className="mt-0.5 line-clamp-2 text-muted-foreground">{agent.hint ? <span className="text-foreground/70">[{agent.hint}] </span> : null}{agent.description}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{agent.domain} · 사용 {agent.uses}회{agent.minTier ? ` · D${agent.minTier} 이상` : ''}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const agent = detail?.agent;
  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex h-8 items-center gap-1 border-b border-border px-2">
        <button type="button" onClick={() => setSelected(null)} aria-label="목록" className="rounded p-1 hover:bg-accent"><ChevronLeft size={14} /></button>
        <span className="truncate font-medium">{agent?.name ?? '…'}</span>
        {agent ? <span className="text-muted-foreground">v{agent.version}</span> : null}
        {agent && agent.domain !== 'meta' ? <button type="button" title="다음 명령을 이 agent로 보내기" onClick={() => routingStore.setOverrides({ agent: agent.name })} className="ml-auto inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent"><Sparkles size={11} /> 다음 명령에 사용</button> : null}
      </div>
      {error ? <div className="px-3 py-2 text-red-600">{error}</div> : null}
      {!detail ? <div className="p-3 text-muted-foreground">불러오는 중…</div> : (
        <div className="flex-1 space-y-3 overflow-auto px-3 py-2">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md bg-muted/60 py-1.5"><div className="text-[10px] text-muted-foreground">실행</div><div className="font-medium">{detail.stats.runs}</div></div>
            <div className="rounded-md bg-muted/60 py-1.5"><div className="text-[10px] text-muted-foreground">성공률</div><div className="font-medium">{detail.stats.runs ? `${Math.round(((detail.stats.success ?? 0) / detail.stats.runs) * 100)}%` : '-'}</div></div>
            <div className="rounded-md bg-muted/60 py-1.5"><div className="text-[10px] text-muted-foreground">평균 시간</div><div className="font-medium">{detail.stats.avg_ms ? `${Math.round(detail.stats.avg_ms / 1000)}s` : '-'}</div></div>
          </div>
          {editing ? (
            <div className="space-y-1.5">
              <input className="w-full rounded border border-border bg-background px-2 py-1" value={editing.hint} onChange={(event) => setEditing({ ...editing, hint: event.target.value })} placeholder="라우팅 힌트 (4~7 영단어)" />
              <textarea className="h-16 w-full rounded border border-border bg-background px-2 py-1" value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} />
              <textarea className="h-48 w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]" value={editing.prompt} onChange={(event) => setEditing({ ...editing, prompt: event.target.value })} />
              <input className="w-full rounded border border-border bg-background px-2 py-1" value={editing.changelog} onChange={(event) => setEditing({ ...editing, changelog: event.target.value })} placeholder="변경 이유 (새 버전에 기록)" />
              <div className="flex gap-2"><button type="button" onClick={save} className="h-7 rounded bg-primary px-3 text-primary-foreground">새 버전으로 저장</button><button type="button" onClick={() => setEditing(null)} className="h-7 rounded border border-border px-3">취소</button></div>
            </div>
          ) : (
            <div>
              <div className="text-muted-foreground">{agent!.hint ? `[${agent!.hint}] ` : ''}{agent!.description}</div>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">{agent!.prompt}</pre>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setEditing({ prompt: agent!.prompt, description: agent!.description, hint: agent!.hint ?? '', changelog: '' })} className="h-7 rounded border border-border px-2">편집 (새 버전)</button>
                {agent!.domain !== 'meta' ? (
                  <label className="inline-flex items-center gap-1 text-muted-foreground" title="명령이 짧아 보여도 이 agent는 이 깊이(모델 등급) 이상으로 실행합니다.">
                    최소 등급
                    <select aria-label="최소 등급" value={agent!.minTier ?? ''} onChange={(event) => { const value = event.target.value === '' ? null : Number(event.target.value); void aidevApi.updateAgent(agent!.id, { min_tier: value }).then(() => loadDetail(agent!.id)).catch((err: Error) => setError(err.message)); }} className="h-7 rounded border border-border bg-background px-1 text-foreground">
                      <option value="">없음</option>
                      {[1, 2, 3, 4].map((level) => <option key={level} value={level}>D{level} 이상</option>)}
                    </select>
                  </label>
                ) : null}
              </div>
            </div>
          )}
          <section>
            <div className="mb-1 flex items-center gap-1 text-muted-foreground"><ListChecks size={12} /> 라우팅 예시 {examples.length}</div>
            <div className="flex gap-1">
              <input className="flex-1 rounded border border-border bg-background px-2 py-1" value={newExample} onChange={(event) => setNewExample(event.target.value)} placeholder="이 agent로 가야 할 명령 예시 추가" onKeyDown={(event) => { if (event.key === 'Enter') void addExample(); }} />
              <button type="button" onClick={addExample} aria-label="추가" className="flex h-7 w-7 items-center justify-center rounded border border-border"><Plus size={12} /></button>
            </div>
            <ul className="mt-1 max-h-32 overflow-auto text-muted-foreground">{examples.slice(0, 40).map((example) => <li key={example.id} className="truncate">· {example.text} <span className="text-[10px]">({example.source})</span></li>)}</ul>
          </section>
          <KnowledgePanel items={detail.knowledge} refresh={{ ...knowledge, decide: async (id, accept) => { await knowledge.decide(id, accept); loadDetail(detail.agent.id); } }} />
          <section>
            <div className="mb-1 text-muted-foreground" title="후보는 관련 명령에 시험 적용되어 성공하면 자동 검증, 2회 실패하면 폐기. 검증된 규칙이 3회 성공하면 프롬프트에 승격(내 agent) 또는 항상 적용(공용 agent).">교훈 {detail.lessons.length} · 시험 적용 → 자동 검증 → 승격</div>
            <ul className="space-y-1.5 text-muted-foreground">{detail.lessons.map((lesson) => {
              const merged = Boolean(lesson.promoted_version);
              const pinned = Boolean(lesson.promoted_to_prompt) && !merged;
              const label = merged ? `프롬프트 v${lesson.promoted_version}` : pinned ? '항상 적용' : lesson.status === 'verified' ? (lesson.verified_by === 'auto' ? '자동 검증' : '검증') : lesson.status === 'candidate' ? '시험 대기' : lesson.status;
              const tone = merged || pinned ? 'text-primary' : lesson.status === 'verified' ? 'text-emerald-600' : lesson.status === 'candidate' ? 'text-amber-600' : '';
              const reload = () => loadDetail(detail.agent.id);
              return (
                <li key={lesson.id}>
                  <span className={tone}>[{label}]</span> {lesson.trigger} → {lesson.rule}
                  <span className="ml-1 text-[10px]">성공 {lesson.hits}{lesson.fails ? ` · 실패 ${lesson.fails}` : ''}</span>
                  {lesson.status === 'candidate' ? (
                    <span className="ml-1 inline-flex gap-1">
                      <button type="button" className="rounded border border-border px-1 hover:bg-accent" onClick={() => { void aidevApi.updateLesson(lesson.id, { status: 'verified' }).then(reload); }}>승인</button>
                      <button type="button" className="rounded border border-border px-1 hover:bg-accent" onClick={() => { void aidevApi.updateLesson(lesson.id, { status: 'rejected' }).then(reload); }}>거절</button>
                    </span>
                  ) : null}
                  {lesson.status === 'verified' && !lesson.promoted_to_prompt ? (
                    <button type="button" className="ml-1 rounded border border-border px-1 hover:bg-accent" title="내 agent면 프롬프트에 합쳐 새 버전, 공용 agent면 항상 적용" onClick={() => { void aidevApi.updateLesson(lesson.id, { promote: true }).then(() => { reload(); loadList(); }).catch((err: Error) => setError(err.message)); }}>승격</button>
                  ) : null}
                </li>
              );
            })}</ul>
          </section>
          <section>
            <div className="mb-1 text-muted-foreground">버전</div>
            <ul className="text-muted-foreground">{detail.versions.map((version) => <li key={version.version}>· v{version.version} {version.changelog ?? ''} <span className="text-[10px]">{new Date(version.createdAt).toLocaleDateString()}</span></li>)}</ul>
          </section>
        </div>
      )}
    </div>
  );
}
