//! E1b-2 — LED SAMPLING on the GPU: every LED reads its own surface's cell in the atlas, then RGB → RGBW
//! and brightness, packed to the canonical buffer (r | g<<8 | b<<16 | w<<24 per LED). A port of the LIVE
//! path of src/renderer/gpu/WebGPUMapper.ts's `main` kernel; held to it byte for byte by
//! scripts/test-sampling-parity.cjs --gpu, which hands this the exact atlas and layout WebGPUMapper used.
//!
//! Only the live path. WebGPUMapper's shader still carries per-fixture effects, palettes and the fire
//! simulation, but `buildSegParams` has emitted only "media" (-1) or "off" (-2) since effects moved to
//! surfaces (S3) — those branches are unreachable, so they are not ported. A segment mode >= 0 reads as
//! off here, which no current document produces.

use crate::{EngineError, Gpu};

pub const SAMPLE_WGSL: &str = r#"
struct Params { brightness: f32, count: u32, surfaces: u32, _pad: u32 };

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> ledData: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outBuf: array<u32>;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var<storage, read> segParams: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> ledMeta: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> atlasRects: array<vec4<f32>>;

fn toByte(v: f32) -> u32 { return u32(clamp(v, 0.0, 1.0) * 255.0 + 0.5); }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let surfIdx = u32(ledMeta[i].w + 0.5);
  if (surfIdx >= params.surfaces) { outBuf[i] = 0u; return; }
  let d = ledData[i];
  let uv = d.xy;
  let segIdx = u32(d.w + 0.5);
  let fp0 = segParams[2u * segIdx];
  let fp1 = segParams[2u * segIdx + 1u];
  let mode = fp0.x; // -2 off, -1 media
  if (mode < -1.5 || mode >= 0.0) { outBuf[i] = 0u; return; }
  let r = atlasRects[surfIdx];
  let auv = vec2<f32>(r.x + clamp(uv.x, 0.0, 1.0) * r.z,
                      r.y + clamp(uv.y, 0.0, 1.0) * r.w);
  let color = textureSampleLevel(srcTex, samp, auv, 0.0);
  let b = params.brightness;
  var rr: f32; var gg: f32; var bb: f32; var ww: f32;
  if (fp1.x > 0.5) { // RGBWMode.NONE
    rr = color.r * b; gg = color.g * b; bb = color.b * b; ww = 0.0;
  } else {
    let m = min(min(color.r, color.g), color.b);
    rr = (color.r - m) * b; gg = (color.g - m) * b; bb = (color.b - m) * b; ww = m * b;
  }
  outBuf[i] = toByte(rr) | (toByte(gg) << 8u) | (toByte(bb) << 16u) | (toByte(ww) << 24u);
}
"#;

pub struct SampleInput<'a> {
    pub atlas_w: u32,
    pub atlas_h: u32,
    pub atlas_rgba: &'a [u8],
    pub led: &'a [f32],
    pub meta: &'a [f32],
    pub seg_params: &'a [f32],
    pub rects: &'a [f32],
    pub brightness: f32,
    pub surfaces: u32,
}

fn storage(gpu: &Gpu, label: &str, data: &[f32]) -> wgpu::Buffer {
    let bytes: Vec<u8> = if data.is_empty() { vec![0u8; 16] } else { data.iter().flat_map(|f| f.to_le_bytes()).collect() };
    let b = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: bytes.len() as u64, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    gpu.queue.write_buffer(&b, 0, &bytes);
    b
}

/// One sampling pass over atlas BYTES (the parity harness hands WebGPUMapper's exact atlas); returns the
/// canonical buffer (4 bytes per LED: R, G, B, W).
pub fn sample(gpu: &Gpu, s: &SampleInput) -> Result<Vec<u8>, EngineError> {
    let d = &gpu.device;
    if s.led.is_empty() { return Ok(Vec::new()); }
    let size = wgpu::Extent3d { width: s.atlas_w, height: s.atlas_h, depth_or_array_layers: 1 };
    let tex = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("atlas"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[],
    });
    gpu.queue.write_texture(tex.as_image_copy(), s.atlas_rgba,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(s.atlas_w * 4), rows_per_image: Some(s.atlas_h) }, size);
    sample_texture(gpu, &tex, s.led, s.meta, s.seg_params, s.rects, s.brightness, s.surfaces)
}

/// One sampling pass over an atlas already ON THE GPU (the engine's own, E1d: no readback, no upload).
#[allow(clippy::too_many_arguments)]
pub fn sample_texture(gpu: &Gpu, tex: &wgpu::Texture, led_data: &[f32], meta_data: &[f32], seg_data: &[f32], rect_data: &[f32], brightness: f32, surfaces: u32) -> Result<Vec<u8>, EngineError> {
    match sample_submit(gpu, tex, led_data, meta_data, seg_data, rect_data, brightness, surfaces)? {
        Some(p) => { let at = std::time::Instant::now(); let r = p.wait(gpu); crate::prof::add("leds.wait", at.elapsed()); r }
        None => Ok(Vec::new()),
    }
}

/// O3-2: the sampling pass SUBMITTED, its read-back in flight (None: no LEDs). The runtime collects it a tick later.
#[allow(clippy::too_many_arguments)]
pub fn sample_submit(gpu: &Gpu, tex: &wgpu::Texture, led_data: &[f32], meta_data: &[f32], seg_data: &[f32], rect_data: &[f32], brightness: f32, surfaces: u32) -> Result<Option<crate::PendingRead>, EngineError> {
    let d = &gpu.device;
    let count = (led_data.len() / 4) as u32;
    if count == 0 { return Ok(None); }
    // O1-1: the pipeline and the app's sampler (linear, clamp-to-edge — WebGPUMapper's constructor), built once per
    // device; they were compiled on every tick.
    static SAMPLE: crate::PerDevice<(), (wgpu::ComputePipeline, wgpu::Sampler)> = crate::PerDevice::new();
    let (pipeline, sampler) = SAMPLE.get(d, (), || {
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("sample"), source: wgpu::ShaderSource::Wgsl(SAMPLE_WGSL.into()) });
        let pipeline = d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some("sample"), layout: None, module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
        let sampler = d.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("atlas"),
            address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        (pipeline, sampler)
    });
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&brightness.to_le_bytes());
    p[4..8].copy_from_slice(&count.to_le_bytes());
    p[8..12].copy_from_slice(&surfaces.to_le_bytes());
    let params = d.create_buffer(&wgpu::BufferDescriptor { label: Some("params"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    gpu.queue.write_buffer(&params, 0, &p);
    let led = storage(gpu, "led", led_data);
    let seg = storage(gpu, "segParams", seg_data);
    let meta = storage(gpu, "meta", meta_data);
    let rects = storage(gpu, "rects", rect_data);
    let out_len = count as u64 * 4;
    let out = d.create_buffer(&wgpu::BufferDescriptor { label: Some("out"), size: out_len, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let readback = d.create_buffer(&wgpu::BufferDescriptor { label: Some("out readback"), size: out_len, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let view = tex.create_view(&Default::default());
    let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sample"), layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Sampler(&sampler) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 2, resource: led.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: out.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: params.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: seg.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 6, resource: meta.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 7, resource: rects.as_entire_binding() },
        ],
    });
    let mut enc = d.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.dispatch_workgroups(count.div_ceil(64), 1, 1);
    }
    enc.copy_buffer_to_buffer(&out, 0, &readback, 0, out_len);
    let idx = crate::submit(gpu, [enc.finish()]);
    Ok(Some(crate::PendingRead::start(readback, out_len as usize, idx)))
}
