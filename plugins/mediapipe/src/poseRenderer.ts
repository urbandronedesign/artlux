// Shared, render-API-agnostic compute for the pose viz: turns the tracker's LiveTracks into GPU marker
// instances + comet trails, and builds the optional #id / skeleton overlay canvas. Used by both the
// editor stage (poseDrawable's GL canvas) and the projector (poseProjector's source FBO), so the look
// stays identical wherever it's drawn. Mirrors the LiDAR trackingRenderer; the orientation-calibration
// (rotate + flip) and heading math are the same so a MEDIAPIPE surface configures like a TRACKING one.

import type { Surface, SurfaceContent } from '@/types'; // host domain types (transitional; type-only)
import * as poseStore from './poseStore';
import * as poseTracking from './poseTracking';
import type { LiveTrack } from './poseTracking';
import type { PoseInst } from './posePass';

const BASE_W = 1920;                 // source width; height is a fixed 16:9 (camera frames are landscape)
const SOURCE_H = 1080;

let lastTickAt = -1;
let liveCache: LiveTrack[] = [];

export function configure(smoothing: number, predictMs: number): void {
  poseTracking.configure({ smoothing, predictMs });
}

// Ingest the store's latest detections + advance the tracker once per animation frame, regardless of
// how many MEDIAPIPE surfaces draw. In the main window the store is fed by poseEngine; in a projector
// window it's fed by the projector-channel snapshot bridge — either way this consumes getDetections().
function tickOnce(now: number): void {
  if (now - lastTickAt < 8) return;
  lastTickAt = now;
  poseTracking.ingest(poseStore.getDetections(), now);
  liveCache = poseTracking.tick(now);
}

// Orientation calibration (rotate, then optional H/V mirror) in tracking space (bottom-left origin).
function transformUV(u: number, v: number, c: SurfaceContent): [number, number] {
  let a = u, b = v;
  switch (c.rotate) {
    case 90: { const na = b, nb = 1 - a; a = na; b = nb; break; }
    case 180: { a = 1 - a; b = 1 - b; break; }
    case 270: { const na = 1 - b, nb = a; a = na; b = nb; break; }
    default: break;
  }
  if (c.flipH) a = 1 - a;
  if (c.flipV) b = 1 - b;
  return [a, b];
}

export function sourceSize(): { w: number; h: number } {
  return { w: BASE_W, h: SOURCE_H };
}

// hsl→rgb (0..1). Distinct hue per person id (same palette as the LiDAR blobs for a consistent look).
function colorFor(id: number): [number, number, number] {
  const h = ((id * 47) % 360) / 360, s = 0.95, l = 0.58;
  const k = (n: number) => (n + h * 12) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

const SPEED_REF = 0.3; // normalized units/sec at which the direction triangle is fully shown
const VEL_EPS = 0.05;  // seconds — probe distance for the transformed heading

// Smoothed + predicted people as GPU marker instances (x,y top-left normalized; r = fraction of
// height; heading in screen space; dir = strength). Drives the tracker once/frame.
export function instances(surface: Surface, now: number): PoseInst[] {
  tickOnce(now);
  const c = surface.content;
  const r = c.blobSize ?? 0.05;
  const out: PoseInst[] = [];
  for (const t of liveCache) {
    const [a, b] = transformUV(t.u, t.v, c);
    const [a2, b2] = transformUV(t.u + VEL_EPS * t.vu, t.v + VEL_EPS * t.vv, c);
    const heading = Math.atan2((1 - b2) - (1 - b), a2 - a); // screen space (x right, y down)
    const dir = Math.min(1, Math.hypot(t.vu, t.vv) / SPEED_REF);
    out.push({ x: a, y: 1 - b, r, rgb: colorFor(t.id), a: t.alpha, heading, dir });
  }
  return out;
}

// Comet-trail ribbons for the surface as premultiplied solid triangles ([x,y,r,g,b,a] per vertex).
export function trails(surface: Surface, now: number, trailSeconds: number): Float32Array {
  tickOnce(now);
  const c = surface.content;
  const { w: W, h: H } = sourceSize();
  const headHalf = (c.blobSize ?? 0.05) * H * 0.6;
  const winMs = Math.max(50, trailSeconds * 1000);
  const verts: number[] = [];
  for (const t of liveCache) {
    const pts = t.trail;
    if (pts.length < 2) continue;
    const [rr, gg, bb] = colorFor(t.id);
    const n = pts.length;
    const sx: number[] = [], sy: number[] = [], age: number[] = [];
    for (let i = 0; i < n; i++) {
      const [pa, pb] = transformUV(pts[i].u, pts[i].v, c);
      sx.push(pa * W); sy.push((1 - pb) * H);
      age.push(Math.max(0, 1 - (now - pts[i].t) / winMs));
    }
    for (let i = 0; i < n - 1; i++) {
      const f0 = i / (n - 1), f1 = (i + 1) / (n - 1);
      const w0 = headHalf * f0, w1 = headHalf * f1;
      const a0 = age[i] * f0 * t.alpha, a1 = age[i + 1] * f1 * t.alpha;
      let dx = sx[i + 1] - sx[i], dy = sy[i + 1] - sy[i];
      const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      const nx = -dy, ny = dx;
      const push = (px: number, py: number, al: number) => verts.push(px / W, py / H, rr * al, gg * al, bb * al, al);
      const x0l = sx[i] + nx * w0, y0l = sy[i] + ny * w0, x0r = sx[i] - nx * w0, y0r = sy[i] - ny * w0;
      const x1l = sx[i + 1] + nx * w1, y1l = sy[i + 1] + ny * w1, x1r = sx[i + 1] - nx * w1, y1r = sy[i + 1] - ny * w1;
      push(x0l, y0l, a0); push(x0r, y0r, a0); push(x1r, y1r, a1);
      push(x0l, y0l, a0); push(x1r, y1r, a1); push(x1l, y1l, a1);
    }
  }
  return new Float32Array(verts);
}

// BlazePose 33-landmark skeleton connections (index pairs). The standard MediaPipe POSE_CONNECTIONS.
const POSE_CONNECTIONS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],           // shoulders + arms
  [11, 23], [12, 24], [23, 24],                               // torso
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],           // left leg
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],           // right leg
  [15, 17], [15, 19], [15, 21], [17, 19],                     // left hand
  [16, 18], [16, 20], [16, 22], [18, 20],                     // right hand
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10], // face
];

// Optional 2D overlay: #id labels and/or the BlazePose skeleton, drawn on top of the GPU markers.
// Returns null when neither is enabled (the common case → pure GPU markers).
let overlayCv: { el: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
export function overlayCanvas(surface: Surface, W: number, H: number): HTMLCanvasElement | null {
  const c = surface.content;
  if (!c.showIds && !c.poseSkeleton) return null;
  if (!overlayCv) { const el = document.createElement('canvas'); overlayCv = { el, ctx: el.getContext('2d')! }; }
  const { el, ctx } = overlayCv;
  if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
  ctx.clearRect(0, 0, W, H);

  if (c.poseSkeleton) {
    ctx.lineWidth = Math.max(1.5, H * 0.004);
    ctx.lineCap = 'round';
    for (const t of liveCache) {
      const lm = t.landmarks;
      if (!lm) continue;
      const [rr, gg, bb] = colorFor(t.id);
      ctx.globalAlpha = t.alpha;
      ctx.strokeStyle = `rgb(${Math.round(rr * 255)},${Math.round(gg * 255)},${Math.round(bb * 255)})`;
      const pt = (i: number): [number, number] => { const [a, b] = transformUV(lm[i].x, lm[i].y, c); return [a * W, (1 - b) * H]; };
      ctx.beginPath();
      for (const [i, j] of POSE_CONNECTIONS) {
        if (!lm[i] || !lm[j]) continue;
        if (lm[i].visibility < 0.3 || lm[j].visibility < 0.3) continue;
        const [x0, y0] = pt(i), [x1, y1] = pt(j);
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  if (c.showIds) {
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `${Math.round(H * 0.045)}px system-ui`;
    const rPx = (c.blobSize ?? 0.05) * H;
    for (const t of liveCache) {
      const [a, bb] = transformUV(t.u, t.v, c);
      ctx.globalAlpha = t.alpha;
      ctx.fillText(`#${t.id}`, a * W, (1 - bb) * H - rPx - 6);
      ctx.globalAlpha = 1;
    }
  }
  return el;
}
