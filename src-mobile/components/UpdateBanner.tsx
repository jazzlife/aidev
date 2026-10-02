import { useReleaseWatch } from '@/shared/hooks/useReleaseWatch';

/** Used by the mobile app shell: a new release while the app is open — tap to load it (reopening the app loads it). */
export function UpdateBanner() {
  const { updateReady, reload } = useReleaseWatch();
  if (!updateReady) return null;
  return (
    <button type="button" onClick={reload} data-testid="release-update"
      className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+6px)] z-[70] rounded-xl bg-ink px-4 py-2.5 text-left text-[14px] text-bg shadow-lg">
      새 버전이 있습니다 · <span className="font-semibold text-accent">탭하여 새로고침</span>
    </button>
  );
}
