//! Status icon (2026-10-02): Windows notification area, macOS menu bar, Linux StatusNotifierItem (KDE, XFCE, GNOME
//! with the AppIndicator extension …). The NadoVibe logo in colour when connected, faded while connecting, grey when
//! stopped; its menu shows the state and offers 시작 / 정지 / 종료 (`control`).
//! Shown by a runner in a desktop session — not by the boot-time runner, not over SSH or on a headless machine.
//! Windows and macOS need an event loop on the main thread (`run`): the runner itself then works on another thread.
//! Linux's backend has its own D-Bus thread (`spawn`).

use crate::control::{self, State};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

const PNG: &[u8] = include_bytes!("../assets/tray.png");

/// Icons for Connecting, Connected and Paused: the logo with a status dot in its lower right corner (amber, green,
/// red) — the logo itself is nearly black and white, so fading it alone does not show the state at menu-bar size.
fn icons() -> Result<[Icon; 3], String> {
    let img = image::load_from_memory(PNG).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = img.dimensions();
    let base = img.into_raw();
    let with_dot = |rgb: [u8; 3], dim: bool| -> Result<Icon, String> {
        let mut px = base.clone();
        if dim {
            for p in px.chunks_mut(4) {
                p[3] = (p[3] as u32 * 3 / 5) as u8;
            }
        }
        let r = w as f32 * 0.22;
        let (cx, cy) = (w as f32 - r - 1.0, h as f32 - r - 1.0);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                let i = ((y * w + x) * 4) as usize;
                if d <= r - 2.0 {
                    px[i..i + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                } else if d <= r {
                    px[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);   // a white ring keeps it visible on dark bars
                }
            }
        }
        Icon::from_rgba(px, w, h).map_err(|e| e.to_string())
    };
    Ok([with_dot([245, 166, 35], true)?, with_dot([46, 204, 64], false)?, with_dot([231, 76, 60], true)?])
}

fn label(s: State) -> &'static str {
    match s {
        State::Connecting => "연결 중…",
        State::Connected => "연결됨",
        State::Paused => "정지됨",
    }
}

pub struct Tray {
    icon: TrayIcon,
    status: MenuItem,
    start: MenuItem,
    stop: MenuItem,
    quit: MenuItem,
    icons: [Icon; 3],
    name: String,
    shown: Option<State>,
}

impl Tray {
    pub fn new(name: &str) -> Result<Self, String> {
        let status = MenuItem::new("NadoVibe 러너", false, None);
        let start = MenuItem::new("시작", false, None);
        let stop = MenuItem::new("정지", false, None);
        let quit = MenuItem::new("종료", true, None);
        let menu = Menu::new();
        menu.append_items(&[&status, &PredefinedMenuItem::separator(), &start, &stop, &PredefinedMenuItem::separator(), &quit])
            .map_err(|e| e.to_string())?;
        let icons = icons()?;
        let icon = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip(format!("NadoVibe 러너 — {name}"))
            .with_icon(icons[0].clone())
            .build()
            .map_err(|e| e.to_string())?;
        let mut tray = Tray { icon, status, start, stop, quit, icons, name: name.to_string(), shown: None };
        tray.tick();
        Ok(tray)
    }

    /// Menu choices since the last tick, then the icon for the state now.
    pub fn tick(&mut self) {
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            if ev.id == *self.start.id() {
                control::set_paused(false);
            } else if ev.id == *self.stop.id() {
                control::set_paused(true);
            } else if ev.id == *self.quit.id() {
                control::quit();
            }
        }
        let s = if control::is_paused() { State::Paused } else { control::state() };
        if self.shown == Some(s) {
            return;
        }
        self.shown = Some(s);
        let _ = self.icon.set_icon(Some(self.icons[s as usize].clone()));
        let _ = self.icon.set_tooltip(Some(format!("NadoVibe 러너 — {} ({})", label(s), self.name)));
        self.status.set_text(format!("● {} — {}", label(s), self.name));
        self.start.set_enabled(s == State::Paused);
        self.stop.set_enabled(s != State::Paused);
    }
}

/// Whether this runner shows an icon: a desktop session, not the boot-time runner, not turned off.
pub fn wanted(boot: bool) -> bool {
    if boot || std::env::var_os("AIDEV_NO_TRAY").is_some() {
        return false;
    }
    desktop_session()
}

#[cfg(target_os = "macos")]
fn desktop_session() -> bool {
    // a window-server session (not SSH, not a LaunchDaemon)
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> *const std::ffi::c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const std::ffi::c_void);
    }
    unsafe {
        let d = CGSessionCopyCurrentDictionary();
        if d.is_null() {
            return false;
        }
        CFRelease(d);
        true
    }
}

#[cfg(windows)]
fn desktop_session() -> bool {
    // session 0 is the services' session (no desktop)
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcessId() -> u32;
        fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
    }
    let mut session = 0u32;
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) != 0 && session != 0 }
}

#[cfg(target_os = "linux")]
fn desktop_session() -> bool {
    // a session bus to register on; the icon appears when the desktop's StatusNotifierWatcher is (or comes) up
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
        || std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|d| std::path::Path::new(&d).join("bus").exists())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn desktop_session() -> bool {
    false
}

/// Windows / macOS: `job` (the runner) on a worker thread, the icon's event loop here on the main thread; the process
/// exits with the job's code when it ends (Ctrl+C, 종료, a refused token …).
#[cfg(any(windows, target_os = "macos"))]
pub fn run(name: String, job: impl FnOnce() -> i32 + Send + 'static) -> ! {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    let done: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
    let finished = done.clone();
    std::thread::spawn(move || {
        let code = job();
        *finished.lock().unwrap() = Some(code);
    });
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::new().build();
    #[cfg(target_os = "macos")]
    {
        // a menu bar item only: no Dock icon, no app menu
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let mut tray: Option<Tray> = None;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250));
        // macOS: create the icon once the loop runs (tray-icon's rule)
        if let Event::NewEvents(StartCause::Init) = event {
            match Tray::new(&name) {
                Ok(t) => tray = Some(t),
                Err(e) => eprintln!("[aidev-runner] 상태 아이콘을 만들지 못했습니다: {e}"),
            }
        }
        if let Some(t) = tray.as_mut() {
            t.tick();
        }
        if let Some(code) = done.lock().unwrap().take() {
            tray = None;
            std::process::exit(code);
        }
    })
}

/// Linux: the icon on its own thread (the backend needs no event loop); the runner keeps the main thread.
#[cfg(target_os = "linux")]
pub fn spawn(name: String) {
    std::thread::spawn(move || {
        let mut tray = match Tray::new(&name) {
            Ok(t) => t,
            Err(e) => return eprintln!("[aidev-runner] 상태 아이콘을 만들지 못했습니다: {e}"),
        };
        loop {
            tray.tick();
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
}
