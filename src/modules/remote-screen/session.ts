/**
 * Live screen session (IMPLEMENTATION-PLAN §3.12, F-07b/F-07c), non-visual: one WebSocket to
 * `/api/aidev/targets/:id/screen` for one program window on the PC (`window`; runners before 0.7 stream a
 * whole `display`), frames `[kind][flags][data]` (1 = H.264 access unit from the runner's built-in encoder,
 * 2 = VP8 frame from 0.6 runners, 3 = JPEG; flags bit 0 = keyframe) drawn on a canvas. Video is decoded with WebCodecs `VideoDecoder`
 * (hardware where available; Annex B H.264 needs no `description`); without WebCodecs the session asks
 * for JPEG frames instead. Remote control: `setControl(true)` then `input(ev)` (mouse/keyboard events in
 * the runner's vocabulary, see runner input.rs).
 */
import { getStoredAuthToken } from '@/shared/authToken';

export type ScreenMode = 'video' | 'jpeg';
export type ScreenOptions = { mode: ScreenMode; window: number | null; display: number; fps: number; maxWidth: number; bitrate: number; codec?: 'h264' | 'vp8' };
export type InputEvent =
  | { t: 'move'; x: number; y: number }   // x, y ∈ [0,1] of the picture (the window); the gateway adds which window
  | { t: 'button'; b: 'left' | 'right' | 'middle'; down: boolean; x?: number; y?: number }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'key'; key: string; code: string; mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } }
  | { t: 'text'; text: string };
export type ScreenState = {
  status: 'connecting' | 'live' | 'closed' | 'error';
  codec: string | null;
  note: string | null;
  error: string | null;
  controlAvailable: boolean;
  control: boolean;
  width: number;
  height: number;
  fps: number;
  kbps: number;
};

const KIND_H264 = 1;
const KIND_VP8 = 2;
const KIND_JPEG = 3;

/** avc1.PPCCLL from the SPS in an Annex B access unit (null when the unit has no SPS). */
export function avcCodecFromAnnexB(au: Uint8Array): string | null {
  for (let i = 0; i + 4 < au.length; i++) {
    const three = au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1;
    if (!three) continue;
    const nal = i + 3;
    if ((au[nal] & 0x1f) === 7 && nal + 3 < au.length) {
      const hex = (b: number) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(au[nal + 1])}${hex(au[nal + 2])}${hex(au[nal + 3])}`;
    }
  }
  return null;
}

/** WebSocket URL of a target's screen (same origin; the stored token or the session cookie authenticates). */
export function screenSocketUrl(targetId: number, o: ScreenOptions) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getStoredAuthToken();
  const q = new URLSearchParams({ mode: o.mode, ...(o.window !== null ? { window: String(o.window) } : {}), display: String(o.display), fps: String(o.fps), maxWidth: String(o.maxWidth), bitrate: String(o.bitrate), codec: o.codec ?? 'h264', ...(token ? { token } : {}) });
  return `${protocol}//${window.location.host}/api/aidev/targets/${targetId}/screen?${q}`;
}

export const webCodecsAvailable = () => typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;

export class RemoteScreenSession {
  private ws: WebSocket | null = null;
  private decoder: VideoDecoder | null = null;
  private decoderCodec: string | null = null;
  private waitKey = true;
  private ts = 0;
  private frames = 0;
  private bytes = 0;
  private windowStart = performance.now();
  private jpegBusy = false;
  private closed = false;
  state: ScreenState = { status: 'connecting', codec: null, note: null, error: null, controlAvailable: false, control: false, width: 0, height: 0, fps: 0, kbps: 0 };

  constructor(private url: (opts: ScreenOptions) => string, private canvas: HTMLCanvasElement, private opts: ScreenOptions, private onState: (s: ScreenState) => void) {
    if (opts.mode === 'video' && !webCodecsAvailable()) this.opts = { ...opts, mode: 'jpeg', fps: 5 };
    this.connect();
  }

  private patch(p: Partial<ScreenState>) { this.state = { ...this.state, ...p }; this.onState(this.state); }

  private connect() {
    const ws = new WebSocket(this.url(this.opts));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') return this.onText(event.data);
      this.onFrame(new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onclose = () => { if (!this.closed) this.patch({ status: 'closed', control: false }); };
    ws.onerror = () => this.patch({ status: 'error', error: '화면 연결 오류' });
  }

  private onText(raw: string) {
    let m: { type: string; message?: string; codec?: string; reason?: string | null; control?: boolean; on?: boolean };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'started') this.patch({ status: 'live', error: null, controlAvailable: Boolean(m.control) });
    else if (m.type === 'format') { this.patch({ codec: m.codec ?? null, note: m.reason ?? null }); this.resetDecoder(); }
    else if (m.type === 'control') this.patch({ control: Boolean(m.on), error: null });
    else if (m.type === 'error') this.patch({ error: m.message ?? '오류' });
    else if (m.type === 'offline') this.patch({ status: 'closed', error: '원격 PC가 오프라인입니다', control: false });
  }

  private tick(n: number) {
    this.frames++; this.bytes += n;
    const now = performance.now();
    if (now - this.windowStart >= 1000) {
      const secs = (now - this.windowStart) / 1000;
      this.patch({ fps: Math.round(this.frames / secs), kbps: Math.round((this.bytes * 8) / 1000 / secs) });
      this.frames = 0; this.bytes = 0; this.windowStart = now;
    }
  }

  private draw(source: CanvasImageSource, w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.patch({ width: w, height: h }); }
    this.canvas.getContext('2d')?.drawImage(source, 0, 0, w, h);
  }

  private resetDecoder() {
    try { this.decoder?.close(); } catch { /* already closed */ }
    this.decoder = null; this.decoderCodec = null; this.waitKey = true;
  }

  private ensureDecoder(codec: string) {
    if (this.decoder && this.decoderCodec === codec && this.decoder.state === 'configured') return true;
    this.resetDecoder();
    const decoder = new VideoDecoder({
      output: (frame) => { this.draw(frame, frame.displayWidth, frame.displayHeight); frame.close(); },
      error: (e) => { this.patch({ error: `영상 디코딩 오류: ${e.message}` }); this.resetDecoder(); },
    });
    try { decoder.configure({ codec, optimizeForLatency: true }); }
    catch (e) { this.patch({ error: `이 브라우저가 ${codec}를 재생할 수 없습니다 — JPEG로 전환합니다` }); this.setOptions({ ...this.opts, mode: 'jpeg', fps: 5 }); return false; }
    this.decoder = decoder; this.decoderCodec = codec;
    return true;
  }

  private onFrame(buf: Uint8Array) {
    if (buf.length < 3) return;
    const kind = buf[0]; const key = (buf[1] & 1) === 1; const data = buf.subarray(2);
    this.tick(buf.length);
    if (kind === KIND_JPEG) {
      if (this.jpegBusy) return;   // drop while the previous picture is still decoding
      this.jpegBusy = true;
      createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }))
        .then((bmp) => { this.draw(bmp, bmp.width, bmp.height); bmp.close(); })
        .catch(() => {})
        .finally(() => { this.jpegBusy = false; });
      return;
    }
    if (!webCodecsAvailable()) return;
    if (this.waitKey && !key) return;
    const codec = kind === KIND_VP8 ? 'vp8' : kind === KIND_H264 ? (key ? avcCodecFromAnnexB(data) ?? this.decoderCodec : this.decoderCodec) : null;
    if (!codec || !this.ensureDecoder(codec) || !this.decoder) return;
    // keep latency low: a decoder that falls behind skips to the next keyframe
    if (this.decoder.decodeQueueSize > 8 && !key) { this.waitKey = true; return; }
    this.waitKey = false;
    this.ts += 33_333;
    try { this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data })); }
    catch { this.resetDecoder(); }
  }

  private send(obj: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  /** New window / quality: the gateway moves this viewer to the matching stream. */
  setOptions(opts: ScreenOptions) {
    this.opts = opts.mode === 'video' && !webCodecsAvailable() ? { ...opts, mode: 'jpeg', fps: 5 } : opts;
    this.resetDecoder();
    this.send({ op: 'config', ...this.opts });
  }

  setControl(on: boolean) { this.send({ op: 'control', on }); }

  input(ev: InputEvent) { if (this.state.control) this.send({ op: 'input', ev }); }

  close() {
    this.closed = true;
    if (this.state.control) this.send({ op: 'control', on: false });
    this.ws?.close(1000);
    this.resetDecoder();
  }
}
