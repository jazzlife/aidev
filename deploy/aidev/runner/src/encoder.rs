//! H.264 inside the runner (F-07c): Cisco OpenH264, compiled into the binary from source (no ffmpeg or
//! other program to install). Screen-content mode, bit-rate control the stream can change while it runs
//! (`set_bitrate`, F-07d), baseline profile (every browser's WebCodecs decodes it). Keyframes come when a
//! viewer needs one (`force_key`); the periodic one is only a safety net (10 s) — a keyframe is a burst that
//! a slow link pays for in latency. Each call gives one access unit in Annex B with SPS/PPS
//! in front of every IDR, ready for `VideoDecoder`.

use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, Profile, RateControlMode, UsageType};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::OpenH264API;

pub struct H264 {
    enc: Encoder,
    pub width: u32,
    pub height: u32,
    pub bitrate_kbps: u32,
}

/// OpenH264's SBitrateInfo (ENCODER_OPTION_BITRATE).
#[repr(C)]
struct BitrateInfo {
    layer: u32,
    bitrate: i32,
}
const ENCODER_OPTION_BITRATE: u32 = 5;
const SPATIAL_LAYER_ALL: u32 = 4;

impl H264 {
    /// `width`/`height` must be even (I420).
    pub fn new(width: u32, height: u32, fps: u32, bitrate_kbps: u32) -> Result<Self, String> {
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(bitrate_kbps.saturating_mul(1000)))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .usage_type(UsageType::ScreenContentRealTime)
            .rate_control_mode(RateControlMode::Bitrate)
            .profile(Profile::Baseline)
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps.max(1) * 10))
            .skip_frames(false);
        let enc = Encoder::with_api_config(OpenH264API::from_source(), config).map_err(|e| format!("H.264 인코더를 만들지 못했습니다: {e}"))?;
        Ok(H264 { enc, width, height, bitrate_kbps })
    }

    /// A new target bit rate from the next frame on (no keyframe, the stream goes on).
    pub fn set_bitrate(&mut self, kbps: u32) {
        let mut info = BitrateInfo { layer: SPATIAL_LAYER_ALL, bitrate: kbps.saturating_mul(1000).min(i32::MAX as u32) as i32 };
        // SAFETY: the option and its struct are OpenH264's own (codec_api.h); the encoder is initialized
        let ok = unsafe { self.enc.raw_api().set_option(ENCODER_OPTION_BITRATE as _, std::ptr::addr_of_mut!(info).cast()) } == 0;
        if ok {
            self.bitrate_kbps = kbps;
        }
    }

    /// RGBA (width × height × 4) → (access unit, keyframe). An empty unit means the encoder skipped the frame.
    pub fn encode(&mut self, rgba: &[u8], force_key: bool) -> Result<(Vec<u8>, bool), String> {
        if force_key {
            self.enc.force_intra_frame();
        }
        let yuv = YUVBuffer::from_rgba8_source(RgbaSliceU8::new(rgba, (self.width as usize, self.height as usize)));
        let bits = self.enc.encode(&yuv).map_err(|e| format!("H.264 인코딩 실패: {e}"))?;
        let key = matches!(bits.frame_type(), FrameType::IDR | FrameType::I);
        Ok((bits.to_vec(), key))
    }
}

/// Scale RGBA to at most `max_width` (keeping the aspect) and crop to even sizes for I420.
pub fn fit(frame: crate::appwin::Frame, max_width: u32) -> (Vec<u8>, u32, u32) {
    let (mut w, mut h, mut rgba) = (frame.width, frame.height, frame.rgba);
    if w > max_width {
        let img = image::RgbaImage::from_raw(w, h, rgba).expect("frame size");
        let nh = ((u64::from(h) * u64::from(max_width)) / u64::from(w)).max(2) as u32;
        let scaled = image::imageops::thumbnail(&img, max_width, nh);
        w = scaled.width();
        h = scaled.height();
        rgba = scaled.into_raw();
    }
    let (ew, eh) = (w & !1, h & !1);
    if ew != w || eh != h {
        let mut out = Vec::with_capacity((ew * eh * 4) as usize);
        for row in 0..eh as usize {
            let start = row * w as usize * 4;
            out.extend_from_slice(&rgba[start..start + ew as usize * 4]);
        }
        rgba = out;
    }
    (rgba, ew.max(2), eh.max(2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_keyframe_then_deltas() {
        let (w, h) = (320u32, 180u32);
        let mut enc = H264::new(w, h, 30, 800).unwrap();
        let mut keys = 0;
        let mut first: Option<Vec<u8>> = None;
        for i in 0..40u32 {
            let rgba: Vec<u8> = (0..w * h).flat_map(|p| [((p + i * 3) % 256) as u8, (p % 199) as u8, 90, 255]).collect();
            let (au, key) = enc.encode(&rgba, false).unwrap();
            if key { keys += 1 }
            if first.is_none() { first = Some(au.clone()) }
            assert!(!au.is_empty());
        }
        let first = first.unwrap();
        assert!(first.starts_with(&[0, 0, 0, 1, 0x67]), "IDR access unit starts with an SPS");
        assert!(keys >= 1);
        let (au, key) = enc.encode(&vec![0u8; (w * h * 4) as usize], true).unwrap();
        assert!(key && !au.is_empty(), "forced keyframe");
    }

    /// `cargo test --release encode_speed -- --ignored --nocapture`: ms per 1080p frame (a moving window).
    #[test]
    #[ignore]
    fn encode_speed() {
        let (w, h) = (1920u32, 1080u32);
        let mut enc = H264::new(w, h, 30, 6000).unwrap();
        let mut total = std::time::Duration::ZERO;
        let mut bytes = 0;
        for i in 0..60u32 {
            let rgba: Vec<u8> = (0..w * h).flat_map(|p| { let x = p % w; let bar = x.abs_diff(i * 30) < 60; [if bar { 250 } else { (x % 256) as u8 }, ((p / w) % 256) as u8, 120, 255] }).collect();
            let t = std::time::Instant::now();
            let (au, _) = enc.encode(&rgba, false).unwrap();
            total += t.elapsed();
            bytes += au.len();
        }
        println!("1080p: {:.1} ms/frame, {} kbit/s at 30 fps", total.as_secs_f64() * 1000.0 / 60.0, bytes * 8 * 30 / 60 / 1000);
    }

    #[test]
    fn fit_scales_and_evens() {
        let f = crate::appwin::Frame { width: 1001, height: 601, rgba: vec![7u8; 1001 * 601 * 4] };
        let (rgba, w, h) = fit(f, 500);
        assert_eq!((w % 2, h % 2), (0, 0));
        assert!(w <= 500);
        assert_eq!(rgba.len(), (w * h * 4) as usize);
    }
}
