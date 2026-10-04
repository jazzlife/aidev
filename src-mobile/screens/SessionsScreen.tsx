import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, MoreHorizontal, Plus, Search, Sparkles } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { aidevApi, useCreateProposals, type UnreadSession } from '@/modules/aidev-router';
import { ConversationActions, type ConversationChange } from '@m/components/ConversationActions';
import { ConversationSearch } from '@m/components/ConversationSearch';
import { HomeTabs } from '@m/components/HomeTabs';
import { ListSkeleton } from '@m/components/Skeleton';
import { TopBar } from '@m/components/TopBar';
import { relativeTime } from '@m/lib/format';
import { useLongPress } from '@m/lib/useLongPress';
import { useBackOverlay, useGo, useParent } from '@m/lib/nav';

type Conversation = { sessionId: string; provider?: string; projectId?: string | null; projectDisplayName?: string; sessionTitle?: string; lastActivity?: string | null };
type View = 'active' | 'hidden';
type Toast = { text: string; undo?: () => void };

async function readList(response: Response, key: 'conversations' | 'sessions') {
  const payload = await response.json() as { data?: Record<string, Conversation[] | undefined> };
  if (!response.ok) throw new Error(`목록을 불러오지 못했습니다 (${response.status})`);
  return payload.data?.[key] ?? [];
}

/** One row: tap opens the conversation; long-press or ⋯ opens its actions. */
function ConversationRow({ item, unread, onOpen, onActions }: { item: Conversation; /** C-06: news not looked at yet */ unread?: UnreadSession; onOpen: () => void; onActions: () => void }) {
  const press = useLongPress(onActions);
  return (
    <li className="border-b border-line flex items-stretch">
      <button type="button" className="flex-1 min-w-0 text-left pl-4 pr-1 py-3 active:bg-elevated" onClick={onOpen} {...press}>
        <div className="flex items-baseline gap-2">
          {unread ? <span aria-label="새 소식" className={`w-2 h-2 shrink-0 rounded-full self-center ${unread.code === 'run.failed' || unread.code === 'permission.required' ? 'bg-danger' : 'bg-accent'}`} /> : null}
          <span className={`flex-1 min-w-0 truncate text-[15px] ${unread ? 'font-semibold' : ''}`}>{item.sessionTitle || '(제목 없음)'}</span>
          <span className="text-[11px] text-muted shrink-0">{relativeTime(item.lastActivity)}</span>
        </div>
        <div className="text-[12px] text-muted truncate mt-0.5">
          {unread?.body ? <span className="text-ink">{unread.body}</span> : <><span className="uppercase tracking-wide">{item.provider ?? ''}</span>{item.projectDisplayName ? ` · ${item.projectDisplayName}` : ''}</>}
        </div>
      </button>
      <button type="button" aria-label="대화 메뉴" onClick={onActions} className="m-touch shrink-0 flex items-center justify-center px-2 text-muted active:bg-elevated"><MoreHorizontal size={18} /></button>
    </li>
  );
}

/**
 * Mobile home: recent conversations across projects, newest first. Long-press (or ⋯) a row for the conversation sheet
 * (rename, fork, hide — with undo — or delete); 🔍 searches titles and content; the archive button lists hidden
 * conversations to restore or delete.
 */
export function SessionsScreen() {
  const navigate = useGo();
  // the app's root: back here leaves the app (the hidden list closes first)
  useParent(null);
  const [view, setView] = useState<View>('active');
  useBackOverlay(view === 'hidden', () => setView('active'));
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Conversation | null>(null);
  // the search over every conversation (🔍), full screen
  const [searching, setSearching] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | null>(null);
  // C-06: sessions with news (run finished / failed / waiting for approval) since they were last opened
  const [unread, setUnread] = useState<Map<string, UnreadSession>>(new Map());
  // D-04: domains worked in repeatedly without a specialist; "만들기" opens a new chat that sends the creation turn
  const creation = useCreateProposals();

  const load = useCallback((which: View) => {
    setItems(null); setError(null);
    const request = which === 'active' ? api.recentConversations({ limit: 60 }).then((r) => readList(r, 'conversations')) : api.getArchivedSessions().then((r) => readList(r, 'sessions'));
    request.then(setItems).catch((err: Error) => setError(err.message));
  }, []);
  useEffect(() => { load(view); }, [load, view]);
  useEffect(() => {
    if (view !== 'active') return;
    aidevApi.notifyUnread().then((r) => {
      setUnread(new Map(r.sessions.map((s) => [s.session_id, s])));
      // the home-screen icon shows how many conversations have news (installed app, where supported)
      const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      void (r.sessions.length ? nav.setAppBadge?.(r.sessions.length) : nav.clearAppBadge?.())?.catch(() => undefined);
    }).catch(() => undefined);
  }, [view]);

  const showToast = (next: Toast) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  };
  const drop = (sessionId: string) => setItems((list) => list?.filter((entry) => entry.sessionId !== sessionId) ?? null);
  const changed = (change: ConversationChange) => {
    if (change.kind === 'renamed') setItems((list) => list?.map((entry) => (entry.sessionId === change.sessionId ? { ...entry, sessionTitle: change.title } : entry)) ?? null);
    else if (change.kind === 'forked') navigate(`/session/${encodeURIComponent(change.forkId)}`);
    else {
      drop(change.sessionId);
      if (change.kind === 'hidden') showToast({ text: '대화를 숨겼습니다', undo: () => { void api.restoreSession(change.sessionId).then(() => { setToast(null); load('active'); }); } });
      else showToast({ text: change.kind === 'restored' ? '대화를 다시 표시합니다' : '대화를 삭제했습니다' });
    }
  };

  const hidden = view === 'hidden';
  return (
    <div className="m-app">
      <TopBar
        title={hidden ? '숨긴 대화' : <HomeTabs active="conversations" />}
        left={hidden ? <button type="button" aria-label="대화 목록" onClick={() => setView('active')} className="m-touch flex items-center justify-center rounded-full"><ArrowLeft size={20} /></button> : undefined}
        right={hidden ? null : (
          <>
            <button type="button" aria-label="대화 검색" onClick={() => setSearching(true)} className="m-touch flex items-center justify-center rounded-full text-muted"><Search size={19} /></button>
            <button type="button" aria-label="숨긴 대화" onClick={() => setView('hidden')} className="m-touch flex items-center justify-center rounded-full text-muted"><Archive size={19} /></button>
          </>
        )}
      />
      <main className="m-scroll flex-1 pb-24">
        {error ? <div className="p-4 text-danger text-sm">{error}</div> : null}
        {items === null && !error ? <ListSkeleton /> : null}
        {items && items.length === 0 ? <div className="p-6 text-center text-muted text-sm">{hidden ? '숨긴 대화가 없습니다.' : '아직 대화가 없습니다. 아래 + 로 시작하세요.'}</div> : null}
        {!hidden ? creation.proposals?.map((entry) => (
          <div key={entry.id} className="mx-3 mt-3 rounded-xl2 border border-accent/40 bg-surface p-3" data-testid="create-proposal">
            <div className="flex items-center gap-1.5 text-[12px] text-muted"><Sparkles size={13} className="text-accent" /> 새 전문 agent 제안</div>
            <div className="mt-1 text-[15px] font-medium">{entry.name}</div>
            <div className="text-[13px] text-muted">'{entry.domain}' 작업을 {entry.count}번 했습니다. 이 분야 전문 agent를 만들까요?</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" className="h-10 rounded-xl bg-accent text-[14px] font-medium text-accent-ink" onClick={() => navigate('/new', { state: { compose: creation.accept(entry) } })}>만들기</button>
              <button type="button" className="h-10 rounded-xl border border-line text-[14px]" onClick={() => creation.dismiss(entry)}>그만</button>
            </div>
          </div>
        )) : null}
        {items && items.length > 0 && !hidden ? <div className="px-4 pt-2 pb-1 text-[11px] text-muted">길게 누르면 이름 변경·분기·숨기기·삭제</div> : null}
        <ul>
          {items?.map((item) => (
            <ConversationRow key={item.sessionId} item={item} unread={hidden ? undefined : unread.get(item.sessionId)} onOpen={() => navigate(`/session/${encodeURIComponent(item.sessionId)}`)} onActions={() => setTarget(item)} />
          ))}
        </ul>
      </main>

      <ConversationActions target={target ? { sessionId: target.sessionId, title: target.sessionTitle ?? '', provider: target.provider, hidden } : null} onClose={() => setTarget(null)} onChange={changed} />
      {searching ? <ConversationSearch onClose={() => setSearching(false)} /> : null}

      {toast ? (
        <div className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+88px)] z-30 flex items-center gap-3 rounded-xl bg-ink text-bg px-4 py-3 text-[14px] shadow-lg" role="status">
          <span className="flex-1">{toast.text}</span>
          {toast.undo ? <button type="button" className="font-semibold text-accent" onClick={toast.undo}>되돌리기</button> : null}
        </div>
      ) : null}

      {!hidden ? (
        <button type="button" onClick={() => navigate('/new')} aria-label="새 대화" className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom)+20px)] w-14 h-14 rounded-full bg-accent text-accent-ink shadow-lg flex items-center justify-center">
          <Plus size={26} />
        </button>
      ) : null}
    </div>
  );
}
