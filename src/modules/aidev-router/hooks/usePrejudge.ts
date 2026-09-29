import { useEffect, useRef } from 'react';

import { aidevApi } from '@/modules/aidev-router/api';
import { routingStore } from '@/modules/aidev-router/store';

const PAUSE_MS = 900;
const MIN_CHARS = 8;

/**
 * Typing-time pre-judge (IMPLEMENTATION-PLAN §3.1): when the user pauses while typing a command, the
 * gateway starts the specialist judge for the draft, so by the time they press send the verdict
 * (existing specialist / generalist / create a new one) is usually cached and routing does not wait
 * for it. Fire-and-forget; slash commands and short drafts are skipped. Used by both composers.
 */
export function usePrejudge(draft: string, projectHint: string | null | undefined) {
  const lastSent = useRef('');
  useEffect(() => {
    const text = draft.trim();
    if (text.length < MIN_CHARS || text.startsWith('/') || text === lastSent.current) return undefined;
    if (routingStore.get().mode === 'off') return undefined;
    const timer = window.setTimeout(() => {
      lastSent.current = text;
      void aidevApi.prejudge({ text, projectHint: projectHint ?? null }).catch(() => undefined);
    }, PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, projectHint]);
}
