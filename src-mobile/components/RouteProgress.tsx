import { useScreenLoading } from '@m/lib/lazyScreen';

/**
 * Used by App: a 2px line at the top while a screen's code downloads. The screen that is already showing stays until
 * the next one is ready (router transitions), so this replaces the full-screen splash between screens. It appears only
 * after 120 ms (CSS transition-delay), so a fast load shows nothing.
 */
export function RouteProgress() {
  const loading = useScreenLoading();
  return <div className="m-route-progress" data-on={loading ? 'true' : 'false'} role="progressbar" aria-hidden={!loading} aria-label="화면 불러오는 중" data-testid="route-progress" />;
}
