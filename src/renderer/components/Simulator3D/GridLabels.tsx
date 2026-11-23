import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { getGridFrame, labelFamilies, LABEL_PX } from './gridScale';
import { gridCamera, gridLabelSigns } from './gridSpace';

// THE NUMBERS ON THE FLOOR — painted ON the floor, along the axis lines they measure, the way Houdini's
// reference plane does it. Each number is a row of flat glyph quads lying at y = 2 mm, running in the
// direction of its axis, so it sits in the floor's own perspective and the depth buffer hides it behind
// a screen exactly as it hides the grid lines.
//
// ── WHY IT IS IN THE SCENE NOW (it was a 2D overlay until 2026-10-22) ───────────────────────────────
// The overlay projected each floor point and drew HORIZONTAL screen text there. Two things followed that
// no overlay can fix: a number could not run along its line (it stood across a receding axis), and it
// knew nothing about depth, so the figures showed THROUGH every screen and model standing on the floor.
// Reading the depth buffer back to occlude them costs an extra pass and an async readback that lags; a
// CPU occlusion test is only exact for flat screens. Geometry in the scene gets both for free.
//
// ── WHY IT IS SAFE ON THE WEBGPU RENDERER ──────────────────────────────────────────────────────────
// The overlay existed because in-scene text kept vanishing on three's node renderer: troika (drei
// <Text>) and sprites are built out of a raw ShaderMaterial / WebGL-only paths (verify-invariants
// forbids them). This uses NONE of that — a plain BufferGeometry and a MeshBasicMaterial with a
// CanvasTexture map and vertex colours, which is the same material the projection screens draw with and
// the same vertex-colour path the grid lines draw with, on both backends. Two rules from this folder:
//   - The material is BORN WITH ITS MAP (blankMap.ts: a property null when the node renderer first
//     snapshots the material is never watched again). The atlas exists before the material does.
//   - It is NEVER PICKED (`raycast` stubbed): a floor-sized decal would otherwise sit in every
//     intersection list and steal clicks meant for fixtures (pickPriority.ts).
// It stays on layer 0, so the projector depth and bake passes — which render ONLY their own layers
// (projectorDepth.ts, projectorBake.ts) — never see it. The look-through-a-projector view shows it,
// exactly as it shows the grid.
//
// ── WHY THERE IS NO COLLISION THINNING ─────────────────────────────────────────────────────────────
// The text height is fixed in pixels at the reference point, and a family only shows once its spacing
// is ≥ LABEL_GONE_PX there (gridScale.labelFamilies). Text and spacing then shrink together with
// perspective along the run, so two numbers never overlap on screen.
//
// ── COST ───────────────────────────────────────────────────────────────────────────────────────────
// One draw call. The atlas is drawn and uploaded ONCE per session. The geometry (a few hundred quads)
// is rewritten only when its quantised key changes (zoom, pan, an axis crossed — see the useFrame).
// A still camera costs one string comparison per frame.

// ── Style ──────────────────────────────────────────────────────────────────────────────────────────
const INK = new THREE.Color('#b4b4b4');    // light grey, a shade over the lines' #a4a4a4 — a caption, not a feature
const X_INK = new THREE.Color('#ff6b7f');
const Z_INK = new THREE.Color('#6fa8f8');
/** 2 mm up: above the grid lines' 1 mm lift, so the two never z-fight. */
const Y = 0.002;

// ── The glyph atlas — every character the ruler can print, drawn once ──────────────────────────────
const CHARS = '0123456789-XZ';   // whole metres only — no '.', no unit
const CELL_H = 64;            // px per glyph cell, tall
const PAD_X = 3;              // px either side of a glyph, so mip levels do not bleed neighbours together
let atlas: THREE.CanvasTexture | null = null;
let cellAspect = 0.6;         // cell width / height — the world width of one character is H × this

function getAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const probe = document.createElement('canvas').getContext('2d')!;
  // System monospace faces only: the atlas is drawn once, and a webfont that has not finished loading
  // by then would bake the fallback in for the whole session.
  const font = `600 ${Math.round(CELL_H * 0.78)}px Consolas, "Cascadia Mono", ui-monospace, Menlo, monospace`;
  probe.font = font;
  const advance = Math.ceil(probe.measureText('0').width);
  const cellW = advance + PAD_X * 2;
  cellAspect = cellW / CELL_H;
  const c = document.createElement('canvas');
  c.width = cellW * CHARS.length;
  c.height = CELL_H;
  const g = c.getContext('2d')!;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';       // WHITE — the colour comes from vertex colours, so one atlas serves every ink
  for (let i = 0; i < CHARS.length; i++) g.fillText(CHARS[i], cellW * i + cellW / 2, CELL_H / 2 + 1);
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 8;       // a floor seen at a grazing angle is exactly what anisotropic filtering is for
  return atlas;
}

// ── Geometry buffers, fixed capacity, rewritten in place ───────────────────────────────────────────
const MAX_QUADS = 512;        // 2 runs × 23 labels × ≤ 9 glyphs, plus the two axis letters, with room
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _ink = new THREE.Color();
const _at = new THREE.Vector3();

function makeGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 12), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 8), 2).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_QUADS * 12), 3).setUsage(THREE.DynamicDrawUsage));
  const idx = new Uint16Array(MAX_QUADS * 6);
  for (let q = 0; q < MAX_QUADS; q++) {
    const a = q * 4;
    idx.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], q * 6);
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setDrawRange(0, 0);
  return geo;
}

/**
 * Lay the string `text` flat on the floor: its baseline runs along `u`, its "up" is `v` (pointing AWAY
 * from the viewer, so it reads the right way round), centred on `at`, hanging `gap` below the line on
 * the viewer's side. Returns the next free quad.
 */
function layString(geo: THREE.BufferGeometry, q: number, text: string, at: THREE.Vector3,
                   u: THREE.Vector3, v: THREE.Vector3, h: number, gap: number, ink: THREE.Color): number {
  const pos = geo.attributes.position.array as Float32Array;
  const uv = geo.attributes.uv.array as Float32Array;
  const col = geo.attributes.color.array as Float32Array;
  const w = h * cellAspect;
  // Bottom-left of the first glyph: centred along u, and from `gap` to `gap + h` toward the viewer.
  _o.copy(at).addScaledVector(u, -(w * text.length) / 2).addScaledVector(v, -(gap + h));
  for (let i = 0; i < text.length && q < MAX_QUADS; i++) {
    const ci = CHARS.indexOf(text[i]);
    if (ci < 0) continue;     // a space: advance, draw nothing
    const u0 = ci / CHARS.length, u1 = (ci + 1) / CHARS.length;
    const bx = _o.x + u.x * w * i, bz = _o.z + u.z * w * i;
    const p = q * 12;
    // bottom-left, bottom-right, top-left, top-right
    pos[p] = bx;                      pos[p + 1] = Y; pos[p + 2] = bz;
    pos[p + 3] = bx + u.x * w;        pos[p + 4] = Y; pos[p + 5] = bz + u.z * w;
    pos[p + 6] = bx + v.x * h;        pos[p + 7] = Y; pos[p + 8] = bz + v.z * h;
    pos[p + 9] = bx + u.x * w + v.x * h; pos[p + 10] = Y; pos[p + 11] = bz + u.z * w + v.z * h;
    const t = q * 8;
    uv[t] = u0; uv[t + 1] = 0; uv[t + 2] = u1; uv[t + 3] = 0; uv[t + 4] = u0; uv[t + 5] = 1; uv[t + 6] = u1; uv[t + 7] = 1;
    for (let k = 0; k < 4; k++) { col[p + k * 3] = ink.r; col[p + k * 3 + 1] = ink.g; col[p + k * 3 + 2] = ink.b; }
    q++;
  }
  return q;
}

// ── 2026-11-23: NO POP, NO BLINK (owner) ─────────────────────────────────────────────────────────
// The numbers used to be laid out per SECTION: their size, spacing and run line all stepped with the
// grid's rung (a pop), and the run line re-snapped as orbiting nudged the reference point (a blink).
// Now (gridScale.labelFamilies): a CONSTANT on-screen size; whole metres in DECADE families (1, 10,
// 100 m …), each number drawn by the coarsest family it belongs to and faded by THAT family's on-screen
// spacing, so zooming out dims the 1 m numbers while the 10 m ones stay; a fade by distance from the
// UNSNAPPED reference point; and a run line that only moves once the view is well past it.
const L_EXT = 9;          // numbers each way per family, in that family's spacings
const L_FADE = 10;        // distance (in the family's spacings) at which a number has faded out
const RUN_STICK = 1.25;   // the run line moves only once the reference is this many spacings from it

interface Layout { px: number; refX: number; refZ: number; runX: number; runZ: number; tilt: number }
/** The widest a number may be, as a fraction of its family's spacing, so it never reaches its neighbour. */
const MAX_W = 0.8;

/**
 * Rebuild both runs. `sideX`/`sideZ` say which side of each axis line the camera is on (+1 / -1), which
 * decides which way the text faces so it is never read mirrored or upside down.
 */
function rebuild(geo: THREE.BufferGeometry, L: Layout, sideX: number, sideZ: number, signX = 1, signZ = 1): void {
  let q = 0;
  const fams = labelFamilies(L.px);
  // LABEL_PX on screen at the reference point — divided by the tilt, because text lying FLAT on a floor
  // seen at a low angle is squashed in depth by about the sine of that angle (measured: 12 px came out
  // as 3 px at a working angle). The reading direction is not squashed, so MAX_W still caps the width.
  const h0 = LABEL_PX / L.px / L.tilt;
  for (const axis of ['x', 'z'] as const) {
    // v = the text's "up", pointing AWAY from the viewer; u = v × Y, the reading direction.
    if (axis === 'x') _v.set(0, 0, -sideX); else _v.set(-sideZ, 0, 0);
    _u.set(-_v.z, 0, _v.x);
    const ref = axis === 'x' ? L.refX : L.refZ;          // where we are along the run
    const across = axis === 'x' ? L.runZ : L.runX;       // the line the run sits on
    const done = new Set<number>();
    // Coarse to fine: a number belongs to the coarsest family it is a multiple of.
    for (let i = fams.length - 1; i >= 0; i--) {
      const { spacing: S, alpha } = fams[i];
      if (alpha < 0.02) continue;
      const c = Math.round(ref / S);
      for (let k = c - L_EXT; k <= c + L_EXT; k++) {
        const metres = Math.round(k * S);   // S is a whole number of metres (labelFamilies), so exact
        if (done.has(metres)) continue;
        done.add(metres);
        if (axis === 'z' && metres === 0 && Math.abs(across) < 1e-6) continue;  // the X run prints the shared "0"
        const d = Math.abs(metres - ref) / (S * L_FADE);
        const f = alpha * (d >= 1 ? 0 : 1 - d);
        if (f < 0.02) continue;
        if (axis === 'x') _at.set(metres, Y, across); else _at.set(across, Y, metres);
        // The WORLD coordinate: on a side view's grid a local axis can run along a world axis reversed
        // (gridSpace.ts) — the Front view's vertical run is height, not minus local z.
        const shown = metres * (axis === 'x' ? signX : signZ);
        const text = String(shown === 0 ? 0 : shown);   // never "-0"
        const h = Math.min(h0, (MAX_W * S) / (text.length * cellAspect));
        q = layString(geo, q, text, _at, _u, _v, h, 0.45 * h, _ink.copy(INK).multiplyScalar(f));
      }
    }
    // The axis letter a few full-strength spacings out on the positive side, so the figures say what
    // they measure and which way the axis grows. Between two numbers, so it never sits on one.
    const full = fams.find((x) => x.alpha > 0.98) ?? fams[fams.length - 1];
    if (full) {
      const value = (Math.round(ref / full.spacing) + 2.5) * full.spacing;
      const d = Math.abs(value - ref) / (full.spacing * L_FADE);
      if (axis === 'x') _at.set(value, Y, across); else _at.set(across, Y, value);
      const h = Math.min(h0, (MAX_W * full.spacing) / cellAspect);
      q = layString(geo, q, axis === 'x' ? 'X' : 'Z', _at, _u, _v, h, 0.45 * h,
        _ink.copy(axis === 'x' ? X_INK : Z_INK).multiplyScalar(d >= 1 ? 0 : 1 - d));
    }
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.uv.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
  geo.setDrawRange(0, q * 6);
}

/** The run line: stays put until the reference is RUN_STICK spacings away, then moves to the nearest
 *  multiple — so orbiting, which nudges the reference, never makes the numbers jump a row. */
function stickRun(prev: number | null, ref: number, S: number): number {
  const onLattice = prev !== null && Math.abs(Math.round(prev / S) * S - prev) < 1e-6;
  if (onLattice && Math.abs(ref - prev!) < RUN_STICK * S) return prev!;
  return Math.round(ref / S) * S;
}

/**
 * Mounted inside the Canvas, after GroundGrid (the single writer of the grid frame) and after
 * ProjectorView — equal-priority useFrame subscribers run in mount order, so this reads this frame's
 * section, never last frame's. Priority stays 0: a positive priority hands r3f's whole render loop to
 * this subscriber and the viewport stops drawing (projectorDepth.ts records the same trap).
 */
// The label mesh, so the four-view renderer can show the numbers in the Perspective pane only: their
// geometry is laid out for ONE camera (reading side, decimation), and rebuilding it per pane per frame
// would cost far more than the flat panes need from a ruler. One <GridLabels> (one Simulator3D, guarded).
let liveLabels: THREE.Object3D | null = null;
export function setGridLabelsVisible(v: boolean): void { if (liveLabels) liveLabels.visible = v; }

const _away = new THREE.Vector3();

export const GridLabels: React.FC = () => {
  const geometry = useMemo(makeGeometry, []);
  // Born with its map — see the header.
  const material = useMemo(() => new THREE.MeshBasicMaterial({
    map: getAtlas(), vertexColors: true, transparent: true, depthWrite: false,
    toneMapped: false, side: THREE.DoubleSide,
  }), []);
  const meshRef = useRef<THREE.Mesh>(null);
  const keyRef = useRef('');
  const sideRef = useRef({ x: 0, z: 0 });
  const runRef = useRef<{ x: number | null; z: number | null }>({ x: null, z: null });

  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);

  useFrame(({ camera: viewCam }) => {
    // In GRID space — see gridSpace.ts (a flat side view puts the grid on its own plane).
    const camera = gridCamera(viewCam);
    const mesh = meshRef.current;
    if (!mesh) return;
    const f = getGridFrame();
    if (!f) { mesh.visible = false; keyRef.current = ''; return; }   // grid drew nothing this tick
    mesh.visible = true;
    // WHICH WAY IS "AWAY" FROM THE VIEWER, on the floor. From the direction the camera LOOKS, not from
    // where it stands relative to the grid origin: the two agree for any view across the floor, but a
    // Top view (3d-workbench Phase 1) stands exactly above its target, where "which side of the origin"
    // is a coin toss — measured: the numbers came out upside down. Looking straight down there is no
    // floor direction to look along, so the screen's up (the camera's Y column) says which way is away.
    _away.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const tilt = Math.min(1, Math.max(0.3, Math.abs(_away.y)));   // how steeply we look down at the floor
    _away.y = 0;
    if (_away.lengthSq() < 0.0025) { _away.setFromMatrixColumn(camera.matrixWorld, 1); _away.y = 0; }
    // SIDE WITH A DEAD BAND: looking along an axis, the look direction wobbles across it while orbiting
    // and the text flipped back and forth (a blink). It now flips only once the view is clearly over.
    const len = Math.hypot(_away.x, _away.z) || 1;
    const az = _away.z / len, ax = _away.x / len;
    const side = sideRef.current;
    if (side.x === 0 || Math.abs(az) > 0.3) side.x = az <= 0 ? 1 : -1;   // which side of the X line we look from
    if (side.z === 0 || Math.abs(ax) > 0.3) side.z = ax <= 0 ? 1 : -1;   // which side of the Z line
    const sg = gridLabelSigns();
    const fams = labelFamilies(f.pxPerMetre);
    if (!fams.length) { mesh.visible = false; keyRef.current = ''; return; }
    const R = (fams.find((x) => x.alpha > 0.98) ?? fams[fams.length - 1]).spacing;
    const run = runRef.current;
    run.x = stickRun(run.x, f.refX, R);
    run.z = stickRun(run.z, f.refZ, R);
    // Rebuilt only when something visible changed: the density (to 1/32 of an octave), the reference
    // (to 1/16 of the finest label spacing), the run lines, the sides. A still camera costs a compare.
    const fine = fams[0].spacing;
    const key = `${Math.round(Math.log2(f.pxPerMetre) * 32)}|${Math.round((f.refX / fine) * 16)}|${Math.round((f.refZ / fine) * 16)}|${run.x}|${run.z}|${side.x}|${side.z}|${sg.x}|${sg.z}|${Math.round(tilt * 40)}`;
    if (key === keyRef.current) return;                      // the common case: nothing to do
    keyRef.current = key;
    rebuild(geometry, { px: f.pxPerMetre, refX: f.refX, refZ: f.refZ, runX: run.x!, runZ: run.z!, tilt: Math.round(tilt * 40) / 40 }, side.x, side.z, sg.x, sg.z);
  });

  useEffect(() => { liveLabels = meshRef.current; return () => { if (liveLabels === meshRef.current) liveLabels = null; }; }, []);

  return (
    <mesh ref={meshRef} geometry={geometry} material={material}
      frustumCulled={false} renderOrder={2} raycast={() => null} />
  );
};
