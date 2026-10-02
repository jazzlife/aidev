import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteScreenSession } from '@/modules/remote-screen/session';
import type { ScreenState } from '@/modules/remote-screen/session';
import { streamStatsDetail, streamStatusLine } from '@/modules/remote-screen/utils/streamStats';

/** A WebSocket the test drives: what the page sent, and messages pushed to it. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 1;
  binaryType = 'blob';
  sent: string[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.last = this; }
  send(data: string) { this.sent.push(data); }
  close() { /* closed */ }
  push(data: unknown) { this.onmessage?.({ data }); }
}
(FakeSocket as unknown as { OPEN: number }).OPEN = 1;

/** A JPEG frame from a 0.15+ runner: `[kind 3][flags key|numbered][seq u32 BE][bytes]`. */
function numberedJpeg(seq: number) {
  const b = new Uint8Array(10);
  b.set([3, 1 | 2, (seq >>> 24) & 255, (seq >>> 16) & 255, (seq >>> 8) & 255, seq & 255, 0xff, 0xd8, 0xff, 0xd9]);
  return b.buffer;
}

describe('remote screen session (numbered frames, acks, latency)', () => {
  // jsdom has no 2D canvas: drawing is a no-op here
  beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('acks a numbered frame once it is drawn, and reads the stream numbers', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 64, height: 36, close: () => undefined })));
    let state: ScreenState | null = null;
    const session = new RemoteScreenSession(() => 'ws://test/screen?v=2', document.createElement('canvas'), { mode: 'jpeg', window: 1, display: 0, fps: 5, maxWidth: 640, bitrate: 1000 }, (s) => { state = s; });
    const ws = FakeSocket.last!;
    ws.push(numberedJpeg(7));
    await vi.waitFor(() => expect(ws.sent).toContain(JSON.stringify({ op: 'ack', seq: 7 })));
    expect(state!.width).toBe(64);

    ws.push(JSON.stringify({ type: 'stats', captureMs: 20, scaleMs: 4, encodeMs: 10, loopMs: 80, skipped: 2, bitrate: 3000 }));
    // capture + scale + encode + half of (loop + decode): no video frame decoded here, so decode counts as 0
    expect(state!.stats).toMatchObject({ captureMs: 20, loopMs: 80, decodeMs: null, latencyMs: 74, skipped: 2, bitrate: 3000 });
    expect(streamStatusLine(state!)).toContain('지연 ~74ms');
    expect(streamStatsDetail(state!)).toContain('밀려서 건너뜀 2');
    session.close();
  });

  it('an unnumbered frame (older runner) is shown and never acked', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const drawn = vi.fn(async () => ({ width: 10, height: 10, close: () => undefined }));
    vi.stubGlobal('createImageBitmap', drawn);
    const session = new RemoteScreenSession(() => 'ws://test/screen', document.createElement('canvas'), { mode: 'jpeg', window: 1, display: 0, fps: 5, maxWidth: 640, bitrate: 1000 }, () => undefined);
    const ws = FakeSocket.last!;
    ws.push(new Uint8Array([3, 1, 0xff, 0xd8, 0xff, 0xd9]).buffer);
    await vi.waitFor(() => expect(drawn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(ws.sent.some((m) => m.includes('"ack"'))).toBe(false);
    session.close();
  });
});
