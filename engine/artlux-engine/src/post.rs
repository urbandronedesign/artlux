//! E4b — THE FRAME'S LAST STEP in the engine's 3D view: the scene is drawn into a linear HDR target (Rgba16Float), and
//! this turns it into what the window shows.
//!
//!   - SHADED: a straight copy — the swapchain is sRGB, so linear in, display out, exactly as before;
//!   - RENDERED (the editor's RenderedMode.tsx): BLOOM (three's BloomNode(strength 0.8, radius 0.4, threshold 0.6):
//!     a bright-pass, a chain of five half-size levels blurred down and added back up, weighted toward the wide
//!     levels by the radius) laid over the frame, then AgX tone mapping at exposure 1.1 (three.js ToneMapping AgX,
//!     line for line) — over EVERYTHING, screens included, as the editor's render pipeline does ("colours are tone-
//!     mapped: use Shaded to judge content" says its button).
//!
//! One module, one bind layout (a texture, a sampler, a small uniform) for every pass.

pub const HDR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const LEVELS: usize = 5;
/// three's BloomNode as RenderedMode uses it: strength, radius, threshold; RenderedMode's exposure.
const STRENGTH: f32 = 0.8;
const RADIUS: f32 = 0.4;
const THRESHOLD: f32 = 0.6;
const EXPOSURE: f32 = 1.1;

const SHADER: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> p: vec4<f32>;   // x: rendered, y: threshold, z: weight (up) / strength (final), w: texel size x (down)
@group(1) @binding(0) var bloom: texture_2d<f32>;

struct FOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_full(@builtin(vertex_index) i: u32) -> FOut {
  let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FOut;
  o.pos = vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x, 1.0 - xy.y);
  return o;
}

fn luma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }

// Down: a 13-tap box (the "dual filter" downsample) — the first level keeps only what is over the threshold
// (three's LuminosityHighPass, smoothWidth 0.01).
@fragment fn fs_down(i: FOut) -> @location(0) vec4<f32> {
  let d = 1.0 / vec2<f32>(textureDimensions(src));
  var c = textureSample(src, samp, i.uv).rgb * 4.0;
  c += textureSample(src, samp, i.uv + vec2<f32>(-d.x, -d.y)).rgb;
  c += textureSample(src, samp, i.uv + vec2<f32>( d.x, -d.y)).rgb;
  c += textureSample(src, samp, i.uv + vec2<f32>(-d.x,  d.y)).rgb;
  c += textureSample(src, samp, i.uv + vec2<f32>( d.x,  d.y)).rgb;
  c = c / 8.0;
  if (p.y > 0.0) {
    let l = luma(c);
    c = c * smoothstep(p.y, p.y + 0.01, l);
  }
  return vec4<f32>(c, 1.0);
}
// Up: a tent over the coarser level, added onto the finer one (additive blend), weighted.
@fragment fn fs_up(i: FOut) -> @location(0) vec4<f32> {
  let d = 1.0 / vec2<f32>(textureDimensions(src));
  var c = textureSample(src, samp, i.uv).rgb * 4.0;
  c += (textureSample(src, samp, i.uv + vec2<f32>(-d.x, 0.0)).rgb + textureSample(src, samp, i.uv + vec2<f32>(d.x, 0.0)).rgb
      + textureSample(src, samp, i.uv + vec2<f32>(0.0, -d.y)).rgb + textureSample(src, samp, i.uv + vec2<f32>(0.0, d.y)).rgb) * 2.0;
  c += textureSample(src, samp, i.uv + vec2<f32>(-d.x, -d.y)).rgb + textureSample(src, samp, i.uv + vec2<f32>(d.x, -d.y)).rgb
     + textureSample(src, samp, i.uv + vec2<f32>(-d.x, d.y)).rgb + textureSample(src, samp, i.uv + vec2<f32>(d.x, d.y)).rgb;
  return vec4<f32>(c / 16.0 * p.z, 1.0);
}

// three.js AgXToneMapping (src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js).
fn agx_contrast(x: vec3<f32>) -> vec3<f32> {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(c0: vec3<f32>, exposure: f32) -> vec3<f32> {
  let srgb_to_2020 = mat3x3<f32>(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956);
  let r2020_to_srgb = mat3x3<f32>(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
  let inset = mat3x3<f32>(0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859);
  let outset = mat3x3<f32>(1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  let min_ev = -12.47393;
  let max_ev = 4.026069;
  var c = c0 * exposure;
  c = srgb_to_2020 * c;
  c = inset * c;
  c = max(c, vec3<f32>(1e-10));
  c = log2(c);
  c = (c - min_ev) / (max_ev - min_ev);
  c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  c = agx_contrast(c);
  c = outset * c;
  c = pow(max(vec3<f32>(0.0), c), vec3<f32>(2.2));
  c = r2020_to_srgb * c;
  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment fn fs_final(i: FOut) -> @location(0) vec4<f32> {
  var c = textureSample(src, samp, i.uv).rgb;
  if (p.x > 0.5) {
    c = c + textureSample(bloom, samp, i.uv).rgb * p.z;
    c = agx(c, p.w);
  }
  return vec4<f32>(c, 1.0);
}
"#;

pub struct Post {
    layout: wgpu::BindGroupLayout,
    bloom_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    down: wgpu::RenderPipeline,
    up: wgpu::RenderPipeline,
    fin: wgpu::RenderPipeline,
    /// Per size: the HDR resolve target and the bloom chain (views), and their bind groups.
    sized: Option<Sized>,
    dummy_bloom: wgpu::BindGroup,
}
struct Sized {
    size: (u32, u32),
    hdr: wgpu::TextureView,
    levels: Vec<wgpu::TextureView>,
    /// Down: level 0 reads the HDR (thresholded), level i reads level i-1. Up: level i reads level i+1.
    down_binds: Vec<wgpu::BindGroup>,
    up_binds: Vec<wgpu::BindGroup>,
    final_bind: wgpu::BindGroup,
    final_bloom: wgpu::BindGroup,
    ubufs: Vec<wgpu::Buffer>,
}

impl Post {
    pub fn new(d: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Post {
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("view3d post"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("post"), entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
        ] });
        let bloom_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("post bloom"), entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
        ] });
        let one = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let two = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout), Some(&bloom_layout)], immediate_size: 0 });
        let pipe = |label: &str, pl: &wgpu::PipelineLayout, fs: &str, fmt: wgpu::TextureFormat, blend: Option<wgpu::BlendState>| d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label), layout: Some(pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), targets: &[Some(wgpu::ColorTargetState { format: fmt, blend, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let add = wgpu::BlendState { color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add }, alpha: wgpu::BlendComponent::REPLACE };
        let sampler = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge, ..Default::default() });
        let t = d.create_texture(&wgpu::TextureDescriptor { label: Some("no bloom"), size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: HDR, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
        let dummy_bloom = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &bloom_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&t.create_view(&Default::default())) }] });
        Post {
            down: pipe("bloom down", &one, "fs_down", HDR, None),
            up: pipe("bloom up", &one, "fs_up", HDR, Some(add)),
            fin: pipe("view3d final", &two, "fs_final", surface_format, None),
            layout, bloom_layout, sampler, sized: None, dummy_bloom,
        }
    }

    /// The HDR target and the bloom chain at this size (re-created when it changes).
    pub fn ensure(&mut self, d: &wgpu::Device, w: u32, h: u32) {
        if self.sized.as_ref().map(|s| s.size) != Some((w, h)) {
            let tex = |label: &str, w: u32, h: u32| d.create_texture(&wgpu::TextureDescriptor { label: Some(label), size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: HDR,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] }).create_view(&Default::default());
            let hdr = tex("view3d hdr", w, h);
            let levels: Vec<wgpu::TextureView> = (0..LEVELS).map(|i| tex("bloom", w >> (i + 1), h >> (i + 1))).collect();
            let ubuf = |v: [f32; 4]| {
                let b = d.create_buffer(&wgpu::BufferDescriptor { label: Some("post params"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: true });
                b.slice(..).get_mapped_range_mut().expect("a buffer mapped at creation").copy_from_slice(&v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>());
                b.unmap();
                b
            };
            let bind = |view: &wgpu::TextureView, u: &wgpu::Buffer| d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.layout, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: u.as_entire_binding() },
            ] });
            let mut ubufs = Vec::new();
            let mut down_binds = Vec::new();
            for i in 0..LEVELS {
                let u = ubuf([0.0, if i == 0 { THRESHOLD } else { 0.0 }, 0.0, 0.0]);
                down_binds.push(bind(if i == 0 { &hdr } else { &levels[i - 1] }, &u));
                ubufs.push(u);
            }
            // UnrealBloom's bloomFactors (1, 0.8, 0.6, 0.4, 0.2) lerped toward their mirror by the radius: the wider
            // levels weigh in more as the radius grows.
            let factor = |i: usize| { let f = [1.0, 0.8, 0.6, 0.4, 0.2][i]; f + (1.2 - f - f) * RADIUS };
            let mut up_binds = Vec::new();
            for i in 0..LEVELS - 1 {
                let u = ubuf([0.0, 0.0, factor(i + 1), 0.0]);
                up_binds.push(bind(&levels[i + 1], &u));
                ubufs.push(u);
            }
            let uf = ubuf([0.0, 0.0, STRENGTH, EXPOSURE]);
            let final_bind = bind(&hdr, &uf);
            ubufs.push(uf);
            let final_bloom = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.bloom_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&levels[0]) }] });
            self.sized = Some(Sized { size: (w, h), hdr, levels, down_binds, up_binds, final_bind, final_bloom, ubufs });
        }
    }
    /// The single-sample HDR target the scene's MSAA pass resolves into (after `ensure`).
    pub fn hdr(&self) -> Option<&wgpu::TextureView> { self.sized.as_ref().map(|s| &s.hdr) }

    /// The frame's last passes into `out`: bloom (Rendered only) and the final copy / tone map.
    pub fn finish(&self, q: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, out: &wgpu::TextureView, rendered: bool) {
        let Some(s) = self.sized.as_ref() else { return };
        // The final pass's mode (x): written each frame, the rest is fixed per size.
        q.write_buffer(s.ubufs.last().unwrap(), 0, &(if rendered { 1.0f32 } else { 0.0 }).to_le_bytes());
        let pass = |enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, load: wgpu::LoadOp<wgpu::Color>, pipe: &wgpu::RenderPipeline, bind: &wgpu::BindGroup, bloom: Option<&wgpu::BindGroup>| {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("view3d post"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load, store: wgpu::StoreOp::Store } })],
                ..Default::default() });
            p.set_pipeline(pipe);
            p.set_bind_group(0, bind, &[]);
            if let Some(b) = bloom { p.set_bind_group(1, b, &[]); }
            p.draw(0..3, 0..1);
        };
        if rendered {
            for i in 0..LEVELS { pass(enc, &s.levels[i], wgpu::LoadOp::Clear(wgpu::Color::BLACK), &self.down, &s.down_binds[i], None); }
            for i in (0..LEVELS - 1).rev() { pass(enc, &s.levels[i], wgpu::LoadOp::Load, &self.up, &s.up_binds[i], None); }
        }
        pass(enc, out, wgpu::LoadOp::Clear(wgpu::Color::BLACK), &self.fin, &s.final_bind, Some(if rendered { &s.final_bloom } else { &self.dummy_bloom }));
    }
}
