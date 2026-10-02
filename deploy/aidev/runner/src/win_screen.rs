//! The remote screen's capture on Windows 10 1903+ (F-18 stage 1, 2026-10-02): Windows Graphics Capture through the
//! `windows-capture` crate, for a program window as for a whole display. The compositor hands over a new picture only
//! when something changed (no timed screenshots, no pixel comparison), with the cursor, as RGBA — scaled to the stream's
//! width right here on the capture thread, straight out of the capture buffer (F-18: while the stream thread encodes
//! one picture this one scales the next — about 28 ms of a 2306×1822 screen on a 4-core ARM64 VM), then colour
//! conversion and the encoder. GDI (xcap) stays the fallback: older Windows,
//! a VM without the capture API, any failure here.

use crate::appwin::Frame;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};
use windows_capture::window::Window;

type Error = Box<dyn std::error::Error + Send + Sync>;

/// The newest picture, waiting for the stream loop.
struct Slot {
    frame: Mutex<Option<Frame>>,
    ready: Condvar,
    max_width: u32,
}

struct Handler {
    slot: Arc<Slot>,
    scratch: Vec<u8>,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Arc<Slot>;
    type Error = Error;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Handler { slot: ctx.flags, scratch: Vec::new() })
    }

    fn on_frame_arrived(&mut self, frame: &mut WgcFrame, _control: InternalCaptureControl) -> Result<(), Self::Error> {
        let buffer = frame.buffer()?;
        let (width, height) = (buffer.width(), buffer.height());
        let (rgba, width, height) = crate::encoder::fit_slice(buffer.as_nopadding_buffer(&mut self.scratch), width, height, self.slot.max_width);
        *self.slot.frame.lock().unwrap() = Some(Frame { width, height, rgba });
        self.slot.ready.notify_one();
        Ok(())
    }
}

/// What screen.list's id names, looked up now: a display by its handle among the current monitors (by its place in
/// the list when the handle changed: the display was reconfigured), a window by its HWND — a 32-bit id, widened back
/// the way Windows does (sign-extended), as a zero-extended handle with the top bit set names another window.
#[derive(Clone, Copy)]
enum Item {
    Display(Monitor),
    Window(Window),
}

impl Item {
    fn find(window: u32) -> Result<Self, String> {
        if !crate::appwin::is_display(window) {
            return Ok(Item::Window(Window::from_raw_hwnd(window as i32 as isize as *mut std::ffi::c_void)));
        }
        let index = window - crate::appwin::DISPLAY_BASE;
        let all = Monitor::enumerate().map_err(|e| format!("화면 목록을 읽지 못했습니다: {e}"))?;
        let id = crate::appwin::display_os_id(index);
        id.and_then(|id| all.iter().find(|m| m.as_raw_hmonitor() as usize as u32 == id))
            .or_else(|| all.get(index as usize))
            .copied()
            .map(Item::Display)
            .ok_or_else(|| format!("화면 #{}을(를) 찾지 못했습니다", index + 1))
    }

    /// Why Windows refuses it (the capture API only says ItemConvertFailed).
    fn why(self) -> String {
        let r: Result<GraphicsCaptureItemType, _> = match self {
            Item::Display(m) => m.try_into(),
            Item::Window(w) => w.try_into(),
        };
        match (r, self) {
            (Err(e), _) => e.to_string(),
            (Ok(_), Item::Window(w)) if !w.is_valid() => "보이지 않거나 캡처할 수 없는 창".into(),
            (Ok(_), _) => "다시 하면 될 수 있습니다".into(),
        }
    }
}

pub struct Capture {
    slot: Arc<Slot>,
    control: Option<CaptureControl<Handler, Error>>,
}

impl Capture {
    /// `window` as screen.list gives it: a program window's HWND, or a display (appwin::DISPLAY_BASE + index);
    /// pictures arrive at most `max_width` wide.
    pub fn open(window: u32, fps: f64, max_width: u32) -> Result<Self, String> {
        let slot = Arc::new(Slot { frame: Mutex::new(None), ready: Condvar::new(), max_width });
        let every = Duration::from_secs_f64(1.0 / fps.max(1.0));
        let start = |item: Item, border: DrawBorderSettings, paced: bool| -> Result<CaptureControl<Handler, Error>, String> {
            let interval = if paced { MinimumUpdateIntervalSettings::Custom(every) } else { MinimumUpdateIntervalSettings::Default };
            match item {
                Item::Display(m) => Handler::start_free_threaded(Settings::new(m, CursorCaptureSettings::WithCursor, border, SecondaryWindowSettings::Default, interval, DirtyRegionSettings::Default, ColorFormat::Rgba8, slot.clone())),
                Item::Window(w) => Handler::start_free_threaded(Settings::new(w, CursorCaptureSettings::WithCursor, border, SecondaryWindowSettings::Default, interval, DirtyRegionSettings::Default, ColorFormat::Rgba8, slot.clone())),
            }
            .map_err(|e| format!("{e:?}"))
        };
        // no yellow border around what is being watched, at most `fps` pictures a second — older Windows (10 before
        // 2104, Server 2022) supports neither setting: then without them (the stream loop paces itself anyway)
        let open = |item: Item| {
            start(item, DrawBorderSettings::WithoutBorder, true)
                .or_else(|_| start(item, DrawBorderSettings::Default, true))
                .or_else(|_| start(item, DrawBorderSettings::WithoutBorder, false))
                .or_else(|_| start(item, DrawBorderSettings::Default, false))
        };
        let item = Item::find(window)?;
        // once more a moment later, looked up again (a display being reconfigured, a window just shown)
        let control = open(item).or_else(|_| {
            std::thread::sleep(Duration::from_millis(500));
            let item = Item::find(window)?;
            open(item).map_err(|e| format!("{e} — {}", item.why()))
        })?;
        Ok(Capture { slot, control: Some(control) })
    }

    /// The newest picture since the last call, waiting up to `wait` for one; None when nothing changed.
    pub fn next(&self, wait: Duration) -> Option<Frame> {
        let mut g = self.slot.frame.lock().unwrap();
        if g.is_none() {
            g = self.slot.ready.wait_timeout(g, wait).unwrap().0;
        }
        g.take()
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(c) = self.control.take() {
            let _ = c.stop();
        }
    }
}
