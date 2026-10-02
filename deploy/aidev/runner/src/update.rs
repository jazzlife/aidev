//! Updates (2026-10-02, "업데이트 메뉴 … 최신 버전과 이전 버전들을 선택해서 업데이트"): the versions the gateway offers
//! (`/_runner/versions`: the one the platform ships and the earlier releases, newest first), and installing the chosen
//! one into ~/.aidev/bin — from `aidev-runner update` or the status icon's 업데이트.
//! Installing: download and check its SHA-256, make sure it runs here (`--version`; macOS: this Mac's signature, so
//! Screen Recording / Accessibility stay granted), then stop this PC's runners (`control::updating`: they drop their
//! connection and commands, as for 정지), replace the file (the previous one kept as aidev-runner.prev), and let them
//! go: each starts again from the new file with its own arguments (`control::restart_self`) — the service
//! registrations, the elevated token, the desktop session, the pairing and the settings stay as they were.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const CURRENT: &str = env!("CARGO_PKG_VERSION");
/// The first version with `update` and the menu: below it, updating again takes the install script.
const FIRST_SELF_UPDATE: &str = "0.14.0";

#[derive(Deserialize, Clone, Debug)]
pub struct Version {
    pub version: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Deserialize)]
struct List {
    versions: Vec<Version>,
}

/// This PC's file names on the gateway, in order of preference.
fn platforms() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "win-x64",
        ("windows", "aarch64") => "win-arm64",
        ("macos", "aarch64") => "mac-arm64,mac-universal",
        ("macos", "x86_64") => "mac-x64,mac-universal",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "arm") => "linux-armv7",
        _ => "",
    }
}

pub fn cmp(a: &str, b: &str) -> Ordering {
    let parts = |s: &str| s.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a).cmp(&parts(b))
}

/// The versions offered for this PC, newest first.
pub fn versions(gateway: &str) -> Result<Vec<Version>, String> {
    let base = gateway.trim_end_matches('/');
    let list: List = ureq::get(&format!("{base}/_runner/versions"))
        .query("platform", platforms())
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| format!("버전 목록을 받지 못했습니다: {e}"))?
        .into_json()
        .map_err(|e| format!("버전 목록을 읽지 못했습니다: {e}"))?;
    let mut list: Vec<Version> = list
        .versions
        .into_iter()
        .filter(|v| v.sha256.len() == 64 && !v.url.is_empty() && v.version.split('.').count() == 3)
        .map(|mut v| {
            if v.url.starts_with('/') {
                v.url = format!("{base}{}", v.url);
            }
            v
        })
        .collect();
    list.sort_by(|a, b| cmp(&b.version, &a.version));
    Ok(list)
}

/// The newest offered version, when it is newer than this runner.
pub fn newer(list: &[Version]) -> Option<&Version> {
    list.first().filter(|v| cmp(&v.version, CURRENT) == Ordering::Greater)
}

/// A version as the lists show it: "0.14.1 (최신)", "0.14.0 (현재)" …
pub fn label(v: &Version, newest: &str) -> String {
    let mut tags = Vec::new();
    if v.version == newest {
        tags.push("최신");
    }
    if v.version == CURRENT {
        tags.push("현재");
    }
    if cmp(&v.version, FIRST_SELF_UPDATE) == Ordering::Less {
        tags.push("이후 업데이트는 설치 스크립트로");
    }
    let date = v.date.as_deref().map(|d| format!("  {}", d.get(..10).unwrap_or(d))).unwrap_or_default();
    if tags.is_empty() { format!("{}{date}", v.version) } else { format!("{} ({}){date}", v.version, tags.join(", ")) }
}

fn download(v: &Version, to: &Path) -> Result<(), String> {
    let resp = ureq::get(&v.url).timeout(Duration::from_secs(900)).call().map_err(|e| format!("{} 받기 실패: {e}", v.version))?;
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(to).map_err(|e| format!("{}: {e}", to.display()))?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("{} 받기 실패: {e}", v.version))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| format!("{}: {e}", to.display()))?;
    }
    drop(file);
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if !got.eq_ignore_ascii_case(&v.sha256) {
        let _ = std::fs::remove_file(to);
        return Err(format!("{}: SHA-256이 맞지 않습니다 — 받은 파일을 버렸습니다", v.version));
    }
    Ok(())
}

/// The downloaded file, ready to run here: executable, (macOS) not quarantined and signed with this Mac's identity,
/// and answering `--version` with the version chosen.
fn prepare(v: &Version, file: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    if let Err(why) = crate::service::sign_for_this_mac(file) {
        eprintln!("! 이 Mac의 고정 서명을 입히지 못했습니다 — macOS가 화면 기록 권한을 다시 물을 수 있습니다: {why}");
    }
    use crate::proc_util::NoWindow;
    let out = std::process::Command::new(file).arg("--version").no_window().output().map_err(|e| format!("받은 러너를 실행하지 못했습니다: {e}"))?;
    let said = String::from_utf8_lossy(&out.stdout);
    if !said.split_whitespace().any(|w| w == v.version) {
        return Err(format!("받은 러너가 {} 이라고 답하지 않습니다 ({})", v.version, said.trim()));
    }
    Ok(())
}

/// Every runner of this PC stopped (the connection lock is free) — or why not.
fn wait_stopped(limit: Duration) -> Option<crate::config::InstanceLock> {
    let deadline = Instant::now() + limit;
    loop {
        if let Ok(lock) = crate::config::lock_instance() {
            return Some(lock);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// A runner that does not know the update file (older than 0.14.0) keeps its connection: stop it the hard way — its
/// service manager starts it again, from the new file.
fn stop_older_runners() {
    #[cfg(unix)]
    if let Some(pid) = std::fs::read_to_string(crate::config::dir().join("runner.lock")).ok().and_then(|s| s.trim().parse::<i32>().ok()) {
        if pid > 1 && pid as u32 != std::process::id() {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    #[cfg(windows)]
    {
        use crate::proc_util::NoWindow;
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='aidev-runner.exe'\" | Where-Object {{ $_.ProcessId -ne {} -and $_.CommandLine -match ' start( |$)' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
            std::process::id()
        );
        let _ = std::process::Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &crate::exec::powershell_encoded(&script)])
            .stdin(std::process::Stdio::null())
            .no_window()
            .status();
    }
}

fn prev_path(target: &Path) -> PathBuf {
    target.with_file_name(if cfg!(windows) { "aidev-runner.prev.exe" } else { "aidev-runner.prev" })
}

/// The new file in place of the installed one; the installed one kept as aidev-runner.prev.
pub(crate) fn swap(new: &Path, target: &Path) -> Result<(), String> {
    let prev = prev_path(target);
    #[cfg(unix)]
    {
        if target.exists() {
            let _ = std::fs::copy(target, &prev);
        }
        std::fs::rename(new, target).map_err(|e| format!("{}: {e}", target.display()))
    }
    #[cfg(windows)]
    {
        // a running .exe cannot be overwritten, but it can be renamed
        let _ = std::fs::remove_file(&prev);
        let prev = if prev.exists() { target.with_file_name(format!("aidev-runner.prev-{}.exe", std::process::id())) } else { prev };
        if target.exists() {
            std::fs::rename(target, &prev).map_err(|e| format!("{}: {e}", target.display()))?;
        }
        std::fs::rename(new, target).map_err(|e| {
            let _ = std::fs::rename(&prev, target);
            format!("{}: {e}", target.display())
        })
    }
}

/// Holds the update file while it exists; removing it lets the runners start again.
struct Stopping;

impl Stopping {
    fn begin() -> Result<Self, String> {
        std::fs::create_dir_all(crate::config::dir()).map_err(|e| e.to_string())?;
        std::fs::write(crate::control::updating_path(), format!("{}\n", std::process::id())).map_err(|e| e.to_string())?;
        Ok(Stopping)
    }
}

impl Drop for Stopping {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(crate::control::updating_path());
    }
}

/// Installs `v` into ~/.aidev/bin (see the module notes); `step` hears each stage.
pub fn install(v: &Version, step: &dyn Fn(&str)) -> Result<String, String> {
    let target = crate::service::installed_path();
    let dir = target.parent().ok_or("설치 폴더를 알 수 없습니다")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let new = dir.join(if cfg!(windows) { "aidev-runner.download.exe" } else { "aidev-runner.download" });
    step(&format!("{} 받는 중…", v.version));
    download(v, &new)?;
    if let Err(e) = prepare(v, &new) {
        let _ = std::fs::remove_file(&new);
        return Err(e);
    }
    step("이 PC의 러너를 멈추는 중…");
    let stopping = Stopping::begin()?;
    let mut held = wait_stopped(Duration::from_secs(30));
    if held.is_none() {
        stop_older_runners();
        held = wait_stopped(Duration::from_secs(15));
    }
    let Some(lock) = held else {
        drop(stopping);
        let _ = std::fs::remove_file(&new);
        return Err("러너가 멈추지 않아 교체하지 못했습니다 — 상태 아이콘의 \"종료\"(또는 작업 관리자/kill)로 끈 뒤 다시 하세요".into());
    };
    step("교체하는 중…");
    let swapped = swap(&new, &target);
    drop(lock);
    drop(stopping);   // the runners start again — from the new file, or (the swap failed) from the old one
    if let Err(e) = swapped {
        let _ = std::fs::remove_file(&new);
        return Err(format!("교체하지 못했습니다: {e}"));
    }
    Ok(format!("{} 설치 완료 ({}) — 이 PC의 러너가 새 버전으로 다시 시작합니다 (이전 파일: {})", v.version, target.display(), prev_path(&target).display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert_eq!(cmp("0.14.0", "0.13.10"), Ordering::Greater);
        assert_eq!(cmp("0.13.5", "0.13.5"), Ordering::Equal);
        assert_eq!(cmp("0.9.9", "0.10.0"), Ordering::Less);
    }

    #[test]
    fn labels_mark_newest_current_and_old() {
        let v = |s: &str| Version { version: s.into(), url: "u".into(), sha256: "0".repeat(64), date: Some("2026-10-02T05:32:44Z".into()) };
        assert_eq!(label(&v("9.9.9"), "9.9.9"), "9.9.9 (최신)  2026-10-02");
        assert!(label(&v(CURRENT), "9.9.9").contains("현재"));
        assert!(label(&v("0.13.5"), "9.9.9").contains("설치 스크립트"));
    }
}
