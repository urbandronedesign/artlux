//! E6j — DECODER PRE-ROLL: a film of the scene the show is about to enter, opened and positioned BEFORE the cut.
//!
//! Measured 2026-11-27 (the 4K heavy show, timers `open.mp4` / `mp4.find`): a film that appears at a scene switch
//! starts MID-FILM — the MP4 surface clock is the app's one free-running clock (mp4Codec `clock`), so a film entering
//! a minute into the show is at `clock mod duration` — and the render thread had to open the decoder (40–100 ms) and
//! decode from the key frame before that point up to it (115–307 ms a 4K film). Several films switching together froze
//! every output and the whole wire for 0.5–0.7 s at each cut.
//!
//! The host knows what comes next (smLookahead — the state machine's soonest edges, the scene each enters, and for a
//! timed edge WHEN): it names those films in the document (`preroll: [{path, at}]`, `at` the clock it predicts for the
//! cut, or null for an edge with no time). For each, a worker here opens the decoder OFF the render thread, positions it
//! at the predicted time, then FOLLOWS the live clock (the tick's `clk.mp4`) until the runtime adopts it — so a cut a
//! little later than predicted (a fade's length, a late tick) still finds it in place, decoding a frame or two. A cut
//! EARLIER than predicted, or an untimed edge, falls back to positioning on the render thread, as before.
//!
//! Threads: the decoder's COM objects live in the process's multithreaded apartment (mf.rs opens with
//! `COINIT_MULTITHREADED` on whichever thread opens), so one opened here is usable on the render thread. It is MOVED
//! whole across, never shared — the worker gives it up under the slot's lock and never touches it again.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The app's MP4 surface clock (µs), as the last tick carried it (`clk.mp4`); i64::MIN until one has.
pub static CLOCK: AtomicI64 = AtomicI64::new(i64::MIN);

/// A pre-rolled decoder stops following, and is dropped, this long after its predicted cut if nobody adopted it.
const GIVE_UP_US: i64 = 15_000_000;
/// How often the worker brings a waiting decoder up to the clock.
const FOLLOW_EVERY: Duration = Duration::from_millis(8);

/// The runtime's fold of the app's absolute clock into the file (runtime.rs Source::Mp4): `abs mod dur`, and in the gap
/// before a late first frame the previous loop's time (mp4Decoder tsOfAbs).
pub fn local_of(abs: i64, dur: i64, first: i64) -> i64 {
    let mut local = if dur > 0 { abs - abs.div_euclid(dur) * dur } else { abs };
    if dur > 0 && abs >= dur && local < first { local += dur; }
    local
}

#[cfg(windows)]
struct Moved(crate::mf::Mp4In);
// SAFETY: see the module note — the decoder's COM objects are in the multithreaded apartment, and the value is moved
// whole from the worker to the render thread under a lock, never used by both.
#[cfg(windows)]
unsafe impl Send for Moved {}

#[cfg(windows)]
pub struct Preroll {
    pub path: String,
    /// The predicted cut (clock µs), if the host had one.
    pub at: Option<i64>,
    slot: Arc<Mutex<Option<Moved>>>,
    stop: Arc<AtomicBool>,
    /// The worker has finished opening (and positioning) — successfully or not.
    settled: Arc<AtomicBool>,
}

#[cfg(windows)]
impl Drop for Preroll { fn drop(&mut self) { self.stop.store(true, Ordering::SeqCst); } }

#[cfg(windows)]
impl Preroll {
    pub fn start(gpu: Arc<crate::Gpu>, path: String, at: Option<i64>) -> Preroll {
        let slot: Arc<Mutex<Option<Moved>>> = Arc::new(Mutex::new(None));
        let (stop, settled) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
        let (sl, st, se, p) = (slot.clone(), stop.clone(), settled.clone(), path.clone());
        let _ = std::thread::Builder::new().name("mp4 preroll".into()).spawn(move || {
            let t0 = std::time::Instant::now();
            let dur = crate::mp4demux::movie_duration_us(&p).unwrap_or(0);
            let mut rx = match crate::mf::Mp4In::open_with(&p, Some(&gpu)) {
                Ok(rx) => rx,
                Err(e) => { eprintln!("artlux-engine: preroll: {p}: {e}"); se.store(true, Ordering::SeqCst); return; }
            };
            let first = rx.first_ts();
            if let Some(at) = at { let _ = rx.frame_at(local_of(at, dur, first)); }
            eprintln!("artlux-engine: preroll: {p} ready in {:.0} ms{}", t0.elapsed().as_secs_f64() * 1e3,
                at.map_or(String::from(" (no predicted time: opened only)"), |a| format!(" at {} µs of the file (clock {a})", local_of(a, dur, first))));
            *sl.lock().unwrap_or_else(|e| e.into_inner()) = Some(Moved(rx));
            se.store(true, Ordering::SeqCst);
            // FOLLOW: from the predicted cut on, keep the decoder at the live clock until it is adopted or given up.
            let Some(at) = at else { return };
            while !st.load(Ordering::SeqCst) {
                std::thread::sleep(FOLLOW_EVERY);
                let clk = CLOCK.load(Ordering::Relaxed);
                if clk == i64::MIN || clk < at { continue; }
                if clk > at + GIVE_UP_US { eprintln!("artlux-engine: preroll: {p} not adopted 15 s after its predicted cut — dropped"); *sl.lock().unwrap_or_else(|e| e.into_inner()) = None; return; }
                let mut g = sl.lock().unwrap_or_else(|e| e.into_inner());
                let Some(Moved(rx)) = g.as_mut() else { return };   // adopted
                let _ = rx.frame_at(local_of(clk, dur, first));
            }
        });
        Preroll { path, at, slot, stop, settled }
    }

    /// The decoder, opened and positioned — waiting up to `wait` for a worker still opening it. None: it failed, or
    /// did not finish in time (the caller opens as before).
    pub fn take(&self, wait: Duration) -> Option<crate::mf::Mp4In> {
        let until = std::time::Instant::now() + wait;
        while !self.settled.load(Ordering::SeqCst) {
            if std::time::Instant::now() >= until { return None; }
            std::thread::sleep(Duration::from_millis(2));
        }
        self.stop.store(true, Ordering::SeqCst);
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).take().map(|m| m.0)
    }
}

/// The same file named two ways (the host's URL, a resolved path): one key.
pub fn key(path: &str) -> String { path.replace('\\', "/").to_lowercase() }

#[cfg(test)]
mod tests {
    /// The duration a pre-roll folds with, for each file in ARTLUX_DUR_FILES (`;`-separated) — compared with the app's
    /// own (mp4box) number by hand / by a script; prints `path=µs`.
    #[test]
    fn movie_durations() {
        for p in std::env::var("ARTLUX_DUR_FILES").unwrap_or_default().split(';').filter(|p| !p.is_empty()) {
            println!("DUR {p}={:?}", crate::mp4demux::movie_duration_us(p));
        }
    }

    #[test]
    fn the_fold_is_the_runtimes() {
        // In the first loop: the time itself. Later loops: folded. Before a late first frame: the previous loop's tail.
        assert_eq!(super::local_of(2_000_000, 10_000_000, 0), 2_000_000);
        assert_eq!(super::local_of(62_214_000, 30_000_000, 0), 2_214_000);
        assert_eq!(super::local_of(30_050_000, 30_000_000, 83_333), 30_050_000);
        assert_eq!(super::local_of(5_000, 30_000_000, 83_333), 5_000);
    }
}
