import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ExternalLink, Maximize2, Minimize2, Minus, X } from 'lucide-react';

import { clampRect, liveWindows, useLiveWindows } from '@/modules/live-window/liveWindowStore';

/** One kind of live window the host can show. `render(visible)`: its content; hidden (minimized) content stays mounted but idle. */
export type LiveWindowSpec = { id: string; title: string; icon: LucideIcon; render: (visible: boolean) => ReactNode; popoutPath?: string };

type Rect = { x: number; y: number; w: number; h: number };
type Gesture = { kind: 'move' | 'resize'; startX: number; startY: number; from: Rect };

/** Opens `path` (same origin) in its own browser window, sized like the overlay it replaces. */
function popout(id: string, path: string, r: Rect) {
  const w = Math.max(480, Math.round(r.w)); const h = Math.max(360, Math.round(r.h));
  const win = window.open(path, `aidev-live-${id}`, `popup=yes,width=${w},height=${h},left=${Math.round(window.screenX + r.x)},top=${Math.round(window.screenY + r.y)}`);
  if (win) { win.focus(); liveWindows.close(id); }
}

function Frame({ spec, compact }: { spec: LiveWindowSpec; compact: boolean }) {
  const all = useLiveWindows();
  const s = all[spec.id];
  // the rectangle while a move/resize is in progress (committed to the store when the pointer is released)
  const [live, setLive] = useState<Rect | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // the same rectangle for the release handler: fast input (touch) can release before React re-renders
  const liveRef = useRef<Rect | null>(null);
  if (!s?.open) return null;
  const visible = s.mode !== 'min';
  const max = compact || s.mode === 'max';
  const rect = live ?? { x: s.x, y: s.y, w: s.w, h: s.h };

  const begin = (kind: Gesture['kind']) => (e: ReactPointerEvent<HTMLElement>) => {
    if (max || e.button !== 0) return;
    if (kind === 'move' && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = { kind, startX: e.clientX, startY: e.clientY, from: rect };
    liveWindows.focus(spec.id);
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.startX; const dy = e.clientY - g.startY;
    const next = clampRect(g.kind === 'move' ? { ...g.from, x: g.from.x + dx, y: g.from.y + dy } : { ...g.from, w: g.from.w + dx, h: g.from.h + dy });
    liveRef.current = next;
    setLive(next);
  };
  const end = () => {
    if (!gesture.current) return;
    gesture.current = null;
    if (liveRef.current) liveWindows.setRect(spec.id, liveRef.current);
    liveRef.current = null;
    setLive(null);
  };
  const Icon = spec.icon;

  return (
    <div
      role="dialog" aria-label={spec.title}
      onPointerDownCapture={() => liveWindows.focus(spec.id)}
      className={`pointer-events-auto absolute flex-col overflow-hidden border border-border bg-background shadow-2xl ${max ? 'inset-0 rounded-none' : 'rounded-lg'} ${visible ? 'flex' : 'hidden'}`}
      style={max ? { zIndex: s.z } : { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: s.z }}
    >
      <div
        onPointerDown={begin('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        onDoubleClick={() => { if (!compact) liveWindows.setMode(spec.id, s.mode === 'max' ? 'float' : 'max'); }}
        className={`aidev-chrome flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-muted/60 px-2 text-xs ${max ? '' : 'cursor-move'}`}
        style={{ touchAction: 'none' }}
      >
        <Icon size={13} className="text-muted-foreground" />
        <span className="font-medium">{spec.title}</span>
        <div className="ml-auto flex items-center">
          {spec.popoutPath ? <button type="button" title="새 창으로 떼어 내기" aria-label="새 창으로 떼어 내기" onClick={() => popout(spec.id, spec.popoutPath!, rect)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ExternalLink size={13} /></button> : null}
          <button type="button" title="최소화" aria-label="최소화" onClick={() => liveWindows.setMode(spec.id, 'min')} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Minus size={13} /></button>
          {compact ? null : <button type="button" title={s.mode === 'max' ? '원래 크기' : '최대화'} aria-label={s.mode === 'max' ? '원래 크기' : '최대화'} onClick={() => liveWindows.setMode(spec.id, s.mode === 'max' ? 'float' : 'max')} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">{s.mode === 'max' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>}
          <button type="button" title="닫기" aria-label="닫기" onClick={() => liveWindows.close(spec.id)} className="rounded p-1 text-muted-foreground hover:bg-rose-600 hover:text-white"><X size={13} /></button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {spec.render(visible)}
        {/* while moving/resizing, a page in the window (iframe) must not swallow the pointer */}
        {live ? <div className="absolute inset-0" /> : null}
      </div>
      {max ? null : (
        <div
          onPointerDown={begin('resize')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          title="크기 조절" className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
          style={{ touchAction: 'none', background: 'linear-gradient(135deg, transparent 50%, hsl(var(--border)) 50%)' }}
        />
      )}
    </div>
  );
}

/**
 * The workbench's live windows (IMPLEMENTATION-PLAN §3.11): preview and remote screen float over the
 * workbench — move by the title bar, resize from the corner, double-click to maximize, minimize to the
 * dock at the bottom right, or pop out into a browser window of their own. `compact` (narrow screens)
 * shows them maximized only. Used by WorkbenchLayout (desktop and tablet).
 */
export function LiveWindowHost({ windows, compact }: { windows: LiveWindowSpec[]; compact: boolean }) {
  const all = useLiveWindows();
  // a browser window that shrank must not leave a floating window out of reach
  useEffect(() => {
    const onResize = () => { for (const w of windows) { const s = liveWindows.get(w.id); if (s?.open) liveWindows.setRect(w.id, s); } };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [windows]);
  const minimized = windows.filter((w) => all[w.id]?.open && all[w.id].mode === 'min');
  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {windows.map((w) => <Frame key={w.id} spec={w} compact={compact} />)}
      {minimized.length ? (
        <div className="aidev-chrome pointer-events-auto absolute bottom-3 right-3 flex gap-1.5">
          {minimized.map((w) => (
            <button key={w.id} type="button" onClick={() => liveWindows.open(w.id)} className="flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs shadow-lg hover:bg-muted">
              <w.icon size={13} /> {w.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
