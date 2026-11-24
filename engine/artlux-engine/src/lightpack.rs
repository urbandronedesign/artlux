//! E3f — A LIGHT'S DMX BYTES, solved by the engine (plans/native-engine.md §4). The step after light.rs: the
//! role values and colours the show evaluates become channel bytes through the fixture's PROFILE, the way the
//! app's packer does it per frame for every light:
//!
//!   - services/profilePack.ts: `modeOf`, `modePlan` (a slot per DMX offset, a 16/24-bit channel split over the
//!     bytes THIS MODE emits, an undefined channel still occupying its slot), `channelValue` (the live fader, then
//!     the role override converted through the channel's physical range, then the authored value, then the
//!     profile default; clamped; inverted) and `packProfiled` (fixed point, most-significant byte first);
//!   - services/colorEngine.ts: `colorCapability` (mix / temperature / wheel / none), `fit` (the bounded
//!     least-squares descent), `solveEmitters`, `flagsForColor`, `solveTemperature`, `temperatureOf`,
//!     `nearestSlot` and `realiseColor` — and `solveCached`, which solves the colour QUANTISED to 1/255;
//!   - services/fixtureSignal.ts: `EMITTERS` and `colorModel` (a mode is subtractive when it has cyan / magenta /
//!     yellow and no red / green / blue);
//!   - engine/frameEngine.ts packAndPublish: THE PRECEDENCE STACK — profile default < authored dmx < lighting clip
//!     < pose cue < colour lane < automation lane < live fader — and the RGB→CMY bridge on a subtractive head.
//!
//! JavaScript semantics are kept where Rust's differ: Math.round (half up), Math.max / Math.min with a NaN,
//! `>>` on Int32 with the count taken mod 32, and a NaN reaching the wire as 0. `npm run test:light-pack-parity`
//! holds this against the app's own code on every mode of the shipped fixture library.

use crate::light::Color;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn jmax(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) } }
fn jmin(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) } }
/// JavaScript's Math.round: half toward +∞.
fn jround(x: f64) -> f64 { let f = x.floor(); if x - f >= 0.5 { f + 1.0 } else { f } }
/// ECMAScript ToInt32.
fn to_i32(x: f64) -> i32 {
    if !x.is_finite() { return 0; }
    let m = x.trunc().rem_euclid(4294967296.0);
    (if m >= 2147483648.0 { m - 4294967296.0 } else { m }) as i32
}
/// `c < 0 ? 0 : c > 1 ? 1 : c` — a NaN passes through, as in the app.
fn clamp01(c: f64) -> f64 { if c < 0.0 { 0.0 } else if c > 1.0 { 1.0 } else { c } }

/// fixtureSignal.ts EMITTERS — what each emitter role adds, in linear RGB.
pub fn emitter(role: &str) -> Option<[f64; 3]> {
    Some(match role {
        "red" => [1.0, 0.0, 0.0], "green" => [0.0, 1.0, 0.0], "blue" => [0.0, 0.0, 1.0],
        "white" => [1.0, 1.0, 1.0], "warmWhite" => [1.0, 0.82, 0.62], "coldWhite" => [0.82, 0.9, 1.0],
        "amber" => [1.0, 0.65, 0.1], "uv" => [0.28, 0.05, 0.9], "lime" => [0.72, 1.0, 0.2], "indigo" => [0.3, 0.1, 1.0],
        "cyan" => [0.0, 1.0, 1.0], "magenta" => [1.0, 0.0, 1.0], "yellow" => [1.0, 1.0, 0.0],
        _ => return None,
    })
}
const SUBTRACTIVE: &[&str] = &["cyan", "magenta", "yellow"];
const PRIMARIES: &[&str] = &["red", "green", "blue"];
/// frameEngine.ts CMY_FROM_RGB.
fn cmy_from_rgb(role: &str) -> Option<&'static str> {
    match role { "cyan" => Some("red"), "magenta" => Some("green"), "yellow" => Some("blue"), _ => None }
}

// ── The profile ────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Range { pub from: f64, pub to: f64, pub color: Option<String>, pub label: String }

#[derive(Clone, Debug)]
pub struct Channel {
    pub key: String,
    pub role: String,
    /// NaN when the profile gives none (the app's `undefined` reaches the wire as 0 the same way).
    pub default: f64,
    pub invert: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub ranges: Vec<Range>,
}

#[derive(Clone, Debug)]
pub struct Mode {
    pub key: String,
    /// A slot: the channel it names and which byte of it (0 = most significant). None: reserved, written 0.
    pub slots: Vec<Option<(String, f64)>>,
}

#[derive(Clone, Debug)]
pub struct Profile { pub channels: Vec<Channel>, pub modes: Vec<Mode> }

fn f(v: &Value) -> Option<f64> { v.as_f64() }

impl Profile {
    pub fn from_json(p: &Value) -> Self {
        Profile {
            channels: p["channels"].as_array().into_iter().flatten().map(|c| Channel {
                key: c["key"].as_str().unwrap_or_default().to_string(),
                role: c["role"].as_str().unwrap_or_default().to_string(),
                default: f(&c["default"]).unwrap_or(f64::NAN),
                invert: c["invert"].as_bool().unwrap_or(false),
                min: f(&c["min"]), max: f(&c["max"]),
                ranges: c["ranges"].as_array().into_iter().flatten().map(|r| Range {
                    from: f(&r["from"]).unwrap_or(f64::NAN), to: f(&r["to"]).unwrap_or(f64::NAN),
                    color: r["color"].as_str().map(str::to_string),
                    label: r["label"].as_str().unwrap_or_default().to_string(),
                }).collect(),
            }).collect(),
            modes: p["modes"].as_array().into_iter().flatten().map(|m| Mode {
                key: m["key"].as_str().unwrap_or_default().to_string(),
                slots: m["slots"].as_array().into_iter().flatten().map(|s| {
                    let k = s["channelKey"].as_str()?;
                    Some((k.to_string(), f(&s["byte"]).unwrap_or(f64::NAN)))
                }).collect(),
            }).collect(),
        }
    }

    /// profilePack.ts modeOf — the mode named, else the first.
    pub fn mode_of(&self, key: Option<&str>) -> Option<&Mode> {
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            if let Some(m) = self.modes.iter().find(|m| m.key == k) { return Some(m); }
        }
        self.modes.first()
    }
}

/// What a colour can be made with on one mode (colorEngine.ts ColorCapability).
#[derive(Clone, Debug, PartialEq)]
pub enum Control { Mix, Temperature, Wheel, None }

/// One (profile, mode), prepared once: the slot plan, the colour model and the colour capability.
#[derive(Clone, Debug)]
pub struct Head {
    /// Per DMX offset: (channel index, byte, bytes this mode emits for the channel), or None (written 0).
    plan: Vec<Option<(usize, f64, f64)>>,
    channels: Vec<Channel>,
    pub subtractive: bool,
    pub control: Control,
    /// Emitter roles, in the profile's channel order.
    emitters: Vec<String>,
    cct: bool,
    wheel: Option<usize>,
    /// Per profile channel: does this mode address it (colorModel's `inMode`).
    in_mode: Vec<bool>,
}

impl Head {
    pub fn new(profile: &Profile, mode: &Mode) -> Self {
        // modePlan
        let mut bytes: HashMap<&str, f64> = HashMap::new();
        for (k, _) in mode.slots.iter().flatten() { *bytes.entry(k.as_str()).or_insert(0.0) += 1.0; }
        let plan = mode.slots.iter().map(|s| {
            let (k, byte) = s.as_ref()?;
            // `new Map(channels.map(c => [c.key, c]))`: a repeated key resolves to its LAST channel.
            let ci = profile.channels.iter().rposition(|c| &c.key == k)?;
            Some((ci, *byte, bytes.get(k.as_str()).copied().unwrap_or(1.0)))
        }).collect();
        // colorModel
        let in_mode: HashSet<&str> = mode.slots.iter().flatten().map(|(k, _)| k.as_str()).collect();
        let (mut cmy, mut prim) = (false, false);
        for c in &profile.channels {
            if !in_mode.contains(c.key.as_str()) { continue; }
            if SUBTRACTIVE.contains(&c.role.as_str()) { cmy = true; } else if PRIMARIES.contains(&c.role.as_str()) { prim = true; }
        }
        let subtractive = cmy && !prim;
        // colorCapability
        let (mut emitters, mut cct, mut wheel) = (Vec::new(), false, None);
        for (i, c) in profile.channels.iter().enumerate() {
            if !in_mode.contains(c.key.as_str()) { continue; }
            if c.role == "colorTemp" { cct = true; continue; }
            if c.role == "colorWheel" { if wheel.is_none() { wheel = Some(i); } continue; }
            if subtractive && SUBTRACTIVE.contains(&c.role.as_str()) { continue; }
            if emitter(&c.role).is_some() { emitters.push(c.role.clone()); }
        }
        let has = |r: &str| emitters.iter().any(|e| e == r);
        let mixable = (has("red") && has("green") && has("blue")) || subtractive;
        let temperature = !mixable && (cct || (has("coldWhite") && has("warmWhite")));
        let control = if mixable { Control::Mix } else if temperature { Control::Temperature } else if wheel.is_some() { Control::Wheel } else { Control::None };
        let in_mode = profile.channels.iter().map(|c| in_mode.contains(c.key.as_str())).collect();
        Head { plan, channels: profile.channels.clone(), subtractive, control, emitters, cct, wheel, in_mode }
    }

    /// colorEngine.ts realiseColor — one authored colour as role values this head can take (empty: it can't).
    pub fn realise(&self, value: &Color) -> HashMap<String, f64> {
        let mut out = HashMap::new();
        if self.control == Control::Temperature {
            let t = match value { Color::Cct(t) => *t, Color::Rgb(c) => temperature_of(*c) };
            let u = clamp01(t);
            if self.cct { out.insert("colorTemp".into(), u); return out; }
            let (cold, warm) = (u, 1.0 - u);
            let p = jmax(cold, warm);
            let peak = if p == 0.0 || p.is_nan() { 1.0 } else { p };   // `|| 1`
            out.insert("coldWhite".into(), cold / peak);
            out.insert("warmWhite".into(), warm / peak);
            return out;
        }
        let rgb = match value { Color::Rgb(c) => *c, Color::Cct(t) => crate::light::temperature_color(*t) };
        if self.control == Control::Mix {
            if self.subtractive {
                let c = normalise_peak(rgb);
                out.insert("cyan".into(), 1.0 - c[0]); out.insert("magenta".into(), 1.0 - c[1]); out.insert("yellow".into(), 1.0 - c[2]);
                return out;
            }
            // solveCached: the colour quantised to 1/255 is what is solved.
            let q = |v: f64| jround(v * 255.0) / 255.0;
            return self.solve([q(rgb[0]), q(rgb[1]), q(rgb[2])]);
        }
        if self.control == Control::Wheel {
            if let Some(w) = self.wheel {
                if let Some(r) = nearest_slot(&self.channels[w], rgb) { out.insert("colorWheel".into(), ((r.from + r.to) / 2.0) / 255.0); }
            }
        }
        out
    }

    /// colorEngine.ts solveEmitters (the values only).
    fn solve(&self, target: [f64; 3]) -> HashMap<String, f64> {
        let want = normalise_peak(target);
        let basis: Vec<[f64; 3]> = self.emitters.iter().map(|r| emitter(r).unwrap()).collect();
        let w = fit(want, &basis);
        let peak = w.iter().fold(0.0, |a, &b| jmax(a, b));
        let scale = if peak > 1e-6 { 1.0 / peak } else { 0.0 };
        let mut out = HashMap::new();
        for (i, r) in self.emitters.iter().enumerate() { out.insert(r.clone(), jmin(1.0, w[i] * scale)); }
        out
    }
}

fn normalise_peak(c: [f64; 3]) -> [f64; 3] {
    let peak = jmax(jmax(c[0], c[1]), c[2]);
    if peak > 1e-6 { [c[0] / peak, c[1] / peak, c[2] / peak] } else { [0.0; 3] }
}

/// colorEngine.ts fit — box-constrained least squares by projected gradient, from zero, 6000 passes at most.
fn fit(target: [f64; 3], basis: &[[f64; 3]]) -> Vec<f64> {
    let n = basis.len();
    let mut w = vec![0.0; n];
    if n == 0 { return w; }
    let mut lip = 0.0;
    for b in basis { lip += b[0] * b[0] + b[1] * b[1] + b[2] * b[2]; }
    let step = 1.0 / jmax(1e-6, 2.0 * lip);
    for _ in 0..6000 {
        let (mut sr, mut sg, mut sb) = (0.0, 0.0, 0.0);
        for i in 0..n { sr += w[i] * basis[i][0]; sg += w[i] * basis[i][1]; sb += w[i] * basis[i][2]; }
        let (er, eg, eb) = (sr - target[0], sg - target[1], sb - target[2]);
        let mut moved: f64 = 0.0;
        for i in 0..n {
            let g = 2.0 * (er * basis[i][0] + eg * basis[i][1] + eb * basis[i][2]);
            let next = jmin(1.0, jmax(0.0, w[i] - step * g));
            moved = jmax(moved, (next - w[i]).abs());
            w[i] = next;
        }
        if moved < 1e-7 { break; }
    }
    w
}

/// colorEngine.ts temperatureOf — a colour projected onto the warm↔cold line.
fn temperature_of(rgb: [f64; 3]) -> f64 {
    let (warm, cold) = (emitter("warmWhite").unwrap(), emitter("coldWhite").unwrap());
    let (mut num, mut den) = (0.0, 0.0);
    for i in 0..3 { let d = cold[i] - warm[i]; num += (rgb[i] - warm[i]) * d; den += d * d; }
    let t = if den > 1e-9 { num / den } else { 0.5 };
    clamp01(t)
}

/// colorEngine.ts nearestSlot — the wheel slot whose hex colour is nearest; slots without one never match.
fn nearest_slot(channel: &Channel, target: [f64; 3]) -> Option<&Range> {
    let want = normalise_peak(target);
    let mut best = None;
    let mut best_d = f64::INFINITY;
    for r in &channel.ranges {
        let Some(c) = r.color.as_deref() else { continue };
        if c.is_empty() { continue; }
        let t = c.trim();   // JS trim: whitespace incl. line terminators — Rust's trim is the Unicode White_Space set
        let h = t.strip_prefix('#').unwrap_or(t);
        if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) { continue; }
        let n = u32::from_str_radix(h, 16).unwrap();
        let c = normalise_peak([((n >> 16) & 255) as f64 / 255.0, ((n >> 8) & 255) as f64 / 255.0, (n & 255) as f64 / 255.0]);
        let d = (c[0] - want[0]).powi(2) + (c[1] - want[1]).powi(2) + (c[2] - want[2]).powi(2);
        if d < best_d { best_d = d; best = Some(r); }
    }
    best
}

// ── The stack, and the bytes ─────────────────────────────────────────────────────────────────────────────

/// What lies over one light's authored values this frame — frameEngine.ts packAndPublish's overrides.
#[derive(Default)]
pub struct Over<'a> {
    /// Channel keys an automation lane owns (its value is already in `dmx`): no clip, cue or colour speaks.
    pub owned: Option<&'a HashSet<String>>,
    /// The fixture's colour (colorOverlay), realised through this head.
    pub color: Option<&'a Color>,
    /// The fired pose cue's role values (lightingCue), when one is running.
    pub cue: Option<&'a HashMap<String, f64>>,
    /// The lighting clips' role values (lightingOverlay).
    pub roles: Option<&'a HashMap<String, f64>>,
    /// Faders under a hand right now, per channel key, in the channel's own 0..1 (livePreview).
    pub live: Option<&'a HashMap<String, f64>>,
}

impl Head {
    /// frameEngine.ts roleOverride, for one channel.
    fn role_override(&self, c: &Channel, o: &Over, realised: &Option<HashMap<String, f64>>) -> Option<f64> {
        if o.owned.is_some_and(|s| s.contains(&c.key)) { return None; }
        if let Some(v) = realised.as_ref().and_then(|m| m.get(&c.role)) { return Some(*v); }
        let get = |r: &str| o.cue.and_then(|m| m.get(r)).or_else(|| o.roles.and_then(|m| m.get(r))).copied();
        if let Some(v) = get(&c.role) { return Some(v); }
        let comp = cmy_from_rgb(&c.role)?;
        if !self.subtractive { return None; }
        get(comp).map(|v| 1.0 - v)
    }

    /// profilePack.ts channelValue.
    fn channel_value(&self, c: &Channel, dmx: &Value, o: &Over, realised: &Option<HashMap<String, f64>>) -> f64 {
        if let Some(now) = o.live.and_then(|m| m.get(&c.key)) {
            let v = clamp01(*now);
            return if c.invert { 1.0 - v } else { v };
        }
        if let Some(from) = self.role_override(c, o, realised) {
            let n = match (c.min, c.max) {
                (Some(lo), Some(hi)) => { let span = hi - lo; if span == 0.0 { 0.0 } else { jmax(0.0, jmin(1.0, (from - lo) / span)) } }
                _ => from,
            };
            let v = clamp01(n);
            return if c.invert { 1.0 - v } else { v };
        }
        let raw = dmx.get(&c.key).and_then(Value::as_f64).filter(|x| x.is_finite());
        let v = clamp01(raw.unwrap_or(c.default));
        if c.invert { 1.0 - v } else { v }
    }

    /// profilePack.ts packProfiled — exactly this mode's footprint, in order. `dmx` is Fixture.dmx.
    pub fn pack(&self, dmx: &Value, o: &Over) -> Vec<u8> {
        let realised = o.color.map(|c| self.realise(c));
        self.plan.iter().map(|slot| {
            let Some((ci, byte, bytes)) = *slot else { return 0 };
            let value = self.channel_value(&self.channels[ci], dmx, o, &realised);
            let max = 256f64.powf(bytes) - 1.0;
            let raw = to_i32(jround(value * max));
            let shift = (to_i32(8.0 * (bytes - 1.0 - byte)) as u32) & 31;
            ((raw >> shift) & 0xff) as u8
        }).collect()
    }
}

/// E4b — WHAT A LIGHT IS DOING, for the 3D view's beams: fixtureSignal.ts `FixtureState` (no gobo, no `emit` —
/// the beam reads neither).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Beam { pub intensity: f64, pub r: f64, pub g: f64, pub b: f64, pub pan: f64, pub tilt: f64, pub zoom: Option<f64>, pub blackout: bool }

/// profilePack.ts selectedRange — the range a discrete channel's value selects.
fn selected_range(c: &Channel, value: f64) -> Option<&Range> {
    if c.ranges.is_empty() { return None; }
    let byte = jround(jmax(0.0, jmin(1.0, value)) * 255.0);
    c.ranges.iter().find(|r| byte >= r.from && byte <= r.to)
}
/// profilePack.ts physicalValue.
fn physical(c: &Channel, value: f64) -> Option<f64> {
    let (lo, hi) = (c.min?, c.max?);
    Some(lo + (hi - lo) * jmax(0.0, jmin(1.0, value)))
}
/// fixtureSignal.ts hexToRgb: `/^#?([0-9a-f]{6})$/i` on the trimmed string.
fn hex_rgb(hex: &str) -> Option<[f64; 3]> {
    let h = hex.trim();
    let h = h.strip_prefix('#').unwrap_or(h);
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    let n = u32::from_str_radix(h, 16).ok()?;
    Some([((n >> 16) & 255) as f64 / 255.0, ((n >> 8) & 255) as f64 / 255.0, (n & 255) as f64 / 255.0])
}

impl Head {
    /// fixtureSignal.ts resolveFixture, through the same stack `pack` writes with (frameEngine resolves every
    /// light with the override it packed it with). `npm run test:light-pack-parity` holds it to the app's.
    pub fn resolve(&self, dmx: &Value, o: &Over) -> Beam {
        let realised = o.color.map(|c| self.realise(c));
        let mut out = Beam { intensity: 1.0, ..Default::default() };
        let (mut dimmer, mut has_emitter, mut shutter_open) = (1.0f64, false, true);
        let mut cmy = [0.0f64; 3];
        for (i, c) in self.channels.iter().enumerate() {
            if !self.in_mode[i] { continue; }
            let v = self.channel_value(c, dmx, o, &realised);
            if self.subtractive {
                if let Some(axis) = SUBTRACTIVE.iter().position(|r| *r == c.role) { cmy[axis] = v; continue; }
            }
            if let Some(e) = emitter(&c.role) {
                out.r += e[0] * v; out.g += e[1] * v; out.b += e[2] * v;
                has_emitter = true;
                continue;
            }
            match c.role.as_str() {
                "dimmer" => dimmer = v,
                "pan" => out.pan = physical(c, v).unwrap_or(v * 540.0),
                "tilt" => out.tilt = physical(c, v).unwrap_or(v * 270.0),
                "zoom" => if let Some(z) = physical(c, v) { out.zoom = Some(z); },
                "shutter" | "strobe" => if let Some(r) = selected_range(c, v) {
                    let l = r.label.to_lowercase();
                    if l.contains("closed") || l.contains("blackout") { shutter_open = false; }
                },
                "colorWheel" => if let Some(col) = selected_range(c, v).and_then(|r| r.color.as_deref()).and_then(hex_rgb) {
                    out.r = col[0]; out.g = col[1]; out.b = col[2]; has_emitter = true;
                },
                _ => {}
            }
        }
        if !has_emitter { out.r = 1.0; out.g = 1.0; out.b = 1.0; }
        if self.subtractive { out.r *= 1.0 - cmy[0]; out.g *= 1.0 - cmy[1]; out.b *= 1.0 - cmy[2]; }
        let peak = jmax(jmax(out.r, out.g), out.b);
        if peak > 1.0 { out.r /= peak; out.g /= peak; out.b /= peak; }
        out.intensity = if shutter_open { dimmer } else { 0.0 };
        out.blackout = !shutter_open || dimmer <= 0.0;
        out
    }
}

/// A rig's heads, prepared once per document: (profile id, mode key as the fixture names it) → Head.
#[derive(Default)]
pub struct Rig { profiles: HashMap<String, Profile>, heads: HashMap<(String, String), Option<Head>> }

impl Rig {
    pub fn from_json(profiles: &Value) -> Self {
        Rig { profiles: profiles.as_object().into_iter().flatten().map(|(k, p)| (k.clone(), Profile::from_json(p))).collect(), heads: HashMap::new() }
    }
    pub fn is_empty(&self) -> bool { self.profiles.is_empty() }
    /// The fixture's head: None when its profile or mode does not resolve (it writes nothing — fixtureFootprint 0).
    pub fn head(&mut self, fixture: &Value) -> Option<&Head> {
        let pid = fixture["profileId"].as_str().unwrap_or_default().to_string();
        let mk = fixture["profileMode"].as_str().unwrap_or_default().to_string();
        let profiles = &self.profiles;
        self.heads.entry((pid.clone(), mk.clone())).or_insert_with(|| {
            let p = profiles.get(&pid)?;
            p.mode_of(Some(&mk)).map(|m| Head::new(p, m))
        }).as_ref()
    }
}

/// The parity harness's engine half (`--pack-cases`): each case → its value, in order.
///   {"pack": {profile, fixture: {profileMode?, dmx?}, owned?: [key], color?, cue?, roles?, live?}} → [byte…] | null
///   {"resolve": {…as pack}}                                                                          → fixtureSignal FixtureState (no emit / gobo)
///   {"realise": {profile, mode?, value}}                                                            → {role: v} | null
pub fn run_cases(cases: &Value) -> Value {
    use serde_json::json;
    let map = |v: &Value| -> Option<HashMap<String, f64>> { v.as_object().map(|o| o.iter().map(|(k, x)| (k.clone(), x.as_f64().unwrap_or(f64::NAN))).collect()) };
    let out: Vec<Value> = cases.as_array().into_iter().flatten().map(|c| {
        if let Some(p) = c.get("pack").or_else(|| c.get("resolve")) {
            let prof = Profile::from_json(&p["profile"]);
            let Some(mode) = prof.mode_of(p["fixture"]["profileMode"].as_str()) else { return Value::Null };
            let head = Head::new(&prof, mode);
            let owned: Option<HashSet<String>> = p["owned"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect());
            let color = p.get("color").and_then(Color::from_json);
            let (cue, roles, live) = (map(&p["cue"]), map(&p["roles"]), map(&p["live"]));
            let o = Over { owned: owned.as_ref(), color: color.as_ref(), cue: cue.as_ref(), roles: roles.as_ref(), live: live.as_ref() };
            let dmx = p["fixture"].get("dmx").unwrap_or(&Value::Null);
            if c.get("pack").is_some() { return json!(head.pack(dmx, &o)); }
            let b = head.resolve(dmx, &o);
            // NaN as null, as JSON.stringify writes it.
            let n = |x: f64| if x.is_finite() { json!(x) } else { Value::Null };
            json!({ "intensity": n(b.intensity), "r": n(b.r), "g": n(b.g), "b": n(b.b), "pan": n(b.pan), "tilt": n(b.tilt), "zoomDeg": b.zoom.map(n), "blackout": b.blackout })
        } else if let Some(r) = c.get("realise") {
            let prof = Profile::from_json(&r["profile"]);
            let Some(mode) = prof.mode_of(r["mode"].as_str()) else { return Value::Null };
            let Some(v) = Color::from_json(&r["value"]) else { return Value::Null };
            json!(Head::new(&prof, mode).realise(&v))
        } else { Value::Null }
    }).collect();
    Value::Array(out)
}
