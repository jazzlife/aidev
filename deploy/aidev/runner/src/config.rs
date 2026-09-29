//! Runner settings in `~/.aidev/runner.toml` (0600 on Unix): where the gateway is, the target's
//! token, and which folders the platform may touch on this PC.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    /// Gateway origin, e.g. https://dev.nado.work
    pub gateway: String,
    /// Target token issued at pairing (32 random bytes, hex). Only its hash is stored server-side.
    pub token: String,
    pub target_id: u64,
    pub name: String,
    /// Folders the platform may read, write and run in. Everything else is refused.
    #[serde(default)]
    pub allowed_roots: Vec<PathBuf>,
    /// Screen capture only with explicit consent (`aidev-runner consent screen on`).
    #[serde(default)]
    pub screen_consent: bool,
    /// Remote control (mouse, keyboard from the live screen) only with explicit consent (`consent control on`).
    #[serde(default)]
    pub control_consent: bool,
    /// Pass this process's environment to commands it runs (off: only the variables a job sends).
    #[serde(default)]
    pub inherit_env: bool,
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn dir() -> PathBuf {
    std::env::var_os("AIDEV_RUNNER_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".aidev"))
}

pub fn path() -> PathBuf {
    dir().join("runner.toml")
}

/// Default workspace the platform syncs projects into (`~/aidev-work`).
pub fn default_root() -> PathBuf {
    home().join("aidev-work")
}

pub fn load() -> Result<Config, String> {
    let p = path();
    let text = std::fs::read_to_string(&p).map_err(|_| format!("설정이 없습니다: {} — 먼저 `aidev-runner pair <코드> --gateway <주소>`", p.display()))?;
    toml::from_str(&text).map_err(|e| format!("설정을 읽지 못했습니다 ({}): {e}", p.display()))
}

pub fn save(cfg: &Config) -> Result<(), String> {
    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
    let p = path();
    let text = toml::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    write_private(&p, &text).map_err(|e| format!("{}: {e}", p.display()))
}

/// Writes a file readable only by the current user (the token lives in it).
fn write_private(p: &Path, text: &str) -> std::io::Result<()> {
    let tmp = p.with_extension("toml.tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, p)
}

/// Short, token-free description for `status`.
pub fn describe(cfg: &Config) -> String {
    let roots: Vec<String> = cfg.allowed_roots.iter().map(|r| r.display().to_string()).collect();
    format!(
        "gateway: {}\ntarget: #{} {}\nallowed_roots: {}\nscreen capture: {}\nremote control: {}\ninherit env: {}\nconfig: {}",
        cfg.gateway,
        cfg.target_id,
        cfg.name,
        if roots.is_empty() { "(none)".into() } else { roots.join(", ") },
        if cfg.screen_consent { "allowed" } else { "off" },
        if cfg.control_consent { "allowed" } else { "off" },
        if cfg.inherit_env { "yes" } else { "no" },
        path().display()
    )
}

/// Held for the lifetime of `start`: a second runner with the same config is refused instead of
/// fighting the first one for the target's connection.
pub struct InstanceLock(#[allow(dead_code)] std::fs::File);

pub fn lock_instance() -> Result<InstanceLock, String> {
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let path = dir().join("runner.lock");
    let busy = || format!("이미 이 PC에서 러너가 실행 중입니다 ({}) — 서비스로 돌고 있다면 `launchctl list | grep aidev` / `systemctl --user status aidev-runner` / 작업 관리자에서 확인하고, 하나만 실행하세요", path.display());
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path).map_err(|e| e.to_string())?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(busy());
        }
        let _ = file.set_len(0);
        let _ = std::io::Write::write_all(&mut &file, std::process::id().to_string().as_bytes());
        Ok(InstanceLock(file))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).share_mode(0).open(&path).map_err(|_| busy())?;
        Ok(InstanceLock(file))
    }
}
