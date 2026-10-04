import { useEffect, useState, type ReactNode } from 'react';
import { EyeOff, GitFork, Pencil, RotateCcw, Trash2 } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { forgetConversation, readCurrentConversation, setCurrentConversation } from '@m/lib/current';
import { failureText, okJson } from '@m/lib/http';
import { useCapsMap } from '@m/lib/chatOptions';

/** The conversation a sheet acts on (any list row, or the open chat). */
export type ConversationTarget = { sessionId: string; title: string; provider?: string; hidden?: boolean };

/** What changed, for the screen that opened the sheet to update itself. */
export type ConversationChange =
  | { kind: 'renamed'; sessionId: string; title: string }
  | { kind: 'hidden' | 'restored' | 'deleted'; sessionId: string }
  | { kind: 'forked'; sessionId: string; forkId: string };

type View = 'menu' | 'rename' | 'delete';

export const sheetButton = 'w-full h-12 rounded-xl flex items-center gap-3 px-4 text-[15px] text-left active:bg-elevated disabled:opacity-50';

/**
 * The one conversation sheet (C-12.3), the same from the conversation list (long-press or ⋯), a project's list and the
 * chat's ⋯: rename, fork (engines that support it), hide / show again, delete for good after a confirmation. `extra`
 * puts the chat's own entries (tokens, export, scheduled messages) on top.
 */
export function ConversationActions({ target, onClose, onChange, extra }: { target: ConversationTarget | null; onClose: () => void; onChange: (change: ConversationChange) => void; extra?: ReactNode }) {
  const caps = useCapsMap(Boolean(target));
  // which part of the sheet is shown: the actions, the rename field or the delete confirmation
  const [view, setView] = useState<View>('menu');
  // the name being typed in the rename view
  const [name, setName] = useState('');
  // one request at a time; the buttons wait for it
  const [busy, setBusy] = useState(false);
  // the server's message when an action failed
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setView('menu'); setError(null); setBusy(false); setName(target?.title ?? ''); }, [target]);
  if (!target) return null;
  const canFork = Boolean(target.provider && caps?.[target.provider]?.supportsSessionForking);

  const run = async (action: () => Promise<ConversationChange>) => {
    setBusy(true); setError(null);
    try {
      const change = await action();
      if (change.kind === 'renamed' && readCurrentConversation()?.sessionId === change.sessionId) {
        const current = readCurrentConversation();
        if (current) setCurrentConversation({ ...current, title: change.title });
      }
      if (change.kind === 'hidden' || change.kind === 'deleted') forgetConversation(change.sessionId);
      onChange(change);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '실패했습니다');
    } finally {
      setBusy(false);
    }
  };
  const id = target.sessionId;
  const rename = () => run(async () => {
    const title = name.trim();
    const response = await api.renameSession(id, title);
    if (!response.ok) throw new Error(await failureText(response));
    return { kind: 'renamed', sessionId: id, title };
  });
  const fork = () => run(async () => {
    const body = await okJson<{ data?: { sessionId?: string } }>(await api.forkSession(id));
    if (!body.data?.sessionId) throw new Error('분기한 대화를 받지 못했습니다');
    return { kind: 'forked', sessionId: id, forkId: body.data.sessionId };
  });
  const hide = (restore: boolean) => run(async () => {
    const response = restore ? await api.restoreSession(id) : await api.deleteSession(id, false);
    if (!response.ok) throw new Error(await failureText(response));
    return { kind: restore ? 'restored' : 'hidden', sessionId: id };
  });
  const remove = () => run(async () => {
    const response = await api.deleteSession(id, true);
    if (!response.ok) throw new Error(await failureText(response));
    return { kind: 'deleted', sessionId: id };
  });

  return (
    <BottomSheet open onClose={onClose} title={<span className="block truncate">{target.title || '(제목 없음)'}</span>}>
      <div data-testid="conversation-actions">
        {view === 'menu' ? (
          <div className="space-y-1">
            {extra}
            <button type="button" className={sheetButton} disabled={busy} onClick={() => setView('rename')}><Pencil size={18} /> 이름 변경</button>
            {canFork ? <button type="button" className={sheetButton} disabled={busy} onClick={() => { void fork(); }}><GitFork size={18} /> 분기<span className="ml-auto text-[12px] text-muted">새 대화로 이어가기</span></button> : null}
            {target.hidden
              ? <button type="button" className={sheetButton} disabled={busy} onClick={() => { void hide(true); }}><RotateCcw size={18} /> 다시 표시</button>
              : <button type="button" className={sheetButton} disabled={busy} onClick={() => { void hide(false); }}><EyeOff size={18} /> 숨기기<span className="ml-auto text-[12px] text-muted">되돌릴 수 있음</span></button>}
            <button type="button" className={`${sheetButton} text-danger`} disabled={busy} onClick={() => setView('delete')}><Trash2 size={18} /> 삭제</button>
          </div>
        ) : null}
        {view === 'rename' ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void rename(); }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="대화 이름" className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-accent" />
            <div className="flex gap-2">
              <button type="button" className="h-11 flex-1 rounded-xl border border-line text-[15px]" onClick={() => setView('menu')}>취소</button>
              <button type="submit" disabled={busy || !name.trim()} className="h-11 flex-1 rounded-xl bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-40">저장</button>
            </div>
          </form>
        ) : null}
        {view === 'delete' ? (
          <div className="space-y-3">
            <p className="text-[14px] text-muted">대화 기록까지 영구 삭제합니다. 되돌릴 수 없습니다.</p>
            <button type="button" className="w-full h-12 rounded-xl bg-danger text-white text-[15px] font-medium disabled:opacity-50" disabled={busy} onClick={() => { void remove(); }}>{busy ? '삭제 중…' : '영구 삭제'}</button>
            <button type="button" className="w-full h-12 rounded-xl border border-line text-[15px]" onClick={() => setView('menu')}>취소</button>
          </div>
        ) : null}
        {error ? <div className="mt-2 text-[13px] text-danger" role="alert">{error}</div> : null}
      </div>
    </BottomSheet>
  );
}
