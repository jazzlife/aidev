//! `input.*` (IMPLEMENTATION-PLAN §3.12, F-07b): remote control — the user's mouse, touch (mapped to mouse
//! in the browser) and keyboard on the live screen are replayed on this PC. Only after the owner ran
//! `aidev-runner consent control on`; only the person in the workbench/app sends these (agents cannot).
//! JSON-RPC *notifications* (no reply, low latency), handled on one input thread (enigo: CGEvent on macOS,
//! SendInput on Windows, X11 on Linux):
//!   input.event {t:"move", x, y, win?}                   x, y ∈ [0,1] of window `win` (F-07c; the main
//!                                                        display when absent). The window is brought to the
//!                                                        front on the first event and on a click while
//!                                                        another window has the focus.
//!   input.event {t:"button", b:"left"|"right"|"middle", down, x?, y?}
//!   input.event {t:"wheel", dx, dy}                      browser pixels (≈100 per notch)
//!   input.event {t:"key", key, code, mods:{shift,ctrl,alt,meta}}   a press+release with the modifiers held
//!   input.event {t:"text", text}                          typed text (IME results included)
//!   input.end                                            release everything (control switched off)
//! Errors (no permission, no display) are reported once per session as `input.error {error}`.

use crate::config::Config;
use crate::exec::Out;
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde_json::{json, Value};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

enum Job {
    Event(Value),
    End,
}

struct Shared {
    tx: Option<Sender<Job>>,
    out: Option<Out>,
}

fn shared() -> &'static Mutex<Shared> {
    static S: OnceLock<Mutex<Shared>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Shared { tx: None, out: None }))
}

pub fn attach(out: Out) {
    shared().lock().unwrap().out = Some(out);
}

pub fn detach() {
    let mut g = shared().lock().unwrap();
    g.out = None;
    if let Some(tx) = &g.tx {
        let _ = tx.send(Job::End);
    }
}

fn report(error: &str) {
    let out = shared().lock().unwrap().out.clone();
    if let Some(out) = out {
        let note = json!({ "jsonrpc": "2.0", "method": "input.error", "params": { "error": error } });
        let _ = out.blocking_send(Message::Text(note.to_string()));
    }
}

/// Browser `KeyboardEvent.key` / `.code` → a key enigo can press on every platform.
pub fn key_of(key: &str, code: &str) -> Option<Key> {
    let named = match key {
        "Enter" => Key::Return,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Escape" | "Esc" => Key::Escape,
        "Delete" => Key::Delete,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "CapsLock" => Key::CapsLock,
        " " | "Spacebar" => Key::Space,
        "Shift" => Key::Shift,
        "Control" => Key::Control,
        "Alt" => Key::Alt,
        "Meta" | "OS" => Key::Meta,
        "F1" => Key::F1, "F2" => Key::F2, "F3" => Key::F3, "F4" => Key::F4, "F5" => Key::F5, "F6" => Key::F6,
        "F7" => Key::F7, "F8" => Key::F8, "F9" => Key::F9, "F10" => Key::F10, "F11" => Key::F11, "F12" => Key::F12,
        _ => {
            // shortcuts: the physical key (Cmd+C is "c" whatever the layout / Shift state says)
            if let Some(letter) = code.strip_prefix("Key") {
                return letter.chars().next().map(|c| Key::Unicode(c.to_ascii_lowercase()));
            }
            if let Some(digit) = code.strip_prefix("Digit") {
                return digit.chars().next().map(Key::Unicode);
            }
            let mut chars = key.chars();
            return match (chars.next(), chars.next()) {
                (Some(c), None) => Some(Key::Unicode(c)),
                _ => None,
            };
        }
    };
    Some(named)
}

struct Session {
    enigo: Option<Enigo>,
    failed: bool,
    wheel_x: f64,
    wheel_y: f64,
    /// the controlled window's bounds, refreshed at most every 300 ms (windows move)
    win: Option<(crate::appwin::WinInfo, Instant)>,
    activated: Option<u32>,
}

impl Default for Session {
    fn default() -> Self {
        Session { enigo: None, failed: false, wheel_x: 0.0, wheel_y: 0.0, win: None, activated: None }
    }
}

/// Normalized position on a window (or the display) → absolute input coordinates.
pub fn map_point(nx: f64, ny: f64, x0: i32, y0: i32, w: u32, h: u32) -> (i32, i32) {
    let px = x0 + (nx.clamp(0.0, 1.0) * f64::from(w.saturating_sub(1))).round() as i32;
    let py = y0 + (ny.clamp(0.0, 1.0) * f64::from(h.saturating_sub(1))).round() as i32;
    (px, py)
}

impl Session {
    fn enigo(&mut self) -> Option<&mut Enigo> {
        if self.enigo.is_none() && !self.failed {
            match Enigo::new(&Settings::default()) {
                Ok(e) => self.enigo = Some(e),
                Err(e) => {
                    self.failed = true;
                    let hint = if cfg!(target_os = "macos") { " — 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 러너를 실행하는 앱을 허용하세요" } else { "" };
                    report(&format!("입력 장치를 열 수 없습니다: {e}{hint}"));
                }
            }
        }
        self.enigo.as_mut()
    }

    /// The window this event targets (fresh bounds), activating it the first time.
    fn window(&mut self, ev: &Value) -> Option<crate::appwin::WinInfo> {
        let id = ev.get("win").and_then(Value::as_u64)? as u32;
        let stale = match &self.win { Some((w, at)) => w.id != id || at.elapsed() > Duration::from_millis(300), None => true };
        if stale {
            match crate::appwin::info(id) {
                Some(w) => self.win = Some((w, Instant::now())),
                None => {
                    if self.win.as_ref().is_some_and(|(w, _)| w.id == id) {
                        self.win = None;
                    }
                    report(&format!("창 #{id}을(를) 찾을 수 없습니다 (닫혔거나 최소화됨)"));
                    return None;
                }
            }
        }
        let w = self.win.as_ref()?.0.clone();
        if self.activated != Some(id) {
            crate::appwin::activate(&w);
            self.activated = Some(id);
        }
        Some(w)
    }

    fn at(&mut self, ev: &Value) {
        let (Some(x), Some(y)) = (ev.get("x").and_then(Value::as_f64), ev.get("y").and_then(Value::as_f64)) else { return };
        let target = if ev.get("win").is_some() {
            let Some(w) = self.window(ev) else { return };
            Some((w.x, w.y, w.width, w.height))
        } else {
            None
        };
        let Some(e) = self.enigo() else { return };
        let (x0, y0, w, h) = match target {
            Some(t) => t,
            None => {
                let Ok((w, h)) = e.main_display() else { return };
                (0, 0, w as u32, h as u32)
            }
        };
        let (px, py) = map_point(x, y, x0, y0, w, h);
        if let Err(err) = e.move_mouse(px, py, Coordinate::Abs) {
            report(&format!("마우스 이동 실패: {err}"));
        }
    }

    fn event(&mut self, ev: &Value) {
        let t = ev.get("t").and_then(Value::as_str).unwrap_or("");
        match t {
            "move" => self.at(ev),
            "button" => {
                // aimed at a window that is gone: drop it — a press must never land in whatever has the focus now
                if ev.get("win").is_some() && self.window(ev).is_none() {
                    return;
                }
                let down = ev.get("down").and_then(Value::as_bool).unwrap_or(false);
                if down {
                    // a click on a window behind another one: bring it forward first (like a local click)
                    if let Some(id) = ev.get("win").and_then(Value::as_u64) {
                        if crate::appwin::info(id as u32).is_some_and(|w| !w.focused) {
                            self.activated = None;
                            self.win = None;
                        }
                    }
                }
                self.at(ev);
                let b = match ev.get("b").and_then(Value::as_str) { Some("right") => Button::Right, Some("middle") => Button::Middle, _ => Button::Left };
                let d = if ev.get("down").and_then(Value::as_bool).unwrap_or(false) { Direction::Press } else { Direction::Release };
                if let Some(e) = self.enigo() { let _ = e.button(b, d); }
            }
            "wheel" => {
                if ev.get("win").is_some() && self.window(ev).is_none() {
                    return;
                }
                // browsers report pixels; one notch ≈ 100 px — keep the remainder for trackpads' small steps
                self.wheel_y += ev.get("dy").and_then(Value::as_f64).unwrap_or(0.0) / 100.0;
                self.wheel_x += ev.get("dx").and_then(Value::as_f64).unwrap_or(0.0) / 100.0;
                let (ny, nx) = (self.wheel_y.trunc() as i32, self.wheel_x.trunc() as i32);
                self.wheel_y -= f64::from(ny);
                self.wheel_x -= f64::from(nx);
                if let Some(e) = self.enigo() {
                    if ny != 0 { let _ = e.scroll(ny, Axis::Vertical); }
                    if nx != 0 { let _ = e.scroll(nx, Axis::Horizontal); }
                }
            }
            "key" | "text" if ev.get("win").is_some() && self.activated.is_none() => {
                // typing goes to the window being watched — and nowhere else when it is gone
                if self.window(ev).is_none() {
                    return;
                }
                let mut ev = ev.clone();
                ev.as_object_mut().map(|o| o.remove("win"));
                self.event(&ev);
            }
            "key" => {
                let key = ev.get("key").and_then(Value::as_str).unwrap_or("");
                let code = ev.get("code").and_then(Value::as_str).unwrap_or("");
                let Some(k) = key_of(key, code) else { return };
                let m = ev.get("mods").cloned().unwrap_or(Value::Null);
                let held: Vec<Key> = [("ctrl", Key::Control), ("alt", Key::Alt), ("shift", Key::Shift), ("meta", Key::Meta)]
                    .into_iter()
                    .filter(|(n, mk)| m.get(*n).and_then(Value::as_bool).unwrap_or(false) && *mk != k)
                    .map(|(_, mk)| mk)
                    .collect();
                if let Some(e) = self.enigo() {
                    for mk in &held { let _ = e.key(*mk, Direction::Press); }
                    let _ = e.key(k, Direction::Click);
                    for mk in held.iter().rev() { let _ = e.key(*mk, Direction::Release); }
                }
            }
            "text" => {
                let text: String = ev.get("text").and_then(Value::as_str).unwrap_or("").chars().take(1000).collect();
                if !text.is_empty() {
                    if let Some(e) = self.enigo() {
                        if let Err(err) = e.text(&text) { report(&format!("글자 입력 실패: {err}")); }
                    }
                }
            }
            _ => {}
        }
    }
}

fn sender() -> Sender<Job> {
    let mut g = shared().lock().unwrap();
    if let Some(tx) = &g.tx {
        return tx.clone();
    }
    let (tx, rx) = channel::<Job>();
    std::thread::Builder::new()
        .name("aidev-input".into())
        .spawn(move || {
            let mut s = Session::default();
            while let Ok(job) = rx.recv() {
                match job {
                    Job::Event(ev) => s.event(&ev),
                    // dropping Enigo releases any held keys/buttons; a new session may retry permissions
                    Job::End => s = Session::default(),
                }
            }
        })
        .ok();
    g.tx = Some(tx.clone());
    tx
}

/// An event that came straight from the viewer (rtc.rs) on a stream the gateway turned control on for
/// (screen::direct_input checked that, and the owner's consent when it was turned on).
pub fn direct(params: Value) {
    let _ = sender().send(Job::Event(params));
}

/// A notification from the gateway. Refused silently without consent (the gateway checks it first and
/// tells the user); returns whether it was handled.
pub fn notify(cfg: &Config, method: &str, params: &Value) -> bool {
    if !method.starts_with("input.") {
        return false;
    }
    if !crate::config::control_allowed(cfg) {
        return true;
    }
    let job = if method == "input.end" { Job::End } else { Job::Event(params.clone()) };
    let _ = sender().send(job);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert_eq!(key_of("Enter", "Enter"), Some(Key::Return));
        assert_eq!(key_of("C", "KeyC"), Some(Key::Unicode('c')));
        assert_eq!(key_of("!", "Digit1"), Some(Key::Unicode('1')));
        assert_eq!(key_of("ArrowLeft", "ArrowLeft"), Some(Key::LeftArrow));
        assert_eq!(key_of("/", "Slash"), Some(Key::Unicode('/')));
        assert_eq!(key_of("Unidentified", ""), None);
    }

    #[test]
    fn window_mapping() {
        assert_eq!(map_point(0.0, 0.0, 100, 50, 801, 601), (100, 50));
        assert_eq!(map_point(1.0, 1.0, 100, 50, 801, 601), (900, 650));
        assert_eq!(map_point(0.5, 0.5, -1920, 0, 1921, 1081), (-960, 540));
        assert_eq!(map_point(2.0, -1.0, 0, 0, 100, 100), (99, 0));
    }

    #[test]
    fn no_consent_no_input() {
        let cfg = Config::default();
        assert!(notify(&cfg, "input.event", &json!({ "t": "move", "x": 0.5, "y": 0.5 })));
        assert!(shared().lock().unwrap().tx.is_none(), "no input thread without consent");
        assert!(!notify(&cfg, "screen.shot", &json!({})));
    }
}
