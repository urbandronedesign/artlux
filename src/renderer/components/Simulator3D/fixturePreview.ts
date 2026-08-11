import type { Fixture, Vec3, Euler3 } from '../../types';

// WHAT THE GIZMO HAS RIGHT NOW, before anything is committed.
//
// The 3D transform gizmo writes the document ONCE, on release. That is not an optimisation anyone can
// give up: App owns all state, so pushing the fixtures array on every pointer move re-renders the whole
// editor at pointer rate and re-runs computeLedPositions over EVERY fixture per move — the same rule
// `verify:invariants` already enforces for Stage drags.
//
// The cost of it was that the operator dragged a handle and nothing moved until they let go, which
// makes placing anything precisely impossible. So the drag is published HERE instead: a module
// singleton holding "these fixtures are currently at these transforms", which the 3D renderers read in
// their own useFrame and apply straight to instance matrices. No React state, no document write, no
// re-render — the picture follows the handle and the document still changes exactly once.
//
// THIS FILE MUST NOT IMPORT REACT. It is a pointer-rate channel, in the shape vertexSnap/dmxSignal
// already use; the moment it grows a hook it becomes a re-render at pointer rate, which is the thing it
// exists to avoid. Guarded by verify:invariants.

export interface FixtureTransform {
  position3D?: Vec3;
  rotation3D?: Euler3;
  /** Per-axis, in the fixture's own frame — what the gizmo writes now. */
  scaleXYZ?: [number, number, number];
  /** Legacy uniform. Still accepted so an older caller (or an older project) keeps working. */
  scale3D?: number;
}

/** What the gesture IS, in the operator's terms — the readout's input. Metres and degrees. */
export interface GestureSummary {
  mode: 'translate' | 'rotate' | 'scale';
  count: number;
  /** Where the gizmo sits now (world metres) — "where is it", next to "how far has it come". */
  at: { x: number; y: number; z: number };
  delta: { x: number; y: number; z: number };
  /** Degrees turned about each axis. */
  turn: { pitch: number; yaw: number; roll: number };
  /** Scale factor per axis. For a multi-selection this is the SPREAD, not a resize. */
  factor: { x: number; y: number; z: number };
}

// Consumers compare this against the last value they applied, so an unchanged frame costs one integer
// compare. Bumped on CLEAR as well as on write — the clearing frame is what puts the committed
// transforms back on screen if a consumer wrote a pose it no longer owns.
let rev = 0;
let map: Map<string, FixtureTransform> | null = null;
// Does the RIG follow the handle, or only the readout? Decided once per gesture (Preferences ▸ GPU
// rendering ▸ Live gizmo preview) and held here rather than at the publisher, so that turning the
// drawing off never also turns the NUMBERS off — reading the drag is the cheaper half and the half
// that makes it precise.
let visual = true;
let gesture: GestureSummary | null = null;
// The readout lives in the viewport header, outside the Canvas, so it has no frame loop to poll from.
// It is the ONLY subscriber; every in-scene consumer polls by revision instead.
const subs = new Set<() => void>();

/** Start a gesture. `drawIt` = whether the fixtures themselves should follow (see `visual`). */
export function beginPreview(drawIt: boolean): void {
  visual = drawIt;
}

/** Publish the live gesture. Called from the gizmo's `objectChange`, i.e. at pointer rate. */
export function setPreview(updates: Array<{ id: string } & FixtureTransform>, summary?: GestureSummary): void {
  const next = new Map<string, FixtureTransform>();
  for (const u of updates) next.set(u.id, u);
  map = next;
  gesture = summary ?? null;
  rev++;
  subs.forEach((f) => f());
}

/** The gesture ended (committed or abandoned). The committed document is the truth again. */
export function clearPreview(): void {
  if (!map && !gesture) return;
  map = null;
  gesture = null;
  rev++;
  subs.forEach((f) => f());
}

/** What the drag currently amounts to, or null between gestures. Drives the header readout. */
export function getGesture(): GestureSummary | null { return gesture; }

/** For the readout only — everything inside the Canvas polls `previewRev()` in its own frame loop. */
export function subscribeGesture(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export function previewRev(): number { return rev; }
// Both answer for the DRAWING, so both are false when the preview is off — which is what makes the
// pref one gate in one file instead of four components each remembering to ask.
export function isPreviewing(): boolean { return visual && map !== null; }
export function hasPreview(id: string): boolean { return visual && (map?.has(id) ?? false); }

/**
 * The fixture as it should be DRAWN this frame: the committed record when nothing is being dragged,
 * and the same record with the live transform merged over it when it is.
 *
 * Returns the SAME OBJECT when there is no override, so the common case allocates nothing — the frame
 * loop calls this once per fixture per frame.
 */
export function livePose(f: Fixture): Fixture {
  const t = map?.get(f.id);
  if (!t) return f;
  return {
    ...f,
    position3D: t.position3D ?? f.position3D,
    rotation3D: t.rotation3D ?? f.rotation3D,
    // A live per-axis scale must SHADOW the committed uniform one, not sit beside it — effectiveScale3
    // prefers scaleXYZ, so leaving the old scale3D in place would be harmless here but is dropped
    // anyway to keep the previewed fixture exactly what the commit will produce.
    scaleXYZ: t.scaleXYZ ?? f.scaleXYZ,
    scale3D: t.scaleXYZ ? undefined : (t.scale3D ?? f.scale3D),
  };
}

// HOW MANY LEDs A PREVIEW IS ALLOWED TO MOVE PER FRAME.
//
// Previewing means recomputing the dragged fixtures' LED positions every frame. A row of bars is a few
// hundred pixels and free; someone dragging their entire 30k-pixel rig as one selection is not, and the
// preview would then cost exactly what the deferred commit was protecting. Above this the LED preview
// is skipped and only the BODIES follow the handle — one instance per fixture, always cheap, and still
// enough to see where the selection is going. It reads as a deliberate simplification rather than as a
// stutter, which is the right failure.
export const PREVIEW_LED_BUDGET = 20000;
