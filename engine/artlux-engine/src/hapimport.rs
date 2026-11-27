//! E0d — HAP INTO THE ENGINE AS WHAT IT IS: GPU BLOCKS (plan §3 "zero-copy imports", §9 E0).
//!
//! A HAP frame is BC (DXT) texture data behind an optional Snappy stage. So the engine's path is:
//! container → frame bytes → un-Snappy → the blocks, uploaded AS A BC TEXTURE. The GPU decodes the
//! blocks as it samples; no RGBA frame ever exists on the CPU. (Today's app decodes HAP to RGBA on the
//! CPU in native/hap/src/lib.rs.) Where an adapter lacks BC, the FALLBACK decodes on the CPU and uploads
//! RGBA — plan §8 risk 4: every source keeps a CPU-upload path from day one.
//!
//! The container and HAP parsers are the APP'S OWN (native/hap/src/mov.rs, hap.rs), compiled in here by
//! path — one parser, not two that drift.

#[path = "../../../native/hap/src/hap.rs"]
#[allow(dead_code)]
pub mod hap;
#[path = "../../../native/hap/src/mov.rs"]
#[allow(dead_code)]
pub mod mov;

use crate::{sample_points, EngineError, Gpu};
use hap::HapFormat;
use std::io::{Read, Seek, SeekFrom};

/// The BC format a HAP texture uploads as. (HapQ is scaled YCoCg in BC3: the blocks upload as BC3 and
/// the colour transform is a shader's job — the same split as today's GL path.)
pub fn bc_format(f: HapFormat) -> wgpu::TextureFormat {
    match f {
        HapFormat::Dxt1 => wgpu::TextureFormat::Bc1RgbaUnorm,
        HapFormat::Dxt5 | HapFormat::ScaledYCoCg => wgpu::TextureFormat::Bc3RgbaUnorm,
        HapFormat::Rgtc1 => wgpu::TextureFormat::Bc4RUnorm,
        HapFormat::Bptc => wgpu::TextureFormat::Bc7RgbaUnorm,
    }
}

fn block_bytes(f: HapFormat) -> u32 {
    match f {
        HapFormat::Dxt1 | HapFormat::Rgtc1 => 8,
        _ => 16,
    }
}

pub fn has_bc(gpu: &Gpu) -> bool {
    gpu.device.features().contains(wgpu::Features::TEXTURE_COMPRESSION_BC)
}

/// The blocks as a BC texture. `w`, `h` are the picture's size; a BC texture's size is whole 4×4 blocks.
pub fn upload_bc(gpu: &Gpu, f: HapFormat, w: u32, h: u32, blocks: &[u8]) -> Result<wgpu::Texture, EngineError> {
    let (bw, bh) = (w.div_ceil(4), h.div_ceil(4));
    let need = (bw * bh * block_bytes(f)) as usize;
    if blocks.len() < need {
        return Err(EngineError::Gpu(format!("HAP frame holds {} bytes of blocks, a {w}x{h} {f:?} needs {need}", blocks.len())));
    }
    let size = wgpu::Extent3d { width: bw * 4, height: bh * 4, depth_or_array_layers: 1 };
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("hap (BC)"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: bc_format(f),
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        tex.as_image_copy(),
        &blocks[..need],
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bw * block_bytes(f)), rows_per_image: Some(bh) },
        size,
    );
    Ok(tex)
}

/// The CPU decode of the blocks to RGBA8 (the fallback's upload, and the reference the GPU is held to).
/// Raw block colours: HapQ's YCoCg transform is not applied, matching what the BC texture samples to.
pub fn cpu_rgba(f: HapFormat, w: u32, h: u32, blocks: &[u8]) -> Result<Vec<u8>, String> {
    let (pw, ph) = (w.div_ceil(4) as usize * 4, h.div_ceil(4) as usize * 4);
    let mut img = vec![0u32; pw * ph];
    match f {
        HapFormat::Dxt1 => texture2ddecoder::decode_bc1(blocks, pw, ph, &mut img)?,
        HapFormat::Dxt5 | HapFormat::ScaledYCoCg => texture2ddecoder::decode_bc3(blocks, pw, ph, &mut img)?,
        HapFormat::Rgtc1 => texture2ddecoder::decode_bc4(blocks, pw, ph, &mut img)?,
        HapFormat::Bptc => texture2ddecoder::decode_bc7(blocks, pw, ph, &mut img)?,
    }
    // texture2ddecoder packs 0xAARRGGBB.
    Ok(img.iter().flat_map(|&c| [(c >> 16) as u8, (c >> 8) as u8, c as u8, (c >> 24) as u8]).collect())
}

pub fn upload_rgba(gpu: &Gpu, w: u32, h: u32, rgba: &[u8]) -> wgpu::Texture {
    let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("hap (CPU fallback)"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        tex.as_image_copy(),
        rgba,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
        size,
    );
    tex
}

/// Pixel-centre UVs on a `cols`×`rows` grid over a `tw`×`th` texture (exact in f32 for any size whose
/// pixel centres the grid lands on — the CPU side indexes the same pixels with the same math).
pub fn grid_uvs(tw: u32, th: u32, cols: u32, rows: u32) -> Vec<[f32; 2]> {
    let mut v = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let x = (c * tw) / cols + tw / (2 * cols);
            let y = (r * th) / rows + th / (2 * rows);
            v.push([(x as f32 + 0.5) / tw as f32, (y as f32 + 0.5) / th as f32]);
        }
    }
    v
}

pub fn cpu_sample(rgba: &[u8], tw: u32, th: u32, uvs: &[[f32; 2]]) -> Vec<u8> {
    let mut out = Vec::new();
    for [u, v] in uvs {
        let x = ((u * tw as f32) as u32).min(tw - 1);
        let y = ((v * th as f32) as u32).min(th - 1);
        let i = ((y * tw + x) * 4) as usize;
        out.extend_from_slice(&rgba[i..i + 3]);
    }
    out
}

// ── THE SELF-TEST PART: synthetic BC1, exact ────────────────────────────────────────────────────────
// An 8×8 BC1 texture of four SOLID blocks — red, green, blue, white. Both endpoints equal and every
// index 0, so a block decodes to its endpoint exactly on any conformant decoder (565 → 888 by bit
// replication: 31 → 255, 63 → 255). The HAP section wrapper around it goes through the app's hap.rs.

pub const BC1_GOLDEN: [u8; 12] = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];

fn bc1_solid(c565: u16) -> [u8; 8] {
    let c = c565.to_le_bytes();
    [c[0], c[1], c[0], c[1], 0, 0, 0, 0]
}

/// A HAP frame (uncompressed section, type 0xAB = no compressor, DXT1) holding the four blocks.
pub fn synthetic_hap_frame() -> Vec<u8> {
    let mut blocks = Vec::new();
    for c in [0xF800u16, 0x07E0, 0x001F, 0xFFFF] { blocks.extend_from_slice(&bc1_solid(c)); }
    let len = blocks.len() as u32;
    let mut f = vec![(len & 0xFF) as u8, ((len >> 8) & 0xFF) as u8, ((len >> 16) & 0xFF) as u8, 0xAB];
    f.extend_from_slice(&blocks);
    f
}

/// Decode the synthetic frame with hap.rs, upload it (BC, or the fallback), sample the four blocks.
pub fn bc_selftest(gpu: &Gpu) -> Result<(Vec<u8>, &'static str), EngineError> {
    let d = hap::decode_frame(&synthetic_hap_frame()).map_err(EngineError::Gpu)?;
    // Blocks in row order: (0,0) red, (1,0) green, (0,1) blue, (1,1) white.
    let uvs = [[2.5 / 8.0, 2.5 / 8.0], [6.5 / 8.0, 2.5 / 8.0], [2.5 / 8.0, 6.5 / 8.0], [6.5 / 8.0, 6.5 / 8.0]];
    if has_bc(gpu) {
        let tex = upload_bc(gpu, d.format, 8, 8, &d.data)?;
        Ok((sample_points(gpu, &tex, &uvs)?, "BC texture"))
    } else {
        let rgba = cpu_rgba(d.format, 8, 8, &d.data).map_err(EngineError::Gpu)?;
        let tex = upload_rgba(gpu, 8, 8, &rgba);
        Ok((sample_points(gpu, &tex, &uvs)?, "CPU-decode fallback"))
    }
}

// ── A REAL FILE ─────────────────────────────────────────────────────────────────────────────────────

pub struct FileReport {
    pub codec: String,
    pub size: (u32, u32),
    pub format: HapFormat,
    pub frame: usize,
    pub frames: usize,
    pub points: usize,
    pub gpu_path: &'static str,
    /// Points where the GPU-decoded BC sample equals the CPU decode exactly, and the largest channel
    /// difference where it does not (BC1/BC3 interpolation may round differently in hardware).
    pub exact: usize,
    pub max_diff: u8,
    /// The CPU-upload fallback must match the CPU decode EXACTLY (it is the same pixels).
    pub fallback_exact: bool,
}

pub fn check_file(gpu: &Gpu, path: &str, frame: usize) -> Result<FileReport, String> {
    let v = mov::parse(path)?;
    let codec = String::from_utf8_lossy(&v.codec).to_string();
    let n = v.frames.len();
    let s = *v.frames.get(frame.min(n.saturating_sub(1))).ok_or("the file has no video frames")?;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(s.offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; s.size as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let d = hap::decode_frame(&buf)?;
    let (tw, th) = (v.width.div_ceil(4) * 4, v.height.div_ceil(4) * 4);
    let reference = cpu_rgba(d.format, v.width, v.height, &d.data)?;
    let uvs = grid_uvs(tw, th, 48, 27);
    let want = cpu_sample(&reference, tw, th, &uvs);
    let (gpu_px, gpu_path) = if has_bc(gpu) {
        let tex = upload_bc(gpu, d.format, v.width, v.height, &d.data).map_err(|e| e.to_string())?;
        (sample_points(gpu, &tex, &uvs).map_err(|e| e.to_string())?, "BC texture (GPU decodes the blocks)")
    } else {
        (Vec::new(), "no BC on this adapter")
    };
    let (mut exact, mut max_diff) = (0, 0u8);
    for (g, w) in gpu_px.chunks(3).zip(want.chunks(3)) {
        let m = g.iter().zip(w).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
        if m == 0 { exact += 1; }
        max_diff = max_diff.max(m);
    }
    let fb = upload_rgba(gpu, tw, th, &reference);
    let fallback_exact = sample_points(gpu, &fb, &uvs).map_err(|e| e.to_string())? == want;
    Ok(FileReport { codec, size: (v.width, v.height), format: d.format, frame: frame.min(n - 1), frames: n, points: uvs.len(), gpu_path, exact, max_diff, fallback_exact })
}

// ── A FRAME AS A SOURCE (E1d-2) ─────────────────────────────────────────────────────────────────────

/// Frame `frame` of a HAP file (clamped to the last), as blocks: (width, height, format, blocks, frame count).
pub fn read_frame(path: &str, frame: usize) -> Result<(u32, u32, HapFormat, Vec<u8>, usize), String> {
    let v = mov::parse(path)?;
    let n = v.frames.len();
    let s = *v.frames.get(frame.min(n.saturating_sub(1))).ok_or("the file has no video frames")?;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(s.offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; s.size as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let d = hap::decode_frame(&buf)?;
    Ok((v.width, v.height, d.format, d.data, n))
}

/// H4K (2026-11-26): ONE HAP FILE, PARSED ONCE AND KEPT OPEN, READ AHEAD. `read_frame` re-parsed the file's index,
/// re-opened it, read and unpacked the frame on the render thread, every new frame — 4–7 ms a 4K HAP Q / Alpha frame
/// (measured), on the thread that also draws, samples and packs. A worker thread now reads and unpacks the NEXT frame
/// (the one after the one asked for: a playing surface's next) while the render thread draws this one; a jump (a seek,
/// a scene) waits for the frame asked for, as before. One request in flight at a time.
use std::sync::Arc;

pub struct HapIn {
    pub path: String,
    pub w: u32,
    pub h: u32,
    /// The file's frame rate and frame count — mov.rs, the SAME parser as the app's hap.node, so the same numbers.
    pub fps: f64,
    pub n: usize,
    tx: std::sync::mpsc::Sender<usize>,
    rx: std::sync::mpsc::Receiver<(usize, Result<(HapFormat, Vec<u8>), String>)>,
    /// O3-5: frames asked for and not back yet, and frames back and not used yet (by index — the replies say which).
    asked: Vec<usize>,
    ready: Vec<(usize, Result<(HapFormat, Vec<u8>), String>)>,
}

/// O3-5: two readers per file — a wanted frame is never queued behind a read-ahead nobody wants (it used to WAIT for
/// that read first: a 60 fps film on a 50 Hz tick, a dropped tick or a scrub cost up to two 4K reads in a row).
const READERS: usize = 2;

impl HapIn {
    pub fn open(path: &str) -> Result<HapIn, String> {
        let v = mov::parse(path)?;
        if v.frames.is_empty() { return Err("the file has no video frames".into()); }
        let frames = Arc::new(v.frames.clone());
        let (tx, ask) = std::sync::mpsc::channel::<usize>();
        let ask = Arc::new(std::sync::Mutex::new(ask));
        let (give, rx) = std::sync::mpsc::channel();
        for k in 0..READERS {
            let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            let (frames, ask, give) = (frames.clone(), ask.clone(), give.clone());
            std::thread::Builder::new().name(format!("hap read {k}")).spawn(move || loop {
                let Ok(i) = ask.lock().unwrap_or_else(|e| e.into_inner()).recv() else { break };
                let s = frames[i.min(frames.len() - 1)];
                let r = (|| {
                    file.seek(SeekFrom::Start(s.offset)).map_err(|e| e.to_string())?;
                    let mut buf = vec![0u8; s.size as usize];
                    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
                    hap::decode_frame(&buf).map(|d| (d.format, d.data))
                })();
                if give.send((i, r)).is_err() { break; }
            }).map_err(|e| e.to_string())?;
        }
        Ok(HapIn { path: path.to_string(), w: v.width, h: v.height, fps: v.fps, n: v.frames.len(), tx, rx, asked: Vec::new(), ready: Vec::new() })
    }

    /// Frame `i` (clamped to the last) as (format, blocks); then the frame after it is read ahead.
    pub fn frame(&mut self, i: usize) -> Result<(HapFormat, Vec<u8>), String> { let n = self.n; self.frame_ahead(i, (i.min(n - 1) + 1) % n) }

    /// O3-5: frame `i`, then `next` read ahead (the caller's prediction — where its clock will be at the next tick).
    /// A frame already back is taken at once; one in flight is waited for (others that land meanwhile are kept, not
    /// waited out); one never asked is asked now. Only the predicted frame is kept beyond this call (memory: one 4K
    /// frame), and at most READERS reads are in flight.
    pub fn frame_ahead(&mut self, i: usize, next: usize) -> Result<(HapFormat, Vec<u8>), String> {
        let (i, next) = (i.min(self.n - 1), next.min(self.n - 1));
        let gone = || "the HAP reader stopped".to_string();
        while let Ok((k, r)) = self.rx.try_recv() { self.asked.retain(|&a| a != k); self.ready.push((k, r)); }
        let r = match self.ready.iter().position(|(k, _)| *k == i) {
            Some(p) => self.ready.swap_remove(p).1,
            None => {
                if !self.asked.contains(&i) { self.tx.send(i).map_err(|_| gone())?; self.asked.push(i); }
                loop {
                    let (k, r) = self.rx.recv().map_err(|_| gone())?;
                    self.asked.retain(|&a| a != k);
                    if k == i { break r; }
                    self.ready.push((k, r));
                }
            }
        };
        self.ready.retain(|(k, _)| *k == next);
        if next != i && !self.asked.contains(&next) && self.ready.is_empty() && self.asked.len() < READERS {
            if self.tx.send(next).is_ok() { self.asked.push(next); }
        }
        r
    }

    /// The frame the app's surface player shows at `clock_s` (hapPlayer.tick: round(clock × fps), looped).
    pub fn index_at(&self, clock_s: f64) -> usize {
        let n = self.n as i64;
        ((((clock_s * self.fps).round() as i64) % n + n) % n) as usize
    }
}

/// The app's names for the formats (native/hap/src/lib.rs's HapFrame.format).
pub fn format_from_str(s: &str) -> Option<HapFormat> {
    Some(match s {
        "dxt1" => HapFormat::Dxt1,
        "dxt5" => HapFormat::Dxt5,
        "ycocg" => HapFormat::ScaledYCoCg,
        "rgtc1" => HapFormat::Rgtc1,
        "bptc" => HapFormat::Bptc,
        _ => return None,
    })
}

#[cfg(test)]
mod reader_tests {
    /// O3-5: the read-ahead reader returns EXACTLY what a direct read of that frame returns, whatever the order it is
    /// asked in — in order, a jump forward, the wrap at the end, a repeat, a scrub backwards, a wrong prediction — with
    /// two readers racing (testdata/hap-64x64-24f.mov: ffmpeg testsrc, every frame different, 4 chunks).
    #[test]
    fn frame_ahead_is_the_direct_read_in_any_order() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/hap-64x64-24f.mov");
        let mut h = super::HapIn::open(path).expect("open");
        assert_eq!(h.n, 24);
        let direct = |i: usize| super::read_frame(path, i).map(|(_, _, f, d, _)| (f, d)).expect("read");
        // (asked, predicted next)
        let asks: &[(usize, usize)] = &[(0, 1), (1, 2), (2, 3), (5, 7), (7, 9), (9, 9), (9, 10), (23, 0), (0, 1), (12, 13), (3, 4), (4, 20), (5, 6), (5, 6), (22, 23)];
        let want: Vec<_> = (0..h.n).map(direct).collect();
        for &(i, next) in asks {
            let got = h.frame_ahead(i, next).expect("frame");
            assert!(got.0 == want[i].0 && got.1 == want[i].1, "frame {i} differs from the direct read");
        }
        // Adversarial: back-to-back asks that mostly DISAGREE with the last prediction, so a read-ahead is still in flight
        // when the next frame is asked — a reader that took whatever reply came first would hand back the wrong frame.
        let mut x = 12345u64;
        for _ in 0..400 {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            let (i, next) = ((x % 24) as usize, ((x >> 8) % 24) as usize);
            let got = h.frame_ahead(i, next).expect("frame");
            assert!(got.0 == want[i].0 && got.1 == want[i].1, "frame {i} differs from the direct read (asked out of order)");
        }
        assert!(h.ready.len() <= 1 && h.asked.len() <= super::READERS, "bounded: {} kept, {} in flight", h.ready.len(), h.asked.len());
    }
}

#[cfg(test)]
mod gpu_picture_tests {
    /// H4K: hap_picture keeps the picture on the GPU and premultiplies in the pass. It must be BIT-IDENTICAL to the old
    /// path (texels read back + compose::premultiply on the CPU) for every format the engine draws. Random bytes are
    /// valid BC1 / BC3 blocks, so every alpha and colour value appears. (Checked on 4K files 2026-11-26 too: a real
    /// alpha ramp, 8.3 M transparent pixels, 0 differ; with the premultiply off, 12.7 M bytes differ.)
    #[test]
    fn hap_picture_on_the_gpu_is_the_old_picture() {
        use super::hap::HapFormat;
        let Ok(gpu) = crate::Gpu::open(crate::AdapterPolicy { allow_software: true, force_software: false }) else { eprintln!("no GPU: skipped"); return };
        if !super::has_bc(&gpu) { eprintln!("no BC textures: skipped"); return; }
        let (w, h) = (96u32, 64u32);
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        for (fmt, mode, bpb) in [(HapFormat::Dxt5, 0u32, 16usize), (HapFormat::Dxt1, 2, 8), (HapFormat::ScaledYCoCg, 1, 16)] {
            let blocks: Vec<u8> = (0..(w / 4 * h / 4) as usize * bpb).map(|_| { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed as u8 }).collect();
            let bc = super::upload_bc(&gpu, fmt, w, h, &blocks).unwrap();
            let mut old = crate::compose::texels(&gpu, &bc, w, h, mode).unwrap();
            crate::compose::premultiply(&mut old);
            let pic = crate::compose::hap_picture(&gpu, fmt, w, h, &blocks).unwrap();
            let new = crate::yuv::read_rgba(&gpu, pic.tex.as_ref().expect("on the GPU"), pic.w, pic.h).unwrap();
            assert!(pic.rgba.is_empty(), "no CPU copy");
            let see_through = old.chunks(4).filter(|p| p[3] != 255).count();
            assert_eq!(old, new, "{fmt:?}: {} bytes differ", old.iter().zip(&new).filter(|(a, b)| a != b).count());
            if fmt == HapFormat::Dxt5 { assert!(see_through > 1000, "the test must cover alpha ({see_through})"); }
        }
    }
}

#[cfg(test)]
mod o5_bench {
    /// O5-4 measurement: per file in ARTLUX_HAP_FILES (`;`), the second-stage compressor of frame 0 and the decode time
    /// of 60 frames (un-Snappy only, what hap.read pays). Prints `HAPBENCH path ty=0x.. chunks? ms/frame`.
    #[test]
    fn hap_decode_bench() {
        use std::io::{Read, Seek, SeekFrom};
        for p in std::env::var("ARTLUX_HAP_FILES").unwrap_or_default().split(';').filter(|p| !p.is_empty()) {
            let mv = super::mov::parse(p).unwrap();
            let mut f = std::fs::File::open(p).unwrap();
            let mut bufs = Vec::new();
            for s in mv.frames.iter().take(60) {
                let mut b = vec![0u8; s.size as usize];
                f.seek(SeekFrom::Start(s.offset)).unwrap(); f.read_exact(&mut b).unwrap(); bufs.push(b);
            }
            let ty = bufs[0][3];
            let t = std::time::Instant::now();
            let mut n = 0usize;
            for b in &bufs { n += super::hap::decode_frame(b).unwrap().data.len(); }
            println!("HAPBENCH {p} ty=0x{ty:02X} {}x{} {:.2} ms/frame ({} MB/frame)", mv.width, mv.height,
                t.elapsed().as_secs_f64() * 1e3 / bufs.len() as f64, n / bufs.len() / 1_000_000);
        }
    }
}
