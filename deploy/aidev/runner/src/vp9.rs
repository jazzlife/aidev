//! VP9 through libvpx (F-18, 2026-10-03): the software encoder of the CPU path where the viewer decodes VP9 — what
//! RustDesk falls back to without a hardware encoder. OpenH264 encodes on about one core (multi-slice threads gave
//! 17 % on screen content) and on Windows ARM64 without its NEON code; libvpx's real-time mode spreads one frame over
//! every core (row-based multi-threading, tile columns) with NEON / SSE / AVX on every platform.
//! Settings as RustDesk's (real-time deadline, CBR, no frame lag, error resilient) plus the screen-content tools.
//! libvpx is linked statically (feature `vpx`, built by scripts/build-libvpx.*: VP9 encoder only).

use crate::vpx_ffi as ffi;
use std::ffi::{c_int, CStr};
use std::time::Instant;
use yuvutils_rs::{rgba_to_yuv420, BufferStoreMut, YuvConversionMode, YuvPlanarImageMut, YuvRange, YuvStandardMatrix};

pub struct Vp9 {
    ctx: Box<ffi::vpx_codec_ctx_t>,
    cfg: Box<ffi::vpx_codec_enc_cfg_t>,
    pub width: u32,
    pub height: u32,
    pub bitrate_kbps: u32,
    /// one I420 picture (Y, then U, then V), reused frame to frame
    i420: Vec<u8>,
    start: Instant,
    frame_ms: u64,
}

// the codec context is used from one thread at a time (the stream's)
unsafe impl Send for Vp9 {}

/// Encoder threads: the cores, at most 8 (AIDEV_VP9_THREADS overrides, for checking).
fn threads() -> u32 {
    std::env::var("AIDEV_VP9_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or_else(|| std::thread::available_parallelism().map_or(2, |n| n.get() as u32)).clamp(1, 8)
}

impl Vp9 {
    /// `width`/`height` must be even (I420).
    pub fn new(width: u32, height: u32, fps: u32, bitrate_kbps: u32) -> Result<Self, String> {
        unsafe {
            let iface = ffi::vpx_codec_vp9_cx();
            let mut cfg: Box<ffi::vpx_codec_enc_cfg_t> = Box::new(std::mem::zeroed());
            if ffi::vpx_codec_enc_config_default(iface, &mut *cfg, 0) != ffi::vpx_codec_err_t_VPX_CODEC_OK {
                return Err("VP9 인코더 기본 설정을 읽지 못했습니다".into());
            }
            cfg.g_w = width;
            cfg.g_h = height;
            // timestamps in milliseconds: frames come when the screen changes, not on a clock
            cfg.g_timebase.num = 1;
            cfg.g_timebase.den = 1000;
            cfg.g_threads = threads();
            cfg.g_lag_in_frames = 0;
            cfg.g_error_resilient = ffi::VPX_ERROR_RESILIENT_DEFAULT;
            cfg.g_pass = ffi::vpx_enc_pass_VPX_RC_ONE_PASS;
            cfg.rc_end_usage = ffi::vpx_rc_mode_VPX_CBR;
            cfg.rc_target_bitrate = bitrate_kbps;
            cfg.rc_min_quantizer = 4;
            cfg.rc_max_quantizer = 56;
            cfg.rc_undershoot_pct = 95;
            cfg.rc_overshoot_pct = 50;
            cfg.rc_buf_sz = 1000;
            cfg.rc_buf_initial_sz = 500;
            cfg.rc_buf_optimal_sz = 600;
            cfg.rc_dropframe_thresh = 0;
            // the periodic keyframe is only a safety net (as H.264's): a viewer that needs one asks (screen.key)
            cfg.kf_mode = ffi::vpx_kf_mode_VPX_KF_AUTO;
            cfg.kf_min_dist = 0;
            cfg.kf_max_dist = fps.max(1) * 10;
            let mut ctx: Box<ffi::vpx_codec_ctx_t> = Box::new(std::mem::zeroed());
            if ffi::vpx_codec_enc_init_ver(&mut *ctx, iface, &*cfg, 0, ffi::VPX_ENCODER_ABI_VERSION as c_int) != ffi::vpx_codec_err_t_VPX_CODEC_OK {
                return Err(format!("VP9 인코더를 만들지 못했습니다: {}", error(&ctx)));
            }
            let mut control = |id: u32, value: c_int| ffi::vpx_codec_control_(&mut *ctx as *mut _, id as c_int, value);
            // real-time speed (RustDesk: 7; 8 trades a little quality for speed on small CPUs)
            control(ffi::vp8e_enc_control_id_VP8E_SET_CPUUSED, speed());
            control(ffi::vp8e_enc_control_id_VP9E_SET_ROW_MT, 1);
            // log2: 4 tile columns where the width allows (each at least 256 pixels)
            control(ffi::vp8e_enc_control_id_VP9E_SET_TILE_COLUMNS, 2);
            control(ffi::vp8e_enc_control_id_VP9E_SET_TUNE_CONTENT, ffi::vp9e_tune_content_VP9E_CONTENT_SCREEN as c_int);
            // cyclic refresh: unchanged areas cost almost nothing, changed ones get the bits
            control(ffi::vp8e_enc_control_id_VP9E_SET_AQ_MODE, 3);
            control(ffi::vp8e_enc_control_id_VP9E_SET_NOISE_SENSITIVITY, 0);
            // a keyframe of a whole screen at most ~3 frames' worth of bits: no burst that stalls a slow link
            control(ffi::vp8e_enc_control_id_VP8E_SET_MAX_INTRA_BITRATE_PCT, 300);
            let (y, c) = ((width * height) as usize, ((width / 2) * (height / 2)) as usize);
            Ok(Vp9 { ctx, cfg, width, height, bitrate_kbps, i420: vec![0; y + 2 * c], start: Instant::now(), frame_ms: 1000 / u64::from(fps.max(1)) })
        }
    }

    /// A new target bit rate from the next frame on (no keyframe, the stream goes on).
    pub fn set_bitrate(&mut self, kbps: u32) {
        self.cfg.rc_target_bitrate = kbps;
        if unsafe { ffi::vpx_codec_enc_config_set(&mut *self.ctx, &*self.cfg) } == ffi::vpx_codec_err_t_VPX_CODEC_OK {
            self.bitrate_kbps = kbps;
        }
    }

    /// RGBA (width × height × 4) → (VP9 frame, keyframe). Empty when the encoder dropped the frame.
    pub fn encode(&mut self, rgba: &[u8], force_key: bool) -> Result<(Vec<u8>, bool), String> {
        let (w, h) = (self.width, self.height);
        let (y_len, c_len) = ((w * h) as usize, ((w / 2) * (h / 2)) as usize);
        {
            let (y, rest) = self.i420.split_at_mut(y_len);
            let (u, v) = rest.split_at_mut(c_len);
            let mut planes = YuvPlanarImageMut {
                y_plane: BufferStoreMut::Borrowed(y),
                y_stride: w,
                u_plane: BufferStoreMut::Borrowed(u),
                u_stride: w / 2,
                v_plane: BufferStoreMut::Borrowed(v),
                v_stride: w / 2,
                width: w,
                height: h,
            };
            // the same colours as the H.264 path: limited range BT.601 (VP9's default signalling)
            rgba_to_yuv420(&mut planes, rgba, w * 4, YuvRange::Limited, YuvStandardMatrix::Bt601, YuvConversionMode::Balanced)
                .map_err(|e| format!("색 변환 실패: {e:?}"))?;
        }
        unsafe {
            let mut img: ffi::vpx_image_t = std::mem::zeroed();
            if ffi::vpx_img_wrap(&mut img, ffi::vpx_img_fmt_VPX_IMG_FMT_I420, w, h, 1, self.i420.as_mut_ptr()).is_null() {
                return Err("VP9 입력 그림을 만들지 못했습니다".into());
            }
            let pts = self.start.elapsed().as_millis() as ffi::vpx_codec_pts_t;
            let flags = if force_key { ffi::VPX_EFLAG_FORCE_KF as ffi::vpx_enc_frame_flags_t } else { 0 };
            let r = ffi::vpx_codec_encode(&mut *self.ctx, &img, pts, self.frame_ms as _, flags, ffi::VPX_DL_REALTIME as _);
            if r != ffi::vpx_codec_err_t_VPX_CODEC_OK {
                return Err(format!("VP9 인코딩 실패: {}", error(&self.ctx)));
            }
            let (mut out, mut key) = (Vec::new(), false);
            let mut iter: ffi::vpx_codec_iter_t = std::ptr::null();
            loop {
                let pkt = ffi::vpx_codec_get_cx_data(&mut *self.ctx, &mut iter);
                if pkt.is_null() {
                    break;
                }
                if (*pkt).kind == ffi::vpx_codec_cx_pkt_kind_VPX_CODEC_CX_FRAME_PKT {
                    let f = (*pkt).data.frame;
                    out.extend_from_slice(std::slice::from_raw_parts(f.buf as *const u8, f.sz));
                    key |= f.flags & ffi::VPX_FRAME_IS_KEY != 0;
                }
            }
            Ok((out, key))
        }
    }
}

impl Drop for Vp9 {
    fn drop(&mut self) {
        unsafe { ffi::vpx_codec_destroy(&mut *self.ctx) };
    }
}

/// cpu-used (AIDEV_VP9_SPEED overrides, for measuring): 8 by default.
fn speed() -> c_int {
    std::env::var("AIDEV_VP9_SPEED").ok().and_then(|s| s.parse().ok()).filter(|s| (5..=9).contains(s)).unwrap_or(8)
}

fn error(ctx: &ffi::vpx_codec_ctx_t) -> String {
    unsafe {
        let msg = ffi::vpx_codec_error(ctx);
        let detail = ffi::vpx_codec_error_detail(ctx);
        let s = |p: *const std::ffi::c_char| if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() };
        format!("{} {}", s(msg), s(detail)).trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_keyframe_then_small_deltas() {
        let (w, h) = (640u32, 360u32);
        let mut enc = Vp9::new(w, h, 30, 2000).unwrap();
        let mut rgba: Vec<u8> = (0..w * h * 4).map(|i| (i % 251) as u8).collect();
        let (first, key) = enc.encode(&rgba, false).unwrap();
        assert!(key && !first.is_empty(), "the first frame is a keyframe");
        // VP9 uncompressed header: frame marker 0b10 in the top two bits
        assert_eq!(first[0] >> 6, 0b10);
        rgba[1000] ^= 0xff;
        let (delta, key) = enc.encode(&rgba, false).unwrap();
        assert!(!key && delta.len() < first.len() / 4, "a small change makes a small delta frame");
        enc.set_bitrate(500);
        let (forced, key) = enc.encode(&rgba, true).unwrap();
        assert!(key && !forced.is_empty(), "a keyframe on request");
    }
}

/// A page to check the encoder with, the same on every PC: rows of glyph-like dots and two coloured boxes on white,
/// the top 3/4 scrolled `4 × i` pixels up (frame `i`), a grey bar below that stays.
pub fn check_frame(i: usize) -> (Vec<u8>, u32, u32) {
    const W: usize = 1440;
    const H: usize = 1136;
    let mut page = vec![255u8; W * H * 4];
    let mut seed = 0x2545_f491u32;
    let mut rnd = || { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed };
    for row in 0..40 {
        for col in 0..84 {
            for p in 0..40 {
                let v = rnd();
                if v % 3 == 0 && (v >> 8) % 7 < 5 {
                    let (x, y) = (10 + col * 9 + p % 7, 6 + row * 27 + p / 7 * 2);
                    page[(y * W + x) * 4..(y * W + x) * 4 + 3].copy_from_slice(&[20, 20, 20]);
                }
            }
        }
    }
    let mut fill = |x0: usize, y0: usize, w: usize, h: usize, c: [u8; 3]| {
        for y in y0..y0 + h { for x in x0..x0 + w { page[(y * W + x) * 4..(y * W + x) * 4 + 3].copy_from_slice(&c); } }
    };
    fill(500, 300, 240, 240, [255, 69, 0]);
    fill(900, 500, 400, 200, [48, 112, 208]);
    fill(0, 1080, W, 56, [232, 232, 232]);
    let (row, band) = (W * 4, H * 3 / 4 * W * 4);
    let s = (i * 4 * row) % band;
    let mut f = page.clone();
    f[..band - s].copy_from_slice(&page[s..band]);
    f[band - s..band].copy_from_slice(&page[..s]);
    (f, W as u32, H as u32)
}

/// `bench --vp9-check <file>`: `frames` of check_frame, 33 ms apart as from a screen (the rate control reads the
/// timestamps), through this PC's encoder into an IVF file — decoded elsewhere (ffmpeg) and compared with the same
/// page, it shows whether the encoder itself is sound here, apart from any capture.
pub fn check(path: &std::path::Path, frames: usize) -> Result<String, String> {
    use std::io::Write;
    let (_, w, h) = check_frame(0);
    let mut ivf = Vec::from(*b"DKIF");
    for v in [0u16, 32] { ivf.extend(v.to_le_bytes()); }
    ivf.extend(*b"VP90");
    for v in [w as u16, h as u16] { ivf.extend(v.to_le_bytes()); }
    for v in [30u32, 1, frames as u32, 0] { ivf.extend(v.to_le_bytes()); }
    let mut enc = Vp9::new(w, h, 30, 4000)?;
    let (mut t, mut spent) = (Instant::now(), std::time::Duration::ZERO);
    for i in 0..frames {
        let (f, _, _) = check_frame(i);
        std::thread::sleep(std::time::Duration::from_millis(33).saturating_sub(t.elapsed()));
        t = Instant::now();
        let (pkt, _) = enc.encode(&f, false)?;
        spent += t.elapsed();
        ivf.extend((pkt.len() as u32).to_le_bytes());
        ivf.extend((i as u64).to_le_bytes());
        ivf.extend(&pkt);
    }
    std::fs::File::create(path).and_then(|mut file| file.write_all(&ivf)).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(format!("VP9 점검 {}×{} {frames}프레임 → {} ({} KB, 인코딩 평균 {:.1} ms, 스레드 {})", w, h, path.display(), ivf.len() / 1024, spent.as_secs_f64() * 1000.0 / frames as f64, threads()))
}

#[cfg(test)]
mod xp {
    /// The check page as raw RGBA, to compare a decoded `bench --vp9-check` file with (ffmpeg psnr):
    ///   XP_OUT=<dir> cargo test --release --features vpx xp -- --ignored
    #[test]
    #[ignore]
    fn check_source() {
        use std::io::Write;
        let out = std::path::PathBuf::from(std::env::var("XP_OUT").unwrap());
        let mut f = std::fs::File::create(out.join("check.rgba")).unwrap();
        for i in 0..120 { f.write_all(&super::check_frame(i).0).unwrap(); }
    }
}

#[cfg(test)]
mod compare {
    use super::*;

    /// EXP_PNG=<screenshot> cargo test --release --features vpx compare -- --ignored --nocapture
    #[test]
    #[ignore]
    fn h264_vs_vp9_on_a_scrolling_page() {
        let img = image::open(std::env::var("EXP_PNG").unwrap()).unwrap().to_rgba8();
        let (w0, h0) = img.dimensions();
        let raw = img.into_raw();
        for max in [1440u32, 2560] {
            let (rgba, w, h) = crate::encoder::fit(crate::appwin::Frame { width: w0, height: h0, rgba: raw.clone() }, max);
            let row = (w * 4) as usize;
            let frames: Vec<Vec<u8>> = (0..60usize).map(|i| { let s = (i * 8 * row) % rgba.len(); let mut f = rgba[s..].to_vec(); f.extend_from_slice(&rgba[..s]); f }).collect();
            let run = |name: &str, enc: &mut dyn FnMut(&[u8]) -> usize| {
                let t = Instant::now();
                let bytes: usize = frames.iter().map(|f| enc(f)).sum();
                println!("{w}x{h} {name:<10} {:6.2} ms/frame  {:4} KB/frame", t.elapsed().as_secs_f64() * 1000.0 / 60.0, bytes / 60 / 1024);
            };
            let mut h264 = crate::encoder::H264::new(w, h, 30, 4000).unwrap();
            run("openh264", &mut |f| h264.encode(f, false).unwrap().0.len());
            for speed in ["7", "8", "9"] {
                std::env::set_var("AIDEV_VP9_SPEED", speed);
                let mut vp9 = Vp9::new(w, h, 30, 4000).unwrap();
                run(&format!("vp9 s{speed}"), &mut |f| vp9.encode(f, false).unwrap().0.len());
            }
        }
    }
}
