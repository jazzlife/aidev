//! `screen.*` (IMPLEMENTATION-PLAN §3.12, F-07): what is on this PC's screen, view only, and only after
//! the owner ran `aidev-runner consent screen on`.
//!   screen.list → {displays:[{id, name, width?, height?}], backend}
//!   screen.shot {display?, maxWidth?, quality?} → {b64 (JPEG), width, height, bytes, ms}
//!   screen.start {streamId, mode: "video"|"jpeg", display?, fps?, maxWidth?, bitrate?, codec?} → {streamId, mode, codec}
//!   screen.stop {streamId}     notifications screen.format {streamId, codec, reason?}, screen.error {streamId, error}
//! Frames: binary `[streamId u32 BE][kind u8][flags u8][data]`, kind 1 = H.264 access unit (Annex B),
//! 2 = VP8 frame, 3 = JPEG; flags bit 0 = keyframe.
//! video (F-07b, default): ffmpeg captures the display and encodes in real time (macOS avfoundation +
//! VideoToolbox, Windows gdigrab + x264, Linux x11grab + x264; 30 fps, 2 s GOP, no B-frames, SPS/PPS on
//! every keyframe), the stdout stream is cut into access units (video.rs) — the browser decodes them with
//! WebCodecs. No ffmpeg / it fails to start → the stream falls back to jpeg and says so (screen.format).
//! jpeg: a frame only when the picture changed (hash of the scaled JPEG), at most `fps` per second (slower
//! when capturing takes longer); also used for screen.shot. Captures use the OS tool
//! — macOS `screencapture`, Windows PowerShell/System.Drawing, Linux grim / gnome-screenshot / ImageMagick
//! `import` / scrot — then scale (≤ maxWidth, default 1440) and re-encode as JPEG in-process.
//! `AIDEV_SCREEN_CMD` (tests) replaces the tool: a shell command whose `{out}` is the image file to write;
//! `AIDEV_SCREEN_FFMPEG_INPUT` (tests) replaces ffmpeg's capture input (e.g. `-f lavfi -i testsrc2=…`).

use crate::config::Config;
use crate::exec::{frame, Out};
use crate::video;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

type RpcResult = Result<Value, (i64, String)>;
const MAX_STREAMS: usize = 4;
const DEFAULT_WIDTH: u32 = 1440;
const DEFAULT_QUALITY: u8 = 60;
const NO_CONSENT: &str = "이 PC는 화면 캡처를 허용하지 않았습니다 — PC에서 `aidev-runner consent screen on` 후 러너를 다시 시작하세요";

#[derive(Default)]
struct Inner {
    out: Option<Out>,
    streams: HashMap<u32, JoinHandle<()>>,
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
    for (_, task) in g.streams.drain() {
        task.abort();
    }
}

#[derive(Clone, Copy)]
struct Opts {
    display: u32,
    max_width: u32,
    quality: u8,
}

fn opts(params: &Value) -> Opts {
    let num = |k: &str| params.get(k).and_then(Value::as_u64);
    Opts {
        display: num("display").unwrap_or(1).clamp(1, 16) as u32,
        max_width: num("maxWidth").unwrap_or(DEFAULT_WIDTH as u64).clamp(320, 3840) as u32,
        quality: num("quality").unwrap_or(DEFAULT_QUALITY as u64).clamp(30, 90) as u8,
    }
}

fn temp_file() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!("aidev-screen-{}-{}.img", std::process::id(), N.fetch_add(1, Ordering::Relaxed)))
}

fn which(tool: &str) -> bool {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).any(|dir| dir.join(tool).is_file())
}

/// The capture command for this OS (program + args), writing the image to `out`.
fn capture_command(display: u32, out: &Path) -> Result<(String, Vec<String>), String> {
    let o = out.display().to_string();
    if let Ok(custom) = std::env::var("AIDEV_SCREEN_CMD") {
        return Ok(("sh".into(), vec!["-c".into(), custom.replace("{out}", &o).replace("{display}", &display.to_string())]));
    }
    if cfg!(target_os = "macos") {
        // -x no sound, -D display (1 = main), -t jpg keeps the file small before scaling
        return Ok(("screencapture".into(), vec!["-x".into(), "-D".into(), display.to_string(), "-t".into(), "jpg".into(), o]));
    }
    if cfg!(windows) {
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::AllScreens; $i={}; if($i -ge $s.Length){{$i=0}}; $b=$s[$i].Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('{}',[System.Drawing.Imaging.ImageFormat]::Png)",
            display - 1,
            o.replace('\'', "''")
        );
        return Ok(("powershell".into(), vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script]));
    }
    for (tool, args) in [
        ("grim", vec![o.clone()]),
        ("gnome-screenshot", vec!["-f".into(), o.clone()]),
        ("import", vec!["-window".into(), "root".into(), o.clone()]),
        ("scrot", vec!["-o".into(), o.clone()]),
    ] {
        if which(tool) {
            return Ok((tool.into(), args));
        }
    }
    Err("화면 캡처 도구가 없습니다 (grim, gnome-screenshot, ImageMagick import, scrot 중 하나를 설치하세요)".into())
}

/// One capture: OS tool → decode → scale to ≤ max_width → JPEG. Blocking (run on a blocking thread).
fn capture(o: Opts) -> Result<(Vec<u8>, u32, u32), String> {
    let out = temp_file();
    let (program, args) = capture_command(o.display, &out)?;
    let status = Command::new(&program).args(&args).output().map_err(|e| format!("{program} 실행 실패: {e}"))?;
    let data = std::fs::read(&out);
    let _ = std::fs::remove_file(&out);
    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr).trim().chars().take(300).collect::<String>();
        let hint = if cfg!(target_os = "macos") { " — 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록에서 러너를 실행하는 앱(터미널 등)을 허용하세요" } else { "" };
        return Err(format!("{program} 실패 ({}){hint}: {err}", status.status));
    }
    let data = data.map_err(|e| format!("캡처 파일을 읽지 못했습니다: {e}"))?;
    let img = image::load_from_memory(&data).map_err(|e| format!("이미지 해석 실패: {e}"))?;
    let img = if img.width() > o.max_width { img.thumbnail(o.max_width, u32::MAX) } else { img };
    let rgb = img.to_rgb8();
    let mut jpeg = Vec::with_capacity(256 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, o.quality)
        .encode_image(&rgb)
        .map_err(|e| format!("JPEG 인코딩 실패: {e}"))?;
    Ok((jpeg, rgb.width(), rgb.height()))
}

async fn capture_async(o: Opts) -> Result<(Vec<u8>, u32, u32), String> {
    tokio::task::spawn_blocking(move || capture(o)).await.map_err(|e| e.to_string())?
}

fn displays() -> Value {
    if cfg!(target_os = "macos") && std::env::var("AIDEV_SCREEN_CMD").is_err() {
        if let Ok(out) = Command::new("system_profiler").args(["SPDisplaysDataType", "-json"]).output() {
            if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
                let mut list = vec![];
                for gpu in v.get("SPDisplaysDataType").and_then(Value::as_array).cloned().unwrap_or_default() {
                    for d in gpu.get("spdisplays_ndrvs").and_then(Value::as_array).cloned().unwrap_or_default() {
                        let main = d.get("spdisplays_main").and_then(Value::as_str) == Some("spdisplays_yes");
                        let entry = json!({ "name": d.get("_name").and_then(Value::as_str).unwrap_or("디스플레이"), "resolution": d.get("_spdisplays_resolution").or_else(|| d.get("spdisplays_resolution")), "main": main });
                        if main { list.insert(0, entry) } else { list.push(entry) }
                    }
                }
                if !list.is_empty() {
                    return Value::Array(list.into_iter().enumerate().map(|(i, mut d)| { d["id"] = json!(i + 1); d }).collect());
                }
            }
        }
    }
    json!([{ "id": 1, "name": "주 화면", "main": true }])
}

fn fingerprint(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

async fn notify(id: u32, error: &str) {
    let out = hub().lock().unwrap().out.clone();
    if let Some(out) = out {
        let note = json!({ "jsonrpc": "2.0", "method": "screen.error", "params": { "streamId": id, "error": error } });
        let _ = out.send(Message::Text(note.to_string())).await;
    }
}

const KIND_H264: u8 = 1;
const KIND_VP8: u8 = 2;
const KIND_JPEG: u8 = 3;

fn tagged(kind: u8, key: bool, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(data.len() + 2);
    v.push(kind);
    v.push(u8::from(key));
    v.extend_from_slice(data);
    v
}

async fn notify_format(id: u32, codec: &str, reason: Option<String>) {
    let out = hub().lock().unwrap().out.clone();
    if let Some(out) = out {
        let note = json!({ "jsonrpc": "2.0", "method": "screen.format", "params": { "streamId": id, "codec": codec, "reason": reason } });
        let _ = out.send(Message::Text(note.to_string())).await;
    }
}

async fn send_frame(id: u32, payload: Vec<u8>) -> bool {
    let out = hub().lock().unwrap().out.clone();
    let Some(out) = out else { return false };
    out.send(Message::Binary(frame(id, &payload))).await.is_ok()
}

/// ffmpeg found in the user's PATH (a service's PATH is short) or the usual Homebrew places.
fn ffmpeg_path() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&crate::exec::user_path().or_else(|| std::env::var("PATH").ok()).unwrap_or_default()).collect();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].iter().map(PathBuf::from));
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

/// macOS: avfoundation's device index of "Capture screen <display-1>".
fn avfoundation_screen(ffmpeg: &Path, display: u32) -> String {
    let out = Command::new(ffmpeg).args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]).output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stderr).to_string()).unwrap_or_default();
    let want = format!("Capture screen {}", display - 1);
    for line in text.lines() {
        if line.contains(&want) {
            // "[AVFoundation indev @ 0x…] [3] Capture screen 0" → "3"
            if let Some(idx) = line.split('[').nth(2).and_then(|s| s.split(']').next()) {
                return idx.trim().to_string();
            }
        }
    }
    // no list (permission missing / parse failed): screens usually follow the cameras; "1" is a common guess
    "1".into()
}

struct VideoOpts {
    display: u32,
    fps: u32,
    max_width: u32,
    bitrate_kbps: u32,
    codec: &'static str,
}

fn ffmpeg_args(ffmpeg: &Path, v: &VideoOpts) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin"].iter().map(|s| s.to_string()).collect();
    let fps = v.fps.to_string();
    if let Ok(custom) = std::env::var("AIDEV_SCREEN_FFMPEG_INPUT") {
        a.extend(custom.replace("{fps}", &fps).split_whitespace().map(String::from));
    } else if cfg!(target_os = "macos") {
        let dev = format!("{}:none", avfoundation_screen(ffmpeg, v.display));
        a.extend(["-f", "avfoundation", "-capture_cursor", "1", "-framerate", &fps, "-i", &dev].iter().map(|s| s.to_string()));
    } else if cfg!(windows) {
        a.extend(["-f", "gdigrab", "-framerate", &fps, "-draw_mouse", "1", "-i", "desktop"].iter().map(|s| s.to_string()));
    } else {
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
        a.extend(["-f", "x11grab", "-framerate", &fps, "-draw_mouse", "1", "-i", &display].iter().map(|s| s.to_string()));
    }
    let scale = format!("scale=trunc(min({}\\,iw)/2)*2:-2,format=yuv420p", v.max_width);
    a.extend(["-vf".to_string(), scale]);
    let gop = (v.fps * 2).to_string();
    let br = format!("{}k", v.bitrate_kbps);
    let buf = format!("{}k", v.bitrate_kbps / 2);
    if v.codec == "vp8" {
        a.extend(["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", &br, "-g", &gop, "-f", "ivf", "-"].iter().map(|s| s.to_string()));
        return a;
    }
    let encoder = std::env::var("AIDEV_SCREEN_ENCODER").unwrap_or_else(|_| if cfg!(target_os = "macos") { "h264_videotoolbox".into() } else { "libx264".into() });
    a.extend(["-c:v".to_string(), encoder.clone()]);
    if encoder == "h264_videotoolbox" {
        a.extend(["-realtime", "1", "-prio_speed", "1", "-profile:v", "high"].iter().map(|s| s.to_string()));
    } else if encoder == "libx264" {
        a.extend(["-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline"].iter().map(|s| s.to_string()));
    }
    a.extend(["-b:v", &br, "-maxrate", &br, "-bufsize", &buf, "-g", &gop, "-bf", "0", "-bsf:v", "dump_extra=freq=keyframe", "-f", "h264", "-"].iter().map(|s| s.to_string()));
    a
}

/// ffmpeg → access units → frames. Returns Err(reason) when it could not produce any video.
async fn run_video(id: u32, v: VideoOpts) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let ffmpeg = ffmpeg_path().ok_or_else(|| "ffmpeg가 없습니다 (brew install ffmpeg / winget install ffmpeg) — JPEG 화면으로 대신합니다".to_string())?;
    let args = { let f = ffmpeg.clone(); let v2 = VideoOpts { codec: v.codec, ..v }; tokio::task::spawn_blocking(move || ffmpeg_args(&f, &v2)).await.map_err(|e| e.to_string())? };
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    if let Some(path) = crate::exec::user_path() {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg 실행 실패: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("ffmpeg stdout 없음")?;
    let mut stderr = child.stderr.take().ok_or("ffmpeg stderr 없음")?;
    let err_tail = tokio::spawn(async move { let mut s = String::new(); let _ = stderr.read_to_string(&mut s).await; s.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>() });
    let kind = if v.codec == "vp8" { KIND_VP8 } else { KIND_H264 };
    let mut h264 = video::AnnexB::default();
    let mut ivf = video::Ivf::default();
    let mut buf = vec![0u8; 256 * 1024];
    let mut frames = 0u64;
    loop {
        let n = match stdout.read(&mut buf).await { Ok(0) | Err(_) => break, Ok(n) => n };
        let units = if kind == KIND_VP8 { ivf.push(&buf[..n]) } else { h264.push(&buf[..n]) };
        for (data, key) in units {
            if frames == 0 {
                notify_format(id, if kind == KIND_VP8 { "vp8" } else { "h264" }, None).await;
            }
            frames += 1;
            if !send_frame(id, tagged(kind, key, &data)).await {
                return Ok(());
            }
        }
    }
    let _ = child.wait().await;
    let tail = err_tail.await.unwrap_or_default();
    if frames == 0 {
        let hint = if cfg!(target_os = "macos") { " — 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록에서 러너를 실행하는 앱을 허용하세요" } else { "" };
        return Err(format!("ffmpeg가 화면을 가져오지 못했습니다{hint}: {}", tail.trim()));
    }
    Err(format!("ffmpeg가 멈췄습니다: {}", tail.trim()))
}

async fn run_jpeg(id: u32, o: Opts, fps: f64) {
    let period = Duration::from_secs_f64(1.0 / fps);
    let mut last: Option<u64> = None;
    let mut failures = 0;
    loop {
        let t0 = Instant::now();
        match capture_async(o).await {
            Ok((jpeg, _, _)) => {
                failures = 0;
                let fp = fingerprint(&jpeg);
                if last != Some(fp) {
                    last = Some(fp);
                    if !send_frame(id, tagged(KIND_JPEG, true, &jpeg)).await {
                        break;
                    }
                }
            }
            Err(e) => {
                failures += 1;
                notify(id, &e).await;
                if failures >= 3 {
                    break;
                }
            }
        }
        tokio::time::sleep(period.saturating_sub(t0.elapsed())).await;
    }
}

fn start(params: &Value) -> RpcResult {
    let id = params.get("streamId").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "streamId 필요".to_string()))?;
    let video = params.get("mode").and_then(Value::as_str) != Some("jpeg");
    let o = opts(params);
    let mut g = hub().lock().unwrap();
    if g.streams.contains_key(&id) {
        return Err((-32602, format!("stream {id} 이미 사용 중")));
    }
    g.streams.retain(|_, t| !t.is_finished());
    if g.streams.len() >= MAX_STREAMS {
        return Err((-32006, format!("동시 화면 스트림은 최대 {MAX_STREAMS}개입니다")));
    }
    let codec: &'static str = if params.get("codec").and_then(Value::as_str) == Some("vp8") { "vp8" } else { "h264" };
    let task = if video {
        let fps = params.get("fps").and_then(Value::as_f64).unwrap_or(30.0).clamp(5.0, 60.0) as u32;
        let bitrate = params.get("bitrate").and_then(Value::as_u64).unwrap_or(4000).clamp(500, 20000) as u32;
        let v = VideoOpts { display: o.display, fps, max_width: o.max_width, bitrate_kbps: bitrate, codec };
        tokio::spawn(async move {
            if let Err(reason) = run_video(id, v).await {
                // no video from ffmpeg: say why and carry on with JPEG frames
                notify_format(id, "jpeg", Some(reason)).await;
                run_jpeg(id, o, 2.0).await;
            }
            hub().lock().unwrap().streams.remove(&id);
        })
    } else {
        let fps = params.get("fps").and_then(Value::as_f64).unwrap_or(2.0).clamp(0.2, 10.0);
        tokio::spawn(async move {
            notify_format(id, "jpeg", None).await;
            run_jpeg(id, o, fps).await;
            hub().lock().unwrap().streams.remove(&id);
        })
    };
    g.streams.insert(id, task);
    Ok(json!({ "streamId": id, "mode": if video { "video" } else { "jpeg" }, "codec": if video { codec } else { "jpeg" }, "display": o.display, "maxWidth": o.max_width }))
}

/// JSON-RPC entry point for `screen.*`; None when the method is not a screen method.
pub async fn rpc(cfg: &Config, method: &str, params: &Value) -> Option<RpcResult> {
    if !method.starts_with("screen.") {
        return None;
    }
    if !cfg.screen_consent {
        return Some(Err((-32030, NO_CONSENT.into())));
    }
    Some(match method {
        "screen.list" => {
            let list = tokio::task::spawn_blocking(displays).await.unwrap_or_else(|_| json!([]));
            Ok(json!({ "displays": list }))
        }
        "screen.shot" => {
            let t0 = Instant::now();
            match capture_async(opts(params)).await {
                Ok((jpeg, w, h)) => Ok(json!({ "b64": base64::engine::general_purpose::STANDARD.encode(&jpeg), "mime": "image/jpeg", "width": w, "height": h, "bytes": jpeg.len(), "ms": t0.elapsed().as_millis() as u64 })),
                Err(e) => Err((-32031, e)),
            }
        }
        "screen.start" => start(params),
        "screen.stop" => {
            let id = params.get("streamId").and_then(Value::as_u64).map(|v| v as u32);
            match id {
                Some(id) => {
                    let task = hub().lock().unwrap().streams.remove(&id);
                    if let Some(t) = &task {
                        t.abort();
                    }
                    Ok(json!({ "ok": task.is_some() }))
                }
                None => Err((-32602, "streamId 필요".to_string())),
            }
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_png(path: &str, shade: u8) {
        let img = image::RgbImage::from_fn(1600, 900, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, shade]));
        img.save(path).unwrap();
    }

    #[tokio::test]
    async fn consent_shot_scale_and_stream_only_on_change() {
        let cfg_off = Config::default();
        assert_eq!(rpc(&cfg_off, "screen.shot", &json!({})).await.unwrap().unwrap_err().0, -32030);
        assert!(rpc(&cfg_off, "exec.start", &json!({})).await.is_none());

        let src = std::env::temp_dir().join(format!("aidev-screen-src-{}.png", std::process::id()));
        test_png(src.to_str().unwrap(), 10);
        std::env::set_var("AIDEV_SCREEN_CMD", format!("cp {} {{out}}", src.display()));
        let cfg = Config { screen_consent: true, ..Default::default() };
        let r = rpc(&cfg, "screen.shot", &json!({ "maxWidth": 800 })).await.unwrap().unwrap();
        assert_eq!(r["width"], 800);
        assert_eq!(r["height"], 450);
        let jpeg = base64::engine::general_purpose::STANDARD.decode(r["b64"].as_str().unwrap()).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        assert_eq!(rpc(&cfg, "screen.list", &json!({})).await.unwrap().unwrap()["displays"][0]["id"], 1);

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Message>(16);
        attach(tx);
        rpc(&cfg, "screen.start", &json!({ "streamId": 5, "mode": "jpeg", "fps": 10, "maxWidth": 640 })).await.unwrap().unwrap();
        let Some(Message::Text(fmt)) = rx.recv().await else { panic!("no format note") };
        assert!(fmt.contains("screen.format") && fmt.contains("\"jpeg\""));
        let Some(Message::Binary(first)) = rx.recv().await else { panic!("no frame") };
        assert_eq!(&first[..4], &5u32.to_be_bytes());
        assert_eq!(&first[4..8], &[KIND_JPEG, 1, 0xFF, 0xD8]);
        // unchanged screen → no second frame
        assert!(tokio::time::timeout(Duration::from_millis(600), rx.recv()).await.is_err());
        // the picture changes → a new frame
        test_png(src.to_str().unwrap(), 200);
        let Some(Message::Binary(second)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap() else { panic!("no change frame") };
        assert_ne!(first, second);
        assert_eq!(rpc(&cfg, "screen.stop", &json!({ "streamId": 5 })).await.unwrap().unwrap()["ok"], true);

        // a failing capture tool reports screen.error and the stream ends after 3 tries
        std::env::set_var("AIDEV_SCREEN_CMD", "exit 7");
        rpc(&cfg, "screen.start", &json!({ "streamId": 6, "mode": "jpeg", "fps": 10 })).await.unwrap().unwrap();
        let _format = rx.recv().await;
        let Some(Message::Text(t)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap() else { panic!("no error note") };
        assert!(t.contains("screen.error") && t.contains("\"streamId\":6"));
        rpc(&cfg, "screen.stop", &json!({ "streamId": 6 })).await.unwrap().unwrap();
        std::env::remove_var("AIDEV_SCREEN_CMD");
        let _ = std::fs::remove_file(src);

        // video: ffmpeg (test pattern instead of the display) → H.264 access units, first one a keyframe with SPS
        if which("ffmpeg") {
            std::env::set_var("AIDEV_SCREEN_FFMPEG_INPUT", "-f lavfi -i testsrc2=size=640x360:rate={fps}");
            std::env::set_var("AIDEV_SCREEN_ENCODER", "libx264");
            while tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_ok() {}
            let r = rpc(&cfg, "screen.start", &json!({ "streamId": 7, "fps": 30, "maxWidth": 640 })).await.unwrap().unwrap();
            assert_eq!(r["codec"], "h264");
            let Some(Message::Text(fmt)) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() else { panic!("no format") };
            assert!(fmt.contains("\"h264\""), "{fmt}");
            let mut keys = 0; let mut deltas = 0;
            for i in 0..40 {
                let Some(Message::Binary(f)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap() else { panic!("no video frame") };
                assert_eq!(&f[..4], &7u32.to_be_bytes());
                assert_eq!(f[4], KIND_H264);
                if i == 0 { assert_eq!(f[5], 1, "starts with a keyframe"); assert_eq!(&f[6..11], &[0, 0, 0, 1, 0x67], "SPS first"); }
                if f[5] == 1 { keys += 1 } else { deltas += 1 }
            }
            assert!(keys >= 1 && deltas >= 30, "keys {keys} deltas {deltas}");
            rpc(&cfg, "screen.stop", &json!({ "streamId": 7 })).await.unwrap().unwrap();
            // VP8 in IVF
            while tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_ok() {}
            rpc(&cfg, "screen.start", &json!({ "streamId": 8, "fps": 30, "codec": "vp8", "maxWidth": 640 })).await.unwrap().unwrap();
            let Some(Message::Text(fmt)) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() else { panic!("no format") };
            assert!(fmt.contains("\"vp8\""), "{fmt}");
            let Some(Message::Binary(f)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap() else { panic!("no vp8 frame") };
            assert_eq!((f[4], f[5]), (KIND_VP8, 1));
            rpc(&cfg, "screen.stop", &json!({ "streamId": 8 })).await.unwrap().unwrap();
            // a broken capture input → falls back to JPEG with the reason
            std::env::set_var("AIDEV_SCREEN_FFMPEG_INPUT", "-f lavfi -i nosuchsource");
            std::env::set_var("AIDEV_SCREEN_CMD", "exit 9");
            while tokio::time::timeout(Duration::from_millis(200), rx.recv()).await.is_ok() {}
            rpc(&cfg, "screen.start", &json!({ "streamId": 9 })).await.unwrap().unwrap();
            let Some(Message::Text(fmt)) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() else { panic!("no fallback") };
            assert!(fmt.contains("\"jpeg\"") && fmt.contains("ffmpeg"), "{fmt}");
            rpc(&cfg, "screen.stop", &json!({ "streamId": 9 })).await.unwrap().unwrap();
            for k in ["AIDEV_SCREEN_FFMPEG_INPUT", "AIDEV_SCREEN_ENCODER", "AIDEV_SCREEN_CMD"] { std::env::remove_var(k); }
        }
        detach();
    }
}
