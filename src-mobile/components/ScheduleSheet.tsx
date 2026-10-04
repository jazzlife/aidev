import { useCallback, useEffect, useState } from 'react';
import { Clock, X } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { failureText } from '@m/lib/http';

/** A message the server will send to the conversation later. */
export type Scheduled = { id: string; content: string; scheduledFor: string; status: 'pending' | 'sent' | 'failed' | 'cancelled'; failureReason: string | null };

/** Used by ChatScreen: the conversation's scheduled messages (the server keeps the timer), and making or cancelling one. */
export function useScheduledMessages(sessionId: string | null) {
  // the conversation's scheduled messages, as the server last listed them
  const [items, setItems] = useState<Scheduled[]>([]);
  const refresh = useCallback(async () => {
    if (!sessionId) { setItems([]); return; }
    try {
      const response = await api.scheduledMessages.list(sessionId);
      const body = await response.json() as { data?: Scheduled[] };
      setItems(Array.isArray(body.data) ? body.data : []);
    } catch { /* the list stays as it was */ }
  }, [sessionId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const schedule = useCallback(async (content: string, at: Date, options: Record<string, unknown>) => {
    if (!sessionId) throw new Error('대화가 아직 없습니다');
    const response = await api.scheduledMessages.create({ sessionId, content, scheduledFor: at.toISOString(), options });
    if (!response.ok) throw new Error(await failureText(response));
    await refresh();
  }, [refresh, sessionId]);
  const cancel = useCallback(async (id: string) => {
    const response = await api.scheduledMessages.cancel(id);
    if (!response.ok) throw new Error(await failureText(response));
    await refresh();
  }, [refresh]);
  const pending = items.filter((item) => item.status === 'pending');
  return { items, pending, schedule, cancel, refresh };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `<input type="datetime-local">` value for a time on this phone's clock. */
export const toLocalInput = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function quickTimes(now: Date): Array<{ label: string; at: Date }> {
  const tomorrow9 = new Date(now); tomorrow9.setDate(now.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0);
  return [
    { label: '30분 뒤', at: new Date(now.getTime() + 30 * 60_000) },
    { label: '1시간 뒤', at: new Date(now.getTime() + 60 * 60_000) },
    { label: '내일 오전 9시', at: tomorrow9 },
  ];
}

/**
 * Used by ChatScreen: "예약 보내기" (the send button held down) picks a time for the composer's text; "예약된 메시지"
 * (the conversation sheet) lists the waiting ones, each cancellable.
 */
export function ScheduleSheet({ mode, text, scheduled, onSchedule, onCancel, onClose }: {
  mode: 'create' | 'list' | null; text: string; scheduled: Scheduled[];
  onSchedule: (at: Date) => Promise<void>; onCancel: (id: string) => Promise<void>; onClose: () => void;
}) {
  // the time picked (the phone's clock), as the time field holds it
  const [at, setAt] = useState('');
  // one request at a time
  const [busy, setBusy] = useState(false);
  // the server's message when scheduling or cancelling failed
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (mode) { setAt(toLocalInput(new Date(Date.now() + 60 * 60_000))); setError(null); setBusy(false); } }, [mode]);
  const run = async (action: () => Promise<void>, closeAfter: boolean) => {
    setBusy(true); setError(null);
    try { await action(); if (closeAfter) onClose(); } catch (err) { setError(err instanceof Error ? err.message : '실패했습니다'); } finally { setBusy(false); }
  };
  const picked = at ? new Date(at) : null;
  const valid = Boolean(picked && !Number.isNaN(picked.getTime()) && picked.getTime() > Date.now());
  return (
    <BottomSheet open={mode !== null} onClose={onClose} title={mode === 'create' ? '예약 보내기' : `예약된 메시지 ${scheduled.length}`}>
      {mode === 'create' ? (
        <div className="space-y-3" data-testid="schedule-create">
          <div className="line-clamp-3 rounded-xl bg-elevated px-3 py-2 text-[14px] whitespace-pre-wrap">{text}</div>
          <div className="flex flex-wrap gap-2">
            {quickTimes(new Date()).map((q) => <button key={q.label} type="button" onClick={() => setAt(toLocalInput(q.at))} className="h-9 rounded-full border border-line px-3 text-[13px]">{q.label}</button>)}
          </div>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="보낼 시각" className="w-full h-11 rounded-xl border border-line bg-bg px-3 text-[15px]" />
          <button type="button" disabled={busy || !valid} onClick={() => { if (picked) void run(() => onSchedule(picked), true); }}
            className="w-full h-12 rounded-xl bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-40">{busy ? '예약 중…' : valid && picked ? `${when(picked.toISOString())}에 보내기` : '지금 이후 시각을 고르세요'}</button>
        </div>
      ) : null}
      {mode === 'list' ? (
        <ul className="space-y-2" data-testid="schedule-list">
          {scheduled.length === 0 ? <li className="text-[14px] text-muted">예약된 메시지가 없습니다. 보내기 버튼을 길게 누르면 예약합니다.</li> : null}
          {scheduled.map((item) => (
            <li key={item.id} className="flex items-start gap-2 rounded-xl border border-line px-3 py-2">
              <Clock size={15} className="mt-0.5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1"><div className="text-[12px] text-muted">{when(item.scheduledFor)}</div><div className="line-clamp-2 text-[14px]">{item.content}</div></div>
              <button type="button" aria-label="예약 취소" disabled={busy} onClick={() => { void run(() => onCancel(item.id), false); }} className="m-touch -my-2 -mr-2 flex items-center justify-center text-muted"><X size={17} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="mt-2 text-[13px] text-danger" role="alert">{error}</div> : null}
    </BottomSheet>
  );
}
