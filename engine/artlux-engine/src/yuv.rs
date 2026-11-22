//! Item 2c — a decoded MP4 frame (NV12) → the picture today's `drawImage(VideoFrame)` makes of it.
//!
//! MEASURED against Chromium on this machine (scripts/test-mp4-parity.cjs: the app's real mp4Decoder, its
//! VideoFrame drawn 1:1 into a 2D canvas, against these planes):
//!   - BT.709, LIMITED range (Y 16–235, C 16–240), the standard's coefficients;
//!   - chroma upsampled BILINEAR, CENTRE-sited (a chroma sample sits between its 2×2 luma), clamped at the
//!     CODED edge — Chromium reads the encoder's padding past the visible edge (with the visible edge as
//!     the clamp, the last row and an odd last column were off by up to 106);
//!   - rounded to nearest.
//! That is within 1 of Chromium on every channel, and identical on all but ~0.25% of them: values within
//! about 0.0075 of a rounding boundary, which Chromium's own float arithmetic rounds the other way. That
//! residue has no structure to copy (a least-squares fit on Y, U, V and the neighbours finds nothing that
//! holds across files; neither a constant nor a proportional offset, nor 8/16-bit chroma quantisation, fits).
//! The whole CODED frame is converted; `Picture::coded_frame` draws its visible rect.
//!
//! Accepted: BT.709 matrix + primaries, limited range, with the BT.709 OR the sRGB (iec61966-2-1) transfer —
//! Chromium draws both onto the sRGB canvas with no transfer conversion (measured: synthetic BT.709 files
//! and two real sRGB-transfer clips, same result). Other colour spaces are REFUSED (the app keeps the
//! surface): BT.601 / BT.2020 / full range / HDR transfers may be colour-converted by Chromium, unmeasured.

use crate::compose::Picture;

/// One decoded frame, as `VideoFrame.copyTo({rect: codedRect})` lays it out (and as the engine's decoder
/// will): the Y plane, then interleaved UV at half resolution.
pub struct Nv12<'a> {
    pub coded: (u32, u32),
    pub visible: [u32; 4],
    pub y: &'a [u8],
    pub y_stride: usize,
    pub uv: &'a [u8],
    pub uv_stride: usize,
}

/// The colour spaces the engine draws as the app does, by the VideoFrame's `colorSpace`.
pub fn accepts(matrix: Option<&str>, full_range: Option<bool>, primaries: Option<&str>, transfer: Option<&str>) -> Result<(), String> {
    let ok = matrix == Some("bt709") && full_range == Some(false) && primaries == Some("bt709")
        && matches!(transfer, Some("bt709") | Some("iec61966-2-1"));
    if ok { Ok(()) } else {
        Err(format!("a video in colour space {}/{}/{}/{} (the engine draws BT.709 limited range only)",
            matrix.unwrap_or("?"), primaries.unwrap_or("?"), transfer.unwrap_or("?"), match full_range { Some(true) => "full", Some(false) => "limited", None => "?" }))
    }
}

/// BT.709 → RGB, limited range, in 8-bit units.
const KR: f64 = 0.2126;
const KB: f64 = 0.0722;

pub fn to_picture(f: &Nv12) -> Picture {
    let (w, h) = f.coded;
    let (cw, ch) = ((w / 2) as i64, (h / 2) as i64);
    let kg = 1.0 - KR - KB;
    let ys = 255.0 / 219.0;
    let cs = 255.0 / 224.0;
    let (rv, gu, gv, bu) = (2.0 * (1.0 - KR) * cs, -2.0 * (1.0 - KB) * KB / kg * cs, -2.0 * (1.0 - KR) * KR / kg * cs, 2.0 * (1.0 - KB) * cs);
    let at = |x: i64, y: i64, k: usize| -> u32 { f.uv[y.clamp(0, ch - 1) as usize * f.uv_stride + x.clamp(0, cw - 1) as usize * 2 + k] as u32 };
    let mut out = vec![0u8; (w * h * 4) as usize];
    for y in 0..h as i64 {
        // Centre-sited: luma row y sits at chroma row (y + 0.5) / 2 − 0.5.
        // fy = the weight of the SECOND tap (y0 + 1), in quarters: 3/4 for an even row, 1/4 for an odd one.
        let (y0, fy) = if y % 2 == 0 { (y / 2 - 1, 3u32) } else { ((y - 1) / 2, 1u32) };
        for x in 0..w as i64 {
            let (x0, fx) = if x % 2 == 0 { (x / 2 - 1, 3u32) } else { ((x - 1) / 2, 1u32) };
            let mut c = [0f64; 2];
            for (k, ck) in c.iter_mut().enumerate() {
                // Exact: the bilinear weights are sixteenths.
                let a = at(x0, y0, k) * (4 - fx) * (4 - fy) + at(x0 + 1, y0, k) * fx * (4 - fy) + at(x0, y0 + 1, k) * (4 - fx) * fy + at(x0 + 1, y0 + 1, k) * fx * fy;
                *ck = a as f64 / 16.0;
            }
            let l = (f.y[y as usize * f.y_stride + x as usize] as f64 - 16.0) * ys;
            let (u, v) = (c[0] - 128.0, c[1] - 128.0);
            let rgb = [l + rv * v, l + gu * u + gv * v, l + bu * u];
            let o = ((y as u32 * w + x as u32) * 4) as usize;
            for k in 0..3 { out[o + k] = rgb[k].round().clamp(0.0, 255.0) as u8; }
            out[o + 3] = 255;
        }
    }
    Picture::coded_frame(w, h, out, f.visible)
}
