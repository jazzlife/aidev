import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Bot, CheckCircle2, ChevronLeft, ListChecks, Plus, RefreshCw, Sparkles } from 'lucide-react';

import { aidevApi, type CatalogAgent } from '@/modules/aidev-router/api';
import { routingStore } from '@/modules/aidev-router/store';

type AgentDetail = {
  agent: CatalogAgent;
  knowledge: Array<{ id: number; title: string; source_url: string | null; source_date: string | null; status: string }>;
  lessons: Array<{ id: number; trigger: string; rule: string; status: string; hits: number }>;
  stats: { runs: number; success: number | null; fail: number | null; avg_ms: number | null };
  versions: Array<{ version: number; changelog: string | null; createdAt: number }>;
};

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
    aidevApi.agent(id).then((response) => setDetail(response as unknown as AgentDetail)).catch((err: Error) => setError(err.message));
    aidevApi.agentExamples(id).then((response) => setExamples(response.examples)).catch(() => setExamples([]));
  }, []);
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
      <div className="h-full flex flex-col text-[12px]">
        <div className="flex items-center gap-2 px-3 h-8 border-b border-border text-muted-foreground">
          <span>{agents ? `${agents.length}개` : '불러오는 중…'}</span>
          <button type="button" onClick={loadList} aria-label="새로고침" className="ml-auto p-1 rounded hover:bg-accent"><RefreshCw size={12} /></button>
        </div>
        {error ? <div className="px-3 py-2 text-red-600">{error}</div> : null}
        <div className="flex-1 overflow-auto">
          {agents?.map((agent) => (
            <button key={agent.id} type="button" onClick={() => setSelected(agent.id)} className="w-full text-left px-3 py-2 border-b border-border/60 hover:bg-accent/50">
              <div className="flex items-center gap-1.5">
                <Bot size={13} className={agent.domain === 'meta' ? 'text-muted-foreground' : 'text-primary'} />
                <span className="font-medium">{agent.name}</span>
                <span className="text-muted-foreground">v{agent.version}</span>
                {agent.ownerId !== null ? <span className="ml-auto rounded bg-muted px-1 text-[10px]">개인</span> : null}
                {agent.verified ? <CheckCircle2 size={12} className="text-emerald-600" /> : null}
              </div>
              <div className="text-muted-foreground line-clamp-2 mt-0.5">{agent.hint ? <span className="text-foreground/70">[{agent.hint}] </span> : null}{agent.description}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{agent.domain} · 사용 {agent.uses}회</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const agent = detail?.agent;
  return (
    <div className="h-full flex flex-col text-[12px]">
      <div className="flex items-center gap-1 px-2 h-8 border-b border-border">
        <button type="button" onClick={() => setSelected(null)} aria-label="목록" className="p-1 rounded hover:bg-accent"><ChevronLeft size={14} /></button>
        <span className="font-medium truncate">{agent?.name ?? '…'}</span>
        {agent ? <span className="text-muted-foreground">v{agent.version}</span> : null}
        {agent && agent.domain !== 'meta' ? <button type="button" title="다음 명령을 이 agent로 보내기" onClick={() => routingStore.setOverrides({ agent: agent.name })} className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded border border-border hover:bg-accent"><Sparkles size={11} /> 다음 명령에 사용</button> : null}
      </div>
      {error ? <div className="px-3 py-2 text-red-600">{error}</div> : null}
      {!detail ? <div className="p-3 text-muted-foreground">불러오는 중…</div> : (
        <div className="flex-1 overflow-auto px-3 py-2 space-y-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md bg-muted/60 py-1.5"><div className="text-[10px] text-muted-foreground">실행</div><div className="font-medium">{detail.stats.runs}</div></div>
            <div className="rounded-md bg-muted/60 py-1.5"><div className="text-[10px] text-muted-foreground">성공률</div><div className="font-medium">{detail.stats.runs ? `${Math.round(((detail.stats.success ?? 0) / detail.stats.runs) * 100)}%` : '-'}</div></div>
            <div className="rounded-md bg-muted/60 py-1.5"><div className="text-[10px] text-muted-foreground">평균 시간</div><div className="font-medium">{detail.stats.avg_ms ? `${Math.round(detail.stats.avg_ms / 1000)}s` : '-'}</div></div>
          </div>
          {editing ? (
            <div className="space-y-1.5">
              <input className="w-full rounded border border-border bg-background px-2 py-1" value={editing.hint} onChange={(event) => setEditing({ ...editing, hint: event.target.value })} placeholder="라우팅 힌트 (4~7 영단어)" />
              <textarea className="w-full rounded border border-border bg-background px-2 py-1 h-16" value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} />
              <textarea className="w-full rounded border border-border bg-background px-2 py-1 h-48 font-mono text-[11px]" value={editing.prompt} onChange={(event) => setEditing({ ...editing, prompt: event.target.value })} />
              <input className="w-full rounded border border-border bg-background px-2 py-1" value={editing.changelog} onChange={(event) => setEditing({ ...editing, changelog: event.target.value })} placeholder="변경 이유 (새 버전에 기록)" />
              <div className="flex gap-2"><button type="button" onClick={save} className="h-7 px-3 rounded bg-primary text-primary-foreground">새 버전으로 저장</button><button type="button" onClick={() => setEditing(null)} className="h-7 px-3 rounded border border-border">취소</button></div>
            </div>
          ) : (
            <div>
              <div className="text-muted-foreground">{agent!.hint ? `[${agent!.hint}] ` : ''}{agent!.description}</div>
              <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] bg-muted/40 rounded p-2 max-h-56 overflow-auto">{agent!.prompt}</pre>
              <button type="button" onClick={() => setEditing({ prompt: agent!.prompt, description: agent!.description, hint: agent!.hint ?? '', changelog: '' })} className="mt-1 h-7 px-2 rounded border border-border">편집 (새 버전)</button>
            </div>
          )}
          <section>
            <div className="flex items-center gap-1 text-muted-foreground mb-1"><ListChecks size={12} /> 라우팅 예시 {examples.length}</div>
            <div className="flex gap-1">
              <input className="flex-1 rounded border border-border bg-background px-2 py-1" value={newExample} onChange={(event) => setNewExample(event.target.value)} placeholder="이 agent로 가야 할 명령 예시 추가" onKeyDown={(event) => { if (event.key === 'Enter') void addExample(); }} />
              <button type="button" onClick={addExample} aria-label="추가" className="h-7 w-7 rounded border border-border flex items-center justify-center"><Plus size={12} /></button>
            </div>
            <ul className="mt-1 max-h-32 overflow-auto text-muted-foreground">{examples.slice(0, 40).map((example) => <li key={example.id} className="truncate">· {example.text} <span className="text-[10px]">({example.source})</span></li>)}</ul>
          </section>
          <section>
            <div className="flex items-center gap-1 text-muted-foreground mb-1"><BookOpen size={12} /> 지식 {detail.knowledge.length}</div>
            <ul className="text-muted-foreground">{detail.knowledge.map((item) => <li key={item.id} className="truncate">· <span className={item.status === 'verified' ? 'text-emerald-600' : item.status === 'sourced' ? 'text-foreground/80' : ''}>[{item.status}]</span> {item.title}{item.source_date ? ` (${item.source_date})` : ''}</li>)}</ul>
          </section>
          <section>
            <div className="text-muted-foreground mb-1">교훈 {detail.lessons.length}</div>
            <ul className="text-muted-foreground space-y-1">{detail.lessons.map((lesson) => (
              <li key={lesson.id}>
                <span className={lesson.status === 'verified' ? 'text-emerald-600' : lesson.status === 'candidate' ? 'text-amber-600' : ''}>[{lesson.status}]</span> {lesson.trigger} → {lesson.rule}
                {lesson.status === 'candidate' ? (
                  <span className="ml-1 inline-flex gap-1">
                    <button type="button" className="px-1 rounded border border-border hover:bg-accent" onClick={() => { void aidevApi.updateLesson(lesson.id, { status: 'verified' }).then(() => loadDetail(detail.agent.id)); }}>승인</button>
                    <button type="button" className="px-1 rounded border border-border hover:bg-accent" onClick={() => { void aidevApi.updateLesson(lesson.id, { status: 'rejected' }).then(() => loadDetail(detail.agent.id)); }}>거절</button>
                  </span>
                ) : null}
              </li>
            ))}</ul>
          </section>
          <section>
            <div className="text-muted-foreground mb-1">버전</div>
            <ul className="text-muted-foreground">{detail.versions.map((version) => <li key={version.version}>· v{version.version} {version.changelog ?? ''} <span className="text-[10px]">{new Date(version.createdAt).toLocaleDateString()}</span></li>)}</ul>
          </section>
        </div>
      )}
    </div>
  );
}
