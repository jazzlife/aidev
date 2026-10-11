import { describe, expect, it } from 'vitest';

import { bindRemoteInput } from '@/modules/remote-screen/input';
import type { InputEvent } from '@/modules/remote-screen/session';
import { bindViewZoom, type ZoomGesture } from '@/modules/remote-screen/viewZoom';

/** A pointer event jsdom can dispatch (it has no PointerEvent constructor). */
function pointer(type: string, id: number, x: number, y: number, pointerType = 'touch') {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 });
  Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: pointerType } });
  return e;
}
function setup() {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  const keys = document.createElement('textarea');
  container.append(canvas); document.body.append(container, keys);
  const gesture: ZoomGesture = { pinching: false };
  const scales: number[] = [];
  const zoom = bindViewZoom(container, canvas, gesture, () => true, (s) => scales.push(s));
  return { container, canvas, keys, gesture, scales, zoom };
}

describe('remote picture zoom (this device only)', () => {
  it('ctrl + wheel zooms, a plain wheel does not, reset goes back to fit', () => {
    const { container, canvas, scales, zoom } = setup();
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true }));
    expect(scales).toEqual([]);
    const ctrl = new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    canvas.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(scales.at(-1)).toBeGreaterThan(1.4);
    expect(canvas.style.transform).toContain('scale(');
    // a press on a button over the picture (the reset chip) is not a drag: no pointer capture, its click arrives
    const chip = document.createElement('button'); container.append(chip);
    const captured: number[] = []; container.setPointerCapture = (id: number) => { captured.push(id); };
    chip.dispatchEvent(pointer('pointerdown', 9, 10, 10, 'mouse'));
    chip.dispatchEvent(pointer('pointerup', 9, 10, 10, 'mouse'));
    expect(captured).toEqual([]);
    canvas.dispatchEvent(pointer('pointerdown', 8, 10, 10, 'mouse'));
    expect(captured).toEqual([8]);
    canvas.dispatchEvent(pointer('pointerup', 8, 10, 10, 'mouse'));
    zoom.reset();
    expect(scales.at(-1)).toBe(1);
    expect(canvas.style.transform).toBe('');
    zoom.cleanup();
  });

  it('a pinch zooms and sends no remote scroll; lifting the fingers is not a tap', () => {
    const { canvas, keys, gesture, scales, zoom } = setup();
    const sent: InputEvent[] = [];
    const unbind = bindRemoteInput(canvas, keys, (ev) => sent.push(ev), () => ({}), gesture);
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 100));
    canvas.dispatchEvent(pointer('pointerdown', 2, 140, 100));
    canvas.dispatchEvent(pointer('pointermove', 2, 220, 100));   // fingers apart: a pinch
    expect(gesture.pinching).toBe(true);
    expect(scales.at(-1)).toBeGreaterThan(2);
    canvas.dispatchEvent(pointer('pointermove', 1, 90, 100));
    expect(sent.filter((e) => e.t === 'wheel')).toEqual([]);
    canvas.dispatchEvent(pointer('pointerup', 2, 220, 100));
    canvas.dispatchEvent(pointer('pointerup', 1, 90, 100));
    expect(gesture.pinching).toBe(false);
    expect(sent.filter((e) => e.t === 'button')).toEqual([]);
    unbind(); zoom.cleanup();
  });

  it('a two-finger tap is a right click where the fingers touched (a little jitter is fine)', () => {
    const { canvas, keys, gesture, zoom } = setup();
    const sent: InputEvent[] = [];
    const unbind = bindRemoteInput(canvas, keys, (ev) => sent.push(ev), () => ({}), gesture);
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 100));
    canvas.dispatchEvent(pointer('pointerdown', 2, 140, 100));
    canvas.dispatchEvent(pointer('pointermove', 2, 142, 102));
    canvas.dispatchEvent(pointer('pointerup', 1, 100, 100));
    canvas.dispatchEvent(pointer('pointermove', 2, 150, 130));   // the last finger moving: no drag
    canvas.dispatchEvent(pointer('pointerup', 2, 150, 130));
    expect(sent.filter((e) => e.t === 'wheel')).toEqual([]);
    expect(sent.filter((e) => e.t === 'button').map((e) => (e.t === 'button' ? `${e.b}:${e.down}` : ''))).toEqual(['right:true', 'right:false']);
    unbind(); zoom.cleanup();
  });

  it('two fingers moving together still scroll the PC', () => {
    const { canvas, keys, gesture, zoom } = setup();
    const sent: InputEvent[] = [];
    const unbind = bindRemoteInput(canvas, keys, (ev) => sent.push(ev), () => ({}), gesture);
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 200));
    canvas.dispatchEvent(pointer('pointerdown', 2, 140, 200));
    // the fingers' moves arrive one at a time, a few pixels each
    for (let y = 195; y >= 150; y -= 5) { canvas.dispatchEvent(pointer('pointermove', 1, 100, y)); canvas.dispatchEvent(pointer('pointermove', 2, 140, y)); }
    expect(gesture.pinching).toBe(false);
    expect(sent.some((e) => e.t === 'wheel')).toBe(true);
    canvas.dispatchEvent(pointer('pointerup', 1, 100, 150));
    canvas.dispatchEvent(pointer('pointerup', 2, 140, 150));
    expect(sent.some((e) => e.t === 'button')).toBe(false);   // a scroll is not a right click
    unbind(); zoom.cleanup();
  });
});
