//! Encoded-video framing for the live screen (F-07b): ffmpeg writes a raw stream to stdout; these parsers
//! cut it into access units / frames that the browser's WebCodecs `VideoDecoder` takes one at a time.
//!   H.264 Annex B → access units (all NAL units of one picture, start codes kept; keyframe = contains IDR)
//!   IVF (VP8/VP9) → frames (keyframe = VP8 frame tag bit 0 clear)

/// Splits an H.264 Annex B byte stream into access units.
/// A new picture starts at an AUD/SPS/PPS/SEI after a slice, or at a slice whose first_mb_in_slice is 0
/// (first slice-header bit set) after a slice — so multi-slice pictures (x264 zerolatency) stay whole.
#[derive(Default)]
pub struct AnnexB {
    buf: Vec<u8>,
    au: Vec<u8>,
    au_has_vcl: bool,
    au_key: bool,
}

fn start_code_at(b: &[u8], i: usize) -> Option<usize> {
    if i + 3 <= b.len() && b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
        return Some(3);
    }
    if i + 4 <= b.len() && b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 0 && b[i + 3] == 1 {
        return Some(4);
    }
    None
}

impl AnnexB {
    /// Feed bytes; returns the access units completed by them: (bytes, keyframe).
    pub fn push(&mut self, data: &[u8]) -> Vec<(Vec<u8>, bool)> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        // positions of start codes currently in the buffer
        let mut starts = Vec::new();
        let mut i = 0;
        while i + 3 <= self.buf.len() {
            if let Some(len) = start_code_at(&self.buf, i) {
                starts.push((i, len));
                i += len;
            } else {
                i += 1;
            }
        }
        if starts.len() < 2 {
            return out; // no complete NAL yet (the last one ends only when the next start code arrives)
        }
        let mut consumed = 0;
        for w in starts.windows(2) {
            let (s, len) = w[0];
            let end = w[1].0;
            let nal = self.buf[s + len..end].to_vec();
            self.nal(&nal, &mut out);
            consumed = end;
        }
        self.buf.drain(..consumed);
        out
    }

    fn flush(&mut self, out: &mut Vec<(Vec<u8>, bool)>) {
        if self.au_has_vcl {
            out.push((std::mem::take(&mut self.au), self.au_key));
        } else {
            self.au.clear();
        }
        self.au_has_vcl = false;
        self.au_key = false;
    }

    fn nal(&mut self, nal: &[u8], out: &mut Vec<(Vec<u8>, bool)>) {
        // trailing zero bytes belong to the next start code (00 00 00 01)
        let mut nal = nal;
        while let [rest @ .., 0] = nal {
            nal = rest;
        }
        if nal.is_empty() {
            return;
        }
        let kind = nal[0] & 0x1f;
        let vcl = kind == 1 || kind == 5;
        if vcl {
            let first_mb_zero = nal.get(1).map(|b| b & 0x80 != 0).unwrap_or(true);
            if self.au_has_vcl && first_mb_zero {
                self.flush(out);
            }
            self.au_has_vcl = true;
            if kind == 5 {
                self.au_key = true;
            }
        } else if matches!(kind, 6..=9) && self.au_has_vcl {
            self.flush(out);
        }
        self.au.extend_from_slice(&[0, 0, 0, 1]);
        self.au.extend_from_slice(nal);
    }
}

/// Splits an IVF stream (32-byte header, then 12-byte frame headers) into frames.
#[derive(Default)]
pub struct Ivf {
    buf: Vec<u8>,
    header_done: bool,
}

impl Ivf {
    pub fn push(&mut self, data: &[u8]) -> Vec<(Vec<u8>, bool)> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        if !self.header_done {
            if self.buf.len() < 32 {
                return out;
            }
            let header_len = u16::from_le_bytes([self.buf[6], self.buf[7]]) as usize;
            if self.buf.len() < header_len.max(32) {
                return out;
            }
            self.buf.drain(..header_len.max(32));
            self.header_done = true;
        }
        let mut pos = 0;
        while self.buf.len() >= pos + 12 {
            let size = u32::from_le_bytes([self.buf[pos], self.buf[pos + 1], self.buf[pos + 2], self.buf[pos + 3]]) as usize;
            if self.buf.len() < pos + 12 + size {
                break;
            }
            let frame = self.buf[pos + 12..pos + 12 + size].to_vec();
            let key = frame.first().map(|b| b & 1 == 0).unwrap_or(false);
            out.push((frame, key));
            pos += 12 + size;
        }
        self.buf.drain(..pos);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annexb_groups_slices_and_marks_idr() {
        // SPS, PPS, IDR slice (first_mb 0), IDR slice (first_mb != 0: second slice of the same picture),
        // then a P slice (first_mb 0) = new picture, then an AUD to close it
        let sps = [0x67, 0x42, 0xc0, 0x1f, 0xaa];
        let pps = [0x68, 0xce, 0x3c, 0x80];
        let idr1 = [0x65, 0x88, 0x84, 0x00, 0x11];
        let idr2 = [0x65, 0x41, 0x9a, 0x02];
        let p = [0x41, 0x9a, 0x22, 0x33];
        let aud = [0x09, 0xf0];
        let mut stream = vec![];
        for n in [&sps[..], &pps, &idr1, &idr2, &p, &aud] {
            stream.extend_from_slice(&[0, 0, 0, 1]);
            stream.extend_from_slice(n);
        }
        stream.extend_from_slice(&[0, 0, 1, 0x41, 0x9a]); // next picture starts (incomplete)
        let mut parser = AnnexB::default();
        // byte-by-byte feeding must give the same result as one chunk
        let mut aus = vec![];
        for b in &stream {
            aus.extend(parser.push(&[*b]));
        }
        assert_eq!(aus.len(), 2);
        assert!(aus[0].1, "first AU has the IDR");
        assert_eq!(aus[0].0.iter().filter(|&&b| b == 0x65).count() >= 2, true);
        assert!(aus[0].0.starts_with(&[0, 0, 0, 1, 0x67]));
        assert!(!aus[1].1);
        assert!(aus[1].0.starts_with(&[0, 0, 0, 1, 0x41]));
    }

    #[test]
    fn ivf_frames() {
        let mut s = vec![0u8; 32];
        s[..4].copy_from_slice(b"DKIF");
        s[6] = 32;
        for (i, key) in [(0u8, true), (1, false)] {
            let data = [if key { 0x10 } else { 0x11 }, i, i];
            s.extend_from_slice(&(data.len() as u32).to_le_bytes());
            s.extend_from_slice(&(i as u64).to_le_bytes());
            s.extend_from_slice(&data);
        }
        let mut p = Ivf::default();
        let (a, b) = s.split_at(40);
        let mut frames = p.push(a);
        frames.extend(p.push(b));
        assert_eq!(frames.len(), 2);
        assert!(frames[0].1 && !frames[1].1);
    }
}
