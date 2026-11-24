import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { Fixture } from '../../types';
import { computeLedPositions, effectivePos } from '../../services/led3dLayout';
import { isLight } from '../../services/fixtureKind';

// E4a — THE ENGINE'S 3D VIEW, editor half (engine half: engine/artlux-engine/src/view3d.rs; plans/
// native-engine.md E4, plans/3d-workbench.md Phase 4).
//
// The detached 3D view is drawn by the NATIVE ENGINE in its own window — any screen, its own swapchain,
// nothing rebuilt when it moves (a GPU viewport cannot leave the editor window, native-engine.md §9a). The
// engine already has every surface's picture and the LED colours; what it does not have is WHERE THINGS
// ARE in 3D. This sends exactly that, read off the editor's own three.js scene — so a model's recentre, a
// gizmo drag's commit, a .blend reload all reach the engine as the world matrices the editor itself draws
// with, and nothing is re-derived on the other side:
//   - models: each venue GLB's file and the world matrix of its recentred root (ModelObject tags it
//     `userData.enginePath`), each screen's quad and the surface it shows (PlaneObject `enginePlane`);
//   - leds: every pixel fixture's LED world positions (led3dLayout.computeLedPositions — the editor's
//     InstancedLeds positions), in the order of their texels in the engine's composed buffer;
//   - lights: each light fixture's position (a housing; beams come later).
// Sent only while the view is open, at most four times a second, and only when it changed (one string
// compare). Pointer-rate work stays out of React: this is a timer, not state.

const PERIOD_MS = 250;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

function buildScene(scene: THREE.Scene, fixtures: Fixture[]): string {
  const models: unknown[] = [];
  scene.updateMatrixWorld();
  scene.traverse((o) => {
    if (!o.userData?.modelId || !o.visible) return;
    const plane = o.userData.enginePlane as { surfaceId: string | null } | undefined;
    if (plane) {
      const mesh = o.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
      if (!mesh) return;
      const g = mesh.geometry as THREE.PlaneGeometry;
      models.push({ id: o.userData.modelId, kind: 'plane', surfaceId: plane.surfaceId, w: g.parameters?.width ?? 16 / 9, h: g.parameters?.height ?? 1, matrix: mesh.matrixWorld.elements.map(r4) });
      return;
    }
    o.traverse((c) => {
      if (typeof c.userData?.enginePath === 'string' && c.userData.enginePath) {
        models.push({ id: o.userData.modelId, kind: 'glb', path: c.userData.enginePath, matrix: c.matrixWorld.elements.map(r4) });
      }
    });
  });
  const leds = fixtures.filter((f) => !isLight(f) && (f.ledCount | 0) > 0).map((f) => ({ id: f.id, pos: Array.from(computeLedPositions(f), r4) }));
  const lights = fixtures.filter((f) => isLight(f)).map((f) => { const p = effectivePos(f); return [r4(p.x), r4(p.y), r4(p.z)]; });
  return JSON.stringify({ models, leds, lights });
}

/** Mounted inside the Canvas while the engine's 3D view is open: keeps the engine's scene current. */
export const EngineViewLink: React.FC<{ fixtures: Fixture[] }> = ({ fixtures }) => {
  const get = useThree((s) => s.get);
  const fx = useRef(fixtures); fx.current = fixtures;
  useEffect(() => {
    let last = '';
    const send = () => {
      const json = buildScene(get().scene, fx.current);
      if (json !== last) { last = json; window.artlux?.nativeEngineScene3d?.(json); }
    };
    send();
    const t = setInterval(send, PERIOD_MS);
    return () => clearInterval(t);
  }, [get]);
  return null;
};

/** Where the editor is looking from — the engine's view opens there. */
export function editorCamera(camera: THREE.Camera, controls: unknown): { position: number[]; target: number[]; fov: number } {
  const t = (controls as { target?: THREE.Vector3 } | null)?.target ?? new THREE.Vector3();
  const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).fov : 50;
  return { position: camera.position.toArray(), target: t.toArray(), fov };
}

// The editor camera, for the header button (outside the Canvas). Module state: one Simulator3D (guarded).
let cameraNow: (() => { position: number[]; target: number[]; fov: number }) | null = null;
export function currentEditorCamera() { return cameraNow?.() ?? null; }
/** Always mounted inside the Canvas: lets the header read where the editor is looking from. */
export const EngineCameraBridge: React.FC = () => {
  const get = useThree((s) => s.get);
  useEffect(() => {
    cameraNow = () => { const { camera, controls } = get(); return editorCamera(camera, controls); };
    return () => { cameraNow = null; };
  }, [get]);
  return null;
};
