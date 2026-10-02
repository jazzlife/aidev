import type { ReactNode } from 'react';
import { useEffect } from 'react';

import { useBackOverlay } from '@m/lib/nav';

type BottomSheetProps = { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode };

/** Used by the chat screen for the router details, permission requests and file peeks. */
export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  // the back button closes the sheet, not the screen under it
  useBackOverlay(open, onClose);
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <button type="button" aria-label="닫기" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] flex flex-col rounded-t-2xl bg-surface border-t border-line shadow-2xl pb-safe-b">
        <div className="flex justify-center pt-2"><div className="w-10 h-1 rounded-full bg-line" /></div>
        {title ? <div className="px-4 pt-2 pb-1 text-[15px] font-semibold">{title}</div> : null}
        <div className="m-scroll px-4 pb-4 pt-1 text-[14px]">{children}</div>
      </div>
    </div>
  );
}
