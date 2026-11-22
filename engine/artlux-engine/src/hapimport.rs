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
