//! E4b — AMBIENT OCCLUSION for the engine's Rendered look (the editor's RenderedMode: GTAO at half resolution,
//! multiplied into the frame BEFORE bloom — `lit = color · ao`).
//!
//! A screen-space pass over the main pass's own depth (its MSAA depth, sample 0 — no second geometry pass): at half
//! resolution, each pixel's view-space position is rebuilt from depth, its normal from its neighbours, and sixteen
//! points of a hemisphere around it (RADIUS, turned per pixel by interleaved-gradient noise) are tested against the
//! depth buffer; the fraction found buried darkens it, faded with distance so a far wall does not shade a near one.
//! A 4 × 4 blur takes the noise out, and `apply` writes `lit = hdr · ao` for post.rs to bloom and tone-map.
//! Not three's GTAO line for line (a horizon search) — the same idea and the same place in the frame; the editor
//! itself runs it at half resolution as "most of the look for a quarter of the cost".

const RADIUS: f32 = 0.35;
const POWER: f32 = 3.0;

const SHADER: &str = r#"
struct P { proj: vec4<f32>, size: vec4<f32>, dbg: vec4<f32> };   // proj: f, aspect, A, B (z_view = -B / (d + A)); size: full w, h, radius, power; dbg.x: show the AO alone
@group(0) @binding(0) var depth: texture_depth_multisampled_2d;
@group(0) @binding(1) var<uniform> p: P;
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;
@group(2) @binding(0) var hdr: texture_2d<f32>;

struct FOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_full(@builtin(vertex_index) i: u32) -> FOut {
  let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: FOut;
  o.pos = vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(xy.x, 1.0 - xy.y);
  return o;
}

fn view_at(uv: vec2<f32>) -> vec4<f32> {
  let full = vec2<i32>(p.size.xy);
  let px = clamp(vec2<i32>(uv * p.size.xy), vec2<i32>(0), full - 1);
  let d = textureLoad(depth, px, 0);
  if (d >= 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  let z = -p.proj.w / (d + p.proj.z);
  // At the CENTRE of the pixel the depth came from: x / y rebuilt from the raw uv while z came from the whole pixel
  // moved a grazing floor's points along the view ray row by row — false occlusion, in horizontal bands.
  let uvc = (vec2<f32>(px) + 0.5) / p.size.xy;
  let ndc = vec2<f32>(uvc.x * 2.0 - 1.0, 1.0 - uvc.y * 2.0);
  return vec4<f32>(ndc.x * (-z) * p.proj.y / p.proj.x, ndc.y * (-z) / p.proj.x, z, 1.0);
}
fn to_uv(v: vec3<f32>) -> vec2<f32> {
  let ndc = vec2<f32>(p.proj.x / p.proj.y * v.x, p.proj.x * v.y) / max(-v.z, 1e-4);
  return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

@fragment fn fs_ao(i: FOut) -> @location(0) vec4<f32> {
  let c = view_at(i.uv);
  if (c.w == 0.0) { return vec4<f32>(1.0); }
  let e = 1.0 / p.size.xy;
  let rx = view_at(i.uv + vec2<f32>(e.x, 0.0));
  let ry = view_at(i.uv + vec2<f32>(0.0, e.y));
  var n = normalize(cross(rx.xyz - c.xyz, ry.xyz - c.xyz));
  if (dot(n, -c.xyz) < 0.0) { n = -n; }
  // A per-pixel turn (interleaved gradient noise), then a frame around the normal.
  let noise = fract(52.9829189 * fract(dot(i.pos.xy, vec2<f32>(0.06711056, 0.00583715))));
  let a = noise * 6.2831853;
  var t = normalize(cross(n, vec3<f32>(cos(a), sin(a), 0.37)));
  let b = cross(n, t);
  var occ = 0.0;
  let r = p.size.z;
  for (var k = 0u; k < 16u; k = k + 1u) {
    let fk = f32(k);
    // Through the hemisphere: the angle by the golden angle, the height above the surface spread by the golden
    // ratio (NOT growing with k — that left every long reach pointing straight up, past anything beside the
    // point), the reach growing with k, denser near the point.
    let ang = fk * 2.39996323;
    let h = 0.1 + 0.85 * fract((fk + 0.5) * 0.6180340);
    let s = sqrt(1.0 - h * h);
    let dir = t * (cos(ang) * s) + b * (sin(ang) * s) + n * h;
    let g = (fk + 1.0) / 16.0;
    let reach = r * mix(0.1, 1.0, g * g);
    let q = c.xyz + dir * reach;
    let sv = view_at(to_uv(q));
    if (sv.w == 0.0) { continue; }
    let range = smoothstep(0.0, 1.0, r / max(abs(c.z - sv.z), 1e-4));
    // The bias grows with distance: a floor seen at a grazing angle from far away otherwise occludes ITSELF in
    // bands (depth precision and the half-res normal), which is what the first Rendered capture showed.
    if (sv.z >= q.z + 0.02 + 0.002 * (-c.z)) { occ = occ + range; }
  }
  let ao = pow(clamp(1.0 - occ / 16.0, 0.0, 1.0), p.size.w);
  return vec4<f32>(ao, ao, ao, 1.0);
}
@fragment fn fs_blur(i: FOut) -> @location(0) vec4<f32> {
  let e = 1.0 / vec2<f32>(textureDimensions(src));
  var s = 0.0;
  for (var y = -2; y < 2; y = y + 1) { for (var x = -2; x < 2; x = x + 1) { s = s + textureSample(src, samp, i.uv + (vec2<f32>(f32(x), f32(y)) + 0.5) * e).r; } }
  return vec4<f32>(vec3<f32>(s / 16.0), 1.0);
}
@fragment fn fs_apply(i: FOut) -> @location(0) vec4<f32> {
  let c = textureSample(hdr, samp, i.uv);
  if (p.dbg.x > 0.5) { let a = textureSample(src, samp, i.uv).r; return vec4<f32>(a, a, a, 1.0); }
  return vec4<f32>(c.rgb * textureSample(src, samp, i.uv).r, c.a);
}
"#;

pub struct Ao {
    l_depth: wgpu::BindGroupLayout,
    l_tex: wgpu::BindGroupLayout,
    l_hdr: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    ao: wgpu::RenderPipeline,
    blur: wgpu::RenderPipeline,
    apply: wgpu::RenderPipeline,
    ubuf: wgpu::Buffer,
    sized: Option<Sized>,
}
struct Sized { key: (u32, u32, usize), occl: wgpu::TextureView, blurred: wgpu::TextureView, b_depth: wgpu::BindGroup, b_occl: wgpu::BindGroup, b_blurred: wgpu::BindGroup, b_hdr: wgpu::BindGroup }

impl Ao {
    /// `multisampled`: the depth it reads — the forward pass's MSAA depth (sample 0), or D1's single-sample G-buffer
    /// depth (`textureLoad(depth, px, 0)` reads sample 0 of the one and mip 0 of the other: the shader is the same text).
    pub fn new(d: &wgpu::Device, multisampled: bool) -> Ao {
        let src = if multisampled { SHADER.to_string() } else { SHADER.replace("texture_depth_multisampled_2d", "texture_depth_2d") };
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("view3d ao"), source: wgpu::ShaderSource::Wgsl(src.into()) });
        let tex = |b: u32| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None };
        let l_depth = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("ao depth"), entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled }, count: None },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
        ] });
        let l_tex = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("ao tex"), entries: &[tex(0),
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None }] });
        let l_hdr = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("ao hdr"), entries: &[tex(0)] });
        let pl = |ls: &[Option<&wgpu::BindGroupLayout>]| d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: ls, immediate_size: 0 });
        let (pl_ao, pl_blur, pl_apply) = (pl(&[Some(&l_depth)]), pl(&[Some(&l_depth), Some(&l_tex)]), pl(&[Some(&l_depth), Some(&l_tex), Some(&l_hdr)]));
        let pipe = |label: &str, layout: &wgpu::PipelineLayout, fs: &str| d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label), layout: Some(layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), targets: &[Some(crate::post::HDR.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let sampler = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge, ..Default::default() });
        let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("ao params"), size: 48, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        Ao { ao: pipe("ao", &pl_ao, "fs_ao"), blur: pipe("ao blur", &pl_blur, "fs_blur"), apply: pipe("ao apply", &pl_apply, "fs_apply"),
            l_depth, l_tex, l_hdr, sampler, ubuf, sized: None }
    }

    /// `lit = hdr · ao`, from the main pass's depth. `depth_id` changes whenever the depth target is re-created.
    #[allow(clippy::too_many_arguments)]
    pub fn run(&mut self, d: &wgpu::Device, q: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, depth: &wgpu::TextureView, depth_id: usize,
               hdr: &wgpu::TextureView, lit: &wgpu::TextureView, w: u32, h: u32, fov_deg: f32, near: f32, far: f32) {
        let key = (w, h, depth_id);
        if self.sized.as_ref().map(|s| s.key) != Some(key) {
            let half = |label: &str| d.create_texture(&wgpu::TextureDescriptor { label: Some(label), size: wgpu::Extent3d { width: (w / 2).max(1), height: (h / 2).max(1), depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: crate::post::HDR,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] }).create_view(&Default::default());
            let (occl, blurred) = (half("ao"), half("ao blurred"));
            let b_depth = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.l_depth, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(depth) },
                wgpu::BindGroupEntry { binding: 1, resource: self.ubuf.as_entire_binding() } ] });
            let tb = |v: &wgpu::TextureView| d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.l_tex, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(v) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) } ] });
            let (b_occl, b_blurred) = (tb(&occl), tb(&blurred));
            let b_hdr = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.l_hdr, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(hdr) }] });
            self.sized = Some(Sized { key, occl, blurred, b_depth, b_occl, b_blurred, b_hdr });
        }
        let s = self.sized.as_ref().unwrap();
        // The projection the view3d presenter draws with (WebGPU clip, z 0…1): z_view = −B / (d + A).
        let f = 1.0 / (fov_deg.to_radians() / 2.0).tan();
        let nf = 1.0 / (near - far);
        // ARTLUX_VIEW3D_AO_ONLY=1: the frame IS the occlusion term (white = open, dark = occluded) — for tuning, and
        // for test:engine-shadows --ao, which cannot see the term under Rendered's bloom otherwise.
        // Read once per process (O1-7: they were two environment reads on every frame).
        static ENV: std::sync::OnceLock<(f32, f32)> = std::sync::OnceLock::new();
        let (dbg, radius) = *ENV.get_or_init(|| (
            std::env::var("ARTLUX_VIEW3D_AO_ONLY").is_ok_and(|v| v == "1") as u32 as f32,
            std::env::var("ARTLUX_VIEW3D_AO_RADIUS").ok().and_then(|v| v.parse::<f32>().ok()).unwrap_or(RADIUS)));
        let params = [f, w as f32 / h.max(1) as f32, far * nf, near * far * nf, w as f32, h as f32, radius, POWER, dbg, 0.0, 0.0, 0.0];
        q.write_buffer(&self.ubuf, 0, &params.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>());
        let pass = |enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, pipe: &wgpu::RenderPipeline, binds: &[&wgpu::BindGroup]| {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("view3d ao"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::WHITE), store: wgpu::StoreOp::Store } })],
                ..Default::default() });
            p.set_pipeline(pipe);
            for (i, b) in binds.iter().enumerate() { p.set_bind_group(i as u32, *b, &[]); }
            p.draw(0..3, 0..1);
        };
        pass(enc, &s.occl, &self.ao, &[&s.b_depth]);
        pass(enc, &s.blurred, &self.blur, &[&s.b_depth, &s.b_occl]);
        pass(enc, lit, &self.apply, &[&s.b_depth, &s.b_blurred, &s.b_hdr]);
    }
}
