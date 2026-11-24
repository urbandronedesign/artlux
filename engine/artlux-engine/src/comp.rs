//! E3a — THE TIMELINE COMPOSITE in the engine (plans/native-engine.md E3: "timeline composite and blend modes
//! in-engine"). The app keeps evaluating the timeline (timeline.nativeLayers: which clip, its fades, gating);
//! this draws what `compositeLayers` draws with them, in Canvas2D's terms:
//!   - the canvas starts TRANSPARENT (clearRect), 8-bit RGBA, PREMULTIPLIED — as a 2D canvas stores it;
//!   - each track, back-most first, is `drawImage(d, 0, 0, w, h)`: stretched to the whole canvas, bilinear
//!     (imageSmoothingEnabled, quality 'low' — no mips), with globalAlpha = track opacity, and the clip's own
//!     alpha (content opacity × fades) baked into its picture first (fadedDrawable) — here, one multiply;
//!   - globalCompositeOperation: normal → source-over, add → lighter, screen, multiply — the W3C compositing
//!     formulas on premultiplied colour;
//!   - every draw lands in an 8-bit target (a ping-pong pair), as each Canvas2D draw does.

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

const WGSL: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_2d<f32>;
struct U { alpha: f32, mode: u32, w: f32, h: f32 };
@group(0) @binding(3) var<uniform> u: U;
struct V { @builtin(position) p: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var a = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o: V; o.p = vec4<f32>(a[i], 0.0, 1.0); return o;
}
@fragment fn fs(v: V) -> @location(0) vec4<f32> {
  // drawImage(d, 0, 0, w, h): the destination pixel's centre maps to the same fraction of the source.
  let uv = v.p.xy / vec2<f32>(u.w, u.h);
  let s = textureSampleLevel(src, samp, uv, 0.0) * u.alpha;   // premultiplied × globalAlpha
  let d = textureLoad(dst, vec2<i32>(v.p.xy), 0);
  var o: vec4<f32>;
  if (u.mode == 1u) {          // lighter: plus, clamped
    o = min(s + d, vec4<f32>(1.0));
  } else if (u.mode == 2u) {   // screen: cs + cb − cs·cb (premultiplied, separable)
    o = vec4<f32>(s.rgb + d.rgb - s.rgb * d.rgb, s.a + d.a - s.a * d.a);
  } else if (u.mode == 3u) {   // multiply: cs(1−ab) + cb(1−as) + cs·cb
    o = vec4<f32>(s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.rgb * d.rgb, s.a + d.a - s.a * d.a);
  } else {                     // source-over
    o = s + d * (1.0 - s.a);
  }
  return o;
}
"#;

/// A track to draw: its picture's texture (+ the picture's visible rect, normalised), the clip alpha, the
/// track's opacity and its blend mode as the timeline names it.
pub struct Layer<'a> { pub tex: &'a wgpu::Texture, pub alpha: f32, pub opacity: f32, pub blend: &'a str }

pub struct Compositor { pipe: wgpu::RenderPipeline, layout: wgpu::BindGroupLayout, samp: wgpu::Sampler }

impl Compositor {
    pub fn new(gpu: &crate::Gpu) -> Compositor {
        let d = &gpu.device;
        let m = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("timeline composite"), source: wgpu::ShaderSource::Wgsl(WGSL.into()) });
        let tex = |b: u32, filterable: bool| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None };
        let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("composite"), entries: &[
            tex(0, true),
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            tex(2, false),
            wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
        ] });
        let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("timeline composite"), layout: Some(&pl),
            vertex: wgpu::VertexState { module: &m, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &m, entry_point: Some("fs"), targets: &[Some(FORMAT.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let samp = d.create_sampler(&wgpu::SamplerDescriptor { label: Some("drawImage"), address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, mipmap_filter: wgpu::MipmapFilterMode::Nearest, ..Default::default() });
        Compositor { pipe, layout, samp }
    }

    /// Composite `layers` (back-most first) into a fresh w × h picture: transparent, then each draw.
    pub fn render(&self, gpu: &crate::Gpu, w: u32, h: u32, layers: &[Layer]) -> wgpu::Texture {
        let d = &gpu.device;
        let mk = || d.create_texture(&wgpu::TextureDescriptor { label: Some("composite"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: FORMAT, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
        let mut a = mk();
        let mut b = mk();
        let mut enc = d.create_command_encoder(&Default::default());
        {
            // clearRect: transparent.
            let v = a.create_view(&Default::default());
            let _ = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("clear"), color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &v, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })], ..Default::default() });
        }
        let mut keep = Vec::new();   // the per-draw buffers and bind groups, alive until the submit
        for l in layers {
            let mode: u32 = match l.blend { "add" => 1, "screen" => 2, "multiply" => 3, _ => 0 };
            let alpha = (l.alpha.clamp(0.0, 1.0)) * l.opacity.clamp(0.0, 1.0);
            let mut ub = [0u8; 16];
            ub[0..4].copy_from_slice(&alpha.to_le_bytes());
            ub[4..8].copy_from_slice(&mode.to_le_bytes());
            ub[8..12].copy_from_slice(&(w as f32).to_le_bytes());
            ub[12..16].copy_from_slice(&(h as f32).to_le_bytes());
            let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            gpu.queue.write_buffer(&ubuf, 0, &ub);
            let sv = l.tex.create_view(&wgpu::TextureViewDescriptor { mip_level_count: Some(1), ..Default::default() });
            let dv = a.create_view(&Default::default());
            let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.layout, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&sv) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.samp) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&dv) },
                wgpu::BindGroupEntry { binding: 3, resource: ubuf.as_entire_binding() },
            ] });
            {
                let ov = b.create_view(&Default::default());
                let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("layer"), color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &ov, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })], ..Default::default() });
                pass.set_pipeline(&self.pipe);
                pass.set_bind_group(0, &bind, &[]);
                pass.draw(0..3, 0..1);
            }
            keep.push((ubuf, bind));
            std::mem::swap(&mut a, &mut b);
        }
        gpu.queue.submit([enc.finish()]);
        drop(keep);
        a
    }
}
