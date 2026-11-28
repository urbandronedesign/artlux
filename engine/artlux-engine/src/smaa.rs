//! D1-2 — THE DEFERRED PATH'S ANTI-ALIASING (plans/engine-optimisation-and-deferred-3d.md §4.5): SMAA 1x, ported line
//! for line from what the editor's Rendered look runs — three.js `SMAANode` (examples/jsm/tsl/display, MIT; SMAA is
//! Jimenez, Echevarria, Sousa, Gutierrez, MIT) as RenderedMode.tsx places it: AFTER the tone curve and the sRGB
//! encoding (`smaa(renderOutput(lit + glow))`), so edges are found and blended on DISPLAY values, as the editor does.
//!
//!   1. the post's final pass (bloom + AgX) renders into `ldr()` — an sRGB view of an 8-bit texture, so the bytes
//!      stored are display-encoded;
//!   2. EDGES: colour deltas to the left / top over a 0.1 threshold, with local contrast adaptation;
//!   3. WEIGHTS: the edge searches (8 steps, the pseudo-gather offsets) and the precomputed AREA texture;
//!   4. BLEND: each pixel mixed toward its strongest neighbour — written to the swapchain decoded, because the
//!      swapchain is sRGB and re-encodes (the editor's output does no transform after SMAA).
//!
//! The two lookup textures are three's own (its base64 PNGs, extracted to assets/ unchanged). Every sample is a
//! `textureSampleLevel(…, 0)`: the searches run in non-uniform control flow, where WGSL allows no derivatives.

const AREA_PNG: &[u8] = include_bytes!("../assets/smaa-area.png");
const SEARCH_PNG: &[u8] = include_bytes!("../assets/smaa-search.png");
const MID: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;   // three: HalfFloatType render targets

const SHADER: &str = r#"
// Edges: t0 the frame (display values). Weights: t0 the edges, t1 the area, t2 the search. Blend: t0 the frame, t1 the weights.
@group(0) @binding(0) var t0: texture_2d<f32>;
@group(0) @binding(1) var t1: texture_2d<f32>;
@group(0) @binding(2) var t2: texture_2d<f32>;
@group(0) @binding(3) var lin: sampler;
@group(0) @binding(4) var pnt: sampler;

const THRESHOLD: f32 = 0.1;
const MAX_SEARCH_STEPS: i32 = 8;
const AREATEX_MAX_DISTANCE: f32 = 16.0;
const AREATEX_PIXEL_SIZE: vec2<f32> = vec2<f32>(1.0 / 160.0, 1.0 / 560.0);
const AREATEX_SUBTEX_SIZE: f32 = 1.0 / 7.0;

struct FOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_full(@builtin(vertex_index) i: u32) -> FOut {
  let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FOut;
  o.pos = vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x, 1.0 - xy.y);   // top-left origin: SMAA's own (Direct3D) convention
  return o;
}
fn inv_size() -> vec2<f32> { return 1.0 / vec2<f32>(textureDimensions(t0)); }
fn s0(c: vec2<f32>) -> vec4<f32> { return textureSampleLevel(t0, lin, c, 0.0); }
fn mx(t: vec3<f32>) -> f32 { return max(t.r, max(t.g, t.b)); }

// ---- 1. edges (colour) ----
@fragment fn fs_edges(i: FOut) -> @location(0) vec4<f32> {
  let r = inv_size();
  let uv = i.uv;
  let c = s0(uv).rgb;
  var delta = vec4<f32>(0.0);
  delta.x = mx(abs(c - s0(uv + vec2<f32>(-r.x, 0.0)).rgb));
  delta.y = mx(abs(c - s0(uv + vec2<f32>(0.0, -r.y)).rgb));
  var edges = step(vec2<f32>(THRESHOLD), delta.xy);
  if (dot(edges, vec2<f32>(1.0)) == 0.0) { discard; }
  delta.z = mx(abs(c - s0(uv + vec2<f32>(r.x, 0.0)).rgb));
  delta.w = mx(abs(c - s0(uv + vec2<f32>(0.0, r.y)).rgb));
  var m = max(max(delta.x, delta.y), max(delta.z, delta.w));
  let ll = mx(abs(c - s0(uv + vec2<f32>(-2.0 * r.x, 0.0)).rgb));
  let tt = mx(abs(c - s0(uv + vec2<f32>(0.0, -2.0 * r.y)).rgb));
  m = max(m, max(ll, tt));
  // Local contrast adaptation:
  edges = edges * step(vec2<f32>(0.5 * m), delta.xy);
  return vec4<f32>(edges, 0.0, 0.0);
}

// ---- 2. blending weights ----
fn search_length(e: vec2<f32>, bias: f32, scale: f32) -> f32 {
  var coord = e;
  coord.x = bias + coord.x * scale;
  return 255.0 * textureSampleLevel(t2, pnt, coord, 0.0).r;
}
fn area(dist: vec2<f32>, e1: f32, e2: f32, offset: f32) -> vec2<f32> {
  // Rounding prevents precision errors of bilinear filtering:
  var tc = AREATEX_MAX_DISTANCE * round(4.0 * vec2<f32>(e1, e2)) + dist;
  tc = AREATEX_PIXEL_SIZE * tc + 0.5 * AREATEX_PIXEL_SIZE;
  tc.y = tc.y + AREATEX_SUBTEX_SIZE * offset;
  return textureSampleLevel(t1, lin, tc, 0.0).rg;
}
fn search_x_left(texcoord: vec2<f32>, end: f32) -> f32 {
  let r = inv_size();
  var e = vec2<f32>(0.0, 1.0);
  var coord = texcoord;
  for (var k = 0; k < MAX_SEARCH_STEPS; k++) {
    e = s0(coord).rg;
    coord = coord - vec2<f32>(2.0, 0.0) * r;
    if (coord.x <= end || e.g <= 0.8281 || e.r != 0.0) { break; }
  }
  coord.x = coord.x + 0.25 * r.x;   // the (-0.25, -0.125) offset of the vertex stage, undone
  coord.x = coord.x + r.x;           // the searches are biased by 1
  coord.x = coord.x + 2.0 * r.x;     // the length the last step added
  coord.x = coord.x - r.x * search_length(e, 0.0, 0.5);
  return coord.x;
}
fn search_x_right(texcoord: vec2<f32>, end: f32) -> f32 {
  let r = inv_size();
  var e = vec2<f32>(0.0, 1.0);
  var coord = texcoord;
  for (var k = 0; k < MAX_SEARCH_STEPS; k++) {
    e = s0(coord).rg;
    coord = coord + vec2<f32>(2.0, 0.0) * r;
    if (coord.x >= end || e.g <= 0.8281 || e.r != 0.0) { break; }
  }
  coord.x = coord.x - 0.25 * r.x;
  coord.x = coord.x - r.x;
  coord.x = coord.x - 2.0 * r.x;
  coord.x = coord.x + r.x * search_length(e, 0.5, 0.5);
  return coord.x;
}
fn search_y_up(texcoord: vec2<f32>, end: f32) -> f32 {
  let r = inv_size();
  var e = vec2<f32>(1.0, 0.0);
  var coord = texcoord;
  for (var k = 0; k < MAX_SEARCH_STEPS; k++) {
    e = s0(coord).rg;
    coord = coord + vec2<f32>(0.0, -2.0) * r;
    if (coord.y <= end || e.r <= 0.8281 || e.g != 0.0) { break; }
  }
  coord.y = coord.y + 0.25 * r.y;
  coord.y = coord.y + r.y;
  coord.y = coord.y + 2.0 * r.y;
  coord.y = coord.y - r.y * search_length(e.gr, 0.0, 0.5);
  return coord.y;
}
fn search_y_down(texcoord: vec2<f32>, end: f32) -> f32 {
  let r = inv_size();
  var e = vec2<f32>(1.0, 0.0);
  var coord = texcoord;
  for (var k = 0; k < MAX_SEARCH_STEPS; k++) {
    e = s0(coord).rg;
    coord = coord - vec2<f32>(0.0, -2.0) * r;
    if (coord.y >= end || e.r <= 0.8281 || e.g != 0.0) { break; }
  }
  coord.y = coord.y - 0.25 * r.y;
  coord.y = coord.y - r.y;
  coord.y = coord.y - 2.0 * r.y;
  coord.y = coord.y + r.y * search_length(e.gr, 0.5, 0.5);
  return coord.y;
}
@fragment fn fs_weights(i: FOut) -> @location(0) vec4<f32> {
  let r = inv_size();
  let uv = i.uv;
  let pix = uv / r;
  // The searches' offsets (@PSEUDO_GATHER4) and their ends:
  let o0 = uv.xyxy + r.xyxy * vec4<f32>(-0.25, -0.125, 1.25, -0.125);
  let o1 = uv.xyxy + r.xyxy * vec4<f32>(-0.125, -0.25, -0.125, 1.25);
  let o2 = vec4<f32>(o0.xz, o1.yw) + vec4<f32>(-2.0, 2.0, -2.0, 2.0) * r.xxyy * f32(MAX_SEARCH_STEPS);
  var w = vec4<f32>(0.0);
  let e = s0(uv).rg;
  if (e.g > 0.0) {   // an edge at north
    let cl = vec2<f32>(search_x_left(o0.xy, o2.x), o1.y);
    let e1 = s0(cl).r;
    let cr = vec2<f32>(search_x_right(o0.zw, o2.y), o1.y);
    let d = vec2<f32>(cl.x, cr.x) / r.x - pix.x;
    let e2 = s0(cr + vec2<f32>(r.x, 0.0)).r;
    let a = area(sqrt(abs(d)), e1, e2, 0.0);
    w = vec4<f32>(a, w.b, w.a);
  }
  if (e.r > 0.0) {   // an edge at west
    let cu = vec2<f32>(o0.x, search_y_up(o1.xy, o2.z));
    let e1 = s0(cu).g;
    let cd = vec2<f32>(o0.x, search_y_down(o1.zw, o2.w));
    let d = vec2<f32>(cu.y, cd.y) / r.y - pix.y;
    let e2 = s0(cd + vec2<f32>(0.0, r.y)).g;
    let a = area(sqrt(abs(d)), e1, e2, 0.0);
    w = vec4<f32>(w.r, w.g, a);
  }
  return w;
}

// ---- 3. neighbourhood blending ----
fn to_linear(c: vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
  return select(hi, lo, c <= vec3<f32>(0.04045));
}
@fragment fn fs_blend(i: FOut) -> @location(0) vec4<f32> {
  let r = inv_size();
  let uv = i.uv;
  let wc = textureSampleLevel(t1, lin, uv, 0.0);
  let a = vec4<f32>(wc.x, textureSampleLevel(t1, lin, uv + vec2<f32>(0.0, r.y), 0.0).g,
                    wc.z, textureSampleLevel(t1, lin, uv + vec2<f32>(r.x, 0.0), 0.0).a);
  var c = s0(uv).rgb;
  if (dot(a, vec4<f32>(1.0)) >= 1e-5) {
    // Up to four lines cross a pixel; the strongest per direction, then the stronger direction:
    var off = vec2<f32>(select(-a.b, a.a, a.a > a.b), select(-a.r, a.g, a.g > a.r));
    if (abs(off.x) > abs(off.y)) { off.y = 0.0; } else { off.x = 0.0; }
    let cop = s0(uv + sign(off) * r).rgb;
    let s = select(abs(off.y), abs(off.x), abs(off.x) > abs(off.y));
    c = mix(c, cop, s);
  }
  // The swapchain is sRGB and encodes on write; these are already display values.
  return vec4<f32>(to_linear(c), 1.0);
}
"#;

pub struct Smaa {
    layout: wgpu::BindGroupLayout,
    lin: wgpu::Sampler,
    pnt: wgpu::Sampler,
    edges: wgpu::RenderPipeline,
    weights: wgpu::RenderPipeline,
    blend: wgpu::RenderPipeline,
    area: wgpu::TextureView,
    search: wgpu::TextureView,
    ldr_format: wgpu::TextureFormat,
    out_format: wgpu::TextureFormat,
    sized: Option<Sized>,
}
struct Sized {
    size: (u32, u32),
    /// What the post's final pass draws into: the sRGB view (encodes on write) …
    ldr_srgb: wgpu::TextureView,
    edges: wgpu::TextureView,
    weights: wgpu::TextureView,
    b_edges: wgpu::BindGroup,
    b_weights: wgpu::BindGroup,
    b_blend: wgpu::BindGroup,
}

impl Smaa {
    /// `out_format`: the swapchain's (sRGB) — the post's final pass targets the same format, so its pipeline draws
    /// into `ldr()` unchanged.
    pub fn new(d: &wgpu::Device, q: &wgpu::Queue, out_format: wgpu::TextureFormat) -> Smaa {
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("view3d smaa"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let tex = |b: u32| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None };
        let smp = |b: u32| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None };
        let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("smaa"), entries: &[tex(0), tex(1), tex(2), smp(3), smp(4)] });
        let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipe = |label: &str, fs: &str, fmt: wgpu::TextureFormat| d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label), layout: Some(&pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), targets: &[Some(fmt.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let clamp = (wgpu::AddressMode::ClampToEdge, wgpu::AddressMode::ClampToEdge);
        let lin = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, address_mode_u: clamp.0, address_mode_v: clamp.1, ..Default::default() });
        let pnt = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Nearest, min_filter: wgpu::FilterMode::Nearest, address_mode_u: clamp.0, address_mode_v: clamp.1, ..Default::default() });
        // The lookup textures, raw (three: NoColorSpace, flipY false).
        let upload = |label: &str, png: &[u8]| {
            let img = image::load_from_memory(png).expect("SMAA's lookup texture (assets/) decodes").to_rgba8();
            let (w, h) = img.dimensions();
            let t = d.create_texture(&wgpu::TextureDescriptor { label: Some(label), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
            q.write_texture(wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, &img,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * w), rows_per_image: Some(h) }, wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
            t.create_view(&Default::default())
        };
        let ldr_format = out_format.remove_srgb_suffix();
        Smaa {
            edges: pipe("smaa edges", "fs_edges", MID),
            weights: pipe("smaa weights", "fs_weights", MID),
            blend: pipe("smaa blend", "fs_blend", out_format),
            area: upload("smaa area", AREA_PNG), search: upload("smaa search", SEARCH_PNG),
            layout, lin, pnt, ldr_format, out_format, sized: None,
        }
    }

    pub fn ensure(&mut self, d: &wgpu::Device, w: u32, h: u32) {
        if self.sized.as_ref().map(|s| s.size) == Some((w, h)) { return; }
        let ext = wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 };
        let usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let ldr = d.create_texture(&wgpu::TextureDescriptor { label: Some("smaa input"), size: ext, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: self.ldr_format, usage, view_formats: &[self.out_format] });
        let ldr_srgb = ldr.create_view(&wgpu::TextureViewDescriptor { format: Some(self.out_format), ..Default::default() });
        // … and the plain view the passes read: the stored (display-encoded) bytes, not decoded.
        let ldr_raw = ldr.create_view(&Default::default());
        let mid = |label: &str| d.create_texture(&wgpu::TextureDescriptor { label: Some(label), size: ext, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: MID, usage, view_formats: &[] }).create_view(&Default::default());
        let edges = mid("smaa edges");
        let weights = mid("smaa weights");
        let bind = |a: &wgpu::TextureView, b: &wgpu::TextureView, c: &wgpu::TextureView| d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.layout, entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(a) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(b) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(c) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.lin) },
            wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.pnt) },
        ] });
        let b_edges = bind(&ldr_raw, &self.area, &self.search);
        let b_weights = bind(&edges, &self.area, &self.search);
        let b_blend = bind(&ldr_raw, &weights, &self.search);
        self.sized = Some(Sized { size: (w, h), ldr_srgb, edges, weights, b_edges, b_weights, b_blend });
    }

    /// Where the post's final pass draws when SMAA follows (after `ensure`).
    pub fn ldr(&self) -> Option<&wgpu::TextureView> { self.sized.as_ref().map(|s| &s.ldr_srgb) }

    /// Edges → weights → blend into `out` (the swapchain).
    pub fn run(&self, enc: &mut wgpu::CommandEncoder, out: &wgpu::TextureView) {
        let Some(s) = self.sized.as_ref() else { return };
        let pass = |enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, pipe: &wgpu::RenderPipeline, bind: &wgpu::BindGroup| {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("view3d smaa"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
                ..Default::default() });
            p.set_pipeline(pipe);
            p.set_bind_group(0, bind, &[]);
            p.draw(0..3, 0..1);
        };
        pass(enc, &s.edges, &self.edges, &s.b_edges);
        pass(enc, &s.weights, &self.weights, &s.b_weights);
        pass(enc, out, &self.blend, &s.b_blend);
    }
}
