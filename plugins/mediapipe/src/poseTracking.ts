// Pose identity + motion: turns the store's per-frame, id-less detections into smoothed, stably-id'd
// LiveTracks for the viz. BlazePose multi-pose gives NO cross-frame identity, so we assign ids by
// greedy nearest-neighbour matching each frame, smooth each track's position with a One-Euro filter
// (jitter-free when still, low-lag when moving), extrapolate a short prediction horizon, and fade a
// track out (rather than popping) when its detection disappears. Self-contained — no dependency on the
// LiDAR plugin's blobMotion, so the two trackers can't share/duplicate a singleton across bundles.

import type { Detection, PoseLandmark } from './poseStore';

export interface LiveTrack {
  id: number;
  key: string;                    // stable React/list key
  u: number; v: number;           // smoothed (+predicted) position, bottom-left normalized
  vu: number; vv: number;         // velocity, normalized units/sec
  alpha: number;                  // 0..1 fade (1 = fresh, →0 over EXIT_MS after last detection)
  score: number;                  // latest detection confidence
  landmarks?: PoseLandmark[];     // latest raw landmarks (for the skeleton overlay)
  trail: { u: number; v: number; t: number }[];
}

// ── One-Euro filter (Casiez et al.) — adaptive low-pass: heavy smoothing at rest, light when fast ──
function alphaFor(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
class OneEuro {
  private x = NaN;
  private dx = 0;
  private t = NaN;
  constructor(public minCutoff: number, public beta: number, public dCutoff = 1) {}
  filter(value: number, tSec: number): number {
    if (Number.isNaN(this.x)) { this.x = value; this.t = tSec; return value; }
    let dt = tSec - this.t; if (dt <= 0) dt = 1 / 60; this.t = tSec;
    const dValue = (value - this.x) / dt;
    const aD = alphaFor(this.dCutoff, dt);
    this.dx = aD * dValue + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = alphaFor(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

interface Track {
  id: number;
  fu: OneEuro; fv: OneEuro;
  u: number; v: number;
  vu: number; vv: number;
  lastSeen: number;               // performance.now() of the last matched detection
  matchedThisTick: boolean;
  score: number;
  landmarks?: PoseLandmark[];
  trail: { u: number; v: number; t: number }[];
}

const MATCH_DIST = 0.18;          // max normalized distance a detection may jump to keep its id
const EXIT_MS = 400;              // fade-out window after a track stops being detected
const TRAIL_MS = 1500;            // max trail age retained (trimmed further by trailSeconds at draw)

let minCutoff = 1.2;              // One-Euro params, updated by configure(smoothing)
let beta = 0.01;
let predictMs = 40;               // constant-velocity extrapolation horizon

const tracks: Track[] = [];
let nextId = 1;
let lastIngestAt = -1;

// Map the scene's 0..1 "smoothing" knob to One-Euro cutoffs: 0 → responsive (minCutoff 3.0), 1 →
// heavy (minCutoff 0.3). beta trades a little lag for less overshoot. predictMs is a straight passthrough.
export function configure(opts: { smoothing?: number; predictMs?: number }): void {
  if (opts.smoothing != null) {
    const s = Math.max(0, Math.min(1, opts.smoothing));
    minCutoff = 3.0 - 2.7 * s;
    beta = 0.005 + 0.02 * (1 - s);
    for (const t of tracks) { t.fu.minCutoff = minCutoff; t.fu.beta = beta; t.fv.minCutoff = minCutoff; t.fv.beta = beta; }
  }
  if (opts.predictMs != null) predictMs = Math.max(0, opts.predictMs);
}

export function reset(): void { tracks.length = 0; nextId = 1; lastIngestAt = -1; }

const dist2 = (au: number, av: number, bu: number, bv: number): number => {
  const du = au - bu, dv = av - bv; return du * du + dv * dv;
};

// Match this frame's detections to existing tracks (greedy nearest), smooth matched positions, spawn
// tracks for unmatched detections. Idempotent-ish: dedupes rapid double-calls within 8ms so multiple
// consumers ticking in the same frame don't double-integrate the motion (mirrors trackingRenderer).
export function ingest(dets: Detection[], now: number): void {
  if (now - lastIngestAt < 8) return;
  const dtSec = lastIngestAt < 0 ? 1 / 30 : Math.max(1e-3, (now - lastIngestAt) / 1000);
  lastIngestAt = now;
  const tSec = now / 1000;

  for (const t of tracks) t.matchedThisTick = false;
  const used = new Array(dets.length).fill(false);

  // Greedy: for each existing track, take its nearest unused detection within MATCH_DIST.
  for (const t of tracks) {
    let best = -1, bestD = MATCH_DIST * MATCH_DIST;
    for (let i = 0; i < dets.length; i++) {
      if (used[i]) continue;
      const d = dist2(t.u, t.v, dets[i].u, dets[i].v);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) continue;
    used[best] = true;
    t.matchedThisTick = true;
    const det = dets[best];
    const su = t.fu.filter(det.u, tSec);
    const sv = t.fv.filter(det.v, tSec);
    t.vu = (su - t.u) / dtSec; t.vv = (sv - t.v) / dtSec;
    t.u = su; t.v = sv;
    t.lastSeen = now;
    t.score = det.score;
    t.landmarks = det.landmarks;
    t.trail.push({ u: su, v: sv, t: now });
  }

  // Unmatched detections → new tracks.
  for (let i = 0; i < dets.length; i++) {
    if (used[i]) continue;
    const det = dets[i];
    const fu = new OneEuro(minCutoff, beta), fv = new OneEuro(minCutoff, beta);
    const su = fu.filter(det.u, tSec), sv = fv.filter(det.v, tSec);
    tracks.push({
      id: nextId++, fu, fv, u: su, v: sv, vu: 0, vv: 0,
      lastSeen: now, matchedThisTick: true, score: det.score,
      landmarks: det.landmarks, trail: [{ u: su, v: sv, t: now }],
    });
  }

  // Age out expired tracks + trim trails.
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    if (now - t.lastSeen > EXIT_MS) { tracks.splice(i, 1); continue; }
    while (t.trail.length && now - t.trail[0].t > TRAIL_MS) t.trail.shift();
  }
}

// The live tracks for this frame: smoothed position + a bounded constant-velocity prediction, with a
// fade alpha for tracks whose detection just dropped. Positions stay in bottom-left normalized space.
export function tick(now: number): LiveTrack[] {
  const pred = predictMs / 1000;
  const out: LiveTrack[] = [];
  for (const t of tracks) {
    const age = now - t.lastSeen;
    const alpha = Math.max(0, Math.min(1, 1 - age / EXIT_MS));
    if (alpha <= 0) continue;
    // Only extrapolate while the track is live (still matched recently); a fading track holds position.
    const k = t.matchedThisTick ? pred : 0;
    out.push({
      id: t.id, key: `p${t.id}`,
      u: t.u + t.vu * k, v: t.v + t.vv * k,
      vu: t.vu, vv: t.vv,
      alpha, score: t.score, landmarks: t.landmarks,
      trail: t.trail,
    });
  }
  return out;
}
