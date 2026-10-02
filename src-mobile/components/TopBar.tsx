import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

import { useGoUp } from '@m/lib/nav';

type TopBarProps = {
  title: ReactNode; subtitle?: ReactNode;
  /** ‹ goes up, like the back button: the screen's parent (useParent), or closes its open in-screen view */
  back?: boolean;
  /** tapping the subtitle (e.g. the project of a conversation) */
  onSubtitle?: () => void;
  right?: ReactNode; /** replaces the back button (e.g. an in-screen view switch) */ left?: ReactNode;
};

/** Used by every mobile screen: safe-area aware header with optional back navigation. */
export function TopBar({ title, subtitle, back, onSubtitle, right, left }: TopBarProps) {
  const goUp = useGoUp();
  return (
    <header className="pt-safe-t bg-bg/90 backdrop-blur sticky top-0 z-20 border-b border-line">
      <div className="flex items-center h-12 px-2 gap-1">
        {left ?? (back ? (
          <button type="button" className="m-touch flex items-center justify-center rounded-full text-ink" aria-label="뒤로" onClick={goUp}>
            <ChevronLeft size={24} />
          </button>
        ) : <div className="w-2" />)}
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold truncate">{title}</div>
          {subtitle ? (onSubtitle
            ? <button type="button" onClick={onSubtitle} className="block max-w-full text-left text-[11px] text-accent truncate">{subtitle} ›</button>
            : <div className="text-[11px] text-muted truncate">{subtitle}</div>) : null}
        </div>
        {right}
      </div>
    </header>
  );
}
