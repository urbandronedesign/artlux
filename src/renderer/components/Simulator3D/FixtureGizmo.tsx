import React, { useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { Fixture } from '../../types';
import { effectivePos, effectiveRot, effectiveScale } from '../../services/led3dLayout';
import { gizmoDelta, type GizmoBasis, type GizmoStart } from './gizmoDelta';
import { setPreview, clearPreview, type FixtureTransform } from './fixturePreview';
import { getLivePreview } from '../../services/scene3dQuality';

export type { FixtureTransform } from './fixturePreview';

interface Props {
  /** The whole selection. Empty ⇒ no gizmo. */
  fixtures: Fixture[];
  mode: 'translate' | 'rotate' | 'scale';
  /** Handle orientation: the room's axes, or the active fixture's own. Never the pivot — see below. */
  space?: 'world' | 'local';
  /** The fixture the handles take their orientation from in 'local'. Defaults to the first selected. */
  activeId?: string | null;
  onRecordHistory: () => void;
  /** One call per gesture, carrying every fixture the drag moved. */
  onCommit: (updates: Array<{ id: string } & FixtureTransform>) => void;
}

// The 3D transform gizmo. It moves the WHOLE SELECTION, not just the primary fixture.
//
// It used to take one `Fixture` and commit one id, while the shell handed it only the primary of a
// multi-selection — so an operator could box-select ten heads, group them, see all ten highlighted…
// and then had to move them one at a time. Rigs are built in rows and arcs; that is the wrong unit
// of work.
//
// The maths of a drag lives in gizmoDelta.ts, because it is needed TWICE: once per frame to draw the
// live preview, and once on release to commit. See that file for what a gesture means.
//
// WHAT IS PUBLISHED AND WHAT IS WRITTEN. Every `objectChange` publishes the gesture to the preview
// channel — the 3D renderers pick it up in their own frame loop and move the LEDs and bodies under the
// handle. Nothing touches React or the document until `mouseUp`, which commits once. So the picture is
// live and the document still changes exactly one time per gesture, i.e. one undo step and one
// re-render. See fixturePreview.ts for why that split is not negotiable.
export const FixtureGizmo: React.FC<Props> = ({ fixtures, mode, space = 'world', activeId, onRecordHistory, onCommit }) => {
  const anchor = useMemo(() => new THREE.Group(), []);
  const controls = useRef<any>(null);

  // The selection as it was when the drag STARTED. Deltas are applied to this, never to the live
  // fixtures: reading committed state mid-drag would compound each frame's delta into the next.
  const startRef = useRef<GizmoStart[]>([]);
  // The ANCHOR's own basis at grab time — the other half of every subtraction (see gizmoDelta).
  const basisRef = useRef<GizmoBasis>({
    centroid: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1),
  });
  const dragging = useRef(false);
  const moved = useRef(false);
  // Read once per gesture rather than per frame: toggling the preference mid-drag would change what a
  // gesture means half way through it.
  const previewing = useRef(false);

  const ids = fixtures.map((f) => f.id).join(',');

  // Park the anchor on the selection centroid whenever the selection (or its transforms) changes.
  // Skipped while dragging — TransformControls owns the anchor then, and resetting it would fight
  // the pointer.
  //
  // THE PIVOT IS ALWAYS THE CENTROID; only the AXES change. That separation is what makes "Object"
  // safe to leave on: switching it can never move where a rotation turns about or where a spread
  // spreads from, so it is a change of grip and not a change of gesture. (Blender calls this median
  // point + active orientation, and it is the right default for a row of bars on an angled truss.)
  useEffect(() => {
    if (!fixtures.length || dragging.current) return;
    const c = new THREE.Vector3();
    for (const f of fixtures) c.add(effectivePos(f));
    c.divideScalar(fixtures.length);
    anchor.position.copy(c);
    // In 'local' the handles follow the ACTIVE fixture — the one the operator clicked last, which is
    // the one they are thinking in the frame of. In 'world' the anchor keeps exactly what it always
    // had: a lone fixture's own rotation (three forces SCALE handles to local regardless, so this is
    // what has always aligned them to the bar), and identity for a multi-selection, which has no
    // shared orientation to speak of. So 'world' is unchanged, to the frame.
    const active = (activeId && fixtures.find((f) => f.id === activeId)) || fixtures[0];
    if (space === 'local') anchor.rotation.copy(effectiveRot(active));
    else if (fixtures.length === 1) anchor.rotation.copy(effectiveRot(fixtures[0]));
    else anchor.rotation.set(0, 0, 0);
    anchor.scale.setScalar(1);
  }, [anchor, fixtures, ids, space, activeId]);

  // A preview that outlives its gesture would freeze the rig at wherever the handle was. Unmounting
  // is one of the ways a gesture ends (the selection is cleared, the model gizmo takes over, the
  // context switches away), and none of them fire `mouseUp`.
  useEffect(() => clearPreview, []);

  useEffect(() => {
    const c = controls.current;
    if (!c || !fixtures.length) return;

    const onDown = () => {
      moved.current = false;
      dragging.current = true;
      previewing.current = getLivePreview();
      // Snapshot the selection AND the anchor the deltas will be measured from.
      basisRef.current = {
        centroid: anchor.position.clone(),
        quat: anchor.quaternion.clone(),
        scale: anchor.scale.clone(),
      };
      startRef.current = fixtures.map((f) => ({
        id: f.id,
        pos: effectivePos(f),
        rot: effectiveRot(f),
        scale: effectiveScale(f),
      }));
    };

    // Record history on the first real movement, not on grab: TransformControls fires mouseDown even
    // for a click that never drags, and recording there pushed a junk undo entry per click.
    const onChange = () => {
      if (!moved.current) { moved.current = true; onRecordHistory(); }
      // The live picture. No state, no document — see fixturePreview.ts.
      if (previewing.current) setPreview(gizmoDelta(startRef.current, basisRef.current, anchor, mode));
    };

    const onUp = () => {
      dragging.current = false;
      clearPreview();
      if (!moved.current) return; // a pure click on a handle — nothing to record or commit
      onCommit(gizmoDelta(startRef.current, basisRef.current, anchor, mode));
      // Re-park the anchor for the next gesture: the fixtures have moved under it, so the effect above
      // re-centres it on the new centroid (and re-aligns it for a single fixture). Zeroing rotation and
      // scale here keeps the HANDLES where the operator expects to find them — the next drag's maths no
      // longer depends on it, because the deltas are measured against whatever the grab found.
      anchor.rotation.set(0, 0, 0);
      anchor.scale.setScalar(1);
    };

    c.addEventListener('mouseDown', onDown);
    c.addEventListener('objectChange', onChange);
    c.addEventListener('mouseUp', onUp);
    return () => {
      c.removeEventListener('mouseDown', onDown);
      c.removeEventListener('objectChange', onChange);
      c.removeEventListener('mouseUp', onUp);
    };
  }, [anchor, fixtures, ids, mode, onCommit, onRecordHistory]);

  if (!fixtures.length) return null;

  return (
    <>
      <primitive object={anchor} />
      {/* `space` only orients the HANDLES (three: TransformControls.js:1538 — the gizmo quaternion is
          the object's in local and identity in world). The commit is unaffected either way, because a
          gesture is read as a delta against whatever basis the grab found — which is exactly why that
          had to be fixed before this switch could exist. */}
      <TransformControls ref={controls} object={anchor} mode={mode} space={space} size={0.8} />
    </>
  );
};
