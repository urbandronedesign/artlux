//! E1e-1 — THE PROJECTOR RENDERER (uncalibrated): one surface's picture onto a projector raster, as the app's
//! src/renderer/projector/ProjectorGL.ts draws it on the 2D warp path (every non-calibrated output).
//!
//!   - GEOMETRY, ported from ProjectorGL.buildGeometry + homography.ts cornerQs/toClip + warp.ts
//!     tessellateBezier (RENDER_TESS = 24, ProjectorApp): either the corner-pin as two triangles carrying
//!     (u·q, v·q, q) — Heckbert's perspective trick — or the Bézier patch tessellated into a mesh (q = 1).
//!     f64 maths, stored as f32 where the TS fills a Float32Array.
//!   - SAMPLING: the content in a texture with mips (levels 0..4 — TEXTURE_MAX_LEVEL 4), trilinear, 8×
//!     anisotropic, clamped; uv = uvq.xy / uvq.z per fragment.
//!   - THE SHADER, line for line: soft-edge share (blendGlsl.ts), its signal share^(1/g), colour gain, black
//!     lift where attenuated, brightness, output gamma.
//!   - 4× MSAA (AA_SAMPLES), resolved; `aa <= 1` draws single-sampled (the panel path).
//! scripts/test-projector-parity.cjs holds it to the app's real ProjectorGL, pixel by pixel — the mesh path
//! and (item 3) the BAKED-MAP path an imported .mpcdi plays (draw_baked).
//!
//! proven against: cd9f5fb8d0216ef5 9601e112ab2c6b05 b39a9329ce318182   (sha256/16 of homography.ts, warp.ts,
//! blendGlsl.ts — LF; verify:invariants fails when one changes: re-port, re-run the test, then update).
//! The mip cap is the LEVEL COUNT (5) here, the sampler's lod clamp is the belt to it.

use crate::Gpu;

/// DrawOpts, as the app passes them (ProjectorApp → ProjectorGL.draw).
#[derive(Clone, Debug)]
pub struct Opts {
    /// tl, tr, br, bl — normalized display space, origin top-left.
    pub pin: [[f64; 2]; 4],
    /// A Bézier control net (16 points, row-major) — supersedes the pin when present.
    pub bezier: Option<Vec<[f64; 2]>>,
    pub soft: [f64; 4],
    pub blend_gamma: f64,
    pub gamma: f64,
    pub brightness: f64,
    pub color_gain: [f64; 3],
    pub black_lift: [f64; 3],
    pub aa: u32,
}

pub const RENDER_TESS: usize = 24;

impl Opts {
    /// From a ProjectorOutput-shaped JSON (cornerPin, warp {points}, softEdge, gamma, colorGain, blackLift)
    /// plus the draw's own `brightness` and `aa`, with ProjectorGL's `?? defaults` and clamps.
    pub fn from_json(o: &serde_json::Value, brightness: f64, aa: u32) -> Self {
        let pt = |v: &serde_json::Value, d: [f64; 2]| -> [f64; 2] { [v[0].as_f64().unwrap_or(d[0]), v[1].as_f64().unwrap_or(d[1])] };
        let cp = &o["cornerPin"];
        let pin = [pt(&cp["tl"], [0.0, 0.0]), pt(&cp["tr"], [1.0, 0.0]), pt(&cp["br"], [1.0, 1.0]), pt(&cp["bl"], [0.0, 1.0])];
        let bezier = o["warp"]["points"].as_array().filter(|p| p.len() == 16).map(|p| p.iter().map(|v| pt(v, [0.0, 0.0])).collect());
        let se = &o["softEdge"];
        let f = |v: &serde_json::Value, d: f64| v.as_f64().unwrap_or(d);
        let v3 = |v: &serde_json::Value, d: f64| [f(&v[0], d), f(&v[1], d), f(&v[2], d)];
        Opts {
            pin, bezier,
            soft: [f(&se["left"], 0.0), f(&se["right"], 0.0), f(&se["top"], 0.0), f(&se["bottom"], 0.0)],
            blend_gamma: f(&se["gamma"], 2.2).max(0.1),
            gamma: f(&o["gamma"], 1.0).max(0.1),
            brightness: brightness.max(0.0),
            color_gain: v3(&o["colorGain"], 1.0),
            black_lift: v3(&o["blackLift"], 0.0),
            aa,
        }
    }
}

type P = [f64; 2];

// homography.ts
fn intersect(a: P, b: P, c: P, d: P) -> Option<P> {
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let denom = r[0] * s[1] - r[1] * s[0];
    if denom.abs() < 1e-9 { return None; }
    let t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denom;
    Some([a[0] + t * r[0], a[1] + t * r[1]])
}
fn dist(a: P, b: P) -> f64 { libm::hypot(a[0] - b[0], a[1] - b[1]) }
pub fn corner_qs(pin: &[P; 4]) -> [f64; 4] {
    let [tl, tr, br, bl] = *pin;
    let Some(center) = intersect(tl, br, tr, bl) else { return [1.0; 4] };
    let (d_tl, d_br, d_tr, d_bl) = (dist(tl, center), dist(br, center), dist(tr, center), dist(bl, center));
    let q = |a: f64, b: f64| if b > 1e-9 { (a + b) / b } else { 1.0 };
    [q(d_tl, d_br), q(d_tr, d_bl), q(d_br, d_tl), q(d_bl, d_tr)]
}
fn to_clip(p: P) -> P { [p[0] * 2.0 - 1.0, 1.0 - p[1] * 2.0] }

// warp.ts
fn bern3(t: f64) -> [f64; 4] { let it = 1.0 - t; [it * it * it, 3.0 * it * it * t, 3.0 * it * t * t, t * t * t] }
fn eval_bezier(points: &[P], u: f64, v: f64) -> P {
    let (bu, bv) = (bern3(u), bern3(v));
    let (mut x, mut y) = (0.0, 0.0);
    for j in 0..4 { for i in 0..4 { let w = bv[j] * bu[i]; let p = points[j * 4 + i]; x += w * p[0]; y += w * p[1]; } }
    [x, y]
}
pub fn tessellate(points: &[P], n: usize) -> Vec<P> {
    let mut out = Vec::with_capacity((n + 1) * (n + 1));
    for j in 0..=n { for i in 0..=n { out.push(eval_bezier(points, i as f64 / n as f64, j as f64 / n as f64)); } }
    out
}

/// ProjectorGL.buildGeometry: interleaved [clipX, clipY, u·q, v·q, q] per vertex, as f32.
pub fn geometry(o: &Opts) -> Vec<f32> {
    let mut out: Vec<f32> = Vec::new();
    let mut push = |c: P, u: f64, v: f64, q: f64| { out.extend_from_slice(&[c[0] as f32, c[1] as f32, (u * q) as f32, (v * q) as f32, q as f32]); };
    if let Some(net) = &o.bezier {
        let n = RENDER_TESS;
        let pts = tessellate(net, n);
        let at = |i: usize, j: usize| pts[j * (n + 1) + i];
        for j in 0..n {
            for i in 0..n {
                let (p00, p10, p11, p01) = (to_clip(at(i, j)), to_clip(at(i + 1, j)), to_clip(at(i + 1, j + 1)), to_clip(at(i, j + 1)));
                let (u0, u1, v0, v1) = (i as f64 / n as f64, (i + 1) as f64 / n as f64, j as f64 / n as f64, (j + 1) as f64 / n as f64);
                push(p00, u0, v0, 1.0); push(p10, u1, v0, 1.0); push(p11, u1, v1, 1.0);
                push(p00, u0, v0, 1.0); push(p11, u1, v1, 1.0); push(p01, u0, v1, 1.0);
            }
        }
    } else {
        let [q_tl, q_tr, q_br, q_bl] = corner_qs(&o.pin);
        let [tl, tr, br, bl] = o.pin.map(to_clip);
        push(tl, 0.0, 0.0, q_tl); push(tr, 1.0, 0.0, q_tr); push(br, 1.0, 1.0, q_br);
        push(tl, 0.0, 0.0, q_tl); push(br, 1.0, 1.0, q_br); push(bl, 0.0, 1.0, q_bl);
    }
    out
}

/// The plain warp's shader source (for `--dump-hlsl`).
pub fn warp_wgsl() -> &'static str { WARP_WGSL }

const WARP_WGSL: &str = r#"
struct U { soft: vec4<f32>, gain: vec4<f32>, lift: vec4<f32>, blend_gamma: f32, gamma: f32, brightness: f32, _p: f32 };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
struct V { @builtin(position) pos: vec4<f32>, @location(0) uvq: vec3<f32> };

@vertex
fn vs(@location(0) pos: vec2<f32>, @location(1) uvq: vec3<f32>) -> V {
    // RASTERISED BOTTOM-UP, like the app's canvas: see `render`.
    return V(vec4<f32>(pos.x, -pos.y, 0.0, 1.0), uvq);
}

// blendGlsl.ts, verbatim.
fn feather(d: f32, w: f32) -> f32 { if (w <= 0.0) { return 1.0; } return clamp(d / w, 0.0, 1.0); }
fn share(uv: vec2<f32>, s: vec4<f32>) -> f32 {
    return feather(uv.x, s.x) * feather(1.0 - uv.x, s.y) * feather(uv.y, s.z) * feather(1.0 - uv.y, s.w);
}
fn signal(sh: f32, g: f32) -> f32 { return pow(max(sh, 0.0), 1.0 / max(g, 0.1)); }

@fragment
fn fs(v: V) -> @location(0) vec4<f32> {
    let uv = v.uvq.xy / v.uvq.z;
    var c = textureSample(tex, samp, uv);
    let pa = signal(share(uv, u.soft), u.blend_gamma);
    var rgb = c.rgb * pa * u.gain.rgb + u.lift.rgb * (1.0 - pa);
    rgb = rgb * u.brightness;
    rgb = pow(max(rgb, vec3<f32>(0.0)), vec3<f32>(1.0 / u.gamma));
    return vec4<f32>(rgb, 1.0);
}
"#;

const MIP_WGSL: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    // One bilinear tap at the centre of the 2×2 parent block: a box filter (the usual generateMipmap).
    let o = vec2<f32>(textureDimensions(src) / 2u);
    return textureSampleLevel(src, samp, pos.xy / max(o, vec2<f32>(1.0)), 0.0);
}
"#;

/// The content as the app's texture holds it: RGBA8 (straight — texImage2D with UNPACK_PREMULTIPLY off),
/// with levels 0..4 generated.
pub fn content_texture(gpu: &Gpu, w: u32, h: u32, rgba: &[u8]) -> wgpu::Texture {
    let d = &gpu.device;
    let full = 32 - w.max(h).leading_zeros();
    let levels = full.min(5);
    let tex = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("projector content"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: levels, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[],
    });
    gpu.queue.write_texture(tex.as_image_copy(), rgba, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
    mip_down(gpu, &tex, levels);
    tex
}

/// (COPY_SRC on both: a content texture is a SOURCE too — a single timeline track's picture IS one, and a bake
/// copies it again, E6a; without it wgpu's validation panics the render thread.)
///
/// Item 2c-4: the same content texture, level 0 COPIED ON THE GPU from a picture already there — an MP4
/// frame's RGBA (yuv.rs GpuConvert, the coded size), its VISIBLE rect. That is exactly what the app's window
/// gets: createImageBitmap(VideoFrame) is the visible picture, converted as drawImage converts it
/// (test:mp4-parity gate 1b), uploaded and mipped by ProjectorGL. No frame crosses to the CPU.
pub fn content_texture_from(gpu: &Gpu, src: &wgpu::Texture, crop: [u32; 4]) -> wgpu::Texture {
    let [x, y, w, h] = crop;
    let levels = (32 - w.max(h).leading_zeros()).min(5);
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("projector content (gpu)"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: levels, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[],
    });
    let mut enc = gpu.device.create_command_encoder(&Default::default());
    enc.copy_texture_to_texture(
        wgpu::TexelCopyTextureInfo { texture: src, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
        tex.as_image_copy(), wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
    gpu.queue.submit([enc.finish()]);
    mip_down(gpu, &tex, levels);
    tex
}

/// Levels 1.. of a content texture, each from the one above — ProjectorGL's generateMipmap (box, linear).
fn mip_down(gpu: &Gpu, tex: &wgpu::Texture, levels: u32) {
    let d = &gpu.device;
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("mip"), source: wgpu::ShaderSource::Wgsl(MIP_WGSL.into()) });
    let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("mip"), layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let samp = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let mut enc = d.create_command_encoder(&Default::default());
    for l in 1..levels {
        let src = tex.create_view(&wgpu::TextureViewDescriptor { base_mip_level: l - 1, mip_level_count: Some(1), ..Default::default() });
        let dst = tex.create_view(&wgpu::TextureViewDescriptor { base_mip_level: l, mip_level_count: Some(1), ..Default::default() });
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&src) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&samp) },
        ] });
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("mip"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &dst, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
        pass.set_pipeline(&pipe); pass.set_bind_group(0, &bind, &[]); pass.draw(0..3, 0..1);
    }
    gpu.queue.submit([enc.finish()]);
}

/// Draw `content` through `o` onto a `w`×`h` target in `format`. `target` must be RENDER_ATTACHMENT.
/// (A one-off; a presenter that draws EVERY frame keeps a `Warp`, which keeps its pipeline.)
pub fn draw(gpu: &Gpu, content: &wgpu::Texture, o: &Opts, target: &wgpu::TextureView, format: wgpu::TextureFormat, w: u32, h: u32) {
    Warp::new(gpu).draw(gpu, content, o, target, format, w, h)
}

/// The warp pass with its pipelines and sampler kept — E6f: a calibrated output with a residual warp warps the
/// venue's picture every frame (ProjectorApp path B), where a plain output redraws only on a change.
pub struct Warp { module: wgpu::ShaderModule, pipes: Vec<((wgpu::TextureFormat, u32), wgpu::RenderPipeline)>, samp: wgpu::Sampler }

impl Warp {
    pub fn new(gpu: &Gpu) -> Self {
        let d = &gpu.device;
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("warp"), source: wgpu::ShaderSource::Wgsl(WARP_WGSL.into()) });
        let samp = d.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, mipmap_filter: wgpu::MipmapFilterMode::Linear,
            lod_max_clamp: 4.0, anisotropy_clamp: 8, ..Default::default()
        });
        Warp { module, pipes: Vec::new(), samp }
    }

    pub fn draw(&mut self, gpu: &Gpu, content: &wgpu::Texture, o: &Opts, target: &wgpu::TextureView, format: wgpu::TextureFormat, w: u32, h: u32) {
    use wgpu::util::DeviceExt;
    let d = &gpu.device;
    let samples = if o.aa > 1 { 4 } else { 1 };
    if !self.pipes.iter().any(|(k, _)| *k == (format, samples)) {
        let module = &self.module;
        let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("warp"), layout: None,
            vertex: wgpu::VertexState { module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 20, step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x3],
            })] },
            fragment: Some(wgpu::FragmentState { module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None,
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() }, multiview_mask: None, cache: None,
        });
        self.pipes.push(((format, samples), pipe));
    }
    let pipe = &self.pipes.iter().find(|(k, _)| *k == (format, samples)).unwrap().1;
    let samp = &self.samp;
    let f = |v: f64| (v as f32).to_le_bytes();
    let mut ub = Vec::new();
    for v in o.soft { ub.extend(f(v)); }
    for v in o.color_gain { ub.extend(f(v)); } ub.extend(f(0.0));
    for v in o.black_lift { ub.extend(f(v)); } ub.extend(f(0.0));
    for v in [o.blend_gamma, o.gamma, o.brightness, 0.0] { ub.extend(f(v)); }
    let ubuf = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("warp u"), contents: &ub, usage: wgpu::BufferUsages::UNIFORM });
    let geo = geometry(o);
    let vbuf = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("warp mesh"), contents: &geo.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(), usage: wgpu::BufferUsages::VERTEX });
    let view = content.create_view(&Default::default());
    let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(samp) },
        wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
    ] });
    let ms = (samples > 1).then(|| d.create_texture(&wgpu::TextureDescriptor {
        label: Some("warp msaa"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: samples,
        dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] }));
    let ms_view = ms.as_ref().map(|t| t.create_view(&Default::default()));
    let mut enc = d.create_command_encoder(&Default::default());
    {
        let (view, resolve) = match &ms_view { Some(m) => (m, Some(target)), None => (target, None) };
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("warp"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view, depth_slice: None, resolve_target: resolve,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
        pass.set_pipeline(pipe); pass.set_bind_group(0, &bind, &[]); pass.set_vertex_buffer(0, vbuf.slice(..));
        pass.draw(0..(geo.len() / 5) as u32, 0..1);
    }
    gpu.queue.submit([enc.finish()]);
    }
}

const CANVAS_WGSL: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    // Row r of the picture is row h − 1 − r of the GL raster: exact texels, no filtering.
    let h = i32(textureDimensions(src).y);
    return textureLoad(src, vec2<i32>(i32(pos.x), h - 1 - i32(pos.y)), 0);
}
"#;

/// E6f: a WebGL CANVAS as the warp's content — `texImage2D(canvas)` + generateMipmap, as ProjectorGL uploads the
/// calibrated scene's canvas when a residual warp bends it (ProjectorApp path B). The canvas's drawing buffer is a GL
/// framebuffer (row 0 at the BOTTOM — the raster calib3d draws); the upload lays it out as a DOM image, top row first
/// (UNPACK_FLIP_Y off), so level 0 is that raster turned over, texel for texel, then mipped as every content texture.
pub struct CanvasContent { flip: wgpu::RenderPipeline, tex: Option<(u32, u32, wgpu::Texture)> }

impl CanvasContent {
    pub fn new(gpu: &Gpu) -> Self {
        let d = &gpu.device;
        let m = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("canvas content"), source: wgpu::ShaderSource::Wgsl(CANVAS_WGSL.into()) });
        let flip = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("canvas content"), layout: None,
            vertex: wgpu::VertexState { module: &m, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &m, entry_point: Some("fs"), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        CanvasContent { flip, tex: None }
    }

    /// `raster`: the canvas's drawing buffer (Rgba8Unorm, w × h, bottom-up, TEXTURE_BINDING).
    pub fn upload(&mut self, gpu: &Gpu, raster: &wgpu::TextureView, w: u32, h: u32) -> &wgpu::Texture {
        let d = &gpu.device;
        let levels = (32 - w.max(h).leading_zeros()).min(5);
        if self.tex.as_ref().map(|t| (t.0, t.1)) != Some((w, h)) {
            self.tex = Some((w, h, d.create_texture(&wgpu::TextureDescriptor {
                label: Some("projector content (canvas)"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: levels, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[],
            })));
        }
        let tex = &self.tex.as_ref().unwrap().2;
        let dst = tex.create_view(&wgpu::TextureViewDescriptor { base_mip_level: 0, mip_level_count: Some(1), ..Default::default() });
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.flip.get_bind_group_layout(0), entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(raster) },
        ] });
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("canvas content"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &dst, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&self.flip); pass.set_bind_group(0, &bind, &[]); pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
        mip_down(gpu, tex, levels);
        tex
    }
}

/// Offscreen: the projector raster as RGBA8, top row first.
///
/// ⚠ THE PICTURE IS RASTERISED UPSIDE DOWN, THEN FLIPPED — on purpose, and it is what makes this
/// byte-identical. The app's WebGL canvas is a GL framebuffer: row 0 at the BOTTOM. ANGLE on D3D draws it
/// that way and the compositor shows it the right way up, so what reaches the projector is the
/// bottom-up raster. Drawn top-down instead, the same triangles cover different MSAA samples wherever an
/// edge crosses one exactly (the fill rule is applied in the other direction), and the anisotropic
/// footprint's derivatives change sign: measured, ~0.05% of pixels (the warped picture's OUTLINE, by one
/// sample of four = 64 levels) and up to 8% within ±4 inside a strong perspective. Mirrored: every pixel
/// identical (scripts/test-projector-parity.cjs). A window flips with a copy pass; offscreen flips rows.
pub fn render(gpu: &Gpu, content: &wgpu::Texture, o: &Opts, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let d = &gpu.device;
    let target = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("projector raster"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
    draw(gpu, content, o, &target.create_view(&Default::default()), wgpu::TextureFormat::Rgba8Unorm, w, h);
    let px = crate::compose::texels(gpu, &target, w, h, 0)?;
    let row = (w * 4) as usize;
    Ok((0..h as usize).rev().flat_map(|y| px[y * row..(y + 1) * row].to_vec()).collect())
}

// ── THE BAKED-MAP PATH (item 3: calibrated outputs that play an imported .mpcdi) ─────────────────────
// ProjectorGL.setBakedMap / setBakedAlpha / drawBaked + FRAG_BAKED, line for line. Per projector pixel the
// map holds the CONTENT coordinate (and coverage); the content is read there, the soft edge and an optional
// imported RIG blend (8-bit) shape the light, then gain / lift / brightness / gamma, coverage last. One
// fullscreen pass, NO MSAA (drawBaked draws straight to the default framebuffer). The raster is drawn
// BOTTOM-UP like the mesh path (see `render`), which is also what makes vRaster come out as GL's: y up.
// The map is RGBA32F and NEAREST in the app; wgpu refuses a float32 texture behind a filtering sampler
// without an optional feature, and NEAREST at these coordinates IS a texel load at floor(uv × size), so
// the shader loads texels — the same texels.

/// A baked map as the app holds it after setBakedMap (packed RGBA32F: u, v, coverage, hit — misses dilated)
/// plus its optional rig blend.
pub struct Baked { pub map: wgpu::Texture, pub has_coverage: bool, pub alpha: Option<wgpu::Texture> }

/// setBakedMap's repack, exactly: (u, v, spare) per pixel with NaN where the projector has no content →
/// (u, v, coverage-or-1, hit), then every MISS that touches hits takes the mean uv of its 3×3 hits (alpha
/// stays 0), so a fringe pixel samples a real neighbour rather than the picture's (0, 0) corner. Float32Array
/// stores round every value to f32; the means are JS doubles over f32 values, stored as f32.
pub fn pack_baked(w: usize, h: usize, uv: &[f32]) -> (Vec<f32>, bool) {
    let mut packed = vec![0f32; w * h * 4];
    for i in 0..w * h {
        let (u, v) = (uv[i * 3], uv[i * 3 + 1]);
        let hit = u.is_finite() && v.is_finite();
        packed[i * 4] = if hit { u } else { 0.0 };
        packed[i * 4 + 1] = if hit { v } else { 0.0 };
        packed[i * 4 + 2] = if hit { if uv[i * 3 + 2].is_finite() { uv[i * 3 + 2] } else { 1.0 } } else { 0.0 };
        packed[i * 4 + 3] = if hit { 1.0 } else { 0.0 };
    }
    let src = packed.clone();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            if src[i + 3] > 0.0 { continue; }
            let (mut su, mut sv, mut n) = (0f64, 0f64, 0u32);
            for dy in -1i64..=1 {
                let yy = y as i64 + dy; if yy < 0 || yy >= h as i64 { continue; }
                for dx in -1i64..=1 {
                    let xx = x as i64 + dx; if xx < 0 || xx >= w as i64 { continue; }
                    let j = (yy as usize * w + xx as usize) * 4;
                    if src[j + 3] > 0.0 { su += src[j] as f64; sv += src[j + 1] as f64; n += 1; }
                }
            }
            if n > 0 { packed[i] = (su / n as f64) as f32; packed[i + 1] = (sv / n as f64) as f32; }
        }
    }
    let partial = (0..w * h).any(|i| { let c = packed[i * 4 + 2]; packed[i * 4 + 3] > 0.0 && c > 0.0 && c < 0.999 });
    (packed, partial)
}

pub fn baked_upload(gpu: &Gpu, w: u32, h: u32, uv: &[f32], alpha: Option<(u32, u32, &[u8])>) -> Baked {
    let d = &gpu.device;
    let (packed, has_coverage) = pack_baked(w as usize, h as usize, uv);
    let map = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("baked map"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba32Float, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
    gpu.queue.write_texture(map.as_image_copy(), &packed.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 16), rows_per_image: Some(h) }, wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
    let alpha = alpha.filter(|(aw, ah, data)| *aw > 0 && *ah > 0 && data.len() >= (*aw * *ah) as usize).map(|(aw, ah, data)| {
        let t = d.create_texture(&wgpu::TextureDescriptor {
            label: Some("baked rig alpha"), size: wgpu::Extent3d { width: aw, height: ah, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::R8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
        // Rows of `aw` bytes: wgpu needs no 4-alignment for a direct write (UNPACK_ALIGNMENT 1 in the app).
        gpu.queue.write_texture(t.as_image_copy(), &data[..(aw * ah) as usize], wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(aw), rows_per_image: Some(ah) },
            wgpu::Extent3d { width: aw, height: ah, depth_or_array_layers: 1 });
        t
    });
    Baked { map, has_coverage, alpha }
}

const BAKED_WGSL: &str = r#"
struct U { soft: vec4<f32>, gain: vec4<f32>, lift: vec4<f32>, blend_gamma: f32, gamma: f32, brightness: f32, has_cov: f32, has_alpha: f32, _a: f32, _b: f32, _c: f32 };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@group(0) @binding(3) var bmap: texture_2d<f32>;
@group(0) @binding(4) var alpha: texture_2d<f32>;
@group(0) @binding(5) var asamp: sampler;
@group(0) @binding(6) var msamp: sampler;   // NON-filtering: the map is RGBA32F and NEAREST, as in the app

struct V { @builtin(position) pos: vec4<f32>, @location(0) vraster: vec2<f32> };
// VERT_BAKED: the SAME big triangle (-1,-1), (3,-1), (-1,3) and vRaster = aPos × 0.5 + 0.5 as a VARYING —
// interpolated as GL's is, by construction. (It was not what fixed the smaller map — the point sampler was,
// see `texel` — but it removes one more way for the two to differ.) The clip y is mirrored: bottom-up.
@vertex
fn vs(@builtin(vertex_index) i: u32) -> V {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return V(vec4<f32>(x, -y, 0.0, 1.0), vec2<f32>(x, y) * 0.5 + 0.5);
}

fn feather(d: f32, w: f32) -> f32 { if (w <= 0.0) { return 1.0; } return clamp(d / w, 0.0, 1.0); }
fn share(uv: vec2<f32>, s: vec4<f32>) -> f32 {
    return feather(uv.x, s.x) * feather(1.0 - uv.x, s.y) * feather(uv.y, s.z) * feather(1.0 - uv.y, s.w);
}
fn signal(sh: f32, g: f32) -> f32 { return pow(max(sh, 0.0), 1.0 / max(g, 0.1)); }
// GL NEAREST + CLAMP_TO_EDGE through the HARDWARE point sampler — not floor(uv × size) by hand: the sampler
// works in fixed point, and on an exact texel boundary (a smaller map: every third pixel of 640 → 960) it
// picks the texel the app's does, where an exact floor picked the other (measured: 2–5% of pixels).
fn texel(p: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(bmap, msamp, p, 0.0);
}

@fragment
fn fs(v: V) -> @location(0) vec4<f32> {
    let vraster = v.vraster;
    let m = texel(vraster);
    let t = vec2<f32>(1.0) / vec2<f32>(textureDimensions(bmap));
    var cov: f32;
    if (u.has_cov > 0.5) {
        cov = clamp(m.b, 0.0, 1.0);
    } else {
        cov = (
            4.0 * texel(vraster).a
          + 2.0 * (texel(vraster + vec2<f32>(t.x, 0.0)).a + texel(vraster + vec2<f32>(-t.x, 0.0)).a
                 + texel(vraster + vec2<f32>(0.0, t.y)).a + texel(vraster + vec2<f32>(0.0, -t.y)).a)
          +        texel(vraster + vec2<f32>(t.x, t.y)).a + texel(vraster + vec2<f32>(-t.x, t.y)).a
          +        texel(vraster + vec2<f32>(t.x, -t.y)).a + texel(vraster + vec2<f32>(-t.x, -t.y)).a
        ) / 16.0;
    }
    // Sample before any branch (uniform control flow for the implicit derivatives, as GL computes them for
    // the quad either way).
    var c = textureSample(tex, samp, vec2<f32>(m.r, 1.0 - m.g));
    let a = textureSample(alpha, asamp, vec2<f32>(vraster.x, 1.0 - vraster.y)).r;
    if (cov <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    let sh = share(vraster, u.soft) * mix(1.0, a, u.has_alpha);
    let pa = signal(sh, u.blend_gamma);
    var rgb = c.rgb * pa * u.gain.rgb + u.lift.rgb * (1.0 - pa);
    rgb = rgb * u.brightness;
    rgb = pow(max(rgb, vec3<f32>(0.0)), vec3<f32>(1.0 / u.gamma));
    return vec4<f32>(rgb * cov, 1.0);
}
"#;

/// drawBaked: the content through the baked map onto a `w`×`h` target (bottom-up; see `render_baked`).
pub fn draw_baked(gpu: &Gpu, content: &wgpu::Texture, baked: &Baked, o: &Opts, target: &wgpu::TextureView, format: wgpu::TextureFormat, w: u32, h: u32) {
    use wgpu::util::DeviceExt;
    let d = &gpu.device;
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("baked"), source: wgpu::ShaderSource::Wgsl(BAKED_WGSL.into()) });
    // An EXPLICIT layout: the map is an UNFILTERABLE float texture read through a NON-filtering sampler,
    // which wgpu's automatic layout cannot express (it would ask for a filterable float32 — an optional feature).
    let tex_entry = |b: u32, filterable: bool| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None };
    let samp_entry = |b: u32, t: wgpu::SamplerBindingType| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(t), count: None };
    let bgl = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("baked"), entries: &[
        tex_entry(0, true), samp_entry(1, wgpu::SamplerBindingType::Filtering),
        wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
        tex_entry(3, false), tex_entry(4, true), samp_entry(5, wgpu::SamplerBindingType::Filtering), samp_entry(6, wgpu::SamplerBindingType::NonFiltering),
    ] });
    let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("baked"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
    let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("baked"), layout: Some(&pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let samp = d.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, mipmap_filter: wgpu::MipmapFilterMode::Linear,
        lod_max_clamp: 4.0, anisotropy_clamp: 8, ..Default::default()
    });
    let asamp = d.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default()
    });
    // No alpha map: a 1×1 white stand-in (uHasAlpha 0 ignores it, as the app's unbound unit is ignored).
    let white = d.create_texture_with_data(&gpu.queue, &wgpu::TextureDescriptor {
        label: Some("no alpha"), size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::R8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] },
        wgpu::util::TextureDataOrder::LayerMajor, &[255]);
    let f = |v: f64| (v as f32).to_le_bytes();
    let mut ub = Vec::new();
    for v in o.soft { ub.extend(f(v)); }
    for v in o.color_gain { ub.extend(f(v)); } ub.extend(f(0.0));
    for v in o.black_lift { ub.extend(f(v)); } ub.extend(f(1.0));
    for v in [o.blend_gamma, o.gamma, o.brightness, if baked.has_coverage { 1.0 } else { 0.0 }, if baked.alpha.is_some() { 1.0 } else { 0.0 },
              1.0 / w as f64, 1.0 / h as f64, 0.0] { ub.extend(f(v)); }
    let ubuf = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("baked u"), contents: &ub, usage: wgpu::BufferUsages::UNIFORM });
    let (cv, mv) = (content.create_view(&Default::default()), baked.map.create_view(&Default::default()));
    let av = baked.alpha.as_ref().unwrap_or(&white).create_view(&Default::default());
    let msamp = d.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Nearest, min_filter: wgpu::FilterMode::Nearest, ..Default::default() });
    let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &bgl, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&cv) },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&samp) },
        wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&mv) },
        wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&av) },
        wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::Sampler(&asamp) },
        wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::Sampler(&msamp) },
    ] });
    let mut enc = d.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("baked"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
        pass.set_pipeline(&pipe); pass.set_bind_group(0, &bind, &[]); pass.draw(0..3, 0..1);
    }
    gpu.queue.submit([enc.finish()]);
}

/// Offscreen: the baked output as RGBA8, top row first (the raster is drawn bottom-up — see `render`).
pub fn render_baked(gpu: &Gpu, content: &wgpu::Texture, baked: &Baked, o: &Opts, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let d = &gpu.device;
    let target = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("projector raster"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
    draw_baked(gpu, content, baked, o, &target.create_view(&Default::default()), wgpu::TextureFormat::Rgba8Unorm, w, h);
    let px = crate::compose::texels(gpu, &target, w, h, 0)?;
    let row = (w * 4) as usize;
    Ok((0..h as usize).rev().flat_map(|y| px[y * row..(y + 1) * row].to_vec()).collect())
}
