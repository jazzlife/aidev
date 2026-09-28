import { useCallback, useEffect, useRef, useState } from 'react';

import { aidevApi } from '@/modules/aidev-router/api';
import { claudeAuth } from '@/modules/aidev-router/hooks/useClaudeAuth';

/**
 * Drives the in-app Claude subscription login: the runtime starts `claude setup-token`, the user
 * opens the returned sign-in page, pastes the code shown there, and the runtime stores the 1-year
 * token itself. View-free so the workbench panel and the mobile sheet share it.
 */
export type ClaudeLoginStage = 'idle' | 'starting' | 'awaiting_code' | 'submitting' | 'done' | 'error';

/** Used by the workbench ClaudeLoginPanel and the mobile ClaudeLoginSheet. */
export function useClaudeLoginFlow() {
  const [stage, setStage] = useState<ClaudeLoginStage>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const loginIdRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    setStage('starting'); setError(null); setUrl(null);
    try {
      const started = await aidevApi.claudeLoginStart();
      loginIdRef.current = started.loginId;
      setUrl(started.url);
      setStage('awaiting_code');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, []);

  const submit = useCallback(async (code: string) => {
    const loginId = loginIdRef.current;
    if (!loginId || !code.trim()) return;
    setStage('submitting'); setError(null);
    try {
      const saved = await aidevApi.claudeLoginCode(loginId, code.trim());
      loginIdRef.current = null;
      setExpiresAt(saved.expiresAt);
      setStage('done');
      await claudeAuth.completed();
    } catch (err) {
      // the runtime ends the attempt on a refused code; the user starts again
      loginIdRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, []);

  // Leaving the dialog mid-login frees the runtime's pseudo-terminal right away.
  useEffect(() => () => {
    if (loginIdRef.current) void aidevApi.claudeLoginCancel(loginIdRef.current).catch(() => undefined);
  }, []);

  return { stage, url, error, expiresAt, start, submit };
}
