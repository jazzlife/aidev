import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteScreenSession, screenSocketUrl } from '@/modules/remote-screen/session';
import type { ScreenState } from '@/modules/remote-screen/session';

/** A WebSocket the test drives. */
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

/** Web Audio as far as sound.ts uses it: what was scheduled when, at which gain. */
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 10;
  destination = {};
  started: number[] = [];
  gainNode = { gain: { value: 1 }, connect: () => undefined };
  onstatechange: (() => void) | null = null;
  constructor() { FakeAudioContext.last = this; }
  createGain() { return this.gainNode; }
  createBuffer(_channels: number, frames: number, rate: number) { return { duration: frames / rate, getChannelData: () => new Float32Array(frames) }; }
  createBufferSource() { return { buffer: null, connect: () => undefined, start: (at: number) => this.started.push(at) }; }
  async resume() { this.state = 'running'; this.onstatechange?.(); }
  async close() { this.state = 'closed'; }
}
/** An Opus decoder that hands back 20 ms of sound per packet. */
class FakeAudioDecoder {
  static made = 0;
  static packets: number[] = [];
  static isConfigSupported = vi.fn(async (c: { codec: string }) => ({ supported: c.codec === 'opus' }));
  constructor(private init: { output: (d: unknown) => void }) { FakeAudioDecoder.made++; }
  configure() { /* opus */ }
  decode(chunk: { data: Uint8Array }) {
    FakeAudioDecoder.packets.push(chunk.data[0]);
    this.init.output({ numberOfChannels: 2, numberOfFrames: 960, sampleRate: 48_000, copyTo: () => undefined, close: () => undefined });
  }
  close() { /* closed */ }
}

/** `[kind 5][flags][seq u32 BE][packet byte]` */
const sound = (seq: number, first = false, byte = 7) => new Uint8Array([5, first ? 1 : 0, (seq >>> 24) & 255, (seq >>> 16) & 255, (seq >>> 8) & 255, seq & 255, byte]).buffer;
const opts = { mode: 'jpeg' as const, window: 1, display: 0, fps: 5, maxWidth: 640, bitrate: 1000 };

describe('remote screen sound', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    FakeSocket.last = null; FakeAudioDecoder.made = 0; FakeAudioDecoder.packets = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('a browser without WebCodecs audio asks for pictures only and says why there is no sound', () => {
    let state: ScreenState | null = null;
    const session = new RemoteScreenSession((o) => `ws://test/screen?audio=${String(o.audio)}`, document.createElement('canvas'), opts, (s) => { state = s; });
    expect(FakeSocket.last!.url).toBe('ws://test/screen?audio=false');
    FakeSocket.last!.push(JSON.stringify({ type: 'started', streamId: 1 }));
    expect(state!).toMatchObject({ audio: false, audioNote: '이 브라우저는 원격 PC의 소리를 재생할 수 없습니다' });
    expect(screenSocketUrl(1, { ...opts, audio: false })).toContain('v=2');
    expect(screenSocketUrl(1, { ...opts, audio: true })).toContain('v=3');
    session.close();
  });

  it('plays the PC\'s sound a little ahead, each packet once, apart from the picture\'s numbers, at the page\'s volume', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
    vi.stubGlobal('EncodedAudioChunk', class { data: Uint8Array; constructor(o: { data: Uint8Array }) { this.data = o.data; } });
    const drawn = vi.fn(async () => ({ width: 64, height: 36, close: () => undefined }));
    vi.stubGlobal('createImageBitmap', drawn);
    let state: ScreenState | null = null;
    const session = new RemoteScreenSession((o) => `ws://test/screen?audio=${String(o.audio)}`, document.createElement('canvas'), opts, (s) => { state = s; });
    session.setSound(0.4, false);
    await vi.waitFor(() => expect(FakeSocket.last?.url).toBe('ws://test/screen?audio=true'));
    const ws = FakeSocket.last!;
    ws.push(JSON.stringify({ type: 'started', streamId: 1, audio: true }));
    expect(state!).toMatchObject({ audio: true, audioBlocked: false, audioNote: null });
    const ctx = FakeAudioContext.last!;
    expect(ctx.gainNode.gain.value).toBe(0.4);

    ws.push(sound(100, true, 1));
    ws.push(sound(101, false, 2));
    ws.push(sound(101, false, 2));   // the same packet from the other path
    expect(FakeAudioDecoder.packets).toEqual([1, 2]);
    // the first plays 80 ms ahead, the next right after it
    expect(ctx.started[0]).toBeCloseTo(10.08);
    expect(ctx.started[1]).toBeCloseTo(10.1);
    // the picture's numbers are untouched: frame 1 is still shown after sound numbered 100+
    ws.push(new Uint8Array([3, 1 | 2, 0, 0, 0, 1, 0xff, 0xd8, 0xff, 0xd9]).buffer);
    await vi.waitFor(() => expect(drawn).toHaveBeenCalled());

    // muted: silent at once; a new encoder on the PC (after a pause): a new decoder here
    session.setSound(0.4, true);
    expect(ctx.gainNode.gain.value).toBe(0);
    ws.push(sound(102, true, 3));
    expect(FakeAudioDecoder.made).toBe(2);
    // a capture error reaches the page
    ws.push(JSON.stringify({ type: 'audio', error: 'no device' }));
    expect(state!.audioNote).toBe('소리를 가져오지 못했습니다: no device');
    session.close();
    expect(ctx.state).toBe('closed');
  });

  it('a browser that holds the sound waits for a click, and the sound of that time is not played late', async () => {
    vi.stubGlobal('AudioContext', class extends FakeAudioContext { state: 'running' | 'suspended' | 'closed' = 'suspended'; });
    vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
    vi.stubGlobal('EncodedAudioChunk', class { data: Uint8Array; constructor(o: { data: Uint8Array }) { this.data = o.data; } });
    let state: ScreenState | null = null;
    const session = new RemoteScreenSession(() => 'ws://test/screen', document.createElement('canvas'), opts, (s) => { state = s; });
    await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
    FakeSocket.last!.push(JSON.stringify({ type: 'started', streamId: 1, audio: true }));
    expect(state!.audioBlocked).toBe(true);
    FakeSocket.last!.push(sound(1, true));
    expect(FakeAudioDecoder.packets).toEqual([]);
    document.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(state!.audioBlocked).toBe(false));
    FakeSocket.last!.push(sound(2));
    expect(FakeAudioDecoder.packets).toEqual([7]);
    session.close();
  });
});
