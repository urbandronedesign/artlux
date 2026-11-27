//! O3-4 — THE MP4 DECODER OFF THE RENDER THREAD (plans/engine-optimisation-and-deferred-3d.md O3-4).
//!
//! Measured before (2026-11-26/27): the render thread ran each film's decoder itself — `mp4.find` (decode forward to the
//! clock) + `mp4` (the D3D11 copy into the shared NV12 slot, its spin, the conversion and its wait) ≈ 2 ms a film per
//! new frame, nearly all waiting — and at every LOOP of a film the seek back to its first key frame and the decode up to
//! it, 40–60 ms, froze every output and the whole wire (the spikes E6j's pre-roll left).
//!
//! Now a worker thread per film owns the decoder (`mf::Mp4In`, moved whole — its COM objects are in the multithreaded
//! apartment, as preroll.rs moves one) and its own converter, and keeps the NEXT frames ready as pictures — the frames
//! the clock will reach, in presentation order, ACROSS the loop (the wrap's seek happens here, a few frames early). The
//! render thread works out which frame is on screen at its clock from the file's own timetable (`frame_times` — the
//! same rule as `Mp4In::frame_at`: the frame at it within 2 µs, else the last before it, else the first) and takes that
//! picture. Only a frame the worker has not got — a scrub, a jump, the first frame — is asked for and WAITED for, as
//! before: the frame shown is always the frame the clock names, never a late one.

use crate::compose::Picture;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const EPS_US: i64 = 2;
/// How far ahead (film time) the worker keeps pictures ready: past a loop's seek (40–60 ms measured on 4K files).
const LEAD_US: i64 = 120_000;
const LEAD_MIN: usize = 2;
const LEAD_MAX: usize = 6;
/// A frame asked for and not delivered in this long is an error (the decoder is stuck), not a frozen engine.
const MISS_TIMEOUT: Duration = Duration::from_secs(5);

struct Moved(crate::mf::Mp4In);
// SAFETY: as preroll.rs — the decoder's COM objects are in the multithreaded apartment (mf.rs opens with
// COINIT_MULTITHREADED), and the value is moved whole to the worker, which alone uses it from then on.
unsafe impl Send for Moved {}
impl Moved { fn into_inner(self) -> crate::mf::Mp4In { self.0 } }   // takes the WHOLE wrapper into the thread (a field
// use would capture the bare, non-Send decoder — edition 2021's disjoint captures)

#[derive(Default)]
struct St {
    /// Ready pictures, by index in `pts`.
    pics: Vec<(usize, Picture)>,
    /// The frame the render thread is showing (index in `pts`) — None until it first asks: a decoder handed over
    /// positioned (a pre-roll, E6j) must not be sent back to frame 0 by reading ahead from a guess.
    now: Option<usize>,
    /// A frame the render thread asked for and is waiting on: its clock (local µs).
    want: Option<i64>,
    err: Option<String>,
}

pub struct Mp4Worker {
    pub path: String,
    pub software_why: Option<String>,
    first: i64,
    colour: crate::mf::Colour,
    pts: Arc<Vec<i64>>,
    sh: Arc<(Mutex<St>, Condvar)>,
    stop: Arc<AtomicBool>,
}

impl Drop for Mp4Worker {
    // The worker finishes the frame it is on and drops the decoder on its own thread — never a join here (the render
    // thread must not wait for a decode to close a film).
    fn drop(&mut self) { self.stop.store(true, Ordering::SeqCst); self.sh.1.notify_all(); }
}

fn pic_clone(p: &Picture) -> Picture { Picture { w: p.w, h: p.h, rgba: p.rgba.clone(), mips: p.mips, crop: p.crop, tex: p.tex.clone() } }

/// The index of the frame on screen at `local` (µs) — `Mp4In::frame_at`'s rule over the file's sorted presentation times.
pub fn index_at(pts: &[i64], local: i64) -> usize {
    let n = pts.partition_point(|&t| t <= local + EPS_US);
    n.saturating_sub(1)
}

impl Mp4Worker {
    pub fn start(gpu: Arc<crate::Gpu>, rx: crate::mf::Mp4In, sid: &str) -> Mp4Worker {
        let pts = Arc::new(rx.frame_times());
        let (first, colour, software_why, path) = (rx.first_ts(), rx.colour(), rx.software_why.clone(), rx.path.clone());
        let sh: Arc<(Mutex<St>, Condvar)> = Arc::new((Mutex::new(St::default()), Condvar::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let n = pts.len();
        // Frames ahead: enough to cover LEAD_US at the file's own frame rate.
        let lead = if n > 1 { let fd = ((pts[n - 1] - pts[0]) / (n as i64 - 1)).max(1); ((LEAD_US + fd - 1) / fd) as usize } else { 1 }.clamp(LEAD_MIN, LEAD_MAX).min(n.saturating_sub(1)).max(if n > 1 { 1 } else { 0 });
        let (sh2, st2, pts2, moved, name) = (sh.clone(), stop.clone(), pts.clone(), Moved(rx), format!("mp4 {sid}"));
        let _ = std::thread::Builder::new().name(name.clone()).spawn(move || {
            let mut rx = moved.into_inner();
            let conv = crate::yuv::GpuConvert::new(&gpu);
            let mut last_decoded: Option<usize> = None;
            let mut reported = Instant::now();
            let (lock, cv) = &*sh2;
            while !st2.load(Ordering::SeqCst) {
                if reported.elapsed() > Duration::from_secs(5) { crate::prof::report(&name); reported = Instant::now(); }
                let (want, now) = { let mut s = lock.lock().unwrap_or_else(|e| e.into_inner()); (s.want.take(), s.now) };
                // A frame the render thread waits for: first, whatever was ahead.
                if let Some(local) = want {
                    let i = index_at(&pts2, local);
                    let r = crate::prof::time("mp4.asked", || rx.picture(&gpu, &conv, local));
                    let mut s = lock.lock().unwrap_or_else(|e| e.into_inner());
                    match r { Ok(p) => { s.pics.retain(|(k, _)| *k != i); s.pics.push((i, p)); last_decoded = Some(i); } Err(e) => s.err = Some(e) }
                    cv.notify_all();
                    continue;
                }
                // AHEAD: the next frame after the last made, while it is within `lead` frames of what is shown.
                let Some(now) = now else {
                    let s = lock.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = cv.wait_timeout_while(s, Duration::from_millis(100), |s| s.want.is_none() && s.now.is_none() && !st2.load(Ordering::SeqCst));
                    continue;
                };
                let dist = |a: usize, b: usize| (b + n - a) % n.max(1);
                let base = last_decoded.filter(|&d| dist(now, d) <= lead).unwrap_or(now);
                let next = (base + 1) % n.max(1);
                if n > 1 && dist(now, next) <= lead && dist(now, next) > 0 {
                    let have = lock.lock().unwrap_or_else(|e| e.into_inner()).pics.iter().any(|(k, _)| *k == next);
                    if !have {
                        // Exactly that frame's time: frame_at answers the frame AT it (a wrap to frame 0 is a seek, here).
                        let r = crate::prof::time("mp4.ahead", || rx.picture(&gpu, &conv, pts2[next]));
                        let mut s = lock.lock().unwrap_or_else(|e| e.into_inner());
                        match r {
                            Ok(p) => { if s.now.is_some_and(|n| dist(n, next) <= lead) { s.pics.retain(|(k, _)| *k != next); s.pics.push((next, p)); } }
                            Err(e) => { eprintln!("artlux-engine: mp4: ahead of the clock in {}: {e}", rx.path); }
                        }
                        cv.notify_all();
                    }
                    last_decoded = Some(next);
                    continue;
                }
                // Nothing to do: wait for the render thread to move (or ask, or stop).
                let s = lock.lock().unwrap_or_else(|e| e.into_inner());
                let _ = cv.wait_timeout_while(s, Duration::from_millis(100), |s| s.want.is_none() && s.now == Some(now) && !st2.load(Ordering::SeqCst));
            }
        });
        Mp4Worker { path, software_why, first, colour, pts, sh, stop }
    }

    pub fn first_ts(&self) -> i64 { self.first }
    pub fn colour(&self) -> crate::mf::Colour { self.colour.clone() }
    /// The presentation time of the frame on screen at `local` — what the runtime keys the picture's generation on.
    pub fn shown(&self, local: i64) -> i64 { self.pts.get(index_at(&self.pts, local)).copied().unwrap_or(local) }

    /// The picture on screen at `local`: the worker's, ready — or asked for and waited on (a frame it does not have).
    pub fn picture(&self, local: i64) -> Result<Picture, String> {
        let i = index_at(&self.pts, local);
        let n = self.pts.len().max(1);
        let (lock, cv) = &*self.sh;
        let mut s = lock.lock().unwrap_or_else(|e| e.into_inner());
        let was = s.now;
        if s.now != Some(i) {
            s.now = Some(i);
            // What is behind the shown frame is never shown again (before a loop brings it round, when it is made anew).
            s.pics.retain(|(k, _)| (*k + n - i) % n <= LEAD_MAX);
            cv.notify_all();
        }
        if let Some((_, p)) = s.pics.iter().find(|(k, _)| *k == i) { crate::prof::add("mp4.ready", Duration::ZERO); return Ok(pic_clone(p)); }
        let at = Instant::now();
        let held: Vec<usize> = s.pics.iter().map(|(k, _)| *k).collect();
        s.want = Some(local);
        s.err = None;
        cv.notify_all();
        loop {
            if let Some((_, p)) = s.pics.iter().find(|(k, _)| *k == i) {
                crate::prof::add("mp4.miss", at.elapsed());
                // A long wait names itself: which frame, what was shown before, what the worker had ready.
                if at.elapsed() > Duration::from_millis(15) {
                    eprintln!("artlux-engine: mp4: waited {:.1} ms for frame {i}/{n} of {} (shown before {was:?}, ready {held:?})", at.elapsed().as_secs_f64() * 1e3, self.path);
                }
                return Ok(pic_clone(p));
            }
            if let Some(e) = s.err.take() { return Err(e); }
            if self.stop.load(Ordering::SeqCst) { return Err("the decoder stopped".into()); }
            let left = MISS_TIMEOUT.saturating_sub(at.elapsed());
            if left.is_zero() { return Err(format!("{}: no frame at {local} µs in {} s", self.path, MISS_TIMEOUT.as_secs())); }
            s = cv.wait_timeout(s, left.min(Duration::from_millis(100))).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn index_at_is_frame_ats_rule() {
        let pts = [83_333i64, 125_000, 166_667, 208_333];
        assert_eq!(super::index_at(&pts, 0), 0, "before the first frame: the first");
        assert_eq!(super::index_at(&pts, 83_331), 0, "within 2 µs of a frame: that frame");
        assert_eq!(super::index_at(&pts, 125_001), 1);
        assert_eq!(super::index_at(&pts, 166_665), 2, "2 µs before a frame counts as it");
        assert_eq!(super::index_at(&pts, 166_664), 1, "3 µs before: the one before");
        assert_eq!(super::index_at(&pts, 9_000_000), 3, "past the end: the last");
    }
}
