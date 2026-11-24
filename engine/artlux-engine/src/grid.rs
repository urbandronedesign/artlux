//! E4b — THE FLOOR GRID in the engine's 3D view, as the editor draws it (Simulator3D/GroundGrid.tsx, gridScale.ts
//! gridFamilies, OriginGnomon.tsx).
//!
//! Not a fixed metre lattice: THREE DECADES of lines (0.1 / 1 / 10 m…, whichever the density puts on screen), each
//! faded in by the pixels one of its cells covers at the reference point (where the view meets the floor —
//! labels.rs `reference`, the same answer the floor numbers use), each centred on the reference snapped to its own
//! spacing and fading with distance from it. A close view shows centimetres, a venue-wide one tens of metres, and
//! nothing about it steps as the camera moves. The origin is marked by a small gnomon — X red, Y green, Z blue,
//! GNOMON_PX long at the reference's density, drawn over everything — not by full-length axis lines.

/// GroundGrid.tsx EXTENT / FADE / STEP / LINE_COLOR (#a4a4a4, linear) / LINE_OPACITY; gridScale FAMILY_*_PX and
/// GNOMON_PX; OriginGnomon RADIUS_FRAC.
const EXTENT: i32 = 24;
const FADE: f32 = 20.0;
const STEP: i32 = 2;
const LINE: f32 = 0.371;
const LINE_OPACITY: f32 = 0.55;
const FAMILY_GONE_PX: f32 = 7.0;
const FAMILY_FULL_PX: f32 = 46.0;
const GNOMON_PX: f32 = 28.0;
const RADIUS_FRAC: f32 = 0.012;
/// Per vertex: x y z r g b a.
pub const VERT_FLOATS: usize = 7;

fn log_fade(px: f32, gone: f32, full: f32) -> f32 {
    if px <= 0.0 { return 0.0; }
    let t = ((px.ln() - gone.ln()) / (full.ln() - gone.ln())).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
/// gridScale.ts gridFamilies: three decades of lines, finest first, with their opacity.
pub fn families(px_per_m: f32) -> Vec<(f32, f32)> {
    if !(px_per_m > 0.0) || !px_per_m.is_finite() { return Vec::new(); }
    let decade = |v: f32| 10f32.powf(v.log10().floor());
    let mut s = decade(FAMILY_GONE_PX / px_per_m);
    if s * px_per_m < FAMILY_GONE_PX { s *= 10.0; }
    [s, s * 10.0, s * 100.0].iter().map(|&sp| (sp, log_fade(sp * px_per_m, FAMILY_GONE_PX, FAMILY_FULL_PX))).collect()
}

/// The lines, x y z r g b a per vertex (a line list): each family's lattice (GroundGrid's `build`, scaled by its
/// spacing and moved to the reference snapped to it), its colour faded with distance in the lattice's own units, its
/// alpha the family's opacity.
pub fn lines(at: [f32; 3], px_per_m: f32) -> Vec<f32> {
    let mut v = Vec::new();
    for (s, alpha) in families(px_per_m) {
        if alpha <= 0.002 { continue; }
        let a = LINE_OPACITY * alpha;
        let (ox, oz) = ((at[0] / s).round() * s, (at[2] / s).round() * s);
        let fade = |x: f32, z: f32| { let d = (x * x + z * z).sqrt() / FADE; if d >= 1.0 { 0.0 } else { (1.0 - d) * (1.0 - d) } };
        let mut push = |x1: f32, z1: f32, x2: f32, z2: f32| {
            let (f1, f2) = (fade(x1, z1), fade(x2, z2));
            if f1 <= 0.001 && f2 <= 0.001 { return; }
            v.extend_from_slice(&[ox + x1 * s, 0.001, oz + z1 * s, LINE * f1, LINE * f1, LINE * f1, a,
                                  ox + x2 * s, 0.001, oz + z2 * s, LINE * f2, LINE * f2, LINE * f2, a]);
        };
        for i in -EXTENT..=EXTENT {
            let mut t = -EXTENT;
            while t < EXTENT {
                let t2 = (t + STEP).min(EXTENT);
                push(i as f32, t as f32, i as f32, t2 as f32);   // along Z
                push(t as f32, i as f32, t2 as f32, i as f32);   // along X
                t += STEP;
            }
        }
    }
    v
}

/// The origin gnomon's triangles (x y z r g b a), arms GNOMON_PX long at the reference's density, facing the eye.
pub fn gnomon(px_per_m: f32, eye: [f32; 3]) -> Vec<f32> {
    let mut v = Vec::new();
    if !(px_per_m > 0.0) { return v; }
    let len = GNOMON_PX / px_per_m;
    let w = len * RADIUS_FRAC * 2.0;
    for (d, c) in [([1.0, 0.0, 0.0], [0.9, 0.08, 0.1]), ([0.0, 1.0, 0.0], [0.12, 0.75, 0.15]), ([0.0, 0.0, 1.0], [0.1, 0.25, 0.95])] {
        let b = [d[0] * len, d[1] * len, d[2] * len];
        let to_eye = [-eye[0], -eye[1], -eye[2]];
        let side = [b[1] * to_eye[2] - b[2] * to_eye[1], b[2] * to_eye[0] - b[0] * to_eye[2], b[0] * to_eye[1] - b[1] * to_eye[0]];
        let sl = (side[0] * side[0] + side[1] * side[1] + side[2] * side[2]).sqrt();
        if sl < 1e-9 { continue; }
        let s = side.map(|x| x * w * 0.5 / sl);
        let (a0, a1, b0, b1) = ([-s[0], -s[1], -s[2]], s, [b[0] + s[0], b[1] + s[1], b[2] + s[2]], [b[0] - s[0], b[1] - s[1], b[2] - s[2]]);
        for p in [a0, a1, b0, a0, b0, b1] { v.extend_from_slice(&[p[0], p[1], p[2], c[0], c[1], c[2], 1.0]); }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_decades_follow_the_density() {
        // 100 px a metre: decimetres just fading in (10 px a cell), metres full.
        let f = families(100.0);
        assert!((f[0].0 - 0.1).abs() < 1e-6 && f[0].1 > 0.05 && f[0].1 < 0.5, "{f:?}");
        assert!((f[1].0 - 1.0).abs() < 1e-6 && f[1].1 > 0.98);
        // 2 px a metre: metres gone, tens in.
        assert!((families(2.0)[0].0 - 10.0).abs() < 1e-4);
    }
    #[test]
    fn the_lattice_is_centred_on_the_reference_and_fades() {
        let v = lines([3.4, 0.0, -7.6], 100.0);
        assert!(!v.is_empty());
        assert_eq!(v.len() % (2 * VERT_FLOATS), 0);
        // The metre family is centred on (3, -8): a vertex there carries the full line colour.
        assert!(v.chunks_exact(VERT_FLOATS).any(|p| (p[0] - 3.0).abs() < 1e-4 && (p[2] + 8.0).abs() < 1e-4 && (p[3] - LINE).abs() < 1e-4));
        // Nothing reaches past EXTENT spacings of the coarsest family drawn.
        assert!(v.chunks_exact(VERT_FLOATS).all(|p| (p[0] - 3.4).abs() <= 24.0 * 10.0 + 10.0));
        assert_eq!(gnomon(100.0, [0.0, 5.0, 10.0]).len(), 3 * 6 * VERT_FLOATS);
    }
}
