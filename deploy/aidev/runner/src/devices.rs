//! Attached devices (F-10): `device.list` / `device.shot` for phones, TVs and simulators — see below.
//! Device bridges for debugging (F-09e): getting a program on an attached phone or simulator into a state a
//! debug adapter on this PC can attach to. Used by dap.rs `dap.start{android|iosSim}`.
//!
//!   android {package, activity?, serial?, attach?}  Java/Kotlin apps (debuggable builds) over JDWP:
//!       launch: am force-stop → am set-debug-app -w (the app waits for a debugger) → start it (the activity,
//!       or its launcher entry through monkey) → pidof → adb forward tcp:<port> jdwp:<pid>
//!       attach: pidof the running app → forward.         → {debugPort, pid}; undone when the session ends
//!   iosSim {bundleId, device?}   an app in the iOS Simulator (macOS): simctl launch --wait-for-debugger
//!       → {pid} for lldb-dap / codelldb to attach to
//!
//! Every command runs with a time limit; its output is part of the error when a step fails.

use crate::proc_util::NoWindow;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct Prepared {
    pub debug_port: Option<u16>,
    pub pid: Option<u32>,
    /// commands that undo the setup (adb forward --remove …), run when the debug session ends
    pub cleanup: Vec<Vec<String>>,
    pub note: String,
}

fn text(o: &std::process::Output) -> String {
    let mut s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
    if !e.is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(&e);
    }
    s.chars().take(1500).collect()
}

/// Runs argv with a time limit; Ok(output text) when it exited 0.
pub fn run(argv: &[String], limit: Duration) -> Result<String, String> {
    run_output(argv, limit).map(|o| text(&o))
}

/// Like run(), but the raw stdout (an image a device tool writes to its standard output).
pub fn run_bytes(argv: &[String], limit: Duration) -> Result<Vec<u8>, String> {
    run_output(argv, limit).map(|o| o.stdout)
}

fn run_output(argv: &[String], limit: Duration) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(&argv[0]);
    cmd.no_window().args(&argv[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(path) = crate::exec::user_path() {
        cmd.env("PATH", path);
    }
    let child = cmd.spawn().map_err(|e| format!("{}: {e}", argv[0]))?;
    let (tx, rx) = std::sync::mpsc::channel();
    let pid = child.id();
    std::thread::spawn(move || { let _ = tx.send(child.wait_with_output()); });
    match rx.recv_timeout(limit) {
        Ok(Ok(out)) if out.status.success() => Ok(out),
        Ok(Ok(out)) => Err(format!("{} → {}: {}", argv.join(" "), out.status, text(&out))),
        Ok(Err(e)) => Err(format!("{}: {e}", argv[0])),
        Err(_) => {
            #[cfg(unix)]
            unsafe { libc::kill(pid as i32, libc::SIGKILL); }
            #[cfg(not(unix))]
            let _ = pid;
            Err(format!("{}: {}초 안에 끝나지 않았습니다", argv.join(" "), limit.as_secs()))
        }
    }
}

/// adb: $AIDEV_ADB, PATH, $ANDROID_HOME / $ANDROID_SDK_ROOT, then the Android Studio default SDK folder.
pub fn adb() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("AIDEV_ADB").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    if let Some(p) = crate::dap_adapters::which("adb") {
        return Some(p);
    }
    let exe = if cfg!(windows) { "adb.exe" } else { "adb" };
    let mut roots: Vec<PathBuf> = ["ANDROID_HOME", "ANDROID_SDK_ROOT"].iter().filter_map(|k| std::env::var_os(k).map(PathBuf::from)).collect();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from) {
        roots.push(home.join("Library/Android/sdk"));
        roots.push(home.join("Android/Sdk"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(Path::new(&local).join("Android").join("Sdk"));
    }
    roots.into_iter().map(|r| r.join("platform-tools").join(exe)).find(|p| p.is_file())
}

/// sdb (Tizen): $AIDEV_SDB, PATH, then the Tizen Studio / VS Code Tizen extension folders.
pub fn sdb() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("AIDEV_SDB").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    if let Some(p) = crate::dap_adapters::which("sdb") {
        return Some(p);
    }
    let exe = if cfg!(windows) { "sdb.exe" } else { "sdb" };
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)?;
    let mut dirs = vec![home.join("tizen-studio/tools"), home.join(".tizen-extension-platform/server/sdktools/data/tools")];
    if cfg!(windows) {
        dirs.push(PathBuf::from(r"C:\tizen-studio\tools"));
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

// ---- device.list / device.shot (F-10): attached phones, TVs, watches and simulators -------------------------
//   device.list → {devices:[{tool: adb|sdb|sim, serial, state, name}], errors:{tool: message}}
//   device.shot {tool?, serial?, maxWidth?, quality?} → {b64 (JPEG), width, height, device}  (screen consent)
// Without serial the only device (of that tool) is used. adb: `exec-out screencap -p`; sim (macOS):
// `simctl io <udid> screenshot`; sdb: `enlightenment_info -dump_screen` on the device, then `sdb pull`.

type RpcResult = Result<Value, (i64, String)>;

fn valid_serial(s: &str) -> bool {
    !s.is_empty() && s.len() <= 120 && s.chars().all(|c| c.is_ascii_alphanumeric() || ".:-_".contains(c))
}

/// `adb devices -l`: "SERIAL state usb:… product:… model:Pixel_7 device:… transport_id:1"
fn parse_adb(out: &str) -> Vec<Value> {
    out.lines()
        .filter(|l| !l.starts_with("List of devices") && !l.starts_with('*'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next()?;
            let state = parts.next()?;
            let rest: Vec<&str> = parts.collect();
            let field = |k: &str| rest.iter().find_map(|p| p.strip_prefix(k)).map(|v| v.replace('_', " "));
            let name = field("model:").or_else(|| field("product:")).unwrap_or_else(|| serial.to_string());
            Some(json!({ "tool": "adb", "serial": serial, "state": state, "name": name }))
        })
        .collect()
}

/// `sdb devices`: "SERIAL   state   name" (name may contain spaces)
fn parse_sdb(out: &str) -> Vec<Value> {
    out.lines()
        .filter(|l| !l.starts_with("List of devices") && !l.starts_with('*'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next()?;
            let state = parts.next()?;
            let name = parts.collect::<Vec<_>>().join(" ");
            Some(json!({ "tool": "sdb", "serial": serial, "state": state, "name": if name.is_empty() { serial.to_string() } else { name } }))
        })
        .collect()
}

/// `simctl list devices booted -j`: {"devices": {"<runtime id>": [{udid, name, state}]}}
fn parse_sims(out: &str) -> Vec<Value> {
    let v: Value = serde_json::from_str(out).unwrap_or(Value::Null);
    let mut list = Vec::new();
    if let Some(runtimes) = v.get("devices").and_then(Value::as_object) {
        for (runtime, devs) in runtimes {
            let os = runtime.rsplit('.').next().unwrap_or(runtime).replacen('-', " ", 1).replace('-', ".");
            for d in devs.as_array().into_iter().flatten().filter(|d| d.get("state").and_then(Value::as_str) == Some("Booted")) {
                let udid = d.get("udid").and_then(Value::as_str).unwrap_or_default();
                let name = d.get("name").and_then(Value::as_str).unwrap_or(udid);
                list.push(json!({ "tool": "sim", "serial": udid, "state": "device", "name": format!("{name} ({os})") }));
            }
        }
    }
    list
}

fn xcrun() -> Option<String> {
    if !cfg!(target_os = "macos") && std::env::var_os("AIDEV_FAKE_XCRUN").is_none() {
        return None;
    }
    crate::dap_adapters::which("xcrun").map(|p| p.display().to_string())
}

pub fn list() -> Value {
    let t = Duration::from_secs(10);
    let mut devices = Vec::new();
    let mut errors = serde_json::Map::new();
    if let Some(adb) = adb() {
        match run(&[adb.display().to_string(), "devices".into(), "-l".into()], t) {
            Ok(out) => devices.extend(parse_adb(&out)),
            Err(e) => { errors.insert("adb".into(), json!(e)); }
        }
    }
    if let Some(sdb) = sdb() {
        match run(&[sdb.display().to_string(), "devices".into()], t) {
            Ok(out) => devices.extend(parse_sdb(&out)),
            Err(e) => { errors.insert("sdb".into(), json!(e)); }
        }
    }
    if let Some(x) = xcrun() {
        match run(&[x, "simctl".into(), "list".into(), "devices".into(), "booted".into(), "-j".into()], t) {
            Ok(out) => devices.extend(parse_sims(&out)),
            Err(e) => { errors.insert("sim".into(), json!(e)); }
        }
    }
    json!({ "devices": devices, "errors": errors, "tools": { "adb": adb().is_some(), "sdb": sdb().is_some(), "sim": xcrun().is_some() } })
}

/// Which device: the given tool/serial, or the only usable one.
fn pick(p: &Value) -> Result<(String, String, String), (i64, String)> {
    let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let tool = s("tool");
    if tool.is_some_and(|t| !["adb", "sdb", "sim"].contains(&t)) {
        return Err((-32602, "tool은 adb, sdb, sim 중 하나입니다".into()));
    }
    if s("serial").is_some_and(|v| !valid_serial(v)) {
        return Err((-32602, "serial이 올바르지 않습니다".into()));
    }
    let all = list();
    let usable: Vec<&Value> = all["devices"].as_array().into_iter().flatten()
        .filter(|d| d["state"] == "device" && tool.is_none_or(|t| d["tool"] == t) && s("serial").is_none_or(|v| d["serial"] == v))
        .collect();
    match usable.as_slice() {
        [d] => Ok((d["tool"].as_str().unwrap_or_default().into(), d["serial"].as_str().unwrap_or_default().into(), d["name"].as_str().unwrap_or_default().into())),
        [] => Err((-32033, match s("serial") {
            Some(v) => format!("연결된 기기 중 {v}가 없습니다 (USB 디버깅 허용·에뮬레이터 실행 상태를 확인하세요)"),
            None => "연결된 기기가 없습니다 (adb devices / sdb devices / 부팅된 iOS 시뮬레이터)".into(),
        })),
        many => Err((-32034, format!("기기가 여러 대입니다 — serial을 지정하세요: {}", many.iter().map(|d| format!("{} {} ({})", d["tool"].as_str().unwrap_or(""), d["serial"].as_str().unwrap_or(""), d["name"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", ")))),
    }
}

/// PNG bytes of the device's screen.
fn capture(tool: &str, serial: &str) -> Result<Vec<u8>, String> {
    let t = Duration::from_secs(30);
    let tmp = std::env::temp_dir().join(format!("aidev-device-{}-{}.png", std::process::id(), rand::random::<u32>()));
    let from_file = |argv: Vec<String>| -> Result<Vec<u8>, String> {
        let r = run(&argv, t).and_then(|_| std::fs::read(&tmp).map_err(|e| format!("스크린샷 파일을 읽지 못했습니다: {e}")));
        let _ = std::fs::remove_file(&tmp);
        r
    };
    match tool {
        "adb" => {
            let adb = adb().ok_or("adb를 찾지 못했습니다")?.display().to_string();
            run_bytes(&[adb, "-s".into(), serial.into(), "exec-out".into(), "screencap".into(), "-p".into()], t)
        }
        "sim" => {
            let x = xcrun().ok_or("xcrun이 없습니다 (Xcode 설치 필요)")?;
            from_file(vec![x, "simctl".into(), "io".into(), serial.into(), "screenshot".into(), "--type=png".into(), tmp.display().to_string()])
        }
        _ => {
            let sdb = sdb().ok_or("sdb를 찾지 못했습니다 (Tizen Studio)")?.display().to_string();
            let remote = "/tmp/aidev-shot.png";
            let sh = |args: &[&str]| -> Vec<String> { [sdb.as_str(), "-s", serial].iter().chain(args).map(|a| a.to_string()).collect() };
            let dumped = run(&sh(&["shell", "enlightenment_info", "-dump_screen", "-p", "/tmp", "-n", "aidev-shot.png"]), t)?;
            let r = from_file(sh(&["pull", remote, &tmp.display().to_string()])).map_err(|e| format!("Tizen 화면 덤프를 가져오지 못했습니다 ({dumped}): {e}"));
            let _ = run(&sh(&["shell", "rm", "-f", remote]), t);
            r
        }
    }
}

fn shot(p: &Value) -> RpcResult {
    let (tool, serial, name) = pick(p)?;
    let max_width = p.get("maxWidth").and_then(Value::as_u64).unwrap_or(1080).clamp(240, 2160) as u32;
    let quality = p.get("quality").and_then(Value::as_u64).unwrap_or(70).clamp(30, 90) as u8;
    let t0 = Instant::now();
    let png = capture(&tool, &serial).map_err(|e| (-32031, e))?;
    let img = image::load_from_memory(&png).map_err(|e| (-32031, format!("기기 화면을 읽지 못했습니다({} bytes): {e}", png.len())))?.to_rgba8();
    let frame = crate::appwin::Frame { width: img.width(), height: img.height(), rgba: img.into_raw() };
    let (rgba, w, h) = crate::encoder::fit(frame, max_width);
    let j = crate::screen::jpeg(&rgba, w, h, quality).map_err(|e| (-32031, e))?;
    use base64::Engine as _;
    Ok(json!({ "b64": base64::engine::general_purpose::STANDARD.encode(&j), "mime": "image/jpeg", "width": w, "height": h, "bytes": j.len(), "ms": t0.elapsed().as_millis() as u64, "device": { "tool": tool, "serial": serial, "name": name } }))
}

/// JSON-RPC entry point for `device.*`; None when the method is not a device method.
pub async fn rpc(cfg: &crate::config::Config, method: &str, params: &Value) -> Option<RpcResult> {
    if !method.starts_with("device.") {
        return None;
    }
    let params = params.clone();
    Some(match method {
        "device.list" => tokio::task::spawn_blocking(|| Ok(list())).await.unwrap_or_else(|e| Err((-32000, e.to_string()))),
        "device.shot" if !cfg.screen_consent => Err((-32030, crate::screen::NO_CONSENT.into())),
        "device.shot" => tokio::task::spawn_blocking(move || shot(&params)).await.unwrap_or_else(|e| Err((-32000, e.to_string()))),
        _ => Err((-32601, format!("method not found: {method}"))),
    })
}

fn valid_app_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
}

pub fn android(p: &Value, free_port: impl Fn() -> Result<u16, String>) -> Result<Prepared, String> {
    let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let package = s("package").ok_or("android.package(앱 패키지 이름)가 필요합니다")?;
    if !valid_app_id(package) {
        return Err(format!("패키지 이름이 올바르지 않습니다: {package}"));
    }
    let activity = s("activity");
    if activity.is_some_and(|a| !a.chars().all(|c| c.is_ascii_alphanumeric() || ".$_/".contains(c))) {
        return Err("activity 이름이 올바르지 않습니다".into());
    }
    let serial = s("serial");
    if serial.is_some_and(|v| !v.chars().all(|c| c.is_ascii_alphanumeric() || ".:-_".contains(c))) {
        return Err("serial이 올바르지 않습니다".into());
    }
    let attach = p.get("attach").and_then(Value::as_bool).unwrap_or(false);
    let adb = adb().ok_or("adb를 찾지 못했습니다 — Android SDK platform-tools를 설치하거나 ANDROID_HOME을 지정하세요")?;
    let base: Vec<String> = std::iter::once(adb.display().to_string()).chain(serial.map(|v| vec!["-s".to_string(), v.to_string()]).unwrap_or_default()).collect();
    let cmd = |args: &[&str]| -> Vec<String> { base.iter().cloned().chain(args.iter().map(|a| a.to_string())).collect() };
    let t = Duration::from_secs(20);

    let state = run(&cmd(&["get-state"]), t).map_err(|e| format!("Android 기기가 연결돼 있지 않습니다(adb devices로 확인, 여러 대면 device에 serial): {e}"))?;
    if !state.contains("device") {
        return Err(format!("Android 기기 상태가 {state}입니다 (USB 디버깅 허용 필요)"));
    }
    let pidof = || run(&cmd(&["shell", "pidof", package]), t).ok().and_then(|o| o.split_whitespace().next().and_then(|x| x.parse::<u32>().ok()));
    let mut cleanup = Vec::new();
    if !attach {
        run(&cmd(&["shell", "am", "force-stop", package]), t)?;
        run(&cmd(&["shell", "am", "set-debug-app", "-w", package]), t)?;
        cleanup.push(cmd(&["shell", "am", "clear-debug-app"]));
        let started = match activity {
            Some(a) => {
                let comp = if a.contains('/') { a.to_string() } else { format!("{package}/{a}") };
                run(&cmd(&["shell", "am", "start", "-n", &comp]), t)?
            }
            None => run(&cmd(&["shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"]), t)?,
        };
        if started.contains("Error") || started.contains("No activities found") || started.contains("aborted") {
            let _ = run(&cmd(&["shell", "am", "clear-debug-app"]), t);
            return Err(format!("앱을 시작하지 못했습니다 (설치돼 있나요? {package}): {started}"));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(if attach { 3 } else { 30 });
    let pid = loop {
        if let Some(pid) = pidof() {
            break pid;
        }
        if Instant::now() > deadline {
            for c in &cleanup { let _ = run(c, t); }
            return Err(if attach { format!("{package}이(가) 실행 중이 아닙니다") } else { format!("{package} 프로세스가 30초 안에 뜨지 않았습니다") });
        }
        std::thread::sleep(Duration::from_millis(300));
    };
    let port = free_port()?;
    let spec = format!("tcp:{port}");
    if let Err(e) = run(&cmd(&["forward", &spec, &format!("jdwp:{pid}")]), t) {
        for c in &cleanup { let _ = run(c, t); }
        return Err(format!("JDWP 연결을 열지 못했습니다 — debug(debuggable) 빌드인지 확인하세요: {e}"));
    }
    cleanup.insert(0, cmd(&["forward", "--remove", &spec]));
    Ok(Prepared { debug_port: Some(port), pid: Some(pid), cleanup, note: format!("{package} pid {pid} → 127.0.0.1:{port} (JDWP)") })
}

pub fn ios_sim(p: &Value) -> Result<Prepared, String> {
    if !cfg!(target_os = "macos") && std::env::var_os("AIDEV_FAKE_XCRUN").is_none() {
        return Err("iOS 시뮬레이터 디버깅은 Mac에서만 됩니다".into());
    }
    let s = |k: &str| p.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let bundle = s("bundleId").ok_or("iosSim.bundleId(앱 번들 ID)가 필요합니다")?;
    if !valid_app_id(bundle) {
        return Err(format!("번들 ID가 올바르지 않습니다: {bundle}"));
    }
    let device = s("device").unwrap_or("booted");
    if !device.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("device(시뮬레이터 UDID)가 올바르지 않습니다".into());
    }
    let xcrun = crate::dap_adapters::which("xcrun").ok_or("xcrun이 없습니다 (Xcode 설치 필요)")?.display().to_string();
    let argv: Vec<String> = [&xcrun, "simctl", "launch", "--wait-for-debugger", "--terminate-running-process", device, bundle].iter().map(|x| x.to_string()).collect();
    let out = run(&argv, Duration::from_secs(60)).map_err(|e| format!("시뮬레이터에서 앱을 시작하지 못했습니다 (부팅된 시뮬레이터에 설치돼 있나요?): {e}"))?;
    // "com.example.App: 12345"
    let pid = out.lines().rev().find_map(|l| l.rsplit(':').next().and_then(|x| x.trim().parse::<u32>().ok())).ok_or_else(|| format!("pid를 읽지 못했습니다: {out}"))?;
    let cleanup = vec![[&xcrun, "simctl", "terminate", device, bundle].iter().map(|x| x.to_string()).collect()];
    Ok(Prepared { debug_port: None, pid: Some(pid), cleanup, note: format!("{bundle} pid {pid} (시뮬레이터 {device}, 디버거 대기)") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_ids_and_refusals() {
        assert!(valid_app_id("com.example.my_app"));
        assert!(!valid_app_id("com.x; reboot"));
        assert!(!valid_app_id("1abc"));
        assert!(android(&json!({ "package": "com.x;rm" }), || Ok(1)).unwrap_err().contains("올바르지"));
        assert!(android(&json!({}), || Ok(1)).unwrap_err().contains("package"));
    }

    #[test]
    fn device_lists() {
        let adb = parse_adb("List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\nR58M123 unauthorized usb:1-1 transport_id:2\n\n");
        assert_eq!(adb.len(), 2);
        assert_eq!(adb[0], json!({ "tool": "adb", "serial": "emulator-5554", "state": "device", "name": "sdk gphone64 arm64" }));
        assert_eq!(adb[1]["state"], "unauthorized");
        assert_eq!(adb[1]["name"], "R58M123");
        let sdb = parse_sdb("List of devices attached \nemulator-26101         device          T-samsung-9.0-x86\n192.168.0.7:26101  offline  QE55 TV\n");
        assert_eq!(sdb[0], json!({ "tool": "sdb", "serial": "emulator-26101", "state": "device", "name": "T-samsung-9.0-x86" }));
        assert_eq!(sdb[1]["name"], "QE55 TV");
        let sims = parse_sims(r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-1":[{"udid":"BCDD25D4-4B27","name":"iPhone 17 Pro","state":"Booted"},{"udid":"X","name":"iPad","state":"Shutdown"}]}}"#);
        assert_eq!(sims, vec![json!({ "tool": "sim", "serial": "BCDD25D4-4B27", "state": "device", "name": "iPhone 17 Pro (iOS 26.1)" })]);
        assert!(valid_serial("192.168.0.7:5555") && !valid_serial("x;reboot") && !valid_serial(""));
    }

    /// Real devices: `cargo test real_device_shots -- --ignored --nocapture` with an emulator / simulator running.
    #[test]
    #[ignore]
    fn real_device_shots() {
        let all = list();
        println!("{all}");
        for d in all["devices"].as_array().unwrap().iter().filter(|d| d["state"] == "device") {
            let r = shot(&json!({ "tool": d["tool"], "serial": d["serial"] })).unwrap();
            println!("{} {} → {}x{} {} bytes {} ms", d["tool"], d["serial"], r["width"], r["height"], r["bytes"], r["ms"]);
            assert!(r["bytes"].as_u64().unwrap() > 1000);
        }
    }

    #[tokio::test]
    async fn shot_needs_consent_and_a_valid_device() {
        let cfg = crate::config::Config::default();
        assert_eq!(rpc(&cfg, "device.shot", &json!({})).await.unwrap().unwrap_err().0, -32030);
        let cfg = crate::config::Config { screen_consent: true, ..Default::default() };
        assert_eq!(rpc(&cfg, "device.shot", &json!({ "tool": "fastboot" })).await.unwrap().unwrap_err().0, -32602);
        assert_eq!(rpc(&cfg, "device.shot", &json!({ "serial": "a b" })).await.unwrap().unwrap_err().0, -32602);
        assert!(rpc(&cfg, "screen.list", &json!({})).await.is_none());
        assert!(rpc(&cfg, "device.list", &json!({})).await.unwrap().unwrap()["devices"].is_array());
    }
}
