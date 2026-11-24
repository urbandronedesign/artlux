//! E4b — THE MOVE GIZMO in the engine's 3D view (the editor's Simulator3D/FixtureGizmo.tsx, translate mode).
//!
//! THE EDITOR STILL MOVES THE FIXTURES. The engine draws the handles where the editor's own gizmo anchors them
//! (the selection's centroid; the room's axes, or the active fixture's with "Object" axes — engineView.tsx sends
//! both), reads a drag along one axis, and streams the OFFSET to the editor (`view3dGizmo` start / move / end).
//! The editor turns that offset into the move with the same `gizmoDelta` its own handles use, previews it, records
//! undo on the first movement and commits once on release — one implementation of "what a drag means".
//! While the drag runs, this window moves the selection's drawing by the offset itself (`Drag`), because the scene
//! it draws from only follows committed positions; the offset is dropped once a scene arrives after the release.
//!
//! Handles are a fixed size ON SCREEN (GIZMO_PX), drawn over everything (like three's TransformControls), and
//! picked in screen space: within GRAB_PX of an axis's drawn shaft.

/// What the editor asks for: the anchor, the handles' orientation (x y z w), and the move snap (metres), if on.
#[derive(Clone, Copy, Debug)]
pub struct Gizmo { pub at: [f32; 3], pub q: [f32; 4], pub snap: Option<f32> }

impl Gizmo {
    pub fn from_json(v: &serde_json::Value) -> Option<Gizmo> {
        let a = |k: &str, n: usize| -> Option<Vec<f32>> { let x = v[k].as_array()?; (x.len() == n).then(|| x.iter().map(|e| e.as_f64().unwrap_or(0.0) as f32).collect()) };
        let at = a("at", 3)?;
        let q = a("q", 4).unwrap_or(vec![0.0, 0.0, 0.0, 1.0]);
        Some(Gizmo { at: [at[0], at[1], at[2]], q: [q[0], q[1], q[2], q[3]], snap: v["snap"].as_f64().filter(|s| *s > 0.0).map(|s| s as f32) })
    }
    /// The three handle directions (unit, world).
    pub fn axes(&self) -> [[f32; 3]; 3] {
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]].map(|v| rot(self.q, v))
    }
}

/// A drag in progress, shared with the presenter: whose drawing moves, and by how much.
#[derive(Clone, Debug)]
pub struct Drag { pub ids: std::collections::HashSet<String>, pub delta: [f32; 3], pub axis: usize, pub ended_at_scene: Option<u64> }

pub const GIZMO_PX: f32 = 90.0;
pub const GRAB_PX: f32 = 10.0;
/// X red, Y green, Z blue (three's TransformControls hues, linear), and the hovered / held handle in yellow.
pub const COLORS: [[f32; 3]; 3] = [[0.9, 0.08, 0.1], [0.12, 0.75, 0.15], [0.1, 0.25, 0.95]];
pub const HOT: [f32; 3] = [1.0, 0.85, 0.1];

fn rot(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let u = [q[0], q[1], q[2]];
    let c = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let t = c(u, v).map(|x| 2.0 * x);
    let ct = c(u, t);
    [v[0] + q[3] * t[0] + ct[0], v[1] + q[3] * t[1] + ct[1], v[2] + q[3] * t[2] + ct[2]]
}
fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn scale(a: [f32; 3], s: f32) -> [f32; 3] { a.map(|x| x * s) }
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn len(a: [f32; 3]) -> f32 { dot(a, a).sqrt() }

/// World length of a handle: GIZMO_PX on screen at the anchor's distance (`px` = world units per pixel at 1 m).
pub fn handle_len(at: [f32; 3], eye: [f32; 3], px: f32) -> f32 { GIZMO_PX * px * len(sub(at, eye)).max(0.05) }

/// Which handle is under the cursor: each shaft projected with `vp` (column-major, WebGPU clip) into a w × h
/// window, the nearest within GRAB_PX. Axes seen end-on (shorter than a few pixels on screen) cannot be grabbed —
/// a drag along them would be numerically meaningless.
pub fn hit(g: &Gizmo, vp: &[f32; 16], eye: [f32; 3], px: f32, w: f32, h: f32, x: f32, y: f32) -> Option<usize> {
    let screen = |p: [f32; 3]| -> Option<[f32; 2]> {
        let cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
        let cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
        let cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
        (cw > 1e-4).then(|| [(cx / cw + 1.0) * 0.5 * w, (1.0 - cy / cw) * 0.5 * h])
    };
    let l = handle_len(g.at, eye, px);
    let a = screen(g.at)?;
    let mut best: Option<(f32, usize)> = None;
    for (i, d) in g.axes().iter().enumerate() {
        let Some(b) = screen(add(g.at, scale(*d, l))) else { continue };
        let (ux, uy) = (b[0] - a[0], b[1] - a[1]);
        let ll = ux * ux + uy * uy;
        if ll < 64.0 { continue; }
        // Skip the first fifth (the centre, where all three meet).
        let t = (((x - a[0]) * ux + (y - a[1]) * uy) / ll).clamp(0.0, 1.0);
        if t < 0.2 { continue; }
        let gap = ((a[0] + ux * t - x).powi(2) + (a[1] + uy * t - y).powi(2)).sqrt();
        if gap <= GRAB_PX && best.is_none_or(|bb| gap < bb.0) { best = Some((gap, i)); }
    }
    best.map(|b| b.1)
}

/// Where along the line p + s·u the ray o + t·d passes closest (u, d unit). The drag reads this at the press and
/// at every move; the difference is how far the handle has been pulled.
pub fn along(p: [f32; 3], u: [f32; 3], o: [f32; 3], d: [f32; 3]) -> Option<f32> {
    let w0 = sub(p, o);
    let (b, dd, e) = (dot(u, d), dot(u, w0), dot(d, w0));
    let den = 1.0 - b * b;
    if den.abs() < 1e-5 { return None; }   // the ray runs along the axis
    Some((b * e - dd) / den)
}

/// The offset a pull of `s` metres along handle `axis` means, snapped as the editor's handles snap: along a ROOM
/// axis the anchor's coordinate lands on a multiple of the step; along an object axis the distance does.
pub fn offset(g: &Gizmo, axis: usize, s: f32) -> [f32; 3] {
    let dir = g.axes()[axis];
    let Some(step) = g.snap else { return scale(dir, s) };
    let world_aligned = (dir[axis].abs() - 1.0).abs() < 1e-4;
    if world_aligned {
        let target = ((g.at[axis] + dir[axis] * s) / step).round() * step;
        let mut o = [0.0; 3];
        o[axis] = target - g.at[axis];
        o
    } else {
        scale(dir, (s / step).round() * step)
    }
}

/// The handles' triangles, x y z r g b a per vertex: per axis a shaft (a screen-facing ribbon SHAFT_PX wide) and
/// an arrowhead, `hot` in yellow.
pub fn geometry(g: &Gizmo, eye: [f32; 3], px: f32, hot: Option<usize>) -> Vec<f32> {
    const SHAFT_PX: f32 = 3.0;
    const HEAD_PX: f32 = 9.0;
    let mut v = Vec::new();
    let l = handle_len(g.at, eye, px);
    let per_px = px * len(sub(g.at, eye)).max(0.05);
    for (i, d) in g.axes().iter().enumerate() {
        let c = if hot == Some(i) { HOT } else { COLORS[i] };
        let view = sub(g.at, eye);
        let mut side = [d[1] * view[2] - d[2] * view[1], d[2] * view[0] - d[0] * view[2], d[0] * view[1] - d[1] * view[0]];
        let sl = len(side);
        if sl < 1e-6 { continue; }   // end-on: nothing to draw
        side = scale(side, 1.0 / sl);
        let base = g.at;
        let neck = add(g.at, scale(*d, l * 0.78));
        let tip = add(g.at, scale(*d, l));
        let w = scale(side, SHAFT_PX * 0.5 * per_px);
        let hw = scale(side, HEAD_PX * 0.5 * per_px);
        let mut tri = |a: [f32; 3], b: [f32; 3], cc: [f32; 3]| {
            for p in [a, b, cc] { v.extend_from_slice(&[p[0], p[1], p[2], c[0], c[1], c[2], 1.0]); }
        };
        tri(sub(base, w), add(base, w), add(neck, w));
        tri(sub(base, w), add(neck, w), sub(neck, w));
        tri(sub(neck, hw), add(neck, hw), tip);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_pull_along_x_reads_as_the_distance_pulled() {
        let g = Gizmo { at: [1.0, 2.0, 0.0], q: [0.0, 0.0, 0.0, 1.0], snap: None };
        // Rays from a camera at +Z through two points of the X axis: 0.5 m apart.
        let eye = [1.0, 2.0, 10.0];
        let ray = |p: [f32; 3]| { let d = sub(p, eye); let l = len(d); (eye, scale(d, 1.0 / l)) };
        let (o0, d0) = ray([1.2, 2.0, 0.0]);
        let (o1, d1) = ray([1.7, 2.0, 0.0]);
        let s = along(g.at, g.axes()[0], o1, d1).unwrap() - along(g.at, g.axes()[0], o0, d0).unwrap();
        assert!((s - 0.5).abs() < 1e-4, "{s}");
        assert_eq!(offset(&g, 0, s), [s, 0.0, 0.0]);
    }
    #[test]
    fn snapping_lands_the_anchor_on_the_step() {
        let g = Gizmo { at: [1.03, 2.0, 0.0], q: [0.0, 0.0, 0.0, 1.0], snap: Some(0.25) };
        let o = offset(&g, 0, 0.4);
        assert!(((g.at[0] + o[0]) - 1.5).abs() < 1e-5, "{o:?}");   // 1.43 → 1.5
        // Object axes (turned 90° about Y: X now points along −Z): the DISTANCE snaps.
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let t = Gizmo { q: [0.0, s, 0.0, s], ..g };
        let o = offset(&t, 0, 0.4);
        assert!((len(o) - 0.5).abs() < 1e-5, "{o:?}");
    }
    #[test]
    fn the_handle_under_the_cursor_is_found_in_screen_space() {
        let cam = crate::view3d::Cam::from_pose([0.0, 0.0, 10.0], [0.0, 0.0, 0.0], 50.0);
        let (vp, _, _) = crate::view3d::camera_frame(&cam, 1.0);
        let px = 2.0 * (25f32).to_radians().tan() / 800.0;
        let g = Gizmo { at: [0.0, 0.0, 0.0], q: [0.0, 0.0, 0.0, 1.0], snap: None };
        // GIZMO_PX right of the centre lies on the X shaft; up, on Y; Z points at the camera (end-on).
        assert_eq!(hit(&g, &vp, cam.eye(), px, 800.0, 800.0, 400.0 + 60.0, 400.0), Some(0));
        assert_eq!(hit(&g, &vp, cam.eye(), px, 800.0, 800.0, 400.0, 400.0 - 60.0), Some(1));
        assert_eq!(hit(&g, &vp, cam.eye(), px, 800.0, 800.0, 400.0 + 60.0, 400.0 + 60.0), None);
        assert!(!geometry(&g, cam.eye(), px, Some(0)).is_empty());
    }
}
