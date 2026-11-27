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
//!   - the POST PASS (E6f step 2): ProjectorScene's EffectComposer, mounted for a lens distortion or a blend look — the
//!     scene then renders LINEAR into an 8× MSAA half-float buffer (@react-three/postprocessing's defaults:
//!     multisampling 8, HalfFloatType; three writes no OETF into a linear render target), resolved, and ONE merged
//!     EffectPass draws postprocessing's fullscreen triangle: DistortionEffect's mainUv bends the lookup, the input is
//!     read there (LinearFilter, clamp), BlendEffect's mainImage applies the soft edge / rig blend / gain / lift in
//!     PHYSICAL raster space (gl_FragCoord), the NORMAL blend at opacity 1 keeps it, then three's OETF into the 8-bit
//!     canvas. POST below, line for line from ProjectorScene's distortFrag / blendFrag and blendGlsl.ts.
//!   - a RESIDUAL WARP (E6f step 3, `warped`): ProjectorApp's path B — the scene's canvas, undimmed, becomes the warp
//!     stage's source (outputs.rs: projector::CanvasContent + projector::Warp, geometry only).
//!   - OCCLUSION (E6f step 4): projectorDepth.ts — every venue mesh rendered from the projecting projector into a
//!     1024² RGBA8 map of its PACKED LINEAR distance (clip.w / 250, both faces, cleared white = nothing there), and
//!     BODY_FRAG's test against it, the bias growing on grazing faces. DEPTH below, line for line.
//!   - a mesh in its OWN material (E6f step 5): the window lights a venue file's materials with an ambient and a
//!     hemisphere light and no environment map, where MeshStandardMaterial reduces to irradiance × diffuse ×
//!     (1 − metalness) / π + emissive, then ACESFilmic (r3f's default; none under the post pass's composer) and the
//!     OETF. OWN below, from three's lights_* / tonemapping chunks; the host refuses what that does not cover.
//! Not drawn yet (the host refuses it, with the reason): a timeline layer.

use crate::compose::Picture;
use crate::Gpu;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

pub const SAMPLES: u32 = 4;
/// The post pass's scene buffer: EffectComposer's `multisampling` default, in its HalfFloatType.
pub const POST_SAMPLES: u32 = 8;
const LINEAR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const DEPTH_FMT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;
const OBJ_STRIDE: u64 = 256;
/// The Obj uniform: mv, world, proj (64 each), pe, pf, po (16 each).
const OBJ_SIZE: u64 = 256;   // the OWN uniform (E6i step 4); the content Obj is 240 and reads within it
/// projectorDepth.ts DEPTH_SIZE and DEPTH_FAR (metres — what the packed distance is normalised over).
pub const DEPTH_SIZE: u32 = 1024;
pub const DEPTH_FAR: f32 = 250.0;

/// One content source: a surface, optionally PROJECTED from a projector (view-projection, eye, soft, cull).
#[derive(Clone, Debug)]
pub struct Src { pub surface: String, pub proj: Option<Proj> }
#[derive(Clone, Debug)]
pub struct Proj { pub view: [f32; 16], pub eye: [f32; 3], pub soft: f32, pub cull: bool, pub occlude: bool, pub bias: f32 }

/// One placed mesh: its model-view (three's modelViewMatrix) and world matrix (modelMatrix), as the host computed them —
/// and, wearing its OWN material, that material and three's normalMatrix.
#[derive(Clone, Debug)]
pub struct Xf { pub mv: [f32; 16], pub world: [f32; 16], pub own: Option<Own> }

/// A MeshStandardMaterial's uniforms (diffuse, metalness, emissive × emissiveIntensity — linear), its side (three's
/// FrontSide 0 / BackSide 1 / DoubleSide 2) and the mesh's normal matrix (column-major 3 × 3).
#[derive(Clone, Debug)]
pub struct Own {
    pub color: [f32; 3], pub metalness: f32, pub emissive: [f32; 3], pub side: u8, pub nm: [f32; 9],
    /// E6i step 4: map, emissiveMap, metalnessMap, aoMap, normalMap (glTF's base colour, emissive, metallic-roughness,
    /// occlusion, normal) — and the normal map's normalScale.
    pub maps: [Option<MapRef>; 5],
    pub normal_scale: [f32; 2],
    /// E6i step 4b: opacity, alphaTest, transparent (NormalBlending, drawn after the opaque, far to near by `z` — three's
    /// projected bounding-sphere centre), depthWrite, forceSinglePass, aoMapIntensity.
    pub opacity: f32, pub alpha_test: f32, pub transparent: bool, pub depth_write: bool, pub single: bool, pub ao: f32, pub z: f32,
    /// E6i step 4d: vertexColors (COLOR_0 × diffuse; × alpha too when the attribute has four components), and the
    /// normal map's TBN from the mesh's own TANGENT attribute (three's USE_TANGENT) rather than screen derivatives.
    pub vertex_colors: bool, pub vertex_alpha: bool, pub tangents: bool,
}
/// A map: three's sampler for it, and — a map that is not a PNG — the raster key of the APP's decode of it.
#[derive(Clone, Debug)]
pub struct MapRef { pub s: MapSampler, pub raster: Option<String> }

/// E6i step 4: a map texture — its source (the GLB's path, or a raster key), its image (usize::MAX for a raster), its
/// sampler, and whether it is sRGB.
type MapKey = (String, usize, MapSampler, bool);

/// E6i step 4: an own mesh's draw — its side (this pass's), blending, depth write, its maps, its sort depth.
struct OwnDraw { side: u8, blend: bool, depth_write: bool, maps: [Option<MapKey>; 5], z: f32 }

/// E6i step 4: a base-colour MAP (the GLB's own baseColorTexture — the engine reads the image from the file, as three's
/// GLTFLoader does) and three's sampler for it, as its constants: wrapS / wrapT (RepeatWrapping 1000, ClampToEdge 1001,
/// MirroredRepeat 1002), magFilter / minFilter (Nearest 1003 … LinearMipmapLinear 1008).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MapSampler { pub wrap_s: u32, pub wrap_t: u32, pub mag: u32, pub min: u32 }

/// The window's two lights as WebGLLights uploads them: ambient, hemisphere sky / ground (× intensity), its direction
/// in view space.
#[derive(Clone, Debug)]
pub struct Lights { pub ambient: [f32; 3], pub sky: [f32; 3], pub ground: [f32; 3], pub dir: [f32; 3] }

#[derive(Clone, Debug)]
pub enum Geo { Plane { w: f64, h: f64 }, Glb { path: String } }

#[derive(Clone, Debug)]
pub struct Model { pub id: String, pub geo: Geo, pub meshes: Vec<Xf>, pub src: Vec<Src>, pub mesh_src: Vec<i32> }

/// The blend look, as BlendEffect's uniforms (renderLook.blendValues): soft edge l r t b, gamma, gain, lift, and the
/// solved rig blend's two 8-bit grids (w, h, alpha, black) — absent, BlendEffect binds white 1×1 and uHasBlend 0.
#[derive(Clone, Debug)]
pub struct Blend { pub soft: [f32; 4], pub gamma: f32, pub gain: [f32; 3], pub lift: [f32; 3], pub map: Option<(u32, u32, Vec<u8>, Vec<u8>)>, pub key: u64 }

/// The post pass: DistortionEffect's values (fx fy cx cy k1 k2 k3 p1 p2 — renderLook.distortionValues) and/or the blend.
#[derive(Clone, Debug)]
pub struct Post { pub dist: Option<[f32; 9]>, pub blend: Option<Blend> }

/// A calibrated output's venue, from the document's `calib`.
#[derive(Clone, Debug)]
pub struct View { pub proj: [f32; 16], pub models: Vec<Model>, pub post: Option<Post>, pub warped: bool, pub lights: Option<Lights> }

fn xf_of(x: &Value) -> Option<Xf> {
    let own = x.get("own").filter(|o| o.is_object()).and_then(|o| Some(Own {
        color: fl::<3>(&o["color"])?, metalness: o["metalness"].as_f64()? as f32, emissive: fl::<3>(&o["emissive"])?,
        side: o["side"].as_u64().unwrap_or(0).min(2) as u8, nm: fl::<9>(&x["nm"])?,
        maps: {
            let one = |m: &Value| -> Option<Option<MapRef>> {
                if m.is_null() { return Some(None); }
                Some(Some(MapRef {
                    s: MapSampler { wrap_s: m["wrapS"].as_u64()? as u32, wrap_t: m["wrapT"].as_u64()? as u32, mag: m["mag"].as_u64()? as u32, min: m["min"].as_u64()? as u32 },
                    // A map that is not a PNG comes as the APP's decode, a raster under this key (not the file's).
                    raster: m["raster"].as_str().map(str::to_string),
                }))
            };
            let a = o["maps"].as_array();
            [one(a.and_then(|a| a.first()).unwrap_or(&Value::Null))?, one(a.and_then(|a| a.get(1)).unwrap_or(&Value::Null))?,
             one(a.and_then(|a| a.get(2)).unwrap_or(&Value::Null))?, one(a.and_then(|a| a.get(3)).unwrap_or(&Value::Null))?,
             one(a.and_then(|a| a.get(4)).unwrap_or(&Value::Null))?]
        },
        normal_scale: fl::<2>(&o["normalScale"]).unwrap_or([1.0, 1.0]),
        opacity: o["opacity"].as_f64().unwrap_or(1.0) as f32, alpha_test: o["alphaTest"].as_f64().unwrap_or(0.0) as f32,
        transparent: o["transparent"].as_bool().unwrap_or(false), depth_write: o["depthWrite"].as_bool().unwrap_or(true),
        single: o["forceSinglePass"].as_bool().unwrap_or(false), ao: o["aoMapIntensity"].as_f64().unwrap_or(1.0) as f32,
        z: o["z"].as_f64().unwrap_or(0.0) as f32,
        vertex_colors: o["vertexColors"].as_bool().unwrap_or(false), vertex_alpha: o["vertexAlpha"].as_bool().unwrap_or(false),
        tangents: o["tangents"].as_bool().unwrap_or(false),
    }));
    // A mesh that says it wears its own material but whose material did not parse is no mesh (drawn as nothing,
    // never as something else).
    if x.get("own").is_some_and(|o| o.is_object()) && own.is_none() { return None; }
    Some(Xf { mv: m16(&x["mv"])?, world: m16(&x["world"])?, own })
}

fn fl<const N: usize>(v: &Value) -> Option<[f32; N]> {
    let a = v.as_array()?;
    if a.len() != N { return None; }
    let mut m = [0f32; N];
    for (i, x) in a.iter().enumerate() { m[i] = x.as_f64()? as f32; }
    Some(m)
}

fn bytes(v: &Value) -> Option<Vec<u8>> { v.as_array()?.iter().map(|x| x.as_u64().map(|b| b.min(255) as u8)).collect() }

fn post_of(v: &Value) -> Option<Post> {
    if !v.is_object() { return None; }
    let dist = fl::<9>(&v["dist"]);
    let blend = v["blend"].as_object().and_then(|b| {
        let map = b.get("map").and_then(|m| {
            let (w, h) = (m["w"].as_u64()? as u32, m["h"].as_u64()? as u32);
            let (a, k) = (bytes(&m["alpha"])?, bytes(&m["black"])?);
            let n = (w.max(1) * h.max(1)) as usize;
            if a.len() != n || k.len() != n { return None; }
            Some((w.max(1), h.max(1), a, k))
        });
        use std::hash::{Hash, Hasher};
        let mut hs = std::collections::hash_map::DefaultHasher::new();
        map.hash(&mut hs);
        Some(Blend { soft: fl::<4>(b.get("soft")?)?, gamma: b.get("gamma")?.as_f64()? as f32, gain: fl::<3>(b.get("gain")?)?, lift: fl::<3>(b.get("lift")?)?, map, key: hs.finish() })
    });
    if dist.is_none() && blend.is_none() { return None; }
    Some(Post { dist, blend })
}

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
        occlude: p.get("occlude").and_then(|x| x.as_bool()).unwrap_or(false),
        bias: p.get("bias").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
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
                    meshes: vec![Xf { mv: m16(&m["mv"])?, world: m16(&m["world"])?, own: None }],
                    src: vec![src_of(&m["src"])?], mesh_src: vec![0],
                }),
                "glb" => models.push(Model {
                    id, geo: Geo::Glb { path: m["path"].as_str()?.to_string() },
                    meshes: m["meshes"].as_array()?.iter().map(xf_of).collect::<Option<Vec<_>>>()?,
                    src: m["content"]["src"].as_array()?.iter().map(src_of).collect::<Option<Vec<_>>>()?,
                    mesh_src: m["content"]["mesh"].as_array()?.iter().map(|x| x.as_i64().unwrap_or(-1) as i32).collect(),
                }),
                _ => return None,
            }
        }
        // `warped`: the output carries a residual warp — the venue is then the warp stage's SOURCE (outputs.rs, path B).
        let l = &v["lights"];
        let lights = (|| Some(Lights { ambient: fl::<3>(&l["ambient"])?, sky: fl::<3>(&l["sky"])?, ground: fl::<3>(&l["ground"])?, dir: fl::<3>(&l["dir"])? }))();
        Some(View { proj, models, post: post_of(&v["post"]), warped: v["warped"].as_bool().unwrap_or(false), lights })
    }
    /// The surfaces it shows (the presenters need their pictures).
    /// E6i step 4: the raster keys of the maps the app decodes for this venue (published to the presenter as is).
    pub fn maps(&self) -> Vec<String> {
        let mut v: Vec<String> = self.models.iter().flat_map(|m| m.meshes.iter().filter_map(|x| x.own.as_ref()))
            .flat_map(|o| o.maps.iter().filter_map(|r| r.as_ref().and_then(|r| r.raster.clone()))).collect();
        v.sort(); v.dedup(); v
    }
    pub fn surfaces(&self) -> Vec<String> {
        let mut v: Vec<String> = self.models.iter().flat_map(|m| m.src.iter().map(|s| s.surface.clone())).collect();
        v.sort(); v.dedup(); v
    }
}

const SHADER: &str = r#"
struct Cam { p: mat4x4<f32> };
@group(0) @binding(0) var<uniform> cam: Cam;
// mv = three's modelViewMatrix, world = modelMatrix; proj = the PROJECTING camera's view-projection (GL clip);
// pe = its eye + edge softness; pf.x = projected, pf.y = facing test; po = (has depth map, bias m, DEPTH_FAR, _).
struct Obj { mv: mat4x4<f32>, world: mat4x4<f32>, proj: mat4x4<f32>, pe: vec4<f32>, pf: vec4<f32>, po: vec4<f32> };
@group(1) @binding(0) var<uniform> obj: Obj;
@group(2) @binding(0) var tex: texture_2d<f32>;
@group(2) @binding(1) var samp: sampler;
// The projector's depth map (NEAREST — four bytes are one number), or a white 1×1 (farDepthTexture).
@group(3) @binding(0) var dtex: texture_2d<f32>;
@group(3) @binding(1) var dsamp: sampler;

// projectorDepth.ts DEPTH_PACK_GLSL artluxUnpackDepth.
fn artluxUnpackDepth(p: vec4<f32>) -> f32 { return dot(p, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }

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
    // BODY_FRAG's OCCLUSION: plain NDC→UV into the depth map, metres, the bias grown on grazing faces.
    if (obj.po.x > 0.5 && vis > 0.0) {
      let duv = ndc.xy * 0.5 + 0.5;
      let seen = artluxUnpackDepth(textureSampleLevel(dtex, dsamp, duv, 0.0)) * obj.po.z;
      let bias = obj.po.y * (1.0 + 4.0 * (1.0 - abs(ndl)));
      if (i.ppos.w > seen + bias) { vis = 0.0; }
    }
  }
  let s = textureSample(tex, samp, uv);
  // MeshBasicMaterial: diffuseColor = white × texel (opacity 1); outgoingLight = diffuseColor.rgb.
  let c = s.rgb * vis;
  return vec4<f32>(oetf(c), s.a);
}

// The same material into the post pass's LINEAR render target: three applies no OETF there.
@fragment fn fs_lin(i: VOut) -> @location(0) vec4<f32> {
  var uv = i.uv;
  var vis = 1.0;
  if (obj.pf.x > 0.5) {
    if (i.ppos.w <= 0.0) { vis = 0.0; }
    let ndc = i.ppos.xyz / max(i.ppos.w, 1e-6);
    uv = vec2<f32>(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);
    uv = uv * vec2<f32>(1.0, -1.0) + vec2<f32>(0.0, 1.0);
    let e = max(obj.pe.w, 1e-4);
    let ix = 1.0 - smoothstep(1.0 - e, 1.0, abs(ndc.x));
    let iy = 1.0 - smoothstep(1.0 - e, 1.0, abs(ndc.y));
    vis = vis * ix * iy * step(abs(ndc.z), 1.0);
    let ndl = dot(normalize(i.pnrm), normalize(obj.pe.xyz - i.pworld));
    vis = vis * mix(1.0, step(0.0, ndl), obj.pf.y);
    // BODY_FRAG's OCCLUSION: plain NDC→UV into the depth map, metres, the bias grown on grazing faces.
    if (obj.po.x > 0.5 && vis > 0.0) {
      let duv = ndc.xy * 0.5 + 0.5;
      let seen = artluxUnpackDepth(textureSampleLevel(dtex, dsamp, duv, 0.0)) * obj.po.z;
      let bias = obj.po.y * (1.0 + 4.0 * (1.0 - abs(ndl)));
      if (i.ppos.w > seen + bias) { vis = 0.0; }
    }
  }
  let s = textureSample(tex, samp, uv);
  return vec4<f32>(s.rgb * vis, s.a);
}
"#;

// A venue mesh's OWN MeshStandardMaterial, lit as the projector window lights it (ambient + hemisphere, no environment
// map — so RE_IndirectSpecular adds exactly zero and there is no direct light): meshphysical.glsl's path through
// normal_fragment_begin, lights_physical_fragment, lights_fragment_begin (irradiance = ambient, += the hemisphere),
// RE_IndirectDiffuse_Physical (irradiance × BRDF_Lambert(diffuseContribution)), opaque_fragment, tonemapping (r3f's
// ACESFilmic, exposure 1 — not under the composer, which sets NoToneMapping and renders to a target), colorspace.
// Same bind groups as SHADER (the venue's pipeline layout), the Obj slot read as `Own`.
const OWN: &str = r#"
struct Cam { p: mat4x4<f32> };
@group(0) @binding(0) var<uniform> cam: Cam;
// flags = (double-sided, back-sided, toneMappingExposure, _)
// flags.w = has a map; mf = (has emissiveMap, has metalnessMap, has aoMap, aoMapIntensity); tr = (opacity, alphaTest,
// transparent, normalScale.y); n0.w = has a normalMap, emissive.w = normalScale.x; n1.w = vertex colours, n2.w = vertex
// alpha, dir.w = the normal map's frame from the mesh's own tangents.
struct Own { mv: mat4x4<f32>, n0: vec4<f32>, n1: vec4<f32>, n2: vec4<f32>, color: vec4<f32>, emissive: vec4<f32>,
             ambient: vec4<f32>, sky: vec4<f32>, ground: vec4<f32>, dir: vec4<f32>, flags: vec4<f32>, mf: vec4<f32>, tr: vec4<f32> };
@group(1) @binding(0) var<uniform> own: Own;
// E6i step 4: map, emissiveMap (sRGB-decoded by their format), metalnessMap, aoMap (linear) — mipmapped; a white 1×1
// where there is none.
@group(2) @binding(0) var omap: texture_2d<f32>;
@group(2) @binding(1) var osamp: sampler;
@group(2) @binding(2) var oemi: texture_2d<f32>;
@group(2) @binding(3) var osemi: sampler;
@group(2) @binding(4) var omet: texture_2d<f32>;
@group(2) @binding(5) var osmet: sampler;
@group(2) @binding(6) var oao: texture_2d<f32>;
@group(2) @binding(7) var osao: sampler;
@group(2) @binding(8) var onor: texture_2d<f32>;
@group(2) @binding(9) var osnor: sampler;

// vpos = mvPosition.xyz (three's −vViewPosition), for the normal map's screen-space tangent frame.
struct OOut { @builtin(position) pos: vec4<f32>, @location(0) vn: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) vpos: vec3<f32>,
              @location(3) col: vec4<f32>, @location(4) vt: vec3<f32>, @location(5) vb: vec3<f32> };

@vertex fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) col: vec4<f32>, @location(4) tan: vec4<f32>) -> OOut {
  var o: OOut;
  let mvp = own.mv * vec4<f32>(p, 1.0);
  var c = cam.p * mvp;
  c.y = -c.y;
  c.z = (c.z + c.w) * 0.5;
  o.pos = c;
  // defaultnormal_vertex: transformedNormal = normalMatrix * objectNormal (negated for BackSide, FLIP_SIDED);
  // normal_vertex: vNormal = normalize(transformedNormal).
  var tn = mat3x3<f32>(own.n0.xyz, own.n1.xyz, own.n2.xyz) * n;
  if (own.flags.y > 0.5) { tn = -tn; }
  o.vn = normalize(tn);
  // vMapUv = uv (no transform; the host refuses one). The geometry's v was turned to 1 − v at load (the content
  // path's flip) — turned back: GLTFLoader's textures are flipY false, so glTF's v samples the image as stored.
  o.uv = vec2<f32>(uv.x, 1.0 - uv.y);
  o.vpos = mvp.xyz;
  // color_vertex: vColor = color (rgb, or rgba with vertex alpha) — applied in the fragment where the material asks.
  o.col = col;
  // tangent_vertex / normal_vertex (USE_TANGENT): transformedTangent = (modelViewMatrix × (tangent.xyz, 0)).xyz, negated
  // for BackSide; vTangent = normalize(it); vBitangent = normalize(cross(vNormal, vTangent) × tangent.w).
  var tt = (own.mv * vec4<f32>(tan.xyz, 0.0)).xyz;
  if (own.flags.y > 0.5) { tt = -tt; }
  o.vt = normalize(tt);
  o.vb = normalize(cross(o.vn, o.vt) * tan.w);
  return o;
}

fn lit(i: OOut, ff: bool) -> vec4<f32> {
  // Every map sampled first, unconditionally (uniform control flow), applied where there is one.
  let texel = textureSample(omap, osamp, i.uv);
  let temi = textureSample(oemi, osemi, i.uv);
  let tmet = textureSample(omet, osmet, i.uv);
  let tao = textureSample(oao, osao, i.uv);
  let tnor = textureSample(onor, osnor, i.uv);
  // normalmap_pars_fragment getTangentFrame's derivatives — here, in uniform control flow (dFdx → HLSL ddx on both
  // sides: ANGLE's D3D11 and wgpu's DX12). The raster is bottom-up as GL's window is, so dpdy is GL's dFdy.
  let q0 = dpdx(i.vpos);
  let q1 = dpdy(i.vpos);
  let st0 = dpdx(i.uv);
  let st1 = dpdy(i.uv);
  // diffuseColor = vec4(diffuse, opacity); map_fragment: *= texel; alphatest_fragment: discard below alphaTest.
  var dc = vec4<f32>(own.color.rgb, own.tr.x);
  if (own.flags.w > 0.5) { dc = dc * texel; }
  // color_fragment: diffuseColor.rgb *= vColor.rgb (USE_COLOR), diffuseColor *= vColor (USE_COLOR_ALPHA).
  if (own.n1.w > 0.5) { dc = vec4<f32>(dc.rgb * i.col.rgb, select(dc.a, dc.a * i.col.a, own.n2.w > 0.5)); }
  if (own.tr.y > 0.0 && dc.a < own.tr.y) { discard; }
  let diffuse = dc.rgb;
  // metalnessmap_fragment: metalnessFactor *= texelMetalness.b; emissivemap_fragment: totalEmissiveRadiance *= texel.rgb.
  let metalness = select(own.color.w, own.color.w * tmet.b, own.mf.y > 0.5);
  let emissive = select(own.emissive.rgb, own.emissive.rgb * temi.rgb, own.mf.x > 0.5);
  // normal_fragment_begin.
  let faceDirection = select(-1.0, 1.0, ff);
  var normal = normalize(i.vn);
  if (own.flags.x > 0.5) { normal = normal * faceDirection; }
  // E6i step 4c — a TANGENT-SPACE NORMAL MAP with no tangents (GLTFLoader's usual case): normal_fragment_begin's
  // tbn = getTangentFrame(−vViewPosition, normal, vNormalMapUv) (× faceDirection when double-sided), then
  // normal_fragment_maps: mapN = texel × 2 − 1, mapN.xy *= normalScale, normal = normalize(tbn × mapN).
  if (own.n0.w > 0.5) {
    let N = normal;
    let q1perp = cross(q1, N);
    let q0perp = cross(N, q0);
    let T = q1perp * st0.x + q0perp * st1.x;
    let B = q1perp * st0.y + q0perp * st1.y;
    let det = max(dot(T, T), dot(B, B));
    let sc = select(inverseSqrt(det), 0.0, det == 0.0);
    var t = T * sc;
    var b = B * sc;
    // USE_TANGENT: tbn = mat3(normalize(vTangent), normalize(vBitangent), normal) — the mesh's own tangents.
    if (own.dir.w > 0.5) { t = normalize(i.vt); b = normalize(i.vb); }
    if (own.flags.x > 0.5) { t = t * faceDirection; b = b * faceDirection; }
    var mapN = tnor.xyz * 2.0 - 1.0;
    mapN = vec3<f32>(mapN.xy * vec2<f32>(own.emissive.w, own.tr.w), mapN.z);
    normal = normalize(mat3x3<f32>(t, b, N) * mapN);
  }
  // lights_physical_fragment: diffuseContribution = diffuseColor.rgb * (1 - metalnessFactor).
  let diffuseContribution = diffuse * (1.0 - metalness);
  // lights_fragment_begin: irradiance = ambientLightColor; += getHemisphereLightIrradiance(hemi, normal).
  var irradiance = own.ambient.rgb;
  let dotNL = dot(normal, own.dir.xyz);
  let hemiDiffuseWeight = 0.5 * dotNL + 0.5;
  irradiance = irradiance + mix(own.ground.rgb, own.sky.rgb, vec3<f32>(hemiDiffuseWeight));
  // RE_IndirectDiffuse_Physical: irradiance * BRDF_Lambert(diffuseContribution) = irradiance * (RECIPROCAL_PI * c).
  var indirectDiffuse = irradiance * (0.3183098861837907 * diffuseContribution);
  // aomap_fragment: ambientOcclusion = (texel.r − 1) × aoMapIntensity + 1; indirectDiffuse *= it.
  if (own.mf.z > 0.5) { indirectDiffuse = indirectDiffuse * ((tao.r - 1.0) * own.mf.w + 1.0); }
  // outgoingLight = totalDiffuse + totalSpecular (0) + totalEmissiveRadiance; opaque_fragment: alpha 1 unless
  // transparent.
  return vec4<f32>(indirectDiffuse + emissive, select(1.0, dc.a, own.tr.z > 0.5));
}

// tonemapping_pars_fragment ACESFilmicToneMapping, as written there.
fn RRTAndODTFit(v: vec3<f32>) -> vec3<f32> {
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
fn ACESFilmicToneMapping(c0: vec3<f32>) -> vec3<f32> {
  let ACESInputMat = mat3x3<f32>(vec3<f32>(0.59719, 0.07600, 0.02840), vec3<f32>(0.35458, 0.90834, 0.13383), vec3<f32>(0.04823, 0.01566, 0.83777));
  let ACESOutputMat = mat3x3<f32>(vec3<f32>(1.60475, -0.10208, -0.00327), vec3<f32>(-0.53108, 1.10813, -0.07276), vec3<f32>(-0.07367, -0.00605, 1.07602));
  var color = c0 * (own.flags.z / 0.6);
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
}
fn oetf(v: vec3<f32>) -> vec3<f32> {
  return mix(pow(v, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055), v * 12.92, vec3<f32>(v <= vec3<f32>(0.0031308)));
}

@fragment fn fs(i: OOut, @builtin(front_facing) ff: bool) -> @location(0) vec4<f32> {
  let c = lit(i, ff);
  return vec4<f32>(oetf(ACESFilmicToneMapping(c.rgb)), c.a);
}
@fragment fn fs_lin(i: OOut, @builtin(front_facing) ff: bool) -> @location(0) vec4<f32> {
  return lit(i, ff);
}
"#;

// projectorDepth.ts makeDepthShaderMaterial, written out: the proxy's projectionMatrix * modelViewMatrix * p (the
// depth camera's projection IS the projector's world→clip, its view identity — so model-view is the mesh's world),
// clip.w carried as the distance, packed into RGBA8. ANGLE's y negate and depth remap, as every pass here.
const DEPTH: &str = r#"
struct D { vp: mat4x4<f32>, world: mat4x4<f32>, k: vec4<f32> };
@group(0) @binding(0) var<uniform> u: D;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) dist: f32 };
@vertex fn vs(@location(0) p: vec3<f32>) -> VO {
  var c = (u.vp * u.world) * vec4<f32>(p, 1.0);
  var o: VO;
  o.dist = c.w;
  c.y = -c.y;
  c.z = (c.z + c.w) * 0.5;
  o.pos = c;
  return o;
}
fn artluxPackDepth(v: f32) -> vec4<f32> {
  var e = fract(clamp(v, 0.0, 0.999999) * vec4<f32>(1.0, 255.0, 65025.0, 16581375.0));
  e = e - e.yzww * vec4<f32>(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return e;
}
@fragment fn fs(i: VO) -> @location(0) vec4<f32> { return artluxPackDepth(i.dist * u.k.x); }
"#;

// THE POST PASS — postprocessing's EffectPass as it merges ProjectorScene's two effects (effect.frag + effect.vert,
// DistortionEffect's mainUv, BlendEffect's mainImage, blendGlsl.ts's ramp), written out in the same order.
// u.res = (w, h, distort?, blend?); focal = (fx, fy, cx, cy); radial = (k1, k2, k3, _); tang = (p1, p2, gamma, hasMap).
const POST: &str = r#"
struct U { res: vec4<f32>, focal: vec4<f32>, radial: vec4<f32>, tang: vec4<f32>, soft: vec4<f32>, gain: vec4<f32>, lift: vec4<f32> };
@group(0) @binding(0) var inp: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var btex: texture_2d<f32>;
@group(0) @binding(3) var ktex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u: U;

struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

// postprocessing's fullscreen triangle (-1,-1) (3,-1) (-1,3); effect.vert: vUv = position.xy * 0.5 + 0.5,
// gl_Position = vec4(position.xy, 1.0, 1.0) — then ANGLE's y negate (the bottom-up raster) and depth remap.
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = vec2<f32>(-1.0, -1.0);
  if (i == 1u) { p = vec2<f32>(3.0, -1.0); } else if (i == 2u) { p = vec2<f32>(-1.0, 3.0); }
  var o: VO;
  o.uv = p * 0.5 + 0.5;
  o.pos = vec4<f32>(p.x, -p.y, 1.0, 1.0);
  return o;
}

// blendGlsl.ts SOFT_EDGE_GLSL.
fn softEdgeFeather(d: f32, w: f32) -> f32 { return select(clamp(d / w, 0.0, 1.0), 1.0, w <= 0.0); }
fn softEdgeShare(uv: vec2<f32>, s: vec4<f32>) -> f32 {
  return softEdgeFeather(uv.x, s.x) * softEdgeFeather(1.0 - uv.x, s.y)
       * softEdgeFeather(uv.y, s.z) * softEdgeFeather(1.0 - uv.y, s.w);
}
fn blendSignal(share: f32, g: f32) -> f32 { return pow(max(share, 0.0), 1.0 / max(g, 0.1)); }
// ProjectorScene blendFrag.
fn blendEncodeSRGB(c0: vec3<f32>) -> vec3<f32> { let c = max(c0, vec3<f32>(0.0)); return mix(c * 12.92, 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, step(vec3<f32>(0.0031308), c)); }
fn blendDecodeSRGB(c0: vec3<f32>) -> vec3<f32> { let c = max(c0, vec3<f32>(0.0)); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3<f32>(2.4)), step(vec3<f32>(0.04045), c)); }
// three's sRGBTransferOETF (colorspace_fragment, ENCODE_OUTPUT).
fn oetf(v: vec3<f32>) -> vec3<f32> {
  return mix(pow(v, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055), v * 12.92, vec3<f32>(v <= vec3<f32>(0.0031308)));
}

@fragment fn fs(i: VO) -> @location(0) vec4<f32> {
  var uv = i.uv;
  if (u.res.z > 0.5) {
    // DistortionEffect mainUv.
    let px = uv * u.res.xy;
    let nd = (px - u.focal.zw) / u.focal.xy;
    let r2 = dot(nd, nd);
    let radial = 1.0 + u.radial.x * r2 + u.radial.y * r2 * r2 + u.radial.z * r2 * r2 * r2;
    let dt = vec2<f32>(2.0 * u.tang.x * nd.x * nd.y + u.tang.y * (r2 + 2.0 * nd.x * nd.x),
                       u.tang.x * (r2 + 2.0 * nd.y * nd.y) + 2.0 * u.tang.y * nd.x * nd.y);
    let ndd = nd * radial + dt;
    uv = (ndd * u.focal.xy + u.focal.zw) / u.res.xy;
  }
  var color0 = textureSampleLevel(inp, samp, uv, 0.0);
  if (u.res.w > 0.5) {
    // BlendEffect mainImage — in physical raster space (gl_FragCoord), v = 0 at the TOP.
    let suv = vec2<f32>(i.pos.x / u.res.x, 1.0 - i.pos.y / u.res.y);
    let share = softEdgeShare(suv, u.soft) * mix(1.0, textureSampleLevel(btex, samp, suv, 0.0).r, u.tang.w);
    let a = blendSignal(share, u.tang.z);
    let blackW = mix(1.0 - a, textureSampleLevel(ktex, samp, suv, 0.0).r, u.tang.w);
    let signal = blendEncodeSRGB(color0.rgb) * a * u.gain.rgb + u.lift.rgb * blackW;
    color0 = vec4<f32>(blendDecodeSRGB(signal), color0.a);
  }
  color0.a = clamp(color0.a, 0.0, 1.0);
  return vec4<f32>(oetf(color0.rgb), color0.a);
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

/// `ex` (E6i step 4d, a GLB's meshes): the second vertex buffer the OWN pipelines read — colour and tangent per vertex.
struct GpuMesh { vb: wgpu::Buffer, ib: wgpu::Buffer, n: u32, ex: Option<wgpu::Buffer> }
/// What the post pass reads: (w, h, blend key) it was made for, and its bind group.
struct PostBind { key: (u32, u32, u64), bind: wgpu::BindGroup, _texs: Vec<wgpu::Texture> }
enum GlbState { Loading, Ready(Vec<Option<GpuMesh>>), Failed }
type Loaded = (String, Result<Arc<crate::scenegpu::Loaded>, String>);

/// The renderer one presenter holds: pipelines, the venue's geometry, the surfaces' textures, its targets.
pub struct Renderer {
    pipe_double: wgpu::RenderPipeline,
    pipe_front: wgpu::RenderPipeline,
    /// The same into the post pass's linear 8× buffer.
    lin_double: wgpu::RenderPipeline,
    lin_front: wgpu::RenderPipeline,
    post_samples: u32,
    post_pipe: wgpu::RenderPipeline,
    post_buf: wgpu::Buffer,
    post_bind: Option<PostBind>,
    cam_buf: wgpu::Buffer,
    cam_bind: wgpu::BindGroup,
    obj_layout: wgpu::BindGroupLayout,
    obj: Option<(u64, wgpu::Buffer, wgpu::BindGroup)>,
    tex_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    /// Occlusion: the depth pass, its per-(map, mesh) uniforms, the depth-map bind layout, the white 1×1 bound
    /// where a mesh reads no map, and one map per projecting projector (keyed by its view-projection's bits).
    depth_pipe: wgpu::RenderPipeline,
    /// OWN materials: their pipeline layout (group 2: four maps), the module, the pipelines.
    layout: wgpu::PipelineLayout,
    own_module: wgpu::ShaderModule,
    own_pipes: HashMap<(u8, bool, bool, bool), wgpu::RenderPipeline>,   // (side, post pass?, blend, depth write)
    /// E6i step 4: each venue GLB's images (decoded RGBA) and, by three's mesh slot, its maps' images — the textures made
    /// of them (by source, image, sampler, sRGB?), and the four-map bindings of the own pipelines' group 2.
    /// O5-2a: the parse itself (shared — scenegpu::cpu), held while this output shows the file, with its buffers.
    glb_imgs: HashMap<String, (Vec<[Option<usize>; 5]>, Arc<crate::scenegpu::Loaded>)>,
    glb_bufs: HashMap<String, Arc<crate::scenegpu::GlbBufs>>,
    own_views: HashMap<MapKey, (wgpu::TextureView, wgpu::Sampler)>,
    /// O5-2a: the shared textures behind `own_views` (a GLB's images — scenegpu::image), held while in use.
    own_texs: HashMap<MapKey, Arc<wgpu::Texture>>,
    own_binds: HashMap<[Option<MapKey>; 5], wgpu::BindGroup>,
    own_tex_layout: wgpu::BindGroupLayout,
    own_white: (wgpu::TextureView, wgpu::Sampler),
    depth_u: Option<(u64, wgpu::Buffer, wgpu::BindGroup)>,
    dmap_layout: wgpu::BindGroupLayout,
    dsamp: wgpu::Sampler,
    far_bind: wgpu::BindGroup,
    dmaps: HashMap<[u32; 16], (wgpu::TextureView, wgpu::TextureView, wgpu::BindGroup)>,
    /// O2-4: what the occlusion maps were last drawn from (the projectors, every caster's mesh and place).
    dmap_key: u64,
    planes: HashMap<(u64, u64), GpuMesh>,
    glbs: HashMap<String, GlbState>,
    loaded_tx: Sender<Loaded>,
    loaded_rx: Receiver<Loaded>,
    /// surface id → (picture generation, its texture's sRGB bindings)
    texs: HashMap<String, (u64, wgpu::BindGroup, wgpu::Texture)>,
    /// (w, h, post?, the MSAA colour, its depth, the resolved linear picture the post pass reads)
    targets: Option<(u32, u32, bool, wgpu::TextureView, wgpu::TextureView, Option<wgpu::TextureView>)>,
    /// Path C's dim: its pipeline and uniform, and the resolved picture it reads (made at the target's size).
    dim_pipe: wgpu::RenderPipeline,
    dim_buf: wgpu::Buffer,
    resolved: Option<(u32, u32, wgpu::TextureView, wgpu::BindGroup)>,
    out_id: String,
}

/// E6i step 4: one mip level from the one above — a bilinear sample at each destination texel's centre (exactly the
/// 2×2 average of the source texels under it), read through the sRGB view (decoded to linear before filtering) and
/// written through it (the hardware's encode): what a GPU's GenerateMips on an sRGB format does. A CPU average with
/// its own encode was off by 1 on the smallest levels (measured: 1 007 pixels at the far end of a minified wall).
const MIP: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
struct V { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  var o: V;
  o.p = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  o.uv = vec2<f32>(x, y);
  return o;
}
@fragment fn fs(v: V) -> @location(0) vec4<f32> { return textureSampleLevel(src, s, v.uv, 0.0); }
"#;

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
            binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(OBJ_SIZE) }, count: None }] });
        let tex_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("calib3d tex"), entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        ] });
        let dmap_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("calib3d depth map"), entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        ] });
        let layout = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("calib3d"), bind_group_layouts: &[Some(&cam_layout), Some(&obj_layout), Some(&tex_layout), Some(&dmap_layout)], immediate_size: 0 });
        // EffectComposer asks 8 samples; three clamps to the context's MAX_SAMPLES (8 on a desktop D3D11 GPU). wgpu
        // offers 8 only with the adapter-specific format features — where it cannot, 4 (logged: the edges then differ).
        let ok8 = d.features().contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
            && [LINEAR, DEPTH_FMT].iter().all(|f| gpu.adapter.get_texture_format_features(*f).flags.sample_count_supported(POST_SAMPLES));
        let post_samples = if ok8 { POST_SAMPLES } else { eprintln!("artlux-engine: output '{out_id}': no 8x MSAA here — the post pass's edges use 4x"); SAMPLES };
        let mk = |cull: Option<wgpu::Face>, fmt: wgpu::TextureFormat, samples: u32, fs: &str| d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("calib3d"), layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2] })] },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), compilation_options: Default::default(),
                targets: &[Some(fmt.into())] }),
            // GL's front face is counter-clockwise; with y negated (the bottom-up raster) it is clockwise here — the
            // same flip ANGLE makes.
            primitive: wgpu::PrimitiveState { cull_mode: cull, front_face: wgpu::FrontFace::Cw, ..Default::default() },
            // three: depthTest + depthWrite, LessEqual.
            depth_stencil: Some(wgpu::DepthStencilState { format: DEPTH_FMT, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::LessEqual), stencil: Default::default(), bias: Default::default() }),
            multisample: wgpu::MultisampleState { count: samples, mask: !0, alpha_to_coverage_enabled: false },
            multiview_mask: None, cache: None,
        });
        let own_module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("calib3d own"), source: wgpu::ShaderSource::Wgsl(OWN.into()) });
        // E6i step 4: the own pipelines' group 2 — four maps, each a texture and its own sampler — and a white 1×1.
        let own_tex_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("calib3d own maps"), entries: &(0..10u32).map(|b| wgpu::BindGroupLayoutEntry {
            binding: b, visibility: wgpu::ShaderStages::FRAGMENT, count: None,
            ty: if b % 2 == 0 { wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false } }
                else { wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering) } }).collect::<Vec<_>>() });
        let own_layout = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("calib3d own"), bind_group_layouts: &[Some(&cam_layout), Some(&obj_layout), Some(&own_tex_layout), Some(&dmap_layout)], immediate_size: 0 });
        let own_white = {
            use wgpu::util::DeviceExt;
            let t = d.create_texture_with_data(&gpu.queue, &wgpu::TextureDescriptor {
                label: Some("calib3d white"), size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] },
                wgpu::util::TextureDataOrder::LayerMajor, &[255, 255, 255, 255]);
            (t.create_view(&Default::default()), d.create_sampler(&Default::default()))
        };
        let pipe_double = mk(None, wgpu::TextureFormat::Rgba8Unorm, SAMPLES, "fs");
        let pipe_front = mk(Some(wgpu::Face::Back), wgpu::TextureFormat::Rgba8Unorm, SAMPLES, "fs");
        let lin_double = mk(None, LINEAR, post_samples, "fs_lin");
        let lin_front = mk(Some(wgpu::Face::Back), LINEAR, post_samples, "fs_lin");
        let pm = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("calib3d post"), source: wgpu::ShaderSource::Wgsl(POST.into()) });
        let post_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("calib3d post"), layout: None,
            vertex: wgpu::VertexState { module: &pm, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &pm, entry_point: Some("fs"), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        // The depth pass: projectorDepth's ShaderMaterial — DoubleSide, depth test + write (LessEqual), RGBA8, no MSAA.
        let dm = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("calib3d depth"), source: wgpu::ShaderSource::Wgsl(DEPTH.into()) });
        let du_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("calib3d depth u"), entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(144) }, count: None }] });
        let depth_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("calib3d depth"), layout: Some(&d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&du_layout)], immediate_size: 0 })),
            vertex: wgpu::VertexState { module: &dm, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3] })] },
            fragment: Some(wgpu::FragmentState { module: &dm, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())] }),
            primitive: wgpu::PrimitiveState { cull_mode: None, front_face: wgpu::FrontFace::Cw, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState { format: DEPTH_FMT, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::LessEqual), stencil: Default::default(), bias: Default::default() }),
            multisample: Default::default(), multiview_mask: None, cache: None,
        });
        // NEAREST both ways, clamp — makeTarget's filters (linear would average the bytes of two distances).
        let dsamp = d.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("calib3d depth map"), address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest, min_filter: wgpu::FilterMode::Nearest, mipmap_filter: wgpu::MipmapFilterMode::Nearest, ..Default::default() });
        let far_bind = {
            use wgpu::util::DeviceExt;
            let t = d.create_texture_with_data(&gpu.queue, &wgpu::TextureDescriptor {
                label: Some("calib3d far depth"), size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] },
                wgpu::util::TextureDataOrder::LayerMajor, &[255, 255, 255, 255]);
            let v = t.create_view(&Default::default());
            d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &dmap_layout, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&v) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&dsamp) },
            ] })
        };
        let post_buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("calib3d post"), size: 112, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
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
        Renderer { pipe_double, pipe_front, lin_double, lin_front, post_samples, post_pipe, post_buf, post_bind: None, cam_buf, cam_bind, obj_layout, obj: None, tex_layout, sampler,
            depth_pipe, depth_u: None, dmap_layout, dsamp, far_bind, dmaps: HashMap::new(), dmap_key: 0,
            layout: own_layout, own_module, own_pipes: HashMap::new(), glb_imgs: HashMap::new(), glb_bufs: HashMap::new(), own_views: HashMap::new(), own_texs: HashMap::new(), own_binds: HashMap::new(), own_tex_layout, own_white, planes: HashMap::new(), glbs: HashMap::new(),
            loaded_tx, loaded_rx, texs: HashMap::new(), targets: None, dim_pipe, dim_buf, resolved: None, out_id: out_id.to_string() }
    }

    fn mesh(gpu: &Gpu, verts: &[f32], idx: &[u32]) -> GpuMesh {
        use wgpu::util::DeviceExt;
        let d = &gpu.device;
        let vb = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("calib3d vb"), contents: &f32s(verts), usage: wgpu::BufferUsages::VERTEX });
        let ib = d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("calib3d ib"), contents: &idx.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), usage: wgpu::BufferUsages::INDEX });
        GpuMesh { vb, ib, n: idx.len() as u32, ex: None }
    }

    /// A venue GLB's meshes, by three's mesh slot — loaded OFF this thread (a CAD venue takes seconds), drawn once in.
    /// Every mesh here WEARS CONTENT (the host refuses one that does not), so glTF's v is turned to 1 − v, in f32, as
    /// modelScreens.flippedUv does on the twin geometry.
    fn glb(&mut self, gpu: &Gpu, path: &str) -> Option<&Vec<Option<GpuMesh>>> {
        while let Ok((p, r)) = self.loaded_rx.try_recv() {
            let st = match r {
                Ok(l) => {
                    // O5-2a: the parse and the (v-flipped) buffers are the SHARED ones — every calibrated output on
                    // this device draws the same buffers (scenegpu.rs; they were N copies).
                    let cpu = &l.cpu;
                    let n = cpu.prims.iter().map(|p| p.slot + 1).max().unwrap_or(0);
                    let mut by_slot: Vec<Option<GpuMesh>> = (0..n).map(|_| None).collect();
                    let bufs = crate::scenegpu::bufs(gpu, &l, true);
                    for (i, pr) in cpu.prims.iter().enumerate() {
                        by_slot[pr.slot] = Some(GpuMesh { vb: bufs.vb[i].clone(), ib: bufs.ib[i].clone(), n: pr.idx.len() as u32, ex: Some(bufs.ex[i].clone()) });
                    }
                    self.glb_bufs.insert(p.clone(), bufs);
                    eprintln!("artlux-engine: output '{}': venue {p} loaded ({n} meshes)", self.out_id);
                    let mut img_of: Vec<[Option<usize>; 5]> = vec![[None; 5]; n];
                    for pr in &cpu.prims { img_of[pr.slot] = pr.maps; }
                    self.own_views.retain(|k, _| k.0 != p);
                    self.own_texs.retain(|k, _| k.0 != p);
                    self.own_binds.clear();
                    self.glb_imgs.insert(p.clone(), (img_of, l.clone()));
                    GlbState::Ready(by_slot)
                }
                Err(e) => { eprintln!("artlux-engine: output '{}': venue {p}: {e}", self.out_id); GlbState::Failed }
            };
            self.glbs.insert(p, st);
        }
        if !self.glbs.contains_key(path) {
            self.glbs.insert(path.to_string(), GlbState::Loading);
            let (tx, p) = (self.loaded_tx.clone(), path.to_string());
            std::thread::spawn(move || { let r = crate::scenegpu::cpu(&p); let _ = tx.send((p, r)); });
        }
        match self.glbs.get(path) { Some(GlbState::Ready(m)) => Some(m), _ => None }
    }

    /// E6i step 4 — A GLB's base-colour map as three uploads it: SRGB8_ALPHA8 (decoded to linear by the format before
    /// filtering), generateMipmap (ANGLE on D3D11: GenerateMips on the sRGB format — done on the GPU here, MIP), and
    /// the glTF sampler three made of it.
    fn own_map(&self, gpu: &Gpu, key: &MapKey, pictures: &HashMap<String, (u64, Arc<Picture>)>) -> Option<(wgpu::TextureView, wgpu::Sampler, Option<Arc<wgpu::Texture>>)> {
        // usize::MAX: the app's decode, a raster picture (opaque — the bytes as three uploaded them); otherwise the GLB's.
        let pic;
        let mut shared: Option<&str> = None;
        let (w, h, rgba): (&u32, &u32, &Vec<u8>) = if key.1 == usize::MAX {
            pic = pictures.get(&key.0)?.1.clone();
            (&pic.w, &pic.h, &pic.rgba)
        } else {
            let (_, l) = self.glb_imgs.get(&key.0)?;
            shared = Some(&l.key);
            let (w, h, rgba) = l.cpu.images.get(key.1)?;
            (w, h, rgba)
        };
        if *w == 0 || *h == 0 || rgba.len() < (*w * *h * 4) as usize { return None; }
        // O5-2a: a GLB image is made ONCE for every calibrated output (scenegpu::image) — its texture and mips; the
        // sampler (the glTF sampler three made) stays this key's own.
        let tex = match shared {
            Some(fk) => crate::scenegpu::image(gpu, fk, key.1, crate::scenegpu::ImageUse::VenueMap { srgb: key.3 }, || Self::own_map_texture(gpu, *w, *h, rgba, key.3)),
            None => Arc::new(Self::own_map_texture(gpu, *w, *h, rgba, key.3)),
        };
        let d = &gpu.device;
        let s = key.2;
        let wrap = |m: u32| match m { 1001 => wgpu::AddressMode::ClampToEdge, 1002 => wgpu::AddressMode::MirrorRepeat, _ => wgpu::AddressMode::Repeat };
        let lin = |f: u32| if matches!(f, 1003 | 1004 | 1005) { wgpu::FilterMode::Nearest } else { wgpu::FilterMode::Linear };
        // minFilter: Nearest / Linear read the base level only; *MipmapNearest one level, *MipmapLinear two.
        let mipped = matches!(s.min, 1004 | 1005 | 1007 | 1008);
        let sampler = d.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("calib3d own map"), address_mode_u: wrap(s.wrap_s), address_mode_v: wrap(s.wrap_t),
            mag_filter: lin(s.mag), min_filter: lin(s.min),
            mipmap_filter: if matches!(s.min, 1005 | 1008) { wgpu::MipmapFilterMode::Linear } else { wgpu::MipmapFilterMode::Nearest },
            lod_max_clamp: if mipped { 32.0 } else { 0.0 }, ..Default::default() });
        Some((tex.create_view(&Default::default()), sampler, shared.map(|_| tex)))
    }

    /// The texture of an own map: the image, uploaded in its format, with a full mip chain made on the GPU (MIP).
    fn own_map_texture(gpu: &Gpu, w: u32, h: u32, rgba: &[u8], srgb: bool) -> wgpu::Texture {
        let (w, h) = (&w, &h);
        let d = &gpu.device;
        let levels = 32 - (*w).max(*h).leading_zeros();   // three: floor(log2(max)) + 1
        // map / emissiveMap are sRGB (decoded by the format), metalnessMap / aoMap linear data.
        let fmt = if srgb { wgpu::TextureFormat::Rgba8UnormSrgb } else { wgpu::TextureFormat::Rgba8Unorm };
        let t = d.create_texture(&wgpu::TextureDescriptor {
            label: Some("calib3d own map"), size: wgpu::Extent3d { width: *w, height: *h, depth_or_array_layers: 1 }, mip_level_count: levels, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: fmt,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
        gpu.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &rgba[..(*w * *h * 4) as usize], wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(*w * 4), rows_per_image: Some(*h) },
            wgpu::Extent3d { width: *w, height: *h, depth_or_array_layers: 1 });
        // generateMipmap, on the GPU (MIP above). O5-2a: the pipeline once per (device, format) — it was compiled per map.
        static MIPS: crate::PerDevice<wgpu::TextureFormat, (wgpu::RenderPipeline, wgpu::Sampler)> = crate::PerDevice::new();
        let (pipe, lin) = MIPS.get(d, fmt, || {
            let mm = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("calib3d mip"), source: wgpu::ShaderSource::Wgsl(MIP.into()) });
            let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("calib3d mip"), layout: None,
                vertex: wgpu::VertexState { module: &mm, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState { module: &mm, entry_point: Some("fs"), targets: &[Some(fmt.into())], compilation_options: Default::default() }),
                primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
            });
            (pipe, d.create_sampler(&wgpu::SamplerDescriptor { label: Some("calib3d mip"), mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() }))
        });
        let mut enc = d.create_command_encoder(&Default::default());
        for lv in 1..levels {
            let one = |l: u32| t.create_view(&wgpu::TextureViewDescriptor { base_mip_level: l, mip_level_count: Some(1), ..Default::default() });
            let (sv, dv) = (one(lv - 1), one(lv));
            let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&sv) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&lin) },
            ] });
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("calib3d mip"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &dv, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&pipe);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
        t
    }

    /// E6i step 4: the own pipelines' group 2 for these four maps (white where there is none).
    fn own_bind(&self, gpu: &Gpu, keys: &[Option<MapKey>; 5]) -> Option<wgpu::BindGroup> {
        let mut views = Vec::with_capacity(5);
        for k in keys { views.push(match k { Some(k) => self.own_views.get(k)?, None => &self.own_white }); }
        let entries: Vec<wgpu::BindGroupEntry> = views.iter().enumerate().flat_map(|(j, (v, s))| [
            wgpu::BindGroupEntry { binding: j as u32 * 2, resource: wgpu::BindingResource::TextureView(v) },
            wgpu::BindGroupEntry { binding: j as u32 * 2 + 1, resource: wgpu::BindingResource::Sampler(s) },
        ]).collect();
        Some(gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("calib3d own maps"), layout: &self.own_tex_layout, entries: &entries }))
    }

    /// The surface's picture as three samples a streamed frame: its visible rect, sRGB-decoded by the format.
    fn texture(&mut self, gpu: &Gpu, sid: &str, gen: u64, p: &Picture) -> Option<&wgpu::BindGroup> {
        if self.texs.get(sid).map(|t| t.0) != Some(gen) {
            let d = &gpu.device;
            let [cx, cy, cw, ch] = p.crop.unwrap_or([0, 0, p.w, p.h]);
            if cw == 0 || ch == 0 { return None; }
            // O1-3: the surface's own texture and its bind group KEPT while the size holds — a new frame is a copy into
            // it (every draw that sampled the last one is already submitted; the one queue keeps the order). It was a
            // new texture + bind group per frame, per surface, per calibrated output.
            let kept = self.texs.remove(sid).filter(|t| t.2.width() == cw && t.2.height() == ch);
            let t = match &kept { Some(k) => k.2.clone(), None => d.create_texture(&wgpu::TextureDescriptor {
                label: Some("calib3d surface"), size: wgpu::Extent3d { width: cw, height: ch, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[wgpu::TextureFormat::Rgba8UnormSrgb] }) };
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
            let bind = match kept { Some(k) => k.1, None => {
                let view = t.create_view(&wgpu::TextureViewDescriptor { format: Some(wgpu::TextureFormat::Rgba8UnormSrgb), ..Default::default() });
                d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.tex_layout, entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                ] })
            } };
            self.texs.insert(sid.to_string(), (gen, bind, t));
        }
        self.texs.get(sid).map(|t| &t.1)
    }

    /// Draw the venue into `target` (Rgba8Unorm, w × h, BOTTOM-UP as the projector raster is), cleared to black.
    /// `pictures`: surface id → its picture; `dim`: projectorBrightness × the surface's opacity.
    /// O2-3: a venue file still on its way in (drawn every pass until it lands, then only on a change).
    pub fn loading(&self) -> bool { self.glbs.values().any(|g| matches!(g, GlbState::Loading)) }

    pub fn draw(&mut self, gpu: &Gpu, view: &View, pictures: &HashMap<String, (u64, Arc<Picture>)>, target: &wgpu::TextureView, w: u32, h: u32, dim: f64) {
        let d = &gpu.device;
        let post = view.post.as_ref();
        let posted = post.is_some();
        if self.targets.as_ref().map(|t| (t.0, t.1, t.2)) != Some((w, h, posted)) {
            let samples = if posted { self.post_samples } else { SAMPLES };
            let mk = |format: wgpu::TextureFormat, label: &str, samples: u32, usage: wgpu::TextureUsages| d.create_texture(&wgpu::TextureDescriptor {
                label: Some(label), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: samples,
                dimension: wgpu::TextureDimension::D2, format, usage, view_formats: &[] }).create_view(&Default::default());
            let ra = wgpu::TextureUsages::RENDER_ATTACHMENT;
            let colour = if posted { LINEAR } else { wgpu::TextureFormat::Rgba8Unorm };
            self.targets = Some((w, h, posted, mk(colour, "calib3d msaa", samples, ra), mk(DEPTH_FMT, "calib3d depth", samples, ra),
                posted.then(|| mk(LINEAR, "calib3d linear", 1, ra | wgpu::TextureUsages::TEXTURE_BINDING))));
            self.post_bind = None;
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
        struct Draw { plane: Option<(u64, u64)>, glb: Option<(String, usize)>, front: bool, sid: String, world: [f32; 16], occl: Option<[u32; 16]>, own: Option<OwnDraw> }
        let mut draws: Vec<Draw> = Vec::new();
        let mut objs: Vec<u8> = Vec::new();
        // The venue files first: a textured own mesh needs its file's images to say which map it wears.
        for m in &view.models { if let Geo::Glb { path } = &m.geo { let _ = self.glb(gpu, path); } }
        for m in &view.models {
            for (k, xf) in m.meshes.iter().enumerate() {
                // A mesh in its OWN material: the Own uniform in its slot (mv, normal matrix, material, the lights).
                if let (Some(o), Geo::Glb { path }, Some(l)) = (&xf.own, &m.geo, &view.lights) {
                    // E6i step 4: the map this slot wears in the file. Not loaded yet → not drawn yet (as the geometry);
                    // the host says a map and the file has none → not drawn (never drawn as something else).
                    // Each map's texture: the file's image (a PNG), or the app's decode once it has arrived. One not
                    // there yet → the mesh is not drawn yet (as while the geometry loads); never drawn without it.
                    let mut keys: [Option<MapKey>; 5] = Default::default();
                    let mut ready = true;
                    for (j, r) in o.maps.iter().enumerate() {
                        let Some(r) = r else { continue };
                        let srgb = j <= 1;
                        keys[j] = match &r.raster {
                            Some(key) => pictures.contains_key(key).then(|| (key.clone(), usize::MAX, r.s, srgb)),
                            None => self.glb_imgs.get(path).and_then(|(of, _)| of.get(k).and_then(|a| a[j])).map(|img| (path.clone(), img, r.s, srgb)),
                        };
                        if keys[j].is_none() { ready = false; }
                    }
                    if !ready { continue; }
                    // WebGLRenderer.renderObject: a TRANSPARENT DoubleSide material (not forceSinglePass) is drawn twice —
                    // BackSide, then FrontSide; each a program of its own (FLIP_SIDED, no DOUBLE_SIDED).
                    let passes: Vec<u8> = if o.transparent && o.side == 2 && !o.single { vec![1, 0] } else { vec![o.side] };
                    for side in passes {
                        let mut u: Vec<f32> = Vec::with_capacity(64);
                        u.extend_from_slice(&xf.mv);
                        let on = |j: usize| if keys[j].is_some() { 1.0 } else { 0.0 };
                        let vc = [on(4), if o.vertex_colors { 1.0 } else { 0.0 }, if o.vertex_colors && o.vertex_alpha { 1.0 } else { 0.0 }];
                        for c in 0..3 { u.extend_from_slice(&[o.nm[c * 3], o.nm[c * 3 + 1], o.nm[c * 3 + 2], vc[c]]); }
                        u.extend_from_slice(&[o.color[0], o.color[1], o.color[2], o.metalness]);
                        u.extend_from_slice(&[o.emissive[0], o.emissive[1], o.emissive[2], o.normal_scale[0]]);
                        for v in [l.ambient, l.sky, l.ground] { u.extend_from_slice(&[v[0], v[1], v[2], 0.0]); }
                        u.extend_from_slice(&[l.dir[0], l.dir[1], l.dir[2], if o.tangents && keys[4].is_some() { 1.0 } else { 0.0 }]);
                        u.extend_from_slice(&[if side == 2 { 1.0 } else { 0.0 }, if side == 1 { 1.0 } else { 0.0 }, 1.0, on(0)]);
                        u.extend_from_slice(&[on(1), on(2), on(3), o.ao]);
                        u.extend_from_slice(&[o.opacity, o.alpha_test, if o.transparent { 1.0 } else { 0.0 }, o.normal_scale[1]]);
                        let mut b = f32s(&u);
                        b.resize(OBJ_STRIDE as usize, 0);
                        objs.extend_from_slice(&b);
                        draws.push(Draw { plane: None, glb: Some((path.clone(), k)), front: false, sid: String::new(), world: xf.world, occl: None,
                            own: Some(OwnDraw { side, blend: o.transparent, depth_write: o.depth_write, maps: keys.clone(), z: o.z }) });
                    }
                    continue;
                }
                let Some(si) = m.mesh_src.get(k).copied().filter(|&i| i >= 0) else { continue };
                let Some(s) = m.src.get(si as usize) else { continue };
                // The uniform: mv, world, proj (the projecting camera), pe (eye, soft), pf (projected, cull).
                let mut u: Vec<f32> = Vec::with_capacity(64);
                u.extend_from_slice(&xf.mv); u.extend_from_slice(&xf.world);
                match &s.proj {
                    Some(p) => {
                        u.extend_from_slice(&p.view); u.extend_from_slice(&[p.eye[0], p.eye[1], p.eye[2], p.soft, 1.0, if p.cull { 1.0 } else { 0.0 }, 0.0, 0.0]);
                        u.extend_from_slice(&[if p.occlude { 1.0 } else { 0.0 }, p.bias, DEPTH_FAR, 0.0]);
                    }
                    None => { u.extend_from_slice(&[0.0; 16]); u.extend_from_slice(&[0.0; 12]); }
                }
                let occl = s.proj.as_ref().filter(|p| p.occlude).map(|p| p.view.map(f32::to_bits));
                let mut b = f32s(&u);
                b.resize(OBJ_STRIDE as usize, 0);
                objs.extend_from_slice(&b);
                let front = s.proj.is_some();   // the projected material is FRONT-sided, the authored one double
                match &m.geo {
                    Geo::Plane { w, h } => draws.push(Draw { plane: Some((w.to_bits(), h.to_bits())), glb: None, front, sid: s.surface.clone(), world: xf.world, occl, own: None }),
                    Geo::Glb { path } => draws.push(Draw { plane: None, glb: Some((path.clone(), k)), front, sid: s.surface.clone(), world: xf.world, occl, own: None }),
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
            // OWN pipelines: three's side → the cull (FrontSide culls back faces, BackSide front ones, DoubleSide none);
            // a transparent one blends (NormalBlending, straight alpha) and writes depth as its material says.
            if let Some(od) = &dr.own {
                for k in od.maps.iter().flatten() {
                    if !self.own_views.contains_key(k) {
                        if let Some((v, s, t)) = self.own_map(gpu, k, pictures) {
                            self.own_views.insert(k.clone(), (v, s));
                            if let Some(t) = t { self.own_texs.insert(k.clone(), t); }
                        }
                    }
                }
                if !self.own_binds.contains_key(&od.maps) { if let Some(b) = self.own_bind(gpu, &od.maps) { self.own_binds.insert(od.maps.clone(), b); } }
                let (side, blend, dw) = (od.side, od.blend, od.depth_write);
                if !self.own_pipes.contains_key(&(side, posted, blend, dw)) {
                    let (fmt, samples, fs) = if posted { (LINEAR, self.post_samples, "fs_lin") } else { (wgpu::TextureFormat::Rgba8Unorm, SAMPLES, "fs") };
                    let cull = match side { 0 => Some(wgpu::Face::Back), 1 => Some(wgpu::Face::Front), _ => None };
                    let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                        label: Some("calib3d own"), layout: Some(&self.layout),
                        vertex: wgpu::VertexState { module: &self.own_module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[
                            Some(wgpu::VertexBufferLayout { array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex,
                                attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2] }),
                            // E6i step 4d: colour, tangent.
                            Some(wgpu::VertexBufferLayout { array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex,
                                attributes: &wgpu::vertex_attr_array![3 => Float32x4, 4 => Float32x4] }),
                        ] },
                        fragment: Some(wgpu::FragmentState { module: &self.own_module, entry_point: Some(fs), compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState {
                            format: fmt, write_mask: wgpu::ColorWrites::ALL,
                            // three's NormalBlending, premultipliedAlpha false: blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA).
                            blend: blend.then_some(wgpu::BlendState {
                                color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
                                alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
                            }) })] }),
                        primitive: wgpu::PrimitiveState { cull_mode: cull, front_face: wgpu::FrontFace::Cw, ..Default::default() },
                        depth_stencil: Some(wgpu::DepthStencilState { format: DEPTH_FMT, depth_write_enabled: Some(dw), depth_compare: Some(wgpu::CompareFunction::LessEqual), stencil: Default::default(), bias: Default::default() }),
                        multisample: wgpu::MultisampleState { count: samples, mask: !0, alpha_to_coverage_enabled: false },
                        multiview_mask: None, cache: None,
                    });
                    self.own_pipes.insert((side, posted, blend, dw), pipe);
                }
            }
        }
        let need = objs.len().max(OBJ_STRIDE as usize) as u64;
        if self.obj.as_ref().map_or(true, |o| o.0 < need) {
            let buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("calib3d obj"), size: need, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.obj_layout, entries: &[wgpu::BindGroupEntry {
                binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buf, offset: 0, size: wgpu::BufferSize::new(OBJ_SIZE) }) }] });
            self.obj = Some((need, buf, bind));
        }
        let (_, obj_buf, obj_bind) = self.obj.as_ref().unwrap();
        if !objs.is_empty() { gpu.queue.write_buffer(obj_buf, 0, &objs); }
        // The post pass's uniforms and what it reads (the linear picture at this size, the rig blend's grids).
        if let Some(pp) = post {
            let (dist, bl) = (pp.dist.unwrap_or([1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]), pp.blend.as_ref());
            let (soft, gamma, gain, lift, has_map) = match bl {
                Some(b) => (b.soft, b.gamma, b.gain, b.lift, if b.map.is_some() { 1.0 } else { 0.0 }),
                None => ([0.0; 4], 2.2, [1.0; 3], [0.0; 3], 0.0),
            };
            let u = [w as f32, h as f32, if pp.dist.is_some() { 1.0 } else { 0.0 }, if bl.is_some() { 1.0 } else { 0.0 },
                dist[0], dist[1], dist[2], dist[3], dist[4], dist[5], dist[6], 0.0, dist[7], dist[8], gamma, has_map,
                soft[0], soft[1], soft[2], soft[3], gain[0], gain[1], gain[2], 0.0, lift[0], lift[1], lift[2], 0.0];
            gpu.queue.write_buffer(&self.post_buf, 0, &f32s(&u));
            let key = (w, h, bl.and_then(|b| b.map.as_ref().map(|_| b.key)).unwrap_or(0));
            if self.post_bind.as_ref().map(|b| b.key) != Some(key) {
                let grid = |gw: u32, gh: u32, data: &[u8]| {
                    let t = d.create_texture(&wgpu::TextureDescriptor {
                        label: Some("calib3d blend grid"), size: wgpu::Extent3d { width: gw, height: gh, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::R8Unorm,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
                    // Tight rows, as three uploads a DataTexture (UNPACK_ALIGNMENT 1); write_texture takes any row pitch.
                    gpu.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        data, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(gw), rows_per_image: Some(gh) },
                        wgpu::Extent3d { width: gw, height: gh, depth_or_array_layers: 1 });
                    t
                };
                let (ta, tk) = match bl.and_then(|b| b.map.as_ref()) {
                    Some((gw, gh, a, k)) => (grid(*gw, *gh, a), grid(*gw, *gh, k)),
                    None => (grid(1, 1, &[255]), grid(1, 1, &[255])),   // WHITE_1X1
                };
                let (va, vk) = (ta.create_view(&Default::default()), tk.create_view(&Default::default()));
                let lin = self.targets.as_ref().unwrap().5.as_ref().unwrap();
                let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("calib3d post"), layout: &self.post_pipe.get_bind_group_layout(0), entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(lin) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&va) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&vk) },
                    wgpu::BindGroupEntry { binding: 4, resource: self.post_buf.as_entire_binding() },
                ] });
                self.post_bind = Some(PostBind { key, bind, _texs: vec![ta, tk] });
            }
        }
        // OCCLUSION: one depth map per projecting projector that occludes — EVERY venue mesh casts (projectorDepth's
        // casters are every visible model, a mesh without content of its own included), drawn every frame (the app's
        // pass is change-gated; a static venue's map is the same either way).
        let mut keys: Vec<[u32; 16]> = draws.iter().filter_map(|dr| dr.occl).collect();
        keys.sort(); keys.dedup();
        self.dmaps.retain(|k, _| keys.contains(k));
        for k in &keys {
            if self.dmaps.contains_key(k) { continue; }
            let mk = |format: wgpu::TextureFormat, usage: wgpu::TextureUsages| d.create_texture(&wgpu::TextureDescriptor {
                label: Some("calib3d depth map"), size: wgpu::Extent3d { width: DEPTH_SIZE, height: DEPTH_SIZE, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                dimension: wgpu::TextureDimension::D2, format, usage, view_formats: &[] }).create_view(&Default::default());
            let colour = mk(wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING);
            let zbuf = mk(DEPTH_FMT, wgpu::TextureUsages::RENDER_ATTACHMENT);
            let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.dmap_layout, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&colour) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.dsamp) },
            ] });
            self.dmaps.insert(*k, (colour, zbuf, bind));
        }
        let inv_far = (1.0f64 / DEPTH_FAR as f64) as f32;   // uInvFar: 1 / DEPTH_FAR in JS, then f32
        let mut du: Vec<u8> = Vec::new();
        for k in &keys {
            let vp: Vec<f32> = k.iter().map(|b| f32::from_bits(*b)).collect();
            for dr in &draws {
                let mut u = vp.clone(); u.extend_from_slice(&dr.world); u.extend_from_slice(&[inv_far, 0.0, 0.0, 0.0]);
                let mut b = f32s(&u); b.resize(OBJ_STRIDE as usize, 0); du.extend_from_slice(&b);
            }
        }
        if !du.is_empty() {
            let need = du.len() as u64;
            if self.depth_u.as_ref().map_or(true, |x| x.0 < need) {
                let buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("calib3d depth u"), size: need, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
                let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.depth_pipe.get_bind_group_layout(0), entries: &[wgpu::BindGroupEntry {
                    binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buf, offset: 0, size: wgpu::BufferSize::new(144) }) }] });
                self.depth_u = Some((need, buf, bind));
            }
            gpu.queue.write_buffer(&self.depth_u.as_ref().unwrap().1, 0, &du);
        }
        let (_, _, _, msaa, depth, lin) = self.targets.as_ref().unwrap();
        let resolve = if dimmed { &self.resolved.as_ref().unwrap().2 } else { target };
        // With the post pass the scene resolves into the linear picture, and the pass writes `resolve`.
        let scene_resolve = lin.as_ref().unwrap_or(resolve);
        let mut enc = d.create_command_encoder(&Default::default());
        // O2-4: the maps are a function of the projectors (their view-projections) and the casters (which mesh, where,
        // whether it has loaded) — NOT of the pictures. Drawn again only when that moves: a film on a calibrated venue
        // re-drew every map on every frame, in every presenter. (A map made new this pass always draws: its key is new.)
        let dk = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            keys.hash(&mut h);
            for dr in &draws {
                let ready = match (&dr.plane, &dr.glb) {
                    (Some(k), _) => self.planes.contains_key(k),
                    (_, Some((p, slot))) => matches!(self.glbs.get(p), Some(GlbState::Ready(m)) if m.get(*slot).is_some_and(|x| x.is_some())),
                    _ => false,
                };
                (&dr.plane, &dr.glb, dr.world.map(f32::to_bits), ready).hash(&mut h);
            }
            h.finish()
        };
        let draw_maps = dk != self.dmap_key;
        self.dmap_key = dk;
        for (m, k) in keys.iter().enumerate().filter(|_| draw_maps) {
            let (colour, zbuf, _) = &self.dmaps[k];
            // Cleared WHITE (beyond DEPTH_FAR — nothing in the way), depth 1; no background (beginPass nulls it).
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("calib3d depth map"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: colour, depth_slice: None, resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::WHITE), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: zbuf, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_pipeline(&self.depth_pipe);
            for (i, dr) in draws.iter().enumerate() {
                let mesh = match (&dr.plane, &dr.glb) {
                    (Some(k), _) => self.planes.get(k),
                    (_, Some((p, slot))) => match self.glbs.get(p) { Some(GlbState::Ready(m)) => m.get(*slot).and_then(|x| x.as_ref()), _ => None },
                    _ => None,
                };
                let Some(mesh) = mesh else { continue };
                pass.set_bind_group(0, &self.depth_u.as_ref().unwrap().2, &[((m * draws.len() + i) as u64 * OBJ_STRIDE) as u32]);
                pass.set_vertex_buffer(0, mesh.vb.slice(..));
                pass.set_index_buffer(mesh.ib.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..mesh.n, 0, 0..1);
            }
        }
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("calib3d"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: msaa, depth_slice: None, resolve_target: Some(scene_resolve),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Discard } })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_bind_group(0, &self.cam_bind, &[]);
            // E6i step 4b — three's render lists: every opaque object first (in its order here), then the TRANSPARENT
            // ones far to near (reversePainterSortStable: z = the bounding-sphere centre through the projection-view,
            // larger first; ties in creation order). A double-sided one's two passes stay together, BackSide first.
            let mut order: Vec<usize> = (0..draws.len()).filter(|&i| !draws[i].own.as_ref().is_some_and(|o| o.blend)).collect();
            let mut glass: Vec<usize> = (0..draws.len()).filter(|&i| draws[i].own.as_ref().is_some_and(|o| o.blend)).collect();
            glass.sort_by(|&a, &b| draws[b].own.as_ref().unwrap().z.total_cmp(&draws[a].own.as_ref().unwrap().z));
            order.extend(glass);
            for i in order {
                let dr = &draws[i];
                if let Some(od) = &dr.own {
                    let mesh = match &dr.glb { Some((p, slot)) => match self.glbs.get(p) { Some(GlbState::Ready(m)) => m.get(*slot).and_then(|x| x.as_ref()), _ => None }, None => None };
                    let Some(mesh) = mesh else { continue };
                    let Some(maps) = self.own_binds.get(&od.maps) else { continue };
                    pass.set_pipeline(&self.own_pipes[&(od.side, posted, od.blend, od.depth_write)]);
                    pass.set_bind_group(1, obj_bind, &[(i as u64 * OBJ_STRIDE) as u32]);
                    pass.set_bind_group(2, maps, &[]);
                    pass.set_bind_group(3, &self.far_bind, &[]);
                    let Some(ex) = &mesh.ex else { continue };
                    pass.set_vertex_buffer(0, mesh.vb.slice(..));
                    pass.set_vertex_buffer(1, ex.slice(..));
                    pass.set_index_buffer(mesh.ib.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..mesh.n, 0, 0..1);
                    continue;
                }
                let Some((_, tb, _)) = self.texs.get(&dr.sid) else { continue };
                let mesh = match (&dr.plane, &dr.glb) {
                    (Some(k), _) => self.planes.get(k),
                    (_, Some((p, slot))) => match self.glbs.get(p) { Some(GlbState::Ready(m)) => m.get(*slot).and_then(|x| x.as_ref()), _ => None },
                    _ => None,
                };
                let Some(mesh) = mesh else { continue };
                pass.set_pipeline(match (posted, dr.front) { (false, true) => &self.pipe_front, (false, false) => &self.pipe_double, (true, true) => &self.lin_front, (true, false) => &self.lin_double });
                pass.set_bind_group(1, obj_bind, &[(i as u64 * OBJ_STRIDE) as u32]);
                pass.set_bind_group(2, tb, &[]);
                pass.set_bind_group(3, dr.occl.as_ref().map_or(&self.far_bind, |k| &self.dmaps[k].2), &[]);
                pass.set_vertex_buffer(0, mesh.vb.slice(..));
                pass.set_index_buffer(mesh.ib.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..mesh.n, 0, 0..1);
            }
        }
        if let Some(pb) = self.post_bind.as_ref().filter(|_| posted) {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("calib3d post"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: resolve, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&self.post_pipe);
            pass.set_bind_group(0, &pb.bind, &[]);
            pass.draw(0..3, 0..1);
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
        assert!(!p.models[1].src[0].proj.as_ref().unwrap().occlude);
        assert!(p.post.is_none());
    }
    #[test]
    fn parses_the_post_pass() {
        let id: Vec<f64> = vec![1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
        let v = serde_json::json!({ "proj": id, "models": [], "post": {
            "dist": [1800, 1800, 960, 540, -0.18, 0.07, 0.01, 0.0015, -0.002],
            "blend": { "soft": [0.1, 0, 0, 0.05], "gamma": 2.2, "gain": [1, 0.9, 0.8], "lift": [0, 0, 0.01], "map": { "w": 2, "h": 1, "alpha": [255, 128], "black": [0, 255] } } } });
        let p = View::parse(&v).unwrap().post.unwrap();
        assert_eq!(p.dist.unwrap()[6], 0.01f32);
        let b = p.blend.unwrap();
        assert_eq!(b.map.as_ref().unwrap().2, vec![255u8, 128]);
        // A grid of the wrong size is no grid (BlendEffect would read past it).
        let bad = serde_json::json!({ "proj": id, "models": [], "post": { "dist": null, "blend": { "soft": [0, 0, 0, 0], "gamma": 2.2, "gain": [1, 1, 1], "lift": [0, 0, 0], "map": { "w": 3, "h": 1, "alpha": [1], "black": [1] } } } });
        assert!(View::parse(&bad).unwrap().post.unwrap().blend.unwrap().map.is_none());
    }
}
