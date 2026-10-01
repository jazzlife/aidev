import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type CreateQueueEntry } from '@/modules/aidev-router/api';
import { routingStore } from '@/modules/aidev-router/store';

/** Window event the workbench chat listens for: send `detail.text` as a new turn (D-04 "만들기" from the catalog). */
export const COMPOSE_EVENT = 'aidev:compose';

/** The turn that starts creating a queued domain's specialist (the gateway routes it to the agent-architect). */
export function proposalCommand(entry: CreateQueueEntry) {
  return `[전문 agent 만들기] ${entry.domain} — ${entry.description}`;
}

/**
 * D-04 (§3.7): domains the user worked in several times without a specialist, offered for creation. `accept` arms
 * the next send to create that specialist and returns the command to send; `dismiss` never offers it again.
 * Used by the workbench catalog and the mobile conversation list.
 */
export function useCreateProposals() {
  // the proposed entries (null while loading); queued ones below the threshold are not offered yet
  const [proposals, setProposals] = useState<CreateQueueEntry[] | null>(null);
  const load = useCallback(() => {
    aidevApi.createQueue().then((r) => setProposals(r.entries.filter((e) => e.status === 'proposed'))).catch(() => setProposals([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  const accept = useCallback((entry: CreateQueueEntry) => {
    routingStore.patch({ oneShotCreate: entry.id });
    setProposals((list) => list?.filter((e) => e.id !== entry.id) ?? null);
    return proposalCommand(entry);
  }, []);
  const dismiss = useCallback((entry: CreateQueueEntry) => {
    setProposals((list) => list?.filter((e) => e.id !== entry.id) ?? null);
    void aidevApi.dismissCreate(entry.id).catch(() => load());
  }, [load]);
  return { proposals, accept, dismiss, reload: load };
}
