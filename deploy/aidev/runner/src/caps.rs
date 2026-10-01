//! What this PC offers, reported to the gateway on every connect: OS, shell, tool versions, attached
//! Android/Tizen devices and the allowed folders. Probes run in parallel with a short timeout.
//! 0.12: `shells` (what exec.start's `shell` accepts here) and `admin` — whether commands run elevated
//! (Windows: an elevated logon task; Unix: root) and whether `sudo -n` works without a password.

use crate::proc_util::NoWindow;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::process::Command;

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// (name, command, args) — the first line of output is reported as the version.
const TOOLS: &[(&str, &str, &[&str])] = &[
    ("node", "node", &["--version"]),
    ("npm", "npm", &["--version"]),
    ("python", "python3", &["--version"]),
    ("java", "java", &["-version"]),
    ("go", "go", &["version"]),
    ("rustc", "rustc", &["--version"]),
    ("cargo", "cargo", &["--version"]),
    ("git", "git", &["--version"]),
    ("docker", "docker", &["--version"]),
    ("xcodebuild", "xcodebuild", &["-version"]),
    ("adb", "adb", &["version"]),
    ("sdb", "sdb", &["version"]),
    ("dotnet", "dotnet", &["--version"]),
    // debuggers (remote_console) and local agent CLIs (remote_agent)
    ("gdb", "gdb", &["--version"]),
    ("lldb", "lldb", &["--version"]),
    ("claude", "claude", &["--version"]),
    ("codex", "codex", &["--version"]),
    ("gemini", "gemini", &["--version"]),
];
/// npm-installed commands are .cmd shims on Windows: run them through cmd.exe.
#[cfg(windows)]
const NPM_SHIMS: &[&str] = &["npm", "claude", "codex", "gemini"];

async fn first_line(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true).no_window();
    #[cfg(windows)]
    {
        if NPM_SHIMS.contains(&cmd) {
            c = Command::new("cmd");
            c.args(["/C", cmd]).args(args).stdin(std::process::Stdio::null()).kill_on_drop(true).no_window();
        }
    }
    let out = tokio::time::timeout(PROBE_TIMEOUT, c.output()).await.ok()?.ok()?;
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    let line = String::from_utf8_lossy(&text).lines().map(str::trim).find(|l| !l.is_empty())?.to_string();
    Some(line.chars().take(120).collect())
}

/// `adb devices` / `sdb devices`: serials in state "device".
async fn devices(tool: &std::path::Path) -> Vec<String> {
    let Ok(Ok(out)) = tokio::time::timeout(PROBE_TIMEOUT, Command::new(tool).arg("devices").kill_on_drop(true).no_window().output()).await else {
        return vec![];
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .skip(1)
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next()?;
            (parts.next()? == "device").then(|| serial.to_string())
        })
        .collect()
}

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn IsUserAnAdmin() -> i32;
}

/// {elevated, sudo}: elevated = commands run with administrator rights (Windows elevated token / Unix root);
/// sudo (Unix) = "nopasswd" when `sudo -n true` succeeds, "password" when sudo needs one, null without sudo.
async fn admin() -> Value {
    #[cfg(windows)]
    {
        json!({ "elevated": unsafe { IsUserAnAdmin() } != 0, "sudo": null })
    }
    #[cfg(not(windows))]
    {
        let elevated = unsafe { libc::geteuid() } == 0;
        let sudo = if elevated {
            Value::Null
        } else {
            match tokio::time::timeout(PROBE_TIMEOUT, Command::new("sudo").args(["-n", "true"]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).status()).await {
                Ok(Ok(s)) if s.success() => json!("nopasswd"),
                Ok(Ok(_)) => json!("password"),
                _ => Value::Null,
            }
        };
        json!({ "elevated": elevated, "sudo": sudo })
    }
}

pub fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .or_else(|| {
            std::process::Command::new("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

pub fn shell() -> String {
    std::env::var("SHELL").or_else(|_| std::env::var("COMSPEC")).unwrap_or_else(|_| if cfg!(windows) { "cmd.exe".into() } else { "/bin/sh".into() })
}

pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    }
}

pub async fn collect(cfg: &crate::config::Config) -> Value {
    let probes = TOOLS.iter().map(|(name, cmd, args)| async move { (*name, first_line(cmd, args).await) });
    let results = futures_util::future::join_all(probes).await;
    let mut tools = serde_json::Map::new();
    for (name, version) in results {
        if let Some(v) = version {
            tools.insert(name.to_string(), json!(v));
        }
    }
    // adb/sdb in the SDK folder (not on PATH) count too: commands get that folder on their PATH
    let (adb_bin, sdb_bin) = tokio::join!(tokio::task::spawn_blocking(crate::devices::adb), tokio::task::spawn_blocking(crate::devices::sdb));
    let (adb_bin, sdb_bin) = (adb_bin.ok().flatten(), sdb_bin.ok().flatten());
    for (name, bin) in [("adb", &adb_bin), ("sdb", &sdb_bin)] {
        if let (false, Some(bin)) = (tools.contains_key(name), bin) {
            if let Some(v) = first_line(&bin.display().to_string(), &["version"]).await {
                tools.insert(name.to_string(), json!(v));
            }
        }
    }
    let (adb, sdb, admin) = tokio::join!(
        async { match &adb_bin { Some(b) => devices(b).await, None => vec![] } },
        async { match &sdb_bin { Some(b) => devices(b).await, None => vec![] } },
        admin()
    );
    json!({
        "runner": env!("CARGO_PKG_VERSION"),
        "os": platform(),
        "arch": std::env::consts::ARCH,
        "hostname": hostname(),
        "shell": shell(),
        "shells": crate::exec::available_shells(),
        "admin": admin,
        "tools": tools,
        "devices": { "adb": adb, "sdb": sdb },
        "allowed_roots": cfg.allowed_roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>(),
        "screen": cfg.screen_consent,
        "control": cfg.control_consent,
        "features": ["ping", "exec", "sync", "tunnel", "screen", "video", "input", "windows", "dev", "dap", "stdin", "device", "shell", "pull"],
        "limits": { "exec_running": crate::exec::MAX_RUNNING },
    })
}
