//! E1d — THE ENGINE OWNS A FRAME: sources → its own atlas → LED sampling → universes.
//!
//! The atlas is built the way WebGPUMapper.renderSurfaces builds it, so the LEDs come out as close to
//! today's as two different rasterisers allow:
//!   - cleared to black (unpacked gaps, fade to black);
//!   - each surface's picture stretched into its cell — `drawImage(img, x, y, w, h)`: destination pixel
//!     centre (x + i + 0.5) samples the source at ((i + 0.5) / w) of its width, BILINEAR (Canvas2D's
//!     default `imageSmoothingQuality: 'low'`), clamped at the edges;
//!   - source-over onto that black with `globalAlpha = opacity`: rgb × alpha × opacity, in the same
//!     NON-linear 8-bit space a 2D canvas blends in (an Rgba8Unorm target, not sRGB);
//!   - the picture PREMULTIPLIED at decode (8-bit, Skia's rounding) and a Skia-style mip chain built from
//!     that, one level read per stretch (see mip_level) with bilinear filtering inside it. Plain bilinear
//!     from full resolution put a 1-px line on or off an LED depending on where it fell — up to 60 levels
//!     off on an 8× downscale.
//! The gate (scripts/test-image-parity.cjs): per picture, byte-identical to the browser, OR at least as
//! close as the browser to an alias-free reference. Never less faithful than today.
//! What is NOT the same: Chromium decodes the file (createImageBitmap — its own PNG/JPEG decoders, colour
//! management, EXIF orientation) and Skia rasterises the stretch; the engine decodes with the `image` crate
//! and stretches with the GPU. Decoding agrees (PNG to the bit, JPEG within ±3 per pixel); the stretch
//! agrees at some scales and not others — see the gate below. Not handled yet: ICC profiles and EXIF
//! orientation (Chromium applies both), and formats beyond PNG / JPEG (a WebP/GIF/AVIF surface is black).
//!
//! Sources so far: IMAGE, and a HAP frame (hap_picture, below). Everything else (other video, SPOUT,
//! EFFECT, …) leaves its cell black here.

use crate::layout::{self, Fixture, Surface};
use crate::{EngineError, Gpu};
use std::collections::HashMap;
use std::path::Path;

const STRETCH_WGSL: &str = r#"
struct Cell { rect: vec4<f32>, opacity: f32, level: f32, _p1: f32, _p2: f32 };
@group(0) @binding(0) var img: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> cell: Cell;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    // pos.xy is the ATLAS pixel centre; the cell's own coordinate is (pos - rect.xy) / rect.wh.
    let uv = (pos.xy - cell.rect.xy) / cell.rect.zw;
    let c = textureSampleLevel(img, samp, uv, cell.level);
    // The picture is PREMULTIPLIED: its rgb already carries its alpha. Source-over onto opaque black with
    // globalAlpha = opacity is then rgb × opacity.
    return vec4<f32>(c.rgb * cell.opacity, 1.0);
}
"#;

/// A picture to stretch into a cell, RGBA8, and HOW today's `drawImage` stretches that kind of source —
/// which is not the same for every source (measured, scripts/test-image-parity.cjs):
///   - a decoded IMAGE is an ImageBitmap: PREMULTIPLIED at decode (8-bit, Skia's rounding) and drawn from
///     a MIP CHAIN — `Picture::still`;
///   - a CANVAS (the HAP plugin's WebGL canvas, `premultipliedAlpha: false`) is premultiplied the same way
///     but drawn from the texture itself, NO mips — `Picture::canvas`. With mips the three real HAP clips
///     here were 9–97% exact; without, all three byte-identical. (Multiplying the straight alpha in AFTER
///     the filter was tried and is wrong: 46% exact on an alpha frame. Truncating, shift-by-8 and f32
///     premultiplies were each worse than Skia's rounding.)
pub struct Picture { pub w: u32, pub h: u32, pub rgba: Vec<u8>, pub mips: bool }

impl Picture {
    pub fn still(w: u32, h: u32, mut rgba: Vec<u8>) -> Self { premultiply(&mut rgba); Picture { w, h, rgba, mips: true } }
    pub fn canvas(w: u32, h: u32, mut rgba: Vec<u8>) -> Self { premultiply(&mut rgba); Picture { w, h, rgba, mips: false } }
    /// A VideoFrame (Spout's shared texture, imported by Electron). MEASURED like the others — see E1d-3.
    pub fn video_frame(w: u32, h: u32, mut rgba: Vec<u8>) -> Self { premultiply(&mut rgba); Picture { w, h, rgba, mips: false } }
}

/// `round(c × a / 255)` in integers — Skia's SkMulDiv255Round.
fn mul_div_255_round(c: u8, a: u8) -> u8 {
    let p = c as u32 * a as u32 + 128;
    ((p + (p >> 8)) >> 8) as u8
}

pub fn load_image(path: &Path) -> Result<Picture, String> {
    let img = image::open(path).map_err(|e| format!("{}: {e}", path.display()))?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    Ok(Picture::still(w, h, img.into_raw()))
}

/// RGBA8 in place → premultiplied, Skia's 8-bit rounding.
pub fn premultiply(rgba: &mut [u8]) {
    for px in rgba.chunks_exact_mut(4) {
        let a = px[3];
        if a != 255 { for c in &mut px[..3] { *c = mul_div_255_round(*c, a); } }
    }
}

/// What one frame needs from the document.
pub struct FrameDoc<'a> {
    pub fixtures: &'a [Fixture],
    pub surfaces: &'a [Surface],
    /// Per surface id: its picture (None = no content / not a source the engine has yet → black cell).
    pub pictures: &'a HashMap<String, Picture>,
    pub opacity: &'a HashMap<String, f32>,
    pub brightness: f32,
}

/// The GPU copies of the pictures, kept between frames (E1f): a picture is uploaded — and its mip chain
/// built — only when its GENERATION changes. A still is uploaded once; an effect or a HAP frame each time
/// it moves. Without it a 1080p still would be re-mipped on the CPU 44 times a second.
#[derive(Default)]
pub struct TexCache { entries: HashMap<String, (u64, wgpu::Texture, usize)> }

impl TexCache {
    /// Forget surfaces that are no longer drawn.
    pub fn retain(&mut self, keep: &dyn Fn(&str) -> bool) { self.entries.retain(|k, _| keep(k)); }
}

/// One frame: the atlas, then the LEDs. Returns the canonical buffer (R, G, B, W per LED).
pub fn frame(gpu: &Gpu, doc: &FrameDoc) -> Result<Vec<u8>, EngineError> { frame_cached(gpu, doc, None) }

/// `frame`, reusing a picture's texture while `gens[surface]` is unchanged (a missing generation always
/// re-uploads).
pub fn frame_cached(gpu: &Gpu, doc: &FrameDoc, mut cache: Option<(&mut TexCache, &HashMap<String, u64>)>) -> Result<Vec<u8>, EngineError> {
    let d = &gpu.device;
    let order = layout::surface_order(doc.fixtures, doc.surfaces);
    let seg_count = layout::count_segments(doc.fixtures);
    let leds = layout::build_led_data(doc.fixtures, doc.surfaces, &order, seg_count);
    if leds.total == 0 { return Ok(Vec::new()); }
    let max_dim = d.limits().max_texture_dimension_2d as f64;
    let plan = layout::plan_atlas(&order, doc.fixtures, doc.surfaces, max_dim);
    let packed = plan.packed.unwrap_or(layout::Packed { rects: vec![], w: 1.0, h: 1.0 });
    let (aw, ah) = (packed.w as u32, packed.h as u32);
    let atlas = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("engine atlas"), size: wgpu::Extent3d { width: aw, height: ah, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    });
    let atlas_view = atlas.create_view(&Default::default());
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("stretch"), source: wgpu::ShaderSource::Wgsl(STRETCH_WGSL.into()) });
    let pipeline = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("stretch"), layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let sampler = d.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("stretch"), address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Nearest,   // ONE level, bilinear within it (Skia's)
        ..Default::default()
    });
    // Per cell: its picture's texture + a uniform, kept alive until the pass is submitted.
    struct Draw { rect: layout::Rect, bind: wgpu::BindGroup }
    let mut draws = Vec::new();
    for (k, sid) in order.iter().enumerate() {
        let (Some(rect), Some(pic)) = (packed.rects.get(k), doc.pictures.get(sid)) else { continue };
        let opacity = doc.opacity.get(sid).copied().unwrap_or(1.0);
        if opacity <= 0.0 { continue; }
        let gen = cache.as_ref().and_then(|(_, g)| g.get(sid).copied());
        let hit = match (&cache, gen) { (Some((c, _)), Some(g)) => c.entries.get(sid).filter(|e| e.0 == g).map(|e| (e.1.clone(), e.2)), _ => None };
        let (tex, levels) = match hit {
            Some(t) => t,
            None => {
                let chain = if pic.mips { mip_chain(pic) } else { vec![(pic.w, pic.h, pic.rgba.clone())] };
                let size = wgpu::Extent3d { width: pic.w, height: pic.h, depth_or_array_layers: 1 };
                let tex = d.create_texture(&wgpu::TextureDescriptor {
                    label: Some("picture"), size, mip_level_count: chain.len() as u32, sample_count: 1, dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[],
                });
                for (lvl, (w, h, px)) in chain.iter().enumerate() {
                    gpu.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: lvl as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, px,
                        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(*h) }, wgpu::Extent3d { width: *w, height: *h, depth_or_array_layers: 1 });
                }
                if let (Some((c, _)), Some(g)) = (cache.as_mut(), gen) { c.entries.insert(sid.clone(), (g, tex.clone(), chain.len())); }
                (tex, chain.len())
            }
        };
        let level = mip_level(pic.w as f64 / rect.w, pic.h as f64 / rect.h, levels);
        let mut u = [0u8; 32];
        for (i, v) in [rect.x as f32, rect.y as f32, rect.w as f32, rect.h as f32, opacity.min(1.0), level].iter().enumerate() {
            u[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("cell"), size: 32, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        gpu.queue.write_buffer(&ubuf, 0, &u);
        let view = tex.create_view(&Default::default());
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cell"), layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
            ],
        });
        draws.push(Draw { rect: *rect, bind });
    }
    let mut enc = d.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("atlas"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &atlas_view, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        for dr in &draws {
            let r = dr.rect;
            // The cell, and only the cell: the full-screen triangle is clipped to its rect.
            pass.set_viewport(r.x as f32, r.y as f32, r.w as f32, r.h as f32, 0.0, 1.0);
            pass.set_scissor_rect(r.x as u32, r.y as u32, r.w as u32, r.h as u32);
            pass.set_bind_group(0, &dr.bind, &[]);
            pass.draw(0..3, 0..1);
        }
    }
    gpu.queue.submit([enc.finish()]);
    let rects = layout::atlas_rect_data(&packed.rects, packed.w, packed.h);
    crate::sample::sample_texture(gpu, &atlas, &leds.led, &leds.meta, &layout::build_seg_params(doc.fixtures), &rects, doc.brightness.clamp(0.0, 1.0), order.len() as u32)
}

/// The picture's mip chain, Skia-style: each level halves (floor), a 2-wide box where the source size is
/// even and a 1-2-1 filter where it is odd. Level 0 is the picture itself.
pub fn mip_chain(pic: &Picture) -> Vec<(u32, u32, Vec<u8>)> {
    let mut out = vec![(pic.w, pic.h, pic.rgba.clone())];
    loop {
        let (w, h, src) = out.last().unwrap();
        let (w, h) = (*w, *h);
        if w == 1 && h == 1 { break; }
        let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
        let taps = |n: u32, len: u32, i: u32| -> Vec<(u32, f32)> {
            if n == len { return vec![(i, 1.0)]; }            // this axis does not shrink
            if len % 2 == 0 { vec![(2 * i, 0.5), (2 * i + 1, 0.5)] }
            else { vec![(2 * i, 0.25), (2 * i + 1, 0.5), ((2 * i + 2).min(len - 1), 0.25)] }
        };
        let mut dst = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh {
            let ty = taps(nh, h, y);
            for x in 0..nw {
                let tx = taps(nw, w, x);
                let mut acc = [0f32; 4];
                for &(sy, wy) in &ty { for &(sx, wx) in &tx {
                    let i = ((sy * w + sx) * 4) as usize;
                    for c in 0..4 { acc[c] += src[i + c] as f32 * wx * wy; }
                }}
                let o = ((y * nw + x) * 4) as usize;
                for c in 0..4 { dst[o + c] = (acc[c] + 0.5).floor().min(255.0) as u8; }
            }
        }
        out.push((nw, nh, dst));
    }
    out
}

/// Which level a stretch of `sx`×`sy` (source texels per destination pixel) reads: floor(log2(s)), s the
/// LEAST-shrunk axis. Chosen by MEASUREMENT (scripts/test-image-parity.cjs), not to copy Chromium — Skia's
/// own rule could not be reproduced bit for bit at every size — but to be FAITHFUL: against an alias-free
/// reference (each picture area-averaged exactly into its cell), this rule was never further from it than
/// the browser and closer on every picture where the two differ; the geometric-mean rule was slightly worse
/// than the browser on real JPEGs, and the larger-axis / no-mip / rounded rules up to 67 levels off on an 8×
/// downscale. Where the browser's rule agrees, the LEDs are byte-identical to today's.
pub fn mip_level(sx: f64, sy: f64, levels: usize) -> f32 {
    let scale = sx.min(sy);
    if scale <= 1.0 || levels <= 1 { return 0.0; }
    scale.log2().floor().clamp(0.0, (levels - 1) as f64) as f32
}

// ── HAP (E1d-2): a frame's blocks → the picture the app would stretch ──────────────────────────────────
// Today (plugins/hap/src/hapGL.ts) the blocks go into a WebGL2 compressed texture the size of the video
// and are drawn ONCE onto a canvas the same size — pixel centre onto texel centre, so the LINEAR filter
// there reads exactly one texel — with HapQ's scaled-YCoCg → RGB in that shader. The canvas is
// `premultipliedAlpha: false`, and `drawImage` then stretches it into the atlas like any picture. So the
// engine does the same: the GPU decodes the blocks (a BC texture; the CPU decode where the adapter has no
// BC), one pass applies the app's shader per texel, and the result enters the proven picture path
// (premultiply, mips, stretch). Two of the app's choices are kept ON PURPOSE, because they are what is on
// the LEDs today:
//   - DXT1 is `COMPRESSED_RGB_S3TC_DXT1_EXT` there: alpha is ALWAYS 1, even on a punch-through texel
//     (whose colour is black). wgpu's BC1 is the RGBA variant, so the shader forces alpha to 1.
//   - HapQ's maths is the app's float shader, line for line (not an integer YCoCg).
// The frame is read back to the CPU here, which a live engine would not do (the picture stays on the GPU);
// this step is about WHAT is drawn, and the readback is what lets the same stretch be reused and judged.
const HAP_WGSL: &str = r#"
@group(0) @binding(0) var blocks: texture_2d<f32>;
@group(0) @binding(1) var<uniform> mode: vec4<u32>;   // x: 0 direct (alpha kept), 1 scaled YCoCg, 2 direct (alpha 1)

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(blocks, vec2<i32>(pos.xy), 0);
    if (mode.x == 1u) {
        // plugins/hap/src/hapGL.ts FRAG, verbatim.
        let scale = c.b * 31.875 + 1.0;
        let co = (c.r * 255.0 - 128.0) / scale;
        let cg = (c.g * 255.0 - 128.0) / scale;
        let y = c.a * 255.0;
        return vec4<f32>((y + co - cg) / 255.0, (y + cg) / 255.0, (y - co - cg) / 255.0, 1.0);
    }
    if (mode.x == 2u) { return vec4<f32>(c.rgb, 1.0); }
    return c;
}
"#;

/// A HAP frame's blocks as the picture today's GL path paints — a CANVAS (no mips). BC4 / BC7 (HapA, Hap7) are REFUSED: the app's GL path uploads them as DXT5
/// and shows garbage (docs/CODECS.md), and the engine will not copy a picture that is known to be wrong.
pub fn hap_picture(gpu: &Gpu, format: crate::hapimport::hap::HapFormat, w: u32, h: u32, blocks: &[u8]) -> Result<Picture, String> {
    use crate::hapimport::{self, hap::HapFormat};
    let mode: u32 = match format {
        HapFormat::Dxt1 => 2,
        HapFormat::Dxt5 => 0,
        HapFormat::ScaledYCoCg => 1,
        f => return Err(format!("{f:?} is not drawn by the engine (the app shows it wrongly too — docs/CODECS.md)")),
    };
    let tex = if hapimport::has_bc(gpu) {
        hapimport::upload_bc(gpu, format, w, h, blocks).map_err(|e| e.to_string())?
    } else {
        let rgba = hapimport::cpu_rgba(format, w, h, blocks)?;
        hapimport::upload_rgba(gpu, w.div_ceil(4) * 4, h.div_ceil(4) * 4, &rgba)
    };
    Ok(Picture::canvas(w, h, texels(gpu, &tex, w, h, mode)?))
}

/// The top-left `w`×`h` texels of `tex` (any colour format, BC included) as RGBA8, through the per-texel
/// pass above (`mode` as there: 0 as stored, 1 HapQ, 2 opaque). BGRA storage reads back as RGBA.
pub fn texels(gpu: &Gpu, tex: &wgpu::Texture, w: u32, h: u32, mode: u32) -> Result<Vec<u8>, String> {
    let d = &gpu.device;
    let target = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("texels"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[],
    });
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("hap"), source: wgpu::ShaderSource::Wgsl(HAP_WGSL.into()) });
    let pipeline = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("hap"), layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("hap mode"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    gpu.queue.write_buffer(&ubuf, 0, &[mode.to_le_bytes(), [0; 4], [0; 4], [0; 4]].concat());
    let view = tex.create_view(&Default::default());
    let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("hap"), layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 1, resource: ubuf.as_entire_binding() },
        ],
    });
    let row = (w * 4).div_ceil(256) * 256;
    let readback = d.create_buffer(&wgpu::BufferDescriptor { label: Some("hap readback"), size: (row * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let target_view = target.create_view(&Default::default());
    let mut enc = d.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("hap"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }
    enc.copy_texture_to_buffer(target.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
    gpu.queue.submit([enc.finish()]);
    let raw = gpu.read_buffer(&readback, (row * h) as usize).map_err(|e| e.to_string())?;
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h as usize { rgba.extend_from_slice(&raw[y * row as usize..y * row as usize + w as usize * 4]); }
    Ok(rgba)
}
