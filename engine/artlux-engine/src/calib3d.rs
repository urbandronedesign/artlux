//! E6f — RENDER-FROM-PROJECTOR: a calibrated projector output's VENUE, drawn by the engine from the solved
//! projector (plans/native-engine.md E6f; host half: src/renderer/engine/venueLink.ts).
//!
//! The app draws it in the projector window with three.js (the calibration plugin's ProjectorScene), and this is
//! held to THAT picture, so it is three's MeshBasicMaterial path written out, not the 3D view's look (view3d.rs
//! lights its meshes and approximates sRGB with a 2.2 power — fine for a preview, a different picture here):
//!   - geometry: every mesh's MODEL-VIEW comes from the host, computed in f64 as three's renderer computes
//!     `modelViewMatrix` (camera.matrixWorldInverse × object.matrixWorld) — the vertex stage is three's
//!     `projectionMatrix * (modelViewMatrix * p)`, then ANGLE's GL→D3D step (y negated — the raster is BOTTOM-UP,
//!     GL's order, which the flip pass turns over — and z from [−w, w] to [0, w]). The same triangles land on the
//!     same pixels under the same 4× MSAA pattern;
//!   - colour: the surface's picture as three samples a streamed frame (LinearFilter, no mips, clamp, its
//!     sRGB decoded by the texture format before filtering — SRGB8_ALPHA8 there, Rgba8UnormSrgb here), times
//!     white, then three's own sRGBTransferOETF (pow 0.41666, not 1/2.4) into an 8-bit target. No tone mapping
//!     (toneMapped: false). Cleared to black;
//!   - orientation: three's texture matrix for a streamed ImageBitmap (bitmapFlip.ts: repeat.y = −1, offset.y =
//!     1 → v' = −v + 1, in the VERTEX stage), and a GLB mesh wearing content has its glTF v turned to 1 − v first
//!     (modelScreens.flippedUv, f32 on the CPU) — both written as three computes them;
//!   - projected mapping: projectedMapping.ts BODY_VERT / BODY_FRAG (vProjPos from the vertex stage, the edge ramp,
//!     the facing test, the repeat/offset by hand). Its material is FRONT-sided (the authored one is double-sided).
//! Not drawn yet (the host refuses them, with the reason): a mesh's own lit material, a timeline layer, occlusion,
//! lens distortion, the blend pass, a residual warp.

use crate::compose::Picture;
use crate::Gpu;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

pub const SAMPLES: u32 = 4;
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;
const OBJ_STRIDE: u64 = 256;

/// One content source: a surface, optionally PROJECTED from a projector (view-projection, eye, soft, cull).
#[derive(Clone, Debug)]
pub struct Src { pub surface: String, pub proj: Option<Proj> }
#[derive(Clone, Debug)]
pub struct Proj { pub view: [f32; 16], pub eye: [f32; 3], pub soft: f32, pub cull: bool }

/// One placed mesh: its model-view (three's modelViewMatrix) and world matrix (modelMatrix), as the host computed them.
#[derive(Clone, Debug)]
pub struct Xf { pub mv: [f32; 16], pub world: [f32; 16] }

#[derive(Clone, Debug)]
pub enum Geo { Plane { w: f64, h: f64 }, Glb { path: String } }

#[derive(Clone, Debug)]
pub struct Model { pub id: String, pub geo: Geo, pub meshes: Vec<Xf>, pub src: Vec<Src>, pub mesh_src: Vec<i32> }

/// A calibrated output's venue, from the document's `calib`.
#[derive(Clone, Debug)]
pub struct View { pub proj: [f32; 16], pub models: Vec<Model> }

fn m16(v: &Value) -> Option<[f32; 16]> {
    let a = v.as_array()?;
    if a.len() != 16 { return None; }
    let mut m = [0f32; 16];
    for (i, x) in a.iter().enumerate() { m[i] = x.as_f64()? as f32; }
    Some(m)
}

fn src_of(v: &Value) -> Option<Src> {
    let surface = v["surface"].as_str()?.to_string();
    let proj = v["proj"].as_object().and_then(|p| Some(Proj {
        view: m16(p.get("view")?)?,
        eye: { let e = p.get("eye")?.as_array()?; [e.first()?.as_f64()? as f32, e.get(1)?.as_f64()? as f32, e.get(2)?.as_f64()? as f32] },
        soft: p.get("soft").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
        cull: p.get("cull").and_then(|x| x.as_bool()).unwrap_or(false),
    }));
    Some(Src { surface, proj })
}

impl View {
    pub fn parse(v: &Value) -> Option<View> {
        let proj = m16(&v["proj"])?;
        let mut models = Vec::new();
        for m in v["models"].as_array()? {
            let id = m["id"].as_str().unwrap_or_default().to_string();
            match m["kind"].as_str()? {
                "plane" => models.push(Model {
                    id, geo: Geo::Plane { w: m["w"].as_f64()?, h: m["h"].as_f64()? },
                    meshes: vec![Xf { mv: m16(&m["mv"])?, world: m16(&m["world"])? }],
                    src: vec![src_of(&m["src"])?], mesh_src: vec![0],
                }),
                "glb" => models.push(Model {
                    id, geo: Geo::Glb { path: m["path"].as_str()?.to_string() },
                    meshes: m["meshes"].as_array()?.iter().map(|x| Some(Xf { mv: m16(&x["mv"])?, world: m16(&x["world"])? })).collect::<Option<Vec<_>>>()?,
                    src: m["content"]["src"].as_array()?.iter().map(src_of).collect::<Option<Vec<_>>>()?,
                    mesh_src: m["content"]["mesh"].as_array()?.iter().map(|x| x.as_i64().unwrap_or(-1) as i32).collect(),
                }),
                _ => return None,
            }
        }
        Some(View { proj, models })
    }
    /// The surfaces it shows (the presenters need their pictures).
    pub fn surfaces(&self) -> Vec<String> {
        let mut v: Vec<String> = self.models.iter().flat_map(|m| m.src.iter().map(|s| s.surface.clone())).collect();
        v.sort(); v.dedup(); v
    }
}

const SHADER: &str = r#"
struct Cam { p: mat4x4<f32> };
@group(0) @binding(0) var<uniform> cam: Cam;
// mv = three's modelViewMatrix, world = modelMatrix; proj = the PROJECTING camera's view-projection (GL clip);
// pe = its eye + edge softness; pf.x = projected, pf.y = facing test.
struct Obj { mv: mat4x4<f32>, world: mat4x4<f32>, proj: mat4x4<f32>, pe: vec4<f32>, pf: vec4<f32> };
@group(1) @binding(0) var<uniform> obj: Obj;
@group(2) @binding(0) var tex: texture_2d<f32>;
@group(2) @binding(1) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) ppos: vec4<f32>,
  @location(2) pworld: vec3<f32>,
  @location(3) pnrm: vec3<f32>,
};

@vertex fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) uv: vec2<f32>) -> VOut {
  var o: VOut;
  // three's <project_vertex>: mvPosition = modelViewMatrix * vec4(transformed, 1); gl_Position = projectionMatrix * mvPosition.
  let mvp = obj.mv * vec4<f32>(p, 1.0);
  var c = cam.p * mvp;
  // ANGLE's GL→D3D: y negated (a GL framebuffer is bottom-up — so is the projector raster), depth [-w,w] → [0,w].
  c.y = -c.y;
  c.z = (c.z + c.w) * 0.5;
  o.pos = c;
  // three's map transform for a streamed ImageBitmap (repeat.y −1, offset.y 1): mat3 * vec3(uv, 1).
  let t = mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 1.0, 1.0));
  o.uv = (t * vec3<f32>(uv, 1.0)).xy;
  // projectedMapping BODY_VERT.
  let w = obj.world * vec4<f32>(p, 1.0);
  o.ppos = obj.proj * w;
  o.pworld = w.xyz;
  o.pnrm = mat3x3<f32>(obj.world[0].xyz, obj.world[1].xyz, obj.world[2].xyz) * n;
  return o;
}

// three's sRGBTransferOETF (colorspace_pars_fragment), as written there.
fn oetf(v: vec3<f32>) -> vec3<f32> {
  return mix(pow(v, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055), v * 12.92, vec3<f32>(v <= vec3<f32>(0.0031308)));
}

@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  var uv = i.uv;
  var vis = 1.0;
  if (obj.pf.x > 0.5) {
    // projectedMapping BODY_FRAG (no occlusion — the host refuses it), line for line.
    if (i.ppos.w <= 0.0) { vis = 0.0; }
    let ndc = i.ppos.xyz / max(i.ppos.w, 1e-6);
    uv = vec2<f32>(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
    uv = uv * vec2<f32>(1.0, -1.0) + vec2<f32>(0.0, 1.0);   // uMapRepeat / uMapOffset (the bitmap flip)
    let e = max(obj.pe.w, 1e-4);
    let ix = 1.0 - smoothstep(1.0 - e, 1.0, abs(ndc.x));
    let iy = 1.0 - smoothstep(1.0 - e, 1.0, abs(ndc.y));
    vis = vis * ix * iy * step(abs(ndc.z), 1.0);
    let ndl = dot(normalize(i.pnrm), normalize(obj.pe.xyz - i.pworld));
    vis = vis * mix(1.0, step(0.0, ndl), obj.pf.y);
  }
  let s = textureSample(tex, samp, uv);
  // MeshBasicMaterial: diffuseColor = white × texel (opacity 1); outgoingLight = diffuseColor.rgb.
  let c = s.rgb * vis;
  return vec4<f32>(oetf(c), s.a);
}
"#;

// PATH C (ProjectorApp): with no residual warp the scene's canvas IS the output, and the output's brightness × the
// surface's opacity is the canvas ELEMENT's opacity — applied by the compositor to the canvas AFTER it was resolved
// to 8 bits, and rounded again. So it is its own pass over the resolved picture, not a factor in the scene shader:
// measured, the factor in the shader (one rounding) left 289 648 pixels one level off the app (two roundings).
const DIM: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
struct U { q: vec4<f32> };
@group(0) @binding(1) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let c = textureLoad(src, vec2<i32>(p.xy), 0);
  return vec4<f32>(c.rgb * u.q.x, c.a);
}
"#;

struct GpuMesh { vb: wgpu::Buffer, ib: wgpu::Buffer, n: u32 }
enum GlbState { Loading, Ready(Vec<Option<GpuMesh>>), Failed }
type Loaded = (String, Result<crate::view3d::CpuGlb, String>);

/// The renderer one presenter holds: pipelines, the venue's geometry, the surfaces' textures, its targets.
pub struct Renderer {
    pipe_double: wgpu::RenderPipeline,
    pipe_front: wgpu::RenderPipeline,
    cam_buf: wgpu::Buffer,
    cam_bind: wgpu::BindGroup,
    obj_layout: wgpu::BindGroupLayout,
    obj: Option<(u64, wgpu::Buffer, wgpu::BindGroup)>,
    tex_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    planes: HashMap<(u64, u64), GpuMesh>,
    glbs: HashMap<String, GlbState>,
    loaded_tx: Sender<Loaded>,
    loaded_rx: Receiver<Loaded>,
    /// surface id → (picture generation, its texture's sRGB bindings)
    texs: HashMap<String, (u64, wgpu::BindGroup)>,
    targets: Option<(u32, u32, wgpu::TextureView, wgpu::TextureView)>,
    /// Path C's dim: its pipeline and uniform, and the resolved picture it reads (made at the target's size).
    dim_pipe: wgpu::RenderPipeline,
    dim_buf: wgpu::Buffer,
    resolved: Option<(u32, u32, wgpu::TextureView, wgpu::BindGroup)>,
    out_id: String,
}

/// three's PlaneGeometry(w, h) (1 × 1 segments), as it builds it: positions in f64 then stored f32, uv (ix, 1 − iy),
/// indices a b d, b c d.
fn plane_geometry(w: f64, h: f64) -> (Vec<f32>, Vec<u32>) {
    let (wh, hh) = (w / 2.0, h / 2.0);
    let mut v = Vec::with_capacity(32);
    for iy in 0..2 {
        let y = iy as f64 * h - hh;
        for ix in 0..2 {
            let x = ix as f64 * w - wh;
            v.extend_from_slice(&[x as f32, -y as f32, 0.0, 0.0, 0.0, 1.0, ix as f32, 1.0 - iy as f32]);
        }
    }
    (v, vec![0, 2, 1, 2, 3, 1])
}

impl Renderer {
    pub fn new(gpu: &Gpu, out_id: &str) -> Self {
        let d = &gpu.device;
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("calib3d"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let cam_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("calib3d cam"), entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }] });
        let obj_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("calib3d obj"), entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(224) }, count: None }] });
        let tex_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("calib3d tex"), entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        ] });
        let layout = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("calib3d"), bind_group_layouts: &[Some(&cam_layout), Some(&obj_layout), Some(&tex_layout)], immediate_size: 0 });
        let mk = |cull: Option<wgpu::Face>| d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("calib3d"), layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2] })] },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(),
                targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())] }),
            // GL's front face is counter-clockwise; with y negated (the bottom-up raster) it is clockwise here — the
            // same flip ANGLE makes.
            primitive: wgpu::PrimitiveState { cull_mode: cull, front_face: wgpu::FrontFace::Cw, ..Default::default() },
            // three: depthTest + depthWrite, LessEqual.
            depth_stencil: Some(wgpu::DepthStencilState { format: DEPTH, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::LessEqual), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: SAMPLES, mask: !0, alpha_to_coverage_enabled: false },
            multiview_mask: None, cache: None,
        });
        let pipe_double = mk(None);
        let pipe_front = mk(Some(wgpu::Face::Back));
        let cam_buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("calib3d cam"), size: 64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let cam_bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &cam_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: cam_buf.as_entire_binding() }] });
        // three's LinearFilter both ways, no mipmaps (generateMipmaps false), ClampToEdge.
        let sampler = d.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("calib3d"), address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, mipmap_filter: wgpu::MipmapFilterMode::Nearest, ..Default::default() });
        let (loaded_tx, loaded_rx) = channel();
        let dm = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("calib3d dim"), source: wgpu::ShaderSource::Wgsl(DIM.into()) });
        let dim_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("calib3d dim"), layout: None,
            vertex: wgpu::VertexState { module: &dm, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &dm, entry_point: Some("fs"), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let dim_buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("calib3d dim"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        Renderer { pipe_double, pipe_front, cam_buf, cam_bind, obj_layout, obj: None, tex_layout, sampler, planes: HashMap::new(), glbs: HashMap::new(),
            loaded_tx, loaded_rx, texs: HashMap::new(), targets: None, dim_pipe, dim_buf, resolved: None, out_id: out_id.to_string() }
    }

    fn mesh(gpu: &Gpu, verts: &[f32], idx: &[u32]) -> GpuMesh {
        use wgpu::util::DeviceExt;
        let d = &gpu.device;
        let vb = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("calib3d vb"), contents: &f32s(verts), usage: wgpu::BufferUsages::VERTEX });
        let ib = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("calib3d ib"), contents: &idx.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), usage: wgpu::BufferUsages::INDEX });
        GpuMesh { vb, ib, n: idx.len() as u32 }
    }

    /// A venue GLB's meshes, by three's mesh slot — loaded OFF this thread (a CAD venue takes seconds), drawn once in.
    /// Every mesh here WEARS CONTENT (the host refuses one that does not), so glTF's v is turned to 1 − v, in f32, as
    /// modelScreens.flippedUv does on the twin geometry.
    fn glb(&mut self, gpu: &Gpu, path: &str) -> Option<&Vec<Option<GpuMesh>>> {
        while let Ok((p, r)) = self.loaded_rx.try_recv() {
            let st = match r {
                Ok(cpu) => {
                    let n = cpu.prims.iter().map(|p| p.slot + 1).max().unwrap_or(0);
                    let mut by_slot: Vec<Option<GpuMesh>> = (0..n).map(|_| None).collect();
                    for pr in &cpu.prims {
                        let mut v = pr.verts.clone();
                        for k in (0..v.len()).step_by(8) { v[k + 7] = 1.0 - v[k + 7]; }
                        by_slot[pr.slot] = Some(Self::mesh(gpu, &v, &pr.idx));
                    }
                    eprintln!("artlux-engine: output '{}': venue {p} loaded ({n} meshes)", self.out_id);
                    GlbState::Ready(by_slot)
                }
                Err(e) => { eprintln!("artlux-engine: output '{}': venue {p}: {e}", self.out_id); GlbState::Failed }
            };
            self.glbs.insert(p, st);
        }
        if !self.glbs.contains_key(path) {
            self.glbs.insert(path.to_string(), GlbState::Loading);
            let (tx, p) = (self.loaded_tx.clone(), path.to_string());
            std::thread::spawn(move || { let r = crate::view3d::load_glb(&p); let _ = tx.send((p, r)); });
        }
        match self.glbs.get(path) { Some(GlbState::Ready(m)) => Some(m), _ => None }
    }

    /// The surface's picture as three samples a streamed frame: its visible rect, sRGB-decoded by the format.
    fn texture(&mut self, gpu: &Gpu, sid: &str, gen: u64, p: &Picture) -> Option<&wgpu::BindGroup> {
        if self.texs.get(sid).map(|t| t.0) != Some(gen) {
            let d = &gpu.device;
            let [cx, cy, cw, ch] = p.crop.unwrap_or([0, 0, p.w, p.h]);
            if cw == 0 || ch == 0 { return None; }
            let t = d.create_texture(&wgpu::TextureDescriptor {
                label: Some("calib3d surface"), size: wgpu::Extent3d { width: cw, height: ch, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[wgpu::TextureFormat::Rgba8UnormSrgb] });
            match &p.tex {
                Some(src) => {
                    let mut enc = d.create_command_encoder(&Default::default());
                    enc.copy_texture_to_texture(
                        wgpu::TexelCopyTextureInfo { texture: src, mip_level: 0, origin: wgpu::Origin3d { x: cx, y: cy, z: 0 }, aspect: wgpu::TextureAspect::All },
                        wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        wgpu::Extent3d { width: cw, height: ch, depth_or_array_layers: 1 });
                    gpu.queue.submit([enc.finish()]);
                }
                None => {
                    if p.rgba.len() < (p.w * p.h * 4) as usize { return None; }
                    let mut rows = Vec::with_capacity((cw * ch * 4) as usize);
                    for y in cy..cy + ch { let o = ((y * p.w + cx) * 4) as usize; rows.extend_from_slice(&p.rgba[o..o + (cw * 4) as usize]); }
                    gpu.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        &rows, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(cw * 4), rows_per_image: Some(ch) },
                        wgpu::Extent3d { width: cw, height: ch, depth_or_array_layers: 1 });
                }
            }
            let view = t.create_view(&wgpu::TextureViewDescriptor { format: Some(wgpu::TextureFormat::Rgba8UnormSrgb), ..Default::default() });
            let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.tex_layout, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ] });
            self.texs.insert(sid.to_string(), (gen, bind));
        }
        self.texs.get(sid).map(|t| &t.1)
    }

    /// Draw the venue into `target` (Rgba8Unorm, w × h, BOTTOM-UP as the projector raster is), cleared to black.
    /// `pictures`: surface id → its picture; `dim`: projectorBrightness × the surface's opacity.
    pub fn draw(&mut self, gpu: &Gpu, view: &View, pictures: &HashMap<String, (u64, Arc<Picture>)>, target: &wgpu::TextureView, w: u32, h: u32, dim: f64) {
        let d = &gpu.device;
        if self.targets.as_ref().map(|t| (t.0, t.1)) != Some((w, h)) {
            let mk = |format: wgpu::TextureFormat, label: &str| d.create_texture(&wgpu::TextureDescriptor {
                label: Some(label), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: SAMPLES,
                dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] }).create_view(&Default::default());
            self.targets = Some((w, h, mk(wgpu::TextureFormat::Rgba8Unorm, "calib3d msaa"), mk(DEPTH, "calib3d depth")));
        }
        gpu.queue.write_buffer(&self.cam_buf, 0, &f32s(&view.proj));
        // Path C's dim, as the compositor applies a layer's opacity: quantised to 8 bits (outputs.rs BADGE_OPACITY,
        // measured) and only when it dims at all — at 1 the scene resolves straight into the raster.
        let q = ((dim.clamp(0.0, 1.0) * 255.0).round() / 255.0) as f32;
        let dimmed = q < 1.0;
        if dimmed && self.resolved.as_ref().map(|r| (r.0, r.1)) != Some((w, h)) {
            let t = d.create_texture(&wgpu::TextureDescriptor {
                label: Some("calib3d resolved"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
            let v = t.create_view(&Default::default());
            let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.dim_pipe.get_bind_group_layout(0), entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&v) },
                wgpu::BindGroupEntry { binding: 1, resource: self.dim_buf.as_entire_binding() },
            ] });
            self.resolved = Some((w, h, v, bind));
        }
        if dimmed { gpu.queue.write_buffer(&self.dim_buf, 0, &f32s(&[q, 0.0, 0.0, 0.0])); }
        // Every draw: (geometry, cull, obj uniform index, texture bind) — gathered first, as the pass borrows.
        struct Draw { plane: Option<(u64, u64)>, glb: Option<(String, usize)>, front: bool, sid: String }
        let mut draws: Vec<Draw> = Vec::new();
        let mut objs: Vec<u8> = Vec::new();
        for m in &view.models {
            for (k, xf) in m.meshes.iter().enumerate() {
                let Some(si) = m.mesh_src.get(k).copied().filter(|&i| i >= 0) else { continue };
                let Some(s) = m.src.get(si as usize) else { continue };
                // The uniform: mv, world, proj (the projecting camera), pe (eye, soft), pf (projected, cull).
                let mut u: Vec<f32> = Vec::with_capacity(64);
                u.extend_from_slice(&xf.mv); u.extend_from_slice(&xf.world);
                match &s.proj {
                    Some(p) => { u.extend_from_slice(&p.view); u.extend_from_slice(&[p.eye[0], p.eye[1], p.eye[2], p.soft, 1.0, if p.cull { 1.0 } else { 0.0 }, 0.0, 0.0]); }
                    None => { u.extend_from_slice(&[0.0; 16]); u.extend_from_slice(&[0.0; 8]); }
                }
                let mut b = f32s(&u);
                b.resize(OBJ_STRIDE as usize, 0);
                objs.extend_from_slice(&b);
                let front = s.proj.is_some();   // the projected material is FRONT-sided, the authored one double
                match &m.geo {
                    Geo::Plane { w, h } => draws.push(Draw { plane: Some((w.to_bits(), h.to_bits())), glb: None, front, sid: s.surface.clone() }),
                    Geo::Glb { path } => draws.push(Draw { plane: None, glb: Some((path.clone(), k)), front, sid: s.surface.clone() }),
                }
            }
        }
        // Geometry and textures ready (a GLB still loading is simply not drawn yet).
        for dr in &draws {
            if let Some((wb, hb)) = dr.plane {
                if !self.planes.contains_key(&(wb, hb)) { let (v, i) = plane_geometry(f64::from_bits(wb), f64::from_bits(hb)); self.planes.insert((wb, hb), Self::mesh(gpu, &v, &i)); }
            }
            if let Some((p, _)) = &dr.glb { let _ = self.glb(gpu, p); }
            if let Some((g, pic)) = pictures.get(&dr.sid) { let _ = self.texture(gpu, &dr.sid, *g, pic); }
        }
        let need = objs.len().max(OBJ_STRIDE as usize) as u64;
        if self.obj.as_ref().map_or(true, |o| o.0 < need) {
            let buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("calib3d obj"), size: need, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.obj_layout, entries: &[wgpu::BindGroupEntry {
                binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buf, offset: 0, size: wgpu::BufferSize::new(224) }) }] });
            self.obj = Some((need, buf, bind));
        }
        let (_, obj_buf, obj_bind) = self.obj.as_ref().unwrap();
        if !objs.is_empty() { gpu.queue.write_buffer(obj_buf, 0, &objs); }
        let (_, _, msaa, depth) = self.targets.as_ref().unwrap();
        let resolve = if dimmed { &self.resolved.as_ref().unwrap().2 } else { target };
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("calib3d"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: msaa, depth_slice: None, resolve_target: Some(resolve),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Discard } })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_bind_group(0, &self.cam_bind, &[]);
            for (i, dr) in draws.iter().enumerate() {
                let Some((_, tb)) = self.texs.get(&dr.sid) else { continue };
                let mesh = match (&dr.plane, &dr.glb) {
                    (Some(k), _) => self.planes.get(k),
                    (_, Some((p, slot))) => match self.glbs.get(p) { Some(GlbState::Ready(m)) => m.get(*slot).and_then(|x| x.as_ref()), _ => None },
                    _ => None,
                };
                let Some(mesh) = mesh else { continue };
                pass.set_pipeline(if dr.front { &self.pipe_front } else { &self.pipe_double });
                pass.set_bind_group(1, obj_bind, &[(i as u64 * OBJ_STRIDE) as u32]);
                pass.set_bind_group(2, tb, &[]);
                pass.set_vertex_buffer(0, mesh.vb.slice(..));
                pass.set_index_buffer(mesh.ib.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..mesh.n, 0, 0..1);
            }
        }
        if dimmed {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("calib3d dim"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&self.dim_pipe);
            pass.set_bind_group(0, &self.resolved.as_ref().unwrap().3, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
    }
}

fn f32s(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plane_is_threes() {
        // three: PlaneGeometry(16/9, 1) → positions (−w/2, ½), (w/2, ½), (−w/2, −½), (w/2, −½); uv (0,1) (1,1) (0,0) (1,0).
        let (v, i) = plane_geometry(16.0 / 9.0, 1.0);
        let w2 = (16.0f64 / 9.0 / 2.0) as f32;
        assert_eq!(&v[0..2], &[-w2, 0.5]); assert_eq!(&v[6..8], &[0.0, 1.0]);
        assert_eq!(&v[8..10], &[w2, 0.5]); assert_eq!(&v[14..16], &[1.0, 1.0]);
        assert_eq!(&v[16..18], &[-w2, -0.5]); assert_eq!(&v[22..24], &[0.0, 0.0]);
        assert_eq!(&v[24..26], &[w2, -0.5]); assert_eq!(&v[30..32], &[1.0, 0.0]);
        assert_eq!(i, vec![0, 2, 1, 2, 3, 1]);
    }
    #[test]
    fn parses_a_venue() {
        let id: Vec<f64> = vec![1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
        let v = serde_json::json!({ "proj": id, "models": [
            { "id": "p", "kind": "plane", "w": 16.0 / 9.0, "h": 1.0, "mv": id, "world": id, "src": { "surface": "s1" } },
            { "id": "g", "kind": "glb", "path": "x.glb", "meshes": [{ "mv": id, "world": id }], "content": { "src": [{ "surface": "s2", "proj": { "view": id, "eye": [0, 1, 2], "soft": 0.1, "cull": true } }], "mesh": [0] } },
        ] });
        let p = View::parse(&v).unwrap();
        assert_eq!(p.models.len(), 2);
        assert_eq!(p.surfaces(), vec!["s1".to_string(), "s2".to_string()]);
        assert!(p.models[1].src[0].proj.as_ref().unwrap().cull);
    }
}
