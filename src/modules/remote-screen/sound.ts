/**
 * The PC's sound beside its screen (2026-11-03), non-visual: Opus packets from the runner (audio.rs, frames
 * `[5][flags][seq u32 BE][packet]`, 48 kHz stereo, 20 ms) decoded with WebCodecs `AudioDecoder` and played through Web
 * Audio a little ahead of now (`playout`, a small jitter buffer that grows when packets come late). A packet later than
 * that, or a queue past MAX_AHEAD_S, starts the playout over from now — the sound stays with the picture instead of
 * drifting behind it. flags bit 0 = the first packet of a new encoder on the PC (after a pause): a new decoder here.
 * Browsers start sound only after the person touched the page: until then `onBlocked(true)`, and the next click or key
 * anywhere (or `resume()` from a button) lets it play.
 */
const OPUS_CONFIG: AudioDecoderConfig = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 };
/** How far ahead of now the first packet plays, and how far that may grow on a jittery path (seconds). */
const PLAYOUT_MIN_S = 0.08;
const PLAYOUT_MAX_S = 0.25;
/** More than this queued (a burst after a stall, clock drift): start over from now. */
const MAX_AHEAD_S = 0.45;
/** A packet's length in microseconds (the chunk timestamps; the decoder only needs them to rise). */
const PACKET_US = 20_000;

/** This browser has WebCodecs audio and Web Audio at all (checked without waiting). */
export const soundSupported = () => typeof window !== 'undefined' && 'AudioDecoder' in window && 'EncodedAudioChunk' in window && 'AudioContext' in window;

let opusPlayable: Promise<boolean> | null = null;
/** This browser decodes Opus (checked once per page). */
export function soundPlayable(): Promise<boolean> {
  opusPlayable ??= soundSupported() ? AudioDecoder.isConfigSupported(OPUS_CONFIG).then((r) => Boolean(r.supported), () => false) : Promise.resolve(false);
  return opusPlayable;
}

export class RemoteSound {
  private ctx = new AudioContext({ latencyHint: 'interactive' });
  private gain = this.ctx.createGain();
  private decoder: AudioDecoder | null = null;
  /** when (context time) the next decoded piece plays */
  private at = 0;
  private playout = PLAYOUT_MIN_S;
  /** the next piece follows a new decoder: being late there is the PC's pause, not the network */
  private fresh = true;
  private ts = 0;
  private lastSeq = 0;
  private unlock = () => { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined); };

  constructor(private onBlocked: (blocked: boolean) => void) {
    this.gain.connect(this.ctx.destination);
    this.ctx.onstatechange = () => this.onBlocked(this.ctx.state === 'suspended');
    document.addEventListener('pointerdown', this.unlock, true);
    document.addEventListener('keydown', this.unlock, true);
    this.onBlocked(this.ctx.state === 'suspended');
  }

  setVolume(volume: number, muted: boolean) { this.gain.gain.value = muted ? 0 : Math.min(Math.max(volume, 0), 1); }

  /** From a click or tap (a user gesture): the browser lets the sound start. */
  resume() { this.unlock(); }

  /** A new stream: its packets count from wherever the runner is. */
  reset() { this.lastSeq = 0; }

  /** One sound frame, from either path. */
  frame(buf: Uint8Array) {
    if (buf.length < 7) return;
    const first = (buf[1] & 1) === 1;
    const seq = ((buf[2] << 24) >>> 0) + (buf[3] << 16) + (buf[4] << 8) + buf[5];
    // both paths may bring the same packet while switching: each number once
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    if (first || !this.decoder) this.openDecoder();
    // held until a touch: decoding now would only pile up sound to play late
    if (this.ctx.state !== 'running' || !this.decoder) return;
    this.ts += PACKET_US;
    try { this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: buf.subarray(6) })); }
    catch { this.decoder = null; }
  }

  private openDecoder() {
    try { this.decoder?.close(); } catch { /* already closed */ }
    this.fresh = true;
    try {
      const decoder: AudioDecoder = new AudioDecoder({ output: (data) => this.play(data), error: () => { if (this.decoder === decoder) this.decoder = null; } });
      decoder.configure(OPUS_CONFIG);
      this.decoder = decoder;
    } catch { this.decoder = null; }
  }

  private play(data: AudioData) {
    try {
      const buffer = this.ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
      for (let c = 0; c < data.numberOfChannels; c++) data.copyTo(buffer.getChannelData(c), { planeIndex: c, format: 'f32-planar' });
      const now = this.ctx.currentTime;
      if (this.at < now) {
        // ran dry: a late packet on this path makes the buffer a little deeper from now on
        if (!this.fresh && this.at > 0) this.playout = Math.min(PLAYOUT_MAX_S, this.playout + 0.02);
        this.at = now + this.playout;
      } else if (this.at > now + MAX_AHEAD_S) this.at = now + this.playout;
      this.fresh = false;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);
      source.start(this.at);
      this.at += buffer.duration;
    } catch { /* a piece that cannot be played is skipped */ }
    finally { data.close(); }
  }

  close() {
    document.removeEventListener('pointerdown', this.unlock, true);
    document.removeEventListener('keydown', this.unlock, true);
    try { this.decoder?.close(); } catch { /* already closed */ }
    this.decoder = null;
    this.ctx.onstatechange = null;
    void this.ctx.close().catch(() => undefined);
  }
}
