/**
 * Live screen session (IMPLEMENTATION-PLAN §3.12, F-07b/F-07c), non-visual: one WebSocket to
 * `/api/aidev/targets/:id/screen` for one program window on the PC (`window`; runners before 0.7 stream a
 * whole `display`), frames `[kind][flags][data]` (1 = H.264 access unit from the runner's built-in encoder,
 * 2 = VP8 frame from 0.6 runners, 3 = JPEG; flags bit 0 = keyframe) drawn on a canvas. Video is decoded with WebCodecs `VideoDecoder`
 * (hardware where available; Annex B H.264 needs no `description`); without WebCodecs the session asks
 * for JPEG frames instead. Remote control: `setControl(true)` then `input(ev)` (mouse/keyboard events in
 * the runner's vocabulary, see runner input.rs).
 * Latency (F-07d, 2026-10-02): the page asks for numbered frames (`v=2`: flags bit 1, a u32 after the flags) and
 * acks each one once it is on the canvas — the runner paces itself by those acks, so the picture never sits in a
 * queue. Once a second the runner's numbers (capture, scale, encode, the send → shown → ack loop) arrive as
 * `stats`; with this page's decode time they make `state.stats` and its latency estimate.
 * Codecs (F-18, 2026-10-03): the page says which it decodes (`codecs=vp9,h264`); runners with libvpx answer with VP9
 * (kind 4) from their CPU path — several times faster to encode than OpenH264 there — and H.264 otherwise.
 * Direct (F-18 P2P, runner 0.18+): when `started` says `p2p`, the page also opens a WebRTC data channel to the runner
 * (offer/answer over this socket, STUN only). The runner sends the same numbered frames there, in 16 KB pieces
 * `[last u8][bytes]`; each frame number is taken once from whichever path brings it first, so the switch has no gap.
 * Once frames come directly the page says `{op:"p2p", on:true}` (the gateway stops sending them) and acks on the
 * channel; if the channel fails it says `on:false` and the gateway path resumes from the next keyframe. With runners
 * that take it (`started.p2pInput`, 0.18.1+) the remote-control input goes over the channel as well — the gateway path
 * crosses the server (and its CDN) twice per event, the channel goes straight to the PC.
 */
import { getStoredAuthToken } from '@/shared/authToken';

export type ScreenMode = 'video' | 'jpeg';
export type ScreenOptions = { mode: ScreenMode; window: number | null; display: number; fps: number; maxWidth: number; bitrate: number; codec?: 'h264' | 'vp8'; codecs?: string[] };
export type InputEvent =
  | { t: 'move'; x: number; y: number }   // x, y ∈ [0,1] of the picture (the window); the gateway adds which window
  | { t: 'button'; b: 'left' | 'right' | 'middle'; down: boolean; x?: number; y?: number }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'key'; key: string; code: string; mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } }
  | { t: 'text'; text: string };
/** One second of the stream's numbers (runner and this page), in milliseconds; latencyMs is the estimate of
 *  capture → on screen: capture + scale + encode + half of (loop + decode) — the loop runs to the ack and back. */
export type ScreenStats = { captureMs: number; scaleMs: number; encodeMs: number; loopMs: number | null; decodeMs: number | null; latencyMs: number | null; skipped: number; bitrate: number };

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
  stats: ScreenStats | null;
  /** the frames come straight from the PC (WebRTC), not through the server */
  direct: boolean;
};

const KIND_H264 = 1;
const KIND_VP8 = 2;
const KIND_JPEG = 3;
const KIND_VP9 = 4;
/** VP9 profile 0, 8-bit, level 5 (up to 4096×2176) — what the runner's libvpx sends. */
const VP9_CODEC = 'vp09.00.50.08';
/** The STUN server both ends ask for their public address (the runner's rtc.rs uses the same). */
const STUN_URL = 'stun:stun.cloudflare.com:3478';
/** How long the page gathers its candidates before it sends the offer anyway. */
const GATHER_MS = 2000;

/** The page's side of a direct connection: frames arrive in pieces on `channel`. */
type DirectPeer = { pc: RTCPeerConnection; channel: RTCDataChannel; streamId: number; pieces: Uint8Array[]; live: boolean };

/** The offer once the candidates are gathered (or GATHER_MS passed), without mDNS host names (the runner cannot resolve them). */
async function gatheredOffer(pc: RTCPeerConnection) {
  await pc.setLocalDescription(await pc.createOffer());
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const done = () => { if (pc.iceGatheringState === 'complete') resolve(); };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, GATHER_MS);
    });
  }
  return (pc.localDescription?.sdp ?? '').split('\r\n').filter((line) => !/^a=candidate:\S+ \d+ \S+ \d+ \S+\.local /.test(line)).join('\r\n');
}

let decodableCodecs: Promise<string[]> | null = null;
/** The video codecs this browser decodes with WebCodecs, best first (checked once per page). */
function videoCodecs(): Promise<string[]> {
  decodableCodecs ??= (async () => {
    if (!webCodecsAvailable()) return ['h264'];
    const vp9 = await VideoDecoder.isConfigSupported({ codec: VP9_CODEC, optimizeForLatency: true }).then((r) => Boolean(r.supported), () => false);
    return vp9 ? ['vp9', 'h264'] : ['h264'];
  })();
  return decodableCodecs;
}

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
  const q = new URLSearchParams({ v: '2', mode: o.mode, ...(o.window !== null ? { window: String(o.window) } : {}), display: String(o.display), fps: String(o.fps), maxWidth: String(o.maxWidth), bitrate: String(o.bitrate), codec: o.codec ?? 'h264', ...(o.codecs?.length ? { codecs: o.codecs.join(',') } : {}), ...(token ? { token } : {}) });
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
  /** chunk timestamp → frame number and when it went to the decoder */
  private pending = new Map<number, { seq: number; at: number }>();
  private decodeTotal = 0;
  private decodeCount = 0;
  /** the newest frame number taken (from either path) since the stream started */
  private lastSeq = 0;
  private peer: DirectPeer | null = null;
  /** the runner takes input over the direct channel (else it always goes through the gateway) */
  private directInput = false;
  state: ScreenState = { status: 'connecting', codec: null, note: null, error: null, controlAvailable: false, control: false, width: 0, height: 0, fps: 0, kbps: 0, stats: null, direct: false };

  constructor(private url: (opts: ScreenOptions) => string, private canvas: HTMLCanvasElement, private opts: ScreenOptions, private onState: (s: ScreenState) => void) {
    if (opts.mode === 'video' && !webCodecsAvailable()) this.opts = { ...opts, mode: 'jpeg', fps: 5 };
    void this.connect();
  }

  private patch(p: Partial<ScreenState>) { this.state = { ...this.state, ...p }; this.onState(this.state); }

  private async connect() {
    if (this.opts.mode === 'video') this.opts = { ...this.opts, codecs: await videoCodecs() };
    if (this.closed) return;
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
    let m: { type: string; message?: string; codec?: string; reason?: string | null; control?: boolean; on?: boolean; seq?: number; streamId?: number; p2p?: boolean; p2pInput?: boolean; answer?: string } & Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'stats') return this.onStats(m);
    if (m.type === 'started') {
      // a new stream: frame numbers start over, and a direct path is tried for it
      this.lastSeq = 0;
      this.closePeer();
      this.directInput = Boolean(m.p2pInput);
      this.patch({ status: 'live', error: null, controlAvailable: Boolean(m.control), direct: false });
      if (m.p2p && typeof m.streamId === 'number' && typeof RTCPeerConnection !== 'undefined') void this.openPeer(m.streamId);
    } else if (m.type === 'rtc') {
      if (!this.peer || m.streamId !== this.peer.streamId) return;
      if (typeof m.answer === 'string') this.peer.pc.setRemoteDescription({ type: 'answer', sdp: m.answer }).catch(() => this.closePeer());
      else this.closePeer();   // the runner could not: the server path stays
    } else if (m.type === 'format') {
      this.patch({ codec: m.codec ?? null, note: m.reason ?? null });
      // the note may come after its keyframe (it travels the other path): reset only before that frame
      if (!(typeof m.seq === 'number' && this.lastSeq >= m.seq)) this.resetDecoder();
    }
    else if (m.type === 'control') this.patch({ control: Boolean(m.on), error: null });
    else if (m.type === 'error') this.patch({ error: m.message ?? '오류' });
    else if (m.type === 'offline') this.patch({ status: 'closed', error: '원격 PC가 오프라인입니다', control: false });
  }

  private onStats(m: Record<string, unknown>) {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const loopMs = typeof m.loopMs === 'number' ? m.loopMs : null;
    const decodeMs = this.decodeCount ? Math.round((this.decodeTotal / this.decodeCount) * 10) / 10 : null;
    this.decodeTotal = 0; this.decodeCount = 0;
    const [captureMs, scaleMs, encodeMs] = [num(m.captureMs), num(m.scaleMs), num(m.encodeMs)];
    const latencyMs = loopMs === null ? null : Math.round(captureMs + scaleMs + encodeMs + (loopMs + (decodeMs ?? 0)) / 2);
    this.patch({ stats: { captureMs, scaleMs, encodeMs, loopMs, decodeMs, latencyMs, skipped: num(m.skipped), bitrate: num(m.bitrate) } });
  }

  /** The frame is on the canvas: tell the runner (it sends the next ones only as fast as they are shown). */
  private shown(seq: number) {
    if (seq <= 0) return;
    if (this.peer?.live && this.peer.channel.readyState === 'open') this.peer.channel.send(JSON.stringify({ ack: seq }));
    else this.send({ op: 'ack', seq });
  }

  /** Offer the runner a direct connection for this stream; the server path carries on until frames come over it. */
  private async openPeer(streamId: number) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
    const channel = pc.createDataChannel('screen');
    channel.binaryType = 'arraybuffer';
    const peer: DirectPeer = { pc, channel, streamId, pieces: [], live: false };
    this.peer = peer;
    channel.onmessage = (event) => { if (event.data instanceof ArrayBuffer) this.onPiece(peer, new Uint8Array(event.data)); };
    channel.onclose = () => this.peerLost(peer);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.peerLost(peer); };
    try {
      const offer = await gatheredOffer(pc);
      if (this.peer === peer) this.send({ op: 'rtc', offer });
    } catch { this.peerLost(peer); }
  }

  private onPiece(peer: DirectPeer, piece: Uint8Array) {
    if (this.peer !== peer || piece.length < 1) return;
    peer.pieces.push(piece.subarray(1));
    if ((piece[0] & 1) === 0) return;
    const frame = peer.pieces.length === 1 ? peer.pieces[0] : new Uint8Array(peer.pieces.reduce((n, p) => n + p.length, 0));
    if (peer.pieces.length > 1) { let at = 0; for (const p of peer.pieces) { frame.set(p, at); at += p.length; } }
    peer.pieces = [];
    if (!peer.live) {
      // frames come directly now: the server stops sending them to this page
      peer.live = true;
      this.send({ op: 'p2p', on: true });
      this.patch({ direct: true });
    }
    this.onFrame(frame);
  }

  /** The direct connection broke: the server path resumes (from its next keyframe). */
  private peerLost(peer: DirectPeer) {
    if (this.peer !== peer) return;
    const wasLive = peer.live;
    this.closePeer();
    if (wasLive) { this.waitKey = true; this.send({ op: 'p2p', on: false }); }
  }

  private closePeer() {
    const peer = this.peer;
    if (!peer) return;
    this.peer = null;
    peer.channel.onclose = null; peer.pc.onconnectionstatechange = null;
    try { peer.pc.close(); } catch { /* already closed */ }
    if (this.state.direct) this.patch({ direct: false });
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
    this.decoder = null; this.decoderCodec = null; this.waitKey = true; this.pending.clear();
  }

  private ensureDecoder(codec: string) {
    if (this.decoder && this.decoderCodec === codec && this.decoder.state === 'configured') return true;
    this.resetDecoder();
    const decoder = new VideoDecoder({
      output: (frame) => {
        this.draw(frame, frame.displayWidth, frame.displayHeight);
        const sent = this.pending.get(frame.timestamp);
        frame.close();
        if (!sent) return;
        this.pending.delete(frame.timestamp);
        this.decodeTotal += performance.now() - sent.at; this.decodeCount++;
        this.shown(sent.seq);
      },
      error: (e) => { this.patch({ error: `영상 디코딩 오류: ${e.message}` }); this.resetDecoder(); },
    });
    try { decoder.configure({ codec, optimizeForLatency: true }); }
    catch (e) { this.patch({ error: `이 브라우저가 ${codec}를 재생할 수 없습니다 — JPEG로 전환합니다` }); this.setOptions({ ...this.opts, mode: 'jpeg', fps: 5 }); return false; }
    this.decoder = decoder; this.decoderCodec = codec;
    return true;
  }

  private onFrame(buf: Uint8Array) {
    if (buf.length < 3) return;
    const kind = buf[0]; const key = (buf[1] & 1) === 1;
    // numbered frames (0.15+ runners): `[kind][flags][seq u32 BE][data]`
    const numbered = (buf[1] & 2) === 2 && buf.length >= 6;
    const seq = numbered ? ((buf[2] << 24) >>> 0) + (buf[3] << 16) + (buf[4] << 8) + buf[5] : 0;
    const data = buf.subarray(numbered ? 6 : 2);
    // both paths may bring the same frame (while switching): each number once
    if (seq) { if (seq <= this.lastSeq) return; this.lastSeq = seq; }
    this.tick(buf.length);
    if (kind === KIND_JPEG) {
      if (this.jpegBusy) return;   // drop while the previous picture is still decoding
      this.jpegBusy = true;
      createImageBitmap(new Blob([data as BlobPart], { type: 'image/jpeg' }))
        .then((bmp) => { this.draw(bmp, bmp.width, bmp.height); bmp.close(); this.shown(seq); })
        .catch(() => {})
        .finally(() => { this.jpegBusy = false; });
      return;
    }
    if (!webCodecsAvailable()) return;
    if (this.waitKey && !key) return;
    const codec = kind === KIND_VP9 ? VP9_CODEC : kind === KIND_VP8 ? 'vp8' : kind === KIND_H264 ? (key ? avcCodecFromAnnexB(data) ?? this.decoderCodec : this.decoderCodec) : null;
    if (!codec || !this.ensureDecoder(codec) || !this.decoder) return;
    // keep latency low: a decoder that falls behind skips to the next keyframe (a queue is latency)
    if (this.decoder.decodeQueueSize > 2 && !key) { this.waitKey = true; this.pending.clear(); return; }
    this.waitKey = false;
    this.ts += 33_333;
    if (seq) {
      this.pending.set(this.ts, { seq, at: performance.now() });
      if (this.pending.size > 120) this.pending.delete(this.pending.keys().next().value as number);
    }
    try { this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data })); }
    catch { this.resetDecoder(); }
  }

  private send(obj: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  /** New window / quality: the gateway moves this viewer to the matching stream. */
  setOptions(opts: ScreenOptions) {
    // the codecs this page decodes stay with the session (found when it connected)
    const next = { ...opts, codecs: this.opts.codecs };
    this.opts = next.mode === 'video' && !webCodecsAvailable() ? { ...next, mode: 'jpeg', fps: 5 } : next;
    this.closePeer();   // the next `started` tries again for the new stream
    this.resetDecoder();
    this.send({ op: 'config', ...this.opts });
  }

  setControl(on: boolean) { this.send({ op: 'control', on }); }

  input(ev: InputEvent) {
    if (!this.state.control) return;
    const channel = this.directInput && this.peer?.live ? this.peer.channel : null;
    if (channel?.readyState === 'open') channel.send(JSON.stringify({ input: ev }));
    else this.send({ op: 'input', ev });
  }

  close() {
    this.closed = true;
    if (this.state.control) this.send({ op: 'control', on: false });
    this.ws?.close(1000);
    this.closePeer();
    this.resetDecoder();
  }
}
