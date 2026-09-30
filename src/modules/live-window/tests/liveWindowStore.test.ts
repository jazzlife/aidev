import { describe, expect, it } from 'vitest';

import { clampRect, liveWindows } from '@/modules/live-window/liveWindowStore';

describe('live windows', () => {
  it('opens, minimizes, restores, toggles and closes a window', () => {
    liveWindows.open('preview');
    expect(liveWindows.get('preview')).toMatchObject({ open: true, mode: 'float' });
    liveWindows.setMode('preview', 'min');
    expect(liveWindows.get('preview')?.mode).toBe('min');
    liveWindows.toggle('preview');   // a minimized window comes back instead of closing
    expect(liveWindows.get('preview')).toMatchObject({ open: true, mode: 'float' });
    liveWindows.toggle('preview');
    expect(liveWindows.get('preview')?.open).toBe(false);
  });

  it('keeps the maximized mode when reopened and brings the window to the front', () => {
    liveWindows.open('screen');
    liveWindows.setMode('screen', 'max');
    liveWindows.close('screen');
    liveWindows.open('preview');
    liveWindows.open('screen');
    expect(liveWindows.get('screen')?.mode).toBe('max');
    expect(liveWindows.get('screen')!.z).toBeGreaterThan(liveWindows.get('preview')!.z);
  });

  it('remembers the rectangle across page loads, never the open state', () => {
    liveWindows.open('preview');
    liveWindows.setRect('preview', { x: 40, y: 50, w: 500, h: 400 });
    const saved = JSON.parse(localStorage.getItem('aidev.liveWindows') ?? '{}');
    expect(saved.preview).toMatchObject({ x: 40, y: 50, w: 500, h: 400 });
  });

  it('clamps a window so its title bar stays reachable and it keeps a minimum size', () => {
    expect(clampRect({ x: 5000, y: -30, w: 100, h: 100 }, 1200, 800)).toEqual({ w: 320, h: 220, x: 1080, y: 0 });
    expect(clampRect({ x: -2000, y: 790, w: 2000, h: 2000 }, 1200, 800)).toEqual({ w: 1192, h: 792, x: -1064, y: 760 });
  });
});
