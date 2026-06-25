// Shared, render-API-agnostic compute for the blob viz: turns smoothed tracks into GPU blob
// instances, and builds the optional calibration/label overlay canvas. Used by both the editor
// stage (trackingDrawable's GL canvas) and the projector (ProjectorGL's source FBO), so the look
// and the calibration math stay identical regardless of where it's drawn.

import type { Surface, SurfaceContent } from '../types';
import * as tracking from './trackingStore';
import * as blobMotion from './blobMotion';
import type { BlobInst } from '../gpu/blobPass';

const BASE_W = 1920;                 // source width; height derives from the zone aspect
const DEFAULT_ASPECT = 1024 / 1920;  // venue content-map aspect until specs arrive

let lastTickAt = -1;
let liveCache: blobMotion.LiveTrack[] = [];

export function configure(smoothing: number, predictMs: number): void {
  blobMotion.configure({ smoothing, predictMs });
}

// Ingest + tick once per animation frame, regardless of how many tracking surfaces draw.
function tickOnce(now: number): void {
  if (now - lastTickAt < 8) return;
  lastTickAt = now;
  blobMotion.ingest(tracking.getActiveEntries(), now);
  liveCache = blobMotion.tick(now);
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

function aspectFor(source: string): number {
  const t = tracking.getSurfaceTrack(source);
  return t && t.scaleX > 0 && t.scaleY > 0 ? t.scaleY / t.scaleX : DEFAULT_ASPECT;
}

export function sourceSize(source: string): { w: number; h: number } {
  // Clamp the aspect so a bad specs value (scaleX≈0) can't request a giant texture / crash the GPU.
  const aspect = Math.min(4, Math.max(0.1, aspectFor(source)));
  return { w: BASE_W, h: Math.max(2, Math.min(4096, Math.round(BASE_W * aspect))) };
}

// hsl→rgb (0..1). Distinct hue per person, matching the 2D path's `hsl((id*47)%360, 95%, 58%)`.
function colorFor(id: number): [number, number, number] {
  const h = ((id * 47) % 360) / 360, s = 0.95, l = 0.58;
  const k = (n: number) => (n + h * 12) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

const SPEED_REF = 0.3; // normalized units/sec at which the direction triangle is fully shown
const VEL_EPS = 0.05;  // seconds — probe distance for the transformed heading

// Smoothed + predicted blobs for a surface as GPU instances (x,y top-left normalized; r = fraction
// of height; heading in screen space; dir = direction strength). Drives the motion filter once/frame.
export function instances(surface: Surface, now: number): BlobInst[] {
  const source = surface.content.trackingSource;
  if (!source) return [];
  tickOnce(now);
  const c = surface.content;
  const r = c.blobSize ?? 0.04;
  const out: BlobInst[] = [];
  for (const t of liveCache) {
    if (t.surface !== source) continue;
    const [a, b] = transformUV(t.u, t.v, c);
    const [a2, b2] = transformUV(t.u + VEL_EPS * t.vu, t.v + VEL_EPS * t.vv, c); // velocity, transformed
    const heading = Math.atan2((1 - b2) - (1 - b), a2 - a); // screen space (x right, y down)
    const dir = Math.min(1, Math.hypot(t.vu, t.vv) / SPEED_REF);
    out.push({ x: a, y: 1 - b, r, rgb: colorFor(t.id), a: t.alpha, heading, dir });
  }
  return out;
}

// Comet-trail ribbons for a surface as premultiplied solid triangles ([x,y,r,g,b,a] per vertex,
// x/y normalized). Width tapers full→0 and alpha fades head→tail (bounded by trailSeconds).
export function trails(surface: Surface, now: number, trailSeconds: number): Float32Array {
  const source = surface.content.trackingSource;
  if (!source) return new Float32Array(0);
  tickOnce(now);
  const c = surface.content;
  const { w: W, h: H } = sourceSize(source);
  const headHalf = (c.blobSize ?? 0.04) * H * 0.6; // head half-width (px), a bit under the circle
  const winMs = Math.max(50, trailSeconds * 1000);
  const verts: number[] = [];
  for (const t of liveCache) {
    if (t.surface !== source) continue;
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
      const f0 = i / (n - 1), f1 = (i + 1) / (n - 1);     // 0 tail → 1 head
      const w0 = headHalf * f0, w1 = headHalf * f1;
      const a0 = age[i] * f0 * t.alpha, a1 = age[i + 1] * f1 * t.alpha;
      let dx = sx[i + 1] - sx[i], dy = sy[i + 1] - sy[i];
      const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      const nx = -dy, ny = dx; // perpendicular
      const push = (px: number, py: number, al: number) => verts.push(px / W, py / H, rr * al, gg * al, bb * al, al);
      const x0l = sx[i] + nx * w0, y0l = sy[i] + ny * w0, x0r = sx[i] - nx * w0, y0r = sy[i] - ny * w0;
      const x1l = sx[i + 1] + nx * w1, y1l = sy[i + 1] + ny * w1, x1r = sx[i + 1] - nx * w1, y1r = sy[i + 1] - ny * w1;
      push(x0l, y0l, a0); push(x0r, y0r, a0); push(x1r, y1r, a1);
      push(x0l, y0l, a0); push(x1r, y1r, a1); push(x1l, y1l, a1);
    }
  }
  return new Float32Array(verts);
}

// Optional 2D overlay (calibration grid/labels/axes + #id labels) drawn on top of the GPU blobs.
// Returns null when neither calibration nor showIds is on (the common show case → pure GPU). #id
// labels are read from the live tracks (which carry the id), positioned to match the GPU blobs.
let overlayCv: { el: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
export function overlayCanvas(surface: Surface, W: number, H: number): HTMLCanvasElement | null {
  const c = surface.content;
  const source = c.trackingSource ?? '';
  if (!c.calibration && !c.showIds) return null;
  if (!overlayCv) { const el = document.createElement('canvas'); overlayCv = { el, ctx: el.getContext('2d')! }; }
  const { el, ctx } = overlayCv;
  if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
  ctx.clearRect(0, 0, W, H);

  if (c.calibration) drawCalibration(ctx, W, H, c, source);

  if (c.showIds) {
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `${Math.round(H * 0.04)}px system-ui`;
    const rPx = (c.blobSize ?? 0.04) * H;
    for (const t of liveCache) {
      if (t.surface !== source) continue;
      const [a, bb] = transformUV(t.u, t.v, c);
      ctx.globalAlpha = t.alpha;
      ctx.fillText(`#${t.id}`, a * W, (1 - bb) * H - rPx - 6);
      ctx.globalAlpha = 1;
    }
  }
  return el;
}

function drawCalibration(ctx: CanvasRenderingContext2D, W: number, H: number, c: SurfaceContent, source: string): void {
  const toPx = (a: number, b: number): [number, number] => [a * W, (1 - b) * H];
  ctx.save();
  ctx.lineWidth = Math.max(1, H * 0.003);
  ctx.strokeStyle = 'rgba(52,211,153,0.7)';
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, W - ctx.lineWidth * 2, H - ctx.lineWidth * 2);
  ctx.strokeStyle = 'rgba(52,211,153,0.22)';
  ctx.lineWidth = Math.max(1, H * 0.0015);
  for (let i = 1; i < 8; i++) { const x = (i / 8) * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let j = 1; j < 4; j++) { const y = (j / 4) * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(52,211,153,0.5)';
  const cx = W / 2, cy = H / 2, cs = H * 0.04;
  ctx.beginPath(); ctx.moveTo(cx - cs, cy); ctx.lineTo(cx + cs, cy); ctx.moveTo(cx, cy - cs); ctx.lineTo(cx, cy + cs); ctx.stroke();
  ctx.fillStyle = 'rgba(52,211,153,0.9)';
  ctx.font = `${Math.round(H * 0.05)}px system-ui`;
  const pad = H * 0.02;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('TL', pad, pad);
  ctx.textAlign = 'right'; ctx.fillText('TR', W - pad, pad);
  ctx.textBaseline = 'bottom'; ctx.fillText('BR', W - pad, H - pad);
  ctx.textAlign = 'left'; ctx.fillText('BL', pad, H - pad);
  const [ox, oy] = toPx(...transformUV(0, 0, c));
  const [ux, uy] = toPx(...transformUV(0.18, 0, c));
  const [vx, vy] = toPx(...transformUV(0, 0.18, c));
  ctx.strokeStyle = '#f59e0b'; ctx.fillStyle = '#f59e0b'; ctx.lineWidth = Math.max(2, H * 0.004);
  ctx.beginPath(); ctx.arc(ox, oy, H * 0.012, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ux, uy); ctx.moveTo(ox, oy); ctx.lineTo(vx, vy); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('U', ux, uy); ctx.fillText('V', vx, vy);
  ctx.fillText(source, cx, cy - H * 0.08);
  ctx.restore();
}
