// What the UI costs the frame loop — the measurement this repo has never had.
//
// services/perfMonitor answers "is the render/output loop landing frames?". It cannot answer WHY a
// frame was late, because it only sees the interval. Every frame-rate incident in this project's
// history was localized to the GPU, a decoder or file IO — but that is partly because those were the
// only things instrumented. Before the engine-decoupling work claims React costs us anything (or
// nothing), the claim has to be measurable. So this records two signals perfMonitor structurally
// cannot see:
//
//   • LONG TASKS — any main-thread task over ~50 ms, from PerformanceObserver('longtask'). This is
//     the direct evidence for "the UI stalled the engine": while a long task runs, nothing else on
//     the thread does, including the frame loop. Always on: the browser reports only the rare
//     offenders, so the steady-state cost is zero callbacks.
//   • REACT COMMITS — actualDuration per <Profiler> region, fed in by components/UiProfiler.
//     OPT-IN, because Profiler itself is not free (it times every render in its subtree).
//     Enable with `?uiperf=1` or localStorage['artlux.uiPerf']='1'; see UI_PROFILING_ENABLED below.
//
// Pure + framework-free (no React, no DOM), like perfMonitor, so it is callable from any loop and
// trivially checkable.
//
// WINDOWING DIFFERS FROM perfMonitor ON PURPOSE. perfMonitor keeps a rolling ring of the last 240
// frames and derives percentiles. Here the natural question is a RATE ("how much did the UI block in
// the last second"), and there are TWO independent ~1 Hz readers — App's Prometheus push and the
// Performance panel. A drain-on-read accumulator would silently give each of them half the events,
// so reads must be NON-MUTATING: events land in time-stamped 100 ms buckets and a read sums the ten
// buckets still inside the window. Any number of readers, at any phase, see the same truth.

const BUCKET_MS = 100;
const BUCKETS = 10; // 10 x 100 ms = a 1 s sliding window

/**
 * Fixed-capacity time-bucketed accumulator. Each slot carries the bucket index it was last written
 * for, so a stale slot is recognized and reset on write and skipped on read — no clearing pass, no
 * allocation, and a read never mutates.
 */
class Buckets {
  private count = new Float64Array(BUCKETS);
  private total = new Float64Array(BUCKETS);
  private peak = new Float64Array(BUCKETS);
  // Bucket index each slot currently holds. 0 is effectively "never written": performance.now() is
  // milliseconds since navigation start, so a live index is far above zero within the first second.
  private idx = new Float64Array(BUCKETS);

  add(ms: number, at: number): void {
    const bucket = Math.floor(at / BUCKET_MS);
    const slot = bucket % BUCKETS;
    if (this.idx[slot] !== bucket) {
      this.idx[slot] = bucket;
      this.count[slot] = 0;
      this.total[slot] = 0;
      this.peak[slot] = 0;
    }
    this.count[slot]++;
    this.total[slot] += ms;
    if (ms > this.peak[slot]) this.peak[slot] = ms;
  }

  /** Sum the buckets still inside the 1 s window. Non-mutating — safe for concurrent readers. */
  window(now: number, out: WindowSum): WindowSum {
    const bucket = Math.floor(now / BUCKET_MS);
    out.count = 0; out.totalMs = 0; out.maxMs = 0;
    for (let slot = 0; slot < BUCKETS; slot++) {
      const age = bucket - this.idx[slot];
      if (age < 0 || age >= BUCKETS) continue; // never written, or aged out
      out.count += this.count[slot];
      out.totalMs += this.total[slot];
      if (this.peak[slot] > out.maxMs) out.maxMs = this.peak[slot];
    }
    return out;
  }
}

interface WindowSum { count: number; totalMs: number; maxMs: number }

export interface UiRegionStats {
  id: string;
  commits: number;
  totalMs: number;
  maxMs: number;
}

export interface UiPerfStats {
  /** False when the runtime has no longtask observer — the numbers below are then meaningless, not zero. */
  longTaskSupported: boolean;
  longTasks: number;      // long tasks that landed in the last second
  longTaskMs: number;     // total main-thread time they blocked, ms
  longTaskMaxMs: number;  // the worst single one, ms
  /** True while the <Profiler> tree is active. When false, every commit figure below is 0 because nothing reports. */
  profiling: boolean;
  commits: number;        // React commits in the last second, all regions
  commitMs: number;       // their summed actualDuration, ms
  commitMaxMs: number;    // the worst single commit, ms
  /** Per-region breakdown, heaviest first. Allocates — read at most a few times a second. */
  regions: UiRegionStats[];
}

/**
 * Is the React <Profiler> tree active for this session?
 *
 * READ EXACTLY ONCE, AT MODULE LOAD, AND NEVER RE-EVALUATED — this is load-bearing, not laziness.
 * components/UiProfiler branches on it, so flipping it mid-session would change the element type at
 * every wrapped position and REMOUNT the subtree. Those subtrees include Stage (which publishes
 * dmx:frame), Simulator3D (one WebGL context) and TimelinePanel (one keyboard hook + one engine
 * subscription). A debug toggle must never be able to stop Art-Net, so there is no toggle: set the
 * flag, reload.
 */
export const UI_PROFILING_ENABLED: boolean = (() => {
  try {
    if (new URLSearchParams(window.location.search).get('uiperf') === '1') return true;
    return localStorage.getItem('artlux.uiPerf') === '1';
  } catch {
    return false; // no window/localStorage (worker, test harness) — profiling simply stays off
  }
})();

const EMPTY_REGIONS: UiRegionStats[] = [];

class UiPerfMonitor {
  private longTasks = new Buckets();
  private regions = new Map<string, Buckets>();
  private observer: PerformanceObserver | null = null;
  private supported = false;
  // Reused scratch so a 1 Hz read allocates nothing but the regions array it returns.
  private scratch: WindowSum = { count: 0, totalMs: 0, maxMs: 0 };
  private scratchRegion: WindowSum = { count: 0, totalMs: 0, maxMs: 0 };

  constructor() {
    this.startLongTaskObserver();
  }

  private startLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // Bucket by when the task ENDED: a 300 ms task belongs to the window that actually lost
          // that time, not to the one in which the observer callback happened to run.
          this.longTasks.add(entry.duration, entry.startTime + entry.duration);
        }
      });
      // `buffered` replays long tasks from before this module loaded — startup is exactly when the
      // worst ones happen, and they would otherwise be invisible.
      this.observer.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
      this.supported = true;
    } catch {
      // Chromium supports longtask; a runtime that doesn't must degrade to "unsupported", never to a
      // confident zero — a reader has to be able to tell "nothing blocked" from "nothing watched".
      this.observer = null;
      this.supported = false;
    }
  }

  /** Fed by components/UiProfiler's onRender. No-op unless UI_PROFILING_ENABLED. */
  noteCommit(id: string, actualDurationMs: number): void {
    let b = this.regions.get(id);
    if (!b) { b = new Buckets(); this.regions.set(id, b); } // allocates once per region id, ever
    b.add(actualDurationMs, performance.now());
  }

  /** Stats over the last second. Cheap enough for ~1 Hz polling; do not call per frame. */
  stats(): UiPerfStats {
    const now = performance.now();
    const lt = this.longTasks.window(now, this.scratch);

    let commits = 0, commitMs = 0, commitMaxMs = 0;
    let regions: UiRegionStats[] = EMPTY_REGIONS;
    if (this.regions.size > 0) {
      regions = [];
      for (const [id, b] of this.regions) {
        const w = b.window(now, this.scratchRegion);
        if (w.count === 0) continue; // idle this window — omit rather than list a row of zeroes
        commits += w.count;
        commitMs += w.totalMs;
        if (w.maxMs > commitMaxMs) commitMaxMs = w.maxMs;
        regions.push({ id, commits: w.count, totalMs: w.totalMs, maxMs: w.maxMs });
      }
      regions.sort((a, b) => b.totalMs - a.totalMs);
    }

    return {
      longTaskSupported: this.supported,
      longTasks: lt.count,
      longTaskMs: lt.totalMs,
      longTaskMaxMs: lt.maxMs,
      profiling: UI_PROFILING_ENABLED,
      commits, commitMs, commitMaxMs,
      regions,
    };
  }
}

export const uiPerfMonitor = new UiPerfMonitor();
