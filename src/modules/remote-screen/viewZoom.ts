/**
 * Zooming the remote picture on this device (2026-10-12), non-visual: nothing of it reaches the PC.
 *   two-finger pinch: zoom around the fingers (and follow them) · ctrl + wheel (a trackpad pinch too): zoom at the pointer
 *   one finger / the mouse dragging while not in control: move the zoomed picture
 * The canvas gets `translate(…) scale(…)` from its top-left corner, kept so the picture always covers its own box.
 * Remote-control input normalizes positions to the canvas's on-screen rectangle, so it stays right when zoomed;
 * while a pinch is on, `gesture.pinching` tells it not to send that two-finger move as a remote scroll.
 */
export type ZoomGesture = { pinching: boolean };

const MAX_SCALE = 6;
const PINCH_START = 0.08;   // the fingers' distance changes this much (relative) before it is a pinch, not a scroll

/** Used by useRemoteScreen. `canPan`: the picture may be dragged (not while a press goes to the PC). Returns reset + cleanup. */
export function bindViewZoom(container: HTMLElement, canvas: HTMLCanvasElement, gesture: ZoomGesture, canPan: () => boolean, onScale: (scale: number) => void) {
  let scale = 1; let tx = 0; let ty = 0;
  const apply = () => {
    // keep the picture over its own box: no empty edge inside it while zoomed
    const w = canvas.offsetWidth; const h = canvas.offsetHeight;
    tx = Math.min(0, Math.max(w - w * scale, tx)); ty = Math.min(0, Math.max(h - h * scale, ty));
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    onScale(scale);
  };
  /** Zoom by `factor`, keeping the picture point under (x, y) where it is. */
  const zoomAt = (x: number, y: number, factor: number) => {
    const next = Math.min(MAX_SCALE, Math.max(1, scale * factor));
    if (next === scale) return;
    const r = canvas.getBoundingClientRect();
    const left = r.left - tx; const top = r.top - ty;   // the untransformed box
    tx = x - left - (next / scale) * (x - left - tx); ty = y - top - (next / scale) * (y - top - ty);
    scale = next;
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  };

  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;   // a plain wheel is the PC's scroll (or the page's)
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01));
  };
  const points = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; scale: number; mx: number; my: number } | null = null;
  let drag: { id: number; x: number; y: number } | null = null;
  const pair = () => { const [a, b] = [...points.values()]; return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };
  const onDown = (e: PointerEvent) => {
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 2) { const p = pair(); pinch = { dist: p.dist, scale, mx: p.mx, my: p.my }; drag = null; return; }
    if (points.size === 1 && scale > 1 && canPan() && (e.pointerType !== 'mouse' || e.button === 0)) {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      container.setPointerCapture?.(e.pointerId);
    }
  };
  const onMove = (e: PointerEvent) => {
    const pt = points.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;
    if (pinch && points.size >= 2) {
      const p = pair();
      if (!gesture.pinching && Math.abs(p.dist / pinch.dist - 1) < PINCH_START) return;   // two fingers moving together: a remote scroll
      gesture.pinching = true;
      zoomAt(p.mx, p.my, (pinch.scale * (p.dist / pinch.dist)) / scale);
      tx += p.mx - pinch.mx; ty += p.my - pinch.my; pinch.mx = p.mx; pinch.my = p.my;
      apply();
      return;
    }
    if (drag && drag.id === e.pointerId) { tx += e.clientX - drag.x; ty += e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; apply(); }
  };
  const onUp = (e: PointerEvent) => {
    points.delete(e.pointerId);
    if (points.size < 2) { pinch = null; gesture.pinching = false; }
    if (drag?.id === e.pointerId) drag = null;
  };
  const onResize = () => apply();

  container.style.touchAction = 'none';
  container.addEventListener('wheel', onWheel, { passive: false });
  // capture: a pinch is known before the canvas's remote-control listener sees the same move
  container.addEventListener('pointerdown', onDown, true);
  container.addEventListener('pointermove', onMove, true);
  container.addEventListener('pointerup', onUp, true);
  container.addEventListener('pointercancel', onUp, true);
  window.addEventListener('resize', onResize);
  return {
    reset: () => { scale = 1; tx = 0; ty = 0; apply(); },
    cleanup: () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('pointerdown', onDown, true);
      container.removeEventListener('pointermove', onMove, true);
      container.removeEventListener('pointerup', onUp, true);
      container.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('resize', onResize);
      canvas.style.transform = '';
      onScale(1);
    },
  };
}
