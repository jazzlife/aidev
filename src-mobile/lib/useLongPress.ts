import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

const HOLD_MS = 480;
const MOVE_TOLERANCE_PX = 10;

/**
 * Used by the conversation list and chat messages: a press held ~0.5 s runs `onLongPress` (with a
 * light haptic tick where supported) instead of the browser's own long-press menu / text selection.
 * Moving the finger (scrolling) cancels it; the click that follows a long press is swallowed.
 */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    start.current = null;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    fired.current = false;
    start.current = { x: event.clientX, y: event.clientY };
    timer.current = window.setTimeout(() => {
      fired.current = true;
      timer.current = null;
      try { navigator.vibrate?.(10); } catch { /* not supported */ }
      onLongPress();
    }, HOLD_MS);
  }, [onLongPress]);

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    if (!start.current) return;
    if (Math.abs(event.clientX - start.current.x) > MOVE_TOLERANCE_PX || Math.abs(event.clientY - start.current.y) > MOVE_TOLERANCE_PX) clear();
  }, [clear]);

  // Swallow the click that ends a long press so the row does not also open.
  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (fired.current) { event.preventDefault(); event.stopPropagation(); fired.current = false; }
  }, []);

  return {
    onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear, onPointerLeave: clear, onClickCapture,
    // a mouse selection inside (message text) keeps the browser menu for "copy"
    onContextMenu: (event: ReactMouseEvent) => { if (!window.getSelection()?.toString()) event.preventDefault(); },
  };
}
