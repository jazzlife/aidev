import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { RemotePreviewEntry } from '@/shared/types';

/** Newest preview list, polled while `active` (the workbench also uses it to notice agent-opened previews). */
export function usePreviewList(active: boolean, intervalMs = 5000) {
  const [previews, setPreviews] = useState<RemotePreviewEntry[]>([]);
  const load = useCallback(async () => {
    try { setPreviews((await readApiJson<{ previews: RemotePreviewEntry[] }>(await api.targets.previews())).previews ?? []); } catch { /* keep the last list */ }
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    void load();
    const timer = window.setInterval(() => { void load(); }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs, load]);
  return { previews, reload: load };
}
