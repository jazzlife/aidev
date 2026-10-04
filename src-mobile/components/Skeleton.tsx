import { Component, type ReactNode } from 'react';

/** Used by the conversation and project lists while they load: grey rows in the shape of the list. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul aria-label="불러오는 중" aria-busy="true" data-testid="list-skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="border-b border-line px-4 py-3">
          <div className="h-4 w-2/3 rounded bg-elevated m-pulse" />
          <div className="mt-2 h-3 w-1/3 rounded bg-elevated m-pulse" />
        </li>
      ))}
    </ul>
  );
}

/** Used by App around the screens: a screen whose code failed to download (offline, a deploy in between). */
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="m-app items-center justify-center gap-3 p-6 text-center" role="alert">
        <div className="text-[15px]">화면을 불러오지 못했습니다</div>
        <div className="text-[13px] text-muted">연결을 확인한 뒤 다시 시도하세요.</div>
        <button type="button" className="h-11 rounded-xl bg-accent px-5 text-[15px] font-medium text-accent-ink" onClick={() => window.location.reload()}>다시 시도</button>
      </div>
    );
  }
}
