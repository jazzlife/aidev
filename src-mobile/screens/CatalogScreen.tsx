import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Monitor } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';

import { aidevApi, knowledgeLabel, type AgentDetail, type CatalogAgent } from '@/modules/aidev-router';
import { TopBar } from '@m/components/TopBar';

const lessonLabel = (lesson: AgentDetail['lessons'][number]) => {
  if (lesson.promoted_version) return `프롬프트 v${lesson.promoted_version}`;
  if (lesson.promoted_to_prompt) return '항상 적용';
  if (lesson.status === 'verified') return lesson.verified_by === 'auto' ? '자동 검증' : '검증';
  if (lesson.status === 'candidate') return '시험 대기';
  return lesson.status;
};

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-elevated py-2 text-center"><div className="text-[11px] text-muted">{label}</div><div className="text-[14px] font-medium">{value}</div></div>;
}

/** One agent, read-only: what it is for, how it has done, what it knows and what it has learned. */
function AgentView({ id }: { id: number }) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the full prompt is long; it stays folded until asked for
  const [promptOpen, setPromptOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    aidevApi.agent(id).then((response) => { if (!cancelled) setDetail(response); }).catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [id]);
  if (error) return <div className="px-4 py-6 text-[14px] text-danger">{error}</div>;
  if (!detail) return <div className="px-4 py-6 text-[14px] text-muted m-pulse">불러오는 중…</div>;
  const { agent, stats } = detail;
  const section = 'text-[12px] uppercase tracking-wide text-muted mb-2';
  return (
    <main className="m-scroll flex-1 space-y-5 px-4 py-4 pb-safe-b" data-testid="catalog-agent">
      <div>
        <div className="text-[13px] text-muted">{agent.domain}{agent.ownerId !== null ? ' · 개인' : ''}{agent.minTier ? ` · D${agent.minTier} 이상` : ''}</div>
        <div className="mt-1 text-[15px]">{agent.hint ? <span className="text-muted">[{agent.hint}] </span> : null}{agent.description}</div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="실행" value={String(stats.runs)} />
        <Stat label="성공률" value={stats.runs ? `${Math.round(((stats.success ?? 0) / stats.runs) * 100)}%` : '-'} />
        <Stat label="평균 시간" value={stats.avg_ms ? `${Math.round(stats.avg_ms / 1000)}초` : '-'} />
      </div>
      <section>
        <button type="button" className="flex items-center gap-1 text-[14px] text-accent" onClick={() => setPromptOpen(!promptOpen)}>{promptOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />} 프롬프트</button>
        {promptOpen ? <pre className="mt-2 max-h-[50dvh] overflow-auto whitespace-pre-wrap rounded-xl bg-elevated p-3 font-mono text-[12px]">{agent.prompt}</pre> : null}
      </section>
      <section>
        <div className={section}>교훈 {detail.lessons.length}</div>
        {detail.lessons.length ? (
          <ul className="space-y-2">{detail.lessons.map((lesson) => (
            <li key={lesson.id} className="rounded-xl border border-line bg-surface px-3 py-2 text-[13px]">
              <div className="text-[11px] text-muted">[{lessonLabel(lesson)}] 성공 {lesson.hits}{lesson.fails ? ` · 실패 ${lesson.fails}` : ''}</div>
              <div>{lesson.trigger} → {lesson.rule}</div>
            </li>
          ))}</ul>
        ) : <div className="text-[13px] text-muted">아직 쌓인 교훈이 없습니다.</div>}
      </section>
      <section>
        <div className={section}>지식 {detail.knowledge.length}</div>
        {detail.knowledge.length ? (
          <ul className="space-y-2">{detail.knowledge.map((item) => (
            <li key={item.id} className="rounded-xl border border-line bg-surface px-3 py-2 text-[13px]">
              <div className="text-[11px] text-muted">{knowledgeLabel(item)}{item.source_date ? ` · ${item.source_date}` : ''}</div>
              <div>{item.title}</div>
              {item.source_url ? <a href={item.source_url} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-accent">출처 <ExternalLink size={12} /></a> : null}
            </li>
          ))}</ul>
        ) : <div className="text-[13px] text-muted">등록된 지식이 없습니다.</div>}
      </section>
      <section>
        <div className={section}>버전</div>
        <ul className="space-y-1 text-[13px]">{detail.versions.map((version) => <li key={version.version}>v{version.version} <span className="text-muted">{version.changelog ?? ''} · {new Date(version.createdAt).toLocaleDateString()}</span></li>)}</ul>
      </section>
      <div className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-3 text-[13px] text-muted"><Monitor size={16} className="mt-0.5 shrink-0" />프롬프트 편집·교훈 승인·라우팅 예시는 데스크탑 작업대의 Agent 카탈로그에서 합니다.</div>
    </main>
  );
}

/**
 * Agent catalog on the phone (C-05, `/catalog`, `/catalog/:agentId`): the specialists the router can pick and,
 * per agent, its statistics, lessons, knowledge and versions — read-only; edits happen in the workbench.
 */
export function CatalogScreen() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<CatalogAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { aidevApi.agents().then((response) => setAgents(response.agents)).catch((err: Error) => setError(err.message)); }, []);
  const id = agentId ? Number(agentId) : null;
  if (id !== null && Number.isFinite(id)) {
    const agent = agents?.find((entry) => entry.id === id);
    return (
      <div className="m-app">
        <TopBar title={agent ? agent.name : 'agent'} subtitle={agent ? `v${agent.version} · 사용 ${agent.uses}회` : undefined} back="/catalog" />
        <AgentView id={id} />
      </div>
    );
  }
  return (
    <div className="m-app">
      <TopBar title="Agent 카탈로그" subtitle={agents ? `${agents.length}개` : undefined} back="/settings" />
      <main className="m-scroll flex-1 px-4 py-3 pb-safe-b" data-testid="catalog-list">
        {error ? <div className="py-2 text-[14px] text-danger">{error}</div> : null}
        {!agents && !error ? <div className="py-6 text-center text-[14px] text-muted m-pulse">불러오는 중…</div> : null}
        <div className="divide-y divide-line">
          {agents?.map((agent) => (
            <button key={agent.id} type="button" onClick={() => navigate(`/catalog/${agent.id}`)} className="w-full py-3 text-left">
              <div className="flex items-center gap-1.5">
                <Bot size={15} className={agent.domain === 'meta' ? 'text-muted' : 'text-accent'} />
                <span className="text-[15px] font-medium">{agent.name}</span>
                <span className="text-[12px] text-muted">v{agent.version}</span>
                {agent.verified ? <CheckCircle2 size={14} className="text-ok" /> : null}
                {agent.ownerId !== null ? <span className="ml-auto rounded bg-elevated px-1.5 text-[11px] text-muted">개인</span> : null}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[13px] text-muted">{agent.description}</div>
              <div className="mt-0.5 text-[11px] text-muted">{agent.domain} · 사용 {agent.uses}회</div>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
