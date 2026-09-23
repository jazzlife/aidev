import { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';

/** Used by ChatScreen after a run completes: 👍/👎 feed the run outcome (IMPLEMENTATION-PLAN §3.8). */
export function RunFeedback({ onFeedback }: { onFeedback: (value: 'up' | 'down') => void }) {
  const [sent, setSent] = useState<'up' | 'down' | null>(null);
  return (
    <div className="mx-3 mb-1 flex items-center gap-2 text-[12px] text-muted">
      <span>결과가 괜찮았나요?</span>
      <button type="button" aria-label="좋아요" disabled={Boolean(sent)} onClick={() => { setSent('up'); onFeedback('up'); }} className={`m-touch flex items-center justify-center rounded-full ${sent === 'up' ? 'text-ok' : ''}`}><ThumbsUp size={16} /></button>
      <button type="button" aria-label="별로예요" disabled={Boolean(sent)} onClick={() => { setSent('down'); onFeedback('down'); }} className={`m-touch flex items-center justify-center rounded-full ${sent === 'down' ? 'text-danger' : ''}`}><ThumbsDown size={16} /></button>
    </div>
  );
}
