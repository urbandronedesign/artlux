//! E3c — THE TIME EVALUATORS, in Rust (plans/native-engine.md §4: "the engine evaluates anything
//! time-continuous"). A port of the app's own, line for line, so a parity harness can hold the two against
//! each other before the TypeScript path goes:
//!
//!   - `segment_ease` / `bezier_ease` / the named eases — services/automation.ts (`segmentEase`, `EASE_FN`,
//!     `bezierEase`): the one place a curve kind becomes a number, shared by automation, colour and lighting
//!     keys in the app, so here too;
//!   - `sample_lane` — automation.ts `sampleLane` (hold before the first key and after the last, coincident keys
//!     step, `hold` holds, log targets interpolate in log space). The app's frame-to-frame cursor is a speed-up
//!     of the same answer, so the port searches instead;
//!   - `clip_fade_alpha` / `clip_alpha` / `clip_time` — types.ts `clipFadeAlpha` and timeline.ts `layerAlpha`
//!     and the clip-local time `nativeLayers` reports (E3a sent both per tick; the engine now evaluates them
//!     from the playhead and the clip, which is what owning the clock needs).
//!
//! Pure f64 maths, no state. Any formula changed in automation.ts must change here, and
//! `npm run test:eval-parity` says so.

use std::f64::consts::PI;

/// The shipped `smooth` ease — the default shape for a bezier segment (automation.ts BEZ_DEFAULT).
pub const BEZ_DEFAULT: [f64; 4] = [0.42, 0.0, 0.58, 1.0];

fn bez(u: f64, p1: f64, p2: f64) -> f64 {
    let v = 1.0 - u;
    3.0 * v * v * u * p1 + 3.0 * v * u * u * p2 + u * u * u
}
fn bez_d(u: f64, p1: f64, p2: f64) -> f64 {
    let v = 1.0 - u;
    3.0 * v * v * p1 + 6.0 * v * u * (p2 - p1) + 3.0 * u * u * (1.0 - p2)
}

/// Solve x(s) = u for s (Newton, then bisection if the handle is degenerate), then return y(s) — as the app.
pub fn bezier_ease(u: f64, cx1: f64, cy1: f64, cx2: f64, cy2: f64) -> f64 {
    if u <= 0.0 { return 0.0; }
    if u >= 1.0 { return 1.0; }
    let mut s = u;
    for _ in 0..4 {
        let x = bez(s, cx1, cx2) - u;
        if x > -1e-5 && x < 1e-5 { return bez(s, cy1, cy2); }
        let d = bez_d(s, cx1, cx2);
        if d < 1e-6 { break; }
        s -= x / d;
    }
    let (mut lo, mut hi) = (0.0, 1.0);
    s = u;
    for _ in 0..20 {
        if bez(s, cx1, cx2) < u { lo = s; } else { hi = s; }
        s = (lo + hi) * 0.5;
    }
    bez(s, cy1, cy2)
}

const B1: f64 = 1.70158;
const B2: f64 = B1 * 1.525;
const B3: f64 = B1 + 1.0;
const E4: f64 = (2.0 * PI) / 3.0;
const E5: f64 = (2.0 * PI) / 4.5;

fn bounce_out(mut x: f64) -> f64 {
    let (n, d) = (7.5625, 2.75);
    if x < 1.0 / d { return n * x * x; }
    if x < 2.0 / d { x -= 1.5 / d; return n * x * x + 0.75; }
    if x < 2.5 / d { x -= 2.25 / d; return n * x * x + 0.9375; }
    x -= 2.625 / d;
    n * x * x + 0.984375
}
fn pin(x: f64, f: impl Fn(f64) -> f64) -> f64 { if x <= 0.0 { 0.0 } else if x >= 1.0 { 1.0 } else { f(x) } }
fn pw(a: f64, b: f64) -> f64 { libm::pow(a, b) }   // fdlibm, as V8

/// The classic easing set (automation.ts EASE_FN), by name. None for a name the app does not know either.
pub fn named_ease(name: &str, x: f64) -> Option<f64> {
    Some(match name {
        "easeInSine" => 1.0 - libm::cos((x * PI) / 2.0),
        "easeOutSine" => libm::sin((x * PI) / 2.0),
        "easeInOutSine" => -(libm::cos(PI * x) - 1.0) / 2.0,
        "easeInQuad" => x * x,
        "easeOutQuad" => 1.0 - (1.0 - x) * (1.0 - x),
        "easeInOutQuad" => if x < 0.5 { 2.0 * x * x } else { 1.0 - pw(-2.0 * x + 2.0, 2.0) / 2.0 },
        "easeInCubic" => x * x * x,
        "easeOutCubic" => 1.0 - pw(1.0 - x, 3.0),
        "easeInOutCubic" => if x < 0.5 { 4.0 * x * x * x } else { 1.0 - pw(-2.0 * x + 2.0, 3.0) / 2.0 },
        "easeInQuart" => x * x * x * x,
        "easeOutQuart" => 1.0 - pw(1.0 - x, 4.0),
        "easeInOutQuart" => if x < 0.5 { 8.0 * x * x * x * x } else { 1.0 - pw(-2.0 * x + 2.0, 4.0) / 2.0 },
        "easeInQuint" => x * x * x * x * x,
        "easeOutQuint" => 1.0 - pw(1.0 - x, 5.0),
        "easeInOutQuint" => if x < 0.5 { 16.0 * x * x * x * x * x } else { 1.0 - pw(-2.0 * x + 2.0, 5.0) / 2.0 },
        "easeInExpo" => pin(x, |v| pw(2.0, 10.0 * v - 10.0)),
        "easeOutExpo" => pin(x, |v| 1.0 - pw(2.0, -10.0 * v)),
        "easeInOutExpo" => pin(x, |v| if v < 0.5 { pw(2.0, 20.0 * v - 10.0) / 2.0 } else { (2.0 - pw(2.0, -20.0 * v + 10.0)) / 2.0 }),
        "easeInCirc" => 1.0 - (1.0 - pw(x, 2.0)).sqrt(),
        "easeOutCirc" => (1.0 - pw(x - 1.0, 2.0)).sqrt(),
        "easeInOutCirc" => if x < 0.5 { (1.0 - (1.0 - pw(2.0 * x, 2.0)).sqrt()) / 2.0 } else { ((1.0 - pw(-2.0 * x + 2.0, 2.0)).sqrt() + 1.0) / 2.0 },
        "easeInBack" => B3 * x * x * x - B1 * x * x,
        "easeOutBack" => 1.0 + B3 * pw(x - 1.0, 3.0) + B1 * pw(x - 1.0, 2.0),
        "easeInOutBack" => if x < 0.5 {
            (pw(2.0 * x, 2.0) * ((B2 + 1.0) * 2.0 * x - B2)) / 2.0
        } else {
            (pw(2.0 * x - 2.0, 2.0) * ((B2 + 1.0) * (x * 2.0 - 2.0) + B2) + 2.0) / 2.0
        },
        "easeInElastic" => pin(x, |v| -pw(2.0, 10.0 * v - 10.0) * libm::sin((v * 10.0 - 10.75) * E4)),
        "easeOutElastic" => pin(x, |v| pw(2.0, -10.0 * v) * libm::sin((v * 10.0 - 0.75) * E4) + 1.0),
        "easeInOutElastic" => pin(x, |v| if v < 0.5 {
            -(pw(2.0, 20.0 * v - 10.0) * libm::sin((20.0 * v - 11.125) * E5)) / 2.0
        } else {
            (pw(2.0, -20.0 * v + 10.0) * libm::sin((20.0 * v - 11.125) * E5)) / 2.0 + 1.0
        }),
        "easeInBounce" => 1.0 - bounce_out(1.0 - x),
        "easeOutBounce" => bounce_out(x),
        "easeInOutBounce" => if x < 0.5 { (1.0 - bounce_out(1.0 - 2.0 * x)) / 2.0 } else { (1.0 + bounce_out(2.0 * x - 1.0)) / 2.0 },
        _ => return None,
    })
}

/// A key's outgoing curve: its kind and, for `bezier`, its handles (None = the default's).
#[derive(Clone, Debug, Default)]
pub struct Curve { pub kind: Option<String>, pub bez: [Option<f64>; 4] }

impl Curve {
    pub fn from_json(k: &serde_json::Value) -> Self {
        Curve {
            kind: k["curve"].as_str().map(str::to_string),
            bez: [k["cx1"].as_f64(), k["cy1"].as_f64(), k["cx2"].as_f64(), k["cy2"].as_f64()],
        }
    }
}

/// The eased fraction of a segment whose OUTGOING key has curve `c`, at linear fraction `u`
/// (automation.ts segmentEase). `hold` is the caller's; linear and any unknown curve are linear.
pub fn segment_ease(c: &Curve, u: f64) -> f64 {
    let Some(k) = c.kind.as_deref() else { return u };
    if k == "linear" { return u; }
    if k == "bezier" {
        let d = BEZ_DEFAULT;
        return bezier_ease(u, c.bez[0].unwrap_or(d[0]), c.bez[1].unwrap_or(d[1]), c.bez[2].unwrap_or(d[2]), c.bez[3].unwrap_or(d[3]));
    }
    if !k.starts_with("ease") { return u; }
    named_ease(k, u).unwrap_or(u)
}

/// One automation key.
#[derive(Clone, Debug)]
pub struct Key { pub t: f64, pub v: f64, pub curve: Curve }

impl Key {
    pub fn from_json(k: &serde_json::Value) -> Option<Self> {
        Some(Key { t: k["t"].as_f64()?, v: k["v"].as_f64()?, curve: Curve::from_json(k) })
    }
}

/// Greatest index i where keys[i].t <= t, or None before the first key (automation.ts bsearch).
fn seek(keys: &[Key], t: f64) -> Option<usize> {
    if keys.is_empty() || t < keys[0].t { return None; }
    let (mut lo, mut hi) = (0usize, keys.len() - 1);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if keys[mid].t <= t { lo = mid; } else { hi = mid - 1; }
    }
    Some(lo)
}

/// The value of a lane at time `t` (automation.ts sampleLane). `keys` is non-empty and sorted, as the app's.
pub fn sample_lane(keys: &[Key], t: f64, log: bool) -> f64 {
    let Some(i) = seek(keys, t) else { return keys[0].v };
    if i >= keys.len() - 1 { return keys[keys.len() - 1].v; }
    let (a, b) = (&keys[i], &keys[i + 1]);
    let span = b.t - a.t;
    if span <= 0.0 { return b.v; }
    if a.curve.kind.as_deref() == Some("hold") { return a.v; }
    let u = (t - a.t) / span;
    let e = segment_ease(&a.curve, u);
    if log { libm::exp(libm::log(a.v) + (libm::log(b.v) - libm::log(a.v)) * e) } else { a.v + (b.v - a.v) * e }
}

/// E3i: a track's clips as the engine needs them to choose one — (clip id, start, duration), in the document's
/// clip order (timeline.ts `data.clips`, filtered to the track).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Track { pub id: Option<String>, pub spans: Vec<(String, f64, f64)> }

impl Track {
    /// `l` is one composite layer of the document: the clip it describes (`clip.id`) and its track's spans.
    pub fn from_json(l: &serde_json::Value) -> Self {
        Track {
            id: l["clip"]["id"].as_str().map(str::to_string),
            spans: l["spans"].as_array().into_iter().flatten()
                .filter_map(|s| Some((s["id"].as_str()?.to_string(), s["start"].as_f64()?, s["duration"].as_f64()?))).collect(),
        }
    }
}

/// timeline.ts activeClip — the clip under time `t` on a track: the LAST in document order whose half-open span
/// `[start, start + duration)` holds it (an overlap is won by the later clip).
pub fn active_clip(spans: &[(String, f64, f64)], t: f64) -> Option<&str> {
    let mut found = None;
    for (id, start, duration) in spans {
        if t >= *start && t < start + duration { found = Some(id.as_str()); }
    }
    found
}

/// E3j: what the engine needs of a video file to choose a timeline track's frame, as the app's codecs do.
#[derive(Clone, Debug, PartialEq)]
pub enum VidTable {
    /// hapCodec.layerFrame: `clamp(Math.round(t · fps), 0, frames − 1)` — the frame index.
    Hap { fps: f64, frames: usize },
    /// mp4Decoder FileDecoder.frame(t, loop = false): the presentation timestamps (µs, truncated as an
    /// EncodedVideoChunk's, ascending) and the file's duration; the frame shown is the LAST at or before the
    /// clamped time + PRESENT_EPS_US, else the first.
    Mp4 { ts: Vec<i64>, dur_us: f64 },
}

/// mp4Decoder.ts PRESENT_EPS_US.
pub const PRESENT_EPS_US: f64 = 1000.0;

impl VidTable {
    pub fn is_hap(&self) -> bool { matches!(self, VidTable::Hap { .. }) }
    /// The frame at clip-local time `t` (seconds): a HAP index, or an MP4 timestamp in µs.
    pub fn frame(&self, t: f64) -> i64 {
        match self {
            VidTable::Hap { fps, frames } => {
                let i = (t * fps + 0.5).floor();   // Math.round
                i.min(*frames as f64 - 1.0).max(0.0) as i64
            }
            VidTable::Mp4 { ts, dur_us } => {
                let us = t * 1e6;
                let want = if *dur_us > 0.0 { us.max(0.0).min(*dur_us) } else { us.max(0.0) };
                let i = ts.partition_point(|&x| (x as f64) <= want + PRESENT_EPS_US);
                if i > 0 { ts[i - 1] } else { ts.first().copied().unwrap_or(0) }
            }
        }
    }
}

/// What the engine needs of a timeline clip to evaluate it in time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClipTime { pub start: f64, pub in_point: f64, pub duration: f64, pub fade_in: f64, pub fade_out: f64, pub opacity: f64 }

impl ClipTime {
    pub fn from_json(c: &serde_json::Value) -> Option<Self> {
        Some(ClipTime {
            start: c["start"].as_f64()?, in_point: c["inPoint"].as_f64().unwrap_or(0.0), duration: c["duration"].as_f64()?,
            fade_in: c["fadeIn"].as_f64().unwrap_or(0.0), fade_out: c["fadeOut"].as_f64().unwrap_or(0.0),
            opacity: c["opacity"].as_f64().unwrap_or(1.0),
        })
    }
}

/// types.ts clipFadeAlpha — the linear fade envelope at clip-local time `t_local` (from the clip's start).
pub fn clip_fade_alpha(c: &ClipTime, t_local: f64) -> f64 {
    let mut g = 1.0;
    if c.fade_in > 0.0 && t_local < c.fade_in { g *= (t_local / c.fade_in).max(0.0); }
    if c.fade_out > 0.0 {
        let left = c.duration - t_local;
        if left < c.fade_out { g *= (left / c.fade_out).max(0.0); }
    }
    g
}

/// timeline.ts layerAlpha — the clip's content opacity × its fades at the playhead, clamped to [0, 1].
pub fn clip_alpha(c: &ClipTime, playhead: f64) -> f64 {
    (c.opacity * clip_fade_alpha(c, playhead - c.start)).clamp(0.0, 1.0)
}

/// The clip-local time its content is drawn at (timeline.ts nativeLayers: playhead − start + inPoint).
pub fn clip_time(c: &ClipTime, playhead: f64) -> f64 { playhead - c.start + c.in_point }

/// The parity harness's engine half: a JSON list of cases in, the values out, in order.
///   {"ease": name|"bezier"|..., "u", "cx1"…}  → segment_ease
///   {"lane": [keys], "t", "log"}              → sample_lane
///   {"clip": {...}, "ph"}                     → [clip_alpha, clip_time]
pub fn run_cases(cases: &serde_json::Value) -> serde_json::Value {
    use serde_json::json;
    let out: Vec<serde_json::Value> = cases.as_array().into_iter().flatten().map(|c| {
        if let Some(lane) = c["lane"].as_array() {
            let keys: Vec<Key> = lane.iter().filter_map(Key::from_json).collect();
            if keys.is_empty() { return serde_json::Value::Null; }
            json!(sample_lane(&keys, c["t"].as_f64().unwrap_or(0.0), c["log"].as_bool().unwrap_or(false)))
        } else if c.get("clip").is_some() {
            let Some(clip) = ClipTime::from_json(&c["clip"]) else { return serde_json::Value::Null };
            let ph = c["ph"].as_f64().unwrap_or(0.0);
            json!([clip_alpha(&clip, ph), clip_time(&clip, ph)])
        } else {
            let curve = Curve { kind: c["ease"].as_str().map(str::to_string), bez: [c["cx1"].as_f64(), c["cy1"].as_f64(), c["cx2"].as_f64(), c["cy2"].as_f64()] };
            json!(segment_ease(&curve, c["u"].as_f64().unwrap_or(0.0)))
        }
    }).collect();
    serde_json::Value::Array(out)
}

#[cfg(test)]
mod track_tests {
    use super::*;
    #[test]
    fn video_frames_as_the_codecs_choose_them() {
        let h = VidTable::Hap { fps: 30.0, frames: 90 };
        assert_eq!(h.frame(0.0), 0);
        assert_eq!(h.frame(1.0 / 60.0), 1);      // half a frame rounds up, as Math.round
        assert_eq!(h.frame(10.0), 89);          // clamped to the last
        let m = VidTable::Mp4 { ts: vec![0, 33366, 66733, 100100], dur_us: 133466.0 };
        assert_eq!(m.frame(0.0333), 33366);    // within PRESENT_EPS of the next frame
        assert_eq!(m.frame(0.0320), 0);
        assert_eq!(m.frame(5.0), 100100);        // clamped to the duration, then the last frame
    }
    #[test]
    fn the_later_clip_wins_an_overlap_and_the_end_is_open() {
        let s = vec![("a".to_string(), 0.0, 3.0), ("b".to_string(), 2.0, 2.0)];
        assert_eq!(active_clip(&s, 1.0), Some("a"));
        assert_eq!(active_clip(&s, 2.5), Some("b"));
        assert_eq!(active_clip(&s, 4.0), None);
        assert_eq!(active_clip(&s, 3.0), Some("b"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ends_and_steps() {
        for n in ["easeInSine", "easeOutBack", "easeInOutElastic", "easeOutBounce"] {
            assert!((named_ease(n, 0.0).unwrap()).abs() < 1e-9 && (named_ease(n, 1.0).unwrap() - 1.0).abs() < 1e-9, "{n}");
        }
        let k = |t: f64, v: f64, c: &str| Key { t, v, curve: Curve { kind: Some(c.into()), bez: [None; 4] } };
        let lane = [k(0.0, 0.0, "hold"), k(1.0, 1.0, "linear"), k(2.0, 3.0, "linear")];
        assert_eq!(sample_lane(&lane, -1.0, false), 0.0);
        assert_eq!(sample_lane(&lane, 0.5, false), 0.0);
        assert_eq!(sample_lane(&lane, 1.5, false), 2.0);
        assert_eq!(sample_lane(&lane, 9.0, false), 3.0);
    }
}
