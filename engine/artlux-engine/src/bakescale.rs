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

/// `--bake-nv12-check [WxH]`: a picture of ramps, noise and hard edges converted on the GPU and by `encode::to_nv12`;
/// the bytes that differ and by how much (float order on a GPU may move a value sitting exactly on .5 by one).
pub fn nv12_check(gpu: &Gpu, w: u32, h: u32) -> serde_json::Value {
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    let mut seed = 0x2545_f491u32;
    for y in 0..h { for x in 0..w {
        let o = ((y * w + x) * 4) as usize;
        seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
        let c = match (x * 4 / w, y * 2 / h) {
            (0, 0) => [(x * 255 / w) as u8, (y * 255 / h) as u8, 128],
            (1, 0) => [seed as u8, (seed >> 8) as u8, (seed >> 16) as u8],
            (2, 0) => if (x / 3 + y / 3) % 2 == 0 { [255, 0, 0] } else { [0, 0, 255] },
            (3, 0) => [255, 255, 255],
            (_, _) => [((x ^ y) & 255) as u8, (x * 7 & 255) as u8, (y * 13 & 255) as u8],
        };
        rgba[o..o + 3].copy_from_slice(&c); rgba[o + 3] = 255;
    } }
    let pic = crate::compose::Picture { w, h, rgba: rgba.clone().into(), mips: false, crop: None, tex: None };
    let mut sc = Scaler::new(gpu, w, h);
    let t0 = std::time::Instant::now();
    let g = match sc.frame_nv12(gpu, &pic, 1) { Ok(v) => v, Err(e) => return serde_json::json!({ "ok": false, "error": e }) };
    let gpu_ms = t0.elapsed().as_secs_f64() * 1000.0;
    // The CPU's input is what the GPU drew (the same pixels: the picture at its own size, sampled at texel centres).
    let drawn = match sc.frame(gpu, &pic, 1) { Ok(v) => v, Err(e) => return serde_json::json!({ "ok": false, "error": e }) };
    let mut c = Vec::new();
    let t1 = std::time::Instant::now();
    crate::encode::to_nv12(&drawn, w as usize, h as usize, true, &mut c);
    let cpu_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let differ = g.iter().zip(&c).filter(|(a, b)| a != b).count();
    let worst = g.iter().zip(&c).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
    serde_json::json!({ "ok": g.len() == c.len(), "bytes": c.len(), "differ": differ, "worst": worst, "drawnExact": drawn == rgba, "gpuMs": gpu_ms, "cpuMs": cpu_ms })
}

/// E6c — RGB → NV12 ON THE GPU, `encode::to_nv12` line for line (BT.709 limited, chroma the 2×2 mean, rounded
/// hh up), from the frame just drawn. One invocation per 4 × 2 block: four luma bytes per row and two chroma
/// pairs are each one u32, so the planes are written as words (a width that is a multiple of 4; another goes the
/// CPU way). The encoder is handed 1.5 bytes a pixel instead of 4, already converted.
const NV12_WGSL: &str = r#"
struct U { w: u32, h: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> u: U;
const KR: f32 = 0.2126; const KB: f32 = 0.0722;
fn q(x: f32) -> u32 { return u32(clamp(floor(x + 0.5), 0.0, 255.0)); }
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let bx = id.x; let by = id.y;           // a 4 × 2 block
    if (bx * 4u >= u.w || by * 2u >= u.h) { return; }
    let kg = 1.0 - KR - KB;
    var ys: array<u32, 2>;
    var uv: u32 = 0u;
    for (var hh = 0u; hh < 2u; hh++) {
        var sb = 0.0; var sr = 0.0;
        for (var dy = 0u; dy < 2u; dy++) {
            for (var dx = 0u; dx < 2u; dx++) {
                let x = bx * 4u + hh * 2u + dx; let y = by * 2u + dy;
                let c = textureLoad(src, vec2<u32>(x, y), 0).rgb;
                let yl = KR * c.r + kg * c.g + KB * c.b;
                ys[dy] = ys[dy] | (q(16.0 + 219.0 * yl) << (8u * (hh * 2u + dx)));
                sb += (c.b - yl) / (2.0 * (1.0 - KB));
                sr += (c.r - yl) / (2.0 * (1.0 - KR));
            }
        }
        uv = uv | (q(128.0 + 224.0 * sb / 4.0) << (16u * hh)) | (q(128.0 + 224.0 * sr / 4.0) << (16u * hh + 8u));
    }
    let wq = u.w / 4u;
    out[(by * 2u) * wq + bx] = ys[0];
    out[(by * 2u + 1u) * wq + bx] = ys[1];
    out[(u.w * u.h) / 4u + by * wq + bx] = uv;
}
"#;

/// The conversion pass and its buffers, made once per bake.
struct Nv12Pass { pipe: wgpu::ComputePipeline, ubuf: wgpu::Buffer, storage: wgpu::Buffer, read: wgpu::Buffer, len: u64 }

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
    /// E6c: NV12 on the GPU — None for a width that is not a multiple of 4 (the CPU converts those).
    nv12: Option<Nv12Pass>,
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
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
        });
        let row = (w * 4).div_ceil(256) * 256;
        let nv12 = (w % 4 == 0 && h % 2 == 0).then(|| {
            let m = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("bake nv12"), source: wgpu::ShaderSource::Wgsl(NV12_WGSL.into()) });
            let pipe = d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some("bake nv12"), layout: None, module: &m, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
            let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("bake nv12"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            let len = (w * h * 3 / 2) as u64;
            let storage = d.create_buffer(&wgpu::BufferDescriptor { label: Some("bake nv12"), size: len, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
            let read = d.create_buffer(&wgpu::BufferDescriptor { label: Some("bake nv12 readback"), size: len, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
            gpu.queue.write_buffer(&ubuf, 0, &[w.to_le_bytes(), h.to_le_bytes(), [0; 4], [0; 4]].concat());
            Nv12Pass { pipe, ubuf, storage, read, len }
        });
        let buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("bake readback"), size: (row * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        Scaler { pipe, samp, ubuf, target, buf, w, h, row, upload: None, nv12 }
    }

    /// E6c: whether `frame_nv12` is available (a width that is a multiple of 4).
    pub fn gpu_nv12(&self) -> bool { self.nv12.is_some() }

    /// A picture's frame for the file: w × h straight RGBA, top row first.
    pub fn frame(&mut self, gpu: &Gpu, pic: &crate::compose::Picture, gen: u64) -> Result<Vec<u8>, String> {
        self.draw(gpu, pic, gen);
        self.read_rgba(gpu)
    }

    /// E6c: the same frame as NV12, converted on the GPU (BT.709 limited — `encode::to_nv12`'s arithmetic).
    pub fn frame_nv12(&mut self, gpu: &Gpu, pic: &crate::compose::Picture, gen: u64) -> Result<Vec<u8>, String> {
        self.draw(gpu, pic, gen);
        self.convert(gpu)
    }

    fn convert(&self, gpu: &Gpu) -> Result<Vec<u8>, String> {
        let n = self.nv12.as_ref().ok_or("no GPU NV12 at this width")?;
        let d = &gpu.device;
        let view = self.target.create_view(&Default::default());
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &n.pipe.get_bind_group_layout(0), entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 1, resource: n.storage.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: n.ubuf.as_entire_binding() },
        ] });
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&n.pipe); pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups((self.w / 4).div_ceil(8), (self.h / 2).div_ceil(8), 1);
        }
        enc.copy_buffer_to_buffer(&n.storage, 0, &n.read, 0, n.len);
        gpu.queue.submit([enc.finish()]);
        gpu.read_buffer(&n.read, n.len as usize).map_err(|e| e.to_string())
    }

    /// Draw the picture into the target (one pass, submitted).
    fn draw(&mut self, gpu: &Gpu, pic: &crate::compose::Picture, gen: u64) {
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
        gpu.queue.submit([enc.finish()]);
    }

    fn read_rgba(&self, gpu: &Gpu) -> Result<Vec<u8>, String> {
        let mut enc = gpu.device.create_command_encoder(&Default::default());
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
