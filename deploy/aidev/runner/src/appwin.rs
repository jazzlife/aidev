//! Program windows on this PC (IMPLEMENTATION-PLAN §3.12, F-07c): list them, capture one (even when other
//! windows cover it, where the OS allows), find its bounds for input and bring it to the front.
//! Everything is inside the runner — no external program to install:
//!   macOS / Windows: the `xcap` crate (CoreGraphics window list + window image / Win32 PrintWindow)
//!   Linux (X11): x11rb directly (_NET_CLIENT_LIST or the top-level tree, GetImage on the window)
//! Coordinates (x, y, width, height) are in the OS's input space (points on macOS), so a normalized
//! position on the streamed picture maps to `x + nx * width` for the mouse whatever the pixel density.

#[derive(Debug, Clone, serde::Serialize)]
pub struct WinInfo {
    pub id: u32,
    pub pid: u32,
    pub app: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub minimized: bool,
    pub focused: bool,
}

/// RGBA pixels of one capture.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Windows a person would pick: real size, a name, not minimized.
pub fn list() -> Result<Vec<WinInfo>, String> {
    let mut all = imp::list()?;
    all.retain(|w| w.width >= 80 && w.height >= 60 && !(w.title.trim().is_empty() && w.app.trim().is_empty()) && !w.minimized);
    all.sort_by(|a, b| b.focused.cmp(&a.focused).then_with(|| a.app.to_lowercase().cmp(&b.app.to_lowercase())).then_with(|| a.title.cmp(&b.title)));
    Ok(all)
}

pub fn info(id: u32) -> Option<WinInfo> {
    imp::list().ok()?.into_iter().find(|w| w.id == id)
}

/// A window by id, or the first whose app or title contains `query` (case-insensitive), or the focused one.
pub fn find(id: Option<u32>, query: Option<&str>) -> Result<WinInfo, String> {
    let all = list()?;
    if let Some(id) = id {
        return all.into_iter().find(|w| w.id == id).ok_or_else(|| format!("창 #{id}이(가) 없습니다 (닫혔거나 최소화됨)"));
    }
    if let Some(q) = query.map(str::to_lowercase).filter(|q| !q.is_empty()) {
        return all.into_iter().find(|w| w.app.to_lowercase().contains(&q) || w.title.to_lowercase().contains(&q)).ok_or_else(|| format!("'{q}'에 맞는 창이 없습니다"));
    }
    all.into_iter().next().ok_or_else(|| "보이는 프로그램 창이 없습니다".into())
}

/// A capture session on one window: keeps the OS handle between frames.
pub struct Capturer(imp::Handle);

impl Capturer {
    pub fn open(id: u32) -> Result<Self, String> {
        imp::Handle::open(id).map(Capturer)
    }
    pub fn capture(&mut self) -> Result<Frame, String> {
        self.0.capture()
    }
}

/// Brings the window's app to the front (input goes where the user sees it).
pub fn activate(w: &WinInfo) {
    imp::activate(w)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod imp {
    use super::{Frame, WinInfo};
    use xcap::Window;

    fn to_info(w: &Window) -> Option<WinInfo> {
        Some(WinInfo {
            id: w.id().ok()?,
            pid: w.pid().unwrap_or(0),
            app: w.app_name().unwrap_or_default(),
            title: w.title().unwrap_or_default(),
            x: w.x().unwrap_or(0),
            y: w.y().unwrap_or(0),
            width: w.width().unwrap_or(0),
            height: w.height().unwrap_or(0),
            minimized: w.is_minimized().unwrap_or(false),
            focused: w.is_focused().unwrap_or(false),
        })
    }

    pub fn list() -> Result<Vec<WinInfo>, String> {
        let all = Window::all().map_err(|e| format!("창 목록을 읽지 못했습니다: {e}"))?;
        Ok(all.iter().filter_map(to_info).collect())
    }

    pub struct Handle(Window);

    impl Handle {
        pub fn open(id: u32) -> Result<Self, String> {
            let all = Window::all().map_err(|e| format!("창 목록을 읽지 못했습니다: {e}"))?;
            all.into_iter().find(|w| w.id().ok() == Some(id)).map(Handle).ok_or_else(|| format!("창 #{id}이(가) 없습니다"))
        }
        pub fn capture(&mut self) -> Result<Frame, String> {
            let img = self.0.capture_image().map_err(|e| {
                let hint = if cfg!(target_os = "macos") { " — 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록에서 러너를 허용하세요" } else { "" };
                format!("창을 캡처하지 못했습니다: {e}{hint}")
            })?;
            let (width, height) = (img.width(), img.height());
            Ok(Frame { width, height, rgba: img.into_raw() })
        }
    }

    pub fn activate(w: &WinInfo) {
        if w.pid == 0 {
            return;
        }
        if cfg!(target_os = "macos") {
            // built into macOS: bring the process with this pid to the front
            let script = format!("tell application \"System Events\" to set frontmost of (first process whose unix id is {}) to true", w.pid);
            let _ = std::process::Command::new("osascript").args(["-e", &script]).output();
        } else {
            // Windows only lets the foreground process hand the focus over; an Alt keystroke from the same
            // process first lifts that lock (the usual AppActivate workaround)
            let script = format!("$s = New-Object -ComObject WScript.Shell; $s.SendKeys('%'); $s.AppActivate({}) | Out-Null", w.pid);
            let _ = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output();
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{Frame, WinInfo};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt, EventMask, ImageFormat, MapState, StackMode, Window, WindowClass};
    use x11rb::rust_connection::RustConnection;

    struct X {
        conn: RustConnection,
        root: Window,
    }

    fn connect() -> Result<X, String> {
        let (conn, screen) = x11rb::connect(None).map_err(|e| format!("X 디스플레이에 연결하지 못했습니다 (DISPLAY={}): {e}", std::env::var("DISPLAY").unwrap_or_default()))?;
        let root = conn.setup().roots[screen].root;
        Ok(X { conn, root })
    }

    fn atom(x: &X, name: &str) -> u32 {
        x.conn.intern_atom(false, name.as_bytes()).ok().and_then(|c| c.reply().ok()).map(|r| r.atom).unwrap_or(0)
    }

    fn prop(x: &X, win: Window, name: u32, kind: u32) -> Option<Vec<u8>> {
        let r = x.conn.get_property(false, win, name, kind, 0, 4096).ok()?.reply().ok()?;
        (r.value_len > 0).then_some(r.value)
    }

    fn windows(x: &X) -> Vec<Window> {
        let client_list = atom(x, "_NET_CLIENT_LIST");
        if let Some(v) = prop(x, x.root, client_list, AtomEnum::WINDOW.into()) {
            return v.chunks_exact(4).map(|c| u32::from_ne_bytes([c[0], c[1], c[2], c[3]])).collect();
        }
        // no window manager (e.g. a bare X server): mapped top-level windows
        x.conn.query_tree(x.root).ok().and_then(|c| c.reply().ok()).map(|t| t.children).unwrap_or_default()
    }

    fn describe(x: &X, win: Window, active: Window) -> Option<WinInfo> {
        let attrs = x.conn.get_window_attributes(win).ok()?.reply().ok()?;
        // not a program window: input-only helpers, menus and tooltips (override-redirect)
        if attrs.class == WindowClass::INPUT_ONLY || attrs.override_redirect {
            return None;
        }
        let geo = x.conn.get_geometry(win).ok()?.reply().ok()?;
        let pos = x.conn.translate_coordinates(win, x.root, 0, 0).ok()?.reply().ok()?;
        let utf8 = atom(x, "UTF8_STRING");
        let title = prop(x, win, atom(x, "_NET_WM_NAME"), utf8)
            .or_else(|| prop(x, win, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
            .map(|v| String::from_utf8_lossy(&v).trim_end_matches('\0').to_string())
            .unwrap_or_default();
        // WM_CLASS = "instance\0Class\0"
        let app = prop(x, win, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into())
            .map(|v| String::from_utf8_lossy(&v).split('\0').rfind(|s| !s.is_empty()).unwrap_or("").to_string())
            .unwrap_or_default();
        let pid = prop(x, win, atom(x, "_NET_WM_PID"), AtomEnum::CARDINAL.into()).filter(|v| v.len() >= 4).map(|v| u32::from_ne_bytes([v[0], v[1], v[2], v[3]])).unwrap_or(0);
        Some(WinInfo {
            id: win,
            pid,
            app: if app.is_empty() && !title.is_empty() { title.split(':').next().unwrap_or("").trim().to_string() } else { app },
            title,
            x: i32::from(pos.dst_x),
            y: i32::from(pos.dst_y),
            width: u32::from(geo.width),
            height: u32::from(geo.height),
            minimized: attrs.map_state != MapState::VIEWABLE,
            focused: win == active,
        })
    }

    pub fn list() -> Result<Vec<WinInfo>, String> {
        let x = connect()?;
        let active = prop(&x, x.root, atom(&x, "_NET_ACTIVE_WINDOW"), AtomEnum::WINDOW.into())
            .filter(|v| v.len() >= 4)
            .map(|v| u32::from_ne_bytes([v[0], v[1], v[2], v[3]]))
            .or_else(|| x.conn.get_input_focus().ok().and_then(|c| c.reply().ok()).map(|f| f.focus))
            .unwrap_or(0);
        Ok(windows(&x).into_iter().filter_map(|w| describe(&x, w, active)).collect())
    }

    pub struct Handle {
        x: X,
        win: Window,
    }

    impl Handle {
        pub fn open(id: u32) -> Result<Self, String> {
            let x = connect()?;
            x.conn.get_geometry(id).map_err(|e| e.to_string())?.reply().map_err(|_| format!("창 #{id}이(가) 없습니다"))?;
            Ok(Handle { x, win: id })
        }

        pub fn capture(&mut self) -> Result<Frame, String> {
            let geo = self.x.conn.get_geometry(self.win).map_err(|e| e.to_string())?.reply().map_err(|_| "창이 닫혔습니다".to_string())?;
            let (w, h) = (i32::from(geo.width), i32::from(geo.height));
            // GetImage needs the rectangle on screen (BadMatch otherwise): read the visible part, the rest stays black
            let pos = self.x.conn.translate_coordinates(self.win, self.x.root, 0, 0).map_err(|e| e.to_string())?.reply().map_err(|_| "창이 닫혔습니다".to_string())?;
            let root = self.x.conn.get_geometry(self.x.root).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
            let (px, py) = (i32::from(pos.dst_x), i32::from(pos.dst_y));
            let (x0, y0) = ((-px).max(0), (-py).max(0));
            let (x1, y1) = (w.min(i32::from(root.width) - px), h.min(i32::from(root.height) - py));
            if x1 <= x0 || y1 <= y0 {
                return Err("창이 화면 밖에 있습니다".into());
            }
            let (vw, vh) = ((x1 - x0) as usize, (y1 - y0) as usize);
            let img = self.x.conn.get_image(ImageFormat::Z_PIXMAP, self.win, x0 as i16, y0 as i16, vw as u16, vh as u16, !0).map_err(|e| e.to_string())?.reply().map_err(|e| format!("창 이미지를 읽지 못했습니다: {e:?}"))?;
            if img.data.len() < vw * vh * 4 {
                return Err(format!("지원하지 않는 화면 형식입니다 (depth {})", img.depth));
            }
            // 24/32-bit TrueColor: BGRX in memory (little endian)
            let (fw, fh) = (w as usize, h as usize);
            let mut rgba = vec![0u8; fw * fh * 4];
            for row in 0..vh {
                let src = &img.data[row * vw * 4..(row + 1) * vw * 4];
                let start = ((y0 as usize + row) * fw + x0 as usize) * 4;
                for (dst, s) in rgba[start..start + vw * 4].chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                    dst[0] = s[2];
                    dst[1] = s[1];
                    dst[2] = s[0];
                }
            }
            for a in rgba.iter_mut().skip(3).step_by(4) {
                *a = 255;
            }
            Ok(Frame { width: fw as u32, height: fh as u32, rgba })
        }
    }

    pub fn activate(w: &WinInfo) {
        let Ok(x) = connect() else { return };
        let net_active = atom(&x, "_NET_ACTIVE_WINDOW");
        let ev = ClientMessageEvent::new(32, w.id, net_active, [2u32, 0, 0, 0, 0]);
        let _ = x.conn.send_event(false, x.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, ev);
        let _ = x.conn.configure_window(w.id, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
        let _ = x.conn.set_input_focus(x11rb::protocol::xproto::InputFocus::PARENT, w.id, x11rb::CURRENT_TIME);
        let _ = x.conn.flush();
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod imp {
    use super::{Frame, WinInfo};
    pub fn list() -> Result<Vec<WinInfo>, String> {
        Err("이 OS에서는 창 캡처를 지원하지 않습니다".into())
    }
    pub struct Handle;
    impl Handle {
        pub fn open(_id: u32) -> Result<Self, String> {
            Err("이 OS에서는 창 캡처를 지원하지 않습니다".into())
        }
        pub fn capture(&mut self) -> Result<Frame, String> {
            Err("지원하지 않음".into())
        }
    }
    pub fn activate(_w: &WinInfo) {}
}
