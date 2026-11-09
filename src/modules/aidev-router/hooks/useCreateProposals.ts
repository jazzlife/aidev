import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type CreateQueueEntry } from '@/modules/aidev-router/api';

/**
 * D-04 (§3.7): domains the user worked in several times without a specialist, offered for creation. `accept` has the
 * gateway design that specialist out of band (no chat turn — its commands already ran) and registers it; `dismiss`
 * never offers it again. Used by the workbench catalog and the mobile conversation list.
 */
export function useCreateProposals() {
  // the proposed entries (null while loading); queued ones below the threshold are not offered yet
  const [proposals, setProposals] = useState<CreateQueueEntry[] | null>(null);
  const load = useCallback(() => {
    aidevApi.createQueue().then((r) => setProposals(r.entries.filter((e) => e.status === 'proposed'))).catch(() => setProposals([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  const accept = useCallback((entry: CreateQueueEntry) => {
    setProposals((list) => list?.filter((e) => e.id !== entry.id) ?? null);
    void aidevApi.designCreate(entry.id).catch(() => load());
  }, [load]);
  const dismiss = useCallback((entry: CreateQueueEntry) => {
    setProposals((list) => list?.filter((e) => e.id !== entry.id) ?? null);
    void aidevApi.dismissCreate(entry.id).catch(() => load());
  }, [load]);
  return { proposals, accept, dismiss, reload: load };
}
