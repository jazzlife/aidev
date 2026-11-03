//! The PC's sound beside its screen (2026-11-03): what this PC plays — its output, not the microphone — captured while
//! a screen stream wants it (`screen.audio {streamId, on}` from the gateway, screen.rs), encoded as Opus (opus-rs, pure
//! Rust: 48 kHz stereo, 20 ms packets, ~128 kbps) and sent on those streams like their pictures (the gateway path and
//! the direct channel, rtc.rs): frames `[5][flags][seq u32 BE][packet]` — not "numbered" (flags bit 1 stays clear: the
//! seq is the sound's own, pages before sound ignore kind 5). flags bit 0: the first packet of a new encoder — the page
//! resets its decoder and plays from now. Silence is not sent: after SILENT_TAIL quiet packets the sound pauses until the
//! PC plays something again. One capture for every stream; it stops with the last one.
//!   macOS 13+: ScreenCaptureKit (the screen recording permission covers it); Windows: WASAPI loopback of the default
//!   output device (follows it when it changes); Linux: `parec` (PulseAudio, PipeWire's pulse server) or `pw-record`
//!   on the default output's monitor. Errors go to the streams' viewers as `screen.audio {streamId, error}`.

use opus_rs::{Application, OpusEncoder};
use serde_json::json;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// a frame of sound (screen.rs frame kinds: 1 H.264, 3 JPEG, 4 VP9)
pub const KIND_OPUS: u8 = 5;
const RATE: u32 = 48_000;
/// samples per channel in one packet (20 ms)
const FRAME: usize = 960;
const KBPS: i32 = 128;
/// quiet packets still sent before the sound pauses (0.5 s: a short pause between sounds stays one stream)
const SILENT_TAIL: u32 = 25;
/// below this (about -80 dBFS) a packet counts as silence
const QUIET: f32 = 1e-4;

#[derive(Default)]
struct Hub {
    streams: BTreeSet<u32>,
    /// the capture thread's stop flag, while one runs
    running: Option<Arc<AtomicBool>>,
}

fn hub() -> &'static Mutex<Hub> {
    static HUB: OnceLock<Mutex<Hub>> = OnceLock::new();
    HUB.get_or_init(Default::default)
}

/// This PC can send its sound (caps feature "audio").
pub fn available() -> bool {
    #[cfg(target_os = "macos")]
    { crate::mac_screen::available() }
    #[cfg(windows)]
    { true }
    #[cfg(target_os = "linux")]
    { linux::recorder().is_some() }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    { false }
}

/// `stream` takes the sound (on) or no longer (off, also when it ends); the capture runs while any stream does.
pub fn set(stream: u32, on: bool) {
    let mut g = hub().lock().unwrap();
    if on && available() {
        g.streams.insert(stream);
    } else {
        g.streams.remove(&stream);
    }
    if g.streams.is_empty() {
        if let Some(stop) = g.running.take() {
            stop.store(true, Ordering::Relaxed);
        }
    } else if g.running.is_none() {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        if std::thread::Builder::new().name("aidev-audio".into()).spawn(move || run(&flag)).is_ok() {
            g.running = Some(stop);
        }
    }
}

fn streams() -> Vec<u32> {
    hub().lock().unwrap().streams.iter().copied().collect()
}

/// The packet number, across captures: a page dedups the two paths by it within a stream.
fn next_seq() -> u32 {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
}

/// PCM in (interleaved stereo f32 at 48 kHz), Opus packets out: one per 20 ms, none while it stays silent.
struct Packer {
    pcm: Vec<f32>,
    enc: Option<OpusEncoder>,
    quiet: u32,
    out: Vec<u8>,
}

impl Packer {
    fn new() -> Self {
        Packer { pcm: Vec::with_capacity(FRAME * 8), enc: None, quiet: SILENT_TAIL, out: vec![0; 4000] }
    }

    /// `emit(first, packet)` for every whole packet in what has come so far.
    fn push(&mut self, samples: &[f32], mut emit: impl FnMut(bool, &[u8])) {
        self.pcm.extend_from_slice(samples);
        let mut at = 0;
        while self.pcm.len() - at >= FRAME * 2 {
            let frame = &self.pcm[at..at + FRAME * 2];
            at += FRAME * 2;
            if frame.iter().any(|s| s.abs() > QUIET) {
                self.quiet = 0;
            } else if self.quiet >= SILENT_TAIL {
                self.enc = None;   // paused: the next sound starts a new encoder (and the page a new decoder)
                continue;
            } else {
                self.quiet += 1;
            }
            let first = self.enc.is_none();
            if first {
                // CELT only (restricted low delay): music and system sounds, the least added delay
                let Ok(mut e) = OpusEncoder::new(RATE as i32, 2, Application::RestrictedLowDelay) else { continue };
                e.bitrate_bps = KBPS * 1000;
                e.complexity = 5;
                self.enc = Some(e);
            }
            match self.enc.as_mut().map(|e| e.encode(frame, FRAME, &mut self.out)) {
                Some(Ok(n)) if n > 0 => emit(first, &self.out[..n]),
                _ => self.enc = None,
            }
        }
        self.pcm.drain(..at);
    }
}

/// To every stream that takes the sound now.
fn send(first: bool, packet: &[u8]) {
    let mut frame = Vec::with_capacity(packet.len() + 6);
    frame.push(KIND_OPUS);
    frame.push(u8::from(first));
    frame.extend_from_slice(&next_seq().to_be_bytes());
    frame.extend_from_slice(packet);
    for id in streams() {
        crate::screen::send_frame(id, &frame);
    }
}

fn report(error: Option<&str>) {
    for id in streams() {
        crate::screen::note("screen.audio", json!({ "streamId": id, "error": error }));
    }
}

/// The capture thread: opens the PC's output, and opens it again after a failure (a device that went away) until stopped.
fn run(stop: &AtomicBool) {
    let mut reported = false;
    while !stop.load(Ordering::Relaxed) {
        match Source::open() {
            Ok(mut src) => {
                if std::mem::take(&mut reported) {
                    report(None);
                }
                let mut packer = Packer::new();
                let mut buf = Vec::with_capacity(FRAME * 8);
                while !stop.load(Ordering::Relaxed) {
                    buf.clear();
                    if let Err(e) = src.read(&mut buf) {
                        eprintln!("[aidev-runner] 소리 캡처가 끊겼습니다: {e}");
                        break;
                    }
                    packer.push(&buf, send);
                }
            }
            Err(e) => {
                if !std::mem::replace(&mut reported, true) {
                    eprintln!("[aidev-runner] 소리를 캡처할 수 없습니다: {e}");
                    report(Some(&e));
                }
            }
        }
        // again in a moment (a stop meanwhile ends it)
        for _ in 0..10 {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(target_os = "macos")]
use mac::Source;
#[cfg(windows)]
use win::Source;
#[cfg(target_os = "linux")]
use linux::Source;

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
struct Source;
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
impl Source {
    fn open() -> Result<Self, String> {
        Err("이 OS에서는 소리를 보낼 수 없습니다".into())
    }
    fn read(&mut self, _out: &mut Vec<f32>) -> Result<(), String> {
        Err("unsupported".into())
    }
}

/// macOS: a ScreenCaptureKit stream of the main display for its sound only (the picture is 2×2, once a second).
#[cfg(target_os = "macos")]
mod mac {
    use screencapturekit::cm::AudioBuffer;
    use screencapturekit::prelude::*;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    #[derive(Default)]
    struct Pcm {
        samples: Mutex<Vec<f32>>,
        ready: Condvar,
    }

    struct Sink(Arc<Pcm>);

    impl SCStreamOutputTrait for Sink {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
            if !matches!(kind, SCStreamOutputType::Audio) {
                return;
            }
            let Ok(list) = sample.audio_buffer_list() else { return };
            let f32s = |b: &AudioBuffer| b.data().chunks_exact(4).map(|c| f32::from_ne_bytes([c[0], c[1], c[2], c[3]])).collect::<Vec<_>>();
            let mut out = self.0.samples.lock().unwrap();
            match (list.get(0), list.get(1)) {
                // one buffer per channel (what ScreenCaptureKit hands over)
                (Some(l), Some(r)) => {
                    for (a, b) in f32s(l).into_iter().zip(f32s(r)) {
                        out.extend_from_slice(&[a, b]);
                    }
                }
                (Some(b), None) if b.number_channels >= 2 => out.extend(f32s(b)),
                (Some(b), None) => {
                    for s in f32s(b) {
                        out.extend_from_slice(&[s, s]);
                    }
                }
                _ => return,
            }
            // a reader that stopped reading must not grow this without end
            let len = out.len();
            if len > super::RATE as usize * 2 {
                out.drain(..len - super::RATE as usize);
            }
            self.0.ready.notify_one();
        }
    }

    pub struct Source {
        stream: SCStream,
        pcm: Arc<Pcm>,
    }

    impl Source {
        pub fn open() -> Result<Self, String> {
            let content = SCShareableContent::get().map_err(|e| format!("화면 목록을 읽지 못했습니다: {e:?}"))?;
            let display = content.displays().into_iter().next().ok_or("화면이 없습니다")?;
            let filter = SCContentFilter::create().with_display(&display).with_excluding_windows(&[]).build().map_err(|e| format!("{e:?}"))?;
            let config = SCStreamConfiguration::new()
                .with_width(2)
                .with_height(2)
                .with_minimum_frame_interval(&CMTime::new(1, 1))
                .with_captures_audio(true)
                .with_sample_rate(super::RATE as i32)
                .with_channel_count(2);
            let pcm = Arc::new(Pcm::default());
            let mut stream = SCStream::new(&filter, &config).map_err(|e| format!("{e:?}"))?;
            // a picture output too: without one ScreenCaptureKit complains about every (tiny) frame it drops
            stream.add_output_handler(Sink(pcm.clone()), SCStreamOutputType::Screen).map_err(|e| format!("{e:?}"))?;
            stream.add_output_handler(Sink(pcm.clone()), SCStreamOutputType::Audio).map_err(|e| format!("{e:?}"))?;
            stream.start_capture().map_err(|e| format!("소리 캡처를 시작하지 못했습니다: {e:?}"))?;
            Ok(Source { stream, pcm })
        }

        /// What arrived since the last call, waiting up to 100 ms for some (none while nothing plays is normal).
        pub fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
            let mut g = self.pcm.samples.lock().unwrap();
            if g.is_empty() {
                g = self.pcm.ready.wait_timeout(g, Duration::from_millis(100)).unwrap().0;
            }
            out.append(&mut g);
            Ok(())
        }
    }

    impl Drop for Source {
        fn drop(&mut self) {
            let _ = self.stream.stop_capture();
        }
    }
}

/// Windows: WASAPI loopback of the default output device, in shared mode, converted to 48 kHz stereo f32 by Windows.
#[cfg(windows)]
mod win {
    use std::time::{Duration, Instant};
    use wasapi::{initialize_mta, AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    pub struct Source {
        _client: AudioClient,
        capture: AudioCaptureClient,
        enumerator: DeviceEnumerator,
        device: String,
        checked: Instant,
        buf: Vec<u8>,
    }

    impl Source {
        pub fn open() -> Result<Self, String> {
            let _ = initialize_mta();
            let e = |what: &str| { let what = what.to_string(); move |err: wasapi::WasapiError| format!("{what}: {err}") };
            let enumerator = DeviceEnumerator::new().map_err(e("오디오 장치 목록"))?;
            let dev = enumerator.get_default_device(&Direction::Render).map_err(e("기본 출력 장치가 없습니다"))?;
            let device = dev.get_id().unwrap_or_default();
            let mut client = dev.get_iaudioclient().map_err(e("오디오 장치"))?;
            let format = WaveFormat::new(32, 32, &SampleType::Float, super::RATE as usize, 2, None);
            // a render device opened for capture = loopback; a 200 ms buffer, read every 10 ms
            client.initialize_client(&format, &Direction::Capture, &StreamMode::PollingShared { autoconvert: true, buffer_duration_hns: 2_000_000 }).map_err(e("소리 캡처(루프백)"))?;
            let capture = client.get_audiocaptureclient().map_err(e("소리 캡처"))?;
            client.start_stream().map_err(e("소리 캡처 시작"))?;
            Ok(Source { _client: client, capture, enumerator, device, checked: Instant::now(), buf: Vec::new() })
        }

        /// What the device has (nothing while nothing plays); an error when the default output changed (opened again).
        pub fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
            std::thread::sleep(Duration::from_millis(10));
            while let Some(n) = self.capture.get_next_packet_size().map_err(|e| e.to_string())?.filter(|n| *n > 0) {
                self.buf.resize(n as usize * 8, 0);
                let (frames, info) = self.capture.read_from_device(&mut self.buf).map_err(|e| e.to_string())?;
                let bytes = &self.buf[..frames as usize * 8];
                if info.flags.silent {
                    out.resize(out.len() + frames as usize * 2, 0.0);
                } else {
                    out.extend(bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])));
                }
            }
            // headphones plugged in, another output picked: the sound follows the default device
            if self.checked.elapsed() >= Duration::from_secs(2) {
                self.checked = Instant::now();
                let now = self.enumerator.get_default_device(&Direction::Render).and_then(|d| d.get_id()).unwrap_or_default();
                if now != self.device {
                    return Err("기본 출력 장치가 바뀌었습니다".into());
                }
            }
            Ok(())
        }
    }
}

/// Linux: the default output's monitor through `parec` (PulseAudio, PipeWire's pulse server) or `pw-record`.
#[cfg(target_os = "linux")]
mod linux {
    use std::io::Read;
    use std::process::{Child, Command, Stdio};

    /// The recorder this PC has and its arguments: raw 48 kHz stereo f32 on stdout.
    pub fn recorder() -> Option<(std::path::PathBuf, &'static [&'static str])> {
        const PAREC: &[&str] = &["--device=@DEFAULT_MONITOR@", "--format=float32le", "--rate=48000", "--channels=2", "--latency-msec=20", "--raw"];
        const PW_RECORD: &[&str] = &["-P", "{ stream.capture.sink=true }", "--rate", "48000", "--channels", "2", "--format", "f32", "-"];
        crate::dap_adapters::which("parec").map(|p| (p, PAREC)).or_else(|| crate::dap_adapters::which("pw-record").map(|p| (p, PW_RECORD)))
    }

    pub struct Source {
        child: Child,
        buf: Vec<u8>,
    }

    impl Source {
        pub fn open() -> Result<Self, String> {
            let (bin, args) = recorder().ok_or("parec(pulseaudio-utils) 또는 pw-record(pipewire)가 없습니다")?;
            let child = Command::new(&bin).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("{}: {e}", bin.display()))?;
            Ok(Source { child, buf: vec![0; super::FRAME * 8] })
        }

        /// The next piece of the stream (the monitor sends silence too, so this never waits long).
        pub fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
            let stdout = self.child.stdout.as_mut().ok_or("no output")?;
            let n = stdout.read(&mut self.buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("녹음 프로그램이 끝났습니다".into());
            }
            // a sample cut between two reads waits for the next one
            let whole = n / 4 * 4;
            out.extend(self.buf[..whole].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])));
            if whole < n {
                let mut rest = [0u8; 4];
                rest[..n - whole].copy_from_slice(&self.buf[whole..n]);
                stdout.read_exact(&mut rest[n - whole..]).map_err(|e| e.to_string())?;
                out.push(f32::from_le_bytes(rest));
            }
            Ok(())
        }
    }

    impl Drop for Source {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packets_every_20ms_and_none_in_silence() {
        let tone: Vec<f32> = (0..FRAME * 10).flat_map(|i| { let s = (i as f32 * 440.0 * std::f32::consts::TAU / RATE as f32).sin() * 0.3; [s, s] }).collect();
        let mut p = Packer::new();
        let mut got = Vec::new();
        // in odd pieces, as captures deliver them
        for piece in tone.chunks(777) {
            p.push(piece, |first, pkt| got.push((first, pkt.len())));
        }
        assert_eq!(got.len(), 10);
        assert!(got[0].0 && got[1..].iter().all(|(f, _)| !f), "only the first packet starts an encoder: {got:?}");
        // ~128 kbps → ~320 bytes per packet (a new encoder's first one is larger)
        assert!(got[1..].iter().all(|(_, n)| (200..=480).contains(n)) && got[0].1 < 1000, "{got:?}");

        // silence: the tail goes out, then nothing; the next sound starts a new encoder
        got.clear();
        p.push(&vec![0.0; FRAME * 2 * (SILENT_TAIL as usize + 20)], |first, pkt| got.push((first, pkt.len())));
        assert_eq!(got.len(), SILENT_TAIL as usize);
        got.clear();
        p.push(&tone[..FRAME * 2], |first, pkt| got.push((first, pkt.len())));
        assert_eq!(got.len(), 1);
        assert!(got[0].0, "after a pause the page resets its decoder");
    }

    /// This PC's real output: `cargo test -- --ignored captures_what_the_pc_plays` while something plays.
    #[test]
    #[ignore]
    fn captures_what_the_pc_plays() {
        let mut src = Source::open().expect("open");
        let (mut p, mut loud, mut samples) = (Packer::new(), 0, 0);
        let until = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < until {
            let mut buf = Vec::new();
            src.read(&mut buf).expect("read");
            samples += buf.len();
            p.push(&buf, |_, _| loud += 1);
        }
        eprintln!("{samples} samples, {loud} packets");
        assert!(loud > 20, "nothing heard");
    }

    #[test]
    fn silence_from_the_start_sends_nothing() {
        let mut p = Packer::new();
        let mut n = 0;
        p.push(&vec![0.0; FRAME * 2 * 50], |_, _| n += 1);
        assert_eq!(n, 0);
    }
}
