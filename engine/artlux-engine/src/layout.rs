//! E1b-2 — THE LED LAYOUT in the engine: per LED, where it samples (surface-local UV), its segment and its
//! surface; and how the surfaces' cells pack into one atlas. A PORT of src/renderer/gpu/ledLayout.ts, held
//! to it BIT FOR BIT (the f32 buffers the GPU reads) by scripts/test-sampling-parity.cjs.
//!
//! Two rules keep it bit-exact:
//!   - JavaScript's arithmetic is f64, rounded to f32 only where the TS stores into a Float32Array — so the
//!     same here, in the same order of operations.
//!   - `Math.cos/sin/log2` in V8 are fdlibm's. Rust's `f64::cos` calls the C runtime, which MAY round the
//!     last bit differently; the `libm` crate is fdlibm-derived too, so it is used for those three. A
//!     PRECAUTION, not a fix: swapping in `f64::cos/sin` changed no f32 over the 332 parity cases (the f64
//!     difference, if any, never survived the rounding to f32) — kept because it costs nothing.
//! And JavaScript's reading of loose fields (`||`, `??`, truthiness, strict `===`) as in pack.rs.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: f64,
    pub stop: f64,
    #[serde(default)]
    pub off: Value,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    #[serde(default)] pub x: f64,
    #[serde(default)] pub y: f64,
    #[serde(default)] pub width: f64,
    #[serde(default)] pub height: f64,
    #[serde(default)] pub rotation: Value,
    #[serde(default)] pub led_count: f64,
    #[serde(default)] pub surface_id: Value,
    #[serde(default)] pub shape: Value,
    #[serde(default)] pub matrix_width: Value,
    #[serde(default)] pub matrix_height: Value,
    #[serde(default)] pub serpentine: Value,
    #[serde(default)] pub reverse: Value,
    #[serde(default)] pub led_map: Option<Vec<Value>>,
    #[serde(default)] pub segments: Option<Vec<Segment>>,
    #[serde(default)] pub rgbw_mode: Value,
    #[serde(default)] pub channels_per_pixel: Value,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Surface {
    pub id: String,
    #[serde(default)] pub x: f64,
    #[serde(default)] pub y: f64,
    #[serde(default)] pub width: Value,
    #[serde(default)] pub height: Value,
    #[serde(default)] pub rotation: Value,
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
/// `v || d` for a number field.
fn num_or(v: &Value, d: f64) -> f64 {
    if truthy(v) { v.as_f64().unwrap_or(d) } else { d }
}
/// `v ?? d` for a number field.
fn num_coalesce(v: &Value, d: f64) -> f64 {
    if v.is_null() { d } else { v.as_f64().unwrap_or(f64::NAN) }
}
fn is_matrix(f: &Fixture) -> bool { f.shape.as_str() == Some("MATRIX") }

/// `2 ** Math.ceil(Math.log2(Math.max(1, n)))`
pub fn ceil_pow2(n: f64) -> f64 {
    2f64.powf(libm::ceil(libm::log2(n.max(1.0))))
}
pub const OVERSAMPLE: f64 = 2.0;
pub const MIN_CELL: f64 = 64.0;
pub const MAX_CELL: f64 = 1024.0;

#[derive(Clone, Copy, Debug)]
struct Seg { start: f64, stop: f64, off: bool }

fn fixture_segments(f: &Fixture) -> Vec<Seg> {
    match &f.segments {
        Some(s) if !s.is_empty() => s.iter().map(|x| Seg { start: x.start, stop: x.stop, off: truthy(&x.off) }).collect(),
        _ => vec![Seg { start: 0.0, stop: f.led_count, off: false }],
    }
}

pub fn count_segments(fixtures: &[Fixture]) -> usize {
    fixtures.iter().map(|f| fixture_segments(f).len()).sum()
}

pub fn build_seg_params(fixtures: &[Fixture]) -> Vec<f32> {
    let mut out = Vec::new();
    for f in fixtures {
        for s in fixture_segments(f) {
            let mut e = [0f32; 8];
            e[0] = if s.off { -2.0 } else { -1.0 };
            // ledLayout.ts buildSegParams, exactly: a 3-channel fixture keeps full RGB (it has no W to put white in).
            e[4] = if f.rgbw_mode.as_str() == Some("NONE") || f.channels_per_pixel.as_f64() == Some(3.0) { 1.0 } else { 0.0 };
            out.extend_from_slice(&e);
        }
    }
    let mut tail = [0f32; 8];
    tail[0] = -2.0;
    out.extend_from_slice(&tail);
    out
}

/// `f.surfaceId === s.id` — strict: only a string equal to the id.
fn links(f: &Fixture, sid: &str) -> bool { f.surface_id.as_str() == Some(sid) }

pub fn surface_order(fixtures: &[Fixture], surfaces: &[Surface]) -> Vec<String> {
    surfaces.iter().filter(|s| fixtures.iter().any(|f| links(f, &s.id))).map(|s| s.id.clone()).collect()
}

pub fn cell_sizes(order: &[String], fixtures: &[Fixture], surfaces: &[Surface], oversample: f64) -> Vec<(f64, f64)> {
    order.iter().map(|sid| {
        let s = surfaces.iter().find(|x| &x.id == sid);
        let sw = num_coalesce(s.map_or(&Value::Null, |s| &s.width), 1.0).max(1e-6);
        let sh = num_coalesce(s.map_or(&Value::Null, |s| &s.height), 1.0).max(1e-6);
        let (mut need_u, mut need_v) = (0f64, 0f64);
        for f in fixtures {
            if !links(f, sid) { continue; }
            let (mut lu, mut lv);
            if is_matrix(f) {
                lu = num_coalesce(&f.matrix_width, 1.0).max(1.0);
                lv = num_coalesce(&f.matrix_height, 1.0).max(1.0);
            } else if f.width >= f.height { lu = f.led_count.max(1.0); lv = 1.0; }
            else { lu = 1.0; lv = f.led_count.max(1.0); }
            let rot = (num_or(&f.rotation, 0.0) % 180.0).abs();
            if rot > 1.0 && rot < 179.0 { let m = lu.max(lv); lu = m; lv = m; }
            let fu = (f.width / sw).max(1e-3).min(1.0);
            let fv = (f.height / sh).max(1e-3).min(1.0);
            need_u = need_u.max(lu / fu);
            need_v = need_v.max(lv / fv);
        }
        let clamp = |n: f64| MAX_CELL.min(MIN_CELL.max(ceil_pow2(n * oversample)));
        let pick = |n: f64| if n != 0.0 && !n.is_nan() { n } else { MIN_CELL };   // `needU || MIN_CELL`
        (clamp(pick(need_u)), clamp(pick(need_v)))
    }).collect()
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Packed { pub rects: Vec<Rect>, pub w: f64, pub h: f64 }

pub fn pack_atlas(sizes: &[(f64, f64)], max_dim: f64) -> Option<Packed> {
    if sizes.is_empty() { return Some(Packed { rects: vec![], w: 1.0, h: 1.0 }); }
    let area: f64 = sizes.iter().map(|s| s.0 * s.1).sum();
    let widest = sizes.iter().fold(0f64, |a, s| a.max(s.0));
    if widest > max_dim { return None; }
    let mut width = max_dim.min(widest.max(ceil_pow2(area.sqrt())));
    while width <= max_dim {
        let mut order: Vec<usize> = (0..sizes.len()).collect();
        order.sort_by(|&a, &b| sizes[b].1.partial_cmp(&sizes[a].1).unwrap_or(std::cmp::Ordering::Equal)); // stable, as JS's
        let mut rects = vec![Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }; sizes.len()];
        let (mut x, mut y, mut shelf, mut ok) = (0f64, 0f64, 0f64, true);
        for i in order {
            let (w, h) = sizes[i];
            if x + w > width { x = 0.0; y += shelf; shelf = 0.0; }
            if y + h > max_dim { ok = false; break; }
            rects[i] = Rect { x, y, w, h };
            x += w;
            if h > shelf { shelf = h; }
        }
        if ok { return Some(Packed { rects, w: width, h: max_dim.min(ceil_pow2(y + shelf)) }); }
        if width == max_dim { break; }
        width *= 2.0;
    }
    None
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan { pub packed: Option<Packed>, pub used_oversample: f64 }

pub fn plan_atlas(order: &[String], fixtures: &[Fixture], surfaces: &[Surface], max_dim: f64) -> Plan {
    for os in [OVERSAMPLE, OVERSAMPLE / 2.0, OVERSAMPLE / 4.0] {
        if let Some(p) = pack_atlas(&cell_sizes(order, fixtures, surfaces, os), max_dim) {
            return Plan { packed: Some(p), used_oversample: os };
        }
    }
    let min: Vec<(f64, f64)> = order.iter().map(|_| (MIN_CELL, MIN_CELL)).collect();
    Plan { packed: pack_atlas(&min, max_dim), used_oversample: 0.0 }
}

pub fn atlas_rect_data(rects: &[Rect], aw: f64, ah: f64) -> Vec<f32> {
    let mut out = vec![0f32; rects.len().max(1) * 4];
    for (i, r) in rects.iter().enumerate() {
        out[i * 4] = ((r.x + 0.5) / aw) as f32;
        out[i * 4 + 1] = ((r.y + 0.5) / ah) as f32;
        out[i * 4 + 2] = ((r.w - 1.0).max(0.0) / aw) as f32;
        out[i * 4 + 3] = ((r.h - 1.0).max(0.0) / ah) as f32;
    }
    out
}

pub struct LedData { pub led: Vec<f32>, pub meta: Vec<f32>, pub total: usize }

pub fn build_led_data(fixtures: &[Fixture], surfaces: &[Surface], order: &[String], seg_count: usize) -> LedData {
    const OFF: f64 = 65535.0;
    let pi = std::f64::consts::PI;   // Math.PI
    let (mut led, mut meta) = (Vec::new(), Vec::new());
    let (mut led_base, mut seg_cursor) = (0f64, 0f64);
    let off_seg = seg_count as f64;
    for f in fixtures {
        let segs = fixture_segments(f);
        let cx = f.x + f.width / 2.0;
        let cy = f.y + f.height / 2.0;
        let rads = num_or(&f.rotation, 0.0) * (pi / 180.0);
        let (cos, sin) = (libm::cos(rads), libm::sin(rads));
        let surf = surfaces.iter().find(|s| links(f, &s.id));
        let s_idx = surf.map_or(OFF, |s| order.iter().position(|o| o == &s.id).map_or(-1.0, |p| p as f64));
        let (scx, scy, sr, sw, sh) = match surf {
            Some(s) => {
                let w = num_or(&s.width, 1.0);
                let h = num_or(&s.height, 1.0);
                // `surf.x + surf.width / 2` uses the RAW width (no `|| 1`), as the TS does.
                let rw = num_coalesce(&s.width, f64::NAN);
                let rh = num_coalesce(&s.height, f64::NAN);
                (s.x + rw / 2.0, s.y + rh / 2.0, -num_or(&s.rotation, 0.0) * (pi / 180.0), w, h)
            }
            None => (0.0, 0.0, 0.0, 1.0, 1.0),
        };
        let (scos, ssin) = (libm::cos(sr), libm::sin(sr));
        let matrix = is_matrix(f);
        let cols = num_coalesce(&f.matrix_width, 1.0).max(1.0);
        let rows = num_coalesce(&f.matrix_height, 1.0).max(1.0);
        let cells = cols * rows;
        let horiz = f.width >= f.height;
        let reverse = truthy(&f.reverse);
        let serp = truthy(&f.serpentine);
        let mut i = 0f64;
        while i < f.led_count {
            let j = segs.iter().position(|s| i >= s.start && i < s.stop);
            let (seg_index, seg_start, seg_len, local, mut tt) = match j {
                None => (off_seg, 0.0, 0.0, 0.0, 0.0),
                Some(q) => {
                    let s = segs[q];
                    let len = s.stop - s.start;
                    let local = i - s.start;
                    (seg_cursor + q as f64, led_base + s.start, len, local, if len > 1.0 { local / (len - 1.0) } else { 0.0 })
                }
            };
            if j.is_some() && reverse { tt = 1.0 - tt; }
            let gi = if reverse { f.led_count - 1.0 - i } else { i };
            // `f.ledMap ? (f.ledMap[gi] ?? gi) : gi`
            let g = match &f.led_map {
                Some(m) => {
                    let e = if gi >= 0.0 && gi.fract() == 0.0 { m.get(gi as usize) } else { None };
                    match e { Some(v) if !v.is_null() => v.as_f64().unwrap_or(f64::NAN), _ => gi }
                }
                None => gi,
            };
            let (mut rel_x, mut rel_y) = (0f64, 0f64);
            if matrix {
                let gg = g.min(cells - 1.0);
                let row = (gg / cols).floor();
                let mut col = gg % cols;   // JS % on f64
                if serp && row % 2.0 == 1.0 { col = cols - 1.0 - col; }
                rel_x = (col + 0.5) * (f.width / cols) - f.width / 2.0;
                rel_y = (row + 0.5) * (f.height / rows) - f.height / 2.0;
            } else if horiz {
                let step = f.width / f.led_count;
                rel_x = g * step + step / 2.0 - f.width / 2.0;
            } else {
                let step = f.height / f.led_count;
                rel_y = g * step + step / 2.0 - f.height / 2.0;
            }
            let rx = rel_x * cos - rel_y * sin;
            let ry = rel_x * sin + rel_y * cos;
            let (gx, gy) = (cx + rx, cy + ry);
            let (mut uu, mut vv) = (gx, gy);
            if surf.is_some() {
                let (ddx, ddy) = (gx - scx, gy - scy);
                let lx = ddx * scos - ddy * ssin;
                let ly = ddx * ssin + ddy * scos;
                uu = lx / sw + 0.5;
                vv = ly / sh + 0.5;
            }
            led.extend_from_slice(&[uu as f32, vv as f32, tt as f32, seg_index as f32]);
            meta.extend_from_slice(&[seg_start as f32, seg_len as f32, local as f32, s_idx as f32]);
            i += 1.0;
        }
        led_base += f.led_count;
        seg_cursor += segs.len() as f64;
    }
    let total = led.len() / 4;
    LedData { led, meta, total }
}

// ── the parity harness's entry ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub name: String,
    pub fixtures: Vec<Fixture>,
    pub surfaces: Vec<Surface>,
    pub max_dim: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseOut {
    pub name: String,
    pub surface_order: Vec<String>,
    pub seg_count: usize,
    pub total: usize,
    /// f32 buffers as their u32 BIT PATTERNS — compared bit for bit, never through a decimal.
    pub led: Vec<u32>,
    pub meta: Vec<u32>,
    pub seg_params: Vec<u32>,
    pub plan: Plan,
    pub rect_data: Vec<u32>,
}

pub fn run_case(c: &Case) -> CaseOut {
    let order = surface_order(&c.fixtures, &c.surfaces);
    let seg_count = count_segments(&c.fixtures);
    let d = build_led_data(&c.fixtures, &c.surfaces, &order, seg_count);
    let plan = plan_atlas(&order, &c.fixtures, &c.surfaces, c.max_dim);
    let rect_data = plan.packed.as_ref().map(|p| atlas_rect_data(&p.rects, p.w, p.h)).unwrap_or_default();
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<u32>>();
    CaseOut {
        name: c.name.clone(), surface_order: order, seg_count, total: d.total,
        led: bits(&d.led), meta: bits(&d.meta), seg_params: bits(&build_seg_params(&c.fixtures)),
        rect_data: bits(&rect_data), plan,
    }
}
