import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { getGridFrame } from './gridScale';

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
// ── WHY THERE IS NO COLLISION THINNING ANY MORE ────────────────────────────────────────────────────
// The text is sized as a fraction of ONE SECTION and runs along the same axis its neighbours are spaced
// on. Perspective shrinks the spacing and the text by exactly the same factor, so two numbers on a run
// can never overlap on screen at any camera — the screen-space stride ladder the overlay needed is gone.
// Far numbers dissolve with the same squared fade as the grid lines instead.
//
// ── COST ───────────────────────────────────────────────────────────────────────────────────────────
// One draw call. The atlas is drawn and uploaded ONCE per session. The geometry (a few hundred quads)
// is rewritten only when the grid frame changes — a zoom rung or a pan across a section — or the camera
// crosses an axis (the text flips to stay readable). Every other frame is two comparisons.

// ── Style ──────────────────────────────────────────────────────────────────────────────────────────
const INK = new THREE.Color('#d0d0d0');    // a shade under the section lines' #d8d8d8 — a caption, not a feature
const X_INK = new THREE.Color('#ff6b7f');
const Z_INK = new THREE.Color('#6fa8f8');
/**
 * Text height. Numbers sit only on WHOLE METRES, so neighbours are max(1 m, one section) apart — much
 * further than one section when the grid is finer than a metre — and the text is sized against THAT
 * spacing (H_OF_SPACING), capped by H_OF_SECTION so zooming in close does not blow a "1" up to a
 * third of the screen. Flat text on a floor seen at a grazing angle needs every bit of height it can
 * get, and the spacing is what says how much it can have.
 */
const H_OF_SPACING = 0.3;
const H_OF_SECTION = 0.4;
/** The widest a label may be, as a fraction of the spacing, so it never reaches its neighbour. */
const MAX_W = 0.86;
/** Gap between the line and the top of its numbers, in sections — they caption the line, not sit on it. */
const GAP = 0.06;
/** Sections each way that get a number. The grid lines have faded to ~2% by here (GroundGrid FADE). */
const EXT = 11;
/** Same falloff as GroundGrid's lines, so a number dissolves exactly where its line does. */
const FADE = 12;
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

/**
 * Linear falloff with distance from the grid centre, in sections, reaching zero where GroundGrid's lines
 * do. Linear, not the lines' squared curve: a thin line can afford to go dim early, flat text cannot —
 * with the squared curve the second number out was already at 40% and unreadable at a working angle.
 */
const fadeAt = (k: number) => { const d = Math.abs(k) / FADE; return d >= 1 ? 0 : 1 - d; };

/**
 * Rebuild both runs. `sideX`/`sideZ` say which side of each axis line the camera is on (+1 / -1), which
 * decides which way the text faces so it is never read mirrored or upside down.
 */
function rebuild(geo: THREE.BufferGeometry, section: number, ox: number, oz: number, sideX: number, sideZ: number): void {
  let q = 0;
  // Whole metres only ⇒ neighbours are 1 m apart on sub-metre rungs, one section apart otherwise
  // (the ≥ 1 m rungs — 1, 2, 5, 10… — are themselves whole metres).
  const spacing = Math.max(1, section);
  const h = Math.min(H_OF_SPACING * spacing, H_OF_SECTION * section), gap = GAP * section;
  for (const axis of ['x', 'z'] as const) {
    // v = the text's "up", pointing AWAY from the viewer; u = v × Y, the reading direction.
    if (axis === 'x') _v.set(0, 0, -sideX); else _v.set(-sideZ, 0, 0);
    _u.set(-_v.z, 0, _v.x);
    let endK = -Infinity;
    for (let k = -EXT; k <= EXT; k++) {
      if (axis === 'z' && k === 0) continue;   // the X run already prints the shared "0"
      const f = fadeAt(k);
      if (f < 0.02) continue;
      const value = (axis === 'x' ? ox : oz) + k * section;
      // WHOLE METRES ONLY, as a bare integer (owner's decision, 2026-10-22: the floor is read in metres,
      // so no unit and no decimals). A line between whole metres simply carries no number.
      const metres = Math.round(value);
      if (Math.abs(value - metres) > 1e-6) continue;
      if (axis === 'x') _at.set(value, Y, oz); else _at.set(ox, Y, value);
      const text = String(metres === 0 ? 0 : metres);   // never "-0"
      // Shrink only the long ones ("-120"): a label wider than its spacing would touch the next.
      const hk = Math.min(h, (MAX_W * spacing) / (text.length * cellAspect));
      q = layString(geo, q, text, _at, _u, _v, hk, gap, _ink.copy(INK).multiplyScalar(f));
      if (k > endK) endK = k;
    }
    // The axis letter under the positive end of the run, so the figures say what they measure and which
    // way the axis grows.
    if (endK > -Infinity) {
      const value = (axis === 'x' ? ox : oz) + endK * section;
      if (axis === 'x') _at.set(value, Y, oz); else _at.set(ox, Y, value);
      q = layString(geo, q, axis === 'x' ? 'X' : 'Z', _at, _u, _v, h, gap + h * 1.35,
        _ink.copy(axis === 'x' ? X_INK : Z_INK).multiplyScalar(fadeAt(endK)));
    }
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.uv.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
  geo.setDrawRange(0, q * 6);
}

/**
 * Mounted inside the Canvas, after GroundGrid (the single writer of the grid frame) and after
 * ProjectorView — equal-priority useFrame subscribers run in mount order, so this reads this frame's
 * section, never last frame's. Priority stays 0: a positive priority hands r3f's whole render loop to
 * this subscriber and the viewport stops drawing (projectorDepth.ts records the same trap).
 */
export const GridLabels: React.FC = () => {
  const geometry = useMemo(makeGeometry, []);
  // Born with its map — see the header.
  const material = useMemo(() => new THREE.MeshBasicMaterial({
    map: getAtlas(), vertexColors: true, transparent: true, depthWrite: false,
    toneMapped: false, side: THREE.DoubleSide,
  }), []);
  const meshRef = useRef<THREE.Mesh>(null);
  const keyRef = useRef('');

  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);

  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const f = getGridFrame();
    if (!f) { mesh.visible = false; keyRef.current = ''; return; }   // grid drew nothing this tick
    mesh.visible = true;
    const sideX = camera.position.z >= f.originZ ? 1 : -1;   // which side of the X line we look from
    const sideZ = camera.position.x >= f.originX ? 1 : -1;   // which side of the Z line
    const key = `${f.section}|${f.originX}|${f.originZ}|${sideX}|${sideZ}`;
    if (key === keyRef.current) return;                      // the common case: nothing to do
    keyRef.current = key;
    rebuild(geometry, f.section, f.originX, f.originZ, sideX, sideZ);
  });

  return (
    <mesh ref={meshRef} geometry={geometry} material={material}
      frustumCulled={false} renderOrder={2} raycast={() => null} />
  );
};
