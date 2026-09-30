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

use serde_json::Value;
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
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(path) = crate::exec::user_path() {
        cmd.env("PATH", path);
    }
    let child = cmd.spawn().map_err(|e| format!("{}: {e}", argv[0]))?;
    let (tx, rx) = std::sync::mpsc::channel();
    let pid = child.id();
    std::thread::spawn(move || { let _ = tx.send(child.wait_with_output()); });
    match rx.recv_timeout(limit) {
        Ok(Ok(out)) if out.status.success() => Ok(text(&out)),
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

/// adb: PATH, $ANDROID_HOME / $ANDROID_SDK_ROOT, then the Android Studio default SDK folder.
pub fn adb() -> Option<PathBuf> {
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
}
