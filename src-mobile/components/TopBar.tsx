import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

type TopBarProps = { title: ReactNode; subtitle?: ReactNode; back?: string | boolean; right?: ReactNode };

/** Used by every mobile screen: safe-area aware header with optional back navigation. */
export function TopBar({ title, subtitle, back, right }: TopBarProps) {
  const navigate = useNavigate();
  return (
    <header className="pt-safe-t bg-bg/90 backdrop-blur sticky top-0 z-20 border-b border-line">
      <div className="flex items-center h-12 px-2 gap-1">
        {back ? (
          <button type="button" className="m-touch flex items-center justify-center rounded-full text-ink" aria-label="뒤로" onClick={() => (typeof back === 'string' ? navigate(back) : navigate(-1))}>
            <ChevronLeft size={24} />
          </button>
        ) : <div className="w-2" />}
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold truncate">{title}</div>
          {subtitle ? <div className="text-[11px] text-muted truncate">{subtitle}</div> : null}
        </div>
        {right}
      </div>
    </header>
  );
}
