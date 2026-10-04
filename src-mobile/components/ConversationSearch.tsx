import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { useBackOverlay, useGo } from '@m/lib/nav';

/** One conversation found: by its title, or by what was said in it (the first matching snippet). */
type Hit = { sessionId: string; title: string; projectName: string; provider?: string; snippet?: string };
type TitleResult = { sessionId: string; provider?: string; projectDisplayName?: string; sessionTitle?: string };
type ProjectResult = { projectDisplayName?: string; sessions?: Array<{ sessionId: string; sessionSummary?: string; provider?: string; matches?: Array<{ snippet?: string }> }> };

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

/**
 * Used by the conversation list (🔍): searches every conversation's title and content on the runtime (the workbench's
 * search stream). Title matches come first; a conversation found both ways shows once. Tap opens it.
 */
export function ConversationSearch({ onClose }: { onClose: () => void }) {
  const go = useGo();
  useBackOverlay(true, onClose);
  // the words typed
  const [query, setQuery] = useState('');
  // conversations found so far for the current words (null: not searched yet)
  const [hits, setHits] = useState<Hit[] | null>(null);
  // the stream is still sending results
  const [searching, setSearching] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    const words = query.trim();
    if (words.length < MIN_CHARS) { setHits(null); setSearching(false); return undefined; }
    const timer = window.setTimeout(() => {
      const source = new EventSource(api.searchConversationsUrl(words, 50));
      sourceRef.current = source;
      let titles: Hit[] = [];
      let content: Hit[] = [];
      const publish = () => {
        const seen = new Set(titles.map((hit) => hit.sessionId));
        setHits([...titles, ...content.filter((hit) => !seen.has(hit.sessionId))]);
      };
      setSearching(true);
      setHits([]);
      source.addEventListener('title-results', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data as string) as { titleResults?: TitleResult[] };
          titles = (data.titleResults ?? []).map((r) => ({ sessionId: r.sessionId, title: r.sessionTitle || '(제목 없음)', projectName: r.projectDisplayName ?? '', provider: r.provider }));
          publish();
        } catch { /* a malformed event is skipped */ }
      });
      source.addEventListener('result', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data as string) as { projectResult?: ProjectResult };
          const project = data.projectResult;
          for (const session of project?.sessions ?? []) {
            if (content.some((hit) => hit.sessionId === session.sessionId)) continue;
            content = [...content, { sessionId: session.sessionId, title: session.sessionSummary || '(제목 없음)', projectName: project?.projectDisplayName ?? '', provider: session.provider, snippet: session.matches?.[0]?.snippet }];
          }
          publish();
        } catch { /* a malformed event is skipped */ }
      });
      const end = () => { source.close(); if (sourceRef.current === source) { sourceRef.current = null; setSearching(false); } };
      source.addEventListener('done', end);
      source.addEventListener('error', end);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => () => sourceRef.current?.close(), []);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label="대화 검색" data-testid="conversation-search">
      <div className="pt-safe-t border-b border-line">
        <div className="flex h-12 items-center gap-1 px-2">
          <button type="button" aria-label="검색 닫기" onClick={onClose} className="m-touch flex items-center justify-center rounded-full"><ArrowLeft size={20} /></button>
          <div className="flex h-9 flex-1 items-center gap-2 rounded-xl bg-elevated px-3">
            <Search size={16} className="shrink-0 text-muted" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="대화 제목·내용 검색" aria-label="검색어" enterKeyHint="search" className="min-w-0 flex-1 bg-transparent text-[16px] outline-none" />
            {query ? <button type="button" aria-label="지우기" onClick={() => setQuery('')} className="text-muted"><X size={16} /></button> : null}
          </div>
        </div>
      </div>
      <main className="m-scroll flex-1 pb-8">
        {query.trim().length > 0 && query.trim().length < MIN_CHARS ? <div className="p-4 text-[13px] text-muted">두 글자 이상 입력하세요</div> : null}
        {searching && !hits?.length ? <div className="p-4 text-[13px] text-muted m-pulse">찾는 중…</div> : null}
        {!searching && hits && hits.length === 0 ? <div className="p-6 text-center text-[14px] text-muted">찾은 대화가 없습니다</div> : null}
        <ul>
          {hits?.map((hit) => (
            <li key={hit.sessionId} className="border-b border-line">
              <button type="button" onClick={() => { onClose(); go(`/session/${encodeURIComponent(hit.sessionId)}`); }} className="w-full px-4 py-3 text-left active:bg-elevated">
                <div className="truncate text-[15px]">{hit.title}</div>
                {hit.snippet ? <div className="mt-0.5 line-clamp-2 text-[13px] text-ink/80">{hit.snippet}</div> : null}
                <div className="mt-0.5 truncate text-[12px] text-muted"><span className="uppercase tracking-wide">{hit.provider ?? ''}</span>{hit.projectName ? ` · ${hit.projectName}` : ''}</div>
              </button>
            </li>
          ))}
        </ul>
        {searching && hits?.length ? <div className="p-3 text-center text-[12px] text-muted m-pulse">더 찾는 중…</div> : null}
      </main>
    </div>
  );
}
