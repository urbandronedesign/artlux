//! E4b — THE GIZMO in the engine's 3D view: Move, Rotate and Scale (the editor's Simulator3D/FixtureGizmo.tsx).
//!
//! THE EDITOR STILL TRANSFORMS THE FIXTURES. The engine draws the handles where the editor's own gizmo anchors them
//! (the selection's centroid; the handle axes the editor's TransformControls would use — engineView.tsx sends them),
//! reads a drag on one handle, and streams the GESTURE to the editor (`view3dGizmo` start / move / end): an offset,
//! a rotation and a per-axis scale, which the editor composes onto its anchor and turns into the transform with the
//! same `gizmoDelta` its own handles use — previewed, one undo step, one commit. One implementation of "what a drag
//! means". While the drag runs this window transforms the selection's drawing itself (`Drag::apply`), because the
//! scene it draws from only follows committed positions; that is dropped once a scene arrives after the release.
//!
//! Handles are a fixed size ON SCREEN (GIZMO_PX), drawn over everything like three's, and picked in screen space:
//!   - Move: an arrow per axis; the pull is the closest approach of the cursor's ray to the axis line;
//!   - Rotate: a ring per axis; the turn is the angle swept about the axis where the cursor's ray meets the ring's
//!     plane (unwrapped, so a drag past half a turn keeps counting);
//!   - Scale: a shaft with a square end per axis, always in the anchor's own frame (three refuses to world-align
//!     scale handles); the factor is how far along the axis the cursor is now over where it was grabbed.
//! Snapping follows three's: a room-aligned move lands the anchor's coordinate on the step (an object-aligned one
//! snaps the distance), a turn snaps its angle, a scale its factor.

/// Which tool the editor has: the handles drawn and what a drag on them means.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode { Move, Rotate, Scale }

/// What the editor asks for: the tool, the anchor, the handles' orientation (x y z w), and the snap for this tool
/// (metres, degrees or a factor step), if on.
#[derive(Clone, Copy, Debug)]
pub struct Gizmo { pub mode: Mode, pub at: [f32; 3], pub q: [f32; 4], pub snap: Option<f32>, pub model: bool }

impl Gizmo {
    pub fn from_json(v: &serde_json::Value) -> Option<Gizmo> {
        let a = |k: &str, n: usize| -> Option<Vec<f32>> { let x = v[k].as_array()?; (x.len() == n).then(|| x.iter().map(|e| e.as_f64().unwrap_or(0.0) as f32).collect()) };
        let at = a("at", 3)?;
        let q = a("q", 4).unwrap_or(vec![0.0, 0.0, 0.0, 1.0]);
        let mode = match v["mode"].as_str().unwrap_or("translate") { "rotate" => Mode::Rotate, "scale" => Mode::Scale, _ => Mode::Move };
        Some(Gizmo { mode, at: [at[0], at[1], at[2]], q: [q[0], q[1], q[2], q[3]], snap: v["snap"].as_f64().filter(|s| *s > 0.0).map(|s| s as f32),
            // A VENUE MODEL's handles (the editor's ModelObject / PlaneObject TransformControls), not the fixtures'.
            model: v["model"].as_bool().unwrap_or(false) })
    }
    /// The three handle directions (unit, world).
    pub fn axes(&self) -> [[f32; 3]; 3] { [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]].map(|v| rot(self.q, v)) }
}

/// A gesture so far: an offset, a rotation (x y z w, world, about the anchor) and a scale per HANDLE axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gesture { pub delta: [f32; 3], pub rot: [f32; 4], pub scale: [f32; 3] }
impl Gesture {
    pub const NONE: Gesture = Gesture { delta: [0.0; 3], rot: [0.0, 0.0, 0.0, 1.0], scale: [1.0; 3] };
    pub fn to_json(&self) -> String {
        let f = |v: &[f32]| v.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(",");
        format!(r#""delta":[{}],"rot":[{}],"scale":[{}]"#, f(&self.delta), f(&self.rot), f(&self.scale))
    }
}

/// A drag in progress, shared with the presenter: whose drawing moves, the anchor and handle frame it was grabbed
/// at, the gesture so far, the handle held, and (after the release) the scene version it ended on.
#[derive(Clone, Debug)]
pub struct Drag { pub ids: std::collections::HashSet<String>, pub at: [f32; 3], pub q: [f32; 4], pub g: Gesture, pub axis: usize, pub ended_at_scene: Option<u64> }
impl Drag {
    /// A point of the selection, transformed as the editor's gizmoDelta transforms a fixture's position: scaled in
    /// the handle frame about the anchor, turned about it, moved by the offset.
    pub fn apply(&self, p: [f32; 3]) -> [f32; 3] {
        let local = rot(conj(self.q), sub(p, self.at));
        let scaled = [local[0] * self.g.scale[0], local[1] * self.g.scale[1], local[2] * self.g.scale[2]];
        add(add(self.at, rot(self.g.rot, rot(self.q, scaled))), self.g.delta)
    }
    /// A body's orientation turned by the gesture (a beam's base rotation).
    pub fn turn(&self, q: [f32; 4]) -> [f32; 4] { qmul(self.g.rot, q) }
    /// The gesture as a matrix (column-major), for a venue model's world matrix: M' = this · M.
    pub fn matrix(&self) -> [f32; 16] {
        let o = self.apply([0.0; 3]);
        let col = |e: [f32; 3]| sub(self.apply(e), o);
        let (x, y, z) = (col([1.0, 0.0, 0.0]), col([0.0, 1.0, 0.0]), col([0.0, 0.0, 1.0]));
        [x[0], x[1], x[2], 0.0, y[0], y[1], y[2], 0.0, z[0], z[1], z[2], 0.0, o[0], o[1], o[2], 1.0]
    }
}

pub const GIZMO_PX: f32 = 90.0;
pub const GRAB_PX: f32 = 10.0;
const RING_SEG: usize = 64;
/// X red, Y green, Z blue (three's TransformControls hues, linear), and the hovered / held handle in yellow.
pub const COLORS: [[f32; 3]; 3] = [[0.9, 0.08, 0.1], [0.12, 0.75, 0.15], [0.1, 0.25, 0.95]];
pub const HOT: [f32; 3] = [1.0, 0.85, 0.1];

fn rot(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let u = [q[0], q[1], q[2]];
    let t = cross(u, v).map(|x| 2.0 * x);
    let ct = cross(u, t);
    [v[0] + q[3] * t[0] + ct[0], v[1] + q[3] * t[1] + ct[1], v[2] + q[3] * t[2] + ct[2]]
}
fn conj(q: [f32; 4]) -> [f32; 4] { [-q[0], -q[1], -q[2], q[3]] }
fn qmul(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
     a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
     a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
     a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
}
pub fn axis_angle(u: [f32; 3], a: f32) -> [f32; 4] { let s = (a / 2.0).sin(); [u[0] * s, u[1] * s, u[2] * s, (a / 2.0).cos()] }
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn scale(a: [f32; 3], s: f32) -> [f32; 3] { a.map(|x| x * s) }
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn len(a: [f32; 3]) -> f32 { dot(a, a).sqrt() }
fn norm(a: [f32; 3]) -> [f32; 3] { let l = len(a); if l > 1e-9 { scale(a, 1.0 / l) } else { a } }

/// World length of a handle: GIZMO_PX on screen at the anchor's distance (`px` = world units per pixel at 1 m).
pub fn handle_len(at: [f32; 3], eye: [f32; 3], px: f32) -> f32 { GIZMO_PX * px * len(sub(at, eye)).max(0.05) }

/// A ring's points: radius r about `at`, in the plane normal to `n`.
fn ring(at: [f32; 3], n: [f32; 3], r: f32) -> Vec<[f32; 3]> {
    let a = norm(if n[0].abs() < 0.9 { cross(n, [1.0, 0.0, 0.0]) } else { cross(n, [0.0, 1.0, 0.0]) });
    let b = cross(n, a);
    (0..=RING_SEG).map(|i| { let t = i as f32 / RING_SEG as f32 * std::f32::consts::TAU; add(at, add(scale(a, r * t.cos()), scale(b, r * t.sin()))) }).collect()
}

/// Which handle is under the cursor (window pixels x, y in a w × h window, `vp` column-major WebGPU clip): within
/// GRAB_PX of a drawn shaft or ring, the nearest. Axes seen end-on cannot be grabbed (a drag along one means nothing).
pub fn hit(g: &Gizmo, vp: &[f32; 16], eye: [f32; 3], px: f32, w: f32, h: f32, x: f32, y: f32) -> Option<usize> {
    let screen = |p: [f32; 3]| -> Option<[f32; 2]> {
        let cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
        let cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
        let cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
        (cw > 1e-4).then(|| [(cx / cw + 1.0) * 0.5 * w, (1.0 - cy / cw) * 0.5 * h])
    };
    let seg_gap = |a: [f32; 2], b: [f32; 2], from: f32| -> Option<f32> {
        let (ux, uy) = (b[0] - a[0], b[1] - a[1]);
        let ll = ux * ux + uy * uy;
        if ll < 1e-6 { return None; }
        let t = (((x - a[0]) * ux + (y - a[1]) * uy) / ll).clamp(0.0, 1.0);
        if t < from { return None; }
        Some(((a[0] + ux * t - x).powi(2) + (a[1] + uy * t - y).powi(2)).sqrt())
    };
    let l = handle_len(g.at, eye, px);
    let a = screen(g.at)?;
    let mut best: Option<(f32, usize)> = None;
    for (i, d) in g.axes().iter().enumerate() {
        let gap = if g.mode == Mode::Rotate {
            let pts: Vec<[f32; 2]> = ring(g.at, *d, l).into_iter().filter_map(screen).collect();
            pts.windows(2).filter_map(|w2| seg_gap(w2[0], w2[1], 0.0)).fold(None, |m: Option<f32>, v| Some(m.map_or(v, |m| m.min(v))))
        } else {
            let Some(b) = screen(add(g.at, scale(*d, l))) else { continue };
            if (b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) < 64.0 { continue; }   // end-on
            seg_gap(a, b, 0.2)   // not the centre, where all three meet
        };
        if let Some(gap) = gap { if gap <= GRAB_PX && best.is_none_or(|bb| gap < bb.0) { best = Some((gap, i)); } }
    }
    best.map(|b| b.1)
}

/// Where along the line p + s·u the ray o + t·d passes closest (u, d unit).
pub fn along(p: [f32; 3], u: [f32; 3], o: [f32; 3], d: [f32; 3]) -> Option<f32> {
    let w0 = sub(p, o);
    let (b, dd, e) = (dot(u, d), dot(u, w0), dot(d, w0));
    let den = 1.0 - b * b;
    if den.abs() < 1e-5 { return None; }
    Some((b * e - dd) / den)
}

/// Where the ray meets the plane through p with normal n.
fn on_plane(p: [f32; 3], n: [f32; 3], o: [f32; 3], d: [f32; 3]) -> Option<[f32; 3]> {
    let den = dot(n, d);
    if den.abs() < 1e-5 { return None; }
    let t = dot(n, sub(p, o)) / den;
    (t > 0.0).then(|| add(o, scale(d, t)))
}

/// What the cursor's ray reads on handle `axis`: a distance along it (Move, Scale) or an angle about it (Rotate).
pub fn reading(g: &Gizmo, axis: usize, o: [f32; 3], d: [f32; 3]) -> Option<f32> {
    let n = g.axes()[axis];
    match g.mode {
        Mode::Move | Mode::Scale => along(g.at, n, o, d),
        Mode::Rotate => {
            let h = on_plane(g.at, n, o, d)?;
            let v = sub(h, g.at);
            if len(v) < 1e-6 { return None; }
            // An angle in the ring's own frame (the same frame `ring` draws in).
            let a = norm(if n[0].abs() < 0.9 { cross(n, [1.0, 0.0, 0.0]) } else { cross(n, [0.0, 1.0, 0.0]) });
            let b = cross(n, a);
            Some(dot(v, b).atan2(dot(v, a)))
        }
    }
}

/// The gesture a drag from reading `r0` to `r1` on handle `axis` means. For Rotate the readings are angles, already
/// unwrapped by the caller; for Scale, distances from the anchor.
pub fn gesture(g: &Gizmo, axis: usize, r0: f32, r1: f32) -> Gesture {
    let dir = g.axes()[axis];
    match g.mode {
        Mode::Move => {
            let s = r1 - r0;
            let delta = match g.snap {
                None => scale(dir, s),
                Some(step) if (dir[axis].abs() - 1.0).abs() < 1e-4 => {
                    let target = ((g.at[axis] + dir[axis] * s) / step).round() * step;
                    let mut o = [0.0; 3];
                    o[axis] = target - g.at[axis];
                    o
                }
                Some(step) => scale(dir, (s / step).round() * step),
            };
            Gesture { delta, ..Gesture::NONE }
        }
        Mode::Rotate => {
            let mut a = r1 - r0;
            if let Some(step) = g.snap { let st = step.to_radians(); a = (a / st).round() * st; }
            Gesture { rot: axis_angle(dir, a), ..Gesture::NONE }
        }
        Mode::Scale => {
            if r0.abs() < 1e-6 { return Gesture::NONE; }
            let mut f = r1 / r0;
            if let Some(step) = g.snap { f = (f / step).round() * step; }
            let mut s = [1.0; 3];
            s[axis] = f.max(0.001);
            Gesture { scale: s, ..Gesture::NONE }
        }
    }
}

/// The handles' triangles, x y z r g b a per vertex, `hot` in yellow: per axis a screen-facing ribbon SHAFT_PX wide
/// and an arrowhead (Move) or a square end (Scale), or a ring (Rotate).
pub fn geometry(g: &Gizmo, eye: [f32; 3], px: f32, hot: Option<usize>) -> Vec<f32> {
    const SHAFT_PX: f32 = 3.0;
    const HEAD_PX: f32 = 9.0;
    fn tri(v: &mut Vec<f32>, c: [f32; 3], ps: [[f32; 3]; 3]) {
        for p in ps { v.extend_from_slice(&[p[0], p[1], p[2], c[0], c[1], c[2], 1.0]); }
    }
    /// A ribbon from a to b, `w` world units wide, facing the eye.
    fn ribbon(v: &mut Vec<f32>, c: [f32; 3], eye: [f32; 3], a: [f32; 3], b: [f32; 3], w: f32) {
        let side = cross(sub(b, a), sub(a, eye));
        let sl = len(side);
        if sl < 1e-9 { return; }
        let s = scale(side, w * 0.5 / sl);
        tri(v, c, [sub(a, s), add(a, s), add(b, s)]);
        tri(v, c, [sub(a, s), add(b, s), sub(b, s)]);
    }
    let mut v = Vec::new();
    let l = handle_len(g.at, eye, px);
    let per_px = px * len(sub(g.at, eye)).max(0.05);
    for (i, d) in g.axes().iter().enumerate() {
        let c = if hot == Some(i) { HOT } else { COLORS[i] };
        let tip = add(g.at, scale(*d, l));
        match g.mode {
            Mode::Rotate => for w2 in ring(g.at, *d, l).windows(2) { ribbon(&mut v, c, eye, w2[0], w2[1], SHAFT_PX * per_px); },
            Mode::Move => {
                let neck = add(g.at, scale(*d, l * 0.78));
                ribbon(&mut v, c, eye, g.at, neck, SHAFT_PX * per_px);
                // The arrowhead: a triangle across the shaft, facing the eye.
                let side = cross(*d, sub(g.at, eye));
                let sl = len(side);
                if sl > 1e-9 { let hw = scale(side, HEAD_PX * 0.5 * per_px / sl); tri(&mut v, c, [sub(neck, hw), add(neck, hw), tip]); }
            }
            Mode::Scale => {
                let neck = add(g.at, scale(*d, l * 0.9));
                ribbon(&mut v, c, eye, g.at, neck, SHAFT_PX * per_px);
                ribbon(&mut v, c, eye, neck, tip, HEAD_PX * per_px);   // the square end
            }
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
    fn ray_to(eye: [f32; 3], p: [f32; 3]) -> ([f32; 3], [f32; 3]) { (eye, norm(sub(p, eye))) }
    #[test]
    fn a_pull_along_x_reads_as_the_distance_pulled() {
        let g = Gizmo { mode: Mode::Move, at: [1.0, 2.0, 0.0], q: ID, snap: None, model: false };
        let eye = [1.0, 2.0, 10.0];
        let (o0, d0) = ray_to(eye, [1.2, 2.0, 0.0]);
        let (o1, d1) = ray_to(eye, [1.7, 2.0, 0.0]);
        let (r0, r1) = (reading(&g, 0, o0, d0).unwrap(), reading(&g, 0, o1, d1).unwrap());
        let ge = gesture(&g, 0, r0, r1);
        assert!((ge.delta[0] - 0.5).abs() < 1e-4 && ge.delta[1] == 0.0 && ge.delta[2] == 0.0, "{ge:?}");
    }
    #[test]
    fn snapping_lands_the_anchor_on_the_step() {
        let g = Gizmo { mode: Mode::Move, at: [1.03, 2.0, 0.0], q: ID, snap: Some(0.25), model: false };
        let o = gesture(&g, 0, 0.0, 0.4).delta;
        assert!(((g.at[0] + o[0]) - 1.5).abs() < 1e-5, "{o:?}");
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let t = Gizmo { q: [0.0, s, 0.0, s], ..g };
        assert!((len(gesture(&t, 0, 0.0, 0.4).delta) - 0.5).abs() < 1e-5);
    }
    #[test]
    fn a_quarter_turn_about_y_and_its_snap() {
        let g = Gizmo { mode: Mode::Rotate, at: [0.0; 3], q: ID, snap: None, model: false };
        // Looking down from above: the ray meets the floor-plane ring; a quarter turn of the cursor about Y.
        let eye = [0.0, 10.0, 0.0];
        let (o0, d0) = ray_to(eye, [1.0, 0.0, 0.0]);
        let (o1, d1) = ray_to(eye, [0.0, 0.0, -1.0]);
        let (r0, r1) = (reading(&g, 1, o0, d0).unwrap(), reading(&g, 1, o1, d1).unwrap());
        let ge = gesture(&g, 1, r0, r1);
        // +X turned by the gesture lands on −Z (a +90° turn about +Y).
        let p = rot(ge.rot, [1.0, 0.0, 0.0]);
        assert!(len(sub(p, [0.0, 0.0, -1.0])) < 1e-4, "{p:?}");
        let snapped = gesture(&Gizmo { snap: Some(15.0), ..g }, 1, 0.0, 0.20);   // 11.5° → 15°
        assert!((2.0 * snapped.rot[3].acos() - 15f32.to_radians()).abs() < 1e-4);
    }
    #[test]
    fn scale_is_the_ratio_along_the_axis_and_apply_spreads_about_the_anchor() {
        let g = Gizmo { mode: Mode::Scale, at: [0.0; 3], q: ID, snap: Some(0.1), model: false };
        let ge = gesture(&g, 0, 0.5, 1.04);   // ×2.08 → snapped to ×2.1
        assert!((ge.scale[0] - 2.1).abs() < 1e-5 && ge.scale[1] == 1.0);
        let dr = Drag { ids: Default::default(), at: [1.0, 0.0, 0.0], q: ID, g: ge, axis: 0, ended_at_scene: None };
        let p = dr.apply([2.0, 3.0, 0.0]);
        assert!(len(sub(p, [3.1, 3.0, 0.0])) < 1e-5, "{p:?}");
        // The same transform as a matrix (a venue model's).
        let m = dr.matrix();
        let q = [m[0] * 2.0 + m[4] * 3.0 + m[12], m[1] * 2.0 + m[5] * 3.0 + m[13], m[2] * 2.0 + m[6] * 3.0 + m[14]];
        assert!(len(sub(q, p)) < 1e-5, "{q:?}");
    }
    #[test]
    fn the_handle_under_the_cursor_is_found_in_screen_space() {
        let cam = crate::view3d::Cam::from_pose([0.0, 0.0, 10.0], [0.0, 0.0, 0.0], 50.0);
        let (vp, _, _) = crate::view3d::camera_frame(&cam, 1.0);
        let px = 2.0 * (25f32).to_radians().tan() / 800.0;
        let g = Gizmo { mode: Mode::Move, at: [0.0; 3], q: ID, snap: None, model: false };
        assert_eq!(hit(&g, &vp, cam.eye(), px, 800.0, 800.0, 460.0, 400.0), Some(0));
        assert_eq!(hit(&g, &vp, cam.eye(), px, 800.0, 800.0, 400.0, 340.0), Some(1));
        assert_eq!(hit(&g, &vp, cam.eye(), px, 800.0, 800.0, 460.0, 460.0), None);
        // Rotate: Z's ring faces the camera — a point on its circle (90 px out) grabs it.
        let r = Gizmo { mode: Mode::Rotate, ..g };
        assert_eq!(hit(&r, &vp, cam.eye(), px, 800.0, 800.0, 400.0 + 63.6, 400.0 - 63.6), Some(2));
        for m in [Mode::Move, Mode::Rotate, Mode::Scale] { assert!(!geometry(&Gizmo { mode: m, ..g }, cam.eye(), px, Some(0)).is_empty()); }
    }
}
