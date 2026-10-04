import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, FileText, Paperclip, Pencil, ShieldCheck, Square, X } from 'lucide-react';

import { attachmentProblem } from '@m/lib/chatOptions';
import { useLongPress } from '@m/lib/useLongPress';

type ComposerProps = {
  disabled?: boolean;
  /** the agent is answering: stop shows next to send, and a send waits its turn (ChatScreen queues it) */
  busy: boolean;
  /** false: not taken (a send is still on its way) — the text stays */
  onSend: (text: string, files: File[]) => boolean | void;
  onAbort: () => void;
  placeholder?: string;
  /** the draft as typed (ChatScreen pre-judges it) */
  onDraftChange?: (text: string) => void;
  /** text (and files) put back after a send that did not happen, or a message to edit (a new `n` each time) */
  restore?: { text: string; files?: File[]; n: number } | null;
  /** the permission-mode pill: its short label, and what a tap opens */
  mode?: { label: string; onOpen: () => void } | null;
  /** a sent message is being edited: the bar above says so, ✕ gives up */
  editing?: { onCancel: () => void } | null;
  /** extra controls in the row (e.g. the microphone) */
  extra?: ReactNode;
  /** the send button held down: send this later ("예약 보내기"); the text stays until it is scheduled */
  onSchedule?: (text: string, files: File[]) => void;
};

/** Thumbnails of picked images; their object URLs are let go when the files change or the composer goes. */
function useThumbs(files: File[]) {
  const thumbs = useMemo(() => files.map((file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null)), [files]);
  useEffect(() => () => { for (const url of thumbs) if (url) URL.revokeObjectURL(url); }, [thumbs]);
  return thumbs;
}

/**
 * Used by ChatScreen: bottom-anchored input with auto-grow; one row under it — 📎 attach (the phone offers camera,
 * photos and files), the permission-mode pill, then stop (while answering) and send. Safe-area padding.
 */
export function Composer({ disabled, busy, onSend, onAbort, placeholder, onDraftChange, restore, mode, editing, extra, onSchedule }: ComposerProps) {
  const [value, setValueState] = useState('');
  // files picked for the next send (uploaded when it goes)
  const [files, setFiles] = useState<File[]>([]);
  // why a picked file was not taken (count or size), until the next pick
  const [fileError, setFileError] = useState<string | null>(null);
  const setValue = (next: string) => { setValueState(next); onDraftChange?.(next); };
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const thumbs = useThumbs(files);
  const grow = () => { const element = ref.current; if (!element) return; element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 160)}px`; };
  useEffect(() => {
    if (!restore) return;
    setValueState(restore.text);
    onDraftChange?.(restore.text);
    if (restore.files) setFiles(restore.files);
    requestAnimationFrame(() => { grow(); ref.current?.focus(); });
  }, [restore]);   // eslint-disable-line react-hooks/exhaustive-deps -- only a new restore
  // attachments alone can go too (the server takes an empty text; ChatScreen describes them to the router)
  const canSend = Boolean(value.trim() || files.length) && !disabled;
  const send = () => {
    const text = value.trim();
    if (!canSend) return;
    if (onSend(text, files) === false) return;
    setValue(''); setFiles([]); setFileError(null);
    requestAnimationFrame(grow);
  };
  const holdSend = useLongPress(() => { const text = value.trim(); if (text && onSchedule && !disabled) onSchedule(text, files); });
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } };
  const pick = (list: FileList | null) => {
    const next = [...files];
    let problem: string | null = null;
    for (const file of Array.from(list ?? [])) {
      const why = attachmentProblem(next, file);
      if (why) { problem = why; continue; }
      next.push(file);
    }
    setFiles(next); setFileError(problem);
    if (picker.current) picker.current.value = '';
  };
  const icon = 'm-touch flex items-center justify-center rounded-full text-muted disabled:opacity-40';
  return (
    <div className="border-t border-line bg-bg px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+8px)]">
      {editing ? (
        <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-accent/10 px-3 py-1.5 text-[13px]" data-testid="editing-bar">
          <Pencil size={14} className="text-accent" /><span className="flex-1">메시지 수정 중 · 보내면 이 메시지부터 다시 시작합니다</span>
          <button type="button" aria-label="수정 취소" onClick={editing.onCancel} className="text-muted"><X size={16} /></button>
        </div>
      ) : null}
      <div className="rounded-2xl border border-line bg-surface px-2 pt-1">
        {files.length ? (
          <ul className="flex gap-2 overflow-x-auto px-1 pt-1.5 pb-1" data-testid="composer-files">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="relative shrink-0">
                {thumbs[index] ? <img src={thumbs[index] ?? ''} alt={file.name} className="h-14 w-14 rounded-lg object-cover border border-line" />
                  : <div className="flex h-14 w-24 flex-col justify-center rounded-lg border border-line bg-elevated px-2"><FileText size={14} className="text-muted" /><span className="truncate text-[11px]">{file.name}</span></div>}
                <button type="button" aria-label={`${file.name} 빼기`} onClick={() => setFiles(files.filter((_, i) => i !== index))} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-bg"><X size={12} /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea ref={ref} rows={1} value={value} placeholder={placeholder ?? '명령을 입력하세요'} disabled={disabled} onChange={(event) => { setValue(event.target.value); grow(); }} onKeyDown={onKey}
          className="w-full resize-none bg-transparent outline-none text-[16px] leading-6 px-1.5 py-1.5 max-h-40 placeholder:text-muted" />
        <div className="flex items-center gap-1 pb-1">
          <input ref={picker} type="file" multiple hidden data-testid="composer-file-input" onChange={(event) => pick(event.target.files)} />
          <button type="button" aria-label="첨부" disabled={disabled} onClick={() => picker.current?.click()} className={icon}><Paperclip size={19} /></button>
          {extra}
          {mode ? (
            <button type="button" onClick={mode.onOpen} aria-label={`권한 모드: ${mode.label}`} className="flex h-8 min-w-0 items-center gap-1 rounded-full border border-line px-2.5 text-[12px] text-muted">
              <ShieldCheck size={14} className="shrink-0" /><span className="truncate max-[360px]:hidden">{mode.label}</span>
            </button>
          ) : null}
          <span className="flex-1" />
          {busy ? <button type="button" onClick={onAbort} aria-label="중지" className="m-touch w-9 h-9 min-w-9 min-h-9 rounded-full bg-ink text-bg flex items-center justify-center"><Square size={14} /></button> : null}
          <button type="button" onClick={send} disabled={!canSend} {...(onSchedule ? holdSend : {})} aria-label={busy ? '대기열에 넣기' : '보내기'} className="w-9 h-9 min-w-9 min-h-9 ml-1 rounded-full bg-accent text-accent-ink flex items-center justify-center disabled:opacity-40"><ArrowUp size={18} /></button>
        </div>
      </div>
      {fileError ? <div className="px-2 pt-1 text-[12px] text-danger" role="alert">{fileError}</div> : null}
    </div>
  );
}
