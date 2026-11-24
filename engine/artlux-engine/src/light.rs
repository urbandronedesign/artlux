//! E3e — THE LIGHTING EVALUATORS, in Rust (plans/native-engine.md §4: "lighting takes and phase spread are
//! ported to Rust"). A port, line for line, of what the app evaluates per frame for a LIGHT fixture, before the
//! packer solves it into DMX:
//!
//!   - lighting clips → role values: services/lightingTake.ts (`sampleRole`, `sampleEffect`, `phaseOffset`,
//!     `rolesOf`, `centreOf`, `wrapIntoTake`), services/lightingSequence.ts (`compile`, `curveFor`) and the loop
//!     of services/lightingPlayback.ts (active lighting clips, their group's fixtures in the group's order, later
//!     clips over earlier);
//!   - colour lanes → a colour per fixture: services/colorSample.ts (`sampleColorLane`, `blend`),
//!     services/colorEngine.ts (`mixColor` in rgb / hsv / oklab, `temperatureColor`, `resolveColorValue`) and the
//!     loop of services/colorPlayback.ts (a lane's fixture or its group, phase-spread like a clip).
//!
//! Every formula keeps the app's JavaScript semantics where they differ from Rust's: `Math.max` with a NaN is
//! NaN (`jmax`), `%` is fmod (Rust's f64 `%` is too), `x ?? d` takes any present value. `npm run
//! test:light-eval-parity` holds the two against each other, on the app's own code bundled from source.

use crate::eval::{sample_lane, segment_ease, Curve, Key};
use serde_json::Value;
use std::collections::HashMap;
use std::f64::consts::PI;

/// JavaScript's Math.max of two: NaN if either is.
fn jmax(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) } }
/// `x ?? d` for a number field: null / missing → d; a non-number → NaN (what JS arithmetic makes of most).
fn num(v: &Value, d: f64) -> f64 { match v { Value::Null => d, x => x.as_f64().unwrap_or(f64::NAN) } }

fn keys_of(v: &Value) -> Vec<Key> { v.as_array().into_iter().flatten().filter_map(Key::from_json).collect() }

fn hash01(n: f64) -> f64 {
    let x = libm::sin(n * 127.1) * 43758.5453;   // fdlibm, as V8: the hash amplifies an ulp 43758×
    x - x.floor()
}

/// A generated movement (lightingTake.ts LightingEffect).
#[derive(Clone, Debug)]
pub struct Effect { pub form: String, pub role: String, pub centre: f64, pub amplitude: f64, pub period: f64 }

impl Effect {
    pub fn from_json(e: &Value) -> Option<Self> {
        if !e.is_object() { return None; }
        Some(Effect { form: e["form"].as_str().unwrap_or("").into(), role: e["role"].as_str().unwrap_or("").into(), centre: num(&e["centre"], f64::NAN), amplitude: num(&e["amplitude"], f64::NAN), period: num(&e["periodSec"], f64::NAN) })
    }
}

/// lightingTake.ts sampleEffect.
pub fn sample_effect(e: &Effect, time: f64) -> f64 {
    let period = if e.period > 0.0 { e.period } else { 1.0 };
    let p = ((time % period) + period) % period / period;
    let unit = match e.form.as_str() {
        "sine" => libm::sin(p * PI * 2.0),
        "triangle" => 1.0 - 4.0 * (p - 0.5).abs(),
        "ramp" => p * 2.0 - 1.0,
        "square" => if p < 0.5 { 1.0 } else { -1.0 },
        "random" => hash01((time / period).floor()) * 2.0 - 1.0,
        _ => 0.0,
    };
    e.centre + unit * e.amplitude
}

/// The spread fields a lighting clip and a colour lane share (lightingTake.ts PhaseSpread).
#[derive(Clone, Debug, Default)]
pub struct Spread { pub phase: f64, pub mode: Option<String>, pub wings: Option<f64>, pub blocks: Option<f64> }

impl Spread {
    pub fn from_json(c: &Value) -> Self {
        let opt = |k: &str| match &c[k] { Value::Null => None, x => Some(x.as_f64().unwrap_or(f64::NAN)) };
        Spread { phase: num(&c["phase"], 0.0), mode: c["phaseMode"].as_str().map(str::to_string), wings: opt("wings"), blocks: opt("blocks") }
    }
}

/// lightingTake.ts phaseOffset — the time offset of fixture `index` of `total`, in seconds.
pub fn phase_offset(c: &Spread, index: f64, total: f64) -> f64 {
    let step = c.phase;
    if step == 0.0 || step.is_nan() || total <= 1.0 { return 0.0; }
    match c.mode.as_deref().unwrap_or("spread") {
        "wing" => {
            let wings = jmax(1.0, c.wings.unwrap_or(2.0));
            let per = total / wings;
            let in_wing = index % per;
            step * (in_wing - (per - 1.0) / 2.0).abs()
        }
        "block" => {
            let blocks = jmax(1.0, c.blocks.unwrap_or(2.0));
            let size = jmax(1.0, (total / blocks).ceil());
            step * (index / size).floor()
        }
        "random" => step * hash01(index * 7.0 + 13.0) * total,
        _ => step * index,
    }
}

/// A recorded take (types.ts LightingTake): its parts' per-role curves.
#[derive(Clone, Debug, Default)]
pub struct Take { pub duration: f64, pub parts: Vec<HashMap<String, Vec<Key>>> }

impl Take {
    pub fn from_json(t: &Value) -> Self {
        Take {
            duration: num(&t["duration"], f64::NAN),
            parts: t["parts"].as_array().into_iter().flatten().map(|p| p["channels"].as_object().into_iter().flatten().map(|(r, k)| (r.clone(), keys_of(k))).collect()).collect(),
        }
    }
}

/// A pose sequence compiled to per-slot curves (lightingSequence.ts CompiledSequence).
#[derive(Clone, Debug, Default)]
pub struct Sequence { pub duration: f64, pub slots: Vec<HashMap<String, Vec<Key>>>, pub roles: Vec<String> }

/// lightingSequence.ts compile. `poses` = the project's named poses, by id.
pub fn compile_sequence(seq: &Value, poses: &HashMap<String, Vec<Value>>) -> Sequence {
    let empty: Vec<Value> = Vec::new();
    let keys: Vec<&Value> = seq["keys"].as_array().into_iter().flatten().collect();
    let slots_of = |k: &Value| -> Vec<Value> {
        let s = k["slots"].as_array().cloned().unwrap_or_default();
        if !s.is_empty() { return s; }
        match k["poseRef"].as_str() { Some(r) if !r.is_empty() => poses.get(r).cloned().unwrap_or_default(), _ => empty.clone() }
    };
    let width = keys.iter().map(|k| slots_of(k).len()).max().unwrap_or(0);
    let mut slots = Vec::new();
    let mut roles: Vec<String> = Vec::new();
    for s in 0..width {
        let mut by_role: HashMap<String, Vec<Key>> = HashMap::new();
        for key in &keys {
            let ks = slots_of(key);
            if ks.is_empty() { continue; }
            let pose = &ks[s % ks.len()];
            let Some(obj) = pose.as_object() else { continue };
            for (role, value) in obj {
                let Some(v) = value.as_f64().filter(|v| v.is_finite()) else { continue };
                let kind = key["roleCurves"][role].as_str().or(key["curve"].as_str()).unwrap_or("linear").to_string();
                by_role.entry(role.clone()).or_default().push(Key {
                    t: num(&key["t"], f64::NAN), v,
                    curve: Curve { kind: Some(kind), bez: [key["cx1"].as_f64(), key["cy1"].as_f64(), key["cx2"].as_f64(), key["cy2"].as_f64()] },
                });
                if !roles.contains(role) { roles.push(role.clone()); }
            }
        }
        slots.push(by_role);
    }
    Sequence { duration: num(&seq["duration"], f64::NAN), slots, roles }
}

fn curve_for<'a>(c: &'a Sequence, index: usize, role: &str) -> Option<&'a Vec<Key>> {
    if c.slots.is_empty() { return None; }
    c.slots[index % c.slots.len()].get(role)
}

/// One lighting clip's lighting fields (types.ts LightingClip).
#[derive(Clone, Debug, Default)]
pub struct Clip { pub spread: Spread, pub effect: Option<Effect>, pub mirror: bool, pub scale: f64, pub offset: f64, pub role_mask: Option<Vec<String>> }

impl Clip {
    pub fn from_json(l: &Value) -> Self {
        Clip {
            spread: Spread::from_json(l), effect: Effect::from_json(&l["effect"]), mirror: l["mirror"].as_bool().unwrap_or(false),
            scale: num(&l["scale"], 1.0), offset: num(&l["offset"], 0.0),
            role_mask: l["roleMask"].as_array().map(|a| a.iter().filter_map(|r| r.as_str().map(str::to_string)).collect()),
        }
    }
}

/// lightingTake.ts rolesOf — every role the clip drives, honouring its mask.
pub fn roles_of(clip: &Clip, take: Option<&Take>, seq: Option<&Sequence>) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    let mut add = |r: &str| if !all.iter().any(|x| x == r) { all.push(r.to_string()) };
    if let Some(e) = &clip.effect { add(&e.role); }
    for p in take.map(|t| t.parts.as_slice()).unwrap_or(&[]) { for r in p.keys() { add(r); } }
    for r in seq.map(|s| s.roles.as_slice()).unwrap_or(&[]) { add(r); }
    all.into_iter().filter(|r| clip.role_mask.as_ref().is_none_or(|m| m.contains(r))).collect()
}

fn wrap_into_take(time: f64, duration: f64) -> f64 {
    if !(duration > 0.0) { return 0.0; }
    ((time % duration) + duration) % duration
}

fn centre_of(take: Option<&Take>, role: &str, seq: Option<&Sequence>) -> f64 {
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut scan = |k: Option<&Vec<Key>>| for x in k.into_iter().flatten() { if x.v < min { min = x.v; } if x.v > max { max = x.v; } };
    for p in take.map(|t| t.parts.as_slice()).unwrap_or(&[]) { scan(p.get(role)); }
    for s in seq.map(|s| s.slots.as_slice()).unwrap_or(&[]) { scan(s.get(role)); }
    if min.is_finite() { (min + max) / 2.0 } else { 0.0 }
}

/// lightingTake.ts sampleRole — one fixture's role under one clip, None when the clip does not drive it.
pub fn sample_role(clip: &Clip, take: Option<&Take>, seq: Option<&Sequence>, local_time: f64, index: usize, total: usize, role: &str) -> Option<f64> {
    let time = local_time - phase_offset(&clip.spread, index as f64, total as f64);
    let mut value = if let Some(s) = seq {
        curve_for(s, index, role).filter(|k| !k.is_empty()).map(|k| sample_lane(k, wrap_into_take(time, s.duration), false))
    } else if let Some(e) = clip.effect.as_ref().filter(|e| e.role == role) {
        Some(sample_effect(e, time))
    } else if let Some(t) = take.filter(|t| !t.parts.is_empty()) {
        t.parts[index % t.parts.len()].get(role).filter(|k| !k.is_empty()).map(|k| sample_lane(k, wrap_into_take(time, t.duration), false))
    } else { None }?;
    let eff_centre = |r: &str| clip.effect.as_ref().filter(|e| e.role == r).map(|e| e.centre);
    if clip.scale != 1.0 {
        let c = eff_centre(role).unwrap_or_else(|| centre_of(take, role, seq));
        value = c + (value - c) * clip.scale;
    }
    if clip.offset != 0.0 && !clip.offset.is_nan() { value += clip.offset; }
    if clip.mirror && role == "pan" && (index as f64) >= (total as f64 / 2.0).ceil() {
        let c = eff_centre("pan").unwrap_or_else(|| centre_of(take, "pan", seq));
        value = c - (value - c);
    }
    Some(value)
}

// ── Colour ─────────────────────────────────────────────────────────────────────────────────────────

pub type Rgb = [f64; 3];

/// A colour value (types.ts ColorValue): an RGB triple (linear) or a warm↔cold temperature 0..1.
#[derive(Clone, Debug, PartialEq)]
pub enum Color { Rgb(Rgb), Cct(f64) }

impl Color {
    pub fn from_json(v: &Value) -> Option<Self> {
        match v["kind"].as_str()? {
            "rgb" => { let a = v["rgb"].as_array()?; Some(Color::Rgb([num(a.first()?, f64::NAN), num(a.get(1)?, f64::NAN), num(a.get(2)?, f64::NAN)])) }
            "cct" => Some(Color::Cct(num(&v["t"], f64::NAN))),
            _ => None,
        }
    }
    pub fn to_json(&self) -> Value {
        match self { Color::Rgb(c) => serde_json::json!({ "kind": "rgb", "rgb": c }), Color::Cct(t) => serde_json::json!({ "kind": "cct", "t": t }) }
    }
}

/// colorEngine.ts resolveColorValue — a palette reference followed; an unresolved one is nothing.
pub fn resolve_color(v: &Value, palette: &HashMap<String, Color>) -> Option<Color> {
    if v["kind"].as_str() == Some("ref") { return v["id"].as_str().and_then(|id| palette.get(id).cloned()); }
    Color::from_json(v)
}

const WARM: Rgb = [1.0, 0.82, 0.62];   // fixtureSignal.ts EMITTERS.warmWhite
const COLD: Rgb = [0.82, 0.9, 1.0];    // EMITTERS.coldWhite

fn normalise_peak(c: Rgb) -> Rgb {
    let peak = c[0].max(c[1]).max(c[2]);
    if peak > 1e-6 { [c[0] / peak, c[1] / peak, c[2] / peak] } else { [0.0; 3] }
}

/// colorEngine.ts temperatureColor.
pub fn temperature_color(t: f64) -> Rgb {
    let u = if t < 0.0 { 0.0 } else if t > 1.0 { 1.0 } else { t };
    normalise_peak([WARM[0] + (COLD[0] - WARM[0]) * u, WARM[1] + (COLD[1] - WARM[1]) * u, WARM[2] + (COLD[2] - WARM[2]) * u])
}

fn rgb_to_hsv(c: Rgb) -> Rgb {
    let [r, g, b] = c;
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let d = max - min;
    let mut h = 0.0;
    if d > 1e-9 {
        h = if max == r { ((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0 } else if max == g { ((b - r) / d + 2.0) / 6.0 } else { ((r - g) / d + 4.0) / 6.0 };
    }
    [h, if max > 1e-9 { d / max } else { 0.0 }, max]
}

fn hsv_to_rgb(h: f64, s: f64, v: f64) -> Rgb {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - f * s), v * (1.0 - (1.0 - f) * s));
    match (((i % 6.0) + 6.0) % 6.0) as i64 {
        0 => [v, t, p], 1 => [q, v, p], 2 => [p, v, t], 3 => [p, q, v], 4 => [t, p, v], _ => [v, p, q],
    }
}

fn rgb_to_oklab(c: Rgb) -> Rgb {
    let l = (0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]).cbrt();
    let m = (0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]).cbrt();
    let s = (0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]).cbrt();
    [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ]
}

fn oklab_to_rgb(lab: Rgb) -> Rgb {
    let l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]).powi(3);
    let m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]).powi(3);
    let s = (lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2]).powi(3);
    [
        (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s).max(0.0),
        (-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s).max(0.0),
        (-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s).max(0.0),
    ]
}

/// colorEngine.ts mixColor — the path between two colours; `u` is already eased.
pub fn mix_color(a: Rgb, b: Rgb, u: f64, space: &str) -> Rgb {
    let t = if u < 0.0 { 0.0 } else if u > 1.0 { 1.0 } else { u };
    if space == "rgb" { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    if space == "hsv" {
        let (aa, bb) = (rgb_to_hsv(a), rgb_to_hsv(b));
        let mut dh = bb[0] - aa[0];
        if dh > 0.5 { dh -= 1.0; } else if dh < -0.5 { dh += 1.0; }
        return hsv_to_rgb(aa[0] + dh * t, aa[1] + (bb[1] - aa[1]) * t, aa[2] + (bb[2] - aa[2]) * t);
    }
    let (aa, bb) = (rgb_to_oklab(a), rgb_to_oklab(b));
    oklab_to_rgb([aa[0] + (bb[0] - aa[0]) * t, aa[1] + (bb[1] - aa[1]) * t, aa[2] + (bb[2] - aa[2]) * t])
}

fn blend(av: &Color, bv: &Color, space: &str, e: f64) -> Color {
    if let (Color::Cct(a), Color::Cct(b)) = (av, bv) { return Color::Cct(a + (b - a) * e); }
    let rgb = |c: &Color| match c { Color::Rgb(x) => *x, Color::Cct(t) => temperature_color(*t) };
    Color::Rgb(mix_color(rgb(av), rgb(bv), e, space))
}

/// colorSample.ts sampleColorLane — one lane's colour at `t` (keys: the lane's, JSON, sorted).
pub fn sample_color_lane(lane: &Value, t: f64, palette: &HashMap<String, Color>) -> Option<Color> {
    let keys = lane["keys"].as_array()?;
    if keys.is_empty() || lane["enabled"] == Value::Bool(false) { return None; }
    let kt = |i: usize| num(&keys[i]["t"], f64::NAN);
    let n = keys.len();
    if t <= kt(0) { return resolve_color(&keys[0]["value"], palette); }
    if t >= kt(n - 1) { return resolve_color(&keys[n - 1]["value"], palette); }
    let mut i = 0;
    while i + 2 < n && kt(i + 1) <= t { i += 1; }
    let (a, b) = (&keys[i], &keys[i + 1]);
    let av = resolve_color(&a["value"], palette)?;
    let bv = resolve_color(&b["value"], palette)?;
    let span = kt(i + 1) - kt(i);
    if span <= 0.0 { return Some(bv); }
    if a["curve"].as_str() == Some("hold") { return Some(av); }
    let u = (t - kt(i)) / span;
    let e = segment_ease(&Curve::from_json(a), u).clamp(0.0, 1.0);
    Some(blend(&av, &bv, a["space"].as_str().unwrap_or("oklab"), e))
}

/// The parity harness's engine half (`--light-cases`): each case → its value, in order.
///   {"role": {clip, take?, seq?, poses?, localTime, index, total, role}} → number | null
///   {"roles": {clip, take?, seq?, poses?}}                               → [role…]
///   {"phase": {spread…}, "index", "total"}                               → number
///   {"color": lane, "t", "palette": [NamedColor…]}                       → ColorValue | null
///   {"mix": [a, b], "u", "space"}                                         → [r, g, b]
pub fn run_cases(cases: &Value) -> Value {
    use serde_json::json;
    let poses_of = |p: &Value| -> HashMap<String, Vec<Value>> { p.as_array().into_iter().flatten().filter_map(|x| Some((x["id"].as_str()?.to_string(), x["slots"].as_array().cloned().unwrap_or_default()))).collect() };
    let out: Vec<Value> = cases.as_array().into_iter().flatten().map(|c| {
        if let Some(r) = c.get("role") {
            let clip = Clip::from_json(&r["clip"]);
            let take = r.get("take").filter(|t| t.is_object()).map(Take::from_json);
            let seq = r.get("seq").filter(|s| s.is_object()).map(|s| compile_sequence(s, &poses_of(&r["poses"])));
            json!(sample_role(&clip, take.as_ref(), seq.as_ref(), num(&r["localTime"], 0.0), r["index"].as_u64().unwrap_or(0) as usize, r["total"].as_u64().unwrap_or(1) as usize, r["role"].as_str().unwrap_or("")))
        } else if let Some(r) = c.get("roles") {
            let clip = Clip::from_json(&r["clip"]);
            let take = r.get("take").filter(|t| t.is_object()).map(Take::from_json);
            let seq = r.get("seq").filter(|s| s.is_object()).map(|s| compile_sequence(s, &poses_of(&r["poses"])));
            let mut v = roles_of(&clip, take.as_ref(), seq.as_ref());
            v.sort();
            json!(v)
        } else if let Some(p) = c.get("phase") {
            json!(phase_offset(&Spread::from_json(p), num(&c["index"], 0.0), num(&c["total"], 0.0)))
        } else if let Some(l) = c.get("color") {
            let pal: HashMap<String, Color> = c["palette"].as_array().into_iter().flatten().filter_map(|x| Some((x["id"].as_str()?.to_string(), Color::from_json(&x["value"])?))).collect();
            sample_color_lane(l, num(&c["t"], 0.0), &pal).map(|x| x.to_json()).unwrap_or(Value::Null)
        } else if let Some(m) = c.get("mix") {
            let rgb = |v: &Value| [num(&v[0], 0.0), num(&v[1], 0.0), num(&v[2], 0.0)];
            json!(mix_color(rgb(&m[0]), rgb(&m[1]), num(&c["u"], 0.0), c["space"].as_str().unwrap_or("oklab")))
        } else { Value::Null }
    }).collect();
    Value::Array(out)
}

// ── The show: the players' loops (lightingPlayback.ts / colorPlayback.ts tick) ─────────────────────────

/// lightingOverlay.ts HTP_ROLES — intensity and colour roles combine HIGHEST-takes-precedence across clips;
/// every other role is latest-takes-precedence.
const HTP_ROLES: &[&str] = &["dimmer", "red", "green", "blue", "white", "warmWhite", "coldWhite", "amber", "uv", "lime", "indigo", "cyan", "magenta", "yellow"];

struct ShowClip { start: f64, duration: f64, in_point: f64, clip: Clip, take: Option<String>, seq: Option<String>, group: Option<String> }

/// What the app's lighting and colour players read (nativeLink lightingDoc), ready to evaluate.
#[derive(Default)]
pub struct Show {
    pub on: bool,
    clips: Vec<ShowClip>,
    takes: HashMap<String, Take>,
    seqs: HashMap<String, Sequence>,
    groups: HashMap<String, Vec<String>>,
    fixtures: std::collections::HashSet<String>,
    color_lanes: Vec<Value>,
    color_groups: HashMap<String, Vec<String>>,
    color_fixtures: std::collections::HashSet<String>,
    palette: HashMap<String, Color>,
}

/// Role values per fixture, and a colour per fixture — what the two overlays hold after a frame.
pub type Roles = HashMap<String, HashMap<String, f64>>;
pub type Colors = HashMap<String, Color>;

impl Show {
    pub fn from_json(d: &Value) -> Self {
        let groups_of = |g: &Value| -> HashMap<String, Vec<String>> { g.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect())).collect() };
        let ids = |a: &Value| a.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect();
        let poses: HashMap<String, Vec<Value>> = d["poses"].as_array().into_iter().flatten().filter_map(|x| Some((x["id"].as_str()?.to_string(), x["slots"].as_array().cloned().unwrap_or_default()))).collect();
        let opt_id = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
        Show {
            on: d["on"].as_bool().unwrap_or(false),
            clips: d["clips"].as_array().into_iter().flatten().map(|c| ShowClip {
                start: num(&c["start"], f64::NAN), duration: num(&c["duration"], f64::NAN), in_point: num(&c["inPoint"], 0.0),
                clip: Clip::from_json(&c["lighting"]), take: opt_id(&c["lighting"]["takeId"]), seq: opt_id(&c["lighting"]["sequenceId"]), group: opt_id(&c["lighting"]["groupId"]),
            }).collect(),
            takes: d["takes"].as_array().into_iter().flatten().filter_map(|t| Some((t["id"].as_str()?.to_string(), Take::from_json(t)))).collect(),
            seqs: d["sequences"].as_array().into_iter().flatten().filter_map(|s| Some((s["id"].as_str()?.to_string(), compile_sequence(s, &poses)))).collect(),
            groups: groups_of(&d["groups"]), fixtures: ids(&d["fixtures"]),
            color_lanes: d["colorLanes"].as_array().cloned().unwrap_or_default(),
            color_groups: groups_of(&d["colorGroups"]), color_fixtures: ids(&d["colorFixtures"]),
            palette: d["palette"].as_array().into_iter().flatten().filter_map(|x| Some((x["id"].as_str()?.to_string(), Color::from_json(&x["value"])?))).collect(),
        }
    }

    pub fn is_empty(&self) -> bool { self.clips.is_empty() && self.color_lanes.is_empty() }

    /// lightingPlayback.ts tick — every active lighting clip, in timeline order, onto its group's fixtures.
    pub fn roles(&self, playhead: f64) -> Roles {
        let mut out: Roles = HashMap::new();
        for c in &self.clips {
            if !(playhead >= c.start && playhead < c.start + c.duration) { continue; }
            let take = c.take.as_ref().and_then(|id| self.takes.get(id));
            let seq = c.seq.as_ref().and_then(|id| self.seqs.get(id));
            if seq.is_none() && take.is_none() && c.clip.effect.is_none() { continue; }
            let Some(members) = c.group.as_ref().and_then(|g| self.groups.get(g)) else { continue };
            let targets: Vec<&String> = members.iter().filter(|f| self.fixtures.contains(*f)).collect();
            if targets.is_empty() { continue; }
            let roles = roles_of(&c.clip, take, seq);
            if roles.is_empty() { continue; }
            let local = playhead - c.start + c.in_point;
            for (i, f) in targets.iter().enumerate() {
                for role in &roles {
                    let Some(v) = sample_role(&c.clip, take, seq, local, i, targets.len(), role) else { continue };
                    let m = out.entry((*f).clone()).or_default();
                    if HTP_ROLES.contains(&role.as_str()) { if let Some(&p) = m.get(role) { if p >= v { continue; } } }
                    m.insert(role.clone(), v);
                }
            }
        }
        out
    }

    /// colorPlayback.ts tick — every enabled lane, phase-spread over its fixture or group, the later lane winning.
    pub fn colors(&self, playhead: f64) -> Colors {
        let mut out: Colors = HashMap::new();
        for lane in &self.color_lanes {
            if lane["enabled"] == Value::Bool(false) || lane["keys"].as_array().is_none_or(|k| k.is_empty()) { continue; }
            let targets: Vec<String> = if let Some(f) = lane["fixtureId"].as_str().filter(|s| !s.is_empty()) {
                if self.color_fixtures.contains(f) { vec![f.to_string()] } else { vec![] }
            } else {
                lane["groupId"].as_str().and_then(|g| self.color_groups.get(g)).map(|m| m.iter().filter(|f| self.color_fixtures.contains(*f)).cloned().collect()).unwrap_or_default()
            };
            let spread = Spread::from_json(lane);
            let n = targets.len();
            for (i, f) in targets.into_iter().enumerate() {
                let at = playhead - phase_offset(&spread, i as f64, n as f64);
                if let Some(c) = sample_color_lane(lane, at, &self.palette) { out.insert(f, c); }
            }
        }
        out
    }
}
