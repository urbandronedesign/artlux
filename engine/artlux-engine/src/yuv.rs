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

// ── Item 2c-3: the SAME conversion on the GPU ───────────────────────────────────────────────────────────
// The planes as two textures (Y: R8, UV: RG8 — what a hardware decoder's NV12 texture gives as plane views
// too), one compute pass writing the RGBA picture the atlas draws. The arithmetic is to_picture's: the
// plane values back as integers (round(v × 255) of an 8-bit UNORM is exact), the chroma weights in SIXTEENTHS
// (integer, exact), the matrix in f32 — and then NO explicit rounding: the value / 255 goes to the RGBA8
// store and THE GPU'S OWN float→UNORM conversion rounds it, as it does for Chromium's shader.
//
// That last choice was MEASURED, and it is where 2c-1's "unstructured" residue came from. Rounding
// explicitly (round half up — the CPU's rule) left 0.21–0.27% of channels off by one from Chromium; letting
// the store round leaves 0.009–0.015%. The store's rounding is the hardware's (the D3D rules allow it a
// tolerance, and a round-to-nearest emulation on the CPU did NOT reproduce it), so the engine gets it the
// same way Chromium does: by storing on the same GPU. Also tried, no better: the hardware's bilinear filter
// for the chroma, and Skia's matrix-and-bias form on normalised samples. What remains (~0.01%) is float
// ordering inside Chromium's shader.

const CONVERT_WGSL: &str = r#"
@group(0) @binding(0) var ytex: texture_2d<f32>;
@group(0) @binding(1) var uvtex: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;

fn chroma(p: vec2<i32>, cs: vec2<i32>) -> vec2<i32> {
    let q = clamp(p, vec2<i32>(0, 0), cs - vec2<i32>(1, 1));   // clamped at the CODED edge
    return vec2<i32>(floor(textureLoad(uvtex, q, 0).rg * 255.0 + 0.5));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(ytex);
    if (id.x >= size.x || id.y >= size.y) { return; }
    let cs = vec2<i32>(textureDimensions(uvtex));
    let x = i32(id.x);
    let y = i32(id.y);
    // Centre-sited: the SECOND tap's weight in quarters — 3 for an even luma column / row, 1 for an odd one.
    var x0 = (x - 1) / 2; var fx = 1;
    if (x % 2 == 0) { x0 = x / 2 - 1; fx = 3; }
    var y0 = (y - 1) / 2; var fy = 1;
    if (y % 2 == 0) { y0 = y / 2 - 1; fy = 3; }
    let a = chroma(vec2<i32>(x0, y0), cs) * (4 - fx) * (4 - fy) + chroma(vec2<i32>(x0 + 1, y0), cs) * fx * (4 - fy)
          + chroma(vec2<i32>(x0, y0 + 1), cs) * (4 - fx) * fy + chroma(vec2<i32>(x0 + 1, y0 + 1), cs) * fx * fy;
    let c = vec2<f32>(a) / 16.0;
    let luma = floor(textureLoad(ytex, vec2<i32>(x, y), 0).r * 255.0 + 0.5);
    let kr = 0.2126; let kb = 0.0722; let kg = 1.0 - kr - kb;
    let ys = 255.0 / 219.0; let cscale = 255.0 / 224.0;
    let l = (luma - 16.0) * ys;
    let u = c.x - 128.0; let v = c.y - 128.0;
    let rgb = vec3<f32>(l + 2.0 * (1.0 - kr) * cscale * v,
                        l - 2.0 * (1.0 - kb) * kb / kg * cscale * u - 2.0 * (1.0 - kr) * kr / kg * cscale * v,
                        l + 2.0 * (1.0 - kb) * cscale * u);
    let q = clamp(rgb / 255.0, vec3<f32>(0.0), vec3<f32>(1.0));
    textureStore(dst, vec2<i32>(x, y), vec4<f32>(q, 1.0));
}
"#;

pub struct GpuConvert { pipeline: wgpu::ComputePipeline }

impl GpuConvert {
    pub fn new(gpu: &crate::Gpu) -> Self {
        let m = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("nv12 convert"), source: wgpu::ShaderSource::Wgsl(CONVERT_WGSL.into()) });
        let pipeline = gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("nv12 convert"), layout: None, module: &m, entry_point: Some("main"), compilation_options: Default::default(), cache: None,
        });
        GpuConvert { pipeline }
    }

    /// The Y and UV plane views (coded size, and half of it) → an RGBA8 texture of the coded size.
    pub fn convert(&self, gpu: &crate::Gpu, y: &wgpu::TextureView, uv: &wgpu::TextureView, coded: (u32, u32)) -> wgpu::Texture {
        let d = &gpu.device;
        let out = d.create_texture(&wgpu::TextureDescriptor {
            label: Some("nv12 rgba"), size: wgpu::Extent3d { width: coded.0, height: coded.1, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC, view_formats: &[],
        });
        let ov = out.create_view(&Default::default());
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("nv12 convert"), layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(y) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(uv) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&ov) },
            ],
        });
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(coded.0.div_ceil(8), coded.1.div_ceil(8), 1);
        }
        gpu.queue.submit([enc.finish()]);
        out
    }

    /// A CPU-decoded frame (the software decoder's planes): upload the two planes, convert on the GPU.
    pub fn picture(&self, gpu: &crate::Gpu, f: &Nv12) -> Picture {
        let (w, h) = f.coded;
        let plane = |label, pw: u32, ph: u32, format, bpp: u32, src: &[u8], stride: usize| {
            let t = gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label), size: wgpu::Extent3d { width: pw, height: ph, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[],
            });
            // Rows packed tight (write_texture needs no 256 alignment).
            let mut tight = Vec::with_capacity((pw * ph * bpp) as usize);
            for row in 0..ph as usize { tight.extend_from_slice(&src[row * stride..row * stride + (pw * bpp) as usize]); }
            gpu.queue.write_texture(t.as_image_copy(), &tight, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(pw * bpp), rows_per_image: Some(ph) },
                wgpu::Extent3d { width: pw, height: ph, depth_or_array_layers: 1 });
            t
        };
        let yt = plane("nv12 y", w, h, wgpu::TextureFormat::R8Unorm, 1, f.y, f.y_stride);
        let uvt = plane("nv12 uv", w / 2, h / 2, wgpu::TextureFormat::Rg8Unorm, 2, f.uv, f.uv_stride);
        let out = self.convert(gpu, &yt.create_view(&Default::default()), &uvt.create_view(&Default::default()), (w, h));
        Picture::gpu_frame(w, h, out, f.visible)
    }
}

/// A GPU picture's texels back (tests: the conversion gate).
pub fn read_rgba(gpu: &crate::Gpu, tex: &wgpu::Texture, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let row = (w * 4).div_ceil(256) * 256;
    let buf = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("rgba readback"), size: (row * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut enc = gpu.device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(tex.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
    gpu.queue.submit([enc.finish()]);
    let raw = gpu.read_buffer(&buf, (row * h) as usize).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h as usize { out.extend_from_slice(&raw[y * row as usize..y * row as usize + (w * 4) as usize]); }
    Ok(out)
}

