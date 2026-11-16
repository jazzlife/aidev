import { Check, Copy, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { copyTextToClipboard } from '@/shared/utils';

/**
 * Used by chat's Markdown: in the iOS home-screen app a same-origin link (a preview at `/p/…`) would open in the
 * app's own window and replace it with no way back, so it opens here instead — a full-screen frame with a close
 * button, and the link to copy for Safari. Sandboxed like the workbench preview pane (no access to the app's token).
 */
export function LinkViewer({ url, onClose }: { url: string; onClose: () => void }) {
  // "복사됨" for a moment after the link is copied, so the tap visibly did something
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const copy = async () => {
    if (!(await copyTextToClipboard(url))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label={url}>
      <div className="flex items-center gap-2 border-b border-border px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button type="button" onClick={onClose} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-muted">
          <X className="h-4 w-4" aria-hidden /> 닫기
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={url}>{url}</span>
        <button type="button" onClick={() => void copy()} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? '복사됨' : '링크 복사'}
        </button>
      </div>
      <iframe
        src={url}
        title={url}
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>,
    document.body,
  );
}
