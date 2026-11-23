import { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { htmlPosition } from './htmlPosition';

// GRABBING A GIZMO NEVER MOVES THE CAMERA (owner, 2026-11-23: "when I move, scale or rotate, the cam moves").
//
// drei's TransformControls turns the default controls off on 'dragging-changed' — but that fires from the
// gizmo's OWN pointerdown listener, and OrbitControls listens to the same press. Whichever registered first
// wins, and with the orbit first it has already started a rotate (plus its damping tail) by the time it is
// switched off. In four views it was worse: MultiView re-enables the orbit on every pointermove (that is how
// it holds orbit off over the flat panes), which undid the gizmo's switch-off for the whole drag.
//
// So: a CAPTURE-phase pointerdown on the window — before any listener on the canvas — asks every mounted
// gizmo whether a handle is under the pointer (TransformControls keeps `axis` up to date on hover). If one
// is, the orbit is off before it ever sees the press, and stays off until the button comes up; MultiView
// reads gizmoHeld() and leaves it alone meanwhile.
//
// AND THE CLICK THAT ENDS IT IS SWALLOWED. The browser follows the release with a `click`, and r3f fires
// onClick on whatever the pointer is over at both ends — so a drag that ended over another object
// SELECTED that object (measured in the Front pane: dragging the wall screen's base picked the floor
// projection, which lies edge-on along the whole floor line there). A press that grabbed a handle is a
// gizmo gesture, never a pick: its click is stopped at the window before r3f can see it.
type Gizmo = THREE.Object3D & { isTransformControls?: boolean; axis?: string | null; enabled?: boolean; dragging?: boolean };

let held = false;
/** True from a press on a gizmo handle until its release — nothing may turn the orbit back on meanwhile. */
export function gizmoHeld(): boolean { return held; }

export function GizmoOrbitGuard(): null {
  const get = useThree((s) => s.get);
  useEffect(() => {
    let saved: boolean | null = null;
    let swallowClick = false;
    const onDown = (e: PointerEvent) => {
      const { scene, gl, events, controls } = get();
      const host = (events.connected as HTMLElement | undefined) ?? gl.domElement;
      swallowClick = false;
      if (!(e.target instanceof Node) || !(host === e.target || host.contains(e.target) || gl.domElement === e.target)) return;
      let onHandle = false;
      scene.traverse((o) => {
        const g = o as Gizmo;
        if (!onHandle && g.isTransformControls && g.enabled !== false && g.axis) onHandle = true;
      });
      swallowClick = onHandle;   // set per press (cleared above for any other) — one press, one click
      if (!onHandle) return;
      held = true;
      const k = controls as unknown as { enabled?: boolean } | null;
      if (k && 'enabled' in k) { saved = k.enabled ?? true; k.enabled = false; }
    };
    const onUp = () => {
      if (!held) return;
      held = false;
      const k = get().controls as unknown as { enabled?: boolean } | null;
      if (k && 'enabled' in k && saved !== null) k.enabled = saved;
      saved = null;
    };
    // DIAGNOSTIC (read-only, window-guarded like __artluxView3d): where each gizmo's centre is on the
    // canvas (in four views, inside the Perspective pane), so a test can grab one and check the camera stayed put.
    const w = window as unknown as Record<string, unknown>;
    w.__artluxGizmos = () => {
      const { scene, camera, gl } = get();
      const r = gl.domElement.getBoundingClientRect();
      const out: { x: number; y: number; held: boolean; axis: string | null; enabled: boolean }[] = [];
      scene.traverse((o) => {
        const g = o as Gizmo & { object?: THREE.Object3D };
        if (!g.isTransformControls || !g.object) return;
        const [x, y] = htmlPosition(g.object, camera, { width: r.width, height: r.height });   // pane-aware
        out.push({ x: r.left + x, y: r.top + y, held, axis: g.axis ?? null, enabled: g.enabled !== false });
      });
      return out;
    };
    const onClick = (e: MouseEvent) => { if (swallowClick) { swallowClick = false; e.stopPropagation(); } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      held = false;
      delete w.__artluxGizmos;
    };
  }, [get]);
  return null;
}
