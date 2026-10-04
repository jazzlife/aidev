import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { NormalizedMessage } from '@/modules/chat-core';
import { MessageBubble, type PeekHandlers } from '@m/components/MessageBubble';

const RENDERED_KINDS = new Set(['text', 'stream_delta', 'tool_use', 'thinking', 'error']);
/** Scrolled this close to the top, the earlier page loads by itself. */
const OLDER_TRIGGER_PX = 160;

type MessageListProps = {
  messages: NormalizedMessage[];
  loading: boolean;
  /** long-press on a message: its actions (the row's text and the message itself) */
  onMessageLongPress?: (text: string, message: NormalizedMessage) => void;
  /** shown after the last message (the session's remote results) */
  footer?: ReactNode;
  /** the server has earlier messages than the ones loaded */
  hasMore?: boolean;
  onLoadOlder?: () => Promise<unknown>;
} & PeekHandlers;

/**
 * Used by ChatScreen: the transcript, auto-following the bottom while the user has not scrolled up. Long conversations
 * load the latest page first; scrolling to the top (or "이전 메시지 보기") prepends the earlier one and keeps the
 * message the user was looking at in place.
 */
export function MessageList({ messages, loading, onMessageLongPress, footer, onPeekFile, onPeekDiff, hasMore, onLoadOlder }: MessageListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // the distance from the bottom to keep while an earlier page is prepended
  const anchorRef = useRef<number | null>(null);
  // an earlier page is on its way (one at a time)
  const [loadingOlder, setLoadingOlder] = useState(false);
  const results = useMemo(() => {
    const map = new Map<string, NormalizedMessage>();
    for (const message of messages) if (message.kind === 'tool_result' && message.toolId) map.set(message.toolId, message);
    return map;
  }, [messages]);
  const rows = useMemo(() => messages.filter((message) => RENDERED_KINDS.has(message.kind)), [messages]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (anchorRef.current !== null) { element.scrollTop = element.scrollHeight - anchorRef.current; return; }
    if (stickRef.current) element.scrollTop = element.scrollHeight;
  }, [rows]);
  const loadOlder = async () => {
    const element = ref.current;
    if (!hasMore || loadingOlder || !onLoadOlder || !element) return;
    anchorRef.current = element.scrollHeight - element.scrollTop;
    setLoadingOlder(true);
    try { await onLoadOlder(); } finally {
      setLoadingOlder(false);
      requestAnimationFrame(() => { anchorRef.current = null; });
    }
  };
  return (
    <div ref={ref} className="m-scroll flex-1 py-2" data-testid="message-list" onScroll={(event) => {
      const element = event.currentTarget;
      stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      if (element.scrollTop < OLDER_TRIGGER_PX && rows.length) void loadOlder();
    }}>
      {hasMore && rows.length ? (
        <button type="button" onClick={() => { void loadOlder(); }} disabled={loadingOlder} className="mx-auto mb-1 block h-9 px-4 text-[13px] text-accent disabled:text-muted">{loadingOlder ? '불러오는 중…' : '이전 메시지 보기'}</button>
      ) : null}
      {loading && rows.length === 0 ? <div className="px-4 py-6 text-muted text-sm m-pulse">불러오는 중…</div> : null}
      {!loading && rows.length === 0 ? <div className="px-6 py-10 text-center text-muted text-sm">무엇을 만들까요? 아래에 명령을 입력하세요.</div> : null}
      {rows.map((message) => <MessageBubble key={message.id} message={message} result={message.toolId ? results.get(message.toolId) : null} onLongPress={onMessageLongPress} onPeekFile={onPeekFile} onPeekDiff={onPeekDiff} />)}
      {footer}
    </div>
  );
}
