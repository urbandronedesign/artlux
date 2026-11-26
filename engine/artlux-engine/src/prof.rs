//! MEASUREMENT (ARTLUX_ENGINE_STATS=1) — where each thread's time goes, stage by stage.
//!
//! plans/engine-optimisation-and-deferred-3d.md O0-1: every later optimisation is judged by what it saved, so the
//! render thread, each projector presenter and the 3D view's presenter time their stages here and report every 5 s:
//! `artlux-engine: stats <thread>: <stage> <n>× p50 <ms> p99 <ms> max <ms> · …`. Per THREAD (a thread-local table),
//! so no lock is taken and no thread waits on another's measurement; off, each call is one relaxed atomic load.
//!
//! CPU time only. A stage that WAITS for the GPU (`leds.wait`, a readback) is that wait, which is the number a
//! device-wide `poll(Wait)` costs the thread — the coupling the plan's O3 removes.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

const EVERY: Duration = Duration::from_secs(5);

/// 0 = not read yet, 1 = off, 2 = on. The environment is read once per process.
static ON: AtomicU8 = AtomicU8::new(0);

pub fn on() -> bool {
    match ON.load(Ordering::Relaxed) {
        0 => {
            let v = std::env::var("ARTLUX_ENGINE_STATS").is_ok_and(|v| v == "1");
            ON.store(if v { 2 } else { 1 }, Ordering::Relaxed);
            v
        }
        s => s == 2,
    }
}

struct Table { at: Instant, rows: Vec<(&'static str, Vec<f32>)> }

thread_local! { static T: RefCell<Option<Table>> = const { RefCell::new(None) }; }

/// One sample of `stage` on this thread. Stages are reported in the order they are first seen.
pub fn add(stage: &'static str, d: Duration) {
    if !on() { return; }
    T.with(|t| {
        let mut t = t.borrow_mut();
        let t = t.get_or_insert_with(|| Table { at: Instant::now(), rows: Vec::new() });
        let ms = d.as_secs_f32() * 1000.0;
        match t.rows.iter_mut().find(|r| r.0 == stage) { Some(r) => r.1.push(ms), None => t.rows.push((stage, vec![ms])) }
    });
}

/// Times `f` as `stage` (and nothing, off).
pub fn time<R>(stage: &'static str, f: impl FnOnce() -> R) -> R {
    if !on() { return f(); }
    let at = Instant::now();
    let r = f();
    add(stage, at.elapsed());
    r
}

/// Reports this thread's table once EVERY has passed since the last report, then starts a new one.
pub fn report(thread: &str) {
    if !on() { return; }
    T.with(|t| {
        let mut t = t.borrow_mut();
        let Some(tab) = t.as_mut() else { return };
        if tab.at.elapsed() < EVERY { return; }
        let line = summary(&mut tab.rows);
        if !line.is_empty() { eprintln!("artlux-engine: stats {thread}: {line}"); }
        tab.rows.clear();
        tab.at = Instant::now();
    });
}

fn summary(rows: &mut [(&'static str, Vec<f32>)]) -> String {
    rows.iter_mut().filter(|r| !r.1.is_empty()).map(|(name, v)| {
        v.sort_by(|a, b| a.total_cmp(b));
        let q = |p: f32| v[((v.len() - 1) as f32 * p).round() as usize];
        format!("{name} {}× p50 {:.2} p99 {:.2} max {:.2} ms", v.len(), q(0.5), q(0.99), v[v.len() - 1])
    }).collect::<Vec<_>>().join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantiles_of_a_known_set() {
        let mut rows = vec![("a", (1..=100).map(|x| x as f32).collect::<Vec<_>>()), ("empty", vec![])];
        let s = summary(&mut rows);
        assert_eq!(s, "a 100× p50 51.00 p99 99.00 max 100.00 ms");
    }
}
