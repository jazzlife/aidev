//! The remote screen on macOS 13+ (F-18 stage 1, 2026-10-02): ScreenCaptureKit hands over each new picture of a
//! window or display already scaled on the GPU to the stream's size, as NV12 in an IOSurface; VideoToolbox's hardware
//! H.264 encoder takes that surface as it is (no copy, no CPU colour conversion) in real-time, low-latency mode — one
//! frame in, one out, no reordering. Instead of capturing on a timer and comparing pixels, ScreenCaptureKit only
//! delivers a picture when something changed. Older macOS and any failure here fall back to the CPU path
//! (xcap + OpenH264) in screen.rs.

use apple_cf::cf::{CFDictionary, CFNumber, CFString};
use apple_cf::cv::CVPixelBuffer;
use screencapturekit::cm::SCFrameStatus;
use screencapturekit::prelude::*;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use videotoolbox::compression::{CompressionSession, FrameProperties};
use videotoolbox::Codec;

/// macOS 13 or later (the ScreenCaptureKit this path uses); `AIDEV_SCREEN_CPU=1` keeps the CPU path.
pub fn available() -> bool {
    if std::env::var_os("AIDEV_SCREEN_CPU").is_some() {
        return false;
    }
    let mut buf = [0u8; 32];
    let mut len = buf.len();
    let ok = unsafe { libc::sysctlbyname(c"kern.osproductversion".as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) } == 0;
    let version = String::from_utf8_lossy(&buf[..len.saturating_sub(1)]).to_string();
    ok && version.split('.').next().and_then(|m| m.parse::<u32>().ok()).is_some_and(|major| major >= 13)
}

/// A picture from ScreenCaptureKit: its pixels (NV12, IOSurface-backed), and how long it took from the window
/// server's composition to here.
pub struct Picture {
    pub pixels: CVPixelBuffer,
    pub capture: Duration,
}

/// The newest picture ScreenCaptureKit delivered.
#[derive(Default)]
struct Latest {
    frame: Mutex<Option<Picture>>,
    ready: Condvar,
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMClockGetHostTimeClock() -> *const std::ffi::c_void;
    fn CMClockGetTime(clock: *const std::ffi::c_void) -> CMTime;
}

/// Seconds on the host time clock — the clock ScreenCaptureKit stamps its frames with.
fn host_now() -> Option<f64> {
    unsafe { CMClockGetTime(CMClockGetHostTimeClock()) }.as_seconds()
}

struct Handler(Arc<Latest>);

impl SCStreamOutputTrait for Handler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        if !matches!(kind, SCStreamOutputType::Screen) {
            return;
        }
        // only pictures that changed: an idle stream sends status-only buffers
        if !matches!(sample.frame_status(), Some(SCFrameStatus::Complete) | Some(SCFrameStatus::Started)) {
            return;
        }
        let Some(pixels) = sample.pixel_buffer() else { return };
        // from the frame's presentation time to here — usually 0: ScreenCaptureKit hands a frame over at or before
        // the moment it is shown (measured on an M4 Pro, 2026-10-02)
        let capture = match (host_now(), sample.presentation_timestamp().as_seconds()) {
            (Some(now), Some(at)) if now >= at && now - at < 5.0 => Duration::from_secs_f64(now - at),
            _ => Duration::ZERO,
        };
        *self.0.frame.lock().unwrap() = Some(Picture { pixels, capture });
        self.0.ready.notify_one();
    }
}

/// Pixels per point of the main display (2 on Retina).
fn backing_scale() -> f64 {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCopyDisplayMode(display: u32) -> *mut std::ffi::c_void;
        fn CGDisplayModeGetPixelWidth(mode: *mut std::ffi::c_void) -> usize;
        fn CGDisplayModeGetWidth(mode: *mut std::ffi::c_void) -> usize;
        fn CGDisplayModeRelease(mode: *mut std::ffi::c_void);
    }
    unsafe {
        let mode = CGDisplayCopyDisplayMode(CGMainDisplayID());
        if mode.is_null() {
            return 2.0;
        }
        let (px, pt) = (CGDisplayModeGetPixelWidth(mode), CGDisplayModeGetWidth(mode));
        CGDisplayModeRelease(mode);
        if pt == 0 { 2.0 } else { px as f64 / pt as f64 }
    }
}

/// The stream's size for content of `w`×`h` points: at most `max_width` pixels wide, even (H.264 4:2:0).
fn fit(w: f64, h: f64, max_width: u32) -> (u32, u32) {
    let px_w = (w * backing_scale()).max(2.0);
    let width = px_w.min(f64::from(max_width));
    let height = (width * h / w.max(1.0)).max(2.0);
    ((width as u32) & !1, (height as u32) & !1)
}

pub struct Capture {
    stream: SCStream,
    latest: Arc<Latest>,
    window: Option<u32>,
    aspect: f64,
    max_width: u32,
    fps: f64,
    pub width: u32,
    pub height: u32,
}

impl Capture {
    /// A window (`window`, a CGWindowID as screen.list gives it) or a display (`display`, a CGDirectDisplayID).
    pub fn open(window: Option<u32>, display: Option<u32>, max_width: u32, fps: f64) -> Result<Self, String> {
        let content = SCShareableContent::get().map_err(|e| format!("화면 목록을 읽지 못했습니다: {e:?}"))?;
        let (filter, size) = if let Some(id) = window {
            let w = content.windows().into_iter().find(|w| w.window_id() == id).ok_or("창이 없습니다 (닫혔거나 최소화됨)")?;
            let f = w.frame();
            (SCContentFilter::create().with_window(&w).build().map_err(|e| format!("{e:?}"))?, (f.size.width, f.size.height))
        } else {
            let displays = content.displays();
            let d = display.and_then(|id| displays.iter().find(|d| d.display_id() == id)).or_else(|| displays.first()).ok_or("화면이 없습니다")?;
            let f = d.frame();
            (SCContentFilter::create().with_display(d).with_excluding_windows(&[]).build().map_err(|e| format!("{e:?}"))?, (f.size.width, f.size.height))
        };
        let (width, height) = fit(size.0, size.1, max_width);
        let latest = Arc::new(Latest::default());
        let mut stream = SCStream::new(&filter, &config(width, height, fps)).map_err(|e| format!("{e:?}"))?;
        stream.add_output_handler(Handler(latest.clone()), SCStreamOutputType::Screen).map_err(|e| format!("{e:?}"))?;
        stream.start_capture().map_err(|e| format!("화면 캡처를 시작하지 못했습니다: {e:?}"))?;
        Ok(Capture { stream, latest, window, aspect: size.0 / size.1.max(1.0), max_width, fps, width, height })
    }

    /// The newest picture since the last call, waiting up to `wait` for one.
    pub fn next(&self, wait: Duration) -> Option<Picture> {
        let mut g = self.latest.frame.lock().unwrap();
        if g.is_none() {
            g = self.latest.ready.wait_timeout(g, wait).unwrap().0;
        }
        g.take()
    }

    /// A window changed shape (the picture would be letterboxed and clicks would land off): the stream follows it.
    /// True when the size changed (a new encoder is needed).
    pub fn follow_window(&mut self) -> Result<bool, String> {
        let Some(id) = self.window else { return Ok(false) };
        let content = SCShareableContent::get().map_err(|e| format!("{e:?}"))?;
        let w = content.windows().into_iter().find(|w| w.window_id() == id).ok_or("창이 닫혔습니다")?;
        let f = w.frame();
        let aspect = f.size.width / f.size.height.max(1.0);
        let (width, height) = fit(f.size.width, f.size.height, self.max_width);
        if (aspect - self.aspect).abs() < 0.01 && (width, height) == (self.width, self.height) {
            return Ok(false);
        }
        // a new stream at the new size (SCStream.updateConfiguration is behind the crate's macOS 14 feature)
        *self = Capture::open(Some(id), None, self.max_width, self.fps)?;
        Ok(true)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.stream.stop_capture();
    }
}

fn config(width: u32, height: u32, fps: f64) -> SCStreamConfiguration {
    SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_pixel_format(PixelFormat::YCbCr_420v)
        .with_shows_cursor(true)
        .with_queue_depth(5)
        .with_minimum_frame_interval(&CMTime::new(1, fps.round().max(1.0) as i32))
}

/// VideoToolbox H.264 in real-time, low-latency mode; Annex B out (SPS/PPS before every keyframe), as the stream
/// and the browser's WebCodecs expect.
pub struct Encoder {
    session: CompressionSession,
    pub width: u32,
    pub height: u32,
    fps: i32,
    n: i64,
}

impl Encoder {
    pub fn new(width: u32, height: u32, fps: f64, kbps: u32) -> Result<Self, String> {
        let fps_i = fps.round().max(1.0) as i32;
        let session = CompressionSession::builder(width as i32, height as i32, Codec::H264)
            .with_real_time(true)
            .with_allow_frame_reordering(false)
            .with_low_latency_rate_control(true)
            .with_average_bit_rate(kbps.saturating_mul(1000).min(i32::MAX as u32) as i32)
            .with_expected_frame_rate(f64::from(fps_i))
            .with_max_keyframe_interval(fps_i * 10)
            .build()
            .map_err(|e| format!("VideoToolbox H.264 인코더를 만들지 못했습니다: {e:?}"))?;
        Ok(Encoder { session, width, height, fps: fps_i, n: 0 })
    }

    /// Nothing encoded yet (the first frame must be a keyframe).
    pub fn fresh(&self) -> bool {
        self.n == 0
    }

    pub fn set_bitrate(&mut self, kbps: u32) {
        let key = CFString::new("AverageBitRate");
        let value = CFNumber::from_i64(i64::from(kbps) * 1000);
        let _ = self.session.set_properties(&CFDictionary::from_pairs(&[(&key, &value)]));
    }

    /// One picture → (Annex B access unit, keyframe).
    pub fn encode(&mut self, pixels: &CVPixelBuffer, force_key: bool) -> Result<(Vec<u8>, bool), String> {
        let surface = pixels.io_surface().ok_or("캡처한 화면에 IOSurface가 없습니다")?;
        self.n += 1;
        let out = self
            .session
            .encode_with_properties(&surface, CMTime::new(self.n, self.fps), FrameProperties::new().with_force_key_frame(force_key))
            .map_err(|e| format!("H.264 인코딩 실패: {e:?}"))?;
        let sets = out.cm_sample_buffer().and_then(|b| b.format_description()).and_then(|f| f.video_parameter_sets().ok());
        Ok(annex_b(&out.data, sets.as_ref().map(|s| (s.parameter_sets.as_slice(), s.nal_unit_header_length))))
    }
}

/// AVCC (length-prefixed NAL units) → Annex B (start codes); a keyframe (an IDR unit inside) gets the parameter
/// sets in front.
fn annex_b(avcc: &[u8], sets: Option<(&[Vec<u8>], i32)>) -> (Vec<u8>, bool) {
    let len_size = sets.map(|(_, n)| n).filter(|n| (1..=4).contains(n)).unwrap_or(4) as usize;
    let mut nals = Vec::new();
    let mut i = 0;
    while i + len_size <= avcc.len() {
        let n = avcc[i..i + len_size].iter().fold(0usize, |acc, b| (acc << 8) | usize::from(*b));
        i += len_size;
        if n == 0 || i + n > avcc.len() {
            break;
        }
        nals.push(&avcc[i..i + n]);
        i += n;
    }
    let key = nals.iter().any(|n| n.first().is_some_and(|b| b & 0x1f == 5));
    let mut out = Vec::with_capacity(avcc.len() + 64);
    if key {
        for set in sets.map(|(s, _)| s).unwrap_or(&[]) {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(set);
        }
    }
    for nal in nals {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(nal);
    }
    (out, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avcc_becomes_annex_b_with_parameter_sets_on_keyframes() {
        let sps = vec![0x67, 0x42, 0xc0, 0x1f];
        let pps = vec![0x68, 0xce];
        let idr = [0, 0, 0, 3, 0x65, 0x88, 0x80];
        let (out, key) = annex_b(&idr, Some((&[sps.clone(), pps.clone()], 4)));
        assert!(key);
        assert_eq!(out, [&[0, 0, 0, 1][..], &sps, &[0, 0, 0, 1], &pps, &[0, 0, 0, 1], &[0x65, 0x88, 0x80]].concat());
        let p = [0, 0, 0, 2, 0x41, 0x9a];
        let (out, key) = annex_b(&p, Some((&[sps, pps], 4)));
        assert!(!key);
        assert_eq!(out, [0, 0, 0, 1, 0x41, 0x9a]);
    }

    #[test]
    fn sizes_are_even_and_capped() {
        let (w, h) = fit(1720.0, 1001.0, 1440);
        assert!(w <= 1440 && w % 2 == 0 && h % 2 == 0);
    }
}
