// THE FOUR-VIEW LAYOUT (plans/3d-workbench.md Phase 2) — Rhino's Top / Perspective / Front / Right, all
// of the ONE scene, in the ONE canvas. Grown from the spike (its findings are in the plan); mounted only
// while the layout is 'quad' (services/view3d), so a single view runs exactly the path it always did.
//
// THE MODEL, increment 1:
//   - PERSPECTIVE (top-right) is the WORKING pane: r3f's default camera, OrbitControls, the transform
//     gizmos, the corner widget's view — everything the single view had, in a quarter of the canvas.
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
//   - THE GIZMOS: three-stdlib TransformControls maps the pointer over the WHOLE canvas (getPointer reads
//     the element's rect); here it is re-pointed at the Perspective pane, and restored on the way out.
//   - ORBIT is held off while the pointer is over a flat pane, so a wheel there zooms that pane only.

import React, { useEffect, useRef } from 'react';
import { useFrame, useThree, events as createPointerEvents, type RootState } from '@react-three/fiber';
import * as THREE from 'three';
import {
  ORTHO_VIEWS, QUAD_PANES, paneAt, paneRect, orthoFitZoom, onFrameRequest, type OrthoView, type Pane,
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
const PERSP = QUAD_PANES.find((p) => p.view === 'persp')!;

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

function placeFlat(f: FlatPane): void {
  const v = ORTHO_VIEWS[f.pane.view as OrthoView];
  f.cam.up.set(v.up[0], v.up[1], v.up[2]);
  f.cam.position.copy(f.target).add(new THREE.Vector3(v.dir[0], v.dir[1], v.dir[2]).multiplyScalar(STANDOFF));
  f.cam.lookAt(f.target);
  f.cam.updateMatrixWorld(true);
}

type Getter = (e: PointerEvent | MouseEvent) => { x: number; y: number; button: number };
type Gizmo = THREE.Object3D & { isTransformControls?: boolean; getPointer: Getter };

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
    };
    const onDown = (e: PointerEvent) => {
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
    };
  }, [gl, get]);

  // ── The gizmos: map the pointer to the Perspective pane ──
  const patched = useRef(new Map<Gizmo, Getter>());
  useEffect(() => () => { for (const [g, orig] of patched.current) g.getPointer = orig; patched.current.clear(); }, []);

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
        const pr = paneRect(PERSP, r.width, r.height);
        const x = e.clientX - r.left - pr.x, y = e.clientY - r.top - pr.y;
        // Outside the Perspective pane: a point no handle can be under.
        if (x < 0 || y < 0 || x > pr.w || y > pr.h) return { x: 10, y: 10, button: e.button };
        return { x: (x / pr.w) * 2 - 1, y: -(y / pr.h) * 2 + 1, button: e.button };
      };
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
      gl.render(scene, cam);
    }
    gl.setScissorTest(false);
    gl.setViewport(0, 0, w, h);
    gl.autoClear = savedAutoClear;
    scene.background = savedBg;
    // The single-view state for everything that reads it between frames: the floor, numbers on.
    setGridPlane('persp'); syncGridGroups(); setGridLabelsVisible(true);
  }, 1);   // priority > 0: this renders the frame instead of r3f

  return null;
};
