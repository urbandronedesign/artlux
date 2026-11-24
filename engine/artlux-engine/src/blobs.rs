//! E2 — TRACKING BLOBS drawn by the engine (plans/native-engine.md §2: "TRACKING / AUGMENTA — data H, drawing E;
//! blob data is small; port the two blobPass shaders").
//!
//! The app computes the blobs (its motion filter, smoothing, prediction, calibration transform, colours, trail
//! ribbons) and hands the engine, each tick, exactly what its own draw drew this frame
//! (plugins/lidar-tracking trackingDrawable.nativeTickFor, plugins/augmenta likewise). This draws them the way
//! `blobPass.ts` does into the app's per-surface WebGL2 canvas — antialias: true (multisampled), premultiplied,
//! cleared to transparent, the trail ribbons then the markers, both blended ONE / ONE_MINUS_SRC_ALPHA — so the
//! geometry is built on the CPU exactly as `drawBlobs` / `drawSolid` build it, and the fragment maths is
//! BLOB_FRAG line for line.

const SAMPLES: u32 = 4;   // Chromium's WebGL `antialias: true` on D3D11: 4× MSAA
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

const WGSL: &str = r#"
struct SOut { @builtin(position) p: vec4<f32>, @location(0) c: vec4<f32> };
// SOLID_VERT with uFlipY = -1 (the app's canvas, not a projector FBO): y = 1 - 2y.
@vertex fn vs_solid(@location(0) pos: vec2<f32>, @location(1) col: vec4<f32>) -> SOut {
  var o: SOut; o.p = vec4<f32>(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.0, 1.0); o.c = col; return o;
}
@fragment fn fs_solid(i: SOut) -> @location(0) vec4<f32> { return i.c; }

struct BOut { @builtin(position) p: vec4<f32>, @location(0) local: vec2<f32>, @location(1) color: vec3<f32>,
              @location(2) alpha: f32, @location(3) heading: f32, @location(4) dir: f32 };
@vertex fn vs_blob(@location(0) pos: vec2<f32>, @location(1) local: vec2<f32>, @location(2) color: vec3<f32>,
                   @location(3) alpha: f32, @location(4) heading: f32, @location(5) dir: f32) -> BOut {
  var o: BOut; o.p = vec4<f32>(pos, 0.0, 1.0); o.local = local; o.color = color; o.alpha = alpha; o.heading = heading; o.dir = dir; return o;
}
fn edge(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 { let e = b - a; let n = normalize(vec2<f32>(-e.y, e.x)); return dot(p - a, n); }
// BLOB_FRAG, with uYSign = -1 (the app's canvas).
@fragment fn fs_blob(i: BOut) -> @location(0) vec4<f32> {
  let d = length(i.local);
  let disc = 1.0 - smoothstep(0.9, 1.0, d);
  let sl = vec2<f32>(i.local.x, i.local.y * -1.0);
  let c = cos(i.heading); let s = sin(i.heading);
  let p = vec2<f32>(c * sl.x + s * sl.y, -s * sl.x + c * sl.y);
  let ta = vec2<f32>(0.62, 0.0); let tb = vec2<f32>(-0.32, 0.42); let tc = vec2<f32>(-0.32, -0.42);
  let e1 = edge(p, ta, tb); let e2 = edge(p, tb, tc); let e3 = edge(p, tc, ta);
  let aaw = 0.05;
  let tri = max(smoothstep(-aaw, aaw, min(e1, min(e2, e3))), smoothstep(aaw, -aaw, max(e1, max(e2, e3))));
  let rgb = mix(i.color, vec3<f32>(1.0), tri * i.dir);
  let a = disc * i.alpha;
  return vec4<f32>(rgb * a, a);
}
"#;

pub struct Blobs { solid: wgpu::RenderPipeline, blob: wgpu::RenderPipeline }

fn bytes(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

impl Blobs {
    pub fn new(gpu: &crate::Gpu) -> Blobs {
        let d = &gpu.device;
        let m = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("blobs"), source: wgpu::ShaderSource::Wgsl(WGSL.into()) });
        let blend = Some(wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        });
        let ms = wgpu::MultisampleState { count: SAMPLES, mask: !0, alpha_to_coverage_enabled: false };
        let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[], immediate_size: 0 });
        let mk = |vs: &str, fs: &str, stride: u64, attrs: &[wgpu::VertexAttribute]| d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("blobs"), layout: Some(&pl),
            vertex: wgpu::VertexState { module: &m, entry_point: Some(vs), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout { array_stride: stride, step_mode: wgpu::VertexStepMode::Vertex, attributes: attrs })] },
            fragment: Some(wgpu::FragmentState { module: &m, entry_point: Some(fs), targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: ms, multiview_mask: None, cache: None,
        });
        let solid = mk("vs_solid", "fs_solid", 24, &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4]);
        let blob = mk("vs_blob", "fs_blob", 40, &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x3, 3 => Float32, 4 => Float32, 5 => Float32]);
        Blobs { solid, blob }
    }

    /// One frame: `b` = [x, y, r, R, G, B, a, heading, dir] per blob, `t` = trail vertices [x, y, r, g, b, a]
    /// (premultiplied). Returns the picture: w × h, row 0 at the top, premultiplied.
    pub fn render(&self, gpu: &crate::Gpu, w: u32, h: u32, b: &[f32], t: &[f32]) -> wgpu::Texture {
        let d = &gpu.device;
        let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
        let ms = d.create_texture(&wgpu::TextureDescriptor { label: Some("blobs msaa"), size, mip_level_count: 1, sample_count: SAMPLES, dimension: wgpu::TextureDimension::D2, format: FORMAT, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
        let out = d.create_texture(&wgpu::TextureDescriptor { label: Some("blobs picture"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
        // drawBlobs: one quad per blob, half-size = the radius in pixels (r × fbH), flipY false.
        let (fw, fh) = (w as f32, h as f32);
        let mut v: Vec<f32> = Vec::with_capacity(b.len() / 9 * 60);
        for k in b.chunks_exact(9) {
            let half_px = k[2] * fh;
            let (dx, dy) = ((half_px / fw) * 2.0, (half_px / fh) * 2.0);
            let (cx, cy) = (k[0] * 2.0 - 1.0, 1.0 - k[1] * 2.0);
            for (lx, ly) in [(-1.0f32, -1.0f32), (1.0, -1.0), (1.0, 1.0), (-1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
                v.extend_from_slice(&[cx + lx * dx, cy + ly * dy, lx, ly, k[3], k[4], k[5], k[6], k[7], k[8]]);
            }
        }
        let buf = |data: &[f32]| { let bb = bytes(data); let b = d.create_buffer(&wgpu::BufferDescriptor { label: None, size: (bb.len().max(4) as u64 + 3) & !3, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }); if !bb.is_empty() { gpu.queue.write_buffer(&b, 0, &bb); } b };
        let tb = buf(t);
        let bb = buf(&v);
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mv = ms.create_view(&Default::default());
            let ov = out.create_view(&Default::default());
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("blobs"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &mv, depth_slice: None, resolve_target: Some(&ov), ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Discard } })], ..Default::default() });
            if t.len() >= 18 {
                pass.set_pipeline(&self.solid);
                pass.set_vertex_buffer(0, tb.slice(..));
                pass.draw(0..(t.len() / 6) as u32, 0..1);
            }
            if !v.is_empty() {
                pass.set_pipeline(&self.blob);
                pass.set_vertex_buffer(0, bb.slice(..));
                pass.draw(0..(v.len() / 10) as u32, 0..1);
            }
        }
        gpu.queue.submit([enc.finish()]);
        out
    }
}
