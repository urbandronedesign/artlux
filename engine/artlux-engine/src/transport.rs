//! E3 — THE ENGINE'S OWN TRANSPORT CLOCK (plans/native-engine.md §4, "the clock").
//!
//! The app's two clocks (services/timeline.ts runFrame) are `(now - origin) / 1000`, clamped up to the
//! region's in-point, wrapped over `[a, b)` when the document loops and parked one frame short of `b`
//! when it does not. Those rules re-anchor the origin, but only to values the same rules reproduce, so
//! they are a function of (now, origin, region) — and this module runs them. What it cannot derive are the
//! EVENTS (play / pause, a seek, a recall's swap, a region edit, the underrun clamp, the render-clock
//! flip): the app records an anchor at each (timeline.ts `markAnchor`). Every tick carries the latest one,
//! because main drops a tick the engine is too busy for and an anchor must not be lost with it; the engine
//! re-anchors only when its revision changes, so between events the clock is still the engine's own.
//!
//! Stage 1 (this): the engine runs the transport from the anchors and CHECKS its playhead and show time
//! against the app's at the frame time the app computed them for (`fm`) — the same instant, so they must
//! agree to float noise; a missing event site is a `transport: differs` line, not a guess. It also reads
//! its own clock (the wall, through the anchor's `w0`) when the tick ARRIVES, which measures how far the
//! app's frame trails the engine's clock. Stage 2 drives the evaluators from that clock; JUCE in the
//! engine process makes it the audio clock.
use serde_json::Value;

/// One transport event, as the app recorded it (timeline.ts TransportAnchor). Times in the app's
/// renderClock milliseconds; `w0` is that clock's epoch on the wall (performance.timeOrigin).
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub rev: u64,
    pub at: f64,
    pub off: bool,
    pub playing: bool,
    pub w0: f64,
    /// The scene clock: its origin, its position when paused, its region and loop, one source frame.
    pub o: f64, pub p: f64, pub a: f64, pub b: f64, pub lp: bool, pub f: f64,
    /// The show clock (the global document's), the same.
    pub so: f64, pub s: f64, pub ga: f64, pub gb: f64, pub glp: bool, pub gf: f64,
}

impl Anchor {
    pub fn from_json(v: &Value) -> Option<Anchor> {
        let n = |k: &str| v[k].as_f64();
        Some(Anchor {
            rev: v["rev"].as_u64()?, at: n("at")?, off: v["off"].as_bool().unwrap_or(false), playing: v["playing"].as_bool()?,
            w0: n("w0").unwrap_or(f64::NAN),
            o: n("o")?, p: n("p")?, a: n("a")?, b: n("b")?, lp: v["loop"].as_bool().unwrap_or(false), f: n("f")?,
            so: n("so")?, s: n("s")?, ga: n("ga")?, gb: n("gb")?, glp: v["gloop"].as_bool().unwrap_or(false), gf: n("gf")?,
        })
    }
}

/// ONE CLOCK OF runFrame, at renderClock time `now` (ms) — the scene clock and the show clock run the same
/// body on their own regions. `origin` is re-anchored exactly where the app re-anchors it (underrun, wrap,
/// park), so a step-by-step run stays bit-identical to the app's. Returns the clock's time in seconds.
/// Paused, the clock holds its position (`pos`); its origin is kept live as the app keeps it.
pub fn step_one(origin: &mut f64, now: f64, playing: bool, pos: f64, a: f64, b: f64, lp: bool, f: f64) -> f64 {
    if !playing {
        *origin = now - pos * 1000.0;
        return pos;
    }
    let mut t = (now - *origin) / 1000.0;
    if t < a {
        t = a;
        *origin = now - t * 1000.0;
    }
    if t >= b {
        if lp {
            t = a + ((t - a) % (b - a)); // Rust's % on f64 is fmod, as JavaScript's is
            *origin = now - t * 1000.0;
        } else {
            *origin = now - b * 1000.0;
            t = js_max(a, b - f);
        }
    }
    js_max(0.0, t)
}

/// Math.max: NaN in, NaN out (f64::max would drop it).
fn js_max(x: f64, y: f64) -> f64 { if x.is_nan() || y.is_nan() { f64::NAN } else { x.max(y) } }

/// The wall in the app's renderClock domain, for an anchor's `w0`: what `performance.now()` reads in the
/// editor at this instant. Both sides read the system clock, so on one machine this agrees to well
/// under a millisecond (shared/liveProtocol.ts wallNow makes the same bet across windows).
pub fn render_now(w0: f64) -> f64 {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
    ms - w0
}

/// The transport the engine runs: the latest anchor, and the two origins as runFrame has moved them since.
#[derive(Default)]
pub struct Transport {
    pub anchor: Option<Anchor>,
    o: f64,
    so: f64,
    /// Frames checked, frames differing, frames skipped (computed before the anchor they arrived with).
    pub checked: u64,
    pub diffs: u64,
    pub skipped: u64,
    /// The engine's own clock against the app's frame, while playing: (count, sum, max) of
    /// `engine's playhead when the tick arrives − the app's playhead for that frame`, in ms.
    lead: (u64, f64, f64),
    /// E3o: the audio clock's RATE against the wall (1 = no device / not measured yet) — what the engine's own
    /// clock advances at from each anchor, so picture, lights and lanes follow the sound card.
    pub audio: AudioRate,
    last_report: u64,
    anchors: u64,
    unreadable: u64,
}

static SKEW: std::sync::OnceLock<f64> = std::sync::OnceLock::new();

/// E3p — THE ENGINE'S CLOCK, READABLE FROM THE AUDIO THREAD. The render thread owns the transport; the audio thread
/// holds each sounding clip to it (audio.rs `hold`), at the wall time a given mix sample is played — not "now".
struct Shared { a: Anchor, o: f64, so: f64, ratio: f64 }
static SHARED: std::sync::Mutex<Option<Shared>> = std::sync::Mutex::new(None);

/// Both clocks — (scene playhead, show time, playing) — at WALL time `wall` (epoch seconds), on the engine's own clock
/// (the same advance as `Transport::own`: from the anchor at the audio rate). None before the first anchor, during a
/// bake, or before the render thread has published one.
pub fn clocks_at_wall(wall: f64) -> Option<(f64, f64, bool)> {
    let g = SHARED.lock().ok()?;
    let s = g.as_ref()?;
    let a = &s.a;
    let rnow = wall * 1000.0 - a.w0;
    let now = a.at + (rnow - a.at) * s.ratio;
    let (mut o, mut so) = (s.o, s.so);
    Some((step_one(&mut o, now, a.playing, a.p, a.a, a.b, a.lp, a.f), step_one(&mut so, now, a.playing, a.s, a.ga, a.gb, a.glp, a.gf), a.playing))
}

/// E3o — THE AUDIO CLOCK'S RATE AGAINST THE WALL, measured continuously. One reading of the audio clock is a whole
/// device buffer coarse (480 samples = 10 ms at 48 kHz), far too coarse to draw at; its RATE, fitted over the last
/// WINDOW seconds of readings (least squares; ±0.3 ppm over 300 s of 10 ms readings at 60 Hz — the precision grows as
/// span^1.5, and a crystal's rate moves only with temperature) and moves slowly — so the engine's clock
/// runs at the card's rate from each anchor, smoothly. Readings reset when the clock goes backwards (a reopened
/// device) or stalls; a rate further than LIMIT from the wall is refused (a wrong reading, not a crystal).
pub struct AudioRate { pts: std::collections::VecDeque<(f64, f64)>, pub ratio_set: bool, pub ratio: f64, feeds: u64, /** the fit's standard error */ pub se: f64, last_audio: f64 }
// By hand: a derived Default would start the ratio at 0 — a clock that does not move.
impl Default for AudioRate { fn default() -> Self { AudioRate { pts: Default::default(), ratio_set: false, ratio: 1.0, feeds: 0, se: f64::INFINITY, last_audio: f64::NAN } } }
impl AudioRate {
    pub const WINDOW: f64 = 300.0;
    pub const LIMIT: f64 = 1e-3;
    pub const MIN_SPAN: f64 = 3.0;
    /// The rate is APPLIED only once the fit's standard error is below this: a rate less certain than the drift it
    /// corrects would move the picture further from the sound than the wall does.
    pub const MAX_SE: f64 = 2e-6;
    /// One reading: wall seconds, audio seconds.
    pub fn feed(&mut self, wall: f64, audio: f64) {
        if audio == self.last_audio { return; }   // the same callback's stamp, read again
        self.last_audio = audio;
        if let Some(&(w0, a0)) = self.pts.back() {
            if audio < a0 || wall - w0 > 1.0 { self.pts.clear(); }   // a new device, or a gap: start over
        }
        self.pts.push_back((wall, audio));
        while self.pts.front().is_some_and(|&(w, _)| wall - w > Self::WINDOW) { self.pts.pop_front(); }
        self.feeds += 1;
        if self.feeds % 30 == 0 && self.raw_span() >= Self::MIN_SPAN {
            let v: Vec<(f64, f64)> = self.pts.iter().copied().collect();
            let (s, se) = crate::audio::slope_se(&v);
            self.se = se;
            if s.is_finite() && (s - 1.0).abs() < Self::LIMIT && se < Self::MAX_SE { self.ratio = s; self.ratio_set = true; }
        }
    }
    /// No device: the wall again.
    pub fn clear(&mut self) { self.pts.clear(); self.ratio = 1.0; self.ratio_set = false; self.se = f64::INFINITY; self.last_audio = f64::NAN; }
    /// Readings so far (seconds), whether or not the rate is applied yet.
    pub fn measured(&self) -> f64 { self.raw_span() }
    /// Seconds of readings the rate is fitted over (0 = none).
    pub fn span(&self) -> f64 { if self.ratio_set { self.raw_span() } else { 0.0 } }
    fn raw_span(&self) -> f64 { match (self.pts.front(), self.pts.back()) { (Some(a), Some(b)) => b.0 - a.0, _ => 0.0 } }
}

/// How far the engine's clock may sit from the app's at the SAME instant. The two run the same IEEE
/// operations on the same numbers, so this is float noise with room to spare — a missed event is a
/// whole seek, a pause or a frame's step, which is thousands of times this.
pub const TOLERANCE_SEC: f64 = 1e-6;

impl Transport {
    /// A tick's `tp`: a new anchor replaces the old one (a repeat of the same rev changes nothing).
    pub fn set(&mut self, tp: &Value) {
        let Some(a) = Anchor::from_json(tp) else {
            // Never silently: an anchor the engine cannot read leaves it on the previous one.
            self.unreadable += 1;
            if self.unreadable <= 5 { eprintln!("artlux-engine: transport: unreadable anchor {tp}"); }
            return;
        };
        if self.anchor.as_ref().is_some_and(|x| x.rev == a.rev) { return; }
        // The mutation the test needs (scripts/test-transport-clock.cjs): the engine's clock off by a few ms.
        let skew = *SKEW.get_or_init(|| std::env::var("ARTLUX_TRANSPORT_SKEW_MS").ok().and_then(|x| x.parse().ok()).unwrap_or(0.0));
        self.o = a.o - skew;
        self.so = a.so - skew;
        self.anchors += 1;
        if self.anchors <= 200 {
            eprintln!("artlux-engine: transport: anchor {} — {} at {:.4} s, region {}–{} s{}; show {:.4} s", a.rev,
                if a.playing { "playing" } else { "paused" }, if a.playing { (a.at - a.o) / 1000.0 } else { a.p }, a.a, a.b, if a.lp { " looping" } else { "" },
                if a.playing { (a.at - a.so) / 1000.0 } else { a.s });
        }
        self.anchor = Some(a);
    }

    /// Both clocks at the app's frame time `fm`, advancing the origins as runFrame does. None before the
    /// first anchor, during a bake (the render owns time), or for a frame computed before this anchor.
    pub fn step(&mut self, fm: f64) -> Option<(f64, f64)> {
        let a = self.anchor.clone()?;
        if a.off { return None; }
        if fm < a.at { self.skipped += 1; return None; }
        let ph = step_one(&mut self.o, fm, a.playing, a.p, a.a, a.b, a.lp, a.f);
        let st = step_one(&mut self.so, fm, a.playing, a.s, a.ga, a.gb, a.glp, a.gf);
        Some((ph, st))
    }

    /// The scene clock read off the ENGINE's own wall clock, now — pure (no origin moves). None without an
    /// anchor, during a bake, or without a wall epoch.
    pub fn own_playhead(&self) -> Option<f64> { self.own().map(|(p, _)| p) }

    /// BOTH clocks off the engine's own clock, now (E3h: what the engine DRAWS lanes and lights at). E3o: from the
    /// anchor on, that clock advances at the AUDIO clock's rate when a device is open (`audio.ratio`) — the sound
    /// card's crystal, not the wall's — so what is drawn stays with what is heard between events.
    pub fn own(&self) -> Option<(f64, f64)> {
        let a = self.anchor.as_ref()?;
        if a.off || !a.w0.is_finite() { return None; }
        let now = a.at + (render_now(a.w0) - a.at) * self.audio.ratio;
        let (mut o, mut so) = (self.o, self.so);
        Some((step_one(&mut o, now, a.playing, a.p, a.a, a.b, a.lp, a.f), step_one(&mut so, now, a.playing, a.s, a.ga, a.gb, a.glp, a.gf)))
    }

    /// E3p: hand the engine's clock to the AUDIO thread (`clocks_at_wall`) — the anchor, the origins as runFrame has
    /// moved them, and the audio rate. Called after every tick; a bake (`off`) withdraws it.
    pub fn publish(&self) {
        let s = self.anchor.as_ref().filter(|a| !a.off && a.w0.is_finite()).map(|a| Shared { a: a.clone(), o: self.o, so: self.so, ratio: self.audio.ratio });
        if let Ok(mut g) = SHARED.lock() { *g = s; }
    }

    /// One tick: take its anchor, check the app's `ph` / `t` against the engine's clock at `fm`, and read
    /// the engine's own clock against the app's frame. Logs the first differences, and a summary every
    /// 300 checked frames.
    pub fn tick(&mut self, v: &Value) {
        if v["tp"].is_object() { self.set(&v["tp"]); }
        let (Some(fm), Some(ph), Some(st)) = (v["fm"].as_f64(), v["ph"].as_f64(), v["t"].as_f64()) else { return };
        let own = self.own_playhead();
        let Some((eph, est)) = self.step(fm) else { return };
        self.checked += 1;
        let (dp, ds) = ((eph - ph).abs(), (est - st).abs());
        if !(dp <= TOLERANCE_SEC && ds <= TOLERANCE_SEC) {
            self.diffs += 1;
            if self.diffs <= 20 {
                let r = self.anchor.as_ref().map(|a| a.rev).unwrap_or(0);
                eprintln!("artlux-engine: transport: differs at frame {fm:.3} ms (anchor {r}) — playhead app {ph}, engine {eph}; show app {st}, engine {est}");
            }
        }
        // The engine's own clock: where its transport is as the tick arrives, against where the app's frame
        // was. Positive = the app's frame trails the engine (the frame's age by the time it got here).
        if let (Some(op), Some(a)) = (own, self.anchor.as_ref()) {
            let lead = (op - ph) * 1000.0;
            if a.playing && lead.abs() < 1000.0 {
                self.lead.0 += 1;
                self.lead.1 += lead;
                if lead.abs() > self.lead.2.abs() { self.lead.2 = lead; }
            }
        }
        if self.checked - self.last_report >= 300 {
            self.last_report = self.checked;
            let (n, sum, max) = self.lead;
            let mean = if n > 0 { sum / n as f64 } else { 0.0 };
            if self.audio.span() > 0.0 { eprintln!("artlux-engine: transport: the engine's clock follows the audio clock — {:+.2} ppm against the wall (±{:.2}), over {:.1} s of device readings", (self.audio.ratio - 1.0) * 1e6, self.audio.se * 1e6, self.audio.span()); }
            else if self.audio.measured() > 0.0 { eprintln!("artlux-engine: transport: measuring the audio clock — {:.1} s of device readings, ±{:.1} ppm so far (applied below ±{:.0})", self.audio.measured(), self.audio.se * 1e6, AudioRate::MAX_SE * 1e6); }
            eprintln!("artlux-engine: transport: {} frame(s) run by the engine's clock, {} differing ({} before their anchor); own clock vs the app's frame: mean {mean:.2} ms, extreme {max:.2} ms over {n} playing tick(s)", self.checked, self.diffs, self.skipped);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tp(playing: bool, o: f64, p: f64, a: f64, b: f64, lp: bool) -> Value {
        serde_json::json!({ "rev": 1, "at": 0.0, "off": false, "playing": playing, "w0": 0.0,
            "o": o, "p": p, "a": a, "b": b, "loop": lp, "f": 1.0 / 30.0,
            "so": o, "s": p, "ga": a, "gb": b, "gloop": lp, "gf": 1.0 / 30.0 })
    }
    #[test]
    fn plays_wraps_and_parks() {
        let mut t = Transport::default();
        t.set(&tp(true, 1000.0, 0.0, 0.0, 10.0, true));
        assert_eq!(t.step(3500.0).unwrap().0, 2.5);
        let (p, _) = t.step(12000.0).unwrap(); // 11 s → wraps to 1
        assert!((p - 1.0).abs() < 1e-12);
        let mut t = Transport::default();
        let mut x = tp(true, 1000.0, 0.0, 0.0, 10.0, false);
        x["rev"] = 2.into();
        t.set(&x);
        let (p, _) = t.step(12000.0).unwrap(); // past the end, no loop → one frame short of it
        assert!((p - (10.0 - 1.0 / 30.0)).abs() < 1e-12);
        let (p, _) = t.step(13000.0).unwrap(); // and it stays parked
        assert!((p - (10.0 - 1.0 / 30.0)).abs() < 1e-12);
    }
    #[test]
    fn paused_holds_and_old_frames_are_skipped() {
        let mut t = Transport::default();
        let mut x = tp(false, 0.0, 4.25, 0.0, 10.0, false);
        x["at"] = 500.0.into();
        t.set(&x);
        assert_eq!(t.step(400.0), None);
        assert_eq!(t.skipped, 1);
        assert_eq!(t.step(9000.0).unwrap().0, 4.25);
    }
    #[test]
    fn the_clock_follows_the_audio_rate() {
        // A card 10 ppm slow, read in 10 ms buffer steps at ~60 Hz ticks (jittered, as a real frame loop is) for 300 s:
        // the fit finds the rate, not the steps.
        let mut r = AudioRate::default();
        assert_eq!(r.ratio, 1.0);
        let mut seed: u64 = 12345;
        for i in 0..18000 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let jitter = (seed >> 33) as f64 / (1u64 << 31) as f64 * 0.004;
            let wall = i as f64 * 0.0167 + jitter;
            let audio = ((wall * (1.0 - 10e-6)) / 0.01).floor() * 0.01;
            r.feed(wall, audio);
        }
        assert!(((r.ratio - 1.0) * 1e6 + 10.0).abs() < 1.0, "ratio {} ppm", (r.ratio - 1.0) * 1e6);
        // …and the engine's clock advances at it from the anchor: 1000 s after a playing anchor, 10 ms behind the wall.
        // The app's clock epoch 1000 s ago, the anchor playing from 0 at its start: the wall says 1000 s, the card ~999.99.
        let mut t = Transport::default();
        let mut x = tp(true, 0.0, 0.0, 0.0, 1e9, false);
        x["w0"] = (render_now(0.0) - 1_000_000.0).into();
        t.set(&x);
        t.audio = r;
        let (p, _) = t.own().unwrap();
        assert!((p - 1000.0 * (1.0 - 10e-6)).abs() < 0.003, "{p}: the wall says ~1000, the card 999.990");
        // A reading going backwards (a reopened device) starts the fit over; clearing returns to the wall.
        t.audio.clear();
        assert_eq!(t.audio.ratio, 1.0);
    }
    #[test]
    fn underrun_clamps_to_the_in_point() {
        let mut t = Transport::default();
        t.set(&tp(true, 1000.0, 0.0, 5.0, 10.0, false));
        assert_eq!(t.step(2000.0).unwrap().0, 5.0); // 1 s into a region that starts at 5
        assert!((t.step(2500.0).unwrap().0 - 5.5).abs() < 1e-12); // and runs on from there
    }
}
