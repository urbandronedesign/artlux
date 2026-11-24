// THE R3F ADAPTER FOR services/view3d (plans/3d-workbench.md Phase 1, §2 "thin adapter").
//
// view3d.ts holds WHICH view and the framing maths, renderer-free. These three components turn it into
// cameras inside the one Canvas. They are the part the native engine's E4 replaces; nothing outside the
// Canvas reaches in here — the header and the keys talk to view3d.
//
// HOW THE SWITCH WORKS, and why it is shaped like this:
// - Perspective is r3f's DEFAULT camera, the one the Canvas was created with. It is never replaced, only
//   shadowed: an orthographic view mounts <OrthoCamera makeDefault>, and drei hands the default back to
//   the perspective camera when it unmounts. So the perspective pose survives a trip to Top untouched —
//   nothing writes to the perspective camera while an ortho view is up.
// - drei's OrbitControls is rebuilt whenever the default camera changes, and a rebuilt OrbitControls
//   starts with its target at the origin. The perspective TARGET is therefore recorded every frame while
//   in perspective (cheap: one vector copy) and handed back on return.
// - An ortho view LOCKS ROTATION (owner decision, 3d-workbench §6.4 — Rhino): Simulator3D turns
//   `enableRotate` off, so OrbitControls only pans and zooms there.

import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { Fixture } from '../../types';
import { effectivePos } from '../../services/led3dLayout';
import {
  ORTHO_VIEWS, isOrtho, registerFrameHandler, registerPoseIO, perspFitDistance, orthoFitZoom, orthoZoomMatchingPersp,
  type OrthoView, type ViewKind, type FrameTarget, type Pose3D, type DisplayMode,
} from '../../services/view3d';

// The ortho camera's near/far, SYMMETRIC around it: an orthographic projection has no perspective divide,
// so depth precision is linear and a camera placed anywhere along its axis sees the whole venue — nothing
// is ever sliced away because the camera sits "inside" a wall. (Negative near is legal for an ortho
// camera, and the raycaster's ray then starts at the near plane, so picking matches what is drawn.)
export const ORTHO_DEPTH = 10_000;
// How far along its axis the ortho camera is parked from the target. Arbitrary — see ORTHO_DEPTH — but
// finite, so position-derived maths elsewhere (a screen-size marker's distance) stays well-behaved.
const ORTHO_STANDOFF = 1_000;

type Controls = { target: THREE.Vector3; update(): void; object?: THREE.Camera };
const _v = new THREE.Vector3();

/** Mounted only while an orthographic view is shown; becomes r3f's default camera for that time. */
export const OrthoCamera: React.FC = () => <OrthographicCamera makeDefault near={-ORTHO_DEPTH} far={ORTHO_DEPTH} />;

/** Places the camera for the current view on every view change. Renders nothing. */
export const ViewController: React.FC<{ view: ViewKind }> = ({ view }) => {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const height = useThree((s) => s.size.height);
  const perspTarget = useRef(new THREE.Vector3());
  const perspCam = useRef<THREE.PerspectiveCamera | null>(null);
  const applied = useRef<ViewKind>('persp');

  // DIAGNOSTIC (read-only), the same window-guarded pattern as __artluxMp4Stats: where the view camera
  // actually is — the only honest answer to "is Top really looking straight down?".
  const get = useThree((s) => s.get);
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__artluxView3d = () => {
      const { camera: c, controls: k } = get();
      const t = (k as unknown as Controls | null)?.target;
      const dir = new THREE.Vector3(); c.getWorldDirection(dir);
      const r = (v: THREE.Vector3) => v.toArray().map((n) => Math.round(n * 1000) / 1000);
      return { type: c.type, position: r(c.position), up: r(c.up), dir: r(dir), zoom: (c as THREE.OrthographicCamera).zoom, target: t ? r(t) : null, view };
    };
    return () => { delete w.__artluxView3d; };
  }, [get, view]);

  // A view change is PENDING until the camera and the controls built for it are both live: the switch
  // takes several commits (drei sets the default camera, then OrbitControls rebuilds for it).
  const pending = useRef<{ from: ViewKind } | null>(null);
  useEffect(() => {
    if (view === applied.current) return;
    pending.current = { from: applied.current };
    applied.current = view;
  }, [view]);

  // NAMED VIEWS (item 5): capture the live viewpoint; apply a saved one. applyPose() has already switched
  // the view, so the pose waits (like `pending`) until the camera of ITS kind is the live one.
  const posePending = useRef<Pose3D | null>(null);
  const viewRef = useRef(view); viewRef.current = view;
  useEffect(() => registerPoseIO({
    capture: () => {
      const { camera: c, controls: k } = get();
      const t = (k as unknown as Controls | null)?.target;
      if (!t) return null;
      const o = c as THREE.OrthographicCamera;
      return {
        kind: viewRef.current, target: t.toArray() as Pose3D['target'], position: c.position.toArray() as Pose3D['position'],
        ...(o.isOrthographicCamera ? { zoom: o.zoom } : {}),
      };
    },
    apply: (pose) => { posePending.current = pose; },
  }), [get]);

  // ONE PER-FRAME PASS, after OrbitControls' own update (its useFrame runs at -1, this at the default 0).
  //
  // ⚠ AN ORTHO VIEW IS ENFORCED EVERY FRAME, not placed once. Placing it once lost the FIRST Perspective →
  // Top switch on the packaged app: the camera kept the new up and zoom but ended at an elevated perspective
  // framing (an oblique "Top" — the wall showed its face), while ortho → ortho switches held. The writer was
  // found later: the lidar-tracking plugin's VenueFraming framed every NEW camera once, and each switch from
  // Perspective mounts a new orthographic one (fixed there: it frames perspective cameras only). The
  // per-frame placement stays regardless — re-deriving the position from the orbit target along the view's
  // axis makes the axis a property of the view rather than of whoever wrote the camera last; it costs one
  // vector copy and a lookAt, and panning still works because pan moves the target.
  useFrame(() => {
    if (!controls?.target || controls.object !== camera) return;
    if (isOrtho(view)) {
      const cam = camera as THREE.OrthographicCamera;
      if (!cam.isOrthographicCamera) return;
      const p = pending.current;
      if (p) {
        pending.current = null;
        if (!isOrtho(p.from)) {
          controls.target.copy(perspTarget.current);
          if (perspCam.current) {
            // Same size on screen as the perspective view had at its target — no jump on the switch.
            cam.zoom = orthoZoomMatchingPersp(perspCam.current.position.distanceTo(perspTarget.current), perspCam.current.fov, height);
            cam.updateProjectionMatrix();
          }
        }
      }
      const pose = posePending.current;
      if (pose && pose.kind === view) {
        posePending.current = null;
        controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
        if (pose.zoom && pose.zoom > 0) { cam.zoom = pose.zoom; cam.updateProjectionMatrix(); }
      }
      placeOrtho(cam, view, controls.target);
      return;
    }
    const c = camera as THREE.PerspectiveCamera;
    if (!c.isPerspectiveCamera) return;
    if (pending.current) {
      // Back from an ortho view: the rebuilt controls start at the origin — hand the target back. The
      // perspective camera itself was never written while away, so its pose is where it was left.
      pending.current = null;
      controls.target.copy(perspTarget.current);
      controls.update();
      return;
    }
    const pose = posePending.current;
    if (pose && pose.kind === 'persp') {
      posePending.current = null;
      c.position.set(pose.position[0], pose.position[1], pose.position[2]);
      controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
      controls.update();
    }
    perspTarget.current.copy(controls.target);
    perspCam.current = c;
  });
  return null;
};

function placeOrtho(cam: THREE.OrthographicCamera, view: OrthoView, target: THREE.Vector3): void {
  const v = ORTHO_VIEWS[view];
  cam.up.set(v.up[0], v.up[1], v.up[2]);
  cam.position.copy(target).add(_v.set(v.dir[0], v.dir[1], v.dir[2]).multiplyScalar(ORTHO_STANDOFF));
  cam.lookAt(target);
  cam.updateMatrixWorld(true);
}

/**
 * Answers view3d.requestFrame: ZOOM EXTENTS (everything — models and fixtures) and ZOOM SELECTED.
 * Framing keeps the view's direction and moves only the target and the distance/zoom.
 *
 * Bounds come from the scene for MODELS (their groups carry `userData.modelId`; a hidden one is skipped)
 * and from the document for FIXTURES (effectivePos) — not from the fixture InstancedMeshes, whose cached
 * bounding boxes are not refreshed when a fixture moves.
 */
export const FrameController: React.FC<{ fixtures: Fixture[]; selectedFixtureIds: string[]; selectedModelId: string | null; view: ViewKind }> = (p) => {
  const get = useThree((s) => s.get);
  const props = useRef(p); props.current = p;
  useEffect(() => registerFrameHandler((t: FrameTarget) => {
    const { camera, controls, size, scene } = get();
    const ctl = controls as unknown as Controls | null;
    if (!ctl?.target) return;
    const { fixtures, selectedFixtureIds, selectedModelId, view } = props.current;
    let box = boundsOf(scene, fixtures, t === 'selected' ? { fixtureIds: selectedFixtureIds, modelId: selectedModelId } : null);
    if (box.isEmpty() && t === 'selected') box = boundsOf(scene, fixtures, null); // nothing selected → everything
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center;
    if (isOrtho(view) && (camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const cam = camera as THREE.OrthographicCamera;
      placeOrtho(cam, view, center);
      cam.zoom = orthoFitZoom(sphere.radius, size.width, size.height);
      cam.updateProjectionMatrix();
    } else {
      const cam = camera as THREE.PerspectiveCamera;
      if (!cam.isPerspectiveCamera) return;
      // Keep looking from the same direction; only the distance changes.
      const dir = _v.copy(cam.position).sub(ctl.target);
      if (dir.lengthSq() < 1e-12) dir.set(0, 0.4, 1);
      dir.normalize();
      // The camera's OWN aspect: in four views it is the Perspective pane's, not the canvas's.
      const dist = perspFitDistance(sphere.radius, cam.fov, cam.aspect > 0 ? cam.aspect : 1);
      cam.position.copy(center).addScaledVector(dir, dist);
    }
    ctl.target.copy(center);
    ctl.update();
  }), [get]);
  return null;
};

function boundsOf(scene: THREE.Object3D, fixtures: Fixture[], only: { fixtureIds: string[]; modelId: string | null } | null): THREE.Box3 {
  const box = new THREE.Box3();
  const ids = only ? new Set(only.fixtureIds) : null;
  for (const f of fixtures) if (!ids || ids.has(f.id)) box.expandByPoint(effectivePos(f));
  scene.traverseVisible((o) => {
    const id = o.userData?.modelId as string | undefined;
    if (!id || (only && id !== only.modelId)) return;
    box.expandByObject(o);
  });
  return box;
}

// ── DISPLAY MODE (3d-workbench Phase 1, item 6) ───────────────────────────────────────────────────────
// Wireframe / X-ray apply to the VENUE only: every mesh under a group tagged `userData.modelId` (models
// and screen planes). Fixtures, LEDs and beams are untouched — seeing the rig through the room is the point.
//
// WHY A WALK OVER THE SCENE AND NOT A PROP ON EACH MODEL: a model's materials are SWAPPED at run time
// (screen content, projected mapping — assignContentMaterials) and clones of one GLB SHARE theirs. So the
// controller adjusts whatever material is on a mesh right now, remembers each material's own settings the
// first time it touches it, and puts every one back exactly on the way to Shaded. It walks only while a
// non-shaded mode is on (a newly swapped material is caught the next frame); in Shaded it costs nothing.
type Saved = { wireframe: boolean; transparent: boolean; opacity: number; depthWrite: boolean };
const XRAY_OPACITY = 0.22;

export const DisplayModeController: React.FC<{ mode: DisplayMode }> = ({ mode }) => {
  const saved = useRef(new Map<THREE.Material, Saved>());
  const scene = useThree((s) => s.scene);
  const restore = () => {
    for (const [m, o] of saved.current) {
      const w = m as THREE.Material & { wireframe?: boolean };
      if ('wireframe' in w) w.wireframe = o.wireframe;
      m.transparent = o.transparent; m.opacity = o.opacity; m.depthWrite = o.depthWrite;
      m.needsUpdate = true;
    }
    saved.current.clear();
  };
  // Leaving a mode, or the view going away: every touched material back as it was.
  useEffect(() => restore, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(() => {
    if (mode === 'shaded' || mode === 'rendered') return;   // Rendered keeps the materials; RenderedMode.tsx adds the look
    scene.traverse((o) => {
      if (!o.userData?.modelId) return;
      o.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (!m || saved.current.has(m)) continue;
          const w = m as THREE.Material & { wireframe?: boolean };
          saved.current.set(m, { wireframe: !!w.wireframe, transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
          if (mode === 'wireframe') { if ('wireframe' in w) w.wireframe = true; }
          else { m.transparent = true; m.opacity = Math.min(m.opacity, XRAY_OPACITY); m.depthWrite = false; }
          m.needsUpdate = true;
        }
      });
    });
  });
  return null;
};
