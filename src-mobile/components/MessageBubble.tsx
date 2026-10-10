import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileDiff, FileText, Paperclip, Wrench } from 'lucide-react';

import { api, parseToolPayload, type NormalizedMessage } from '@/modules/chat-core';
import { Prose } from '@m/lib/markdown';
import { clampText, summarizeToolInput as summarizeInput } from '@m/lib/format';
import { useLongPress } from '@m/lib/useLongPress';
import { toolCardFor } from '@m/components/ToolCards';
import { fileEditFromTool, filePathFromTool, type FileEdit, type FileRef } from '@m/lib/peek';

type MessageImage = NonNullable<NormalizedMessage['images']>[number];

/** One sent image: inline data (history, or this phone's own echo) or the stored file fetched with the auth header. */
function SentImage({ image }: { image: MessageImage }) {
  const [src, setSrc] = useState<string | null>(image.data ?? null);
  useEffect(() => {
    if (image.data || !image.path) return undefined;
    const filename = image.path.split(/[\\/]/).pop() ?? '';
    const controller = new AbortController();
    let url: string | null = null;
    api.assets.image(filename, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) return;
      url = URL.createObjectURL(await response.blob());
      setSrc(url);
    }).catch(() => undefined);
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [image.data, image.path]);
  return src ? <img src={src} alt={image.name ?? ''} className="h-24 max-w-[60vw] rounded-xl object-cover border border-line" /> : <div className="h-24 w-24 rounded-xl bg-elevated m-pulse" aria-label={image.name ?? '이미지'} />;
}

/** The images and files sent with a user message. */
function SentAttachments({ message }: { message: NormalizedMessage }) {
  const images = message.images ?? [];
  const imagePaths = new Set(images.map((image) => image.path).filter(Boolean));
  const files = (message.files ?? []).filter((file) => !file.path || !imagePaths.has(file.path));
  if (!images.length && !files.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5" data-testid="sent-attachments">
      {images.map((image, index) => <SentImage key={image.path ?? index} image={image} />)}
      {files.map((file, index) => <span key={file.path ?? index} className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[12px]"><Paperclip size={12} className="text-muted" />{file.name ?? file.path?.split(/[\\/]/).pop()}</span>)}
    </div>
  );
}

export type PeekHandlers = {
  /** opens a file (and line) in the file peek */
  onPeekFile?: (ref: FileRef) => void;
  /** opens what a file tool changed in the diff peek */
  onPeekDiff?: (edit: FileEdit) => void;
  /** the open project's path: file paths in tool rows are shown relative to it */
  projectPath?: string | null;
};

/** Used by MessageList: one transcript row — user bubble, assistant prose, or a collapsible tool/thinking card. */
export function MessageBubble({ message, result, onLongPress, onPeekFile, onPeekDiff, projectPath }: { message: NormalizedMessage; result?: NormalizedMessage | null; /** text messages: long-press opens the copy sheet (text selection is off in the app) */ onLongPress?: (text: string, message: NormalizedMessage) => void } & PeekHandlers) {
  const [open, setOpen] = useState(false);
  const text = message.kind === 'text' || message.kind === 'stream_delta' ? String((message.role === 'user' ? message.displayText || message.content : message.content) ?? '') : '';
  const hasAttachments = Boolean(message.images?.length || message.files?.length);
  // a message of attachments only can be held too (its actions: fork here)
  const press = useLongPress(() => { if (text || hasAttachments) onLongPress?.(text, message); });
  if (message.kind === 'text' && message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1 px-3 py-1">
        <div {...press}><SentAttachments message={message} /></div>
        {text ? <div className="m-selectable max-w-[85%] rounded-2xl rounded-br-md bg-accent text-accent-ink px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words" {...press}>{text}</div> : null}
      </div>
    );
  }
  if (message.kind === 'text' || message.kind === 'stream_delta') {
    return (
      <div className="m-selectable px-3 py-1" {...press}>
        <Prose text={message.content ?? ''} onFileRef={onPeekFile} />
        {message.kind === 'stream_delta' ? <span className="inline-block w-2 h-4 bg-accent/70 m-pulse align-middle ml-0.5 rounded-sm" /> : null}
      </div>
    );
  }
  if (message.kind === 'tool_use') {
    // checklists, subagents, plans and answered questions get their own card
    const card = toolCardFor(message, result);
    if (card) return card;
    const isError = Boolean(result?.toolResult?.isError);
    const edit = fileEditFromTool(message.toolName, message.toolInput);
    const readPath = edit?.path ?? filePathFromTool(message.toolName, message.toolInput);
    return (
      <div className="px-3 py-0.5">
        <button type="button" onClick={() => setOpen((value) => !value)} className={`w-full text-left rounded-xl border px-3 py-2 flex items-start gap-2 bg-surface ${isError ? 'border-danger/50' : 'border-line'}`}>
          <Wrench size={14} className="mt-0.5 text-muted shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="text-[13px] font-medium">{message.toolName}</span>
            <span className="block text-[12px] text-muted truncate">{summarizeInput(message.toolInput, message.toolName, projectPath)}</span>
          </span>
          {open ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
        </button>
        {(edit && onPeekDiff) || (readPath && onPeekFile && !edit?.deleted) ? (
          <div className="flex gap-4 pl-8 pt-0.5 text-[12px] text-accent">
            {edit && onPeekDiff ? <button type="button" className="flex h-8 items-center gap-1" onClick={() => onPeekDiff(edit)}><FileDiff size={13} /> 변경 보기</button> : null}
            {readPath && onPeekFile && !edit?.deleted ? <button type="button" className="flex h-8 items-center gap-1" onClick={() => onPeekFile({ path: readPath, line: null })}><FileText size={13} /> 파일 보기</button> : null}
          </div>
        ) : null}
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
