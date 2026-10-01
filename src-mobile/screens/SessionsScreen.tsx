import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, EyeOff, MoreHorizontal, Plus, RotateCcw, Settings, Sparkles, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '@/modules/chat-core';
import { aidevApi, useCreateProposals, type UnreadSession } from '@/modules/aidev-router';
import { BottomSheet } from '@m/components/BottomSheet';
import { RemoteMenu } from '@m/components/RemoteMenu';
import { TopBar } from '@m/components/TopBar';
import { relativeTime } from '@m/lib/format';
import { useLongPress } from '@m/lib/useLongPress';

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
 * Mobile home: recent conversations across projects, newest first. Long-press (or ⋯) a row to hide
 * it (archive — reversible, with undo) or delete it for good after a confirmation; the archive
 * button in the top bar lists hidden conversations to restore or delete.
 */
export function SessionsScreen() {
  const navigate = useNavigate();
  const [view, setView] = useState<View>('active');
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Conversation | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const closeSheet = () => { setTarget(null); setConfirmDelete(false); };
  const drop = (sessionId: string) => setItems((list) => list?.filter((entry) => entry.sessionId !== sessionId) ?? null);

  const act = async (action: 'hide' | 'restore' | 'delete') => {
    if (!target) return;
    const item = target;
    setBusy(true);
    try {
      const response = action === 'hide' ? await api.deleteSession(item.sessionId, false)
        : action === 'restore' ? await api.restoreSession(item.sessionId)
          : await api.deleteSession(item.sessionId, true);
      if (!response.ok) throw new Error(`실패했습니다 (${response.status})`);
      drop(item.sessionId);
      closeSheet();
      if (action === 'hide') {
        showToast({ text: '대화를 숨겼습니다', undo: () => { void api.restoreSession(item.sessionId).then(() => { setToast(null); load('active'); }); } });
      } else {
        showToast({ text: action === 'restore' ? '대화를 다시 표시합니다' : '대화를 삭제했습니다' });
      }
    } catch (err) {
      showToast({ text: err instanceof Error ? err.message : '실패했습니다' });
    } finally {
      setBusy(false);
    }
  };

  const hidden = view === 'hidden';
  const sheetButton = 'w-full h-12 rounded-xl flex items-center gap-3 px-4 text-[15px] active:bg-elevated disabled:opacity-50';
  return (
    <div className="m-app">
      <TopBar
        title={hidden ? '숨긴 대화' : '대화'}
        left={hidden ? <button type="button" aria-label="대화 목록" onClick={() => setView('active')} className="m-touch flex items-center justify-center rounded-full"><ArrowLeft size={20} /></button> : undefined}
        right={hidden ? null : (
          <div className="flex items-center">
            <RemoteMenu />
            <button type="button" aria-label="숨긴 대화" onClick={() => setView('hidden')} className="m-touch flex items-center justify-center rounded-full text-muted"><Archive size={19} /></button>
            <Link to="/settings" className="m-touch flex items-center justify-center rounded-full text-muted" aria-label="설정"><Settings size={20} /></Link>
          </div>
        )}
      />
      <main className="m-scroll flex-1 pb-24">
        {error ? <div className="p-4 text-danger text-sm">{error}</div> : null}
        {items === null && !error ? <div className="p-4 text-muted text-sm m-pulse">불러오는 중…</div> : null}
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
        {items && items.length > 0 && !hidden ? <div className="px-4 pt-2 pb-1 text-[11px] text-muted">길게 누르면 숨기기·삭제</div> : null}
        <ul>
          {items?.map((item) => (
            <ConversationRow key={item.sessionId} item={item} unread={hidden ? undefined : unread.get(item.sessionId)} onOpen={() => navigate(`/session/${encodeURIComponent(item.sessionId)}`)} onActions={() => { setConfirmDelete(false); setTarget(item); }} />
          ))}
        </ul>
      </main>

      <BottomSheet open={Boolean(target)} onClose={closeSheet} title={<span className="block truncate">{target?.sessionTitle || '(제목 없음)'}</span>}>
        {!confirmDelete ? (
          <div className="space-y-1">
            {hidden
              ? <button type="button" className={sheetButton} disabled={busy} onClick={() => { void act('restore'); }}><RotateCcw size={18} /> 다시 표시</button>
              : <button type="button" className={sheetButton} disabled={busy} onClick={() => { void act('hide'); }}><EyeOff size={18} /> 숨기기<span className="ml-auto text-[12px] text-muted">되돌릴 수 있음</span></button>}
            <button type="button" className={`${sheetButton} text-danger`} disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={18} /> 삭제</button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[14px] text-muted">대화 기록까지 영구 삭제합니다. 되돌릴 수 없습니다.</p>
            <button type="button" className="w-full h-12 rounded-xl bg-danger text-white text-[15px] font-medium disabled:opacity-50" disabled={busy} onClick={() => { void act('delete'); }}>{busy ? '삭제 중…' : '영구 삭제'}</button>
            <button type="button" className="w-full h-12 rounded-xl border border-line text-[15px]" onClick={() => setConfirmDelete(false)}>취소</button>
          </div>
        )}
      </BottomSheet>

      {toast ? (
        <div className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+88px)] z-30 flex items-center gap-3 rounded-xl bg-ink text-bg px-4 py-3 text-[14px] shadow-lg" role="status">
          <span className="flex-1">{toast.text}</span>
          {toast.undo ? <button type="button" className="font-semibold text-accent" onClick={toast.undo}>되돌리기</button> : null}
        </div>
      ) : null}

      {!hidden ? (
        <Link to="/new" aria-label="새 대화" className="fixed right-5 bottom-[calc(env(safe-area-inset-bottom)+20px)] w-14 h-14 rounded-full bg-accent text-accent-ink shadow-lg flex items-center justify-center">
          <Plus size={26} />
        </Link>
      ) : null}
    </div>
  );
}
