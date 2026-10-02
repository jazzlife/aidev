//! The runner's state as the status icon shows it, and the icon's three commands (2026-10-02):
//!   정지 — `~/.aidev/paused` exists: every runner on this PC (also the boot-time one) drops its connection and
//!          stops its commands until the file is gone; the icon stays, grey
//!   시작 — the file is removed: they connect again
//!   종료 — paused, and this runner quits (exit 0: service managers do not start it again)
//! A runner started by hand (`aidev-runner` / `start` without `--service`) clears the pause: starting it is asking
//! for it to run. Service starts keep it.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Connecting = 0,
    Connected = 1,
    Paused = 2,
}

static STATE: AtomicU8 = AtomicU8::new(State::Connecting as u8);
static QUIT: AtomicBool = AtomicBool::new(false);
static BOOT: AtomicBool = AtomicBool::new(false);

/// This runner is the boot-time one (`start --boot`): before a sign-in, with no desktop to show or control.
pub fn set_boot(on: bool) {
    BOOT.store(on, Ordering::Relaxed);
}

pub fn is_boot() -> bool {
    BOOT.load(Ordering::Relaxed)
}

pub fn set_state(s: State) {
    STATE.store(s as u8, Ordering::Relaxed);
}

pub fn state() -> State {
    match STATE.load(Ordering::Relaxed) {
        1 => State::Connected,
        2 => State::Paused,
        _ => State::Connecting,
    }
}

pub fn paused_path() -> std::path::PathBuf {
    crate::config::dir().join("paused")
}

pub fn is_paused() -> bool {
    paused_path().exists()
}

pub fn set_paused(on: bool) {
    if on {
        let _ = std::fs::create_dir_all(crate::config::dir());
        let _ = std::fs::write(paused_path(), "paused from the status icon\n");
    } else {
        let _ = std::fs::remove_file(paused_path());
    }
}

/// 종료: paused, then this runner ends.
pub fn quit() {
    set_paused(true);
    QUIT.store(true, Ordering::Relaxed);
}

pub fn quit_requested() -> bool {
    QUIT.load(Ordering::Relaxed)
}

/// While an update replaces the runner's file (`update`, the icon's 업데이트), this file exists: every runner on this PC
/// drops its connection and stops its commands, as for 정지, and when it is gone starts again from the new file.
pub fn updating_path() -> std::path::PathBuf {
    crate::config::dir().join("updating")
}

/// Set by an update in progress — not a file left behind by one that died (an update holds it for well under a minute).
pub fn updating() -> bool {
    match std::fs::metadata(updating_path()).and_then(|m| m.modified()) {
        Ok(at) if at.elapsed().map_or(true, |age| age < std::time::Duration::from_secs(180)) => true,
        Ok(_) => {
            let _ = std::fs::remove_file(updating_path());
            false
        }
        Err(_) => false,
    }
}

/// A restart from the new file failed: carry on with this one instead of trying again and again.
static RESTART_FAILED: AtomicBool = AtomicBool::new(false);

type Fingerprint = (u64, Option<std::time::SystemTime>, u64);
static EXE: std::sync::OnceLock<(std::path::PathBuf, Vec<std::ffi::OsString>, Option<Fingerprint>)> = std::sync::OnceLock::new();

fn fingerprint(path: &std::path::Path) -> Option<Fingerprint> {
    let m = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(&m);
    #[cfg(not(unix))]
    let inode = 0;
    Some((m.len(), m.modified().ok(), inode))
}

/// This process's file and arguments, taken at start: Linux reports a replaced file as "… (deleted)" afterwards.
pub fn remember_exe() {
    if let Ok(exe) = std::env::current_exe() {
        let print = fingerprint(&exe);
        let _ = EXE.set((exe, std::env::args_os().skip(1).collect(), print));
    }
}

/// The file this runner started from has been replaced (an update, or an install over it): a runner that was waiting
/// between checks and missed `updating` still starts again from the new one.
pub fn replaced() -> bool {
    if RESTART_FAILED.load(Ordering::Relaxed) {
        return false;
    }
    match EXE.get() {
        Some((exe, _, Some(was))) => fingerprint(exe).is_some_and(|now| now != *was),
        _ => false,
    }
}

/// `updating()` or `replaced()`: stop and start again from the file.
pub fn update_pending() -> bool {
    updating() || replaced()
}

/// After an update: the same runner again — same file path (now the new version), same arguments — so it stays what
/// it was: the service's process (unix: the same pid), elevated or not, in the same desktop session. Returns only on
/// failure.
pub fn restart_self() -> String {
    let Some((exe, args, _)) = EXE.get() else { return "실행 파일 경로를 모릅니다".into() };
    eprintln!("업데이트: 새 러너로 다시 시작합니다 ({})", exe.display());
    RESTART_FAILED.store(true, Ordering::Relaxed);   // only seen when it returns
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        std::process::Command::new(exe).args(args).exec().to_string()
    }
    #[cfg(windows)]
    {
        use crate::proc_util::NoWindow;
        let mut cmd = std::process::Command::new(exe);
        cmd.args(args);
        if args.iter().any(|a| a == "--hidden") {
            cmd.no_window();
        }
        match cmd.spawn() {
            Ok(_) => std::process::exit(0),
            Err(e) => e.to_string(),
        }
    }
}
