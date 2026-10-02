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
