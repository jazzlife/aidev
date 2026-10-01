import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';

import type { NormalizedMessage } from '@/modules/chat-core';
import { MessageBubble } from '@m/components/MessageBubble';

const RENDERED_KINDS = new Set(['text', 'stream_delta', 'tool_use', 'thinking', 'error']);

/** Used by ChatScreen: the transcript, auto-following the bottom while the user has not scrolled up. */
export function MessageList({ messages, loading, onMessageLongPress, footer }: { messages: NormalizedMessage[]; loading: boolean; onMessageLongPress?: (text: string) => void; /** shown after the last message (the session's remote results) */ footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const results = useMemo(() => {
    const map = new Map<string, NormalizedMessage>();
    for (const message of messages) if (message.kind === 'tool_result' && message.toolId) map.set(message.toolId, message);
    return map;
  }, [messages]);
  const rows = useMemo(() => messages.filter((message) => RENDERED_KINDS.has(message.kind)), [messages]);
  useEffect(() => {
    const element = ref.current;
    if (element && stickRef.current) element.scrollTop = element.scrollHeight;
  }, [rows]);
  return (
    <div ref={ref} className="m-scroll flex-1 py-2" onScroll={(event) => { const element = event.currentTarget; stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      {loading && rows.length === 0 ? <div className="px-4 py-6 text-muted text-sm m-pulse">불러오는 중…</div> : null}
      {!loading && rows.length === 0 ? <div className="px-6 py-10 text-center text-muted text-sm">무엇을 만들까요? 아래에 명령을 입력하세요.</div> : null}
      {rows.map((message) => <MessageBubble key={message.id} message={message} result={message.toolId ? results.get(message.toolId) : null} onLongPress={onMessageLongPress} />)}
      {footer}
    </div>
  );
}
