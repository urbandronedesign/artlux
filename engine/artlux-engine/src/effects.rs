//! E1d-4 — EFFECT surfaces: the app's generative effects (src/renderer/gpu/surfaceFx.ts SurfaceEffect +
//! palettes.ts), ported LINE FOR LINE.
//!
//! The app renders an effect on the CPU into a 96×96 canvas (putImageData) which the atlas then stretches
//! like any canvas (no mips, compose.rs `Picture::canvas`). So the port is CPU too and reproduces the
//! field BYTE FOR BYTE, which needs JavaScript's arithmetic, not "the same formula":
//!   - every expression in f64 in the TS's evaluation order; `Math.sin` is V8's fdlibm port → `libm::sin`;
//!   - the palette LUT stored with `Math.round` (half → +∞) into a Uint8Array;
//!   - the field stored into a Uint8ClampedArray: clamp, then round half to EVEN (Wave's products);
//!   - Fire's heat buffer is a Float32Array: every store rounds to f32, every read widens back;
//!   - `??` defaults (only a MISSING field defaults; the switch compares `===`, so 1.5 is "Solid").
//! Fire draws `Math.random()` — in the engine, a mulberry32 stream (the parity test seeds the page's
//! Math.random with the same generator, so the two simulations step identically). The cache is the
//! app's too: the same effect at the same time returns the last field WITHOUT stepping Fire.
//! scripts/test-image-parity.cjs (EFFECT phase) holds it to the app's real SurfaceEffect.
//!
//! proven against: 172d9e4ebda5ca51 4e8e80766fc9bd55   (sha256/16 of surfaceFx.ts, palettes.ts — LF; checked by
//! verify:invariants, which fails the moment either changes: re-port, re-run the parity test, then update).

pub const FW: usize = 96;
pub const FH: usize = 96;
const SIZE: usize = 256;

/// `Math.round` (half toward +∞), as the LUT builder stores it.
fn js_round(x: f64) -> f64 { (x + 0.5).floor() }

/// A store into a Uint8ClampedArray: NaN → 0, clamp to 0..255, round half to even.
fn clamped_u8(x: f64) -> u8 {
    if x.is_nan() { return 0; }
    let v = x.clamp(0.0, 255.0);
    let f = v.floor();
    let r = if v - f > 0.5 { f + 1.0 } else if v - f < 0.5 { f } else if f % 2.0 == 0.0 { f } else { f + 1.0 };
    r as u8
}

fn hsv_to_rgb(h: f64, s: f64, v: f64) -> [f64; 3] {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - f * s);
    let t = v * (1.0 - (1.0 - f) * s);
    let (r, g, b) = match (i as i64).rem_euclid(6) {
        0 => (v, t, p), 1 => (q, v, p), 2 => (p, v, t), 3 => (p, q, v), 4 => (t, p, v), _ => (v, p, q),
    };
    [r * 255.0, g * 255.0, b * 255.0]
}

const GRADIENTS: [&[u8]; 6] = [
    &[0,0,0,0, 64,128,0,0, 160,255,80,0, 224,255,220,40, 255,255,255,255],
    &[0,0,0,40, 64,0,60,140, 128,0,130,200, 192,40,200,210, 255,200,255,255],
    &[0,0,40,0, 64,0,100,20, 128,40,160,40, 192,140,200,40, 255,220,255,120],
    &[0,0,0,0, 80,140,0,0, 160,255,70,0, 224,255,200,0, 255,255,255,200],
    &[0,120,0,0, 51,255,104,0, 135,100,0,103, 198,16,0,130, 255,0,0,160],
    &[0,0,255,200, 80,0,120,255, 160,180,0,255, 220,255,0,160, 255,255,80,0],
];

/// palettes.ts buildPaletteLut: row 0 the HSV rainbow, then the gradients. RGBA, 256 per row.
pub fn palette_lut() -> Vec<u8> {
    let count = 1 + GRADIENTS.len();
    let mut data = vec![0u8; SIZE * count * 4];
    for x in 0..SIZE {
        let [r, g, b] = hsv_to_rgb(x as f64 / SIZE as f64, 1.0, 1.0);
        data[x * 4..x * 4 + 4].copy_from_slice(&[js_round(r) as u8, js_round(g) as u8, js_round(b) as u8, 255]);
    }
    for (i, a) in GRADIENTS.iter().enumerate() {
        let stops: Vec<[f64; 4]> = a.chunks(4).map(|s| [s[0] as f64, s[1] as f64, s[2] as f64, s[3] as f64]).collect();
        let row = (i + 1) * SIZE * 4;
        for x in 0..SIZE {
            let xf = x as f64;
            let (mut lo, mut hi) = (stops[0], stops[stops.len() - 1]);
            for s in 0..stops.len() - 1 {
                if xf >= stops[s][0] && xf <= stops[s + 1][0] { lo = stops[s]; hi = stops[s + 1]; break; }
            }
            let span = if hi[0] - lo[0] != 0.0 { hi[0] - lo[0] } else { 1.0 };
            let f = ((xf - lo[0]) / span).clamp(0.0, 1.0);
            let o = row + x * 4;
            for c in 0..3 { data[o + c] = js_round(lo[c + 1] + (hi[c + 1] - lo[c + 1]) * f) as u8; }
            data[o + 3] = 255;
        }
    }
    data
}

/// mulberry32 — the engine's Fire randomness, and the stream the parity test feeds the page.
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: u32) -> Self { Rng(seed) }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

/// The effect fields of a SurfaceContent, raw (a missing field is None → the `??` default).
#[derive(Clone, Copy, PartialEq)]
pub struct Params { pub eff: f64, pub pid: f64, pub speed: f64, pub intensity: f64 }
impl Params {
    pub fn from_json(c: &serde_json::Value) -> Self {
        // `x ?? d`: null and a missing field default; anything else is taken (a non-number becomes NaN,
        // which is what JS arithmetic would make of most of it).
        let f = |k: &str, d: f64| match &c[k] { serde_json::Value::Null => d, v => v.as_f64().unwrap_or(f64::NAN) };
        Params { eff: f("effectId", 0.0), pid: f("paletteId", 0.0), speed: f("speed", 0.5), intensity: f("intensity", 0.5) }
    }
}

pub struct SurfaceEffect { lut: Vec<u8>, rows: f64, heat: Vec<f32>, rgba: Vec<u8>, last: Option<(Params, f64)> }

impl Default for SurfaceEffect { fn default() -> Self { Self::new() } }

impl SurfaceEffect {
    pub fn new() -> Self {
        let lut = palette_lut();
        let rows = (lut.len() / (SIZE * 4)) as f64;
        SurfaceEffect { lut, rows, heat: vec![0.0; FW * FH], rgba: vec![0; FW * FH * 4], last: None }
    }

    fn pal(&self, pid: f64, t: f64) -> [u8; 3] {
        let p = ((pid.floor() % self.rows) + self.rows) % self.rows;   // JS % keeps the dividend's sign
        let mut f = t - t.floor();
        if f < 0.0 { f += 1.0; }
        let x = (f * 256.0).floor().clamp(0.0, 255.0);
        let o = ((p * 256.0 + x) * 4.0) as usize;
        [self.lut[o], self.lut[o + 1], self.lut[o + 2]]
    }

    /// The field at time `t` (RGBA8, 96×96, opaque) — SurfaceEffect.render.
    pub fn render(&mut self, c: Params, t: f64, rng: &mut Rng) -> &[u8] {
        if self.last == Some((c, t)) { return &self.rgba; }
        self.last = Some((c, t));
        if c.eff == 4.0 {
            self.fire(c.pid, c.intensity, rng);
        } else {
            let sp = c.speed * 2.0;
            for y in 0..FH {
                for x in 0..FW {
                    let u = x as f64 / FW as f64;
                    let col: [f64; 3] = if c.eff == 1.0 {
                        self.pal(c.pid, u + t * sp * 0.1).map(|v| v as f64)
                    } else if c.eff == 2.0 {
                        self.pal(c.pid, u * (0.5 + c.intensity * 4.0) + t * sp * 0.15).map(|v| v as f64)
                    } else if c.eff == 3.0 {
                        let base = self.pal(c.pid, u);
                        let w = 0.5 + 0.5 * libm::sin((u * (1.0 + c.intensity * 6.0) - t * sp * 0.5) * 6.2831853);
                        [base[0] as f64 * w, base[1] as f64 * w, base[2] as f64 * w]
                    } else {
                        self.pal(c.pid, c.intensity).map(|v| v as f64)
                    };
                    let o = (y * FW + x) * 4;
                    for k in 0..3 { self.rgba[o + k] = clamped_u8(col[k]); }
                    self.rgba[o + 3] = 255;
                }
            }
        }
        &self.rgba
    }

    fn fire(&mut self, pid: f64, intensity: f64, rng: &mut Rng) {
        let h = &mut self.heat;
        for x in 0..FW {
            h[(FH - 1) * FW + x] = ((0.55 + rng.next() * 0.45).min(1.0) * (0.45 + intensity * 0.55)) as f32;
        }
        for y in 0..FH - 1 {
            for x in 0..FW {
                let bx = (y + 1) * FW;
                let c = h[bx + x] as f64;
                let l = h[bx + x.saturating_sub(1)] as f64;
                let r = h[bx + (x + 1).min(FW - 1)] as f64;
                h[y * FW + x] = (c * 0.5 + l * 0.25 + r * 0.25 - (0.008 + rng.next() * 0.05)).max(0.0) as f32;
            }
        }
        for i in 0..FW * FH {
            let col = self.pal(pid, (self.heat[i] as f64).min(0.999));
            self.rgba[i * 4..i * 4 + 4].copy_from_slice(&[col[0], col[1], col[2], 255]);
        }
    }
}
