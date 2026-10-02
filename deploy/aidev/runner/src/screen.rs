//! `screen.*` (IMPLEMENTATION-PLAN §3.12, F-07c): one program window of this PC — listed, captured, streamed
//! as live H.264 (or JPEG on change) — view and control only after the owner ran
//! `aidev-runner consent screen on` (control: `consent control on`, see input.rs). Nothing to install:
//! window capture (appwin.rs) and the H.264 encoder (encoder.rs, OpenH264) are inside the runner.
//!   screen.list → {windows:[{id, pid, app, title, x, y, width, height, focused}]}
//!   screen.list → {windows}   (0.13.3: the whole screens come last, app "전체 화면", ids from appwin::DISPLAY_BASE — usable
//!                               wherever a window id is: shot, start, input; the focused window stays the default)
//!   screen.shot {window? | query?, maxWidth?, quality?} → {b64 (JPEG), width, height, window}
//!   screen.start {streamId, window, mode: "video"|"jpeg", fps?, maxWidth?, bitrate?, acks?} → {streamId, window}
//!   screen.key {streamId}  (next frame is a keyframe)      screen.stop {streamId}
//!   notifications screen.format {streamId, codec, width, height}, screen.error {streamId, error},
//!   screen.stats {streamId, fps, captureMs, scaleMs, encodeMs, loopMs, baseMs, skipped, kbps, bitrate} (every second)
//!   from the gateway: notification screen.ack {streamId, seq} — the newest frame a viewer has shown
//! Frames: binary `[streamId u32 BE][kind u8][flags u8][seq u32 BE, when flags bit 1][data]`, kind 1 = H.264
//! access unit (Annex B, SPS/PPS before every IDR), 3 = JPEG; flags bit 0 = keyframe, bit 1 = numbered. A
//! frame is encoded only when the window's pixels changed (or a keyframe was asked for), at most `fps` per
//! second; a resized window restarts the encoder.
//! Latency (F-07d, 2026-10-02, after RustDesk's VideoQoS): with `acks` the frames are numbered and the stream
//! keeps track of those not yet shown. When the oldest has been on its way longer than the quickest recent
//! loop (sent → shown → ack) plus 150 ms, it makes no new frame — the next capture is newer anyway, so the
//! viewer never watches a queue — and the bit rate steps down (it climbs back after 6 s without that).
//! `AIDEV_SCREEN_CMD` (tests) replaces capture with a shell command writing an image to `{out}`.

use crate::appwin::{self, Frame};
use crate::config::Config;
use crate::encoder::{self, H264};
use crate::exec::{frame, Out};
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

type RpcResult = Result<Value, (i64, String)>;
const MAX_STREAMS: usize = 4;
const DEFAULT_WIDTH: u32 = 1440;
const KIND_H264: u8 = 1;
const KIND_JPEG: u8 = 3;
pub(crate) const NO_CONSENT: &str = "이 PC에서 화면 보기를 꺼 두었습니다 — PC에서 `aidev-runner consent screen on` 후 러너를 다시 시작하세요";

/// The newest frame a viewer has shown, and when the ack came.
type Acked = Arc<Mutex<Option<(u32, Instant)>>>;

struct Ctl {
    stop: Arc<AtomicBool>,
    key: Arc<AtomicBool>,
    acked: Acked,
}

/// `screen.ack` from the gateway (a notification).
pub fn ack(params: &Value) {
    let (Some(id), Some(seq)) = (params.get("streamId").and_then(Value::as_u64), params.get("seq").and_then(Value::as_u64)) else { return };
    if let Some(c) = hub().lock().unwrap().streams.get(&(id as u32)) {
        let mut a = c.acked.lock().unwrap();
        if a.is_none_or(|(s, _)| seq as u32 > s) {
            *a = Some((seq as u32, Instant::now()));
        }
    }
}

#[derive(Default)]
struct Inner {
    out: Option<Out>,
    streams: HashMap<u32, Ctl>,
}

fn hub() -> &'static Mutex<Inner> {
    static HUB: OnceLock<Mutex<Inner>> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(Inner::default()))
}

pub fn attach(out: Out) {
    hub().lock().unwrap().out = Some(out);
}

/// Connection lost: streams stop (nobody is watching any more).
pub fn detach() {
    let mut g = hub().lock().unwrap();
    g.out = None;
    for (_, c) in g.streams.drain() {
        c.stop.store(true, Ordering::Relaxed);
    }
}

fn out() -> Option<Out> {
    hub().lock().unwrap().out.clone()
}

fn note(method: &str, params: Value) {
    if let Some(out) = out() {
        let _ = out.blocking_send(Message::Text(json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()));
    }
}

fn tagged(kind: u8, key: bool, seq: Option<u32>, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(data.len() + 6);
    v.push(kind);
    v.push(u8::from(key) | if seq.is_some() { 2 } else { 0 });
    if let Some(seq) = seq {
        v.extend_from_slice(&seq.to_be_bytes());
    }
    v.extend_from_slice(data);
    v
}

const LOST_AFTER: Duration = Duration::from_secs(3);
const QUEUE_BUDGET: Duration = Duration::from_millis(150);
const MIN_KBPS: u32 = 500;

/// Frames on their way to the viewers, and what the loop to them takes.
struct Flow {
    on: bool,
    seq: u32,
    sent: std::collections::VecDeque<(u32, Instant)>,
    /// the quickest loop of the last 10 s window (sent → shown → ack): the path without any queue
    base: Option<Duration>,
    window_min: Option<Duration>,
    window_at: Instant,
    loops: Vec<Duration>,
}

impl Flow {
    fn new(on: bool) -> Self {
        Flow { on, seq: 0, sent: Default::default(), base: None, window_min: None, window_at: Instant::now(), loops: Vec::new() }
    }

    fn next_seq(&mut self, now: Instant) -> Option<u32> {
        if !self.on {
            return None;
        }
        self.seq = self.seq.wrapping_add(1);
        self.sent.push_back((self.seq, now));
        Some(self.seq)
    }

    fn take_acks(&mut self, acked: &Acked) {
        let Some((seq, at)) = *acked.lock().unwrap() else { return };
        while let Some(&(s, t)) = self.sent.front() {
            if s > seq {
                break;
            }
            self.sent.pop_front();
            if s == seq {
                let d = at.saturating_duration_since(t);
                self.loops.push(d);
                self.window_min = Some(self.window_min.map_or(d, |m| m.min(d)));
                self.base = Some(self.base.map_or(d, |b| b.min(d)));
            }
        }
        // the path changes (another network): the floor follows the last window's quickest loop
        if self.window_at.elapsed() > Duration::from_secs(10) {
            if let Some(m) = self.window_min.take() {
                self.base = Some(m);
            }
            self.window_at = Instant::now();
        }
    }

    /// Frames are queueing on the way: make none now.
    fn congested(&mut self, now: Instant) -> bool {
        let Some(&(_, t)) = self.sent.front() else { return false };
        let age = now.saturating_duration_since(t);
        if age > LOST_AFTER {
            self.sent.clear();   // nobody acks (the viewer left, an older gateway): start over
            return false;
        }
        age > self.base.unwrap_or(Duration::from_millis(250)) + QUEUE_BUDGET
    }

    fn median_loop(&mut self) -> Option<u64> {
        if self.loops.is_empty() {
            return None;
        }
        self.loops.sort();
        let m = self.loops[self.loops.len() / 2].as_millis() as u64;
        self.loops.clear();
        Some(m)
    }
}

/// One second of numbers for screen.stats.
#[derive(Default)]
struct Meter {
    frames: u32,
    bytes: usize,
    skipped: u32,
    capture: Duration,
    scale: Duration,
    encode: Duration,
}

fn avg_ms(total: Duration, n: u32) -> f64 {
    if n == 0 { 0.0 } else { (total.as_secs_f64() * 1000.0 / n as f64 * 10.0).round() / 10.0 }
}

/// What every stream loop shares (F-18): acks and pacing, the bit rate that follows them, the numbers.
pub(crate) struct Pace {
    id: u32,
    flow: Flow,
    meter: Meter,
    meter_at: Instant,
    target: u32,
    pub kbps: u32,
    adapt_at: Instant,
    calm_since: Instant,
    skipped_window: u32,
    acked: Acked,
}

impl Pace {
    fn new(id: u32, acks: bool, kbps: u32, acked: Acked) -> Self {
        let now = Instant::now();
        Pace { id, flow: Flow::new(acks), meter: Meter::default(), meter_at: now, target: kbps, kbps, adapt_at: now, calm_since: now, skipped_window: 0, acked }
    }

    /// Acks in, the second's numbers out; Some(kbps) when the bit rate should change.
    fn tick(&mut self, now: Instant) -> Option<u32> {
        self.flow.take_acks(&self.acked);
        if now.duration_since(self.meter_at) >= Duration::from_secs(1) {
            let secs = now.duration_since(self.meter_at).as_secs_f64();
            let m = std::mem::take(&mut self.meter);
            note("screen.stats", json!({
                "streamId": self.id, "fps": (m.frames as f64 / secs * 10.0).round() / 10.0,
                "captureMs": avg_ms(m.capture, m.frames), "scaleMs": avg_ms(m.scale, m.frames), "encodeMs": avg_ms(m.encode, m.frames),
                "loopMs": self.flow.median_loop(), "baseMs": self.flow.base.map(|b| b.as_millis() as u64), "skipped": m.skipped,
                "kbps": (m.bytes as f64 * 8.0 / 1000.0 / secs).round(), "bitrate": self.kbps,
            }));
            self.meter_at = now;
        }
        if now.duration_since(self.adapt_at) < Duration::from_secs(2) {
            return None;
        }
        // down when frames queue, back up after 6 s without (bit rate before frame rate, as RustDesk's VideoQoS)
        let next = if self.skipped_window > 0 {
            self.calm_since = now;
            (self.kbps * 3 / 4).max(MIN_KBPS)
        } else if now.duration_since(self.calm_since) >= Duration::from_secs(6) {
            (self.kbps * 115 / 100).min(self.target)
        } else {
            self.kbps
        };
        self.skipped_window = 0;
        self.adapt_at = now;
        (next != self.kbps).then(|| {
            self.kbps = next;
            next
        })
    }

    /// Frames are queueing on the way to the viewers: make none now.
    fn hold(&mut self, now: Instant) -> bool {
        if self.flow.on && self.flow.congested(now) {
            self.meter.skipped += 1;
            self.skipped_window += 1;
            return true;
        }
        false
    }

    /// One frame made: counted, numbered, tagged.
    fn frame(&mut self, kind: u8, key: bool, data: &[u8], capture: Duration, scale: Duration, encode: Duration) -> Vec<u8> {
        self.meter.frames += 1;
        self.meter.bytes += data.len();
        self.meter.capture += capture;
        self.meter.scale += scale;
        self.meter.encode += encode;
        tagged(kind, key, self.flow.next_seq(Instant::now()), data)
    }
}

/// Into the connection; false when it is gone.
fn send_frame(id: u32, payload: &[u8]) -> bool {
    out().is_some_and(|out| out.blocking_send(Message::Binary(frame(id, payload))).is_ok())
}

fn temp_file() -> std::path::PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!("aidev-screen-{}-{}.img", std::process::id(), N.fetch_add(1, Ordering::Relaxed)))
}

/// Test stand-in for a window: an image written by `AIDEV_SCREEN_CMD`.
fn fake_capture(cmd: &str) -> Result<Frame, String> {
    let out = temp_file();
    let status = Command::new("sh").args(["-c", &cmd.replace("{out}", &out.display().to_string())]).output().map_err(|e| e.to_string())?;
    let data = std::fs::read(&out);
    let _ = std::fs::remove_file(&out);
    if !status.status.success() {
        return Err(format!("캡처 실패 ({}): {}", status.status, String::from_utf8_lossy(&status.stderr).trim()));
    }
    let img = image::load_from_memory(&data.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?.to_rgba8();
    Ok(Frame { width: img.width(), height: img.height(), rgba: img.into_raw() })
}

enum Source {
    Fake(String),
    Window(Box<appwin::Capturer>),
}

impl Source {
    fn open(window: u32) -> Result<Self, String> {
        if let Ok(cmd) = std::env::var("AIDEV_SCREEN_CMD") {
            return Ok(Source::Fake(cmd));
        }
        appwin::Capturer::open(window).map(|c| Source::Window(Box::new(c)))
    }
    fn capture(&mut self) -> Result<Frame, String> {
        match self {
            Source::Fake(cmd) => fake_capture(cmd),
            Source::Window(c) => c.capture(),
        }
    }
}

pub(crate) fn jpeg(rgba: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>, String> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec()).ok_or("bad frame")?;
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut out = Vec::with_capacity(256 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode_image(&rgb).map_err(|e| format!("JPEG 인코딩 실패: {e}"))?;
    Ok(out)
}

/// Cheap change detection over the whole frame (not cryptographic).
fn fingerprint(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for c in bytes.chunks(8) {
        let mut w = [0u8; 8];
        w[..c.len()].copy_from_slice(c);
        h = (h ^ u64::from_le_bytes(w)).wrapping_mul(0x0000_0100_0000_01b3).rotate_left(29);
    }
    h
}

struct StreamOpts {
    window: u32,
    video: bool,
    fps: f64,
    max_width: u32,
    bitrate: u32,
    acks: bool,
}

/// The capture/encode loop, on its own thread (window handles and the encoder stay on it).
fn run(id: u32, o: StreamOpts, stop: Arc<AtomicBool>, want_key: Arc<AtomicBool>, acked: Acked) {
    // macOS 13+: ScreenCaptureKit + VideoToolbox (F-18); anything it cannot do goes the CPU way below
    #[cfg(target_os = "macos")]
    if o.video && std::env::var("AIDEV_SCREEN_CMD").is_err() && crate::mac_screen::available() {
        let (window, display) = if appwin::is_display(o.window) { (None, appwin::display_os_id(o.window - appwin::DISPLAY_BASE)) } else { (Some(o.window), None) };
        match crate::mac_screen::Capture::open(window, display, o.max_width, o.fps) {
            Ok(cap) => {
                stream_mac(id, &o, cap, &stop, &want_key, acked);
                hub().lock().unwrap().streams.remove(&id);
                return;
            }
            Err(e) => eprintln!("[aidev-runner] ScreenCaptureKit을 쓰지 못해 CPU 캡처로 합니다: {e}"),
        }
    }
    match Source::open(o.window) {
        Ok(source) => stream(id, o, source, stop, want_key, acked),
        Err(e) => note("screen.error", json!({ "streamId": id, "error": e })),
    }
    hub().lock().unwrap().streams.remove(&id);
}

fn stream(id: u32, o: StreamOpts, mut source: Source, stop: Arc<AtomicBool>, want_key: Arc<AtomicBool>, acked: Acked) {
    let period = Duration::from_secs_f64(1.0 / o.fps);
    let mut enc: Option<H264> = None;
    let mut jpeg_size: Option<(u32, u32)> = None;
    let mut last: Option<u64> = None;
    let mut failures = 0;
    let mut pace = Pace::new(id, o.acks, o.bitrate, acked);
    while !stop.load(Ordering::Relaxed) {
        let t0 = Instant::now();
        if let (Some(kbps), Some(e)) = (pace.tick(t0), enc.as_mut()) {
            e.set_bitrate(kbps);
        }
        if pace.hold(t0) {
            std::thread::sleep(period);
            continue;
        }
        match source.capture() {
            Ok(captured) => {
                failures = 0;
                let t1 = Instant::now();
                let (rgba, w, h) = encoder::fit(captured, o.max_width);
                let t2 = Instant::now();
                let fp = fingerprint(&rgba);
                let force = want_key.swap(false, Ordering::Relaxed);
                if last != Some(fp) || force {
                    last = Some(fp);
                    let payload = if o.video {
                        if enc.as_ref().map(|e| (e.width, e.height)) != Some((w, h)) {
                            // first frame or the window was resized: a new encoder, starting with a keyframe
                            match H264::new(w, h, o.fps.round() as u32, pace.kbps) {
                                Ok(e) => { enc = Some(e); note("screen.format", json!({ "streamId": id, "codec": "h264", "width": w, "height": h })); }
                                Err(e) => { note("screen.error", json!({ "streamId": id, "error": e })); break; }
                            }
                        }
                        match enc.as_mut().map(|e| e.encode(&rgba, force)) {
                            Some(Ok((au, key))) if !au.is_empty() => Some((KIND_H264, key, au)),
                            // screen.error always means the stream has ended (the gateway drops it)
                            Some(Err(e)) => { note("screen.error", json!({ "streamId": id, "error": e })); break; }
                            _ => None,
                        }
                    } else {
                        if jpeg_size != Some((w, h)) {
                            jpeg_size = Some((w, h));
                            note("screen.format", json!({ "streamId": id, "codec": "jpeg", "width": w, "height": h }));
                        }
                        jpeg(&rgba, w, h, 70).ok().map(|j| (KIND_JPEG, true, j))
                    };
                    if let Some((kind, key, data)) = payload {
                        let p = pace.frame(kind, key, &data, t1 - t0, t2 - t1, t2.elapsed());
                        if !send_frame(id, &p) {
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                // a window can fail for a moment (resizing, switching spaces): give up after ~2 s in a row
                failures += 1;
                if failures >= 4 {
                    note("screen.error", json!({ "streamId": id, "error": e }));
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        std::thread::sleep(period.saturating_sub(t0.elapsed()));
    }
}

/// The macOS stream: a picture only when the screen changed, encoded on the GPU; while frames queue the newest one
/// waits and goes once the queue has drained (the viewer always ends on the current picture).
#[cfg(target_os = "macos")]
fn stream_mac(id: u32, o: &StreamOpts, mut cap: crate::mac_screen::Capture, stop: &AtomicBool, want_key: &AtomicBool, acked: Acked) {
    use crate::mac_screen::{Encoder, Picture};
    let mut pace = Pace::new(id, o.acks, o.bitrate, acked);
    let mut enc: Option<Encoder> = None;
    let mut pending: Option<Picture> = None;
    let mut last: Option<Picture> = None;
    let mut follow_at = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if let (Some(kbps), Some(e)) = (pace.tick(now), enc.as_mut()) {
            e.set_bitrate(kbps);
        }
        if let Some(p) = cap.next(Duration::from_millis(50)) {
            pending = Some(p);
        }
        // a window that changed shape: the capture follows it, and a new encoder starts with a keyframe
        if now.duration_since(follow_at) >= Duration::from_secs(1) {
            follow_at = now;
            match cap.follow_window() {
                Ok(true) => enc = None,
                Ok(false) => {}
                Err(e) => { note("screen.error", json!({ "streamId": id, "error": e })); break; }
            }
        }
        let force = want_key.load(Ordering::Relaxed);
        if pending.is_none() && force {
            pending = last.take();   // nothing changed, a keyframe asked for: the last picture again
        }
        if pending.is_none() || pace.hold(Instant::now()) {
            continue;
        }
        let Some(pic) = pending.take() else { continue };
        want_key.store(false, Ordering::Relaxed);
        if enc.as_ref().map(|e| (e.width, e.height)) != Some((cap.width, cap.height)) {
            match Encoder::new(cap.width, cap.height, o.fps, pace.kbps) {
                Ok(e) => { enc = Some(e); note("screen.format", json!({ "streamId": id, "codec": "h264", "width": cap.width, "height": cap.height, "encoder": "videotoolbox" })); }
                Err(e) => { note("screen.error", json!({ "streamId": id, "error": e })); break; }
            }
        }
        let t = Instant::now();
        let first = enc.as_ref().is_some_and(|e| e.fresh());
        match enc.as_mut().map(|e| e.encode(&pic.pixels, force || first)) {
            Some(Ok((au, key))) if !au.is_empty() => {
                let p = pace.frame(KIND_H264, key, &au, pic.capture, Duration::ZERO, t.elapsed());
                if !send_frame(id, &p) {
                    break;
                }
            }
            Some(Err(e)) => { note("screen.error", json!({ "streamId": id, "error": e })); break; }
            _ => {}
        }
        last = Some(pic);
    }
}

fn start(params: &Value) -> RpcResult {
    let id = params.get("streamId").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "streamId 필요".to_string()))?;
    let window = params.get("window").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "window 필요 (screen.list의 id)".to_string()))?;
    let video = params.get("mode").and_then(Value::as_str) != Some("jpeg");
    let fps = params.get("fps").and_then(Value::as_f64).unwrap_or(if video { 30.0 } else { 2.0 }).clamp(0.5, 60.0);
    let max_width = params.get("maxWidth").and_then(Value::as_u64).unwrap_or(DEFAULT_WIDTH as u64).clamp(320, 3840) as u32;
    let bitrate = params.get("bitrate").and_then(Value::as_u64).unwrap_or(4000).clamp(300, 20000) as u32;
    let acks = params.get("acks").and_then(Value::as_bool).unwrap_or(false);
    let mut g = hub().lock().unwrap();
    if g.streams.contains_key(&id) {
        return Err((-32602, format!("stream {id} 이미 사용 중")));
    }
    if g.streams.len() >= MAX_STREAMS {
        return Err((-32006, format!("동시 화면 스트림은 최대 {MAX_STREAMS}개입니다")));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let key = Arc::new(AtomicBool::new(false));
    let acked: Acked = Arc::new(Mutex::new(None));
    g.streams.insert(id, Ctl { stop: stop.clone(), key: key.clone(), acked: acked.clone() });
    drop(g);
    let o = StreamOpts { window, video, fps, max_width, bitrate, acks };
    std::thread::Builder::new().name(format!("aidev-screen-{id}")).spawn(move || run(id, o, stop, key, acked)).map_err(|e| (-32000, e.to_string()))?;
    Ok(json!({ "streamId": id, "window": window, "mode": if video { "video" } else { "jpeg" }, "codec": if video { "h264" } else { "jpeg" } }))
}

fn shot(params: &Value) -> RpcResult {
    let max_width = params.get("maxWidth").and_then(Value::as_u64).unwrap_or(DEFAULT_WIDTH as u64).clamp(320, 3840) as u32;
    let quality = params.get("quality").and_then(Value::as_u64).unwrap_or(70).clamp(30, 90) as u8;
    let t0 = Instant::now();
    let (captured, info) = if let Ok(cmd) = std::env::var("AIDEV_SCREEN_CMD") {
        (fake_capture(&cmd).map_err(|e| (-32031, e))?, json!({ "id": 0, "app": "test", "title": "test" }))
    } else {
        let w = appwin::find(params.get("window").and_then(Value::as_u64).map(|v| v as u32), params.get("query").and_then(Value::as_str)).map_err(|e| (-32032, e))?;
        let mut c = appwin::Capturer::open(w.id).map_err(|e| (-32031, e))?;
        (c.capture().map_err(|e| (-32031, e))?, json!(w))
    };
    let (rgba, w, h) = encoder::fit(captured, max_width);
    let j = jpeg(&rgba, w, h, quality).map_err(|e| (-32031, e))?;
    Ok(json!({ "b64": base64::engine::general_purpose::STANDARD.encode(&j), "mime": "image/jpeg", "width": w, "height": h, "bytes": j.len(), "ms": t0.elapsed().as_millis() as u64, "window": info }))
}

/// `aidev-runner bench`: the stream's stages on this PC, timed — capture, scale, change check, H.264 — for the
/// main screen (or `window`), `frames` times at `max_width`. The numbers to compare capture/encode paths by.
pub fn bench(window: Option<u32>, frames: u32, max_width: u32) -> Result<String, String> {
    let id = window.unwrap_or(appwin::DISPLAY_BASE);
    let mut cap = appwin::Capturer::open(id)?;
    let (mut capture, mut scale, mut check, mut encode, mut bytes) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), 0usize);
    let mut enc: Option<H264> = None;
    let mut size = (0, 0, 0, 0);
    for i in 0..frames {
        let t0 = Instant::now();
        let f = cap.capture()?;
        let t1 = Instant::now();
        size = (f.width, f.height, size.2, size.3);
        let (rgba, w, h) = encoder::fit(f, max_width);
        let t2 = Instant::now();
        let _ = fingerprint(&rgba);
        let t3 = Instant::now();
        if enc.as_ref().map(|e| (e.width, e.height)) != Some((w, h)) {
            enc = Some(H264::new(w, h, 30, 4000)?);
        }
        size.2 = w;
        size.3 = h;
        let (au, _) = enc.as_mut().unwrap().encode(&rgba, i == 0)?;
        let t4 = Instant::now();
        bytes += au.len();
        capture.push(t1 - t0);
        scale.push(t2 - t1);
        check.push(t3 - t2);
        encode.push(t4 - t3);
    }
    let line = |name: &str, v: &mut Vec<Duration>| {
        v.sort();
        let avg = v.iter().sum::<Duration>().as_secs_f64() * 1000.0 / v.len().max(1) as f64;
        let p95 = v.get(v.len() * 95 / 100).copied().unwrap_or_default().as_secs_f64() * 1000.0;
        format!("{name:<8} 평균 {avg:6.1} ms   p95 {p95:6.1} ms")
    };
    let total: Vec<Duration> = (0..capture.len()).map(|i| capture[i] + scale[i] + check[i] + encode[i]).collect();
    let mut total = total;
    let avg_total = total.iter().sum::<Duration>().as_secs_f64() / total.len().max(1) as f64;
    Ok(format!(
        "{} ({}×{} → {}×{}, {frames}프레임)\n{}\n{}\n{}\n{}\n{}\n→ 한 스레드로 최대 {:.0} fps, 인코딩 평균 {} KB/프레임",
        if window.is_some() { "창" } else { "주 화면" }, size.0, size.1, size.2, size.3,
        line("캡처", &mut capture), line("축소", &mut scale), line("변화확인", &mut check), line("인코딩", &mut encode), line("합계", &mut total),
        1.0 / avg_total.max(1e-6), bytes / 1024 / frames.max(1) as usize,
    ))
}

/// `bench` on macOS 13+: ScreenCaptureKit + VideoToolbox — pictures for 3 s (only changes arrive: move something on
/// the screen meanwhile), the time from composition to the runner, and the hardware encoder on the last picture.
#[cfg(target_os = "macos")]
pub fn bench_native(window: Option<u32>, frames: u32, max_width: u32) -> Result<String, String> {
    use crate::mac_screen::{Capture, Encoder};
    let (win, display) = match window {
        Some(w) if !appwin::is_display(w) => (Some(w), None),
        Some(w) => (None, appwin::display_os_id(w - appwin::DISPLAY_BASE)),
        None => (None, appwin::display_os_id(0)),
    };
    let t_open = Instant::now();
    let cap = Capture::open(win, display, max_width, 60.0)?;
    let open_ms = t_open.elapsed().as_secs_f64() * 1000.0;
    let mut enc = Encoder::new(cap.width, cap.height, 60.0, 4000)?;
    let (mut lat, mut encode, mut bytes) = (Vec::new(), Vec::new(), 0usize);
    let mut last = None;
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if let Some(p) = cap.next(Duration::from_millis(100)) {
            lat.push(p.capture);
            let t = Instant::now();
            let (au, _) = enc.encode(&p.pixels, encode.is_empty())?;
            encode.push(t.elapsed());
            bytes += au.len();
            last = Some(p);
        }
    }
    let changes = lat.len();
    let pic = last.ok_or("3초 동안 받은 화면이 없습니다 (화면 기록 권한?)")?;
    for i in 0..frames {
        let t = Instant::now();
        let (au, _) = enc.encode(&pic.pixels, i % 30 == 0)?;
        encode.push(t.elapsed());
        bytes += au.len();
    }
    let stat = |v: &mut Vec<Duration>| {
        v.sort();
        let avg = v.iter().sum::<Duration>().as_secs_f64() * 1000.0 / v.len().max(1) as f64;
        let p95 = v.get(v.len() * 95 / 100).copied().unwrap_or_default().as_secs_f64() * 1000.0;
        (avg, p95)
    };
    let (la, lp) = stat(&mut lat);
    let (ea, ep) = stat(&mut encode);
    Ok(format!(
        "ScreenCaptureKit + VideoToolbox ({}×{}, 스트림 여는 데 {open_ms:.0} ms)\n받은 화면 변화 {changes}개 / 3초 — 합성→러너 평균 {la:.1} ms, p95 {lp:.1} ms (축소·색 변환은 GPU)\n인코딩 {}회 평균 {ea:.1} ms, p95 {ep:.1} ms, 평균 {} KB/프레임\n→ 인코딩만으로 최대 {:.0} fps (캡처는 별도 스레드에서 와서 기다리지 않음)",
        cap.width, cap.height, encode.len(), bytes / 1024 / encode.len().max(1), 1000.0 / ea.max(0.01),
    ))
}

/// JSON-RPC entry point for `screen.*`; None when the method is not a screen method.
pub async fn rpc(cfg: &Config, method: &str, params: &Value) -> Option<RpcResult> {
    if !method.starts_with("screen.") {
        return None;
    }
    if !crate::config::screen_allowed(cfg) {
        return Some(Err((-32030, NO_CONSENT.into())));
    }
    // the boot-time runner has no desktop: what it could capture is an empty login screen, not the user's
    if crate::control::is_boot() && std::env::var("AIDEV_SCREEN_CMD").is_err() {
        return Some(Err((-32030, "이 PC에 로그인한 사용자 세션이 없습니다 (부팅용 러너가 연결 중) — 로그인하면 그 세션의 러너가 넘겨받아 화면을 보여 줍니다".into())));
    }
    // macOS without Screen Recording hands out the wallpaper and no windows: say so instead of showing that
    #[cfg(target_os = "macos")]
    if !crate::macperm::granted().0 && std::env::var("AIDEV_SCREEN_CMD").is_err() {
        crate::macperm::request_once();
        return Some(Err((-32030, format!("이 Mac에서 aidev-runner의 화면 기록 권한이 꺼져 있습니다 — 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록에서 {} 를 켜 주세요", std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "aidev-runner".into())))));
    }
    let params = params.clone();
    Some(match method {
        "screen.list" => tokio::task::spawn_blocking(|| {
            if std::env::var("AIDEV_SCREEN_CMD").is_ok() {
                return Ok(json!({ "windows": [{ "id": 1, "pid": 0, "app": "test", "title": "test window", "x": 0, "y": 0, "width": 640, "height": 360, "focused": true }] }));
            }
            // a display list that fails (no permission yet) must not hide the windows
            let displays = appwin::displays().unwrap_or_default();
            appwin::list().map(|mut w| { w.extend(displays); json!({ "windows": w }) }).map_err(|e| (-32032, e))
        }).await.unwrap_or_else(|e| Err((-32000, e.to_string()))),
        "screen.shot" => tokio::task::spawn_blocking(move || shot(&params)).await.unwrap_or_else(|e| Err((-32000, e.to_string()))),
        "screen.start" => start(&params),
        "screen.key" | "screen.stop" => {
            let id = params.get("streamId").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "streamId 필요".to_string()));
            id.map(|id| {
                let mut g = hub().lock().unwrap();
                let found = if method == "screen.stop" { g.streams.remove(&id).map(|c| c.stop.store(true, Ordering::Relaxed)).is_some() } else { g.streams.get(&id).map(|c| c.key.store(true, Ordering::Relaxed)).is_some() };
                json!({ "ok": found })
            })
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_png(path: &str, shade: u8) {
        let img = image::RgbImage::from_fn(1600, 900, |x, y| {
            // a small box changes with `shade` (a whole-frame change is a scene change → an I-frame)
            let b = if (100..300).contains(&x) && (100..240).contains(&y) { shade } else { 60 };
            image::Rgb([(x % 256) as u8, (y % 256) as u8, b])
        });
        // atomic: the stream loop must never read a half-written file
        let tmp = format!("{path}.tmp.png");
        img.save(&tmp).unwrap();
        std::fs::rename(tmp, path).unwrap();
    }

    /// The next message, leaving out the once-a-second screen.stats.
    async fn next(rx: &mut tokio::sync::mpsc::Receiver<Message>, secs: u64) -> Message {
        loop {
            let m = tokio::time::timeout(Duration::from_secs(secs), rx.recv()).await.expect("timeout").expect("closed");
            if !matches!(&m, Message::Text(t) if t.contains("screen.stats")) {
                return m;
            }
        }
    }

    /// No frame (binary message) within `ms`.
    async fn quiet(rx: &mut tokio::sync::mpsc::Receiver<Message>, ms: u64) -> bool {
        let until = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            match tokio::time::timeout_at(until, rx.recv()).await {
                Err(_) => return true,
                Ok(Some(Message::Binary(_))) => return false,
                Ok(_) => {}
            }
        }
    }

    #[tokio::test]
    async fn consent_shot_video_jpeg_keyframes() {
        assert_eq!(rpc(&Config::default(), "screen.shot", &json!({})).await.unwrap().unwrap_err().0, -32030);
        assert!(rpc(&Config::default(), "exec.start", &json!({})).await.is_none());

        let src = std::env::temp_dir().join(format!("aidev-screen-src-{}.png", std::process::id()));
        test_png(src.to_str().unwrap(), 10);
        std::env::set_var("AIDEV_SCREEN_CMD", format!("cp {} {{out}}", src.display()));
        let cfg = Config { screen_consent: true, ..Default::default() };
        let r = rpc(&cfg, "screen.shot", &json!({ "maxWidth": 800 })).await.unwrap().unwrap();
        assert_eq!((r["width"].as_u64(), r["height"].as_u64()), (Some(800), Some(450)));
        assert_eq!(rpc(&cfg, "screen.list", &json!({})).await.unwrap().unwrap()["windows"][0]["id"], 1);
        assert_eq!(rpc(&cfg, "screen.start", &json!({ "streamId": 4 })).await.unwrap().unwrap_err().0, -32602, "a window is required");

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(64);
        attach(tx);
        // video: format note, then an IDR access unit (SPS first); an unchanged window sends nothing more
        rpc(&cfg, "screen.start", &json!({ "streamId": 5, "window": 1, "fps": 20, "maxWidth": 640 })).await.unwrap().unwrap();
        let Message::Text(fmt) = next(&mut rx, 10).await else { panic!("no format") };
        assert!(fmt.contains("screen.format") && fmt.contains("\"h264\"") && fmt.contains("\"width\":640"), "{fmt}");
        let Message::Binary(f) = next(&mut rx, 10).await else { panic!("no frame") };
        assert_eq!(&f[..4], &5u32.to_be_bytes());
        assert_eq!((f[4], f[5]), (KIND_H264, 1));
        assert_eq!(&f[6..11], &[0, 0, 0, 1, 0x67]);
        assert!(quiet(&mut rx, 500).await, "no frames while nothing changes");
        // a keyframe on request, then a change → a delta frame
        rpc(&cfg, "screen.key", &json!({ "streamId": 5 })).await.unwrap().unwrap();
        let Message::Binary(k) = next(&mut rx, 5).await else { panic!("no key") };
        assert_eq!(k[5], 1);
        test_png(src.to_str().unwrap(), 200);
        let m = next(&mut rx, 5).await; let Message::Binary(d) = m else { panic!("no delta: {m:?}") };
        assert_eq!((d[4], d[5]), (KIND_H264, 0));
        rpc(&cfg, "screen.stop", &json!({ "streamId": 5 })).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        while rx.try_recv().is_ok() {}
        // jpeg mode
        rpc(&cfg, "screen.start", &json!({ "streamId": 6, "window": 1, "mode": "jpeg", "fps": 10 })).await.unwrap().unwrap();
        let Message::Text(jf) = next(&mut rx, 5).await else { panic!("no jpeg format") };
        assert!(jf.contains("\"jpeg\""), "{jf}");
        let Message::Binary(j) = next(&mut rx, 5).await else { panic!("no jpeg") };
        assert_eq!(&j[4..8], &[KIND_JPEG, 1, 0xFF, 0xD8]);
        rpc(&cfg, "screen.stop", &json!({ "streamId": 6 })).await.unwrap().unwrap();
        // a failing capture reports screen.error and ends
        std::env::set_var("AIDEV_SCREEN_CMD", "exit 7");
        tokio::time::sleep(Duration::from_millis(200)).await;
        while rx.try_recv().is_ok() {}
        rpc(&cfg, "screen.start", &json!({ "streamId": 7, "window": 1 })).await.unwrap().unwrap();
        let Message::Text(t) = next(&mut rx, 5).await else { panic!("no error") };
        assert!(t.contains("screen.error") && t.contains("\"streamId\":7"));
        rpc(&cfg, "screen.stop", &json!({ "streamId": 7 })).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        while rx.try_recv().is_ok() {}

        // acks: numbered frames; with the first one never shown a new one waits, an ack lets it through
        test_png(src.to_str().unwrap(), 10);
        std::env::set_var("AIDEV_SCREEN_CMD", format!("cp {} {{out}}", src.display()));
        rpc(&cfg, "screen.start", &json!({ "streamId": 8, "window": 1, "fps": 20, "maxWidth": 640, "acks": true })).await.unwrap().unwrap();
        let Message::Text(_) = next(&mut rx, 10).await else { panic!("no format") };
        let Message::Binary(n1) = next(&mut rx, 10).await else { panic!("no frame") };
        assert_eq!((n1[4], n1[5]), (KIND_H264, 3), "keyframe, numbered");
        assert_eq!(&n1[6..10], &1u32.to_be_bytes());
        assert_eq!(&n1[10..15], &[0, 0, 0, 1, 0x67]);
        tokio::time::sleep(Duration::from_millis(600)).await;   // longer than the budget without any loop measured (400 ms)
        test_png(src.to_str().unwrap(), 120);
        assert!(quiet(&mut rx, 800).await, "frame 1 not shown yet: no new frame");
        ack(&json!({ "streamId": 8, "seq": 1 }));
        let Message::Binary(n2) = next(&mut rx, 5).await else { panic!("no frame after the ack") };
        assert_eq!((n2[5] & 2, &n2[6..10]), (2, &2u32.to_be_bytes()[..]));
        // the stats say what happened
        let stats = loop {
            if let Message::Text(t) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap().unwrap() {
                if t.contains("screen.stats") { break serde_json::from_str::<Value>(&t).unwrap(); }
            }
        };
        assert!(stats["params"]["streamId"] == 8 && stats["params"]["bitrate"].as_u64().is_some(), "{stats}");
        rpc(&cfg, "screen.stop", &json!({ "streamId": 8 })).await.unwrap().unwrap();
        detach();
        std::env::remove_var("AIDEV_SCREEN_CMD");
        let _ = std::fs::remove_file(src);
    }
}
