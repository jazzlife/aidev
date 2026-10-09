import { useCallback, useRef } from 'react';

import { aidevApi, useAidevDecide } from '@/modules/aidev-router';

/**
 * The panes `ui.focus` may bring forward (IMPLEMENTATION-PLAN §3.10). The remote run panel is left out:
 * a remote command never pulls it open by itself (Laya's `run_output` answer is ignored).
 */
export type FocusPane = 'chat' | 'editor' | 'diff' | 'terminal' | 'preview' | 'screen' | 'debug' | 'none';
/** A run event and the pane it would normally bring forward (used when Laya is not confident or offline). */
export type FocusEvent = { event: string; summary: string; suggested: FocusPane };

const PANES: FocusPane[] = ['chat', 'editor', 'diff', 'terminal', 'preview', 'screen', 'debug', 'none'];
// the user put the pane away this soon after it came forward → it counts as a revert
const REVERT_WINDOW_MS = 15_000;
const REVERTS_TO_OFF = 3;
const offKey = (sessionId: string) => `aidev.uiFocusOff.${sessionId}`;

function readOff(sessionId: string | null) {
  if (!sessionId) return false;
  try { return sessionStorage.getItem(offKey(sessionId)) === '1'; } catch { return false; }
}

/**
 * C-10: brings a workbench pane forward after a run event. Laya `ui.focus` decides when it is confident;
 * otherwise the event's usual pane is used (agent preview → preview, debugger stopped → debug, …), so the
 * workbench never does less than before. Every decision is logged; a pane the user puts away within 15s
 * is recorded as an override, and 3 such reverts in a row turn automatic focus off for that chat session.
 */
export function useUiFocus({ sessionId, tier, apply, isShown }: {
  sessionId: string | null;
  tier: 'desktop' | 'tablet';
  apply: (pane: FocusPane) => void;
  isShown: (pane: FocusPane) => boolean;
}) {
  const { decide } = useAidevDecide();
  const reverts = useRef(0);
  const focus = useCallback(async (ev: FocusEvent): Promise<FocusPane> => {
    if (readOff(sessionId)) return 'none';
    const result = await decide('ui.focus', { event: ev.event, summary: ev.summary.slice(0, 300), device: tier });
    const laya = result && !result.fallback && PANES.includes(result.answer as FocusPane) ? (result.answer as FocusPane) : null;
    const pane = laya ?? ev.suggested;
    if (pane === 'none' || isShown(pane)) return pane;
    apply(pane);
    window.setTimeout(() => {
      if (isShown(pane)) { reverts.current = 0; return; }
      reverts.current += 1;
      if (result?.decision_id) void aidevApi.overrideDecision(result.decision_id, { final_answer: 'reverted' }).catch(() => {});
      if (reverts.current >= REVERTS_TO_OFF && sessionId) {
        try { sessionStorage.setItem(offKey(sessionId), '1'); } catch { /* per-viewer convenience only */ }
      }
    }, REVERT_WINDOW_MS);
    return pane;
  }, [apply, decide, isShown, sessionId, tier]);
  return { focus };
}
