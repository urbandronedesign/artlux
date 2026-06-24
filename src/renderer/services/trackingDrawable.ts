// Renders LiDAR blobs (smoothed) into a canvas that a Surface can use as its content — so the
// blobs flow through the normal stage + projector-output pipeline and can be projection-mapped onto
// the real floor/wall. Context-agnostic: runs wherever `trackingStore` has data (main window from
// OSC; projector window from the bridged snapshot). Drives the shared `blobMotion` filter once per
// frame and caches one canvas per surface.
//
// The canvas aspect matches the zone's physical aspect (scaleY/scaleX from specs), so once the
// projector quad is corner-pinned to the physical surface a blob circle stays round on the wall/floor.

import type { Surface, SurfaceContent } from '../types';
import * as tracking from './trackingStore';
import * as blobMotion from './blobMotion';
import { timeline } from './timeline';

const BASE_W = 1920;             // canvas width; height derived from the zone aspect
const DEFAULT_ASPECT = 1024 / 1920; // venue content-map aspect until specs arrive

let lastTickAt = -1;
let liveCache: blobMotion.LiveTrack[] = [];
const canvases = new Map<string, { el: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number }>();

export function configure(smoothing: number, predictMs: number): void {
  blobMotion.configure({ smoothing, predictMs });
}

// Ingest + tick once per animation frame, regardless of how many tracking surfaces ask to draw.
function tickOnce(now: number): void {
  if (now - lastTickAt < 8) return;
  lastTickAt = now;
  blobMotion.ingest(tracking.getActiveEntries(), now);
  liveCache = blobMotion.tick(now);
}

// Apply the user's orientation calibration (rotate, then optional H/V mirror) in tracking space
// (normalized, bottom-left origin). Returns transformed (u,v).
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

function colorFor(id: number): string {
  return `hsl(${(id * 47) % 360}, 95%, 58%)`; // distinct hue per person
}

function aspectFor(source: string): number {
  const t = tracking.getSurfaceTrack(source);
  return t && t.scaleX > 0 && t.scaleY > 0 ? t.scaleY / t.scaleX : DEFAULT_ASPECT;
}

// Return the surface's tracking canvas for this frame (black + smoothed blobs + optional overlay),
// or null when no tracking source is selected.
export function get(surface: Surface): HTMLCanvasElement | null {
  const c = surface.content;
  const source = c.trackingSource;
  if (!source) return null;

  const now = performance.now();
  tickOnce(now);

  const W = BASE_W, H = Math.max(2, Math.round(BASE_W * aspectFor(source)));
  let cv = canvases.get(surface.id);
  if (!cv) { const el = document.createElement('canvas'); cv = { el, ctx: el.getContext('2d')!, w: 0, h: 0 }; canvases.set(surface.id, cv); }
  if (cv.w !== W || cv.h !== H) { cv.el.width = W; cv.el.height = H; cv.w = W; cv.h = H; }
  const ctx = cv.ctx;

  // Transparent background so lower-z surfaces (e.g. a video) show through under the blobs on the
  // stage; on a projector the empty areas resolve to black (= no light) anyway.
  ctx.clearRect(0, 0, W, H);

  // Optional background: a timeline video layer drawn UNDER the blobs, so one surface carries
  // video + blobs (and projects as one). In the projector window this is the streamed bitmap.
  if (c.bgLayerId) {
    const bg = timeline.getLayerDrawable(c.bgLayerId);
    if (bg) { try { ctx.drawImage(bg as CanvasImageSource, 0, 0, W, H); } catch { /* not ready */ } }
  }

  const toPx = (a: number, b: number): [number, number] => [a * W, (1 - b) * H]; // bottom-left → top-left

  if (c.calibration) drawCalibration(ctx, W, H, c, source);

  const r = Math.max(2, (c.blobSize ?? 0.04) * H);
  ctx.textAlign = 'center';
  ctx.font = `${Math.round(H * 0.04)}px system-ui`;
  for (const t of liveCache) {
    if (t.surface !== source) continue;
    const [a, b] = transformUV(t.u, t.v, c);
    const [x, y] = toPx(a, b);
    const col = colorFor(t.id);
    ctx.globalAlpha = t.alpha;
    // soft halo + solid core
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
    g.addColorStop(0, col); g.addColorStop(0.5, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fill();
    if (c.showIds) { ctx.fillStyle = '#fff'; ctx.fillText(`#${t.id}`, x, y - r - 6); }
    ctx.globalAlpha = 1;
  }
  return cv.el;
}

// Calibration overlay: zone border + grid + center cross + a labelled origin marker with U/V axis
// arrows (transformed), so the operator can corner-pin the projector and verify blob orientation.
function drawCalibration(ctx: CanvasRenderingContext2D, W: number, H: number, c: SurfaceContent, source: string): void {
  const toPx = (a: number, b: number): [number, number] => [a * W, (1 - b) * H];
  ctx.save();
  ctx.lineWidth = Math.max(1, H * 0.003);
  ctx.strokeStyle = 'rgba(52,211,153,0.7)';
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, W - ctx.lineWidth * 2, H - ctx.lineWidth * 2);
  // grid
  ctx.strokeStyle = 'rgba(52,211,153,0.22)';
  ctx.lineWidth = Math.max(1, H * 0.0015);
  for (let i = 1; i < 8; i++) { const x = (i / 8) * W; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let j = 1; j < 4; j++) { const y = (j / 4) * H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  // center cross
  ctx.strokeStyle = 'rgba(52,211,153,0.5)';
  const cx = W / 2, cy = H / 2, cs = H * 0.04;
  ctx.beginPath(); ctx.moveTo(cx - cs, cy); ctx.lineTo(cx + cs, cy); ctx.moveTo(cx, cy - cs); ctx.lineTo(cx, cy + cs); ctx.stroke();
  // corner labels (surface corners as the projector shows them)
  ctx.fillStyle = 'rgba(52,211,153,0.9)';
  ctx.font = `${Math.round(H * 0.05)}px system-ui`;
  const pad = H * 0.02;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('TL', pad, pad);
  ctx.textAlign = 'right'; ctx.fillText('TR', W - pad, pad);
  ctx.textBaseline = 'bottom'; ctx.fillText('BR', W - pad, H - pad);
  ctx.textAlign = 'left'; ctx.fillText('BL', pad, H - pad);
  // transformed origin + U/V axis arrows — shows where tracking (0,0) and +u/+v project
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
