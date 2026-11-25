//! E6a — A BAKE FRAME'S PICTURE AT THE FILE'S SIZE, read back for the encoder (encode.rs).
//!
//! The first cut drew each frame through the projector's own offscreen path (projector::render): a new pipeline per
//! call, a copy and mip chain of the picture, a read through a second pass, rows flipped — 18.7 ms of a 1080p
//! frame's ~25 (test:engine-bake), more than the GPU's encoder took. A bake keeps ONE of these for its length: the
//! pipeline, the target and the readback buffer are made once, and a frame is one pass + one copy + one map.
//!
//! The picture is sampled where it already is (a decoded frame's texture, a composite, a shader's output) through
//! its VISIBLE rect. Shrinking it by more than half needs its mip chain, as the projector draw had: then — and only
//! then — the picture is copied into a mipped texture first (projector::content_texture_from), so a 4K film baked
//! to 1080p is filtered as before and a bake at the film's own size is not copied at all.

use crate::Gpu;

const WGSL: &str = r#"
struct U { off: vec2<f32>, scale: vec2<f32> };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
struct V { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) i: u32) -> V {
    // One triangle over the target, top row first (uv.y = 0 at the top): the file's row order, no flip after.
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    return V(vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0), vec2<f32>(x, y));
}
@fragment
fn fs(v: V) -> @location(0) vec4<f32> { return textureSample(tex, samp, u.off + v.uv * u.scale); }
"#;

pub struct Scaler {
    pipe: wgpu::RenderPipeline,
    samp: wgpu::Sampler,
    ubuf: wgpu::Buffer,
    target: wgpu::Texture,
    buf: wgpu::Buffer,
    w: u32,
    h: u32,
    row: u32,
    /// A CPU picture's upload, by its generation (a still is uploaded once, not once a frame).
    upload: Option<(u64, wgpu::Texture)>,
}

impl Scaler {
    pub fn new(gpu: &Gpu, w: u32, h: u32) -> Self {
        let d = &gpu.device;
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("bake scale"), source: wgpu::ShaderSource::Wgsl(WGSL.into()) });
        let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("bake scale"), layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        // Linear, mipmapped and clamped — the projector draw's sampling (a picture filling its frame never wraps).
        let samp = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, mipmap_filter: wgpu::MipmapFilterMode::Linear, ..Default::default() });
        let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("bake scale"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let target = d.create_texture(&wgpu::TextureDescriptor {
            label: Some("bake frame"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[],
        });
        let row = (w * 4).div_ceil(256) * 256;
        let buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("bake readback"), size: (row * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        Scaler { pipe, samp, ubuf, target, buf, w, h, row, upload: None }
    }

    /// A picture's frame for the file: w × h straight RGBA, top row first.
    pub fn frame(&mut self, gpu: &Gpu, pic: &crate::compose::Picture, gen: u64) -> Result<Vec<u8>, String> {
        let crop = pic.crop.unwrap_or([0, 0, pic.w, pic.h]);
        let shrink = (crop[2] as f64 / self.w as f64).max(crop[3] as f64 / self.h as f64);
        // What is sampled, and the visible rect within it.
        let (tex, rect): (wgpu::Texture, [u32; 4]) = match &pic.tex {
            Some(t) if shrink <= 1.5 && t.usage().contains(wgpu::TextureUsages::TEXTURE_BINDING) => (t.clone(), crop),
            Some(t) => (crate::projector::content_texture_from(gpu, t, crop), [0, 0, crop[2], crop[3]]),
            None => {
                if self.upload.as_ref().map(|u| u.0) != Some(gen) {
                    // Only the visible rect is uploaded (a software-decoded MP4 carries its coded padding).
                    let t = if crop == [0, 0, pic.w, pic.h] { crate::projector::content_texture(gpu, pic.w, pic.h, &pic.rgba) } else {
                        let [x, y, cw, ch] = crop;
                        let mut sub = Vec::with_capacity((cw * ch * 4) as usize);
                        for r in y..y + ch { let o = ((r * pic.w + x) * 4) as usize; sub.extend_from_slice(&pic.rgba[o..o + (cw * 4) as usize]); }
                        crate::projector::content_texture(gpu, cw, ch, &sub)
                    };
                    self.upload = Some((gen, t));
                }
                (self.upload.as_ref().unwrap().1.clone(), [0, 0, crop[2], crop[3]])
            }
        };
        let (tw, th) = (tex.width() as f32, tex.height() as f32);
        let u: [f32; 4] = [rect[0] as f32 / tw, rect[1] as f32 / th, rect[2] as f32 / tw, rect[3] as f32 / th];
        gpu.queue.write_buffer(&self.ubuf, 0, &u.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>());
        let d = &gpu.device;
        let view = tex.create_view(&Default::default());
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.pipe.get_bind_group_layout(0), entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.samp) },
            wgpu::BindGroupEntry { binding: 2, resource: self.ubuf.as_entire_binding() },
        ] });
        let tv = self.target.create_view(&Default::default());
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("bake frame"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &tv, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&self.pipe); pass.set_bind_group(0, &bind, &[]); pass.draw(0..3, 0..1);
        }
        enc.copy_texture_to_buffer(self.target.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &self.buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(self.row), rows_per_image: Some(self.h) } },
            wgpu::Extent3d { width: self.w, height: self.h, depth_or_array_layers: 1 });
        gpu.queue.submit([enc.finish()]);
        let raw = gpu.read_buffer(&self.buf, (self.row * self.h) as usize).map_err(|e| e.to_string())?;
        let rb = (self.w * 4) as usize;
        if self.row as usize == rb { return Ok(raw); }
        let mut out = Vec::with_capacity(rb * self.h as usize);
        for y in 0..self.h as usize { out.extend_from_slice(&raw[y * self.row as usize..y * self.row as usize + rb]); }
        Ok(out)
    }
}
