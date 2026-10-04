import type { InputEvent as RemoteInputEvent } from '@/modules/remote-screen/session';

/**
 * Remote-control input (F-07b), non-visual: pointer, touch, wheel and keyboard on the screen canvas →
 * runner input events. Coordinates are normalized to the picture (0..1), so the canvas may be scaled.
 *   mouse: move (one per animation frame), buttons, wheel, no context menu
 *   touch: tap = click, long press = right click, one-finger drag = left drag, two-finger pan = scroll
 *   keyboard: a hidden textarea keeps focus: named keys and shortcuts go as key presses with modifiers,
 *   typed text (IME / phone keyboards included) as text.
 */
const NAMED = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'CapsLock']);
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'OS', 'AltGraph']);
const LONG_PRESS_MS = 550;
const DRAG_PX = 10;

export type StickyMods = { ctrl?: boolean; alt?: boolean; meta?: boolean; shift?: boolean };

/** Used by the workbench ScreenPane and the mobile remote screen to drive a PC. Returns a cleanup. */
export function bindRemoteInput(canvas: HTMLCanvasElement, keys: HTMLTextAreaElement, send: (ev: RemoteInputEvent) => void, sticky: () => StickyMods = () => ({})) {
  const norm = (clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.min(Math.max((clientX - r.left) / r.width, 0), 1), y: Math.min(Math.max((clientY - r.top) / r.height, 0), 1) };
  };
  // ---- mouse ----------------------------------------------------------------------------------------
  let pendingMove: { x: number; y: number } | null = null;
  let raf = 0;
  const flushMove = () => { raf = 0; if (pendingMove) { send({ t: 'move', ...pendingMove }); pendingMove = null; } };
  const buttonName = (b: number): 'left' | 'right' | 'middle' => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');
  // ---- touch ----------------------------------------------------------------------------------------
  const touches = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  let longTimer = 0; let longFired = false; let dragging = false; let panY: number | null = null; let panX: number | null = null;
  const clearLong = () => { if (longTimer) { window.clearTimeout(longTimer); longTimer = 0; } };

  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    // a mouse click keeps the keyboard sink focused; a finger does not (it would pop the phone keyboard up)
    if (e.pointerType !== 'touch') keys.focus({ preventScroll: true });
    canvas.setPointerCapture?.(e.pointerId);
    const p = norm(e.clientX, e.clientY);
    if (e.pointerType !== 'touch') { ownsContext = e.button === 2; send({ t: 'button', b: buttonName(e.button), down: true, ...p }); return; }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (touches.size === 1) {
      longFired = false; dragging = false;
      longTimer = window.setTimeout(() => { longFired = true; send({ t: 'move', ...p }); send({ t: 'button', b: 'right', down: true, ...p }); send({ t: 'button', b: 'right', down: false, ...p }); }, LONG_PRESS_MS);
    } else {
      clearLong();
      if (dragging) { const t = [...touches.values()][0]; send({ t: 'button', b: 'left', down: false, ...norm(t.x, t.y) }); dragging = false; }
      const ts = [...touches.values()];
      panY = (ts[0].y + ts[1].y) / 2; panX = (ts[0].x + ts[1].x) / 2;
    }
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') { pendingMove = norm(e.clientX, e.clientY); if (!raf) raf = requestAnimationFrame(flushMove); return; }
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    if (touches.size >= 2 && panY !== null && panX !== null) {
      const ts = [...touches.values()];
      const my = (ts[0].y + ts[1].y) / 2; const mx = (ts[0].x + ts[1].x) / 2;
      // fingers move up → content scrolls down (like a trackpad)
      send({ t: 'wheel', dx: (panX - mx) * 3, dy: (panY - my) * 3 });
      panY = my; panX = mx;
      return;
    }
    if (!dragging && Math.hypot(t.x - t.sx, t.y - t.sy) > DRAG_PX && !longFired) {
      clearLong(); dragging = true;
      const start = norm(t.sx, t.sy);
      send({ t: 'move', ...start }); send({ t: 'button', b: 'left', down: true, ...start });
    }
    if (dragging) { pendingMove = norm(t.x, t.y); if (!raf) raf = requestAnimationFrame(flushMove); }
  };
  const onUp = (e: PointerEvent) => {
    const p = norm(e.clientX, e.clientY);
    if (e.pointerType !== 'touch') { flushMove(); send({ t: 'button', b: buttonName(e.button), down: false, ...p }); return; }
    const t = touches.get(e.pointerId);
    touches.delete(e.pointerId);
    if (touches.size >= 1) { panY = null; panX = null; return; }
    clearLong(); panY = null; panX = null;
    if (!t) return;
    if (dragging) { flushMove(); send({ t: 'button', b: 'left', down: false, ...p }); dragging = false; return; }
    if (!longFired) { send({ t: 'move', ...p }); send({ t: 'button', b: 'left', down: true, ...p }); send({ t: 'button', b: 'left', down: false, ...p }); }
  };
  const onWheel = (e: WheelEvent) => { e.preventDefault(); const k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1; send({ t: 'wheel', dx: e.deltaX * k, dy: e.deltaY * k }); };
  // A right press on the canvas owns the next context menu wherever it opens: Windows opens it on the
  // release, so a right drag that ends off the canvas would otherwise get the browser's menu.
  let ownsContext = false;
  const onAnyDown = () => { ownsContext = false; };   // window capture: runs before onDown sets it again
  const onContext = (e: Event) => { if (ownsContext || e.target === canvas) { e.preventDefault(); ownsContext = false; } };
  // ---- keyboard -------------------------------------------------------------------------------------
  const mods = (e: KeyboardEvent) => {
    const s = sticky();
    return { shift: e.shiftKey || Boolean(s.shift), ctrl: e.ctrlKey || Boolean(s.ctrl), alt: e.altKey || Boolean(s.alt), meta: e.metaKey || Boolean(s.meta) };
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.key === 'Process' || e.keyCode === 229 || e.key === 'Unidentified') return;   // IME / phone keyboard → input events
    if (MODIFIERS.has(e.key)) return;
    const m = mods(e);
    if (NAMED.has(e.key) || m.ctrl || m.meta || m.alt) {
      e.preventDefault();
      send({ t: 'key', key: e.key, code: e.code, mods: m });
      return;
    }
    if (e.key.length === 1) { e.preventDefault(); send({ t: 'text', text: e.key }); }
  };
  const onInput = (e: Event) => {
    const ie = e as globalThis.InputEvent;
    if (ie.isComposing) return;
    if (ie.inputType === 'deleteContentBackward') send({ t: 'key', key: 'Backspace', code: 'Backspace', mods: {} });
    else if (ie.inputType === 'insertLineBreak') send({ t: 'key', key: 'Enter', code: 'Enter', mods: {} });
    else if (ie.data) send({ t: 'text', text: ie.data });
    keys.value = '';
  };
  const onCompositionEnd = (e: CompositionEvent) => { if (e.data) send({ t: 'text', text: e.data }); keys.value = ''; };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('pointerdown', onAnyDown, true);
  window.addEventListener('contextmenu', onContext, true);
  keys.addEventListener('keydown', onKeyDown);
  keys.addEventListener('input', onInput);
  keys.addEventListener('compositionend', onCompositionEnd);
  return () => {
    clearLong(); if (raf) cancelAnimationFrame(raf);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('pointerdown', onAnyDown, true);
    window.removeEventListener('contextmenu', onContext, true);
    keys.removeEventListener('keydown', onKeyDown);
    keys.removeEventListener('input', onInput);
    keys.removeEventListener('compositionend', onCompositionEnd);
  };
}
