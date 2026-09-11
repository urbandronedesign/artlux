import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { getGridFrame, formatMetric } from './gridScale';

// THE NUMBERS ON THE FLOOR — lying ALONG the axis lines, in perspective, the way Houdini's reference
// plane does it. They are painted on a 2D canvas that sits OVER the 3D one, but they are POSITIONED
// in the scene: each one is a world point on the floor, projected through the live camera. So they
// run away toward the vanishing point with the lines they belong to, instead of standing in a ruler
// gutter at the edge of the window.
//
// (They were gutters first. Numbers pinned to the bottom and left edges read as a 2D ruler bolted onto
// a 3D view — and worse, with a grazing camera the rim crossings are not in a legible order, so the
// left edge showed -7.5 m, -3 m and -3.5 m stacked down it. Along the lines is both prettier and the
// only placement that makes each number obviously belong to a line you can see.)
//
// WHY THE TEXT IS NOT IN THE SCENE. This viewport has lost four separate features to three's WebGPU
// node renderer, each recorded in the header of the file it broke: drei's <Grid> (a raw ShaderMaterial,
// so only the bare geometry drew — a black wall at the origin, reported by an operator),
// <GizmoViewport> (`gl.capabilities.getMaxAnisotropy`, which threw INSIDE the Canvas and took the whole
// viewport black on the first frame), the projector frustum's fat LineMaterial, and the beams'
// instanceColor. Every in-scene text option is built out of exactly the things on that list — a sprite,
// a generated texture atlas, or troika's derived shader material. Projecting the points ourselves and
// drawing on a 2D canvas gets the in-scene POSITION with none of that risk, and cannot leak into the
// projector depth or bake passes either, which is what decides whether something reaches a real wall.
//
// WHY NOT drei's <Html>, which this scene does use (AnchorMarker, the tracking viz). Each <Html> is a
// portalled, absolutely-positioned DOM node whose transform is rewritten every frame. Right for one or
// two markers, wrong for forty numbers: forty style writes and a composite, per frame. One canvas is
// one clearRect and ~20 fillText calls, and touches no DOM at all.
//
// IT OWNS NO rAF. Everything runs inside useFrame, which is what makes it inherit the viewport's
// `frameloop` — 'never' while the pane is hidden or capped — and <FrameRateCap> for free.
//
// A STALE NUMBER IS WORSE THAN NO NUMBER, so every path that stops the drawing also clears: this
// unmounting, the grid publishing no frame, and the registry being handed null.

// ── The overlay registry ───────────────────────────────────────────────────────────────────────────
// Simulator3D owns the <canvas> element (it must be a SIBLING of the R3F <Canvas>, not a child); this
// module owns what gets drawn on it. Same shape as registerViewerCamera and
// frameEngine.setSurfacePreviewCanvas. A module singleton is legal here because verify-invariants
// asserts a single <Simulator3D> mount site.
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let cssW = 0, cssH = 0, dpr = 0;

function clear(): void {
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function setGridLabelCanvas(el: HTMLCanvasElement | null): void {
  if (el === canvas) return;
  clear();                       // leave the outgoing element blank, not holding the last frame
  canvas = el;
  ctx = el ? el.getContext('2d') : null;
  cssW = cssH = dpr = 0;         // force a resize on the next draw
}

// ── Style ──────────────────────────────────────────────────────────────────────────────────────────
const INK = 'rgba(208,208,208,0.85)';     // a shade under the section lines' #d8d8d8 — a caption, not a feature
const X_INK = '#ff6b7f';
const Z_INK = '#6fa8f8';
const FONT = '500 10px "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
/** Closest two numbers on one run may sit, in px. Perspective bunches the far ones; this thins them. */
const GAP = 46;
/** Numbers sit this far off their line, so they caption it rather than sit on it. */
const OFF = 7;
/** How far out to consider lines — the geometry reaches this many sections (GroundGrid.GRID_EXTENT). */
const EXT = 15;
/** Slack outside the viewport before a label is dropped. */
const SLACK = 24;

// ── Scratch, reused every frame ────────────────────────────────────────────────────────────────────
const _vp = new THREE.Matrix4();
const _p = { x: 0, y: 0, w: 0 };
interface Cand { x: number; y: number; w: number; k: number; text: string }
const cands: Cand[] = [];
const keep: Cand[] = [];
const byK = new Map<number, Cand>();
/** Strides a run may thin to, in grid cells. The 1-2-5 ladder again, for the same reason. */
const STRIDES = [1, 2, 5, 10, 20, 50, 100];

const NEAR_W = 1e-4;              // clip-space w below this is at or behind the eye

/**
 * A world point ON THE FLOOR (y = 0) → css px. False when it is at or behind the eye, where the
 * projection is meaningless and, left unguarded, flings a number to a plausible-looking but
 * completely wrong place on screen.
 */
function project(m: THREE.Matrix4, x: number, z: number, w: number, h: number): boolean {
  const e = m.elements;
  const cw = e[3] * x + e[11] * z + e[15];     // y is 0, so its column drops out of all four rows
  if (cw < NEAR_W) return false;
  _p.x = ((e[0] * x + e[8] * z + e[12]) / cw * 0.5 + 0.5) * w;
  _p.y = (-(e[1] * x + e[9] * z + e[13]) / cw * 0.5 + 0.5) * h;
  _p.w = cw;                                   // grows with distance — used to find the near end
  return true;
}

/**
 * Thin a run so the numbers never collide — ON A STRIDE LATTICE, not by raw distance.
 *
 * The distinction is what separates a ruler from scattered figures. Dropping whichever label happens
 * to be too close leaves a series like "-30, -20, -12, -6": every one of those is a real grid line,
 * and together they read as noise, because a reader cannot infer the interval. Thinning to multiples
 * of a stride gives "-30, -20, -10" and then "-6, -4, -2" — two regular series with one visible
 * change of gear, which is exactly how a map's scale bar behaves and is instantly readable.
 *
 * Perspective is why the gear has to change at all: the far end of a run crowds into the vanishing
 * point, so one stride cannot serve the whole line. We start at the end NEAREST the camera, where the
 * lines are furthest apart, and coarsen outward through the same 1-2-5 ladder the grid itself uses.
 */
function thin(): void {
  keep.length = 0;
  if (!cands.length) return;
  byK.clear();
  for (const c of cands) byK.set(c.k, c);

  // Anchor on the grid's own centre line when it is visible — it is a round coordinate, and anchoring
  // there keeps the two runs symmetric. Otherwise the candidate nearest the camera.
  let anchor = byK.get(0);
  if (!anchor) { anchor = cands[0]; for (const c of cands) if (c.w < anchor.w) anchor = c; }
  keep.push(anchor);

  for (const dir of [1, -1]) {
    let si = 0, last = anchor, k = anchor.k, guard = 0;
    while (guard++ < 500) {
      const s = STRIDES[si];
      // The next point on the stride lattice strictly beyond `k` in this direction. Snapping to the
      // lattice (rather than just adding s) is what keeps the labelled values round after a gear change.
      const nk = dir > 0 ? Math.floor(k / s) * s + s : Math.ceil(k / s) * s - s;
      if (nk > EXT || nk < -EXT) break;
      const c = byK.get(nk);
      if (!c) { k = nk; continue; }                 // that line is off screen; keep walking
      if (Math.hypot(c.x - last.x, c.y - last.y) < GAP) {
        if (si < STRIDES.length - 1) { si++; continue; }   // too tight — change gear and retry
        break;                                             // even the coarsest collides: the rest is horizon
      }
      keep.push(c); last = c; k = nk;
    }
  }
}

/**
 * One run of numbers, along the grid's own centre line for that axis.
 *
 * It is the GRID's centre line, not the world axis. The grid follows the view (GroundGrid), so its
 * centre lines pass through roughly whatever you are looking at — which is what keeps numbers on
 * screen when you pan away from the world origin, where labelling the world axes would leave the
 * floor completely unnumbered. Near the origin the two coincide, so it reads exactly like Houdini.
 */
function run(g: CanvasRenderingContext2D, axis: 'x' | 'z', origin: number, other: number,
             section: number, w: number, h: number): void {
  cands.length = 0;
  for (let k = -EXT; k <= EXT; k++) {
    const v = origin + k * section;
    if (!project(_vp, axis === 'x' ? v : other, axis === 'x' ? other : v, w, h)) continue;
    if (_p.x < -SLACK || _p.x > w + SLACK || _p.y < -SLACK || _p.y > h + SLACK) continue;
    cands.push({ x: _p.x, y: _p.y, w: _p.w, k, text: formatMetric(v) });
  }
  thin();
  if (keep.length < 2) return;   // a single number says nothing about scale — draw none

  g.fillStyle = INK;
  if (axis === 'x') { g.textAlign = 'center'; g.textBaseline = 'top'; }
  else { g.textAlign = 'left'; g.textBaseline = 'middle'; }
  for (const c of keep) {
    g.fillText(c.text, c.x + (axis === 'x' ? 0 : OFF), c.y + (axis === 'x' ? OFF : 0));
  }

  // The axis letter, on the POSITIVE end of the run, so the figures say what they measure and which
  // way the axis grows. (keep[] comes out of thin() in walk order, not in k order, so this picks.)
  let end = keep[0];
  for (const c of keep) if (c.k > end.k) end = c;
  g.fillStyle = axis === 'x' ? X_INK : Z_INK;
  g.fillText(axis === 'x' ? 'X' : 'Z', end.x + (axis === 'x' ? 0 : OFF), end.y + (axis === 'x' ? OFF + 13 : 14));
}

function draw(cam: THREE.Camera, w: number, h: number): void {
  const c = canvas, g = ctx;
  if (!c || !g || !(w > 0) || !(h > 0)) return;

  // DPR from the WINDOW, not from the Canvas's `dpr={renderScale}` prop. That prop is a per-machine
  // fill-rate budget and may be 0.5; text costs nothing per pixel, and rendering blurry numbers as a
  // side effect of a GPU-quality slider is a bug nobody would ever trace back.
  const d = window.devicePixelRatio || 1;
  if (w !== cssW || h !== cssH || d !== dpr) {
    // Assigning width/height reallocates AND clears, so only on a real change.
    c.width = Math.max(1, Math.round(w * d));
    c.height = Math.max(1, Math.round(h * d));
    cssW = w; cssH = h; dpr = d;
  }
  g.setTransform(d, 0, 0, d, 0, 0);      // draw in css px throughout
  g.clearRect(0, 0, w, h);

  const f = getGridFrame();
  if (!f) return;                        // grid drew nothing this tick — leave the overlay blank

  _vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

  g.font = FONT;
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 3;
  run(g, 'x', f.originX, f.originZ, f.section, w, h);
  run(g, 'z', f.originZ, f.originX, f.section, w, h);
  g.shadowBlur = 0;
}

/**
 * The driver. Renders nothing itself — it lives inside the Canvas only to borrow the frame loop and
 * the live camera, and writes to the sibling overlay through the registry above.
 *
 * MOUNT IT LAST, AT PRIORITY 0. Under `Scene3D.viewFrom`, ProjectorView overwrites
 * `camera.projectionMatrix` in its own useFrame; r3f runs equal-priority subscribers in subscription
 * order, so mounting after it is what makes this see the final matrix. A POSITIVE priority would be
 * actively harmful — r3f hands the whole render loop to any positive-priority subscriber, which would
 * silently stop the viewport rendering (see projectorDepth.ts's note on the same trap).
 */
export const GridLabels: React.FC = () => {
  useFrame(({ camera, size }) => draw(camera, size.width, size.height));
  useEffect(() => clear, []);
  return null;
};
