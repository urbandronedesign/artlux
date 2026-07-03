import type { RenderStats } from '../../../shared/protocol';

// Rolling per-frame timing for the renderer loop.
//
// The renderer had no frame-time / dropped-frame signal — only a 1 Hz frame *count* (App's FPS
// counter), which can't tell a smooth 60 fps apart from one that periodically hitches. Before we
// optimize the hot path (or add anything as demanding as spatial audio) we need to *measure*, so this
// records two things every frame and derives stats over a short rolling window:
//   • the interval between successive frames — are frames landing on time? (jank / drops)
//   • the work spent inside the frame (beginFrame→endFrame) — how much headroom is left?
//
// Pure + framework-free (no React, no DOM) so it's trivially checkable and callable from any loop.
// The Stage tick calls beginFrame()/endFrame(); App polls stats() ~1 Hz for the HUD, a console line
// in broadcast mode, and the Prometheus push. begin/end themselves are two performance.now() reads +
// a ring write — negligible, so they run unconditionally (no enable flag on the hot path).

const WINDOW = 240; // frames retained (~2–4 s at 60–120 Hz): enough for a stable p99 without lag.
// Intervals longer than this are a tab-switch / debugger pause / GC-of-death, not a render drop —
// counting them would wreck p99/max, so they're dropped from the window entirely.
const MAX_SANE_INTERVAL_MS = 1000;
const DROP_FACTOR = 1.5; // an interval > 1.5× the median counts as a long (dropped) frame.

// Fixed-capacity ring of doubles. Reused scratch avoids per-sample and per-stats allocation so the
// monitor never contributes to the GC pressure it exists to measure.
class Ring {
  private buf: Float64Array;
  private cur = 0;
  private len = 0;
  constructor(n: number) { this.buf = new Float64Array(n); }
  push(v: number): void {
    this.buf[this.cur] = v;
    this.cur = (this.cur + 1) % this.buf.length;
    if (this.len < this.buf.length) this.len++;
  }
  get count(): number { return this.len; }
  /** Copy the filled portion into `out`, sorted ascending; returns the used length. */
  snapshotSorted(out: Float64Array): number {
    for (let i = 0; i < this.len; i++) out[i] = this.buf[i];
    // Insertion sort: WINDOW is small and this runs at most ~1 Hz (only inside stats()).
    for (let i = 1; i < this.len; i++) {
      const v = out[i];
      let j = i - 1;
      while (j >= 0 && out[j] > v) { out[j + 1] = out[j]; j--; }
      out[j + 1] = v;
    }
    return this.len;
  }
}

const ZERO: RenderStats = {
  fps: 0, frameP50: 0, frameP99: 0, frameMax: 0, workP50: 0, workP99: 0, longFrames: 0, samples: 0,
};

class PerfMonitor {
  private frames = new Ring(WINDOW);
  private work = new Ring(WINDOW);
  private scratch = new Float64Array(WINDOW);
  private lastFrameTs = 0;
  private frameStartTs = 0;

  /** Call at the very top of the frame loop (unconditionally). Records the inter-frame interval. */
  beginFrame(): void {
    const now = performance.now();
    if (this.lastFrameTs > 0) {
      const dt = now - this.lastFrameTs;
      if (dt < MAX_SANE_INTERVAL_MS) this.frames.push(dt);
    }
    this.lastFrameTs = now;
    this.frameStartTs = now;
  }

  /** Call once the frame's work is done (before scheduling the next rAF). Records in-frame work. */
  endFrame(): void {
    if (this.frameStartTs > 0) this.work.push(performance.now() - this.frameStartTs);
  }

  /** Compute stats over the current window. Cheap enough to call ~1 Hz; avoid calling per-frame. */
  stats(): RenderStats {
    const n = this.frames.snapshotSorted(this.scratch);
    if (n === 0) return ZERO;
    const at = (q: number) => this.scratch[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
    const frameP50 = at(0.5);
    const frameP99 = at(0.99);
    const frameMax = this.scratch[n - 1];
    const threshold = frameP50 * DROP_FACTOR;
    let longFrames = 0;
    for (let i = 0; i < n; i++) if (this.scratch[i] > threshold) longFrames++;

    // Reuse the same scratch for the work ring (frame stats above are already extracted).
    const wn = this.work.snapshotSorted(this.scratch);
    const wAt = (q: number) => (wn === 0 ? 0 : this.scratch[Math.min(wn - 1, Math.max(0, Math.round(q * (wn - 1))))]);

    return {
      fps: frameP50 > 0 ? 1000 / frameP50 : 0,
      frameP50, frameP99, frameMax,
      workP50: wAt(0.5), workP99: wAt(0.99),
      longFrames, samples: n,
    };
  }

  /** Drop the window (e.g. after a mode change) so stale intervals don't skew the next baseline. */
  reset(): void {
    this.frames = new Ring(WINDOW);
    this.work = new Ring(WINDOW);
    this.lastFrameTs = 0;
    this.frameStartTs = 0;
  }
}

export const perfMonitor = new PerfMonitor();
