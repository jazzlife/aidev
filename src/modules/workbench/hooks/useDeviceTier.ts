import { useEffect, useState } from 'react';

/**
 * Workbench device tiers (IMPLEMENTATION-PLAN §3.11): `tablet` (<1280px or touch-first landscape)
 * gets the two-pane workbench, `desktop` the full IDE layout. Phones never reach this app (the
 * gateway serves /m/), but a phone that pinned the workbench cookie is treated as `tablet`.
 * `localStorage['aidev.tier']` = 'tablet' | 'desktop' pins a tier; anything else is automatic.
 */
export type DeviceTier = 'mobile' | 'tablet' | 'desktop';

const TIER_KEY = 'aidev.tier';
const DESKTOP_QUERY = '(min-width: 1280px)';
const MOBILE_QUERY = '(max-width: 767px)';

function readPinnedTier(): DeviceTier | null {
  try {
    const value = localStorage.getItem(TIER_KEY);
    return value === 'tablet' || value === 'desktop' ? value : null;
  } catch {
    return null;
  }
}

function detectTier(): DeviceTier {
  if (typeof window === 'undefined') return 'desktop';
  const pinned = readPinnedTier();
  if (pinned) return pinned;
  if (window.matchMedia(MOBILE_QUERY).matches) return 'mobile';
  if (window.matchMedia(DESKTOP_QUERY).matches) return 'desktop';
  return 'tablet';
}

/** Used by ProjectMainRegion to pick the workbench layout and by the workbench to size its panes. */
export function useDeviceTier(): DeviceTier {
  const [tier, setTier] = useState<DeviceTier>(detectTier);
  useEffect(() => {
    const queries = [window.matchMedia(DESKTOP_QUERY), window.matchMedia(MOBILE_QUERY)];
    const update = () => setTier(detectTier());
    queries.forEach((query) => query.addEventListener('change', update));
    window.addEventListener('storage', update);
    return () => {
      queries.forEach((query) => query.removeEventListener('change', update));
      window.removeEventListener('storage', update);
    };
  }, []);
  return tier;
}

/** Used by the workbench settings to pin a tier ('auto' clears the pin). */
export function pinDeviceTier(tier: DeviceTier | 'auto') {
  try {
    if (tier === 'auto') localStorage.removeItem(TIER_KEY);
    else localStorage.setItem(TIER_KEY, tier);
    window.dispatchEvent(new Event('storage'));
  } catch {
    // per-viewer convenience only
  }
}
