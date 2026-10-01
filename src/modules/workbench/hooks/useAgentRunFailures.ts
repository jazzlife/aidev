import { useEffect, useRef } from 'react';

import type { RemoteRun } from '@/modules/aidev-router';
import { api, readApiJson } from '@/shared/api';

/**
 * C-10: notices a command an agent ran on the user's PC (remote_exec) that finished with a failure, once,
 * so the workbench can bring its output forward. Runs the user started by hand are not reported.
 */
export function useAgentRunFailures(enabled: boolean, onFailed: (run: RemoteRun) => void, intervalMs = 8000) {
  const since = useRef(Date.now());
  const seen = useRef(new Set<number>());
  const onFailedRef = useRef(onFailed);
  useEffect(() => { onFailedRef.current = onFailed; });
  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const { runs } = await readApiJson<{ runs: RemoteRun[] }>(await api.targets.remoteRuns(15));
        for (const run of runs) {
          if (stopped || seen.current.has(run.id) || run.kind !== 'exec' || run.approved_by === 'user') continue;
          if (!run.finished_at || run.finished_at < since.current) continue;
          seen.current.add(run.id);
          if (run.exit_code !== 0) onFailedRef.current(run);
        }
      } catch { /* next poll */ }
    };
    const timer = window.setInterval(() => { void poll(); }, intervalMs);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [enabled, intervalMs]);
}
