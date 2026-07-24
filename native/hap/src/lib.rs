//! Native HAP decoder for ArtLux. Opens a HAP-encoded QuickTime/MOV, exposes its frame
//! count + rate, and decodes any frame to RGBA on demand (HAP is all-intra, so every frame
//! decodes independently — ideal for scrubbing/looping). The CPU cost is Snappy decompress
//! + a BC1/BC3/BC7 block decode; there is no fixed-function hardware video-decode session, so
//! the main process can decode many HAP layers at once without the H.264 session limit that
//! freezes mirror windows.
//!
//! Built as a napi-rs cdylib (native/hap/hap.node) loaded in the main process, mirroring the
//! Spout/NDI addons. Frames cross to the sandboxed renderer as RGBA over IPC.

use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Mutex, OnceLock};

mod hap;
mod mov;

use hap::HapFormat;

#[napi(object)]
pub struct HapInfo {
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub fps: f64,
    pub codec: String, // fourcc, e.g. "Hap1" / "Hap5" / "HapY"
    pub has_alpha: bool,
}

#[napi(object)]
pub struct HapFrame {
    pub width: u32,
    pub height: u32,
    pub data: Buffer, // RGBA8, width*height*4
}

#[napi(object)]
pub struct HapBlocks {
    pub width: u32,
    pub height: u32,
    pub format: String, // "dxt1" | "dxt5" | "ycocg" | "rgtc1" | "bptc"
    pub data: Buffer,   // raw GPU-block bytes (uploaded as a compressed texture in the renderer)
}

struct Decoder {
    mov: mov::MovVideo,
    file: File,
}

fn decoders() -> &'static Mutex<HashMap<String, Decoder>> {
    static D: OnceLock<Mutex<HashMap<String, Decoder>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}

fn err(s: impl AsRef<str>) -> napi::Error {
    napi::Error::from_reason(s.as_ref().to_string())
}

/// Open a HAP MOV; parse its index and return stream info. Errors (and the caller falls back
/// to the browser <video>) if the file isn't a HAP-coded MOV.
#[napi]
pub fn open(path: String) -> napi::Result<HapInfo> {
    let v = mov::parse(&path).map_err(err)?;
    if &v.codec[..3] != b"Hap" {
        return Err(err(format!(
            "not a HAP file (codec {})",
            String::from_utf8_lossy(&v.codec)
        )));
    }
    let info = HapInfo {
        width: v.width,
        height: v.height,
        frame_count: v.frames.len() as u32,
        fps: v.fps,
        codec: String::from_utf8_lossy(&v.codec).into_owned(),
        // Hap5 (DXT5) and HapM/HapA carry alpha; Hap1/HapY are opaque.
        has_alpha: matches!(&v.codec, b"Hap5" | b"HapM" | b"HapA"),
    };
    let file = File::open(&path).map_err(|e| err(format!("open {path}: {e}")))?;
    decoders()
        .lock()
        .unwrap()
        .insert(path.clone(), Decoder { mov: v, file });

    // ── REFUSE WHAT WE CANNOT DECODE, HERE, ONCE ────────────────────────────────────────────────
    // The container parse above only proves the fourcc starts with "Hap" — it says nothing about the
    // frame payload, and HAP Q Alpha (HapM) carries a multi-image section this decoder does not read.
    // Without this check `open()` succeeded, `probed()` reported "yes, this is HAP", the codec CLAIMED
    // the file, and then every single frame failed: the renderer's decode-ahead ring re-issues a failed
    // frame on every rAF, so the app sat in a full-speed retry loop — three concurrent decodes per
    // frame, each doing a real seek+read of a multi-MB sample before erroring, each logging a warning —
    // with black on the output. Failing at the door instead makes `probe()` return false, and the host's
    // existing fallback (a plain <video>) takes over with ONE log line.
    //
    // Header-only (no Snappy, no block copy) and only frame 0, so the cost is one small read per file.
    if info.frame_count > 0 {
        if let Err(e) = read_sample(&path, 0).and_then(|(buf, _, _)| hap::probe_frame(&buf).map(|_| ())) {
            decoders().lock().unwrap().remove(&path); // don't hold a handle to a file we refuse to play
            return Err(err(format!("{} [{}]: {e}", path, info.codec)));
        }
    }
    Ok(info)
}

// Read one frame's compressed sample bytes. Holds the decoder lock only for the (fast)
// seek+read so the file cursor stays consistent; the caller does the heavy decode without the
// lock, so concurrent frame decodes run in parallel across worker threads.
fn read_sample(path: &str, index: u32) -> Result<(Vec<u8>, usize, usize), String> {
    let mut map = decoders().lock().unwrap();
    let dec = map.get_mut(path).ok_or("decoder not open")?;
    let i = index as usize;
    if i >= dec.mov.frames.len() {
        return Err("frame index out of range".into());
    }
    let s = dec.mov.frames[i];
    dec.file.seek(SeekFrom::Start(s.offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; s.size as usize];
    dec.file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok((buf, dec.mov.width as usize, dec.mov.height as usize))
}

fn fmt_name(f: HapFormat) -> &'static str {
    match f {
        HapFormat::Dxt1 => "dxt1",
        HapFormat::Dxt5 => "dxt5",
        HapFormat::ScaledYCoCg => "ycocg",
        HapFormat::Rgtc1 => "rgtc1",
        HapFormat::Bptc => "bptc",
    }
}

// --- RGBA path (used by the standalone test script / fallback) ---
fn decode_rgba(path: &str, index: u32) -> Result<(u32, u32, Vec<u8>), String> {
    let (buf, w, h) = read_sample(path, index)?;
    let decoded = hap::decode_frame(&buf)?;
    let rgba = blocks_to_rgba(&decoded, w, h)?;
    Ok((w as u32, h as u32, rgba))
}

pub struct DecodeTask {
    path: String,
    index: u32,
}
impl Task for DecodeTask {
    type Output = (u32, u32, Vec<u8>);
    type JsValue = HapFrame;
    fn compute(&mut self) -> napi::Result<Self::Output> {
        decode_rgba(&self.path, self.index).map_err(err)
    }
    fn resolve(&mut self, _env: Env, o: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(HapFrame { width: o.0, height: o.1, data: o.2.into() })
    }
}

/// Decode frame `index` to RGBA, asynchronously. Used by the test script; the app uses the
/// cheaper block path below.
#[napi]
pub fn decode_frame(path: String, index: u32) -> AsyncTask<DecodeTask> {
    AsyncTask::new(DecodeTask { path, index })
}

// --- Compressed-block path (the app path: ~8× less data; the renderer GPU-decompresses) ---
fn decode_blocks(path: &str, index: u32) -> Result<(u32, u32, String, Vec<u8>), String> {
    let (buf, w, h) = read_sample(path, index)?;
    let decoded = hap::decode_frame(&buf)?;
    Ok((w as u32, h as u32, fmt_name(decoded.format).to_string(), decoded.data))
}

pub struct BlocksTask {
    path: String,
    index: u32,
}
impl Task for BlocksTask {
    type Output = (u32, u32, String, Vec<u8>);
    type JsValue = HapBlocks;
    fn compute(&mut self) -> napi::Result<Self::Output> {
        decode_blocks(&self.path, self.index).map_err(err)
    }
    fn resolve(&mut self, _env: Env, o: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(HapBlocks { width: o.0, height: o.1, format: o.2, data: o.3.into() })
    }
}

/// Decode frame `index` to its raw GPU blocks (DXT/BC), asynchronously. All-intra, runs on
/// libuv's threadpool. The renderer uploads these as a compressed texture (GPU decompresses).
#[napi]
pub fn decode_frame_blocks(path: String, index: u32) -> AsyncTask<BlocksTask> {
    AsyncTask::new(BlocksTask { path, index })
}

#[napi]
pub fn close(path: String) {
    decoders().lock().unwrap().remove(&path);
}

/// Decode the raw GPU-block bytes to RGBA8. For HapQ (scaled YCoCg in DXT5) we apply the
/// standard scaled-YCoCg→RGB conversion after the BC3 decode.
fn blocks_to_rgba(d: &hap::Decoded, w: usize, h: usize) -> Result<Vec<u8>, String> {
    let mut img = vec![0u32; w * h];
    match d.format {
        HapFormat::Dxt1 => texture2ddecoder::decode_bc1(&d.data, w, h, &mut img)?,
        HapFormat::Dxt5 | HapFormat::ScaledYCoCg => {
            texture2ddecoder::decode_bc3(&d.data, w, h, &mut img)?
        }
        HapFormat::Rgtc1 => texture2ddecoder::decode_bc4(&d.data, w, h, &mut img)?,
        HapFormat::Bptc => texture2ddecoder::decode_bc7(&d.data, w, h, &mut img)?,
    }

    // texture2ddecoder packs each pixel as 0xAARRGGBB.
    let scaled = d.format == HapFormat::ScaledYCoCg;
    let mut out = vec![0u8; w * h * 4];
    for (i, &c) in img.iter().enumerate() {
        let (r, g, b, a) = (
            ((c >> 16) & 0xff) as f32,
            ((c >> 8) & 0xff) as f32,
            (c & 0xff) as f32,
            ((c >> 24) & 0xff) as f32,
        );
        let o = i * 4;
        if scaled {
            // HAP ScaledCoCgYToRGBA: r=Co, g=Cg, b=scale, a=Y (all 0..255).
            let scale = b / 8.0 + 1.0;
            let co = (r - 128.0) / scale;
            let cg = (g - 128.0) / scale;
            let y = a;
            out[o] = (y + co - cg).clamp(0.0, 255.0) as u8;
            out[o + 1] = (y + cg).clamp(0.0, 255.0) as u8;
            out[o + 2] = (y - co - cg).clamp(0.0, 255.0) as u8;
            out[o + 3] = 255;
        } else {
            out[o] = r as u8;
            out[o + 1] = g as u8;
            out[o + 2] = b as u8;
            out[o + 3] = a as u8;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a single-texture HAP frame header for the given compressor/format nibble.
    fn header(len: usize, compressor: u8, format: u8) -> Vec<u8> {
        vec![
            (len & 0xff) as u8,
            ((len >> 8) & 0xff) as u8,
            ((len >> 16) & 0xff) as u8,
            (compressor << 4) | format,
        ]
    }

    #[test]
    fn decodes_uncompressed_dxt1_section() {
        // One DXT1 block (8 bytes) stored uncompressed.
        let payload = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let mut frame = header(payload.len(), 0xA, 0x0B); // None, RGB_DXT1
        frame.extend_from_slice(&payload);
        let d = hap::decode_frame(&frame).unwrap();
        assert_eq!(d.format, HapFormat::Dxt1);
        assert_eq!(d.data, payload);
    }

    // THE VARIANT WE REFUSE, AND THE REASON THE REFUSAL EXISTS. A HapM sample opens with a
    // Multi-Image section (0x0D) whose payload is two complete single-texture sections. Before
    // `probe_frame`, this reached the app as "valid HAP" and then failed on every frame forever.
    // Both doors must agree: probe_frame (open) and decode_frame (playback).
    #[test]
    fn refuses_multi_image_hapm() {
        // Multi-image container holding one YCoCg-DXT5 image (the real thing also carries an RGTC1
        // alpha image; one is enough to prove the container itself is rejected).
        let payload: Vec<u8> = (0..64u8).collect();
        let mut inner = header(payload.len(), 0xA, 0x0F); // None, ScaledYCoCg
        inner.extend_from_slice(&payload);
        let mut frame = vec![
            (inner.len() & 0xff) as u8,
            ((inner.len() >> 8) & 0xff) as u8,
            ((inner.len() >> 16) & 0xff) as u8,
            0x0D, // Multi-Image — the WHOLE type byte, not a compressor/format nibble pair
        ];
        frame.extend_from_slice(&inner);

        let probe = hap::probe_frame(&frame).unwrap_err();
        assert!(probe.contains("HapM"), "probe must name the variant, got: {probe}");
        let decode = hap::decode_frame(&frame).err().expect("decode must refuse it too");
        assert!(decode.contains("HapM"), "decode must agree with probe, got: {decode}");
    }

    #[test]
    fn probe_accepts_what_decode_accepts() {
        let payload: Vec<u8> = (0..64u8).collect();
        let compressed = snap::raw::Encoder::new().compress_vec(&payload).unwrap();
        let mut frame = header(compressed.len(), 0xB, 0x0F); // Snappy, ScaledYCoCg (Hap Q)
        frame.extend_from_slice(&compressed);
        assert_eq!(hap::probe_frame(&frame).unwrap(), HapFormat::ScaledYCoCg);
        assert_eq!(hap::decode_frame(&frame).unwrap().format, HapFormat::ScaledYCoCg);
    }

    #[test]
    fn decodes_snappy_dxt5_section() {
        let payload: Vec<u8> = (0..64u8).collect();
        let compressed = snap::raw::Encoder::new().compress_vec(&payload).unwrap();
        let mut frame = header(compressed.len(), 0xB, 0x0E); // Snappy, RGBA_DXT5
        frame.extend_from_slice(&compressed);
        let d = hap::decode_frame(&frame).unwrap();
        assert_eq!(d.format, HapFormat::Dxt5);
        assert_eq!(d.data, payload);
    }
}
