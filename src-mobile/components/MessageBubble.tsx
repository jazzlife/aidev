import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Wrench } from 'lucide-react';

import { parseToolPayload, type NormalizedMessage } from '@/modules/chat-core';
import { Prose } from '@m/lib/markdown';
import { clampText } from '@m/lib/format';
import { useLongPress } from '@m/lib/useLongPress';

function summarizeInput(input: unknown): string {
  const parsed = parseToolPayload(input);
  if (!parsed || typeof parsed !== 'object') return typeof parsed === 'string' ? clampText(parsed, 120) : '';
  const record = parsed as Record<string, unknown>;
  const keys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description'];
  for (const key of keys) {
    if (typeof record[key] === 'string') return clampText(record[key] as string, 120);
  }
  return clampText(JSON.stringify(record), 120);
}

/** Used by MessageList: one transcript row — user bubble, assistant prose, or a collapsible tool/thinking card. */
export function MessageBubble({ message, result, onLongPress }: { message: NormalizedMessage; result?: NormalizedMessage | null; /** text messages: long-press opens the copy sheet (text selection is off in the app) */ onLongPress?: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const text = message.kind === 'text' || message.kind === 'stream_delta' ? String((message.role === 'user' ? message.displayText || message.content : message.content) ?? '') : '';
  const press = useLongPress(() => { if (text) onLongPress?.(text); });
  if (message.kind === 'text' && message.role === 'user') {
    return (
      <div className="flex justify-end px-3 py-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent text-accent-ink px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words" {...press}>{text}</div>
      </div>
    );
  }
  if (message.kind === 'text' || message.kind === 'stream_delta') {
    return (
      <div className="px-3 py-1" {...press}>
        <Prose text={message.content ?? ''} />
        {message.kind === 'stream_delta' ? <span className="inline-block w-2 h-4 bg-accent/70 m-pulse align-middle ml-0.5 rounded-sm" /> : null}
      </div>
    );
  }
  if (message.kind === 'tool_use') {
    const isError = Boolean(result?.toolResult?.isError);
    return (
      <div className="px-3 py-0.5">
        <button type="button" onClick={() => setOpen((value) => !value)} className={`w-full text-left rounded-xl border px-3 py-2 flex items-start gap-2 bg-surface ${isError ? 'border-danger/50' : 'border-line'}`}>
          <Wrench size={14} className="mt-0.5 text-muted shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="text-[13px] font-medium">{message.toolName}</span>
            <span className="block text-[12px] text-muted truncate">{summarizeInput(message.toolInput)}</span>
          </span>
          {open ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
        </button>
        {open ? (
          <div className="mt-1 rounded-xl bg-elevated border border-line p-2 text-[12px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto">
            {JSON.stringify(parseToolPayload(message.toolInput), null, 1)}
            {result?.toolResult ? <div className={`mt-2 pt-2 border-t border-line ${isError ? 'text-danger' : ''}`}>{clampText(String(result.toolResult.content ?? ''), 4000)}</div> : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (message.kind === 'thinking') {
    return (
      <div className="px-3 py-0.5">
        <button type="button" onClick={() => setOpen((value) => !value)} className="text-[12px] text-muted flex items-center gap-1">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 생각
        </button>
        {open ? <div className="text-[13px] text-muted whitespace-pre-wrap mt-1 pl-4 border-l border-line">{message.content}</div> : null}
      </div>
    );
  }
  if (message.kind === 'error') {
    return (
      <div className="px-3 py-1">
        <div className="rounded-xl border border-danger/50 bg-danger/10 text-danger text-[13px] px-3 py-2 flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" /><span className="whitespace-pre-wrap break-words">{message.content || message.text}</span></div>
      </div>
    );
  }
  return null;
}
