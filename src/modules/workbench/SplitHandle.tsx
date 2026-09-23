import { useCallback, useRef, type PointerEvent } from 'react';

type SplitHandleProps = {
  /** Which edge of the resizable pane this handle sits on. */
  edge: 'left' | 'right' | 'top';
  size: number;
  min: number;
  max: number;
  onSize: (size: number) => void;
};

/**
 * Used by WorkbenchLayout: a drag handle that resizes an adjacent pane. Pointer capture keeps the
 * drag alive when the cursor leaves the handle. Collapsing is the parent's job; this is a pure resizer.
 */
export function SplitHandle({ edge, size, min, max, onSize }: SplitHandleProps) {
  const start = useRef<{ x: number; y: number; size: number } | null>(null);
  const vertical = edge === 'top';
  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    start.current = { x: event.clientX, y: event.clientY, size };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  }, [size, vertical]);
  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const delta = vertical ? start.current.y - event.clientY : event.clientX - start.current.x;
    // The pane grows when the handle moves away from it: left-edge handles grow on leftward drag.
    const grow = edge === 'left' ? -delta : delta;
    onSize(Math.max(min, Math.min(max, start.current.size + grow)));
  }, [edge, max, min, onSize, vertical]);
  const onPointerUp = useCallback(() => {
    start.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`shrink-0 bg-border/60 hover:bg-primary/60 active:bg-primary transition-colors ${vertical ? 'h-1 w-full cursor-row-resize' : 'w-1 h-full cursor-col-resize'}`}
    />
  );
}
