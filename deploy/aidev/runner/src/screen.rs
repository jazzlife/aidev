//! `screen.*` (IMPLEMENTATION-PLAN §3.12, F-07): what is on this PC's screen, view only, and only after
//! the owner ran `aidev-runner consent screen on`.
//!   screen.list → {displays:[{id, name, width?, height?}], backend}
//!   screen.shot {display?, maxWidth?, quality?} → {b64 (JPEG), width, height, bytes, ms}
//!   screen.start {streamId, display?, fps (1-10, default 2), maxWidth?, quality?} → {streamId}
//!   screen.stop {streamId}     notification screen.error {streamId, error}
//! A stream sends a binary frame `[streamId u32 BE][JPEG]` only when the picture changed (hash of the
//! scaled JPEG), at most `fps` per second (slower when capturing takes longer). Captures use the OS tool
//! — macOS `screencapture`, Windows PowerShell/System.Drawing, Linux grim / gnome-screenshot / ImageMagick
//! `import` / scrot — then scale (≤ maxWidth, default 1440) and re-encode as JPEG in-process.
//! `AIDEV_SCREEN_CMD` (tests) replaces the tool: a shell command whose `{out}` is the image file to write.

use crate::config::Config;
use crate::exec::{frame, Out};
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

fn start(params: &Value) -> RpcResult {
    let id = params.get("streamId").and_then(Value::as_u64).map(|v| v as u32).ok_or((-32602, "streamId 필요".to_string()))?;
    let fps = params.get("fps").and_then(Value::as_f64).unwrap_or(2.0).clamp(0.2, 10.0);
    let o = opts(params);
    let mut g = hub().lock().unwrap();
    if g.streams.contains_key(&id) {
        return Err((-32602, format!("stream {id} 이미 사용 중")));
    }
    g.streams.retain(|_, t| !t.is_finished());
    if g.streams.len() >= MAX_STREAMS {
        return Err((-32006, format!("동시 화면 스트림은 최대 {MAX_STREAMS}개입니다")));
    }
    let period = Duration::from_secs_f64(1.0 / fps);
    let task = tokio::spawn(async move {
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
                        let out = hub().lock().unwrap().out.clone();
                        let Some(out) = out else { break };
                        if out.send(Message::Binary(frame(id, &jpeg))).await.is_err() {
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
        hub().lock().unwrap().streams.remove(&id);
    });
    g.streams.insert(id, task);
    Ok(json!({ "streamId": id, "fps": fps, "display": o.display, "maxWidth": o.max_width }))
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
        rpc(&cfg, "screen.start", &json!({ "streamId": 5, "fps": 10, "maxWidth": 640 })).await.unwrap().unwrap();
        let Some(Message::Binary(first)) = rx.recv().await else { panic!("no frame") };
        assert_eq!(&first[..4], &5u32.to_be_bytes());
        // unchanged screen → no second frame
        assert!(tokio::time::timeout(Duration::from_millis(600), rx.recv()).await.is_err());
        // the picture changes → a new frame
        test_png(src.to_str().unwrap(), 200);
        let Some(Message::Binary(second)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap() else { panic!("no change frame") };
        assert_ne!(first, second);
        assert_eq!(rpc(&cfg, "screen.stop", &json!({ "streamId": 5 })).await.unwrap().unwrap()["ok"], true);

        // a failing capture tool reports screen.error and the stream ends after 3 tries
        std::env::set_var("AIDEV_SCREEN_CMD", "exit 7");
        rpc(&cfg, "screen.start", &json!({ "streamId": 6, "fps": 10 })).await.unwrap().unwrap();
        let Some(Message::Text(t)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await.unwrap() else { panic!("no error note") };
        assert!(t.contains("screen.error") && t.contains("\"streamId\":6"));
        detach();
        std::env::remove_var("AIDEV_SCREEN_CMD");
        let _ = std::fs::remove_file(src);
    }
}
