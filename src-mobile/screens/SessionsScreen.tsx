import { useEffect, useState } from 'react';
import { Plus, Settings } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '@/modules/chat-core';
import { TopBar } from '@m/components/TopBar';
import { relativeTime } from '@m/lib/format';

type Conversation = { sessionId: string; provider?: string; projectId?: string; projectDisplayName?: string; sessionTitle?: string; lastActivity?: string | null };

/** Mobile home: recent conversations across projects, newest first. */
export function SessionsScreen() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.recentConversations({ limit: 60 })
      .then(async (response) => {
        const payload = await response.json() as { data?: { conversations?: Conversation[] } };
        if (!response.ok) throw new Error(`목록을 불러오지 못했습니다 (${response.status})`);
        if (!cancelled) setItems(payload.data?.conversations ?? []);
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="m-app">
      <TopBar title="대화" right={<Link to="/settings" className="m-touch flex items-center justify-center rounded-full text-muted" aria-label="설정"><Settings size={20} /></Link>} />
      <main className="m-scroll flex-1 pb-24">
        {error ? <div className="p-4 text-danger text-sm">{error}</div> : null}
        {items === null && !error ? <div className="p-4 text-muted text-sm m-pulse">불러오는 중…</div> : null}
        {items && items.length === 0 ? <div className="p-6 text-center text-muted text-sm">아직 대화가 없습니다. 아래 + 로 시작하세요.</div> : null}
        <ul>
          {items?.map((item) => (
            <li key={item.sessionId} className="border-b border-line">
              <button type="button" className="w-full text-left px-4 py-3 active:bg-elevated" onClick={() => navigate(`/session/${encodeURIComponent(item.sessionId)}`)}>
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 min-w-0 truncate text-[15px]">{item.sessionTitle || '(제목 없음)'}</span>
                  <span className="text-[11px] text-muted shrink-0">{relativeTime(item.lastActivity)}</span>
                </div>
                <div className="text-[12px] text-muted truncate mt-0.5">
                  <span className="uppercase tracking-wide">{item.provider ?? ''}</span>{item.projectDisplayName ? ` · ${item.projectDisplayName}` : ''}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </main>
      <Link to="/new" aria-label="새 대화" className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom)+20px)] w-14 h-14 rounded-full bg-accent text-accent-ink shadow-lg flex items-center justify-center">
        <Plus size={26} />
      </Link>
    </div>
  );
}
