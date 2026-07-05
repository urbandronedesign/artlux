// Per-object motion filtering + prediction for the Augmenta objects (render-free, renderer-side).
//
// The Augmenta box already does detection + association (it hands us stable `id`s), so this is NOT a
// tracker — it only smooths each known object and predicts a short horizon to mask network jitter and
// the bridge cadence while keeping latency low. Ported from the LiDAR plugin's blobMotion; the only
// change is keying by the object id alone (Augmenta is a single field, not named LiDAR surfaces).
//
// State of the art: a **One-Euro filter** (Casiez et al., CHI'12) smooths position with an adaptive
// speed-based cutoff — low jitter when still, low lag when fast. Its smoothed derivative gives a
// velocity estimate (used for the heading triangle), extrapolated forward with a **bounded
// constant-velocity** model. Augmenta also ships a native velocity per object, but we derive our own
// from the smoothed position so the heading matches the displayed (filtered) motion exactly.

export interface TrailPoint { u: number; v: number; t: number } // tracking space, perf-now timestamp

export interface LiveTrack {
  id: number;
  u: number;     // smoothed + predicted, normalized [0..1], bottom-left origin
  v: number;
  vu: number;    // smoothed velocity (units/sec) — for the direction triangle
  vv: number;
  alpha: number; // 1 = fresh; fades to 0 once samples stop, before removal
  trail: TrailPoint[]; // recent display positions, oldest→newest (for the comet trail)
}

interface Config {
  smoothing: number;  // 0 = ~raw, 1 = heavy
  predictMs: number;  // extrapolation horizon cap (0 = off)
  ttl: number;        // ms after the last sample before an object is fully gone
}

let cfg: Config = { smoothing: 0.6, predictMs: 50, ttl: 700 };

export function configure(next: Partial<Config>): void {
  cfg = { ...cfg, ...next };
}

// ---- One-Euro filter ---------------------------------------------------------

const DCUTOFF = 1.0;   // derivative low-pass cutoff (Hz)
const BETA = 0.4;      // speed coefficient — higher cuts lag when moving fast

const alpha = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

// Map the 0..1 smoothing knob to a min-cutoff (Hz): light (~15 Hz) → heavy (~0.8 Hz), log-spaced.
const minCutoff = (s: number): number => {
  const k = Math.min(1, Math.max(0, s));
  return Math.exp(Math.log(15) + (Math.log(0.8) - Math.log(15)) * k);
};

interface Axis {
  xPrev: number;   // previous raw input (for the derivative)
  xHat: number;    // smoothed value
  dxHat: number;   // smoothed derivative (units/sec) — our velocity estimate
  init: boolean;
}

const newAxis = (): Axis => ({ xPrev: 0, xHat: 0, dxHat: 0, init: false });

// Advance one axis with a new raw sample `x` over elapsed `dt` seconds.
function stepAxis(a: Axis, x: number, dt: number): void {
  if (!a.init || dt <= 0) { a.xPrev = x; a.xHat = x; a.dxHat = 0; a.init = true; return; }
  const dx = (x - a.xPrev) / dt;
  a.dxHat = a.dxHat + alpha(DCUTOFF, dt) * (dx - a.dxHat);
  const cutoff = minCutoff(cfg.smoothing) + BETA * Math.abs(a.dxHat);
  a.xHat = a.xHat + alpha(cutoff, dt) * (x - a.xHat);
  a.xPrev = x;
}

// ---- Objects -----------------------------------------------------------------

// The minimal object shape the smoother needs (a subset of AugmentaObject).
export interface MotionSample { id: number; u: number; v: number; updatedAt: number }

interface Track {
  id: number;
  u: Axis;
  v: Axis;
  dispU: number;       // displayed position — chases the smoothed target every render frame
  dispV: number;
  dispInit: boolean;
  svu: number;         // heading velocity, extra-smoothed at render rate so the triangle rotates smoothly
  svv: number;
  tSample: number;     // performance.now() of the last fed sample (consumer clock)
  lastUpdatedAt: number; // store object updatedAt of the last fed sample (to gate duplicates)
  trail: TrailPoint[];
  lastTrailAt: number;
}

const STALE_HOLD = 200;       // ms after the last sample before an object starts fading
const FOLLOW_TAU_MIN = 0.04;  // render-follow time constant (s) at smoothing=0 (snappy)
const FOLLOW_TAU_MAX = 0.18;  // …at smoothing=1 (very smooth)
const TRAIL_DT = 33;          // ms between recorded trail points
const TRAIL_MAX_MS = 2000;    // history window cap (the renderer fades a shorter span)
const HEAD_TAU = 0.16;        // heading-velocity smoothing time constant (s) — smooth triangle rotation

let lastTick = -1;
const tracks = new Map<number, Track>();

// Feed the current active objects. A track's One-Euro filter only advances when a genuinely new sample
// arrived (object updatedAt changed) — the store notifies ~per-frame but data arrives slower, so we
// must not inject duplicate samples (which would corrupt the velocity estimate).
export function ingest(samples: MotionSample[], now: number): void {
  for (const s of samples) {
    let t = tracks.get(s.id);
    if (!t) { t = { id: s.id, u: newAxis(), v: newAxis(), dispU: 0, dispV: 0, dispInit: false, svu: 0, svv: 0, tSample: now, lastUpdatedAt: -1, trail: [], lastTrailAt: 0 }; tracks.set(s.id, t); }
    if (s.updatedAt === t.lastUpdatedAt) continue; // no new data for this object this frame
    const dt = t.lastUpdatedAt < 0 ? 0 : (now - t.tSample) / 1000;
    stepAxis(t.u, s.u, dt);
    stepAxis(t.v, s.v, dt);
    t.tSample = now;
    t.lastUpdatedAt = s.updatedAt;
  }
}

// Per render frame: advance each track's displayed position toward its smoothed target with a
// critically-damped follow, apply a *constant* predictive lead, advance fade, prune dead tracks.
export function tick(now: number): LiveTrack[] {
  const dtFrame = lastTick < 0 ? 1 / 60 : Math.min(0.1, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;
  const lead = cfg.predictMs / 1000; // constant lead (s) — predict ahead without frame jitter
  const tau = FOLLOW_TAU_MIN + (FOLLOW_TAU_MAX - FOLLOW_TAU_MIN) * Math.min(1, Math.max(0, cfg.smoothing));
  const k = 1 - Math.exp(-dtFrame / tau); // damped-follow gain for this frame
  const out: LiveTrack[] = [];
  for (const t of tracks.values()) {
    const ageMs = now - t.tSample;
    if (ageMs > cfg.ttl) { tracks.delete(t.id); continue; }
    const targetU = t.u.xHat + t.u.dxHat * lead;
    const targetV = t.v.xHat + t.v.dxHat * lead;
    if (!t.dispInit) { t.dispU = targetU; t.dispV = targetV; t.dispInit = true; }
    else { t.dispU += (targetU - t.dispU) * k; t.dispV += (targetV - t.dispV) * k; }
    // Render-rate low-pass of the velocity vector → smooth triangle rotation.
    const hk = 1 - Math.exp(-dtFrame / HEAD_TAU);
    t.svu += (t.u.dxHat - t.svu) * hk;
    t.svv += (t.v.dxHat - t.svv) * hk;
    // Record a time-spaced trail point (skip while fading out so the tail doesn't clump in place).
    if (ageMs <= STALE_HOLD && now - t.lastTrailAt >= TRAIL_DT) {
      t.trail.push({ u: t.dispU, v: t.dispV, t: now });
      t.lastTrailAt = now;
      const cutoff = now - TRAIL_MAX_MS;
      while (t.trail.length && t.trail[0].t < cutoff) t.trail.shift();
    }
    const fade = ageMs <= STALE_HOLD ? 1 : 1 - (ageMs - STALE_HOLD) / Math.max(1, cfg.ttl - STALE_HOLD);
    out.push({ id: t.id, u: t.dispU, v: t.dispV, vu: t.svu, vv: t.svv, alpha: Math.min(1, Math.max(0, fade)), trail: t.trail });
  }
  return out;
}

// Drop all tracks (e.g. viz disabled) so stale identities don't linger.
export function reset(): void {
  tracks.clear();
  lastTick = -1;
}
