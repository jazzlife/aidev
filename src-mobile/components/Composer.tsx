import { useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';

type ComposerProps = { disabled?: boolean; busy: boolean; onSend: (text: string) => void; onAbort: () => void; placeholder?: string };

/** Used by ChatScreen: bottom-anchored input with auto-grow, send/stop button, safe-area padding. */
export function Composer({ disabled, busy, onSend, onAbort, placeholder }: ComposerProps) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => { const element = ref.current; if (!element) return; element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 160)}px`; };
  const send = () => { const text = value.trim(); if (!text || disabled) return; onSend(text); setValue(''); requestAnimationFrame(grow); };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } };
  return (
    <div className="border-t border-line bg-bg px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+8px)]">
      <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface px-3 py-1.5">
        <textarea ref={ref} rows={1} value={value} placeholder={placeholder ?? '명령을 입력하세요'} disabled={disabled} onChange={(event) => { setValue(event.target.value); grow(); }} onKeyDown={onKey}
          className="flex-1 resize-none bg-transparent outline-none text-[16px] leading-6 py-1.5 max-h-40 placeholder:text-muted" />
        {busy ? (
          <button type="button" onClick={onAbort} aria-label="중지" className="m-touch w-9 h-9 min-w-9 min-h-9 rounded-full bg-ink text-bg flex items-center justify-center mb-0.5"><Square size={14} /></button>
        ) : (
          <button type="button" onClick={send} disabled={!value.trim() || disabled} aria-label="보내기" className="w-9 h-9 min-w-9 min-h-9 rounded-full bg-accent text-accent-ink flex items-center justify-center mb-0.5 disabled:opacity-40"><ArrowUp size={18} /></button>
        )}
      </div>
    </div>
  );
}
