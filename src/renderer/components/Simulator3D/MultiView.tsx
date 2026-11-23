// THE FOUR-VIEW LAYOUT (plans/3d-workbench.md Phase 2) — Rhino's Top / Perspective / Front / Right, all
// of the ONE scene, in the ONE canvas. Grown from the spike (its findings are in the plan); mounted only
// while the layout is 'quad' (services/view3d), so a single view runs exactly the path it always did.
//
// THE MODEL, increment 1:
//   - PERSPECTIVE (top-right) holds r3f's default camera and OrbitControls — the orbit, in a quarter of
//     the canvas. The gizmos work in any pane (below); the last pane clicked is the ACTIVE one.
//   - THE THREE FLAT PANES are live references: each has its own orthographic camera (target + zoom),
//     wheel zooms it about the cursor, right/middle-drag pans it, a click selects through it.
//
// What this file has to take over from r3f, each for a measured reason (see the plan's spike notes):
//   - RENDERING (useFrame priority 1): one clear, then every pane with autoClear off — WebGPU clears a
//     whole attachment, not a scissor — and the viewport y origin per backend (bottom on WebGL, top on
//     WebGPU).
//   - PICKING (`multiViewEvents`): r3f raycasts through the camera of the pane under the pointer, with
//     the pointer in THAT pane's coordinates.
//   - THE GRID per pane: its plane and scale are re-solved for each pane's camera before drawing it
//     (gridSpace + GroundGrid.applyGrid). The NUMBERS stay in the Perspective pane — their geometry is
//     laid out for one camera.
//   - THE GIZMOS work in EVERY pane (increment 2). three-stdlib TransformControls maps the pointer over the
//     WHOLE canvas (getPointer reads the element's rect) and raycasts/sizes itself through ONE `camera`.
//     So: the gizmo's pane is the pane under the pointer (locked while a handle is held); its getPointer
//     maps into that pane and its camera is that pane's. For drawing, each pane's pass hands the gizmo
//     its own camera (so it is sized and oriented right in every pane), and after the passes the gizmo
//     gets its pane's camera back AND its matrices re-solved — its drag plane is a child whose matrix
//     the LAST pass computed, and a stale plane would drag along the wrong pane's axes.
//   - ORBIT is held off while the pointer is over a flat pane, so a wheel there zooms that pane only.

import React, { useEffect, useRef } from 'react';
import { useFrame, useThree, events as createPointerEvents, type RootState } from '@react-three/fiber';
import * as THREE from 'three';
import {
  ORTHO_VIEWS, QUAD_PANES, paneAt, paneRect, orthoFitZoom, onFrameRequest, setActivePane, type OrthoView, type Pane,
} from '../../services/view3d';
import { setGridPlane, syncGridGroups } from './gridSpace';
import { applyGrid } from './GroundGrid';
import { applyGnomon } from './OriginGnomon';
import { gizmoHeld } from './GizmoOrbitGuard';
import { getGridFrame } from './gridScale';
import { setGridLabelsVisible } from './GridLabels';
import { setQuadHtml } from './htmlPosition';

const STANDOFF = 1000, DEPTH = 10_000;
const BG = new THREE.Color('#0d0d0d');

// The flat panes' cameras, shared with the pointer computer. Module state: one Simulator3D (guarded).
interface FlatPane { pane: Pane; cam: THREE.OrthographicCamera; target: THREE.Vector3; framed: boolean }
const flats = new Map<string, FlatPane>();

/** r3f's pointer mapping, per pane: the pointer in the pane's own NDC, through that pane's camera. */
export function multiViewEvents(store: Parameters<typeof createPointerEvents>[0]) {
  const base = createPointerEvents(store);
  return {
    ...base,
    compute(event: { offsetX: number; offsetY: number }, state: RootState) {
      const { width: w, height: h } = state.size;
      const p = paneAt(event.offsetX, event.offsetY, w, h);
      const r = paneRect(p, w, h);
      state.pointer.set(((event.offsetX - r.x) / r.w) * 2 - 1, -((event.offsetY - r.y) / r.h) * 2 + 1);
      const flat = flats.get(p.id);
      state.raycaster.setFromCamera(state.pointer, flat ? flat.cam : state.camera);
    },
  };
}

/**
 * The pane under a canvas-relative point and the camera it draws through — for code that raycasts on
 * its own (ObjectDrag). `null` when four views are not up: then the whole canvas is one view.
 */
export function paneViewAt(x: number, y: number, w: number, h: number, def: THREE.Camera): { rect: { x: number; y: number; w: number; h: number }; cam: THREE.Camera } | null {
  if (!flats.size) return null;
  const p = paneAt(x, y, w, h);
  return { rect: paneRect(p, w, h), cam: paneCamera(p, def) };
}

/** The camera a pane draws (and the gizmo raycasts) through. */
function paneCamera(p: Pane, def: THREE.Camera): THREE.Camera { return flats.get(p.id)?.cam ?? def; }

function placeFlat(f: FlatPane): void {
  const v = ORTHO_VIEWS[f.pane.view as OrthoView];
  f.cam.up.set(v.up[0], v.up[1], v.up[2]);
  f.cam.position.copy(f.target).add(new THREE.Vector3(v.dir[0], v.dir[1], v.dir[2]).multiplyScalar(STANDOFF));
  f.cam.lookAt(f.target);
  f.cam.updateMatrixWorld(true);
}

type Getter = (e: PointerEvent | MouseEvent) => { x: number; y: number; button: number };
type Gizmo = THREE.Object3D & { isTransformControls?: boolean; getPointer: Getter; camera: THREE.Camera; dragging?: boolean };

/** The pane the gizmos work in: the one under the pointer, held while a handle is dragged. */
let gizmoPane: Pane = QUAD_PANES.find((p) => p.view === 'persp')!;

export const MultiView: React.FC<{ orbitEnabled: boolean }> = ({ orbitEnabled }) => {
  const { gl, scene } = useThree();
  const get = useThree((s) => s.get);
  const orbitOn = useRef(orbitEnabled); orbitOn.current = orbitEnabled;
  const settle = useRef({ key: '', frames: 0 });

  // The flat panes' cameras live as long as the layout does.
  useEffect(() => {
    for (const pane of QUAD_PANES) {
      if (pane.view === 'persp') continue;
      flats.set(pane.id, { pane, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, -DEPTH, DEPTH), target: new THREE.Vector3(), framed: false });
    }
    setQuadHtml(true);
    return () => {
      setQuadHtml(false);
      flats.clear();
      // Leaving the layout: the perspective camera gets the whole canvas's aspect back, the grid its floor.
      const { camera, size } = get();
      const c = camera as THREE.PerspectiveCamera;
      if (c.isPerspectiveCamera && size.height > 0) { c.aspect = size.width / size.height; c.updateProjectionMatrix(); }
      setGridPlane('persp'); syncGridGroups(); setGridLabelsVisible(true);
    };
  }, [get]);

  // DIAGNOSTIC (read-only), like __artluxView3d: the flat panes' cameras and the gizmos re-pointed.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__artluxQuad = () => ({
      flats: [...flats.values()].map((f) => ({ id: f.pane.id, zoom: +f.cam.zoom.toFixed(3), target: f.target.toArray().map((n) => +n.toFixed(3)), framed: f.framed })),
      gizmos: patched.current.size,
      perspAspect: +((get().camera as THREE.PerspectiveCamera).aspect ?? 0).toFixed(3),
      gizmoPane: gizmoPane.id,
      // Where the first gizmo's object sits in each pane, client px — so a test can grab it in any pane.
      gizmoAt: (() => {
        const g = [...patched.current.keys()][0] as (Gizmo & { object?: THREE.Object3D }) | undefined;
        if (!g?.object) return null;
        const { camera, gl: r } = get();
        const rect = r.domElement.getBoundingClientRect();
        const out: Record<string, [number, number]> = {};
        for (const p of QUAD_PANES) {
          const pr = paneRect(p, rect.width, rect.height);
          const v = new THREE.Vector3().setFromMatrixPosition(g.object.matrixWorld).project(paneCamera(p, camera));
          out[p.id] = [rect.left + pr.x + ((v.x + 1) / 2) * pr.w, rect.top + pr.y + ((1 - v.y) / 2) * pr.h];
        }
        return out;
      })(),
    });
    return () => { delete w.__artluxQuad; };
  }, [get]);

  // Home / F also frame the flat panes (on everything).
  useEffect(() => onFrameRequest(() => { for (const f of flats.values()) f.framed = false; settle.current = { key: '', frames: 31 }; }), []);

  // ── DOM: orbit held off over a flat pane; wheel zoom + right/middle-drag pan of the flat panes ──
  useEffect(() => {
    const el = (get().events.connected as HTMLElement | undefined) ?? gl.domElement;
    const local = (e: MouseEvent) => {
      const r = gl.domElement.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
    };
    const flatUnder = (e: MouseEvent) => { const l = local(e); return flats.get(paneAt(l.x, l.y, l.w, l.h).id) ?? null; };
    const setOrbit = (on: boolean) => {
      const k = get().controls as unknown as { enabled?: boolean } | null;
      if (gizmoHeld()) return;   // a gizmo drag owns the pointer — GizmoOrbitGuard.tsx
      if (k && 'enabled' in k) k.enabled = on && orbitOn.current;
    };
    let pan: { f: FlatPane; x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (pan) {
        const z = pan.f.cam.zoom;
        const right = new THREE.Vector3().setFromMatrixColumn(pan.f.cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(pan.f.cam.matrixWorld, 1);
        pan.f.target.addScaledVector(right, -(e.clientX - pan.x) / z).addScaledVector(up, (e.clientY - pan.y) / z);
        pan.x = e.clientX; pan.y = e.clientY;
        return;
      }
      setOrbit(!flatUnder(e));
      // The gizmos follow the pointer into its pane — unless a handle is held (the drag keeps its pane).
      const l = local(e);
      const p = paneAt(l.x, l.y, l.w, l.h);
      if (p !== gizmoPane && ![...patched.current.keys()].some((g) => g.dragging)) {
        gizmoPane = p;
        const cam = paneCamera(p, get().camera);
        for (const g of patched.current.keys()) { g.camera = cam; g.updateMatrixWorld(true); }
      }
    };
    const onDown = (e: PointerEvent) => {
      const l = local(e);
      setActivePane(paneAt(l.x, l.y, l.w, l.h).id);   // Rhino: the active view is the one last clicked
      const f = flatUnder(e);
      setOrbit(!f);
      if (f && (e.button === 1 || e.button === 2)) { pan = { f, x: e.clientX, y: e.clientY }; e.preventDefault(); }
    };
    const onUp = () => { pan = null; };
    const onWheel = (e: WheelEvent) => {
      const f = flatUnder(e);
      if (!f) return;
      e.preventDefault();
      // Zoom ABOUT THE CURSOR: the world point under it stays under it.
      const l = local(e); const r = paneRect(f.pane, l.w, l.h);
      const ndc = new THREE.Vector3(((l.x - r.x) / r.w) * 2 - 1, -((l.y - r.y) / r.h) * 2 + 1, 0);
      const before = ndc.clone().unproject(f.cam);
      f.cam.zoom = Math.min(1e5, Math.max(1e-3, f.cam.zoom * Math.pow(1.0015, -e.deltaY)));
      f.cam.updateProjectionMatrix();
      const after = ndc.clone().unproject(f.cam);
      f.target.add(before.sub(after));
    };
    const onMenu = (e: MouseEvent) => { if (flatUnder(e)) e.preventDefault(); };
    el.addEventListener('pointermove', onMove, true);
    el.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    el.addEventListener('contextmenu', onMenu, true);
    return () => {
      el.removeEventListener('pointermove', onMove, true);
      el.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      el.removeEventListener('wheel', onWheel, true);
      el.removeEventListener('contextmenu', onMenu, true);
      setOrbit(true);
      setActivePane('persp');
    };
  }, [gl, get]);

  // ── The gizmos: the pointer mapped into the gizmo's pane; restored (pointer AND camera) on the way out ──
  const patched = useRef(new Map<Gizmo, Getter>());
  useEffect(() => () => {
    const def = get().camera;
    for (const [g, orig] of patched.current) { g.getPointer = orig; g.camera = def; g.updateMatrixWorld(true); }
    patched.current.clear();
    gizmoPane = QUAD_PANES.find((p) => p.view === 'persp')!;
  }, [get]);

  useFrame((state) => {
    const { width: w, height: h } = state.size;
    if (!(w > 0 && h > 0)) return;
    const isWebGPU = !!(gl as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer;

    // Patch any gizmo that has appeared (they mount with a selection).
    scene.traverse((o) => {
      const g = o as Gizmo;
      if (!g.isTransformControls || patched.current.has(g)) return;
      const orig = g.getPointer;
      patched.current.set(g, orig);
      g.getPointer = (e) => {
        const r = gl.domElement.getBoundingClientRect();
        const pr = paneRect(gizmoPane, r.width, r.height);
        // In the gizmo's pane's own NDC. Outside it (a drag that leaves the pane) the value runs past ±1,
        // which is what a drag wants: the handle keeps following the pointer along its axis.
        const x = e.clientX - r.left - pr.x, y = e.clientY - r.top - pr.y;
        return { x: (x / pr.w) * 2 - 1, y: -(y / pr.h) * 2 + 1, button: e.button };
      };
      g.camera = paneCamera(gizmoPane, state.camera);
    });

    // Frame the flat panes once the scene's bounds hold still (models load over several frames).
    if ([...flats.values()].some((f) => !f.framed)) {
      const box = new THREE.Box3();
      scene.traverseVisible((o) => { if (o.userData?.modelId) box.expandByObject(o); });
      const key = box.isEmpty() ? '' : [...box.min.toArray(), ...box.max.toArray()].map((n) => n.toFixed(3)).join(',');
      const s = settle.current;
      if (key !== s.key) { s.key = key; s.frames = 0; } else s.frames++;
      if (!box.isEmpty() && s.frames > 30) {
        const sph = box.getBoundingSphere(new THREE.Sphere());
        for (const f of flats.values()) {
          const r = paneRect(f.pane, w, h);
          f.target.copy(sph.center);
          f.cam.zoom = orthoFitZoom(sph.radius, r.w, r.h);
          f.framed = true;
        }
      }
    }

    // ── RENDER ──
    const savedAutoClear = gl.autoClear;
    const savedBg = scene.background;
    scene.background = null;                // cleared by hand, once — WebGPU clears a whole attachment
    gl.setScissorTest(false);
    gl.setViewport(0, 0, w, h);
    gl.setClearColor(BG, 1);
    gl.clear();
    gl.autoClear = false;
    gl.setScissorTest(true);
    for (const pane of QUAD_PANES) {
      const r = paneRect(pane, w, h);
      const y = isWebGPU ? r.y : h - r.y - r.h;   // viewport origin: top on WebGPU, bottom on WebGL
      gl.setViewport(r.x, y, r.w, r.h);
      gl.setScissor(r.x, y, r.w, r.h);
      let cam: THREE.Camera;
      const f = flats.get(pane.id);
      if (f) {
        f.cam.left = -r.w / 2; f.cam.right = r.w / 2; f.cam.top = r.h / 2; f.cam.bottom = -r.h / 2;
        f.cam.updateProjectionMatrix();
        placeFlat(f);
        cam = f.cam;
      } else {
        // The working pane keeps the perspective camera AT THE PANE'S ASPECT between frames too — the
        // gizmo raycasts through it with no knowledge of panes.
        const c = state.camera as THREE.PerspectiveCamera;
        const a = r.w / r.h;
        if (c.isPerspectiveCamera && Math.abs(c.aspect - a) > 1e-6) { c.aspect = a; c.updateProjectionMatrix(); }
        cam = c;
      }
      setGridPlane(pane.view); syncGridGroups();
      applyGrid(cam, r.h);
      applyGnomon(getGridFrame()?.pxPerMetre ?? null);   // the origin triad, same size on screen in every pane
      setGridLabelsVisible(pane.view === 'persp');
      for (const g of patched.current.keys()) g.camera = cam;   // sized and oriented for THIS pane
      gl.render(scene, cam);
    }
    // The gizmos back on their own pane's camera, matrices re-solved — see the header (the drag plane).
    const gcam = paneCamera(gizmoPane, state.camera);
    for (const g of patched.current.keys()) { g.camera = gcam; g.updateMatrixWorld(true); }
    gl.setScissorTest(false);
    gl.setViewport(0, 0, w, h);
    gl.autoClear = savedAutoClear;
    scene.background = savedBg;
    // The single-view state for everything that reads it between frames: the floor, numbers on.
    setGridPlane('persp'); syncGridGroups(); setGridLabelsVisible(true);
  }, 1);   // priority > 0: this renders the frame instead of r3f

  return null;
};
