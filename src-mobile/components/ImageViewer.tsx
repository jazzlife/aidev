import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { X } from 'lucide-react';

import { useBackOverlay } from '@m/lib/nav';

const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 300;

type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
const IDENTITY: View = { scale: 1, x: 0, y: 0 };

/**
 * Used by SessionResults (C-05 ScreenSnapshot): a captured screen full-screen with pinch zoom, one-finger pan
 * while zoomed and double-tap to zoom in/out. The app disables browser zoom (viewport), so the gesture is ours.
 */
export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useBackOverlay(true, onClose);
  // the image's zoom and offset (from the screen centre), driven by the gestures below
  const [view, setView] = useState<View>(IDENTITY);
  const pointers = useRef(new Map<number, Point>());
  // the pinch in progress: where it started and the view at that moment
  const pinch = useRef<{ distance: number; mid: Point; view: View } | null>(null);
  const lastTap = useRef(0);
  // fingers on the image: transforms follow them directly; the ease is only for releases and double taps
  const [touching, setTouching] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // positions relative to the screen centre, where the image's transform origin sits
  const centred = (event: PointerEvent): Point => ({ x: event.clientX - window.innerWidth / 2, y: event.clientY - window.innerHeight / 2 });
  const twoFingers = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const onDown = (event: PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, centred(event));
    setTouching(true);
    if (pointers.current.size === 2) pinch.current = { ...twoFingers(), view };
  };
  const onMove = (event: PointerEvent) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = centred(event);
    pointers.current.set(event.pointerId, point);
    const start = pinch.current;
    if (start && pointers.current.size === 2) {
      const now = twoFingers();
      const scale = Math.min(MAX_SCALE, Math.max(1, start.view.scale * (now.distance / start.distance)));
      // keep the image point that was under the fingers' midpoint under it
      const ratio = scale / start.view.scale;
      setView({ scale, x: now.mid.x - (start.mid.x - start.view.x) * ratio, y: now.mid.y - (start.mid.y - start.view.y) * ratio });
    } else if (pointers.current.size === 1) {
      setView((current) => (current.scale > 1 ? { ...current, x: current.x + point.x - previous.x, y: current.y + point.y - previous.y } : current));
    }
  };
  const onUp = (event: PointerEvent) => {
    const wasSingle = pointers.current.size === 1 && !pinch.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) { setTouching(false); setView((current) => (current.scale <= 1.02 ? IDENTITY : current)); }
    if (!wasSingle) return;
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      const point = centred(event);
      setView((current) => (current.scale > 1 ? IDENTITY : { scale: 2.5, x: -point.x * 1.5, y: -point.y * 1.5 }));
      lastTap.current = 0;
    } else lastTap.current = now;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black" role="dialog" aria-modal="true" aria-label={alt} data-testid="image-viewer">
      <div className="absolute inset-0 flex items-center justify-center overflow-hidden" style={{ touchAction: 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <img src={src} alt={alt} draggable={false} className="max-h-full max-w-full select-none object-contain"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transition: touching ? 'none' : 'transform 120ms ease-out' }} />
      </div>
      <button type="button" aria-label="닫기" onClick={onClose} className="m-touch absolute right-3 top-[calc(env(safe-area-inset-top)+8px)] flex items-center justify-center rounded-full bg-white/15 text-white"><X size={22} /></button>
      {view.scale > 1 ? <div className="pointer-events-none absolute bottom-[calc(env(safe-area-inset-bottom)+12px)] left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1 text-[12px] text-white">{view.scale.toFixed(1)}× · 두 번 탭하면 원래 크기</div> : null}
    </div>
  );
}
