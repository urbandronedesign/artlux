// PHASE 2 SPIKE — four views of the ONE scene in the ONE canvas (plans/3d-workbench.md §3 Phase 2, step 3).
//
// EXPERIMENTAL, OFF BY DEFAULT, per machine: localStorage `artlux.multiview = '1'` and reload. It exists to
// answer the plan's three unknowns before anything is built for real:
//   (a) does WebGPURenderer draw several cameras into scissored rectangles of one canvas?
//   (b) can pointer events (picks) be routed to the camera of the quarter under the pointer?
//   (c) what does it cost?
// It is NOT the feature: no per-view controls, no layout switching, no per-view grid. Rhino's default
// layout, fixed: Top (top-left), Perspective (top-right, the live editor camera), Front (bottom-left),
// Right (bottom-right). `window.__artluxMultiView()` reports what it measured.
//
// ⚠ WebGPU CLEARS A WHOLE ATTACHMENT, NOT A SCISSOR. Every render() opens a render pass, and a pass that
// clears clears the entire canvas — so `autoClear` must be off for all but the first quarter, or each
// view erases the ones drawn before it. The scene background is cleared to ONCE, by hand.

import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, events as createPointerEvents, type RootState } from '@react-three/fiber';
import * as THREE from 'three';
import { ORTHO_VIEWS, orthoFitZoom, type OrthoView } from '../../services/view3d';

export const MULTIVIEW_SPIKE = (() => { try { return localStorage.getItem('artlux.multiview') === '1'; } catch { return false; } })();

type Quad = { name: string; view: OrthoView | 'persp'; col: 0 | 1; row: 0 | 1 };
const QUADS: Quad[] = [
  { name: 'Top', view: 'top', col: 0, row: 0 },
  { name: 'Perspective', view: 'persp', col: 1, row: 0 },
  { name: 'Front', view: 'front', col: 0, row: 1 },
  { name: 'Right', view: 'right', col: 1, row: 1 },
];
const STANDOFF = 1000, DEPTH = 10_000;

// Shared with the event computer: which camera answers which quarter. Module state, like the grid frame —
// one Simulator3D (guarded).
const cams = new Map<string, THREE.Camera>();
const quadRect = (q: Quad, w: number, h: number) => ({ x: q.col * (w / 2), y: q.row * (h / 2), w: w / 2, h: h / 2 });
const quadAt = (x: number, y: number, w: number, h: number): Quad => QUADS.find((q) => q.col === (x < w / 2 ? 0 : 1) && q.row === (y < h / 2 ? 0 : 1))!;

/** r3f's pointer mapping, per quarter: NDC inside the quarter under the pointer, through that quarter's camera. */
export function multiViewEvents(store: Parameters<typeof createPointerEvents>[0]) {
  const base = createPointerEvents(store);
  return {
    ...base,
    compute(event: { offsetX: number; offsetY: number }, state: RootState) {
      const { width: w, height: h } = state.size;
      const q = quadAt(event.offsetX, event.offsetY, w, h);
      const r = quadRect(q, w, h);
      state.pointer.set(((event.offsetX - r.x) / r.w) * 2 - 1, -((event.offsetY - r.y) / r.h) * 2 + 1);
      // The Perspective quarter's ray must use the QUARTER's aspect, not the canvas's (measured: a skewed ray).
      const cam = q.view === 'persp' ? perspFor(state.camera as THREE.PerspectiveCamera, r.w / r.h) : cams.get(q.name) ?? state.camera;
      state.raycaster.setFromCamera(state.pointer, cam);
      lastPickQuad = q.name;
    },
  };
}
let lastPickQuad = '';
const _persp = new THREE.PerspectiveCamera();
function perspFor(src: THREE.PerspectiveCamera, aspect: number): THREE.PerspectiveCamera {
  _persp.copy(src); _persp.aspect = aspect; _persp.updateProjectionMatrix(); _persp.updateMatrixWorld(true);
  return _persp;
}

export const MultiViewSpike: React.FC = () => {
  const { gl, scene, size } = useThree();
  const ortho = useMemo(() => {
    const m = new Map<string, THREE.OrthographicCamera>();
    for (const q of QUADS) {
      if (q.view === 'persp') continue;
      const c = new THREE.OrthographicCamera(-1, 1, 1, -1, -DEPTH, DEPTH);
      m.set(q.name, c);
      cams.set(q.name, c);
    }
    return m;
  }, []);
  useEffect(() => () => { for (const k of ortho.keys()) cams.delete(k); }, [ortho]);

  // Frame the flat views once on the scene's models + everything else that has geometry.
  const framed = useRef(false);
  const lastBox = useRef(''); const stableFrames = useRef(0);
  const stats = useRef({ frames: 0, totalMs: 0, perQuadMs: [0, 0, 0, 0], last: 0 });
  const bg = useMemo(() => new THREE.Color('#0d0d0d'), []);

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__artluxMultiView = () => {
      const s = stats.current;
      const n = Math.max(1, s.frames);
      return {
        backend: (gl as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer ? 'webgpu' : 'webgl',
        size: [size.width, size.height], frames: s.frames, avgFrameMs: +(s.totalMs / n).toFixed(3),
        avgQuadMs: s.perQuadMs.map((v) => +(v / n).toFixed(3)), lastPickQuad,
      };
    };
    // Where a world point lands on screen in a given quarter (css px, canvas-relative) — for the pick test.
    w.__artluxMultiViewProject = (p: [number, number, number], quad: string) => {
      const q = QUADS.find((x) => x.name === quad)!;
      const r = quadRect(q, size.width, size.height);
      const cam = q.view === 'persp' ? perspFor(useThreeCamera.current as THREE.PerspectiveCamera, r.w / r.h) : ortho.get(quad)!;
      const v = new THREE.Vector3(...p).project(cam);
      return [r.x + ((v.x + 1) / 2) * r.w, r.y + ((1 - v.y) / 2) * r.h];
    };
    return () => { delete w.__artluxMultiView; delete w.__artluxMultiViewProject; };
  }, [gl, size, ortho]);
  const useThreeCamera = useRef<THREE.Camera | null>(null);

  useFrame((state) => {
    const t0 = performance.now();
    const { width: w, height: h } = state.size;
    useThreeCamera.current = state.camera;
    if (!framed.current) {
      const box = new THREE.Box3();
      scene.traverseVisible((o) => { if (o.userData?.modelId) box.expandByObject(o); });
      const key = box.isEmpty() ? '' : [...box.min.toArray(), ...box.max.toArray()].map((n) => n.toFixed(3)).join(',');
      if (key !== lastBox.current) { lastBox.current = key; stableFrames.current = 0; } else stableFrames.current++;
      // Models load over several frames: frame only once the bounds have held still for half a second.
      if (!box.isEmpty() && stableFrames.current > 30) {
        const s = box.getBoundingSphere(new THREE.Sphere());
        for (const [name, c] of ortho) {
          const v = ORTHO_VIEWS[QUADS.find((q) => q.name === name)!.view as OrthoView];
          c.up.set(...v.up);
          c.position.copy(s.center).add(new THREE.Vector3(...v.dir).multiplyScalar(STANDOFF));
          c.lookAt(s.center);
          c.zoom = orthoFitZoom(s.radius, w / 2, h / 2);
        }
        framed.current = true;
      }
    }
    const isWebGPU = !!(gl as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer;
    const savedAutoClear = gl.autoClear;
    const savedBg = scene.background;
    scene.background = null;                       // cleared by hand, once — see the header
    gl.setScissorTest(false);
    gl.setViewport(0, 0, w, h);
    gl.setClearColor(bg, 1);
    gl.clear();
    gl.autoClear = false;
    gl.setScissorTest(true);
    QUADS.forEach((q, i) => {
      const tq = performance.now();
      const r = quadRect(q, w, h);
      // ⚠ THE VIEWPORT ORIGIN DIFFERS BY BACKEND (measured): WebGLRenderer counts y from the BOTTOM of the
      // canvas, WebGPURenderer from the TOP. With one formula the WebGPU rows came out swapped.
      const y = isWebGPU ? r.y : h - r.y - r.h;
      gl.setViewport(r.x, y, r.w, r.h);
      gl.setScissor(r.x, y, r.w, r.h);
      let cam: THREE.Camera;
      if (q.view === 'persp') {
        const p = state.camera as THREE.PerspectiveCamera;
        const aspect = p.aspect;
        p.aspect = r.w / r.h; p.updateProjectionMatrix();
        gl.render(scene, p);
        p.aspect = aspect; p.updateProjectionMatrix();
        cam = p;
      } else {
        const c = ortho.get(q.name)!;
        c.left = -r.w / 2; c.right = r.w / 2; c.top = r.h / 2; c.bottom = -r.h / 2;
        c.updateProjectionMatrix();
        gl.render(scene, c);
        cam = c;
      }
      void cam;
      stats.current.perQuadMs[i] += performance.now() - tq;
    });
    gl.setScissorTest(false);
    gl.setViewport(0, 0, w, h);
    gl.autoClear = savedAutoClear;
    scene.background = savedBg;
    stats.current.frames++;
    stats.current.totalMs += performance.now() - t0;
  }, 1);   // priority > 0: this component renders the frame instead of r3f

  return null;
};
