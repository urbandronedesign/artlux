//! E4a — THE 3D VIEW, DRAWN BY THE ENGINE, IN ITS OWN WINDOW (plans/native-engine.md §5 + E4;
//! plans/3d-workbench.md Phase 4 — owner, 2026-11-24: "start E4's 3D now").
//!
//! The editor's 3D view is r3f inside the editor window, and a GPU viewport cannot leave that window
//! (native-engine.md §9a: another process would duplicate the scene and every upload; a same-process
//! window still shares one main thread). The engine has neither problem: it already holds every
//! surface's picture (runtime.rs composes them for the LEDs and the projectors) and the LED colours (the
//! composed buffer the packer reads). So the detached 3D view is an ENGINE window — any screen, its own
//! swapchain at that display's refresh, moving it rebuilds nothing.
//!
//! WHAT IT DRAWS (this first step): the venue models (glTF, the same files the editor loads, placed by
//! the world matrices the editor computed — so the recentre and every transform match by construction),
//! the screens with their LIVE pictures, every pixel fixture's LEDs in their LIVE colours, light fixtures
//! as housings, and the floor grid with the world axes. Orbit / pan / zoom with the mouse, in the window.
//! E4b: every lit head's BEAM (beams.rs: the volume and the cone diagram, Shaded or Rendered) from the light
//! states the engine resolves itself. WHAT IT DOES NOT DRAW YET: labels, gizmos and picking (E4b…).
//!
//! THE SPLIT, as everywhere in the engine: the HOST describes (the scene message — what is where, from
//! the editor's own three.js scene, so nothing here re-derives a transform), the RENDER THREAD publishes
//! the live state (pictures, LED colours) into `Shared`, and one PRESENTER thread per open view draws it.
//! The windows thread (outputs.rs) owns the window and feeds mouse input into the camera here.

use crate::compose::Picture;
use crate::Gpu;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use winit::dpi::PhysicalSize;
use winit::window::Window;

// ── The scene, as the host describes it ─────────────────────────────────────────────────────────────

pub enum ModelKind {
    /// A glTF / GLB file, drawn with its own node hierarchy under `matrix` (the editor's recentred root).
    Glb(String),
    /// A screen: a w × h quad in its local XY plane, facing +Z, showing `surface`'s picture.
    Plane { surface: Option<String>, w: f32, h: f32 },
}
pub struct Model { pub id: String, pub kind: ModelKind, pub matrix: [f32; 16], pub content: Option<Content> }
/// One pixel fixture: its LED world positions, in the same order as its texels in the composed buffer.
pub struct LedFix { pub id: String, pub pos: Vec<f32> }
pub struct Scene { pub models: Vec<Model>, pub leds: Vec<LedFix>, pub lights: Vec<LightFix>, pub lines: Vec<f32>, pub look: BeamLook, pub grid: GridLook,
    /// E4b: the editor's move gizmo, when it shows one (a selection, the Move tool) — gizmo.rs.
    pub gizmo: Option<crate::gizmo::Gizmo>,
    /// E4b: the venue model / screen selected in the editor (its bounds are outlined here).
    pub selected_model: Option<String> }
/// The editor's grid toggles (scene3D.gridVisible / gridLabels): the floor grid with its axes, and its numbers.
#[derive(Clone, Copy)]
pub struct GridLook { pub visible: bool, pub labels: bool }
impl Default for GridLook { fn default() -> Self { GridLook { visible: true, labels: true } } }
/// E4b: one light fixture — its housing, and (when its profile resolves) its beam's FIXED half, as the editor
/// computed it (engineView.tsx; Beams.tsx's maths): the lens apex in world space, the fixture's base rotation
/// (a quaternion, x y z w), the pan / tilt mid-points and the lens half-angle, in degrees. The MOVING half is
/// resolved by the engine every tick (`Shared::beams`).
pub struct LightFix { pub id: String, pub pos: [f32; 3], pub beam: Option<BeamFix> }
#[derive(Clone, Copy)]
pub struct BeamFix { pub apex: [f32; 3], pub q: [f32; 4], pub pan_mid: f32, pub tilt_mid: f32, pub lens_half: f32 }
/// How the beams look — what Simulator3D hands its Beams: room haze, the cone diagram, the Rendered look, and
/// the heads being aimed (they get the whole diagram: axis and edge rays).
#[derive(Clone)]
pub struct BeamLook { pub haze: f32, pub cones: bool, pub rendered: bool, pub selected: std::collections::HashSet<String>,
    /// The heads' spotlights' gain (Simulator3D lightGain; 0 = the venue is not lit by the rig).
    pub light_gain: f32 }
impl Default for BeamLook { fn default() -> Self { BeamLook { haze: 0.35, cones: true, rendered: false, selected: Default::default(), light_gain: 0.0 } } }

/// E4a+: WHAT A VENUE GLB WEARS, as the editor decided it (engineView.tsx `engineContent`, which reads
/// the same precedence modelScreens.assignContentMaterials applies): a list of content sources, and for
/// every MESH of the file — in three.js's traversal order, which is the glTF (node, triangle primitive)
/// order `load_glb` walks — the source it shows, or -1 for the file's own material. Mesh ORDER rather
/// than names: three sanitises and de-duplicates node names on load, so a name match would silently miss
/// exactly the `Screen.001`-style names Blender produces; the order is the one thing both loaders share.
pub struct Content { pub src: Vec<Src>, pub mesh: Vec<i32> }
/// A content source: a surface's live picture (None = one the engine cannot draw, e.g. a timeline layer —
/// shown dark, as the editor shows a binding with no frame), through the mesh's own UVs or PROJECTED from
/// a projector's view-projection (three / GL clip space, z in −1…1).
pub struct Src { pub surface: Option<String>, pub proj: Option<Proj> }
pub struct Proj { pub view: [f32; 16], pub eye: [f32; 3], pub soft: f32, pub cull: bool, pub occlude: bool, pub bias: f32 }

impl Scene {
    pub fn parse(v: &serde_json::Value) -> Scene {
        let m16 = |a: &serde_json::Value| -> [f32; 16] {
            let mut m = IDENT;
            if let Some(x) = a.as_array() { for (i, e) in x.iter().take(16).enumerate() { m[i] = e.as_f64().unwrap_or(0.0) as f32; } }
            m
        };
        let models = v["models"].as_array().into_iter().flatten().filter_map(|m| {
            let kind = match m["kind"].as_str()? {
                "glb" => ModelKind::Glb(m["path"].as_str()?.to_string()),
                "plane" => ModelKind::Plane {
                    surface: m["surfaceId"].as_str().map(str::to_string),
                    w: m["w"].as_f64().unwrap_or(16.0 / 9.0) as f32, h: m["h"].as_f64().unwrap_or(1.0) as f32,
                },
                _ => return None,
            };
            let content = m["content"].as_object().map(|c| Content {
                src: c.get("src").and_then(|s| s.as_array()).into_iter().flatten().map(|s| Src {
                    surface: s["surface"].as_str().map(str::to_string),
                    proj: s["proj"].as_object().map(|p| Proj {
                        view: m16(&p["view"]),
                        eye: { let a = p.get("eye").and_then(|e| e.as_array()); let g = |i: usize| a.and_then(|a| a.get(i)).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32; [g(0), g(1), g(2)] },
                        soft: p.get("soft").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
                        cull: p.get("cull").and_then(|x| x.as_bool()).unwrap_or(false),
                        occlude: p.get("occlude").and_then(|x| x.as_bool()).unwrap_or(true),
                        bias: p.get("bias").and_then(|x| x.as_f64()).unwrap_or(0.02) as f32,
                    }),
                }).collect(),
                mesh: c.get("mesh").and_then(|s| s.as_array()).into_iter().flatten().map(|x| x.as_i64().unwrap_or(-1) as i32).collect(),
            });
            Some(Model { id: m["id"].as_str().unwrap_or("").to_string(), kind, matrix: m16(&m["matrix"]), content })
        }).collect();
        // Overlay lines (the projector frustums): x y z r g b per vertex, pairs, colours LINEAR.
        let lines = v["lines"].as_array().into_iter().flatten().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
        let leds = v["leds"].as_array().into_iter().flatten().map(|f| LedFix {
            id: f["id"].as_str().unwrap_or("").to_string(),
            pos: f["pos"].as_array().into_iter().flatten().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect(),
        }).collect();
        let v3 = |a: &serde_json::Value| -> Option<[f32; 3]> { let a = a.as_array()?; Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32]) };
        let lights = v["lights"].as_array().into_iter().flatten().filter_map(|l| {
            // E4a sent a bare position; E4b an object.
            if let Some(p) = v3(l) { return Some(LightFix { id: String::new(), pos: p, beam: None }); }
            let beam = (|| {
                let q = l["q"].as_array()?;
                let g = |i: usize| q.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
                Some(BeamFix { apex: v3(&l["apex"])?, q: [g(0), g(1), g(2), g(3)],
                    pan_mid: l["panMid"].as_f64().unwrap_or(0.0) as f32, tilt_mid: l["tiltMid"].as_f64().unwrap_or(0.0) as f32,
                    lens_half: l["lensHalf"].as_f64().unwrap_or(7.0) as f32 })
            })();
            Some(LightFix { id: l["id"].as_str().unwrap_or("").to_string(), pos: v3(&l["pos"])?, beam })
        }).collect();
        let b = &v["beams"];
        let look = BeamLook {
            haze: b["haze"].as_f64().unwrap_or(0.35) as f32,
            light_gain: b["lightGain"].as_f64().unwrap_or(0.0) as f32,
            cones: b["cones"].as_bool().unwrap_or(true),
            rendered: b["rendered"].as_bool().unwrap_or(false),
            selected: b["selected"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        };
        let g = &v["grid"];
        let grid = GridLook { visible: g["visible"].as_bool().unwrap_or(true), labels: g["labels"].as_bool().unwrap_or(true) };
        let gizmo = crate::gizmo::Gizmo::from_json(&v["gizmo"]);
        let selected_model = v["selectedModel"].as_str().map(str::to_string);
        Scene { models, leds, lights, lines, look, grid, gizmo, selected_model }
    }
}

// ── The camera: an orbit around a target, driven by the window's mouse ────────────────────────────────

#[derive(Clone, Copy)]
pub struct Cam { pub target: [f32; 3], pub yaw: f32, pub pitch: f32, pub dist: f32, pub fov: f32 }
impl Default for Cam { fn default() -> Self { Cam { target: [0.0, 1.0, 0.0], yaw: 0.6, pitch: 0.35, dist: 12.0, fov: 50.0 } } }
impl Cam {
    /// From the editor's camera: where it stands, what it looks at, its vertical field of view (degrees).
    pub fn from_pose(eye: [f32; 3], target: [f32; 3], fov: f32) -> Cam {
        let d = sub(eye, target);
        let dist = len(d).max(0.05);
        Cam { target, yaw: d[0].atan2(d[2]), pitch: (d[1] / dist).clamp(-1.0, 1.0).asin(), dist, fov: if fov > 1.0 { fov } else { 50.0 } }
    }
    pub fn eye(&self) -> [f32; 3] {
        let (cp, sp) = (self.pitch.cos(), self.pitch.sin());
        add(self.target, [self.dist * cp * self.yaw.sin(), self.dist * sp, self.dist * cp * self.yaw.cos()])
    }
    /// Left-drag: turn about the target (pixels → radians), pitch kept off the poles.
    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.yaw -= dx * 0.006;
        self.pitch = (self.pitch + dy * 0.006).clamp(-1.53, 1.53);
    }
    /// Right / middle drag: slide the target in the view plane, scaled so the point under the cursor
    /// follows it at the target's depth.
    pub fn pan(&mut self, dx: f32, dy: f32, height_px: f32) {
        let per_px = 2.0 * self.dist * (self.fov.to_radians() / 2.0).tan() / height_px.max(1.0);
        let (right, up) = self.basis();
        self.target = add(self.target, add(scale(right, -dx * per_px), scale(up, dy * per_px)));
    }
    /// Wheel: dolly toward the target, multiplicatively (each notch the same fraction at any distance).
    pub fn zoom(&mut self, notches: f32) { self.dist = (self.dist * 0.88f32.powf(notches)).clamp(0.05, 5000.0); }
    /// E4b: the ray under a window pixel (x, y from the top-left, in a w × h window): origin, unit direction.
    pub fn ray(&self, x: f32, y: f32, w: f32, h: f32) -> ([f32; 3], [f32; 3]) {
        let eye = self.eye();
        let f = norm(sub(self.target, eye));
        let (right, up) = self.basis();
        let t = (self.fov.to_radians() / 2.0).tan();
        let nx = (2.0 * x / w.max(1.0) - 1.0) * t * (w / h.max(1.0));
        let ny = (1.0 - 2.0 * y / h.max(1.0)) * t;
        (eye, norm(add(f, add(scale(right, nx), scale(up, ny)))))
    }
    fn basis(&self) -> ([f32; 3], [f32; 3]) {
        let f = norm(sub(self.target, self.eye()));
        let right = norm(cross(f, [0.0, 1.0, 0.0]));
        (right, cross(right, f))
    }
}

// ── The window's place (E4b) ────────────────────────────────────────────────────────────────────────
//
// The operator puts the 3D view on a screen and sizes it; the next open (this session, after an engine restart,
// or the next day) puts it back. In the ENGINE's own physical pixels end to end — main stores the blob and never
// reads it — because Electron speaks DIPs and winit physical pixels, and converting between them on a mixed-DPI
// rig is exactly the bug that would land a window half off a screen. The engine checks a saved place against the
// monitors that exist NOW (`on_screen`), so an unplugged screen means the default place, never an invisible window.

/// Outer position and inner size in physical pixels, and whether it was maximised (then x / y / w / h are the
/// place it had before, which is where it goes when un-maximised).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Place { pub x: i32, pub y: i32, pub w: u32, pub h: u32, pub max: bool }
impl Place {
    pub fn from_json(v: &serde_json::Value) -> Option<Place> {
        let i = |k: &str| v[k].as_f64().filter(|x| x.is_finite());
        let (w, h) = (i("w")?, i("h")?);
        if w < 200.0 || h < 150.0 { return None; }
        Some(Place { x: i("x")? as i32, y: i("y")? as i32, w: w as u32, h: h as u32, max: v["max"].as_bool().unwrap_or(false) })
    }
    pub fn to_json(&self) -> String {
        format!(r#"{{"x":{},"y":{},"w":{},"h":{},"max":{}}}"#, self.x, self.y, self.w, self.h, self.max)
    }
    /// Is enough of it on one of these monitors (x, y, w, h) to grab? Its title strip — the top 40 px of its
    /// middle half — must lie on a screen, or the operator could not move it back.
    pub fn on_screen(&self, monitors: &[(i32, i32, u32, u32)]) -> bool {
        let (cx0, cx1, ty) = (self.x + self.w as i32 / 4, self.x + 3 * self.w as i32 / 4, self.y + 20);
        monitors.iter().any(|&(mx, my, mw, mh)| {
            let (mx1, my1) = (mx + mw as i32, my + mh as i32);
            ty >= my && ty < my1 && cx1 > mx && cx0 < mx1
        })
    }
}

/// The view-projection (WebGPU clip), the unit look direction and the unit screen-up, for an aspect — what the
/// presenter draws with and the floor numbers lay themselves out against.
pub fn camera_frame(cam: &Cam, aspect: f32) -> ([f32; 16], [f32; 3], [f32; 3]) {
    let eye = cam.eye();
    let vp = mul(&perspective(cam.fov, aspect, 0.03, 4000.0), &look_at(eye, cam.target));
    let (_, up) = cam.basis();
    (vp, norm(sub(cam.target, eye)), up)
}

// ── Picking (E4b) ───────────────────────────────────────────────────────────────────────────────────
//
// A click in the engine window SELECTS IN THE EDITOR: the engine finds the fixture under the cursor and tells
// main, which hands it to the editor's own selection (so the inspector, the channel strip, the beams' full
// diagram and this window's highlight all follow from the one selection the editor owns). A ray, not a GPU id
// buffer: a pick happens on a click, never per frame, and a rig is tens to hundreds of fixtures — the ray is
// microseconds and needs no extra pass. As in the editor (CLAUDE.md "a fixture in 3D is picked by its BODY"),
// what is hit is the fixture's BODY, not a 12 mm LED: a light's housing box, a pixel fixture's whole strip — a
// generous tube along its LED line, at least a few pixels wide however far away it is.

/// Distance along the ray to an axis-aligned box (centre c, half-size e), if it is hit in front of the eye.
fn ray_box(o: [f32; 3], d: [f32; 3], c: [f32; 3], e: f32) -> Option<f32> {
    let (mut t0, mut t1) = (f32::NEG_INFINITY, f32::INFINITY);
    for i in 0..3 {
        let (lo, hi) = (c[i] - e - o[i], c[i] + e - o[i]);
        if d[i].abs() < 1e-9 { if lo > 0.0 || hi < 0.0 { return None; } continue; }
        let (a, b) = (lo / d[i], hi / d[i]);
        t0 = t0.max(a.min(b)); t1 = t1.min(a.max(b));
    }
    (t1 >= t0.max(0.0)).then_some(t0.max(0.0))
}
/// The ray's closest approach to segment a–b: (distance along the ray, gap between them).
fn ray_segment(o: [f32; 3], d: [f32; 3], a: [f32; 3], b: [f32; 3]) -> (f32, f32) {
    // d is a unit vector. The unclamped closest points, then the segment parameter clamped to [0, 1] and the
    // ray parameter re-solved for that point (≥ 0: behind the eye is not a hit).
    let u = sub(b, a);
    let cc = dot(u, u);
    let w0 = sub(o, a);
    let (bb, dd, ee) = (dot(d, u), dot(d, w0), dot(u, w0));
    let den = cc - bb * bb;
    let v = if cc < 1e-12 { 0.0 } else if den.abs() < 1e-9 { (ee / cc).clamp(0.0, 1.0) } else { ((ee - bb * dd) / den).clamp(0.0, 1.0) };
    let q = add(a, scale(u, v));
    let s = dot(sub(q, o), d).max(0.0);
    let p = add(o, scale(d, s));
    (s, len(sub(p, q)))
}

/// One primitive of a venue file, for picking: its node matrix and triangles (positions, indices).
pub struct PickPrim { pub local: [f32; 16], pub pos: Vec<[f32; 3]>, pub idx: Vec<u32> }

/// What a click landed on.
#[derive(Debug, PartialEq)]
pub enum Picked { Fixture(String), Model(String) }

fn xform(m: &[f32; 16], p: [f32; 3]) -> [f32; 3] {
    [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
}
/// Möller–Trumbore: distance along the ray to the triangle, either face.
fn ray_tri(o: [f32; 3], d: [f32; 3], a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> Option<f32> {
    let (e1, e2) = (sub(b, a), sub(c, a));
    let p = cross(d, e2);
    let det = dot(e1, p);
    if det.abs() < 1e-12 { return None; }
    let inv = 1.0 / det;
    let s = sub(o, a);
    let u = dot(s, p) * inv;
    if !(0.0..=1.0).contains(&u) { return None; }
    let q = cross(s, e1);
    let v = dot(d, q) * inv;
    if v < 0.0 || u + v > 1.0 { return None; }
    let t = dot(e2, q) * inv;
    (t > 1e-4).then_some(t)
}
/// The world corners of a screen quad (w × h in its local XY).
fn plane_corners(m: &[f32; 16], w: f32, h: f32) -> [[f32; 3]; 4] {
    [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(|[x, y]| xform(m, [x * w, y * h, 0.0]))
}

/// What the click landed on: a FIXTURE wherever its body is in the ray (the editor's pick priority — a screen is
/// big and nearly always in front of the LEDs mounted on it, so a model YIELDS to any fixture under the cursor:
/// pickPriority.ts), otherwise the NEAREST venue model or screen triangle.
pub fn pick_any(sc: &Scene, meshes: &HashMap<String, Arc<Vec<PickPrim>>>, o: [f32; 3], d: [f32; 3], px: f32) -> Option<Picked> {
    if let Some(f) = pick(sc, o, d, px) { return Some(Picked::Fixture(f)); }
    let consider = |t: f32, id: &str, best: &mut Option<(f32, String)>| { if best.as_ref().is_none_or(|b| t < b.0) { *best = Some((t, id.to_string())); } };
    let mut found: Option<(f32, String)> = None;
    for m in &sc.models {
        match &m.kind {
            ModelKind::Plane { w, h, .. } => {
                let c = plane_corners(&m.matrix, *w, *h);
                for t in [ray_tri(o, d, c[0], c[1], c[2]), ray_tri(o, d, c[0], c[2], c[3])].into_iter().flatten() { consider(t, &m.id, &mut found); }
            }
            ModelKind::Glb(path) => if let Some(prims) = meshes.get(path) {
                for p in prims.iter() {
                    let world = mul(&m.matrix, &p.local);
                    let wp: Vec<[f32; 3]> = p.pos.iter().map(|v| xform(&world, *v)).collect();
                    for tri in p.idx.chunks_exact(3) {
                        let (a, b, c) = (wp[tri[0] as usize], wp[tri[1] as usize], wp[tri[2] as usize]);
                        if let Some(t) = ray_tri(o, d, a, b, c) { consider(t, &m.id, &mut found); }
                    }
                }
            },
        }
    }
    found.map(|(_, id)| Picked::Model(id))
}

/// A model's world bounds (min, max) — its outline when selected.
pub fn model_bounds(m: &Model, meshes: &HashMap<String, Arc<Vec<PickPrim>>>) -> Option<([f32; 3], [f32; 3])> {
    let mut lo = [f32::INFINITY; 3];
    let mut hi = [f32::NEG_INFINITY; 3];
    let mut add_pt = |p: [f32; 3]| for i in 0..3 { lo[i] = lo[i].min(p[i]); hi[i] = hi[i].max(p[i]); };
    match &m.kind {
        ModelKind::Plane { w, h, .. } => for c in plane_corners(&m.matrix, *w, *h) { add_pt(c); },
        ModelKind::Glb(path) => {
            for p in meshes.get(path)?.iter() {
                let world = mul(&m.matrix, &p.local);
                for v in &p.pos { add_pt(xform(&world, *v)); }
            }
        }
    }
    lo[0].is_finite().then_some((lo, hi))
}

/// The fixture under the cursor: the NEAREST body the ray meets. `px` is world units per pixel at 1 m (the
/// presenter's own figure), so a strip stays pickable — HALF_PX pixels either side — however far away it is.
pub fn pick(sc: &Scene, o: [f32; 3], d: [f32; 3], px: f32) -> Option<String> {
    const HOUSING: f32 = 0.15;     // the drawn housing is a 0.3 m box
    const STRIP: f32 = 0.03;       // a strip's body: 3 cm either side of its LED line…
    const HALF_PX: f32 = 6.0;      // …or six pixels, whichever is wider at that distance
    let mut best: Option<(f32, &str)> = None;
    for l in &sc.lights {
        if l.id.is_empty() { continue; }
        if let Some(t) = ray_box(o, d, l.pos, HOUSING) { if best.is_none_or(|b| t < b.0) { best = Some((t, &l.id)); } }
    }
    for f in &sc.leds {
        let pts: Vec<[f32; 3]> = f.pos.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
        let segs: Vec<([f32; 3], [f32; 3])> = if pts.len() == 1 { vec![(pts[0], pts[0])] } else { pts.windows(2).map(|w| (w[0], w[1])).collect() };
        for (a, b) in segs {
            let (t, gap) = ray_segment(o, d, a, b);
            if gap <= STRIP.max(t * px * HALF_PX) && best.is_none_or(|bb| t < bb.0) { best = Some((t, &f.id)); }
        }
    }
    best.map(|(_, id)| id.to_string())
}

// ── What the render thread publishes and the presenter reads ─────────────────────────────────────────

#[derive(Default)]
pub struct Shared {
    /// The scene, with a version (a new message replaces it).
    pub scene: Option<(u64, Arc<Scene>)>,
    /// The composed LED buffer (RGBA per LED, document order), its generation, and each pixel fixture's
    /// first LED in it — the same offsets the packer walks (pack.rs).
    pub colors: Option<(u64, Arc<Vec<u8>>, Arc<HashMap<String, usize>>)>,
    /// surface id → (generation, picture), for the screens.
    pub pictures: HashMap<String, (u64, Arc<Picture>)>,
    /// E4b: what every light is doing this tick (lightpack Head::resolve), by fixture id.
    pub beams: Arc<HashMap<String, crate::lightpack::Beam>>,
    /// O2-5: bumped when `beams` is replaced with something different — the presenter's change key reads it.
    pub beams_gen: u64,
    pub cam: Cam,
    /// Bumped when the camera is set from OUTSIDE the window (the host's "open here"), not by its mouse.
    pub cam_set: u64,
    /// E4b: where the operator last had the window, as main saved it (machine prefs) — None: the default.
    pub place: Option<Place>,
    /// E4b: the gizmo handle under the cursor (drawn hot), and the drag in progress (its offset drawn here).
    pub hover_axis: Option<usize>,
    /// E4b: every loaded venue file's triangles (CPU), for picking a model with a click — published by the
    /// presenter when it loads a file, keyed by its path.
    pub meshes: HashMap<String, Arc<Vec<PickPrim>>>,
    pub drag: Option<crate::gizmo::Drag>,
}

// ── Math (column-major, three.js / WGSL order) ──────────────────────────────────────────────────────

const IDENT: [f32; 16] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn scale(a: [f32; 3], s: f32) -> [f32; 3] { [a[0] * s, a[1] * s, a[2] * s] }
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn len(a: [f32; 3]) -> f32 { dot(a, a).sqrt() }
fn norm(a: [f32; 3]) -> [f32; 3] { let l = len(a); if l > 1e-9 { scale(a, 1.0 / l) } else { [0.0, 0.0, 1.0] } }
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
pub fn mul(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut r = [0f32; 16];
    for c in 0..4 { for rr in 0..4 { r[c * 4 + rr] = (0..4).map(|k| a[k * 4 + rr] * b[c * 4 + k]).sum(); } }
    r
}
fn look_at(eye: [f32; 3], target: [f32; 3]) -> [f32; 16] {
    let f = norm(sub(target, eye));
    let mut up = [0.0, 1.0, 0.0];
    if dot(f, up).abs() > 0.999 { up = [0.0, 0.0, -1.0]; }
    let s = norm(cross(f, up));
    let u = cross(s, f);
    [s[0], u[0], -f[0], 0., s[1], u[1], -f[1], 0., s[2], u[2], -f[2], 0., -dot(s, eye), -dot(u, eye), dot(f, eye), 1.]
}
/// WebGPU clip space: z in [0, 1].
fn perspective(fov_y_deg: f32, aspect: f32, near: f32, far: f32) -> [f32; 16] {
    let f = 1.0 / (fov_y_deg.to_radians() / 2.0).tan();
    let nf = 1.0 / (near - far);
    [f / aspect, 0., 0., 0., 0., f, 0., 0., 0., 0., far * nf, -1., 0., 0., near * far * nf, 0.]
}
/// The normal matrix (inverse-transpose of the upper 3×3), as a 4×4 for the uniform.
fn normal_matrix(m: &[f32; 16]) -> [f32; 16] {
    let a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    let det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[3] * (a[1] * a[8] - a[2] * a[7]) + a[6] * (a[1] * a[5] - a[2] * a[4]);
    if det.abs() < 1e-12 { return IDENT; }
    let i = 1.0 / det;
    // inverse (column-major), then transposed
    let inv = [
        (a[4] * a[8] - a[5] * a[7]) * i, (a[2] * a[7] - a[1] * a[8]) * i, (a[1] * a[5] - a[2] * a[4]) * i,
        (a[5] * a[6] - a[3] * a[8]) * i, (a[0] * a[8] - a[2] * a[6]) * i, (a[2] * a[3] - a[0] * a[5]) * i,
        (a[3] * a[7] - a[4] * a[6]) * i, (a[1] * a[6] - a[0] * a[7]) * i, (a[0] * a[4] - a[1] * a[3]) * i,
    ];
    [inv[0], inv[3], inv[6], 0., inv[1], inv[4], inv[7], 0., inv[2], inv[5], inv[8], 0., 0., 0., 0., 1.]
}
fn bytes(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

// ── glTF, loaded off the presenter thread ───────────────────────────────────────────────────────────

/// `slot`: this primitive's index among the file's three.js MESHES (see `Content`).
/// `maps` (E6i step 4): the images of its base-colour, emissive, metallic-roughness, occlusion and normal textures.
/// `extra` (E6i step 4d): per vertex, COLOR_0 (RGBA, linear, normalised as the GPU normalises it; white where the file
/// has none) then TANGENT (xyzw; (1, 0, 0, 1) where none) — 8 floats a vertex.
pub(crate) struct CpuPrim { pub(crate) local: [f32; 16], pub(crate) verts: Vec<f32>, pub(crate) idx: Vec<u32>, pub(crate) color: [f32; 4], pub(crate) image: Option<usize>, pub(crate) unlit: bool, pub(crate) slot: usize, pub(crate) maps: [Option<usize>; 5], pub(crate) extra: Vec<f32> }
pub(crate) struct CpuGlb { pub(crate) prims: Vec<CpuPrim>, pub(crate) images: Vec<(u32, u32, Vec<u8>)> }

fn node_matrix(n: &gltf::Node) -> [f32; 16] {
    let m = n.transform().matrix();
    let mut r = [0f32; 16];
    for c in 0..4 { for rr in 0..4 { r[c * 4 + rr] = m[c][rr]; } }
    r
}

pub(crate) fn load_glb(path: &str) -> Result<CpuGlb, String> {
    let (doc, buffers, images) = gltf::import(path).map_err(|e| format!("{path}: {e}"))?;
    let mut prims = Vec::new();
    let scene = doc.default_scene().or_else(|| doc.scenes().next()).ok_or("no scene")?;
    // Three.js's GLTFLoader turns every TRIANGLES / STRIP / FAN primitive into one Mesh (points and lines
    // become Points / Line objects, which are not meshes), node by node, a node's own primitives before
    // its children — which is what three's pre-order traverse then visits. `slots` counts exactly those,
    // so `CpuPrim::slot` is the index the host's `Content::mesh` is written against.
    fn walk(n: gltf::Node, parent: [f32; 16], buffers: &[gltf::buffer::Data], out: &mut Vec<CpuPrim>, slots: &mut usize) {
        use gltf::mesh::Mode;
        let world = mul(&parent, &node_matrix(&n));
        if let Some(mesh) = n.mesh() {
            for p in mesh.primitives() {
                let mode = p.mode();
                if !matches!(mode, Mode::Triangles | Mode::TriangleStrip | Mode::TriangleFan) { continue; }
                let slot = *slots;
                *slots += 1;
                let r = p.reader(|b| Some(&buffers[b.index()]));
                let Some(pos) = r.read_positions() else { continue };
                let pos: Vec<[f32; 3]> = pos.collect();
                let raw: Vec<u32> = match r.read_indices() { Some(i) => i.into_u32().collect(), None => (0..pos.len() as u32).collect() };
                // Strips and fans, as plain triangles (winding is irrelevant: nothing here culls).
                let idx: Vec<u32> = match mode {
                    Mode::TriangleStrip => raw.windows(3).flat_map(|w| [w[0], w[1], w[2]]).collect(),
                    Mode::TriangleFan => (1..raw.len().saturating_sub(1)).flat_map(|i| [raw[0], raw[i], raw[i + 1]]).collect(),
                    _ => raw,
                };
                let nrm: Vec<[f32; 3]> = match r.read_normals() {
                    Some(n) => n.collect(),
                    None => {
                        // Smooth normals from the faces (a GLB without normals is rare; flat would need
                        // un-indexing every vertex).
                        let mut acc = vec![[0f32; 3]; pos.len()];
                        for t in idx.chunks_exact(3) {
                            let (a, b, c) = (pos[t[0] as usize], pos[t[1] as usize], pos[t[2] as usize]);
                            let fnrm = cross(sub(b, a), sub(c, a));
                            for &k in t { acc[k as usize] = add(acc[k as usize], fnrm); }
                        }
                        acc.into_iter().map(norm).collect()
                    }
                };
                let uv: Vec<[f32; 2]> = r.read_tex_coords(0).map(|t| t.into_f32().collect()).unwrap_or_else(|| vec![[0.0, 0.0]; pos.len()]);
                let mut verts = Vec::with_capacity(pos.len() * 8);
                for i in 0..pos.len() {
                    let n = nrm.get(i).copied().unwrap_or([0.0, 1.0, 0.0]);
                    let t = uv.get(i).copied().unwrap_or([0.0, 0.0]);
                    verts.extend_from_slice(&[pos[i][0], pos[i][1], pos[i][2], n[0], n[1], n[2], t[0], t[1]]);
                }
                let cols: Option<Vec<[f32; 4]>> = r.read_colors(0).map(|c| c.into_rgba_f32().collect());
                let tans: Option<Vec<[f32; 4]>> = r.read_tangents().map(|t| t.collect());
                let mut extra = Vec::with_capacity(pos.len() * 8);
                for i in 0..pos.len() {
                    extra.extend_from_slice(&cols.as_ref().and_then(|c| c.get(i).copied()).unwrap_or([1.0; 4]));
                    extra.extend_from_slice(&tans.as_ref().and_then(|t| t.get(i).copied()).unwrap_or([1.0, 0.0, 0.0, 1.0]));
                }
                let mat = p.material();
                let pbr = mat.pbr_metallic_roughness();
                out.push(CpuPrim {
                    extra,
                    local: world, verts, idx, color: pbr.base_color_factor(),
                    image: pbr.base_color_texture().map(|t| t.texture().source().index()),
                    unlit: mat.unlit(), slot,
                    maps: [
                        pbr.base_color_texture().map(|t| t.texture().source().index()),
                        mat.emissive_texture().map(|t| t.texture().source().index()),
                        pbr.metallic_roughness_texture().map(|t| t.texture().source().index()),
                        mat.occlusion_texture().map(|t| t.texture().source().index()),
                        mat.normal_texture().map(|t| t.texture().source().index()),
                    ],
                });
            }
        }
        for c in n.children() { walk(c, world, buffers, out, slots); }
    }
    let mut slots = 0usize;
    for n in scene.nodes() { walk(n, IDENT, &buffers, &mut prims, &mut slots); }
    let images = images.into_iter().map(|im| {
        let px = im.width as usize * im.height as usize;
        let rgba = match im.format {
            gltf::image::Format::R8G8B8A8 => im.pixels,
            gltf::image::Format::R8G8B8 => im.pixels.chunks_exact(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
            gltf::image::Format::R8 => im.pixels.iter().flat_map(|&v| [v, v, v, 255]).collect(),
            gltf::image::Format::R8G8 => im.pixels.chunks_exact(2).flat_map(|c| [c[0], c[0], c[0], c[1]]).collect(),
            _ => vec![200u8; px * 4],   // 16-bit / float textures: a neutral grey rather than a refusal
        };
        (im.width, im.height, rgba)
    }).collect();
    Ok(CpuGlb { prims, images })
}

// ── The presenter ───────────────────────────────────────────────────────────────────────────────────

const SHADER: &str = r#"
struct Cam { vp: mat4x4<f32>, eye: vec4<f32>, px: vec4<f32> };   // px.x = world units per pixel at 1 m; px.y = haze, px.z = 1 for the Rendered look
@group(0) @binding(0) var<uniform> cam: Cam;

// flags: textured, unlit, srgb-texture. PROJECTED content (projectedMapping.ts, the same maths):
// proj = the projector's view-projection (GL clip), pe = its eye + edge softness, pf = projected, cull,
// occlusion (a depth map in group 2), self-shadow bias in metres.
struct Obj { model: mat4x4<f32>, nrm: mat4x4<f32>, color: vec4<f32>, flags: vec4<f32>, proj: mat4x4<f32>, pe: vec4<f32>, pf: vec4<f32> };
@group(1) @binding(0) var<uniform> obj: Obj;
@group(1) @binding(1) var tex: texture_2d<f32>;
@group(1) @binding(2) var samp: sampler;
// The projector's view of the venue: distance along its view axis (clip w, metres) per texel.
@group(2) @binding(0) var pdepth: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) n: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) w: vec3<f32> };

@vertex fn vs_mesh(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) uv: vec2<f32>) -> VOut {
  var o: VOut;
  let wp = obj.model * vec4<f32>(p, 1.0);
  o.pos = cam.vp * wp;
  o.n = (obj.nrm * vec4<f32>(n, 0.0)).xyz;
  o.uv = uv;
  o.w = wp.xyz;
  return o;
}
fn to_linear(c: vec3<f32>) -> vec3<f32> { return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2)); }
// E4b: the heads as real lights (beams.rs `spots`, the editor's MoverLights) — three.js's physically based
// SpotLight: distance falloff 1 / max(d^decay, 0.01) × (1 − (d / range)^4)^2, the cone smoothstep(cos outer,
// cos inner), Lambert (albedo / π × N·L × colour × intensity).
struct Spot { pos: vec4<f32>, dir: vec4<f32>, color: vec4<f32>, cone: vec4<f32> };
// n.x: spots in use; n.y: 1 = Rendered (a dark room); n.z: 1 = the spots cast SHADOWS (Rendered).
struct Lights { spots: array<Spot, 8>, n: vec4<f32>, shadow: array<mat4x4<f32>, 8> };
@group(3) @binding(0) var<uniform> lights: Lights;
@group(3) @binding(1) var shadow_maps: texture_depth_2d_array;
@group(3) @binding(2) var shadow_cmp: sampler_comparison;
// E4b: how much of spot k reaches w — the editor's Rendered shadows (PCFSoftShadowMap, bias −0.0005, normalBias
// 0.02 m): the point pushed along its normal, projected into the spot's map, a 3 × 3 comparison average.
fn spot_shadow(k: u32, w: vec3<f32>, n: vec3<f32>) -> f32 {
  if (lights.n.z < 0.5) { return 1.0; }
  let c = lights.shadow[k] * vec4<f32>(w + n * 0.02, 1.0);
  if (c.w <= 0.0) { return 1.0; }
  let p = c.xyz / c.w;
  if (any(abs(p.xy) > vec2<f32>(1.0)) || p.z > 1.0) { return 1.0; }
  let uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  let texel = 1.0 / f32(textureDimensions(shadow_maps).x);
  var lit = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      lit = lit + textureSampleCompareLevel(shadow_maps, shadow_cmp, uv + vec2<f32>(f32(x), f32(y)) * texel, k, p.z - 0.0005);
    }
  }
  return lit / 9.0;
}
fn spot_light(w: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  var sum = vec3<f32>(0.0);
  for (var k = 0u; k < u32(lights.n.x); k = k + 1u) {
    let s = lights.spots[k];
    let l = s.pos.xyz - w;
    let d = length(l);
    let ld = l / max(d, 1e-5);
    let ndl = max(dot(n, ld), 0.0);
    if (ndl <= 0.0) { continue; }
    var fall = 1.0 / max(pow(d, s.dir.w), 0.01);
    if (s.pos.w > 0.0) { let r = clamp(1.0 - pow(d / s.pos.w, 4.0), 0.0, 1.0); fall = fall * r * r; }
    let cone = smoothstep(s.cone.x, s.cone.y, dot(ld, -s.dir.xyz));
    if (cone <= 0.0) { continue; }
    sum = sum + s.color.rgb * (ndl * fall * cone * spot_shadow(k, w, n));
  }
  return sum;
}
@fragment fn fs_mesh(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  var base = obj.color;
  var uv = i.uv;
  var vis = 1.0;
  if (obj.pf.x > 0.5) {
    // PROJECTED UVs — projectedMapping.ts BODY_FRAG, line for line: nothing behind the projector, the
    // picture upright as a fullscreen image from its viewpoint (v = 0 at the top: the picture's row 0
    // is its top here, so no bitmap flip compensation is needed), an edge ramp, the optional back-face
    // test, and the depth test that stops a nearer surface's content spraying onto what is behind it.
    let pc = obj.proj * vec4<f32>(i.w, 1.0);
    if (pc.w <= 0.0) { vis = 0.0; }
    let ndc = pc.xyz / max(pc.w, 1e-6);
    uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let e = max(obj.pe.w, 1e-4);
    vis = vis * (1.0 - smoothstep(1.0 - e, 1.0, abs(ndc.x))) * (1.0 - smoothstep(1.0 - e, 1.0, abs(ndc.y))) * step(abs(ndc.z), 1.0);
    let ndl = dot(normalize(i.n), normalize(obj.pe.xyz - i.w));
    vis = vis * mix(1.0, step(0.0, ndl), obj.pf.y);
    if (obj.pf.z > 0.5 && vis > 0.0) {
      let dim = vec2<f32>(textureDimensions(pdepth));
      // The depth map was rendered by THIS API: texel row 0 is the top of the projector's frame.
      let px = clamp(vec2<i32>(vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * dim), vec2<i32>(0), vec2<i32>(dim) - 1);
      let seen = textureLoad(pdepth, px, 0).r;
      let bias = obj.pf.w * (1.0 + 4.0 * (1.0 - abs(ndl)));
      if (pc.w > seen + bias) { vis = 0.0; }
    }
  }
  if (obj.flags.x > 0.5) {
    var t = textureSample(tex, samp, uv);
    if (obj.flags.z > 0.5) { t = vec4<f32>(to_linear(t.rgb), t.a); }
    base = base * t;
  }
  base = vec4<f32>(base.rgb * vis, base.a);
  if (obj.flags.y > 0.5) { return vec4<f32>(base.rgb, 1.0); }
  var n = normalize(i.n);
  if (!front) { n = -n; }
  // A soft studio light: sky / ground fill plus one key from over the viewer's shoulder — or, in Rendered, a dark
  // room with a trace of fill (the editor's RoomEnvironment at 0.08) where the rig is the light.
  let sky = mix(0.18, 0.42, n.y * 0.5 + 0.5);
  let key = max(dot(n, normalize(vec3<f32>(-0.35, 0.85, 0.45))), 0.0) * 0.55;
  let fill = select(sky + key, 0.05, lights.n.y > 0.5);
  return vec4<f32>(base.rgb * fill + base.rgb * spot_light(i.w, n) * 0.31830988, 1.0);
}

// LEDs: a camera-facing disc per LED, at least 3 px across so a far rig never vanishes.
struct LOut { @builtin(position) pos: vec4<f32>, @location(0) c: vec3<f32>, @location(1) q: vec2<f32> };
@vertex fn vs_led(@builtin(vertex_index) vi: u32, @location(0) p: vec3<f32>, @location(1) c: vec4<f32>) -> LOut {
  var corners = array<vec2<f32>, 6>(vec2(-1.,-1.), vec2(1.,-1.), vec2(1.,1.), vec2(-1.,-1.), vec2(1.,1.), vec2(-1.,1.));
  let q = corners[vi];
  let d = max(distance(cam.eye.xyz, p), 0.01);
  // As big as the editor's (12 mm radius), never under ~3 px across.
  let r = max(0.012, d * cam.px.x * 1.6);   // the editor's LEDs: 12 mm radius
  let f = normalize(p - cam.eye.xyz);
  let rr = normalize(cross(f, vec3<f32>(0.0, 1.0, 1e-4)));
  let uu = cross(rr, f);
  var o: LOut;
  o.pos = cam.vp * vec4<f32>(p + (rr * q.x + uu * q.y) * r, 1.0);
  o.c = to_linear(c.rgb);
  o.q = q;
  return o;
}
@fragment fn fs_led(i: LOut) -> @location(0) vec4<f32> {
  if (dot(i.q, i.q) > 1.0) { discard; }
  // A dark LED still reads as a dot on the rig, as in the editor.
  return vec4<f32>(max(i.c, vec3<f32>(0.035)), 1.0);
}

// Lines: the grid and the world axes.
struct GOut { @builtin(position) pos: vec4<f32>, @location(0) c: vec4<f32>, @location(1) w: vec3<f32> };
@vertex fn vs_line(@location(0) p: vec3<f32>, @location(1) c: vec4<f32>) -> GOut {
  var o: GOut; o.pos = cam.vp * vec4<f32>(p, 1.0); o.c = c; o.w = p; return o;
}
// Faded with distance from the viewer, as the editor's grid is: far lines bunch into a bright band at
// the horizon otherwise (measured in the first capture).
@fragment fn fs_line(i: GOut) -> @location(0) vec4<f32> {
  let d = distance(i.w.xz, cam.eye.xz);
  let fade = 1.0 - smoothstep(12.0, 40.0, d);
  return vec4<f32>(i.c.rgb, i.c.a * fade);
}
// Overlay lines (projector frustums) keep their colour at any distance — they reach across the venue.
@fragment fn fs_line_flat(i: GOut) -> @location(0) vec4<f32> { return i.c; }

// E4b - A BEAM'S VOLUME (Beams.tsx VERT / FRAG and its node build): an additive cone of haze, apex at the lens.
// The instance scale is non-uniform (thin in x / y, long in z), so the normal takes the inverse scale first.
// Brightness is the CHORD through the haze, approximated by how squarely the shell faces the eye.
struct BOut { @builtin(position) pos: vec4<f32>, @location(0) local: vec3<f32>, @location(1) n: vec3<f32>, @location(2) w: vec3<f32>, @location(3) tint: vec3<f32> };
@vertex fn vs_beam(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>,
                   @location(2) c0: vec4<f32>, @location(3) c1: vec4<f32>, @location(4) c2: vec4<f32>, @location(5) c3: vec4<f32>, @location(6) tint: vec4<f32>) -> BOut {
  let m = mat4x4<f32>(c0, c1, c2, c3);
  let w = m * vec4<f32>(p, 1.0);
  let sc = max(vec3<f32>(length(c0.xyz), length(c1.xyz), length(c2.xyz)), vec3<f32>(1e-6));
  let rot = mat3x3<f32>(c0.xyz / sc.x, c1.xyz / sc.y, c2.xyz / sc.z);
  var o: BOut;
  o.pos = cam.vp * w;
  o.local = p;
  o.n = rot * (n / sc);
  o.w = w.xyz;
  o.tint = tint.rgb;
  return o;
}
@fragment fn fs_beam(i: BOut) -> @location(0) vec4<f32> {
  let t = clamp(-i.local.z, 0.0, 1.0);
  let solid = cam.px.z;
  let facing0 = abs(dot(normalize(i.n), normalize(cam.eye.xyz - i.w)));
  // Rendered: a softer edge and ~45 % left at the floor instead of (1 - t)^2.
  let facing = mix(facing0, pow(facing0, 0.6), solid);
  let fall = mix((1.0 - t) * (1.0 - t), 1.0 - t * 0.55, solid);
  let throat = smoothstep(0.0, 0.05, t);
  let a = facing * fall * throat * cam.px.y * mix(1.0, 2.2, solid);
  if (a <= 0.002) { discard; }
  return vec4<f32>(i.tint * a, a);
}

// E4b — the floor numbers (labels.rs): glyph quads lying on the floor, the atlas's alpha the coverage, the
// vertex colour the ink (already faded).
struct TOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) c: vec3<f32> };
@vertex fn vs_label(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) c: vec3<f32>) -> TOut {
  var o: TOut; o.pos = cam.vp * vec4<f32>(p, 1.0); o.uv = uv; o.c = c; return o;
}
@fragment fn fs_label(i: TOut) -> @location(0) vec4<f32> {
  let a = textureSample(tex, samp, i.uv).a;
  if (a < 0.01) { discard; }
  return vec4<f32>(i.c, a);
}

// A projector's depth map: the venue seen from the projector, distance along its view axis per texel.
struct DOut { @builtin(position) pos: vec4<f32>, @location(0) d: f32 };
@vertex fn vs_depth(@location(0) p: vec3<f32>) -> DOut {
  var o: DOut;
  o.pos = cam.vp * (obj.model * vec4<f32>(p, 1.0));
  o.d = o.pos.w;
  return o;
}
@fragment fn fs_depth(i: DOut) -> @location(0) vec4<f32> { return vec4<f32>(i.d, 0.0, 0.0, 1.0); }
// A spot's shadow map: depth only.
@vertex fn vs_shadow(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> { return cam.vp * (obj.model * vec4<f32>(p, 1.0)); }
"#;

/// A file's geometry, shared by every placement of it.
struct GpuPrim { vb: wgpu::Buffer, ib: wgpu::Buffer, n: u32, local: [f32; 16], color: [f32; 4], image: Option<usize>, unlit: bool, slot: usize }
/// `_held` (O5-2a): the shared buffers and textures (scenegpu.rs) the prims and views are of — held while drawn.
struct GpuGlb { prims: Vec<GpuPrim>, texs: Vec<wgpu::TextureView>, _held: (Arc<crate::scenegpu::GlbBufs>, Vec<Arc<wgpu::Texture>>) }
/// One PLACEMENT's per-primitive state: its own uniforms (its matrix, its content) and the bind group for
/// the texture it currently wears. Per model, not per file — two placements of one file used to share a
/// uniform buffer, so both drew wherever the last one was written.
struct PrimInst { ub: wgpu::Buffer, bind: wgpu::BindGroup, key: (i32, u64) }
struct PlaneGpu { ub: wgpu::Buffer, bind: wgpu::BindGroup, pic_gen: u64 }
/// A projected source's depth map (one per model that projects with occlusion on).
struct DepthMap { view: wgpu::TextureView, bind: wgpu::BindGroup, _cam: wgpu::Buffer, cam_bind: wgpu::BindGroup, depth: wgpu::TextureView, key: String }
const DEPTH_SIZE: u32 = 1024;   // as the editor's (projectorDepth.ts)
/// GL clip (z −1…1, what three's matrices produce) → WebGPU clip (z 0…1): z' = (z + w) / 2.
const GL_TO_WGPU: [f32; 16] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 0.5, 0., 0., 0., 0.5, 1.];

const SAMPLES: u32 = 4;
/// A spot's shadow map, square (RenderedMode: 1024 at "high").
const SHADOW_SIZE: u32 = 1024;
/// The selection accent (FixtureBodies' SELECTED, #27b6c4), in linear.
const ACCENT: [f32; 3] = [0.0203, 0.4678, 0.5520];
const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

/// One open 3D view: draw `shared` into `window` until `stop`. Never returns early on a missing file or
/// a refused texture — the view just shows less (logged once).
pub fn present(gpu: Arc<Gpu>, window: Arc<Window>, surface: wgpu::Surface<'static>, stop: Arc<AtomicBool>, shared: Arc<Mutex<Shared>>) {
    let d = &gpu.device;
    let caps = surface.get_capabilities(&gpu.adapter);
    let surf_format = caps.formats.iter().copied().find(|f| f.is_srgb()).unwrap_or(caps.formats[0]);
    // E4b: the scene is drawn LINEAR into an HDR target and finished by post.rs (a copy in Shaded; bloom and AgX in
    // Rendered) — so every scene pipeline below targets the HDR format, and only the last pass the surface's.
    let format = crate::post::HDR;
    let mut post = crate::post::Post::new(d, surf_format);
    let mut ao = crate::ao::Ao::new(d);
    let mut depth_gen = 0usize;
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("view3d"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });

    let cam_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("cam"), entries: &[wgpu::BindGroupLayoutEntry {
        binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }] });
    let obj_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("obj"), entries: &[
        wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
        wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
        wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
    ] });
    let depth_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("pdepth"), entries: &[
        wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
    ] });
    // Group 2 is its own group (not a binding in the object's): the depth pass draws with the object
    // groups while writing the map, and a bind group naming the map would be a usage conflict there.
    let light_layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("lights"), entries: &[
        wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
        wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false }, count: None },
        wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison), count: None },
    ] });
    // spots (8 × 16 floats), n (4), the shadow matrices (8 × 16).
    let light_buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("lights"), size: ((crate::beams::MAX_SPOTS * crate::beams::SPOT_FLOATS + 4 + crate::beams::MAX_SPOTS * 16) * 4) as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    // E4b: the spots' shadow maps — one layer each, SHADOW_SIZE² (the editor's 1024 at "high"), and a camera per spot.
    let shadow_tex = d.create_texture(&wgpu::TextureDescriptor { label: Some("spot shadows"), size: wgpu::Extent3d { width: SHADOW_SIZE, height: SHADOW_SIZE, depth_or_array_layers: crate::beams::MAX_SPOTS as u32 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: DEPTH, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
    let shadow_layers: Vec<wgpu::TextureView> = (0..crate::beams::MAX_SPOTS as u32).map(|k| shadow_tex.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2), base_array_layer: k, array_layer_count: Some(1), ..Default::default() })).collect();
    let shadow_all = shadow_tex.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    let shadow_cmp = d.create_sampler(&wgpu::SamplerDescriptor { compare: Some(wgpu::CompareFunction::LessEqual), mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
        address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge, ..Default::default() });
    let light_bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &light_layout, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: light_buf.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&shadow_all) },
        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&shadow_cmp) },
    ] });
    let shadow_cams: Vec<(wgpu::Buffer, wgpu::BindGroup)> = (0..crate::beams::MAX_SPOTS).map(|_| {
        let b = d.create_buffer(&wgpu::BufferDescriptor { label: Some("spot cam"), size: 96, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let g = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &cam_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: b.as_entire_binding() }] });
        (b, g)
    }).collect();
    let mesh_pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&cam_layout), Some(&obj_layout), Some(&depth_layout), Some(&light_layout)], immediate_size: 0 });
    let depth_pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&cam_layout), Some(&obj_layout)], immediate_size: 0 });
    let cam_pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&cam_layout)], immediate_size: 0 });
    let ds = |write: bool| Some(wgpu::DepthStencilState { format: DEPTH, depth_write_enabled: Some(write), depth_compare: Some(wgpu::CompareFunction::LessEqual), stencil: Default::default(), bias: Default::default() });
    let ms = wgpu::MultisampleState { count: SAMPLES, mask: !0, alpha_to_coverage_enabled: false };
    let mesh_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("mesh"), layout: Some(&mesh_pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_mesh"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
            array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2] })] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_mesh"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
        depth_stencil: ds(true), multisample: ms, multiview_mask: None, cache: None,
    });
    let led_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("leds"), layout: Some(&cam_pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_led"), compilation_options: Default::default(), buffers: &[
            Some(wgpu::VertexBufferLayout { array_stride: 12, step_mode: wgpu::VertexStepMode::Instance, attributes: &wgpu::vertex_attr_array![0 => Float32x3] }),
            Some(wgpu::VertexBufferLayout { array_stride: 4, step_mode: wgpu::VertexStepMode::Instance, attributes: &wgpu::vertex_attr_array![1 => Unorm8x4] }),
        ] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_led"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: ds(true), multisample: ms, multiview_mask: None, cache: None,
    });
    let flat_line_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("overlay lines"), layout: Some(&cam_pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_line"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
            array_stride: 28, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x4] })] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_line_flat"), targets: &[Some(wgpu::ColorTargetState {
            format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
        primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::LineList, ..Default::default() },
        depth_stencil: ds(false), multisample: ms, multiview_mask: None, cache: None,
    });
    // The gizmo's handles: flat-coloured triangles drawn OVER everything (depth ignored), as TransformControls'.
    let handle_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("gizmo"), layout: Some(&cam_pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_line"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
            array_stride: 28, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x4] })] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_line_flat"), targets: &[Some(wgpu::ColorTargetState {
            format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
        primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
        depth_stencil: Some(wgpu::DepthStencilState { format: DEPTH, depth_write_enabled: Some(false), depth_compare: Some(wgpu::CompareFunction::Always), stencil: Default::default(), bias: Default::default() }),
        multisample: ms, multiview_mask: None, cache: None,
    });
    let label_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("floor numbers"), layout: Some(&depth_pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_label"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
            array_stride: (crate::labels::VERT_FLOATS * 4) as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2, 2 => Float32x3] })] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_label"), targets: &[Some(wgpu::ColorTargetState {
            format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
        primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
        depth_stencil: ds(false), multisample: ms, multiview_mask: None, cache: None,
    });
    // The beams' volume: additive (three's AdditiveBlending: src x alpha + dst), depth-tested, never written.
    let additive = wgpu::BlendState {
        color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
        alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
    };
    let beam_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("beams"), layout: Some(&cam_pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_beam"), compilation_options: Default::default(), buffers: &[
            Some(wgpu::VertexBufferLayout { array_stride: 24, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3] }),
            Some(wgpu::VertexBufferLayout { array_stride: (crate::beams::CONE_FLOATS * 4) as u64, step_mode: wgpu::VertexStepMode::Instance,
                attributes: &wgpu::vertex_attr_array![2 => Float32x4, 3 => Float32x4, 4 => Float32x4, 5 => Float32x4, 6 => Float32x4] }),
        ] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_beam"), targets: &[Some(wgpu::ColorTargetState {
            format, blend: Some(additive), write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
        primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
        depth_stencil: ds(false), multisample: ms, multiview_mask: None, cache: None,
    });
    let shadow_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("spot shadow"), layout: Some(&depth_pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_shadow"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
            array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3] })] },
        fragment: None,
        primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
        depth_stencil: Some(wgpu::DepthStencilState { format: DEPTH, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::LessEqual), stencil: Default::default(), bias: Default::default() }),
        multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let depth_pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("projector depth"), layout: Some(&depth_pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_depth"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout {
            array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x3] })] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_depth"), targets: &[Some(wgpu::TextureFormat::R32Float.into())], compilation_options: Default::default() }),
        primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
        depth_stencil: ds(true), multisample: Default::default(), multiview_mask: None, cache: None,
    });

    let cam_buf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("cam"), size: 96, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let cam_bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &cam_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: cam_buf.as_entire_binding() }] });
    let sampler = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear, address_mode_u: wgpu::AddressMode::Repeat, address_mode_v: wgpu::AddressMode::Repeat, ..Default::default() });
    let white = tex_rgba(&gpu, 1, 1, &[255, 255, 255, 255]);
    let white_view = white.create_view(&Default::default());

    let obj_bind = |ub: &wgpu::Buffer, view: &wgpu::TextureView| d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &obj_layout, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: ub.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view) },
        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
    ] });
    let obj_ub = || d.create_buffer(&wgpu::BufferDescriptor { label: Some("obj"), size: 256, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let write_obj_p = |ub: &wgpu::Buffer, m: &[f32; 16], color: [f32; 4], flags: [f32; 4], proj: Option<(&Proj, bool)>| {
        let mut v = Vec::with_capacity(64);
        v.extend_from_slice(m); v.extend_from_slice(&normal_matrix(m)); v.extend_from_slice(&color); v.extend_from_slice(&flags);
        match proj {
            Some((p, has_depth)) => {
                v.extend_from_slice(&p.view);
                v.extend_from_slice(&[p.eye[0], p.eye[1], p.eye[2], p.soft]);
                v.extend_from_slice(&[1.0, p.cull as u32 as f32, has_depth as u32 as f32, p.bias]);
            }
            None => v.extend_from_slice(&[0.0; 24]),
        }
        gpu.queue.write_buffer(ub, 0, &bytes(&v));
    };
    let write_obj = |ub: &wgpu::Buffer, m: &[f32; 16], color: [f32; 4], flags: [f32; 4]| write_obj_p(ub, m, color, flags, None);
    // Every mesh draw binds a depth map; the ones that do not project bind this 1 × 1 stand-in.
    let mk_depth_bind = |view: &wgpu::TextureView| d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &depth_layout, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) }] });
    let no_depth = d.create_texture(&wgpu::TextureDescriptor { label: Some("no depth"), size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::R32Float, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
    let no_depth_bind = mk_depth_bind(&no_depth.create_view(&Default::default()));

    // A unit box (a light's housing), as a mesh.
    let cube = {
        let mut v: Vec<f32> = Vec::new(); let mut idx: Vec<u32> = Vec::new();
        for (n, u, w) in [([1., 0., 0.], [0., 1., 0.], [0., 0., 1.]), ([-1., 0., 0.], [0., 1., 0.], [0., 0., -1.]), ([0., 1., 0.], [0., 0., 1.], [1., 0., 0.]),
                          ([0., -1., 0.], [0., 0., -1.], [1., 0., 0.]), ([0., 0., 1.], [1., 0., 0.], [0., 1., 0.]), ([0., 0., -1.], [-1., 0., 0.], [0., 1., 0.])] {
            let base = (v.len() / 8) as u32;
            for (a, b) in [(-1., -1.), (1., -1.), (1., 1.), (-1., 1.)] {
                let p = add(scale(n, 0.5), add(scale(u, 0.5 * a), scale(w, 0.5 * b)));
                v.extend_from_slice(&[p[0], p[1], p[2], n[0], n[1], n[2], 0.0, 0.0]);
            }
            idx.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
        let vb = buf_init(&gpu, "cube vb", &bytes(&v), wgpu::BufferUsages::VERTEX);
        let ib = buf_init(&gpu, "cube ib", &idx.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), wgpu::BufferUsages::INDEX);
        (vb, ib, idx.len() as u32)
    };
    // The beams: one unit cone (instanced), and per-frame buffers for the instances and the diagram's lines,
    // grown when a frame needs more (never shrunk: a rig's size is stable).
    let cone = {
        let (v, idx) = crate::beams::unit_cone();
        (buf_init(&gpu, "cone vb", &bytes(&v), wgpu::BufferUsages::VERTEX), buf_init(&gpu, "cone ib", &idx.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), wgpu::BufferUsages::INDEX), idx.len() as u32)
    };
    let mut cone_inst: Option<wgpu::Buffer> = None;
    let mut beam_lines: Option<wgpu::Buffer> = None;
    let grow = |slot: &mut Option<wgpu::Buffer>, data: &[f32], label: &str| {
        let need = (data.len() * 4) as u64;
        if need == 0 { return; }
        if slot.as_ref().is_none_or(|b| b.size() < need) {
            *slot = Some(d.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: need.next_power_of_two().max(256), usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        }
        gpu.queue.write_buffer(slot.as_ref().unwrap(), 0, &bytes(data));
    };
    let mut beams_logged = (0u32, 0u32, false);
    // The floor numbers' glyph atlas, rasterised once (labels.rs), bound through an object group (its texture slot).
    let label_atlas = crate::labels::atlas();
    let label_bind = label_atlas.as_ref().map(|a| {
        eprintln!("artlux-engine: 3D view floor numbers: glyph atlas {} x {}", a.w, a.h);
        let t = tex_rgba(&gpu, a.w, a.h, &a.rgba);
        obj_bind(&obj_ub(), &t.create_view(&Default::default()))
    });
    if label_atlas.is_none() { eprintln!("artlux-engine: 3D view: no monospace system font — the floor has no numbers"); }
    let cell_aspect = label_atlas.as_ref().map_or(0.6, |a| a.cell_aspect);
    let mut label_state = crate::labels::State::default();
    let mut label_buf: Option<wgpu::Buffer> = None;
    let mut labels_logged = false;
    // E4b: the adaptive floor grid (grid.rs) and the origin gnomon, rebuilt when the density or the reference moved.
    let mut grid_lines: Option<(wgpu::Buffer, u32)> = None;
    let mut grid_key = (i64::MIN, i64::MIN, i64::MIN);
    let mut gnomon_buf: Option<wgpu::Buffer> = None;
    let mut handle_buf: Option<wgpu::Buffer> = None;
    // E4b: how many spots cast shadows this frame (Rendered only, as in the editor).
    #[allow(unused_assignments)]
    let mut shadow_n = 0usize;
    let mut shadow_draw: bool;   // O2-5: set each frame by the shadow key
    // E4b: Rendered's matte stage floor (RenderedMode: 400 × 400 m, #1c1c1c, 3 mm under the grid), lit by the rig.
    let floor_ub = obj_ub();
    write_obj(&floor_ub, &[400., 0., 0., 0., 0., 0., -400., 0., 0., 1., 0., 0., 0., -0.003, 0., 1.], [0.0113, 0.0113, 0.0113, 1.0], [0.0; 4]);
    let floor_bind = obj_bind(&floor_ub, &white_view);
    // E4b: the selected model's outline (its world bounds), rebuilt when the selection, the scene or a file changes.
    let mut model_outline: Option<(wgpu::Buffer, u32)> = None;
    let mut model_outline_key = String::new();
    // E4b: the drawing of a drag in progress — the selection's LEDs, housings and beams moved by the offset.
    let mut drag_drawn: Option<crate::gizmo::Gesture> = None;

    // The screen quad: 1 × 1 in XY facing +Z, scaled per plane (PlaneGeometry's UVs: v = 0 at the bottom,
    // and the picture's row 0 is its TOP, so the quad samples (u, 1 - v)).
    let quad = {
        let v: [f32; 32] = [-0.5, -0.5, 0., 0., 0., 1., 0., 1., 0.5, -0.5, 0., 0., 0., 1., 1., 1., 0.5, 0.5, 0., 0., 0., 1., 1., 0., -0.5, 0.5, 0., 0., 0., 1., 0., 0.];
        let idx: [u32; 6] = [0, 1, 2, 0, 2, 3];
        (buf_init(&gpu, "quad vb", &bytes(&v), wgpu::BufferUsages::VERTEX), buf_init(&gpu, "quad ib", &idx.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), wgpu::BufferUsages::INDEX))
    };

    // glTF: loaded on a helper thread, uploaded here.
    let (load_tx, load_rx) = std::sync::mpsc::channel::<(String, Result<Arc<crate::scenegpu::Loaded>, String>)>();
    let mut glbs: HashMap<String, Option<GpuGlb>> = HashMap::new();   // None = loading (or failed)
    let mut insts: HashMap<String, Vec<PrimInst>> = HashMap::new();    // model id → its placement's prims
    let mut planes: HashMap<String, PlaneGpu> = HashMap::new();
    let mut plane_tex: HashMap<String, (u64, wgpu::Texture)> = HashMap::new();
    let mut depths: HashMap<String, DepthMap> = HashMap::new();         // model id → its projector's depth map
    let mut depth_dirty = true;
    let mut lights: Vec<(wgpu::Buffer, wgpu::BindGroup)> = Vec::new();
    let mut led_bufs: Option<(wgpu::Buffer, wgpu::Buffer, u32)> = None;
    let mut overlay: Option<(wgpu::Buffer, u32)> = None;
    let mut scene_ver = 0u64;
    // O2-5 — PRESENT ON CHANGE (the projector outputs' E6i rule, now the 3D view's): what the last presented frame was
    // drawn from, when it was presented, how many file loads have landed; and what the spots' shadow maps were drawn
    // from — a still view drew 8 shadow maps, the 4× MSAA scene, AO and bloom at the display's rate (60–144 a second).
    let mut last_key = 0u64;
    let mut last_present = std::time::Instant::now() - Duration::from_secs(1);
    let mut loads = 0u64;
    let mut shadow_key = 0u64;
    let mut colors_gen = u64::MAX;
    let mut scene: Option<Arc<Scene>> = None;

    // A surface's live picture as a texture, re-uploaded only when its generation moves. Shared by the
    // flat screens and the venue meshes that wear content, so one surface is one upload.
    fn ensure_pic(gpu: &Gpu, cache: &mut HashMap<String, (u64, wgpu::Texture)>, pics: &HashMap<String, (u64, Arc<Picture>)>, sid: &str) -> Option<u64> {
        let (g, p) = pics.get(sid)?;
        if cache.get(sid).map(|t| t.0) != Some(*g) {
            // O1-3: into the surface's own texture when the size is the same (it was a new one per video frame).
            let reuse = cache.remove(sid).map(|c| c.1);
            let t = match &p.tex { Some(t) => crate::projector::content_texture_from_into(gpu, t, p.crop.unwrap_or([0, 0, p.w, p.h]), reuse), None => crate::projector::content_texture_into(gpu, p.w, p.h, &p.rgba, reuse) };
            cache.insert(sid.to_string(), (*g, t));
        }
        Some(*g)
    }

    let mut configured: Option<PhysicalSize<u32>> = None;
    let mut targets: Option<(wgpu::TextureView, wgpu::TextureView)> = None;   // (msaa colour, depth)

    while !stop.load(Ordering::SeqCst) {
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 { std::thread::sleep(Duration::from_millis(50)); continue; }
        if configured != Some(size) {
            surface.configure(d, &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format: surf_format, width: size.width, height: size.height,
                present_mode: wgpu::PresentMode::Fifo, desired_maximum_frame_latency: 2, alpha_mode: caps.alpha_modes[0],
                view_formats: vec![], color_space: wgpu::SurfaceColorSpace::Auto,
            });
            // The depth is also READ (ao.rs, Rendered's ambient occlusion), so it is a binding too.
            let mk = |f: wgpu::TextureFormat| d.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: size.width, height: size.height, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: SAMPLES, dimension: wgpu::TextureDimension::D2, format: f, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] }).create_view(&Default::default());
            depth_gen += 1;
            targets = Some((mk(format), mk(DEPTH)));
            post.ensure(d, size.width, size.height);
            configured = Some(size);
        }

        // What the render thread and the window published.
        let frame_at = std::time::Instant::now();
        let (sc, colors, pics, cam, beam_states, hover_axis, mut drag, beams_gen) = {
            let s = shared.lock().unwrap();
            (s.scene.clone(), s.colors.clone(), s.pictures.clone(), s.cam, s.beams.clone(), s.hover_axis, s.drag.clone(), s.beams_gen)
        };
        // A finished drag's offset is drawn until the scene that carries the committed positions arrives.
        if let (Some(dg), Some((ver, _))) = (&drag, &sc) {
            if dg.ended_at_scene.is_some_and(|e| *ver > e) {
                shared.lock().unwrap().drag = None;
                drag = None;
            }
        }

        // A new scene: start loading files never seen, (re)write every placement.
        if let Some((ver, sc)) = &sc {
            if *ver != scene_ver {
                scene_ver = *ver;
                for m in &sc.models {
                    if let ModelKind::Glb(path) = &m.kind {
                        if !glbs.contains_key(path) {
                            glbs.insert(path.clone(), None);
                            let (tx, p) = (load_tx.clone(), path.clone());
                            let _ = std::thread::Builder::new().name("glb".into()).spawn(move || { let r = crate::scenegpu::cpu(&p); let _ = tx.send((p, r)); });
                        }
                    }
                }
                // Light housings: 0.3 m boxes at each light.
                // Light housings: 0.3 m boxes at each light — in the ACCENT when the editor has it selected
                // (E4b; FixtureBodies' #27b6c4, linear), so a click here shows what it picked.
                lights = sc.lights.iter().map(|l| (l.pos, sc.look.selected.contains(&l.id))).map(|(p, sel)| {
                    let ub = obj_ub();
                    let m = [0.3, 0., 0., 0., 0., 0.3, 0., 0., 0., 0., 0.3, 0., p[0], p[1], p[2], 1.];
                    write_obj(&ub, &m, if sel { [ACCENT[0], ACCENT[1], ACCENT[2], 1.0] } else { [0.16, 0.16, 0.17, 1.0] }, [0.0; 4]);
                    let b = obj_bind(&ub, &white_view);
                    (ub, b)
                }).collect();
                // LED positions: one instance buffer for the whole rig (colours follow below).
                let pos: Vec<f32> = sc.leds.iter().flat_map(|f| f.pos.iter().copied()).collect();
                let n = (pos.len() / 3) as u32;
                led_bufs = if n == 0 { None } else {
                    let pb = buf_init(&gpu, "led pos", &bytes(&pos), wgpu::BufferUsages::VERTEX);
                    let cb = d.create_buffer(&wgpu::BufferDescriptor { label: Some("led col"), size: n as u64 * 4, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
                    gpu.queue.write_buffer(&cb, 0, &vec![20u8; n as usize * 4]);
                    Some((pb, cb, n))
                };
                // Overlay lines (projector frustums): x y z r g b → the line pipeline's x y z r g b a.
                let mut ov: Vec<f32> = sc.lines.chunks_exact(6).flat_map(|v| [v[0], v[1], v[2], v[3], v[4], v[5], 1.0]).collect();
                // A SELECTED pixel fixture: its LED line traced in the accent (the editor tints its body).
                for f in sc.leds.iter().filter(|f| sc.look.selected.contains(&f.id)) {
                    let pts: Vec<&[f32]> = f.pos.chunks_exact(3).collect();
                    for w in pts.windows(2) {
                        for q in [w[0], w[1]] { ov.extend_from_slice(&[q[0], q[1], q[2], ACCENT[0], ACCENT[1], ACCENT[2], 1.0]); }
                    }
                }
                overlay = if ov.is_empty() { None } else { Some((buf_init(&gpu, "overlay", &bytes(&ov), wgpu::BufferUsages::VERTEX), (ov.len() / 7) as u32)) };
                colors_gen = u64::MAX;
                drag_drawn = None;   // a drag's offset is re-applied over the new positions
                planes.retain(|id, _| sc.models.iter().any(|m| &m.id == id));
                insts.retain(|id, _| sc.models.iter().any(|m| &m.id == id && matches!(m.kind, ModelKind::Glb(_))));
                depths.retain(|id, _| sc.models.iter().any(|m| &m.id == id));
                depth_dirty = true;   // anything moved, anything re-projected
                scene = Some(sc.clone());
            }
        }
        // Files that finished loading: upload.
        while let Ok((path, r)) = load_rx.try_recv() {
            loads += 1;
            match r {
                Ok(l) => {
                    let cpu = &l.cpu;
                    // E4b: the triangles, kept for picking (positions only; the vertex stride is 8 floats).
                    let picks: Vec<PickPrim> = cpu.prims.iter().map(|p| PickPrim { local: p.local, pos: p.verts.chunks_exact(8).map(|v| [v[0], v[1], v[2]]).collect(), idx: p.idx.clone() }).collect();
                    shared.lock().unwrap().meshes.insert(path.clone(), Arc::new(picks));
                    model_outline_key = String::new();   // a file that loads may be the selected one
                    // O5-2a: the file's images and buffers from the shared store (scenegpu.rs) — the parse is the one the
                    // calibrated outputs use too.
                    let held: Vec<Arc<wgpu::Texture>> = cpu.images.iter().enumerate().map(|(i, (w, h, px))| crate::scenegpu::image(&gpu, &l.key, i, crate::scenegpu::ImageUse::View, || tex_rgba(&gpu, *w, *h, px))).collect();
                    let texs: Vec<wgpu::TextureView> = held.iter().map(|t| t.create_view(&Default::default())).collect();
                    let bufs = crate::scenegpu::bufs(&gpu, &l, false);
                    let prims = cpu.prims.iter().enumerate().map(|(i, p)| {
                        GpuPrim { vb: bufs.vb[i].clone(), ib: bufs.ib[i].clone(), n: p.idx.len() as u32, local: p.local, color: p.color, image: p.image, unlit: p.unlit, slot: p.slot }
                    }).collect::<Vec<_>>();
                    eprintln!("artlux-engine: 3D view loaded {path} ({} meshes)", prims.iter().map(|p: &GpuPrim| p.slot + 1).max().unwrap_or(0));
                    // Placements of this file built before it loaded (none) or against an older load: rebuild.
                    if let Some(sc) = &scene { for m in &sc.models { if matches!(&m.kind, ModelKind::Glb(p) if *p == path) { insts.remove(&m.id); } } }
                    glbs.insert(path, Some(GpuGlb { prims, texs, _held: (bufs, held) }));
                    depth_dirty = true;
                }
                Err(e) => eprintln!("artlux-engine: 3D view: {e}"),
            }
        }
        // O2-5: everything a frame is drawn from. Unchanged (and the heartbeat not due — a window the compositor lost is
        // never left empty): nothing is drawn, nothing presented; the compositor keeps showing the last frame.
        let key = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            (size.width, size.height, sc.as_ref().map(|s| s.0), colors.as_ref().map(|c| c.0), beams_gen, hover_axis, loads).hash(&mut h);
            [cam.target[0], cam.target[1], cam.target[2], cam.yaw, cam.pitch, cam.dist, cam.fov].map(f32::to_bits).hash(&mut h);
            // Pictures, order-free (a cloned map need not iterate in the same order).
            pics.iter().map(|(sid, (g, _))| { let mut e = std::collections::hash_map::DefaultHasher::new(); (sid, g).hash(&mut e); e.finish() }).fold(0u64, |a, x| a ^ x).hash(&mut h);
            if let Some(dg) = &drag { format!("{dg:?}").hash(&mut h); }
            h.finish()
        };
        if key == last_key && last_present.elapsed() < Duration::from_millis(250) { std::thread::sleep(Duration::from_millis(4)); continue; }
        // LED colours: the composed buffer, fixture by fixture at the packer's offsets.
        if let (Some((g, raw, bases)), Some((_, cb, n)), Some(sc)) = (&colors, &led_bufs, &scene) {
            if *g != colors_gen {
                colors_gen = *g;
                let mut out = Vec::with_capacity(*n as usize * 4);
                for f in &sc.leds {
                    let count = f.pos.len() / 3;
                    let base = bases.get(&f.id).copied();
                    for i in 0..count {
                        let px = base.map(|b| (b + i) * 4).filter(|&k| k + 3 < raw.len()).map(|k| [raw[k], raw[k + 1], raw[k + 2], 255]).unwrap_or([0, 0, 0, 255]);
                        out.extend_from_slice(&px);
                    }
                }
                out.resize(*n as usize * 4, 0);
                gpu.queue.write_buffer(cb, 0, &out);
            }
        }

        // The camera.
        let aspect = size.width as f32 / size.height as f32;
        let eye = cam.eye();
        let vp = mul(&perspective(cam.fov, aspect, 0.03, 4000.0), &look_at(eye, cam.target));
        let px = 2.0 * (cam.fov.to_radians() / 2.0).tan() / size.height as f32;
        let mut cu = Vec::with_capacity(24);
        let look = scene.as_ref().map(|s| s.look.clone()).unwrap_or_default();
        cu.extend_from_slice(&vp); cu.extend_from_slice(&[eye[0], eye[1], eye[2], 1.0]); cu.extend_from_slice(&[px, look.haze, look.rendered as u32 as f32, 0.0]);

        // The beams, from this tick's resolved states.
        // The selected model's outline: the twelve edges of its world bounds, in the accent.
        let want_key = scene.as_ref().and_then(|s| s.selected_model.clone().map(|m| format!("{m}@{scene_ver}@{:?}", drag.as_ref().map(|d| d.g)))).unwrap_or_default();
        if want_key != model_outline_key {
            model_outline_key = want_key;
            model_outline = scene.as_ref().and_then(|s| {
                let id = s.selected_model.as_ref()?;
                let m0 = s.models.iter().find(|m| &m.id == id)?;
                let meshes = shared.lock().unwrap().meshes.clone();
                let moved = drag.as_ref().filter(|d| d.ids.contains(id)).map(|d| Model { id: m0.id.clone(), kind: match &m0.kind { ModelKind::Glb(p) => ModelKind::Glb(p.clone()), ModelKind::Plane { surface, w, h } => ModelKind::Plane { surface: surface.clone(), w: *w, h: *h } }, matrix: mul(&d.matrix(), &m0.matrix), content: None });
                let (lo, hi) = model_bounds(moved.as_ref().unwrap_or(m0), &meshes)?;
                let c = |i: u32| [if i & 1 == 0 { lo[0] } else { hi[0] }, if i & 2 == 0 { lo[1] } else { hi[1] }, if i & 4 == 0 { lo[2] } else { hi[2] }];
                let mut v: Vec<f32> = Vec::new();
                for (a, b) in [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)] {
                    for p in [c(a), c(b)] { v.extend_from_slice(&[p[0], p[1], p[2], ACCENT[0], ACCENT[1], ACCENT[2], 1.0]); }
                }
                Some((buf_init(&gpu, "model outline", &bytes(&v), wgpu::BufferUsages::VERTEX), (v.len() / 7) as u32))
            });
        }

        // A drag in progress transforms the selection's drawing (gizmo.rs Drag::apply): the beams leave from the
        // moved lenses, turned with their heads.
        let moved_lights: Option<Vec<LightFix>> = match (&drag, &scene) {
            (Some(dg), Some(s)) => Some(s.lights.iter().map(|l| {
                let mine = dg.ids.contains(&l.id);
                LightFix {
                    id: l.id.clone(),
                    pos: if mine { dg.apply(l.pos) } else { l.pos },
                    beam: l.beam.as_ref().map(|b| if mine { BeamFix { apex: dg.apply(b.apex), q: dg.turn(b.q), ..*b } } else { *b }),
                }
            }).collect()),
            _ => None,
        };
        let bf = scene.as_ref().map(|s| crate::beams::build(moved_lights.as_deref().unwrap_or(&s.lights), &beam_states, &s.look)).unwrap_or(crate::beams::Frame { cones: Vec::new(), lines: Vec::new() });
        // The gizmo, at the anchor (moved with the drag), its held / hovered handle hot.
        let handle_verts = match scene.as_ref().and_then(|s| s.gizmo) {
            Some(mut g) => {
                if let Some(dg) = &drag { g.at = add(g.at, dg.g.delta); }
                crate::gizmo::geometry(&g, eye, px, drag.as_ref().map(|d| d.axis).or(hover_axis))
            }
            None => Vec::new(),
        };
        let n_handle_verts = (handle_verts.len() / 7) as u32;
        grow(&mut handle_buf, &handle_verts, "gizmo");
        // Housings and LED positions follow the drag (rewritten only while the offset changes).
        let want_drawn = drag.as_ref().map(|d| d.g);
        if want_drawn != drag_drawn {
            if let Some(s) = &scene {
                let mv = |id: &str, p: [f32; 3]| -> [f32; 3] { match drag.as_ref().filter(|d| d.ids.contains(id)) { Some(d) => d.apply(p), None => p } };
                for (l, (ub, _)) in s.lights.iter().zip(&lights) {
                    let p = mv(&l.id, l.pos);
                    let sel = s.look.selected.contains(&l.id);
                    let m = [0.3, 0., 0., 0., 0., 0.3, 0., 0., 0., 0., 0.3, 0., p[0], p[1], p[2], 1.];
                    write_obj(ub, &m, if sel { [ACCENT[0], ACCENT[1], ACCENT[2], 1.0] } else { [0.16, 0.16, 0.17, 1.0] }, [0.0; 4]);
                }
                if let Some((pb, _, _)) = &led_bufs {
                    let pos: Vec<f32> = s.leds.iter().flat_map(|f| f.pos.chunks_exact(3).flat_map(|p| mv(&f.id, [p[0], p[1], p[2]])).collect::<Vec<_>>()).collect();
                    gpu.queue.write_buffer(pb, 0, &bytes(&pos));
                }
            }
            drag_drawn = want_drawn;
        }
        // The heads as lights, this frame (moved with a drag, as the beams are).
        {
            let (mut v, n) = scene.as_ref().map(|s| crate::beams::spots(moved_lights.as_deref().unwrap_or(&s.lights), &beam_states, s.look.light_gain)).unwrap_or((vec![0.0; crate::beams::MAX_SPOTS * crate::beams::SPOT_FLOATS], 0));
            // Each spot's shadow camera: three's SpotLightShadow — fov twice the cone, square, near 0.5, far its range.
            let mut mats = vec![0f32; crate::beams::MAX_SPOTS * 16];
            for k in 0..n {
                let o = k * crate::beams::SPOT_FLOATS;
                let (p, dir) = ([v[o], v[o + 1], v[o + 2]], [v[o + 4], v[o + 5], v[o + 6]]);
                let angle = v[o + 12].clamp(-1.0, 1.0).acos();
                let m = mul(&perspective((2.0 * angle).to_degrees().clamp(1.0, 179.0), 1.0, 0.5, v[o + 3].max(1.0)), &look_at(p, add(p, dir)));
                mats[k * 16..k * 16 + 16].copy_from_slice(&m);
                let mut cv = m.to_vec();
                cv.extend_from_slice(&[p[0], p[1], p[2], 1.0, 0.0, 0.0, 0.0, 0.0]);
                gpu.queue.write_buffer(&shadow_cams[k].0, 0, &bytes(&cv));
            }
            // ARTLUX_VIEW3D_SHADOWS=0: the spots light the room WITHOUT shadow maps — a diagnostic, to measure what the
            // shadows cost while heads move (2026-11-28 chase bench); the look is wrong with it (light through trusses).
            static SHADOWS: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
            let shadows_on = *SHADOWS.get_or_init(|| std::env::var("ARTLUX_VIEW3D_SHADOWS").map_or(true, |v| v != "0"));
            shadow_n = if look.rendered && shadows_on { n } else { 0 };
            // O2-5: the shadow maps are a function of the spots' cameras and the casters (the scene, the files loaded, a
            // drag) — drawn again only when one of those moves, not on every frame (an LED colour does not move them).
            let sk = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                (scene_ver, loads, shadow_n).hash(&mut h);
                for x in &mats[..shadow_n * 16] { x.to_bits().hash(&mut h); }
                if let Some(dg) = &drag { format!("{dg:?}").hash(&mut h); }
                h.finish()
            };
            if sk == shadow_key { shadow_draw = false; } else { shadow_key = sk; shadow_draw = true; }
            v.extend_from_slice(&[n as f32, look.rendered as u32 as f32, (shadow_n > 0) as u32 as f32, 0.0]);
            v.extend_from_slice(&mats);
            gpu.queue.write_buffer(&light_buf, 0, &bytes(&v));
        }
        let n_cones = (bf.cones.len() / crate::beams::CONE_FLOATS) as u32;
        let n_beam_verts = (bf.lines.len() / crate::beams::LINE_FLOATS) as u32;
        // The floor numbers, laid out against this frame's camera, in css pixels.
        let grid_look = scene.as_ref().map(|s| s.grid).unwrap_or_default();
        // The floor grid and the gnomon, against the same reference the numbers use.
        let css_h0 = size.height as f32 / window.scale_factor().max(0.1) as f32;
        let reference = { let (vpm, fwd, up) = camera_frame(&cam, aspect); crate::labels::reference(&vpm, eye, fwd, up, css_h0) };
        let mut n_gnomon = 0u32;
        if let (Some((at, ppm)), true) = (reference, grid_look.visible) {
            let fine = crate::grid::families(ppm).first().map_or(1.0, |f| f.0);
            let key = (((ppm.max(1e-6)).log2() * 32.0).round() as i64, (at[0] / fine * 4.0).round() as i64, (at[2] / fine * 4.0).round() as i64);
            if key != grid_key {
                grid_key = key;
                let v = crate::grid::lines(at, ppm);
                grid_lines = (!v.is_empty()).then(|| (buf_init(&gpu, "floor grid", &bytes(&v), wgpu::BufferUsages::VERTEX), (v.len() / crate::grid::VERT_FLOATS) as u32));
            }
            let g = crate::grid::gnomon(ppm, eye);
            n_gnomon = (g.len() / crate::grid::VERT_FLOATS) as u32;
            grow(&mut gnomon_buf, &g, "gnomon");
        }
        let label_verts = if grid_look.visible && grid_look.labels && label_bind.is_some() {
            let (vpm, fwd, up) = camera_frame(&cam, aspect);
            let css_h = size.height as f32 / window.scale_factor().max(0.1) as f32;
            crate::labels::build(&mut label_state, &vpm, eye, fwd, up, css_h, cell_aspect)
        } else { Vec::new() };
        let n_label_verts = (label_verts.len() / crate::labels::VERT_FLOATS) as u32;
        grow(&mut label_buf, &label_verts, "floor numbers");
        if !labels_logged && n_label_verts > 0 { labels_logged = true; eprintln!("artlux-engine: 3D view floor numbers: {} glyph(s)", n_label_verts / 6); }
        grow(&mut cone_inst, &bf.cones, "beam instances");
        grow(&mut beam_lines, &bf.lines, "beam lines");
        // Logged on the first beams and again whenever the look or the count changes (a test reads it).
        let beams_key = (n_cones, n_beam_verts, look.rendered);
        if beams_key != beams_logged && (n_cones > 0 || n_beam_verts > 0) {
            beams_logged = beams_key;
            eprintln!("artlux-engine: 3D view beams: {} volume(s), {} diagram segment(s) (haze {}, {})", n_cones, n_beam_verts / 2, look.haze, if look.rendered { "Rendered" } else { "Shaded" });
        }
        gpu.queue.write_buffer(&cam_buf, 0, &bytes(&cu));

        // Depth maps: one per model projecting with occlusion on, keyed by its projector matrix (a
        // re-solve or a different projector makes a new one; a moved mesh re-renders via depth_dirty).
        if let Some(sc) = &scene {
            for m in &sc.models {
                let want = m.content.as_ref().and_then(|c| c.src.iter().find_map(|s| s.proj.as_ref().filter(|p| p.occlude)));
                match want {
                    None => { depths.remove(&m.id); }
                    Some(p) => {
                        let key = format!("{:?}", p.view);
                        if depths.get(&m.id).map(|x| x.key.as_str()) != Some(key.as_str()) {
                            let ext = wgpu::Extent3d { width: DEPTH_SIZE, height: DEPTH_SIZE, depth_or_array_layers: 1 };
                            let color = d.create_texture(&wgpu::TextureDescriptor { label: Some("projector depth"), size: ext, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
                                format: wgpu::TextureFormat::R32Float, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
                            let zbuf = d.create_texture(&wgpu::TextureDescriptor { label: Some("projector z"), size: ext, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
                                format: DEPTH, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
                            let view = color.create_view(&Default::default());
                            let cam = d.create_buffer(&wgpu::BufferDescriptor { label: Some("projector cam"), size: 96, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
                            let mut cv = mul(&GL_TO_WGPU, &p.view).to_vec();
                            cv.extend_from_slice(&[p.eye[0], p.eye[1], p.eye[2], 1.0, 0.0, 0.0, 0.0, 0.0]);
                            gpu.queue.write_buffer(&cam, 0, &bytes(&cv));
                            let cam_bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &cam_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: cam.as_entire_binding() }] });
                            let bind = mk_depth_bind(&view);
                            depths.insert(m.id.clone(), DepthMap { view, bind, _cam: cam, cam_bind, depth: zbuf.create_view(&Default::default()), key });
                            insts.remove(&m.id);   // its prims must bind the new map
                            depth_dirty = true;
                        }
                    }
                }
            }
        }

        // Placements (cheap: a uniform write per primitive; scenes are tens to hundreds of them). A venue model under
        // a gizmo drag (E4b) is drawn moved by it (gizmo.rs Drag::matrix) until the committed scene arrives.
        if let Some(sc) = &scene {
            for m in &sc.models {
                let mm = drag.as_ref().filter(|d| d.ids.contains(&m.id)).map_or(m.matrix, |d| mul(&d.matrix(), &m.matrix));
                match &m.kind {
                    ModelKind::Glb(path) => if let Some(Some(g)) = glbs.get(path) {
                        let list = insts.entry(m.id.clone()).or_insert_with(|| g.prims.iter().map(|_| { let ub = obj_ub(); let bind = obj_bind(&ub, &white_view); PrimInst { ub, bind, key: (i32::MIN, 0) } }).collect());
                        for (p, inst) in g.prims.iter().zip(list.iter_mut()) {
                            let world = mul(&mm, &p.local);
                            // Which source this mesh shows (the editor's choice), or its own material.
                            let src = m.content.as_ref().and_then(|c| {
                                let k = *c.mesh.get(p.slot)?;
                                if k < 0 { None } else { c.src.get(k as usize).map(|s| (k, s)) }
                            });
                            match src {
                                None => {
                                    if inst.key != (-1, 0) {
                                        inst.key = (-1, 0);
                                        inst.bind = obj_bind(&inst.ub, p.image.and_then(|i| g.texs.get(i)).unwrap_or(&white_view));
                                    }
                                    write_obj(&inst.ub, &world, p.color, [p.image.is_some() as u32 as f32, p.unlit as u32 as f32, 1.0, 0.0]);
                                }
                                Some((k, s)) => {
                                    let gen = s.surface.as_deref().and_then(|sid| ensure_pic(&gpu, &mut plane_tex, &pics, sid));
                                    let key = (k, gen.unwrap_or(u64::MAX));
                                    if inst.key != key {
                                        inst.key = key;
                                        let view = match (gen, &s.surface) { (Some(_), Some(sid)) => plane_tex[sid].1.create_view(&Default::default()), _ => white.create_view(&Default::default()) };
                                        inst.bind = obj_bind(&inst.ub, &view);
                                    }
                                    let has = gen.is_some();
                                    // Unlit, as the editor's content material: the picture at the colour it is sent;
                                    // no picture → the editor's #161616 stand-in (linear 0.008).
                                    let color = if has { [1.0; 4] } else { [0.008, 0.008, 0.008, 1.0] };
                                    let proj = s.proj.as_ref().map(|pj| (pj, pj.occlude && depths.contains_key(&m.id)));
                                    write_obj_p(&inst.ub, &world, color, [has as u32 as f32, 1.0, 1.0, 0.0], proj);
                                }
                            }
                        }
                    },
                    ModelKind::Plane { surface, w, h } => {
                        let gen = surface.as_deref().and_then(|sid| ensure_pic(&gpu, &mut plane_tex, &pics, sid));
                        let entry = planes.entry(m.id.clone()).or_insert_with(|| { let ub = obj_ub(); let bind = obj_bind(&ub, &white_view); PlaneGpu { ub, bind, pic_gen: u64::MAX } });
                        let g0 = gen.unwrap_or(0);
                        if entry.pic_gen != g0 {
                            entry.pic_gen = g0;
                            let view = match (gen, surface) { (Some(_), Some(sid)) => plane_tex[sid].1.create_view(&Default::default()), _ => white.create_view(&Default::default()) };
                            entry.bind = obj_bind(&entry.ub, &view);
                        }
                        let sm = mul(&mm, &[*w, 0., 0., 0., 0., *h, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
                        // Unlit, like the editor's MeshBasicMaterial: content shows at the colour it is sent.
                        let has = gen.is_some();
                        // No picture: the editor's #161616, in LINEAR (the target is sRGB — 0.086 came out mid-grey).
                        write_obj(&entry.ub, &sm, if has { [1.0; 4] } else { [0.008, 0.008, 0.008, 1.0] }, [has as u32 as f32, 1.0, 1.0, 0.0]);
                    }
                }
            }
        }

        // D0: the frame's stages — `v.prep` (everything up to here: scene, beams, LED gather, placements), `v.acquire`
        // (the swapchain image: the vsync wait lives here, so `frame` alone said little), `v.encode` (passes to submit).
        crate::prof::add("v.prep", frame_at.elapsed());
        let acquire_at = std::time::Instant::now();
        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => { std::thread::sleep(Duration::from_millis(8)); continue; }
            _ => { configured = None; continue; }
        };
        crate::prof::add("v.acquire", acquire_at.elapsed());
        let encode_at = std::time::Instant::now();
        let view = frame.texture.create_view(&Default::default());
        let (msaa, depth) = targets.as_ref().unwrap();
        let mut enc = d.create_command_encoder(&Default::default());

        // E4b: the spots' shadow maps (Rendered): every caster seen from each spot — the venue meshes that wear their
        // own material (a picture is a MeshBasic screen in the editor: no shadow), and the heads' housings.
        if shadow_n > 0 && shadow_draw {
            let shadow_at = std::time::Instant::now();
            if let Some(sc) = &scene {
                for k in 0..shadow_n {
                    let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("spot shadow"), color_attachments: &[],
                        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &shadow_layers[k], depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
                        ..Default::default()
                    });
                    pass.set_pipeline(&shadow_pipe);
                    pass.set_bind_group(0, &shadow_cams[k].1, &[]);
                    for m in &sc.models {
                        if let ModelKind::Glb(path) = &m.kind {
                            if let (Some(Some(g)), Some(list)) = (glbs.get(path), insts.get(&m.id)) {
                                for (p, inst) in g.prims.iter().zip(list) {
                                    if p.unlit || inst.key.0 >= 0 { continue; }
                                    pass.set_bind_group(1, &inst.bind, &[]);
                                    pass.set_vertex_buffer(0, p.vb.slice(..));
                                    pass.set_index_buffer(p.ib.slice(..), wgpu::IndexFormat::Uint32);
                                    pass.draw_indexed(0..p.n, 0, 0..1);
                                }
                            }
                        }
                    }
                    for (_, b) in &lights {
                        pass.set_bind_group(1, b, &[]);
                        pass.set_vertex_buffer(0, cube.0.slice(..));
                        pass.set_index_buffer(cube.1.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..cube.2, 0, 0..1);
                    }
                }
            }
            // The shadow maps' share of the CPU encode, and how often they are redrawn (the count) — their GPU cost is
            // judged on the machine's load with ARTLUX_VIEW3D_SHADOWS=0 against it.
            crate::prof::add("v.shadow", shadow_at.elapsed());
        }

        // The projectors' depth maps, before the view: every caster (venue files and screens, as the
        // editor's projectorDepth.ts registers them) seen from each projector. Only when something moved.
        if depth_dirty && !depths.is_empty() {
            if let Some(sc) = &scene {
                for dm in depths.values() {
                    let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("projector depth"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &dm.view, depth_slice: None, resolve_target: None,
                            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 1e9, g: 0.0, b: 0.0, a: 1.0 }), store: wgpu::StoreOp::Store } })],
                        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &dm.depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
                        ..Default::default()
                    });
                    pass.set_pipeline(&depth_pipe);
                    pass.set_bind_group(0, &dm.cam_bind, &[]);
                    for m in &sc.models {
                        match &m.kind {
                            ModelKind::Glb(path) => if let (Some(Some(g)), Some(list)) = (glbs.get(path), insts.get(&m.id)) {
                                for (p, inst) in g.prims.iter().zip(list) {
                                    pass.set_bind_group(1, &inst.bind, &[]);
                                    pass.set_vertex_buffer(0, p.vb.slice(..));
                                    pass.set_index_buffer(p.ib.slice(..), wgpu::IndexFormat::Uint32);
                                    pass.draw_indexed(0..p.n, 0, 0..1);
                                }
                            },
                            ModelKind::Plane { .. } => if let Some(pg) = planes.get(&m.id) {
                                pass.set_bind_group(1, &pg.bind, &[]);
                                pass.set_vertex_buffer(0, quad.0.slice(..));
                                pass.set_index_buffer(quad.1.slice(..), wgpu::IndexFormat::Uint32);
                                pass.draw_indexed(0..6, 0, 0..1);
                            },
                        }
                    }
                }
            }
            depth_dirty = false;
        }
        {
            let bg = 0.008;   // #0d0d0d-ish in linear, the editor's background
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("view3d"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: msaa, depth_slice: None, resolve_target: post.hdr(),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: bg, g: bg, b: bg, a: 1.0 }), store: wgpu::StoreOp::Discard } })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
                ..Default::default()
            });
            pass.set_bind_group(0, &cam_bind, &[]);
            pass.set_pipeline(&mesh_pipe);
            pass.set_bind_group(2, &no_depth_bind, &[]);
            pass.set_bind_group(3, &light_bind, &[]);
            // Rendered's floor, under everything.
            if look.rendered {
                pass.set_bind_group(1, &floor_bind, &[]);
                pass.set_vertex_buffer(0, quad.0.slice(..));
                pass.set_index_buffer(quad.1.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..6, 0, 0..1);
            }
            if let Some(sc) = &scene {
                for m in &sc.models {
                    match &m.kind {
                        ModelKind::Glb(path) => if let (Some(Some(g)), Some(list)) = (glbs.get(path), insts.get(&m.id)) {
                            pass.set_bind_group(2, depths.get(&m.id).map_or(&no_depth_bind, |dm| &dm.bind), &[]);
                            for (p, inst) in g.prims.iter().zip(list) {
                                pass.set_bind_group(1, &inst.bind, &[]);
                                pass.set_vertex_buffer(0, p.vb.slice(..));
                                pass.set_index_buffer(p.ib.slice(..), wgpu::IndexFormat::Uint32);
                                pass.draw_indexed(0..p.n, 0, 0..1);
                            }
                            pass.set_bind_group(2, &no_depth_bind, &[]);
                        },
                        ModelKind::Plane { .. } => if let Some(pg) = planes.get(&m.id) {
                            pass.set_bind_group(1, &pg.bind, &[]);
                            pass.set_vertex_buffer(0, quad.0.slice(..));
                            pass.set_index_buffer(quad.1.slice(..), wgpu::IndexFormat::Uint32);
                            pass.draw_indexed(0..6, 0, 0..1);
                        },
                    }
                }
            }
            for (_, b) in &lights {
                pass.set_bind_group(1, b, &[]);
                pass.set_vertex_buffer(0, cube.0.slice(..));
                pass.set_index_buffer(cube.1.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..cube.2, 0, 0..1);
            }
            if let Some((pb, cb, n)) = &led_bufs {
                pass.set_pipeline(&led_pipe);
                pass.set_vertex_buffer(0, pb.slice(..));
                pass.set_vertex_buffer(1, cb.slice(..));
                pass.draw(0..6, 0..*n);
            }
            if let (Some(ib), true) = (&cone_inst, n_cones > 0) {
                pass.set_pipeline(&beam_pipe);
                pass.set_vertex_buffer(0, cone.0.slice(..));
                pass.set_vertex_buffer(1, ib.slice(..));
                pass.set_index_buffer(cone.1.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..cone.2, 0, 0..n_cones);
            }
            if let (Some(lb), true) = (&beam_lines, n_beam_verts > 0) {
                pass.set_pipeline(&flat_line_pipe);
                pass.set_vertex_buffer(0, lb.slice(..));
                pass.draw(0..n_beam_verts, 0..1);
            }
            if scene.as_ref().is_none_or(|s| s.grid.visible) {
                if let Some((gb, n)) = &grid_lines {
                    pass.set_pipeline(&flat_line_pipe);
                    pass.set_vertex_buffer(0, gb.slice(..));
                    pass.draw(0..*n, 0..1);
                }
            }
            if let (Some(lb), Some(bind), true) = (&label_buf, &label_bind, n_label_verts > 0) {
                pass.set_pipeline(&label_pipe);
                pass.set_bind_group(1, bind, &[]);
                pass.set_vertex_buffer(0, lb.slice(..));
                pass.draw(0..n_label_verts, 0..1);
            }
            if let Some((ob, n)) = &overlay {
                pass.set_pipeline(&flat_line_pipe);
                pass.set_vertex_buffer(0, ob.slice(..));
                pass.draw(0..*n, 0..1);
            }
            if let Some((ob, n)) = &model_outline {
                pass.set_pipeline(&flat_line_pipe);
                pass.set_vertex_buffer(0, ob.slice(..));
                pass.draw(0..*n, 0..1);
            }
            if let (Some(gb), true) = (&gnomon_buf, n_gnomon > 0) {
                pass.set_pipeline(&handle_pipe);
                pass.set_vertex_buffer(0, gb.slice(..));
                pass.draw(0..n_gnomon, 0..1);
            }
            if let (Some(hb), true) = (&handle_buf, n_handle_verts > 0) {
                pass.set_pipeline(&handle_pipe);
                pass.set_vertex_buffer(0, hb.slice(..));
                pass.draw(0..n_handle_verts, 0..1);
            }
        }
        // Rendered: ambient occlusion from the pass's own depth, laid into the frame before the bloom (ao.rs).
        if look.rendered {
            if let (Some(hdr), Some(lit)) = (post.hdr(), post.lit()) {
                ao.run(d, &gpu.queue, &mut enc, depth, depth_gen, hdr, lit, size.width, size.height, cam.fov, 0.03, 4000.0);
            }
        }
        // The last step: bloom + AgX in Rendered, a straight copy in Shaded (post.rs).
        post.finish(&gpu.queue, &mut enc, &view, look.rendered);
        gpu.queue.submit([enc.finish()]);
        crate::prof::add("v.encode", encode_at.elapsed());
        window.pre_present_notify();
        gpu.queue.present(frame);   // wgpu 30: presenting is the queue's, after the submit
        last_key = key; last_present = std::time::Instant::now();
        crate::prof::add("frame", frame_at.elapsed());
        crate::prof::report("view3d");
    }
}

fn buf_init(gpu: &Gpu, label: &str, data: &[u8], usage: wgpu::BufferUsages) -> wgpu::Buffer {
    let size = (data.len().max(4) as u64 + 3) & !3;
    let b = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: usage | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let mut padded = data.to_vec(); padded.resize(size as usize, 0);
    gpu.queue.write_buffer(&b, 0, &padded);
    b
}

fn tex_rgba(gpu: &Gpu, w: u32, h: u32, px: &[u8]) -> wgpu::Texture {
    let t = gpu.device.create_texture(&wgpu::TextureDescriptor { label: Some("view3d tex"), size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
    gpu.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, px,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) }, wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
    t
}

#[cfg(test)]
mod pick_tests {
    use super::*;
    fn scene() -> Scene {
        Scene {
            models: Vec::new(),
            // A strip along X at y = 2, z = 0, and a light housing in front of it (nearer the camera at +Z).
            leds: vec![LedFix { id: "strip".into(), pos: (0..10).flat_map(|i| [i as f32 * 0.1 - 0.5, 2.0, 0.0]).collect() }],
            lights: vec![LightFix { id: "head".into(), pos: [0.2, 2.0, 2.0], beam: None }],
            lines: Vec::new(), look: BeamLook::default(), grid: GridLook::default(), gizmo: None, selected_model: None,
        }
    }
    #[test]
    fn a_click_picks_the_nearest_body() {
        let sc = scene();
        let cam = Cam::from_pose([0.0, 2.0, 10.0], [0.0, 2.0, 0.0], 50.0);
        let (w, h) = (1000.0, 600.0);
        let px = 2.0 * (25f32).to_radians().tan() / h;
        // Through the middle: the strip (the housing sits 0.2 m to the right).
        let (o, d) = cam.ray(500.0, 300.0, w, h);
        assert_eq!(pick(&sc, o, d, px).as_deref(), Some("strip"));
        // Aimed at the housing: it is NEARER than the strip behind it, so it wins.
        let (o, d) = (cam.eye(), norm(sub([0.2, 2.0, 2.0], cam.eye())));
        assert_eq!(pick(&sc, o, d, px).as_deref(), Some("head"));
        // Well above both: nothing.
        let (o, d) = cam.ray(500.0, 40.0, w, h);
        assert_eq!(pick(&sc, o, d, px), None);
    }
    #[test]
    fn the_ray_under_the_centre_is_the_view_axis() {
        let cam = Cam::from_pose([3.0, 4.0, 5.0], [0.0, 1.0, 0.0], 40.0);
        let (o, d) = cam.ray(400.0, 300.0, 800.0, 600.0);
        let f = norm(sub([0.0, 1.0, 0.0], cam.eye()));
        assert!(len(sub(o, cam.eye())) < 1e-5 && len(sub(d, f)) < 1e-5);
    }
}

#[cfg(test)]
mod place_tests {
    use super::*;
    #[test]
    fn a_saved_place_is_used_only_while_its_screen_exists() {
        let two = [(0, 0, 2560, 1440), (2560, 0, 1920, 1080)];
        let on_second = Place { x: 2700, y: 100, w: 1280, h: 760, max: false };
        assert!(on_second.on_screen(&two));
        assert!(!on_second.on_screen(&two[..1]), "the second screen unplugged: back to the default");
        // Mostly off the left edge, but its title strip's middle still on screen: kept.
        assert!(Place { x: -500, y: 10, w: 1280, h: 760, max: false }.on_screen(&two[..1]));
        // Its title bar above every screen: not grabbable.
        assert!(!Place { x: 100, y: -300, w: 1280, h: 760, max: false }.on_screen(&two));
        let back = Place::from_json(&serde_json::from_str(&on_second.to_json()).unwrap()).unwrap();
        assert_eq!(back, on_second);
        assert!(Place::from_json(&serde_json::json!({"x": 0, "y": 0, "w": 10, "h": 10})).is_none(), "a degenerate size is refused");
    }
}

#[cfg(test)]
mod model_pick_tests {
    use super::*;
    #[test]
    fn a_fixture_on_a_screen_wins_and_the_screen_alone_is_picked() {
        // A 4 × 2 m screen facing +Z at z = 0, an LED strip mounted 2 cm in front of it.
        let screen = Model { id: "scr".into(), kind: ModelKind::Plane { surface: None, w: 4.0, h: 2.0 }, matrix: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 1., 0., 1.], content: None };
        let sc = Scene {
            models: vec![screen],
            leds: vec![LedFix { id: "strip".into(), pos: (0..10).flat_map(|i| [i as f32 * 0.2 - 1.0, 1.0, 0.02]).collect() }],
            lights: Vec::new(), lines: Vec::new(), look: BeamLook::default(), grid: GridLook::default(), gizmo: None, selected_model: None,
        };
        let meshes = HashMap::new();
        let px = 0.001;
        let eye = [0.0, 1.0, 8.0];
        let toward = |p: [f32; 3]| norm(sub(p, eye));
        // Through the strip: the fixture, though the screen is hit too.
        assert_eq!(pick_any(&sc, &meshes, eye, toward([0.3, 1.0, 0.0]), px), Some(Picked::Fixture("strip".into())));
        // The screen above the strip: the model.
        assert_eq!(pick_any(&sc, &meshes, eye, toward([0.3, 1.7, 0.0]), px), Some(Picked::Model("scr".into())));
        // Past its edge: nothing.
        assert_eq!(pick_any(&sc, &meshes, eye, toward([2.5, 1.7, 0.0]), px), None);
        let (lo, hi) = model_bounds(&sc.models[0], &meshes).unwrap();
        assert_eq!((lo, hi), ([-2.0, 0.0, 0.0], [2.0, 2.0, 0.0]));
    }
}
