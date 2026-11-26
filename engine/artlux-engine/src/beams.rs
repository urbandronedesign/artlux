//! E4b — THE BEAMS in the engine's 3D view (plans/native-engine.md E4; the editor's Simulator3D/Beams.tsx,
//! line for line where it matters).
//!
//! The editor draws two things per lit head, and so does this:
//!   - THE VOLUME: an additive cone of haze from the lens — faint, gone by three-quarters of 8 m (Shaded), or the
//!     Rendered look's solid shaft to the floor. Fill-rate bound, so only the MAX_BEAMS brightest are drawn
//!     (Beams.tsx measured why; the cost was overdraw, never draw calls).
//!   - THE DIAGRAM: the illumination boundary where the cone meets the floor (an ellipse on a tilted beam, each
//!     rim ray intersected on its own), and for the heads being AIMED (the editor's selection) the optical axis
//!     and eight edge rays. Lines, so every lit head gets one.
//!
//! The split: the HOST sends each light's FIXED half once (engineView.tsx: lens apex, base rotation, pan / tilt
//! mid-points, lens half-angle — what Beams.tsx computes from the fixture and its rig metrics); the ENGINE
//! resolves the moving half every tick (lightpack.rs `Head::resolve`, the port of fixtureSignal.resolveFixture,
//! held to it by `test:light-pack-parity`). This module turns the two into instance and line data — pure, no GPU.

use crate::lightpack::Beam;
use crate::view3d::{BeamLook, LightFix};
use std::collections::HashMap;

/// Beams.tsx BEAM_LENGTH / MAX_BEAMS / RING / RAYS / MAX_THROW / FLARE / RENDERED_THROW.
const BEAM_LENGTH: f32 = 8.0;
pub const MAX_BEAMS: usize = 48;
const RING: usize = 32;
const RAYS: usize = 8;
const MAX_THROW: f32 = 25.0;
const FLARE: f32 = 2.0;
const RENDERED_THROW: f32 = 30.0;

/// Per drawn cone: its matrix (column-major, 16) and its tint (rgb × intensity, then 0) — 20 floats.
pub const CONE_FLOATS: usize = 20;
/// Per line vertex: x y z r g b a — the overlay line layout.
pub const LINE_FLOATS: usize = 7;

pub struct Frame { pub cones: Vec<f32>, pub lines: Vec<f32> }

type Q = [f32; 4];
fn qmul(a: Q, b: Q) -> Q {
    [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
     a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
     a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
     a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
}
fn qaxis(axis: [f32; 3], rad: f32) -> Q { let s = (rad / 2.0).sin(); [axis[0] * s, axis[1] * s, axis[2] * s, (rad / 2.0).cos()] }
fn qrot(q: Q, v: [f32; 3]) -> [f32; 3] {
    // v + 2w(q×v) + 2 q×(q×v)
    let u = [q[0], q[1], q[2]];
    let c = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let t = c(u, v).map(|x| 2.0 * x);
    let ct = c(u, t);
    [v[0] + q[3] * t[0] + ct[0], v[1] + q[3] * t[1] + ct[1], v[2] + q[3] * t[2] + ct[2]]
}
/// three's Matrix4.compose(position, quaternion, scale).
fn compose(p: [f32; 3], q: Q, s: [f32; 3]) -> [f32; 16] {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    [(1.0 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0.0,
     (xy - wz) * s[1], (1.0 - (xx + zz)) * s[1], (yz + wx) * s[1], 0.0,
     (xz + wy) * s[2], (yz - wx) * s[2], (1.0 - (xx + yy)) * s[2], 0.0,
     p[0], p[1], p[2], 1.0]
}
fn normalize(v: [f32; 3]) -> [f32; 3] { let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt(); if l > 0.0 { v.map(|x| x / l) } else { v } }

/// Beams.tsx useFrame, for one frame of resolved states.
pub fn build(lights: &[LightFix], states: &HashMap<String, Beam>, look: &BeamLook) -> Frame {
    let deg = std::f32::consts::PI / 180.0;
    fn lit<'a>(l: &'a LightFix, states: &'a HashMap<String, Beam>) -> Option<(&'a crate::view3d::BeamFix, &'a Beam)> {
        let b = l.beam.as_ref()?;
        let st = states.get(&l.id)?;
        (!st.blackout && st.intensity > 0.001).then_some((b, st))
    }
    // The fill-rate budget: the MAX_BEAMS brightest volumes (a stable sort, as Array.prototype.sort is).
    // (Each head's intensity looked up ONCE, not twice per comparison — O1-7.)
    let mut order: Vec<(usize, f64)> = (0..lights.len()).filter_map(|i| lit(&lights[i], states).map(|(_, st)| (i, st.intensity))).collect();
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    order.truncate(MAX_BEAMS);
    let drawn: std::collections::HashSet<usize> = order.into_iter().map(|o| o.0).collect();

    let mut cones = Vec::new();
    let mut lines = Vec::new();
    let mut put = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| {
        lines.extend_from_slice(&[a[0], a[1], a[2], c[0], c[1], c[2], 0.9, b[0], b[1], b[2], c[0], c[1], c[2], 0.9]);
    };
    for (i, l) in lights.iter().enumerate() {
        let Some((b, st)) = lit(l, states) else { continue };
        let q = b.q;
        let qp = qaxis([0.0, 1.0, 0.0], (st.pan as f32 - b.pan_mid) * deg);
        let qt = qaxis([1.0, 0.0, 0.0], (st.tilt as f32 - b.tilt_mid) * deg);
        let aim = qmul(qmul(q, qp), qt);
        let p = b.apex;
        // profileRig.halfAngle: a live zoom channel overrides the fixed lens.
        let half = match st.zoom { Some(z) if z > 0.0 => (z as f32 / 2.0).max(0.5), _ => b.lens_half };
        let tan_h = (half * deg).tan();
        let reach = |dir: [f32; 3], limit: f32| -> f32 {
            if dir[1] < -1e-4 && p[1] > 0.0 { let t = p[1] / -dir[1]; if t > 0.0 { return t.min(limit); } }
            limit
        };
        let axis = qrot(aim, [0.0, 0.0, -1.0]);

        if look.cones {
            let sel = look.selected.contains(&l.id);
            let k = if sel { 1.0 } else { 0.42 };
            let (r, g, bl) = (st.r as f32, st.g as f32, st.b as f32);
            let peak = r.max(g).max(bl).max(0.001);
            let c = [r / peak * k, g / peak * k, bl / peak * k];
            let axis_t = if reach(axis, MAX_THROW) < MAX_THROW { reach(axis, MAX_THROW) } else { BEAM_LENGTH.min(MAX_THROW) };
            let hit = [p[0] + axis[0] * axis_t, p[1] + axis[1] * axis_t, p[2] + axis[2] * axis_t];
            if sel { put(p, hit, c.map(|x| x * 0.55)); }
            let mut ring = [[0f32; 3]; RING];
            for (r_i, pt) in ring.iter_mut().enumerate() {
                let a2 = r_i as f32 / RING as f32 * std::f32::consts::TAU;
                let dir = qrot(aim, normalize([a2.cos() * tan_h, a2.sin() * tan_h, -1.0]));
                let t = reach(dir, axis_t * FLARE);
                *pt = [p[0] + dir[0] * t, p[1] + dir[1] * t, p[2] + dir[2] * t];
            }
            for r_i in 0..RING { put(ring[r_i], ring[(r_i + 1) % RING], c); }
            if sel {
                let step = RING as f32 / RAYS as f32;
                for r_i in 0..RAYS { put(p, ring[(r_i as f32 * step).round() as usize % RING], c.map(|x| x * 0.7)); }
            }
        }

        if !drawn.contains(&i) { continue; }
        let len = if look.rendered { if axis[1] < -1e-4 && p[1] > 0.0 { (p[1] / -axis[1]).min(RENDERED_THROW) } else { RENDERED_THROW } } else { BEAM_LENGTH };
        let radius = len * tan_h;
        cones.extend_from_slice(&compose(p, aim, [radius, radius, len]));
        let k = st.intensity as f32;
        cones.extend_from_slice(&[st.r as f32 * k, st.g as f32 * k, st.b as f32 * k, 0.0]);
    }
    Frame { cones, lines }
}

/// E4b — THE HEADS AS REAL LIGHTS (the editor's MoverLights.tsx): the MAX_SPOTS brightest lit heads, each a three.js
/// SpotLight at its lens, aimed down its beam, angle = the beam's half-angle (capped short of 90°), penumbra 0.4,
/// distance 30 m, decay 1.2, its colour, intensity = dimmer × gain × 14 (gain: the scene's light level, ×6 and at
/// least 1 in Rendered — Simulator3D's lightGain). Packed for the mesh shader: per spot position + range, direction
/// + decay, colour × intensity, cos(outer) + cos(inner); then the count.
pub const MAX_SPOTS: usize = 8;
pub const SPOT_FLOATS: usize = 16;
pub fn spots(lights: &[LightFix], states: &HashMap<String, Beam>, gain: f32) -> (Vec<f32>, usize) {
    let deg = std::f32::consts::PI / 180.0;
    let mut lit: Vec<(&crate::view3d::BeamFix, &Beam)> = lights.iter().filter_map(|l| {
        let b = l.beam.as_ref()?;
        let st = states.get(&l.id)?;
        (!st.blackout && st.intensity > 0.01).then_some((b, st))
    }).collect();
    lit.sort_by(|a, b| b.1.intensity.partial_cmp(&a.1.intensity).unwrap_or(std::cmp::Ordering::Equal));
    lit.truncate(MAX_SPOTS);
    let mut out = vec![0f32; MAX_SPOTS * SPOT_FLOATS];
    if gain <= 0.0 { return (out, 0); }
    for (k, (b, st)) in lit.iter().enumerate() {
        let aim = qmul(qmul(b.q, qaxis([0.0, 1.0, 0.0], (st.pan as f32 - b.pan_mid) * deg)), qaxis([1.0, 0.0, 0.0], (st.tilt as f32 - b.tilt_mid) * deg));
        let dir = qrot(aim, [0.0, 0.0, -1.0]);
        let half = match st.zoom { Some(z) if z > 0.0 => (z as f32 / 2.0).max(0.5), _ => b.lens_half };
        let angle = (half * deg).min(std::f32::consts::FRAC_PI_2 - 0.01);
        let i = st.intensity as f32 * gain * 14.0;
        let o = k * SPOT_FLOATS;
        out[o..o + 16].copy_from_slice(&[b.apex[0], b.apex[1], b.apex[2], 30.0, dir[0], dir[1], dir[2], 1.2,
            st.r as f32 * i, st.g as f32 * i, st.b as f32 * i, 0.0, angle.cos(), (angle * (1.0 - 0.4)).cos(), 0.0, 0.0]);
    }
    let n = lit.len();
    (out, n)
}

/// three's ConeGeometry(1, 1, 28, 1, true), apex moved to the origin and the base sent to −Z (Beams.tsx
/// UNIT_CONE): position + normal per vertex, triangles. Open-ended — a capped cone shows a bright disc in mid-air.
pub fn unit_cone() -> (Vec<f32>, Vec<u32>) {
    const SEG: usize = 28;
    let mut v = Vec::new();
    let mut idx = Vec::new();
    let s = std::f32::consts::FRAC_1_SQRT_2;
    for i in 0..=SEG {
        let a = i as f32 / SEG as f32 * std::f32::consts::TAU;
        let (c, sn) = (a.cos(), a.sin());
        let n = [c * s, sn * s, s];   // outward on r = −z
        v.extend_from_slice(&[0.0, 0.0, 0.0, n[0], n[1], n[2]]);   // apex (one per segment, as three's)
        v.extend_from_slice(&[c, sn, -1.0, n[0], n[1], n[2]]);      // base rim
    }
    for i in 0..SEG as u32 { let (a, b, c) = (i * 2, i * 2 + 1, i * 2 + 3); idx.extend_from_slice(&[a, b, c]); }
    (v, idx)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn light(id: &str, apex: [f32; 3]) -> LightFix {
        LightFix { id: id.into(), pos: apex, beam: Some(crate::view3d::BeamFix { apex, q: [0.0, 0.0, 0.0, 1.0], pan_mid: 0.0, tilt_mid: 0.0, lens_half: 10.0 }) }
    }
    #[test]
    fn a_head_aimed_down_lands_its_ring_on_the_floor() {
        // Base rotation identity aims −Z; tilt −90° about X turns −Z to −Y (straight down).
        let l = light("a", [0.0, 5.0, 0.0]);
        let st = Beam { intensity: 1.0, r: 1.0, g: 0.0, b: 0.0, pan: 0.0, tilt: -90.0, zoom: None, blackout: false };
        let f = build(&[l], &HashMap::from([("a".to_string(), st)]), &BeamLook::default());
        assert_eq!(f.cones.len(), CONE_FLOATS);
        // 32 ring segments, two vertices each.
        assert_eq!(f.lines.len(), RING * 2 * LINE_FLOATS);
        for v in f.lines.chunks_exact(LINE_FLOATS) { assert!(v[1].abs() < 1e-3, "ring point off the floor: {v:?}"); }
        // The ring's radius is 5 · tan 10°.
        let r = (f.lines[0].powi(2) + f.lines[2].powi(2)).sqrt();
        assert!((r - 5.0 * (10f32).to_radians().tan()).abs() < 1e-3, "{r}");
    }
    #[test]
    fn a_dark_head_draws_nothing_and_the_budget_keeps_the_brightest() {
        let mut lights = Vec::new();
        let mut st = HashMap::new();
        for i in 0..60 {
            let id = format!("h{i}");
            lights.push(light(&id, [i as f32, 5.0, 0.0]));
            st.insert(id, Beam { intensity: i as f64 / 60.0, r: 1.0, g: 1.0, b: 1.0, pan: 0.0, tilt: 0.0, zoom: None, blackout: i == 59 });
        }
        let f = build(&lights, &st, &BeamLook { cones: false, ..Default::default() });
        assert_eq!(f.cones.len() / CONE_FLOATS, MAX_BEAMS);
        assert!(f.lines.is_empty());
        // h59 is blacked out, h0 is at 0: the dimmest kept is h11 (58 lit, the 48 brightest are h11..h58).
        let min_tint = f.cones.chunks_exact(CONE_FLOATS).map(|c| c[16]).fold(f32::MAX, f32::min);
        assert!((min_tint - 11.0 / 60.0).abs() < 1e-6, "{min_tint}");
    }
}

#[cfg(test)]
mod spot_tests {
    use super::*;
    #[test]
    fn the_brightest_eight_heads_become_lights() {
        let mut lights = Vec::new();
        let mut st = HashMap::new();
        for i in 0..10 {
            let id = format!("h{i}");
            lights.push(LightFix { id: id.clone(), pos: [i as f32, 5.0, 0.0], beam: Some(crate::view3d::BeamFix { apex: [i as f32, 5.0, 0.0], q: [0.0, 0.0, 0.0, 1.0], pan_mid: 0.0, tilt_mid: 0.0, lens_half: 10.0 }) });
            st.insert(id, Beam { intensity: (i + 1) as f64 / 10.0, r: 1.0, g: 0.5, b: 0.0, pan: 0.0, tilt: -90.0, zoom: None, blackout: false });
        }
        let (v, n) = spots(&lights, &st, 6.0);
        assert_eq!(n, MAX_SPOTS);
        // The brightest first: h9 at full, intensity = 1 × 6 × 14, its colour, aimed straight down.
        assert_eq!(&v[0..4], &[9.0, 5.0, 0.0, 30.0]);
        assert!((v[5] + 1.0).abs() < 1e-5 && (v[7] - 1.2).abs() < 1e-6);
        assert!((v[8] - 84.0).abs() < 1e-4 && (v[9] - 42.0).abs() < 1e-4 && v[10] == 0.0);
        assert!((v[12] - 10f32.to_radians().cos()).abs() < 1e-6 && (v[13] - 6f32.to_radians().cos()).abs() < 1e-6);
        // No gain: no lights.
        assert_eq!(spots(&lights, &st, 0.0).1, 0);
    }
}
