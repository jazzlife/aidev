//! `screen.*` (IMPLEMENTATION-PLAN §3.12, F-07c): one program window of this PC — listed, captured, streamed
//! as live H.264 (or JPEG on change) — view and control only after the owner ran
//! `aidev-runner consent screen on` (control: `consent control on`, see input.rs). Nothing to install:
//! window capture (appwin.rs) and the H.264 encoder (encoder.rs, OpenH264) are inside the runner.
//!   screen.list → {windows:[{id, pid, app, title, x, y, width, height, focused}]}
//!   screen.list → {windows}   (0.13.3: the whole screens come last, app "전체 화면", ids from appwin::DISPLAY_BASE — usable
//!                               wherever a window id is: shot, start, input; the focused window stays the default)
//!   screen.shot {window? | query?, maxWidth?, quality?} → {b64 (JPEG), width, height, window}
//!   screen.start {streamId, window, mode: "video"|"jpeg", fps?, maxWidth?, bitrate?} → {streamId, window}
//!   screen.key {streamId}  (next frame is a keyframe)      screen.stop {streamId}
//!   notifications screen.format {streamId, codec, width, height}, screen.error {streamId, error}
//! Frames: binary `[streamId u32 BE][kind u8][flags u8][data]`, kind 1 = H.264 access unit (Annex B, SPS/PPS
//! before every IDR), 3 = JPEG; flags bit 0 = keyframe. A frame is encoded only when the window's pixels
//! changed (or a keyframe was asked for), at most `fps` per second; a resized window restarts the encoder.
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

struct Ctl {
    stop: Arc<AtomicBool>,
    key: Arc<AtomicBool>,
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

fn tagged(kind: u8, key: bool, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(data.len() + 2);
    v.push(kind);
    v.push(u8::from(key));
    v.extend_from_slice(data);
    v
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
}

/// The capture/encode loop, on its own thread (window handles and the encoder stay on it).
fn run(id: u32, o: StreamOpts, stop: Arc<AtomicBool>, want_key: Arc<AtomicBool>) {
    match Source::open(o.window) {
        Ok(source) => stream(id, o, source, stop, want_key),
        Err(e) => note("screen.error", json!({ "streamId": id, "error": e })),
    }
    hub().lock().unwrap().streams.remove(&id);
}

fn stream(id: u32, o: StreamOpts, mut source: Source, stop: Arc<AtomicBool>, want_key: Arc<AtomicBool>) {
    let period = Duration::from_secs_f64(1.0 / o.fps);
    let mut enc: Option<H264> = None;
    let mut jpeg_size: Option<(u32, u32)> = None;
    let mut last: Option<u64> = None;
    let mut failures = 0;
    while !stop.load(Ordering::Relaxed) {
        let t0 = Instant::now();
        match source.capture() {
            Ok(captured) => {
                failures = 0;
                let (rgba, w, h) = encoder::fit(captured, o.max_width);
                let fp = fingerprint(&rgba);
                let force = want_key.swap(false, Ordering::Relaxed);
                if last != Some(fp) || force {
                    last = Some(fp);
                    let payload = if o.video {
                        if enc.as_ref().map(|e| (e.width, e.height)) != Some((w, h)) {
                            // first frame or the window was resized: a new encoder, starting with a keyframe
                            match H264::new(w, h, o.fps.round() as u32, o.bitrate) {
                                Ok(e) => { enc = Some(e); note("screen.format", json!({ "streamId": id, "codec": "h264", "width": w, "height": h })); }
                                Err(e) => { note("screen.error", json!({ "streamId": id, "error": e })); break; }
                            }
                        }
                        match enc.as_mut().map(|e| e.encode(&rgba, force)) {
                            Some(Ok((au, key))) if !au.is_empty() => Some(tagged(KIND_H264, key, &au)),
                            // screen.error always means the stream has ended (the gateway drops it)
                            Some(Err(e)) => { note("screen.error", json!({ "streamId": id, "error": e })); break; }
                            _ => None,
                        }
                    } else {
                        if jpeg_size != Some((w, h)) {
                            jpeg_size = Some((w, h));
                            note("screen.format", json!({ "streamId": id, "codec": "jpeg", "width": w, "height": h }));
                        }
                        jpeg(&rgba, w, h, 70).ok().map(|j| tagged(KIND_JPEG, true, &j))
                    };
                    if let Some(p) = payload {
                        let Some(out) = out() else { break };
                        if out.blocking_send(Message::Binary(frame(id, &p))).is_err() {
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

fn start(params: &Value) -> RpcResult {
    let id = params.get("streamId").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "streamId 필요".to_string()))?;
    let window = params.get("window").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "window 필요 (screen.list의 id)".to_string()))?;
    let video = params.get("mode").and_then(Value::as_str) != Some("jpeg");
    let fps = params.get("fps").and_then(Value::as_f64).unwrap_or(if video { 30.0 } else { 2.0 }).clamp(0.5, 60.0);
    let max_width = params.get("maxWidth").and_then(Value::as_u64).unwrap_or(DEFAULT_WIDTH as u64).clamp(320, 3840) as u32;
    let bitrate = params.get("bitrate").and_then(Value::as_u64).unwrap_or(4000).clamp(300, 20000) as u32;
    let mut g = hub().lock().unwrap();
    if g.streams.contains_key(&id) {
        return Err((-32602, format!("stream {id} 이미 사용 중")));
    }
    if g.streams.len() >= MAX_STREAMS {
        return Err((-32006, format!("동시 화면 스트림은 최대 {MAX_STREAMS}개입니다")));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let key = Arc::new(AtomicBool::new(false));
    g.streams.insert(id, Ctl { stop: stop.clone(), key: key.clone() });
    drop(g);
    let o = StreamOpts { window, video, fps, max_width, bitrate };
    std::thread::Builder::new().name(format!("aidev-screen-{id}")).spawn(move || run(id, o, stop, key)).map_err(|e| (-32000, e.to_string()))?;
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

/// JSON-RPC entry point for `screen.*`; None when the method is not a screen method.
pub async fn rpc(cfg: &Config, method: &str, params: &Value) -> Option<RpcResult> {
    if !method.starts_with("screen.") {
        return None;
    }
    if !crate::config::screen_allowed(cfg) {
        return Some(Err((-32030, NO_CONSENT.into())));
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

    async fn next(rx: &mut tokio::sync::mpsc::Receiver<Message>, secs: u64) -> Message {
        tokio::time::timeout(Duration::from_secs(secs), rx.recv()).await.expect("timeout").expect("closed")
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
        assert!(tokio::time::timeout(Duration::from_millis(500), rx.recv()).await.is_err(), "no frames while nothing changes");
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
        detach();
        std::env::remove_var("AIDEV_SCREEN_CMD");
        let _ = std::fs::remove_file(src);
    }
}
