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
    /// Screen capture of this PC's windows. On from the first run (`grant_on_first_run`); `consent screen off` turns it off.
    #[serde(default)]
    pub screen_consent: bool,
    /// Remote control (mouse, keyboard from the live screen). On from the first run; `consent control off` turns it off.
    #[serde(default)]
    pub control_consent: bool,
    /// 1 once the first run granted screen and control (or the owner chose with `consent`): a later "off" stays off.
    #[serde(default)]
    pub consent_version: u32,
    /// Pass this process's environment to commands it runs (off: only the variables a job sends).
    #[serde(default)]
    pub inherit_env: bool,
}

/// The first run of a runner (also the first run of an updated one on an older config) grants everything it needs, so
/// nothing asks again later: screen and control on. Once granted — or once the owner chose with `consent` — it is
/// left alone. Returns whether the config changed (and was saved).
pub fn grant_on_first_run(cfg: &mut Config) -> bool {
    first_run_grant(cfg) && save(cfg).is_ok()
}

fn first_run_grant(cfg: &mut Config) -> bool {
    if cfg.consent_version >= 1 {
        return false;
    }
    cfg.screen_consent = true;
    cfg.control_consent = true;
    cfg.consent_version = 1;
    true
}

/// Screen / control allowed right now: changed while running by `config.consent` (an agent or the workbench,
/// 2026-10-02), else what the runner started with. Every check reads this, not the start-up copy of the config.
static LIVE_CONSENT: std::sync::RwLock<Option<(bool, bool)>> = std::sync::RwLock::new(None);

pub fn screen_allowed(cfg: &Config) -> bool {
    LIVE_CONSENT.read().ok().and_then(|g| *g).map(|c| c.0).unwrap_or(cfg.screen_consent)
}

pub fn control_allowed(cfg: &Config) -> bool {
    LIVE_CONSENT.read().ok().and_then(|g| *g).map(|c| c.1).unwrap_or(cfg.control_consent)
}

/// `config.consent {screen?, control?}`: saved to runner.toml and effective at once (control implies screen;
/// screen off turns control off). Returns {screen, control}.
pub fn set_consent(cfg: &Config, screen: Option<bool>, control: Option<bool>) -> Result<(bool, bool), String> {
    let mut saved = load().unwrap_or_else(|_| cfg.clone());
    let (s, c) = next_consent((screen_allowed(cfg), control_allowed(cfg)), screen, control);
    saved.screen_consent = s;
    saved.control_consent = c;
    saved.consent_version = 1;
    save(&saved)?;
    if let Ok(mut g) = LIVE_CONSENT.write() { *g = Some((s, c)); }
    Ok((s, c))
}

/// The consent after a change: control implies screen, screen off turns control off.
fn next_consent(current: (bool, bool), screen: Option<bool>, control: Option<bool>) -> (bool, bool) {
    let (mut s, mut c) = current;
    if let Some(v) = screen { s = v; if !v { c = false; } }
    if let Some(v) = control { c = v; if v { s = true; } }
    (s, c)
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
pub struct InstanceLock(#[allow(dead_code)] std::fs::File, Option<PathBuf>);

impl Drop for InstanceLock {
    fn drop(&mut self) {
        if let Some(marker) = &self.1 {
            let _ = std::fs::remove_file(marker);
        }
    }
}

/// Present while the lock's holder is a boot-time runner (one that hands over).
fn boot_marker() -> PathBuf {
    dir().join("boot-holder")
}

/// While a sign-in's runner waits for the boot-time runner (`start --boot`) to hand over, this file exists.
pub fn handoff_path() -> PathBuf {
    dir().join("handoff")
}

/// The lock `start` holds. A boot-time runner (Windows `--boot`, before anyone signs in) waits for it — also after
/// handing over, until the runner that asked has taken it — and so takes over again when that one ends (sign-out).
/// Any other runner that finds it held by a boot-time runner asks it to hand over and waits up to `wait`; held by
/// any other runner, it is refused at once.
pub fn acquire_instance(boot: bool, wait: std::time::Duration) -> Result<InstanceLock, String> {
    use std::time::{Duration, Instant, SystemTime};
    let pause = |ms| std::thread::sleep(Duration::from_millis(ms));
    if boot {
        loop {
            if crate::control::update_pending() {
                return Err("업데이트 중".into());
            }
            let asked = std::fs::metadata(handoff_path()).ok().and_then(|m| m.modified().ok());
            match asked.map(|t| SystemTime::now().duration_since(t).unwrap_or_default()) {
                Some(age) if age < Duration::from_secs(120) => pause(1000),
                Some(_) => { let _ = std::fs::remove_file(handoff_path()); }   // left by a runner that gave up
                None => match lock_instance() {
                    Ok(mut lock) => {
                        let _ = std::fs::write(boot_marker(), std::process::id().to_string());
                        lock.1 = Some(boot_marker());
                        return Ok(lock);
                    }
                    Err(_) => pause(3000),
                },
            }
        }
    }
    let busy = match lock_instance() {
        Ok(lock) => {
            let _ = std::fs::remove_file(boot_marker());   // left by a boot-time runner that was killed
            return Ok(lock);
        }
        Err(e) => e,
    };
    if !boot_marker().exists() {
        return Err(busy);
    }
    let _ = std::fs::write(handoff_path(), std::process::id().to_string());
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline && !crate::control::update_pending() {
        pause(500);
        if let Ok(lock) = lock_instance() {
            let _ = std::fs::remove_file(handoff_path());
            let _ = std::fs::remove_file(boot_marker());
            return Ok(lock);
        }
    }
    let _ = std::fs::remove_file(handoff_path());
    Err(busy)
}

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
        Ok(InstanceLock(file, None))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).share_mode(0).open(&path).map_err(|_| busy())?;
        Ok(InstanceLock(file, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_grants_once_and_respects_a_later_off() {
        // an older config (written before 0.13.2): everything off, never granted
        let mut cfg: Config = toml::from_str("gateway = \"x\"\ntoken = \"t\"\ntarget_id = 1\nname = \"n\"\nscreen_consent = false\ncontrol_consent = false\n").unwrap();
        assert!(first_run_grant(&mut cfg));
        assert!(cfg.screen_consent && cfg.control_consent && cfg.consent_version == 1);
        // the owner turned the screen off afterwards: later runs leave it off
        cfg.screen_consent = false;
        assert!(!first_run_grant(&mut cfg));
        assert!(!cfg.screen_consent);
    }

    #[test]
    fn consent_changes_follow_the_rules() {
        assert_eq!(next_consent((false, false), None, Some(true)), (true, true), "control implies screen");
        assert_eq!(next_consent((true, true), Some(false), None), (false, false), "screen off turns control off");
        assert_eq!(next_consent((true, false), None, None), (true, false));
    }
}
