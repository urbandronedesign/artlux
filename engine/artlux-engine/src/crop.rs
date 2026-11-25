//! E6f — A SLICE SURFACE IN THE ENGINE: a rectangle of another surface's picture, as the app crops it.
//!
//! The app (src/renderer/services/surfaceMedia.ts sliceDrawable) draws the slice into a canvas of
//! round(w × rect.w) × round(h × rect.h) with one `drawImage(src, rect.x·w, rect.y·h, rect.w·w, rect.h·h, 0, 0, dw, dh)`
//! — Skia's default smoothing (imageSmoothingQuality 'low'): BILINEAR, from the full-size picture, no mip levels.
//! This samples that rectangle at each destination pixel's centre the same way (`textureSampleLevel` level 0,
//! a linear clamped sampler): a slice on whole pixels at 1:1 is an exact copy, a fractional one interpolates
//! as the canvas does. One pass on the GPU, no read back; the slice is then a picture like any other.

use crate::Gpu;

const WGSL: &str = r#"
struct U { off: vec2<f32>, scale: vec2<f32> };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
struct V { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) i: u32) -> V {
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    return V(vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0), vec2<f32>(x, y));
}
@fragment
fn fs(v: V) -> @location(0) vec4<f32> { return textureSampleLevel(tex, samp, u.off + v.uv * u.scale, 0.0); }
"#;

pub struct Cropper { pipe: wgpu::RenderPipeline, samp: wgpu::Sampler }

impl Cropper {
    pub fn new(gpu: &Gpu) -> Self {
        let d = &gpu.device;
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("slice"), source: wgpu::ShaderSource::Wgsl(WGSL.into()) });
        let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("slice"), layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let samp = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        Cropper { pipe, samp }
    }

    /// `rect` in TEXELS of `src` (x, y, w, h — fractional allowed), drawn into a new dw × dh texture.
    pub fn crop(&self, gpu: &Gpu, src: &wgpu::Texture, rect: [f64; 4], dw: u32, dh: u32) -> wgpu::Texture {
        let d = &gpu.device;
        let (tw, th) = (src.width() as f64, src.height() as f64);
        let u: [f32; 4] = [(rect[0] / tw) as f32, (rect[1] / th) as f32, (rect[2] / tw) as f32, (rect[3] / th) as f32];
        let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("slice"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        gpu.queue.write_buffer(&ubuf, 0, &u.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>());
        let out = d.create_texture(&wgpu::TextureDescriptor {
            label: Some("slice"), size: wgpu::Extent3d { width: dw, height: dh, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC, view_formats: &[],
        });
        let view = src.create_view(&wgpu::TextureViewDescriptor { base_mip_level: 0, mip_level_count: Some(1), ..Default::default() });
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.pipe.get_bind_group_layout(0), entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.samp) },
            wgpu::BindGroupEntry { binding: 2, resource: ubuf.as_entire_binding() },
        ] });
        let ov = out.create_view(&Default::default());
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("slice"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &ov, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&self.pipe); pass.set_bind_group(0, &bind, &[]); pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
        out
    }
}
