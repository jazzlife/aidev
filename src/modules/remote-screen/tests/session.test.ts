import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteScreenSession } from '@/modules/remote-screen/session';
import type { ScreenState } from '@/modules/remote-screen/session';
import { controlButton } from '@/modules/remote-screen/utils/controlButton';
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

/** The page's end of a direct connection, driven by the test. */
class FakeChannel {
  readyState = 'open';
  binaryType = 'blob';
  sent: string[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) { this.sent.push(data); }
  push(data: Uint8Array) { this.onmessage?.({ data: data.slice().buffer }); }
}
class FakePeer {
  static last: FakePeer | null = null;
  channel = new FakeChannel();
  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: { sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { FakePeer.last = this; }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=candidate:1 1 udp 2122260223 4f1c-77.local 5000 typ host\r\na=candidate:2 1 udp 1686052607 203.0.113.9 6000 typ srflx raddr 0.0.0.0 rport 0\r\n' }; }
  async setLocalDescription(d: { sdp: string }) { this.localDescription = d; }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.remote = d; }
  addEventListener() { /* gathering is complete already */ }
  close() { this.connectionState = 'closed'; }
}

describe('remote screen session (numbered frames, acks, latency)', () => {
  // jsdom has no 2D canvas: drawing is a no-op here
  beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); FakeSocket.last = null; });
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

  it('the picture size is known even when a paused snapshot already sized the canvas', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 64, height: 36, close: () => undefined })));
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;   // the snapshot's size
    let state: ScreenState | null = null;
    const session = new RemoteScreenSession(() => 'ws://test/screen?v=2', canvas, { mode: 'jpeg', window: 1, display: 0, fps: 5, maxWidth: 640, bitrate: 1000 }, (s) => { state = s; });
    FakeSocket.last!.push(numberedJpeg(1));
    await vi.waitFor(() => expect(state!.width).toBe(64));
    expect(state!.height).toBe(36);
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

  it('takes frames over a direct connection once they come, each number once, and falls back when it breaks', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    const drawn = vi.fn(async () => ({ width: 64, height: 36, close: () => undefined }));
    vi.stubGlobal('createImageBitmap', drawn);
    let state: ScreenState | null = null;
    const session = new RemoteScreenSession(() => 'ws://test/screen?v=2', document.createElement('canvas'), { mode: 'jpeg', window: 1, display: 0, fps: 5, maxWidth: 640, bitrate: 1000 }, (s) => { state = s; });
    const ws = FakeSocket.last!;
    ws.push(JSON.stringify({ type: 'started', streamId: 9, p2p: true, p2pInput: true }));
    // the offer goes without the mDNS host candidate (the runner cannot resolve it)
    await vi.waitFor(() => expect(ws.sent.some((m) => m.includes('"op":"rtc"'))).toBe(true));
    const offer = JSON.parse(ws.sent.find((m) => m.includes('"op":"rtc"'))!) as { offer: string };
    expect(offer.offer).toContain('203.0.113.9');
    expect(offer.offer).not.toContain('.local');
    ws.push(JSON.stringify({ type: 'rtc', streamId: 9, answer: 'v=0 answer' }));
    await vi.waitFor(() => expect(FakePeer.last!.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' }));

    // frame 1 over the server, then frame 2 directly in two pieces
    ws.push(numberedJpeg(1));
    await vi.waitFor(() => expect(ws.sent).toContain(JSON.stringify({ op: 'ack', seq: 1 })));
    const f2 = new Uint8Array(numberedJpeg(2));
    const dc = FakePeer.last!.channel;
    dc.push(new Uint8Array([0, ...f2.subarray(0, 4)]));
    dc.push(new Uint8Array([1, ...f2.subarray(4)]));
    await vi.waitFor(() => expect(dc.sent).toContain(JSON.stringify({ ack: 2 })));
    expect(ws.sent).toContain(JSON.stringify({ op: 'p2p', on: true }));
    expect(streamStatusLine(state!)).toContain('직접 연결');
    // the same frame from the server (sent before it stopped) is not shown again
    ws.push(numberedJpeg(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(drawn).toHaveBeenCalledTimes(2);

    // with control on, input goes over the channel too — once the gateway says the runner takes it there
    ws.push(JSON.stringify({ type: 'control', on: true }));
    session.input({ t: 'move', x: 0.2, y: 0.2 });
    expect(ws.sent).toContain(JSON.stringify({ op: 'input', ev: { t: 'move', x: 0.2, y: 0.2 } }));
    ws.push(JSON.stringify({ type: 'control-direct', on: true }));
    session.input({ t: 'move', x: 0.5, y: 0.5 });
    expect(dc.sent).toContain(JSON.stringify({ input: { t: 'move', x: 0.5, y: 0.5 } }));
    expect(ws.sent.filter((m) => m.includes('"op":"input"'))).toHaveLength(1);

    dc.onclose?.();
    session.input({ t: 'move', x: 0.1, y: 0.1 });
    expect(ws.sent).toContain(JSON.stringify({ op: 'input', ev: { t: 'move', x: 0.1, y: 0.1 } }));
    expect(ws.sent).toContain(JSON.stringify({ op: 'p2p', on: false }));
    expect(state!.direct).toBe(false);
    session.close();
  });

  it('control held by someone else: the button asks, withdraws, or (the owner) takes it back; the holder answers', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    let state: ScreenState | null = null;
    const session = new RemoteScreenSession(() => 'ws://test/screen?v=2', document.createElement('canvas'), { mode: 'jpeg', window: 1, display: 0, fps: 5, maxWidth: 640, bitrate: 1000 }, (s) => { state = s; });
    const ws = FakeSocket.last!;
    expect(controlButton(state ?? session.state)).toMatchObject({ label: '제어', op: 'on' });

    ws.push(JSON.stringify({ type: 'control-state', owner: false, holder: { name: 'alice', owner: true, me: false, mine: false }, requests: [] }));
    expect(controlButton(state!)).toMatchObject({ label: '제어권 요청', op: 'request', hint: 'alice 님이 제어 중' });
    session.controlRequest('request');
    expect(ws.sent).toContain(JSON.stringify({ op: 'control-request' }));
    ws.push(JSON.stringify({ type: 'control-state', owner: false, holder: { name: 'alice', owner: true, me: false, mine: false }, requests: [{ id: 4, name: 'bob', me: true }] }));
    expect(controlButton(state!)).toMatchObject({ label: '요청 취소', op: 'cancel' });
    ws.push(JSON.stringify({ type: 'control-note', message: 'alice 님이 제어권 요청을 거절했습니다' }));
    expect(state!.controlNote).toBe('alice 님이 제어권 요청을 거절했습니다');

    // the owner takes it back; the same account on another screen moves it here
    ws.push(JSON.stringify({ type: 'control-state', owner: true, holder: { name: 'bob', owner: false, me: false, mine: false }, requests: [] }));
    expect(controlButton(state!)).toMatchObject({ label: '제어권 회수', op: 'take' });
    ws.push(JSON.stringify({ type: 'control-state', owner: false, holder: { name: 'bob', owner: false, me: false, mine: true }, requests: [] }));
    expect(controlButton(state!)).toMatchObject({ label: '여기서 제어', op: 'on' });

    // the holder answers the first who asked
    ws.push(JSON.stringify({ type: 'control', on: true }));
    expect(controlButton(state!)).toMatchObject({ label: '제어 중', op: 'off', active: true });
    session.controlRequest('grant', 4);
    expect(ws.sent).toContain(JSON.stringify({ op: 'control-grant', to: 4 }));
    ws.push(JSON.stringify({ type: 'control', on: false, message: 'bob 님에게 제어권을 넘겨주었습니다' }));
    expect(state!).toMatchObject({ control: false, controlNote: 'bob 님에게 제어권을 넘겨주었습니다' });
    session.close();
  });

  it('only the holder connects directly: control opens the channel, losing control drops it', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 64, height: 36, close: () => undefined })));
    FakePeer.last = null;
    let state: ScreenState | null = null;
    const session = new RemoteScreenSession(() => 'ws://test/screen?v=2', document.createElement('canvas'), { mode: 'jpeg', window: 1, display: 0, fps: 5, maxWidth: 640, bitrate: 1000 }, (s) => { state = s; });
    const ws = FakeSocket.last!;
    ws.push(JSON.stringify({ type: 'started', streamId: 3, p2p: false, p2pInput: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(FakePeer.last).toBeNull();
    ws.push(JSON.stringify({ type: 'control', on: true, p2p: true, streamId: 3 }));
    await vi.waitFor(() => expect(ws.sent.some((m) => m.includes('"op":"rtc"'))).toBe(true));
    ws.push(JSON.stringify({ type: 'rtc', streamId: 3, answer: 'v=0 answer' }));
    const f1 = new Uint8Array(numberedJpeg(1));
    FakePeer.last!.channel.push(new Uint8Array([1, ...f1]));
    await vi.waitFor(() => expect(state!.direct).toBe(true));

    ws.push(JSON.stringify({ type: 'control', on: false, message: '소유자 alice 님이 제어권을 가져갔습니다' }));
    expect(state!).toMatchObject({ control: false, direct: false, controlNote: '소유자 alice 님이 제어권을 가져갔습니다' });
    expect(FakePeer.last!.connectionState).toBe('closed');
    expect(ws.sent).toContain(JSON.stringify({ op: 'p2p', on: false }));
    session.close();
  });

  it('says it decodes VP9 and feeds VP9 frames (kind 4) to a VP9 decoder', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const configured: string[] = [];
    const decoded: string[] = [];
    class FakeDecoder {
      static isConfigSupported = vi.fn(async (c: { codec: string }) => ({ supported: c.codec.startsWith('vp09') }));
      state = 'unconfigured';
      decodeQueueSize = 0;
      configure(c: { codec: string }) { configured.push(c.codec); this.state = 'configured'; }
      decode(chunk: { type: string }) { decoded.push(chunk.type); }
      close() { this.state = 'closed'; }
    }
    vi.stubGlobal('VideoDecoder', FakeDecoder);
    vi.stubGlobal('EncodedVideoChunk', class { type: string; constructor(o: { type: string }) { this.type = o.type; } });
    const urls: string[] = [];
    const session = new RemoteScreenSession((o) => { urls.push(String(o.codecs)); return 'ws://test/screen?v=2'; }, document.createElement('canvas'), { mode: 'video', window: 1, display: 0, fps: 30, maxWidth: 1440, bitrate: 4000 }, () => undefined);
    await vi.waitFor(() => expect(FakeSocket.last?.url).toBe('ws://test/screen?v=2'));
    expect(urls).toEqual(['vp9,h264']);
    // `[kind 4][flags key|numbered][seq 1][VP9 frame marker …]`
    FakeSocket.last!.push(new Uint8Array([4, 1 | 2, 0, 0, 0, 1, 0x82, 0x49, 0x83, 0x42]).buffer);
    expect(configured).toEqual(['vp09.00.50.08']);
    expect(decoded).toEqual(['key']);
    session.close();
  });
});
