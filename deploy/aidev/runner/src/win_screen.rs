//! The remote screen's capture on Windows 10 1903+ (F-18 stage 1, 2026-10-02): Windows Graphics Capture through the
//! `windows-capture` crate, for a program window as for a whole display. The compositor hands over a new picture only
//! when something changed (no timed screenshots, no pixel comparison), with the cursor, as RGBA — straight into the
//! CPU path's SIMD scaling and colour conversion and the H.264 encoder. GDI (xcap) stays the fallback: older Windows,
//! a VM without the capture API, any failure here.

use crate::appwin::Frame;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};
use windows_capture::window::Window;

type Error = Box<dyn std::error::Error + Send + Sync>;

/// The newest picture, waiting for the stream loop.
#[derive(Default)]
struct Slot {
    frame: Mutex<Option<Frame>>,
    ready: Condvar,
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
        let rgba = buffer.as_nopadding_buffer(&mut self.scratch).to_vec();
        *self.slot.frame.lock().unwrap() = Some(Frame { width, height, rgba });
        self.slot.ready.notify_one();
        Ok(())
    }
}

pub struct Capture {
    slot: Arc<Slot>,
    control: Option<CaptureControl<Handler, Error>>,
}

impl Capture {
    /// `window` as screen.list gives it: a program window's HWND, or a display (appwin::DISPLAY_BASE + index).
    pub fn open(window: u32, fps: f64) -> Result<Self, String> {
        let slot = Arc::new(Slot::default());
        let every = Duration::from_secs_f64(1.0 / fps.max(1.0));
        let start = |border: DrawBorderSettings, paced: bool| -> Result<CaptureControl<Handler, Error>, String> {
            let interval = || if paced { MinimumUpdateIntervalSettings::Custom(every) } else { MinimumUpdateIntervalSettings::Default };
            if crate::appwin::is_display(window) {
                let id = crate::appwin::display_os_id(window - crate::appwin::DISPLAY_BASE).ok_or("화면을 찾지 못했습니다")?;
                let monitor = Monitor::from_raw_hmonitor(id as usize as *mut std::ffi::c_void);
                let settings = Settings::new(monitor, CursorCaptureSettings::WithCursor, border, SecondaryWindowSettings::Default, interval(), DirtyRegionSettings::Default, ColorFormat::Rgba8, slot.clone());
                Handler::start_free_threaded(settings).map_err(|e| format!("{e:?}"))
            } else {
                let w = Window::from_raw_hwnd(window as usize as *mut std::ffi::c_void);
                let settings = Settings::new(w, CursorCaptureSettings::WithCursor, border, SecondaryWindowSettings::Default, interval(), DirtyRegionSettings::Default, ColorFormat::Rgba8, slot.clone());
                Handler::start_free_threaded(settings).map_err(|e| format!("{e:?}"))
            }
        };
        // no yellow border around what is being watched, at most `fps` pictures a second — older Windows (10 before
        // 2104, Server 2022) supports neither setting: then without them (the stream loop paces itself anyway)
        let control = start(DrawBorderSettings::WithoutBorder, true)
            .or_else(|_| start(DrawBorderSettings::Default, true))
            .or_else(|_| start(DrawBorderSettings::WithoutBorder, false))
            .or_else(|_| start(DrawBorderSettings::Default, false))?;
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
