//! E4b — THE NUMBERS ON THE FLOOR in the engine's 3D view (the editor's Simulator3D/GridLabels.tsx and
//! gridScale.ts labelFamilies / solveGridFrame, ported).
//!
//! Whole metres, painted FLAT on the floor along two runs — one parallel to X, one to Z — through the lines
//! nearest where the view meets the floor, so the numbers are where you are looking, not only at the origin.
//! Each run counts in the decades the density allows (1, 10, 100 m: `families`), every number fading with its
//! distance from that reference, and an axis letter (X / Z, in the axis colours) a little along each run. The
//! text faces AWAY from the viewer so it is never read mirrored, and its height is LABEL_PX on screen at the
//! reference, divided by how steeply the floor is seen (flat text foreshortens).
//!
//! Lying in the scene, the depth buffer hides a number behind a screen exactly as it hides the grid. One draw;
//! the glyph atlas is rasterised ONCE from a monospace system font (Consolas, as the editor asks for first) —
//! with no such font on the machine the view simply has no numbers (logged once).

use ab_glyph::{Font, FontVec, PxScale, ScaleFont};

/// gridScale.ts LABEL_GONE_PX / LABEL_FULL_PX / LABEL_PX, and GridLabels.tsx's constants.
const LABEL_GONE_PX: f32 = 38.0;
const LABEL_FULL_PX: f32 = 80.0;
const LABEL_PX: f32 = 13.0;
const MAX_REF_M: f32 = 20.0;
const L_EXT: i32 = 9;
const L_FADE: f32 = 10.0;
const RUN_STICK: f32 = 1.25;
const MAX_W: f32 = 0.8;
const Y: f32 = 0.002;
pub const CHARS: &str = "0123456789-XZ";
const CELL_H: u32 = 64;
const PAD_X: u32 = 3;
/// The inks, in LINEAR (#b4b4b4, #ff6b7f, #6fa8f8 as three keeps them).
const INK: [f32; 3] = [0.456, 0.456, 0.456];
const X_INK: [f32; 3] = [1.0, 0.147, 0.212];
const Z_INK: [f32; 3] = [0.159, 0.392, 0.939];
/// Per vertex: x y z u v r g b — two triangles per glyph.
pub const VERT_FLOATS: usize = 8;

pub struct Atlas { pub w: u32, pub h: u32, pub rgba: Vec<u8>, pub cell_aspect: f32 }

/// The atlas: one cell per CHAR, white with the glyph's coverage in alpha, row 0 at the top.
pub fn atlas() -> Option<Atlas> {
    let candidates: &[&str] = if cfg!(windows) {
        &["C:\\Windows\\Fonts\\consola.ttf", "C:\\Windows\\Fonts\\CascadiaMono.ttf", "C:\\Windows\\Fonts\\cour.ttf"]
    } else if cfg!(target_os = "macos") {
        &["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf"]
    } else {
        &["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/TTF/DejaVuSansMono.ttf", "/usr/share/fonts/dejavu/DejaVuSansMono.ttf"]
    };
    let font = candidates.iter().find_map(|p| FontVec::try_from_vec_and_index(std::fs::read(p).ok()?, 0).ok())?;
    let px = (CELL_H as f32 * 0.78).round();
    let sf = font.as_scaled(PxScale::from(px));
    let advance = sf.h_advance(font.glyph_id('0')).ceil() as u32;
    let cell_w = advance + PAD_X * 2;
    let (w, h) = (cell_w * CHARS.len() as u32, CELL_H);
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for p in rgba.chunks_exact_mut(4) { p[0] = 255; p[1] = 255; p[2] = 255; }
    // textBaseline 'middle' at CELL_H / 2 + 1: the em box's middle there, so the baseline sits half the
    // (ascent + descent) below it.
    let baseline = CELL_H as f32 / 2.0 + 1.0 + (sf.ascent() + sf.descent()) / 2.0;
    for (i, ch) in CHARS.chars().enumerate() {
        let id = font.glyph_id(ch);
        let gx = (cell_w * i as u32) as f32 + cell_w as f32 / 2.0 - sf.h_advance(id) / 2.0;
        let glyph = id.with_scale_and_position(PxScale::from(px), ab_glyph::point(gx, baseline));
        if let Some(o) = font.outline_glyph(glyph) {
            let b = o.px_bounds();
            o.draw(|x, y, c| {
                let (xx, yy) = (b.min.x as i32 + x as i32, b.min.y as i32 + y as i32);
                if xx < 0 || yy < 0 || xx >= w as i32 || yy >= h as i32 { return; }
                let k = ((yy as u32 * w + xx as u32) * 4 + 3) as usize;
                rgba[k] = rgba[k].max((c.clamp(0.0, 1.0) * 255.0).round() as u8);
            });
        }
    }
    Some(Atlas { w, h, rgba, cell_aspect: cell_w as f32 / CELL_H as f32 })
}

fn log_fade(px: f32, gone: f32, full: f32) -> f32 {
    if px <= 0.0 { return 0.0; }
    let t = ((px.ln() - gone.ln()) / (full.ln() - gone.ln())).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
/// gridScale.ts labelFamilies: the decades of whole-metre numbers in view, finest first, with their opacity.
pub fn families(px_per_m: f32) -> Vec<(f32, f32)> {
    if !(px_per_m > 0.0) || !px_per_m.is_finite() { return Vec::new(); }
    let decade = |v: f32| 10f32.powf(v.log10().floor());
    let mut s = decade(LABEL_GONE_PX / px_per_m).max(1.0);
    if s * px_per_m < LABEL_GONE_PX && s >= 1.0 { s *= 10.0; }
    [s, s * 10.0, s * 100.0].iter().map(|&sp| (sp, log_fade(sp * px_per_m, LABEL_GONE_PX, LABEL_FULL_PX))).collect()
}

/// What persists between frames: the run lines (sticky, so orbiting never makes the numbers jump a row) and
/// which side of each run the viewer is on (with a dead band, so looking along an axis does not blink).
#[derive(Default)]
pub struct State { run_x: Option<f32>, run_z: Option<f32>, side_x: f32, side_z: f32 }

fn stick(prev: Option<f32>, r: f32, s: f32) -> f32 {
    if let Some(p) = prev { if ((p / s).round() * s - p).abs() < 1e-4 && (r - p).abs() < RUN_STICK * s { return p; } }
    (r / s).round() * s
}

/// One frame's glyph quads. `vp` is the view-projection (column-major, WebGPU clip), `eye` the camera, `fwd`
/// its unit look direction, `up` its unit screen-up, `height_css` the window height in css pixels.
/// gridScale.ts solveGridFrame: the REFERENCE POINT — where the view meets the floor (capped at MAX_REF_M or ten
/// eye heights), else just ahead — and pixelsPerMetre there (the NDC span of one metre of screen-up, in css px).
/// The floor grid (grid.rs) and the numbers lay themselves out against the same answer, as the editor's do.
pub fn reference(vp: &[f32; 16], eye: [f32; 3], fwd: [f32; 3], up: [f32; 3], height_css: f32) -> Option<([f32; 3], f32)> {
    let mut t = f32::NAN;
    if fwd[1].abs() > 1e-4 { t = -eye[1] / fwd[1]; }
    let at = if t > 0.0 && t.is_finite() {
        let t = t.min(MAX_REF_M.max(10.0 * eye[1].abs()));
        [eye[0] + fwd[0] * t, 0.0, eye[2] + fwd[2] * t]
    } else {
        let t = eye[1].abs().max(1e-3);
        [eye[0] + fwd[0] * t, eye[1] + fwd[1] * t, eye[2] + fwd[2] * t]
    };
    let clip = |p: [f32; 3]| { let x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]; let y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]; let w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]; (x / w, y / w) };
    let (a, b) = (clip(at), clip([at[0] + up[0], at[1] + up[1], at[2] + up[2]]));
    let px = (b.1 - a.1).abs() * 0.5 * height_css;
    (px > 0.0 && px.is_finite()).then_some((at, px))
}

pub fn build(st: &mut State, vp: &[f32; 16], eye: [f32; 3], fwd: [f32; 3], up: [f32; 3], height_css: f32, cell_aspect: f32) -> Vec<f32> {
    let mut out = Vec::new();
    let Some((at, px)) = reference(vp, eye, fwd, up, height_css) else { return out };
    let fams = families(px);
    if fams.is_empty() { return out; }
    // Which way is AWAY on the floor: from the look direction (a straight-down view uses screen-up).
    let tilt = fwd[1].abs().clamp(0.3, 1.0);
    let (mut ax, mut az) = (fwd[0], fwd[2]);
    if ax * ax + az * az < 0.0025 { ax = up[0]; az = up[2]; }
    let l = (ax * ax + az * az).sqrt().max(1e-6);
    let (ax, az) = (ax / l, az / l);
    if st.side_x == 0.0 || az.abs() > 0.3 { st.side_x = if az <= 0.0 { 1.0 } else { -1.0 }; }
    if st.side_z == 0.0 || ax.abs() > 0.3 { st.side_z = if ax <= 0.0 { 1.0 } else { -1.0 }; }
    let r = fams.iter().find(|f| f.1 > 0.98).unwrap_or(fams.last().unwrap()).0;
    let run_x = stick(st.run_x, at[0], r); st.run_x = Some(run_x);
    let run_z = stick(st.run_z, at[2], r); st.run_z = Some(run_z);
    let h0 = LABEL_PX / px / tilt;

    for axis in [0usize, 2] {
        // v: the text's up, away from the viewer; u: its baseline, v turned −90° (GridLabels' _u.set(-v.z, 0, v.x)).
        let v = if axis == 0 { [0.0, 0.0, -st.side_x] } else { [-st.side_z, 0.0, 0.0] };
        let u = [-v[2], 0.0, v[0]];
        let (reference, across) = if axis == 0 { (at[0], run_z) } else { (at[2], run_x) };
        let mut done: Vec<i64> = Vec::new();
        let lay = |out: &mut Vec<f32>, text: &str, p: [f32; 3], h: f32, ink: [f32; 3]| {
            let w = h * cell_aspect;
            let n = text.chars().count() as f32;
            let o = [p[0] - u[0] * w * n / 2.0 - v[0] * 1.45 * h, Y, p[2] - u[2] * w * n / 2.0 - v[2] * 1.45 * h];
            for (i, ch) in text.chars().enumerate() {
                let Some(ci) = CHARS.find(ch) else { continue };
                let (u0, u1) = (ci as f32 / CHARS.len() as f32, (ci + 1) as f32 / CHARS.len() as f32);
                let bx = o[0] + u[0] * w * i as f32; let bz = o[2] + u[2] * w * i as f32;
                // Corners: baseline-left (v = bottom of the glyph), baseline-right, top-left, top-right. The atlas's
                // row 0 is the glyph's TOP, so the far edge (along v) samples v_tex = 0.
                let c = [[bx, bz, u0, 1.0], [bx + u[0] * w, bz + u[2] * w, u1, 1.0], [bx + v[0] * h, bz + v[2] * h, u0, 0.0], [bx + u[0] * w + v[0] * h, bz + u[2] * w + v[2] * h, u1, 0.0]];
                for k in [0, 1, 2, 2, 1, 3] { out.extend_from_slice(&[c[k][0], Y, c[k][1], c[k][2], c[k][3], ink[0], ink[1], ink[2]]); }
            }
        };
        for &(s, alpha) in fams.iter().rev() {
            if alpha < 0.02 { continue; }
            let c = (reference / s).round() as i64;
            for k in (c - L_EXT as i64)..=(c + L_EXT as i64) {
                let metres = (k as f32 * s).round() as i64;
                if done.contains(&metres) { continue; }
                done.push(metres);
                if axis == 2 && metres == 0 && across.abs() < 1e-6 { continue; }   // the X run prints the shared "0"
                let d = (metres as f32 - reference).abs() / (s * L_FADE);
                let f = alpha * if d >= 1.0 { 0.0 } else { 1.0 - d };
                if f < 0.02 { continue; }
                let p = if axis == 0 { [metres as f32, Y, across] } else { [across, Y, metres as f32] };
                let text = metres.to_string();
                let h = h0.min(MAX_W * s / (text.len() as f32 * cell_aspect));
                lay(&mut out, &text, p, h, INK.map(|x| x * f));
            }
        }
        let full = fams.iter().find(|f| f.1 > 0.98).unwrap_or(fams.last().unwrap()).0;
        let value = ((reference / full).round() + 2.5) * full;
        let d = (value - reference).abs() / (full * L_FADE);
        let p = if axis == 0 { [value, Y, across] } else { [across, Y, value] };
        let h = h0.min(MAX_W * full / cell_aspect);
        let ink = if axis == 0 { X_INK } else { Z_INK };
        lay(&mut out, if axis == 0 { "X" } else { "Z" }, p, h, ink.map(|x| x * if d >= 1.0 { 0.0 } else { 1.0 - d }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn families_follow_the_density() {
        // 100 px a metre: every metre is fully shown.
        let f = families(100.0);
        assert_eq!(f[0].0, 1.0);
        assert!(f[0].1 > 0.98);
        // 10 px a metre: metres are gone, tens are partly in.
        let f = families(10.0);
        assert_eq!(f[0].0, 10.0);
        assert!(families(0.0).is_empty());
    }
    #[test]
    fn a_view_down_the_floor_numbers_both_runs() {
        // Looking from +Z, 6 m up and 10 m back, at the origin: vp from the view3d maths.
        let cam = crate::view3d::Cam::from_pose([0.0, 6.0, 10.0], [0.0, 0.0, 0.0], 50.0);
        let eye = cam.eye();
        let (vp, fwd, up) = crate::view3d::camera_frame(&cam, 1280.0 / 720.0);
        let mut st = State::default();
        let q = build(&mut st, &vp, eye, fwd, up, 720.0, 0.6);
        let quads = q.len() / VERT_FLOATS / 6;
        assert!(quads > 20, "{quads} glyphs");
        // Everything lies on the floor.
        assert!(q.chunks_exact(VERT_FLOATS).all(|v| (v[1] - Y).abs() < 1e-6));
        // The X run sits on the line nearest the reference (the origin here): z ≈ 0, its text offset toward the viewer.
        assert_eq!(st.run_z, Some(0.0));
    }
}
