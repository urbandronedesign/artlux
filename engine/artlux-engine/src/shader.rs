//! E2 — SHADER content in the engine (plans/native-engine.md §2 "SHADER (node editor)": "its GLSL goes
//! through naga's GLSL front end to WGSL").
//!
//! The author writes ONE function, `vec4 shaderColor(vec2 uv)` (or a pasted Shadertoy `mainImage`), with
//! the uniforms the app's wrapper declares around it (plugins/shader/src/wrapper.ts — the ONE list of what a
//! shader gets for free). The app wraps that into a GLSL ES 3.00 program for WebGL; this module wraps the
//! SAME author text into GLSL 4.50 for naga, which wgpu then compiles. The author's text is never edited.
//!
//! WHY THE WRAPPER DIFFERS FROM THE APP'S, and only in its plumbing:
//!   - naga's GLSL front end takes no loose (non-opaque) uniforms — they live in ONE std140 block here,
//!     and the names the author reads are private globals filled from it at the top of `main`, so the
//!     author's code sees exactly the names and types wrapper.ts declares (a `float iAudio[16]`, not a
//!     vec4[4] it would have to unpack);
//!   - and no combined `sampler2D` uniforms — `palette()` and `lastFrame` are a texture + a sampler, and
//!     `lastFrame` is a macro for `sampler2D(tex, samp)`, which naga accepts wherever a sampler2D goes.
//!     The two vec4[48] tracking arrays are macros straight onto the block (no 96-vec4 copy per pixel).

use naga::front::glsl;
use naga::valid::{Capabilities, ValidationFlags, Validator};

/// One declared input (the shader's header): its name and its GLSL type, as wrapper.ts declares it
/// (`glslTypeOf`: float / int / bool / vec2 / vec4).
#[derive(Clone, Debug)]
pub struct Input { pub name: String, pub glsl: String }

/// Inputs beyond this are refused (the app has no limit, but no shipped shader comes near it, and the
/// block must have a fixed size). The refusal is a compile error the operator sees, not a silent drop.
pub const MAX_INPUTS: usize = 64;

/// The uniform block's size in bytes (std140, every member a vec4 / ivec4): 7 + 4 + 48 + 48 + 3 + inputs.
pub fn block_size(inputs: usize) -> usize { (6 + 4 + 48 + 48 + 3 + inputs.max(1)) * 16 }

/// The author's text wrapped for naga. `prefix_lines` is where the author's line 1 lands, so a naga
/// diagnostic can be pointed back at the author's own file (as wrapper.ts's `prefixLines` does).
pub fn build(author: &str, inputs: &[Input], last_frame: bool) -> (String, usize) {
    let n = inputs.len().max(1);
    let mut p = String::new();
    p.push_str("#version 450\n");
    p.push_str(&format!(
"layout(std140, set = 0, binding = 0) uniform ArtluxBlock {{
  vec4 artlux_res;      // w, h, 1, aspect
  vec4 artlux_time;     // show time, wall time, audio level, -
  ivec4 artlux_ints;    // frame, palette rows, -, -
  vec4 artlux_audio[4];
  vec4 artlux_beat;
  vec4 artlux_beatCount;
  ivec4 artlux_count;   // people on floor, wall, floor+wall, -
  vec4 artlux_people[48];
  vec4 artlux_motion[48];
  vec4 artlux_zone[3];
  vec4 artlux_in[{n}];
}};
layout(set = 0, binding = 1) uniform texture2D artluxPaletteTex;
layout(set = 0, binding = 2) uniform sampler artluxPaletteSamp;
layout(set = 0, binding = 3) uniform texture2D artluxLastTex;
layout(set = 0, binding = 4) uniform sampler artluxLastSamp;
layout(location = 0) in vec2 vUv;
layout(location = 0) out vec4 artluxFragColor;
vec3 iResolution;
float iTime;
float iWallTime;
float iAspect;
int iFrame;
float iAudio[16];
float iAudioLevel;
float iBeat[4];
float iBeatCount[4];
int iPeopleCount[3];
vec2 iTrackZone[3];
#define iPeople artlux_people
#define iPeopleMotion artlux_motion
vec3 palette(int id, float t) {{
  float y = (float(id) + 0.5) / float(max(artlux_ints.y, 1));
  return texture(sampler2D(artluxPaletteTex, artluxPaletteSamp), vec2(fract(t), y)).rgb;
}}
"));
    // WebGL's window origin is the BOTTOM-left, WebGPU's the TOP-left. A shader reading gl_FragCoord gets
    // GL's (y up), and dFdy keeps GL's sign. The uv path needs neither: vUv is built bottom-up as the app's.
    p.push_str("vec4 artluxFragCoord;\nvoid artluxInitCoord() { artluxFragCoord = vec4(gl_FragCoord.x, artlux_res.y - gl_FragCoord.y, gl_FragCoord.z, gl_FragCoord.w); }\n#define gl_FragCoord artluxFragCoord\n#define dFdy(p) (-dFdy(p))\n");
    if last_frame { p.push_str("#define lastFrame sampler2D(artluxLastTex, artluxLastSamp)\n"); }
    for i in inputs { p.push_str(&format!("{} {};\n", i.glsl, i.name)); }
    // Filled once per invocation, before the author's code runs.
    p.push_str("void artluxInit() {\n  iResolution = artlux_res.xyz;\n  iAspect = artlux_res.w;\n  iTime = artlux_time.x;\n  iWallTime = artlux_time.y;\n  iAudioLevel = artlux_time.z;\n  iFrame = artlux_ints.x;\n");
    p.push_str("  for (int k = 0; k < 16; k++) iAudio[k] = artlux_audio[k / 4][k % 4];\n");
    p.push_str("  for (int k = 0; k < 4; k++) { iBeat[k] = artlux_beat[k]; iBeatCount[k] = artlux_beatCount[k]; }\n");
    p.push_str("  for (int k = 0; k < 3; k++) { iPeopleCount[k] = artlux_count[k]; iTrackZone[k] = artlux_zone[k].xy; }\n");
    for (k, i) in inputs.iter().enumerate() {
        let v = match i.glsl.as_str() {
            "vec4" => format!("artlux_in[{k}]"),
            "vec2" => format!("artlux_in[{k}].xy"),
            "int" => format!("int(round(artlux_in[{k}].x))"),
            "bool" => format!("(artlux_in[{k}].x >= 0.5)"),
            _ => format!("artlux_in[{k}].x"),
        };
        p.push_str(&format!("  {} = {v};\n", i.name));
    }
    p.push_str("}\n");
    let prefix_lines = p.lines().count();
    // Same rule as wrapper.ts: a Shadertoy `mainImage` gets the uv → pixels adapter only when the author
    // wrote no shaderColor of their own.
    let shadertoy = !has_call(author, "shaderColor") && has_call(author, "mainImage");
    let mut s = p;
    s.push_str(author);
    if shadertoy { s.push_str("\nvec4 shaderColor(vec2 uv) {\n  vec4 c = vec4(0.0);\n  mainImage(c, uv * iResolution.xy);\n  return c;\n}"); }
    s.push_str("\nvoid main() {\n  artluxInitCoord();\n  artluxInit();\n  artluxFragColor = shaderColor(vUv);\n}\n");
    (s, prefix_lines)
}

/// `\bname\s*\(` — the same test wrapper.ts makes with a regex.
fn has_call(src: &str, name: &str) -> bool {
    let b = src.as_bytes();
    let mut from = 0;
    while let Some(i) = src[from..].find(name) {
        let at = from + i;
        let before_ok = at == 0 || !(b[at - 1].is_ascii_alphanumeric() || b[at - 1] == b'_');
        let rest = src[at + name.len()..].trim_start();
        if before_ok && rest.starts_with('(') { return true; }
        from = at + name.len();
    }
    false
}

/// Compile the wrapped program: GLSL → naga IR → validated → WGSL. Err is a log the operator can read,
/// with line numbers in the AUTHOR's file.
pub fn compile(author: &str, inputs: &[Input], last_frame: bool) -> Result<String, String> {
    if inputs.len() > MAX_INPUTS { return Err(format!("ERROR: more than {MAX_INPUTS} inputs")); }
    let (src, prefix) = build(author, inputs, last_frame);
    let mut fe = glsl::Frontend::default();
    let module = fe.parse(&glsl::Options::from(naga::ShaderStage::Fragment), &src).map_err(|e| {
        e.errors.iter().map(|err| {
            let line = err.meta.location(&src).line_number as usize;
            let author_line = line.saturating_sub(prefix);
            format!("ERROR: 0:{author_line}: {}", err.kind)
        }).collect::<Vec<_>>().join("\n")
    })?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::all()).validate(&module)
        .map_err(|e| format!("ERROR: validation: {}", e.as_inner()))?;
    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty()).map_err(|e| format!("ERROR: wgsl: {e}"))
}

// ── The runner: one per shader SURFACE (feedback history is the surface's, not the program's) ──────────

/// plugins/shader shaderDrawable.sizeFor: a PIXEL BUDGET spent in the surface's aspect, each side quantised to
/// 16 and held to 64…3840. The main window's budget is the Detail rung (the host sends that size); a projector
/// window's is its own inner size — this computes that one, for the engine's projector outputs.
pub fn size_for(budget: f64, aspect: f64) -> (u32, u32) {
    let a = if aspect.is_finite() && aspect > 0.0 { aspect } else { 16.0 / 9.0 };
    // JavaScript's Math.round: half away from zero for these positive values, i.e. floor(x + 0.5).
    let q = |v: f64| (((v / 16.0) + 0.5).floor() * 16.0).clamp(64.0, 3840.0) as u32;
    (q((budget * a).sqrt()), q((budget / a).sqrt()))
}

/// What the host sends for a shader surface (contentSource NativeSource `{kind:'shader'}`).
#[derive(Clone, Debug, PartialEq)]
pub struct Spec { pub source: String, pub inputs: Vec<(String, String)>, pub last_frame: bool, pub w: u32, pub h: u32,
    /// The app's guard disabled this surface (over its frame budget): keep the last picture, draw no more.
    pub hold: bool }

impl Spec {
    pub fn from_json(v: &serde_json::Value) -> Spec {
        Spec {
            source: v["source"].as_str().unwrap_or_default().to_string(),
            inputs: v["inputs"].as_array().into_iter().flatten().map(|i| (i["name"].as_str().unwrap_or_default().to_string(), i["glsl"].as_str().unwrap_or("float").to_string())).collect(),
            last_frame: v["lastFrame"].as_bool().unwrap_or(false),
            w: v["w"].as_u64().unwrap_or(1280).clamp(1, 8192) as u32,
            h: v["h"].as_u64().unwrap_or(720).clamp(1, 8192) as u32,
            hold: v["hold"].as_bool().unwrap_or(false),
        }
    }
    fn inputs(&self) -> Vec<Input> { self.inputs.iter().map(|(n, g)| Input { name: n.clone(), glsl: g.clone() }).collect() }
}

/// The app's VERT (wrapper.ts): one big triangle, vUv = aPos * 0.5 + 0.5 — so vUv.y = 0 is the BOTTOM row,
/// as in the app's canvas, and the picture's row 0 (the top) is vUv.y = 1, as in the app's bitmap.
const VERT_WGSL: &str = r#"
struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var a = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o: V; o.p = vec4<f32>(a[i], 0.0, 1.0); o.uv = a[i] * 0.5 + 0.5; return o;
}
"#;
/// The history copy, turned over: the app's history is a copyTexSubImage2D of a GL framebuffer, whose
/// row 0 is the BOTTOM, and `texture(lastFrame, uv)` relies on that. The engine's output has row 0 at the
/// top, so it is copied upside down once per frame — and the author's sampling is unchanged.
const FLIP_WGSL: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
struct V { @builtin(position) p: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var a = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o: V; o.p = vec4<f32>(a[i], 0.0, 1.0); return o;
}
@fragment fn fs(v: V) -> @location(0) vec4<f32> {
  let d = textureDimensions(src);
  return textureLoad(src, vec2<i32>(i32(v.p.x), i32(d.y) - 1 - i32(v.p.y)), 0);
}
"#;

/// The app's canvas is 8-bit RGBA with premultipliedAlpha: what the shader writes IS the premultiplied
/// pixel. Stored as such here (compose's pictures are premultiplied).
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

pub struct Runner {
    spec: Spec,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    ubuf: wgpu::Buffer,
    palette: wgpu::TextureView,
    pal_samp: wgpu::Sampler,
    last_samp: wgpu::Sampler,
    rows: i32,
    hist: Option<(wgpu::Texture, u32, u32)>,
    flip: Option<(wgpu::RenderPipeline, wgpu::BindGroupLayout)>,
    blank: wgpu::TextureView,
}

impl Runner {
    pub fn new(gpu: &crate::Gpu, spec: &Spec) -> Result<Runner, String> {
        let d = &gpu.device;
        let wgsl = compile(&spec.source, &spec.inputs(), spec.last_frame)?;
        let frag = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("shader frag"), source: wgpu::ShaderSource::Wgsl(wgsl.into()) });
        let vert = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("shader vert"), source: wgpu::ShaderSource::Wgsl(VERT_WGSL.into()) });
        let tex = |b: u32| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None };
        let samp = |b: u32| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None };
        let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("shader"), entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
            tex(1), samp(2), tex(3), samp(4),
        ] });
        let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipeline = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("shader"), layout: Some(&pl),
            vertex: wgpu::VertexState { module: &vert, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &frag, entry_point: Some("main"), targets: &[Some(FORMAT.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("shader uniforms"), size: block_size(spec.inputs.len()) as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        // shaderContext.ensurePaletteLut: 256 × rows RGBA, LINEAR, REPEAT along t, CLAMP across rows.
        let lut = crate::effects::palette_lut();
        let rows = (lut.len() / (256 * 4)) as u32;
        let pt = d.create_texture(&wgpu::TextureDescriptor { label: Some("palette lut"), size: wgpu::Extent3d { width: 256, height: rows, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
        gpu.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &pt, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, &lut,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256 * 4), rows_per_image: Some(rows) }, wgpu::Extent3d { width: 256, height: rows, depth_or_array_layers: 1 });
        let pal_samp = d.create_sampler(&wgpu::SamplerDescriptor { label: Some("palette"), address_mode_u: wgpu::AddressMode::Repeat, address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        // ensureHistory: LINEAR, CLAMP (a trail off the edge fades rather than wrapping round).
        let last_samp = d.create_sampler(&wgpu::SamplerDescriptor { label: Some("lastFrame"), address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        let blank = d.create_texture(&wgpu::TextureDescriptor { label: Some("no history"), size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: FORMAT, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
        gpu.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &blank, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, &[0, 0, 0, 0],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) }, wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 });
        Ok(Runner { spec: spec.clone(), pipeline, layout, ubuf, palette: pt.create_view(&Default::default()), pal_samp, last_samp, rows: rows as i32, hist: None, flip: None, blank: blank.create_view(&Default::default()) })
    }

    /// Is this runner still the one for `spec`? A new text / input list / feedback flag recompiles; a new
    /// SIZE does not — it only reallocates the output (and the history, as the app's canvas does).
    pub fn fits(&self, spec: &Spec) -> bool { self.spec.source == spec.source && self.spec.inputs == spec.inputs && self.spec.last_frame == spec.last_frame }

    /// One frame at show time `t` with the host's uniforms `u` (shaderContext.nativeUniforms). Returns the
    /// picture's texture: w × h, row 0 at the top, premultiplied.
    pub fn render(&mut self, gpu: &crate::Gpu, w: u32, h: u32, t: f64, u: &serde_json::Value) -> wgpu::Texture {
        let d = &gpu.device;
        // ── the block (`build`), std140, every member a 16-byte slot ──
        let f = |k: &str, n: usize| -> Vec<f32> { let mut v: Vec<f32> = u[k].as_array().into_iter().flatten().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect(); v.resize(n, 0.0); v };
        let mut b: Vec<u8> = Vec::with_capacity(block_size(self.spec.inputs.len()));
        fn put(b: &mut Vec<u8>, v: &[f32]) { for x in v { b.extend_from_slice(&x.to_le_bytes()); } }
        fn puti(b: &mut Vec<u8>, v: &[i32]) { for x in v { b.extend_from_slice(&x.to_le_bytes()); } }
        put(&mut b, &[w as f32, h as f32, 1.0, if h > 0 { w as f32 / h as f32 } else { 1.0 }]);
        put(&mut b, &[t as f32, u["wall"].as_f64().unwrap_or(0.0) as f32, u["level"].as_f64().unwrap_or(0.0) as f32, 0.0]);
        puti(&mut b, &[u["frame"].as_i64().unwrap_or(0) as i32, self.rows, 0, 0]);
        put(&mut b, &f("audio", 16));
        put(&mut b, &f("beat", 4));
        put(&mut b, &f("beatCount", 4));
        let c = f("count", 3);
        puti(&mut b, &[c[0] as i32, c[1] as i32, c[2] as i32, 0]);
        put(&mut b, &f("people", 192));
        put(&mut b, &f("motion", 192));
        let z = f("zone", 6);
        put(&mut b, &[z[0], z[1], 0.0, 0.0, z[2], z[3], 0.0, 0.0, z[4], z[5], 0.0, 0.0]);
        let ins = u["in"].as_array().cloned().unwrap_or_default();
        for k in 0..self.spec.inputs.len().max(1) {
            let mut v: Vec<f32> = ins.get(k).and_then(|x| x.as_array()).into_iter().flatten().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
            v.resize(4, 0.0);
            put(&mut b, &v);
        }
        gpu.queue.write_buffer(&self.ubuf, 0, &b);

        let out = d.create_texture(&wgpu::TextureDescriptor { label: Some("shader picture"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: FORMAT, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
        let mut enc = d.create_command_encoder(&Default::default());
        // The history: reallocated (cleared to transparent black — the app's seed for a trail) on a size change.
        if self.spec.last_frame && self.hist.as_ref().is_none_or(|(_, hw, hh)| *hw != w || *hh != h) {
            let t = d.create_texture(&wgpu::TextureDescriptor { label: Some("shader history"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2, format: FORMAT, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
            {
                let v = t.create_view(&Default::default());
                let _ = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("clear history"), color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &v, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })], ..Default::default() });
            }
            self.hist = Some((t, w, h));
        }
        let hist_view = self.hist.as_ref().map(|(t, _, _)| t.create_view(&Default::default()));
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.layout, entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: self.ubuf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.palette) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.pal_samp) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(hist_view.as_ref().unwrap_or(&self.blank)) },
            wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.last_samp) },
        ] });
        let out_view = out.create_view(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("shader"), color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &out_view, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        // Keep this frame as the next frame's past, in GL's row order (FLIP_WGSL).
        if let Some((hist, _, _)) = &self.hist {
            if self.flip.is_none() {
                let m = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("history flip"), source: wgpu::ShaderSource::Wgsl(FLIP_WGSL.into()) });
                let l = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None }] });
                let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&l)], immediate_size: 0 });
                let p = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: Some("history flip"), layout: Some(&pl),
                    vertex: wgpu::VertexState { module: &m, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
                    fragment: Some(wgpu::FragmentState { module: &m, entry_point: Some("fs"), targets: &[Some(FORMAT.into())], compilation_options: Default::default() }),
                    primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None });
                self.flip = Some((p, l));
            }
            let (fp, fl) = self.flip.as_ref().unwrap();
            let fb = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: fl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&out_view) }] });
            let hv = hist.create_view(&Default::default());
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("history"), color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &hv, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(fp);
            pass.set_bind_group(0, &fb, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
        out
    }
}
