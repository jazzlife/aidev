import { useEffect, useRef } from 'react';

import { aidevApi } from '@/modules/aidev-router/api';
import { routingStore } from '@/modules/aidev-router/store';

const PAUSE_MS = 900;
const MIN_CHARS = 8;

/**
 * Typing-time pre-judge (IMPLEMENTATION-PLAN §3.1): when the user pauses while typing a command, the
 * gateway starts the specialist judge for the draft, so by the time they press send the verdict
 * (existing specialist / generalist / create a new one) is usually cached and routing does not wait
 * for it. Fire-and-forget; slash commands and short drafts are skipped. Used by both composers. `sessionId` is the
 * chat the draft continues (null for a new one): inside a chat the judge also scores the chat's own agent, so the
 * pre-judge must ask the same question the send will. `projectPath` lets the judge read a new chat's technology.
 */
export function usePrejudge(draft: string, projectPath: string | null | undefined, sessionId: string | null | undefined) {
  const lastSent = useRef('');
  useEffect(() => {
    const text = draft.trim();
    // the same draft in another chat is another question (the chat's agent is part of it)
    const key = `${sessionId ?? ''}|${text}`;
    if (text.length < MIN_CHARS || text.startsWith('/') || key === lastSent.current) return undefined;
    if (routingStore.get().mode === 'off') return undefined;
    const timer = window.setTimeout(() => {
      lastSent.current = key;
      void aidevApi.prejudge({ text, projectPath: projectPath ?? null, sessionId: sessionId ?? null }).catch(() => undefined);
    }, PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, projectPath, sessionId]);
}
