// ARMING A CLICK-TO-PLACE IN THE 3D SCENE.
//
// A light fixture lives in the room, not on the 2D canvas, so "where is it" is answered by pointing
// at the venue — the way you would place one in any 3D tool. This holds the one bit of state that
// question needs: which fixture the next click in the scene should move.
//
// A RENDER-FREE SINGLETON, modelled on livePreview/selection: arming must not re-render App (the
// scene is mid-frame, and the 3D canvas is the most expensive thing on screen to disturb), and the
// state is EPHEMERAL — it never enters the document, never persists, and is dropped on project load.
//
// ── WHY THE FIXTURE ALREADY EXISTS WHEN THIS ARMS ────────────────────────────────────────────
// The obvious design is "pick a profile, then click to create". It is the wrong one here: it invents
// a half-created fixture that is in no list, holds no patch, and is lost if the operator changes
// context, presses Escape, or simply forgets. So the fixture is created NORMALLY first — patched,
// listed, selected, spawned on a spread row (led3dDefaults.spawnPosition3D) — and this only offers
// to MOVE it. Never clicking costs nothing; the light is already a real, addressable fixture sitting
// somewhere sensible.

export interface PlacementRequest {
  /** The fixture the next scene click moves. */
  fixtureId: string;
  /** For the on-screen hint — what the operator is placing. */
  label: string;
}

type Listener = (req: PlacementRequest | null) => void;

let current: PlacementRequest | null = null;
const subs = new Set<Listener>();

function notify(): void {
  // Isolate subscribers: one of them is the 3D scene, and a throw propagating out of a click handler
  // there would take the canvas down mid-show. Same rule services/selection.ts follows.
  subs.forEach((cb) => {
    try { cb(current); } catch (e) { console.error('[placement] subscriber threw', e); }
  });
}

/** Arm: the next click in the 3D scene moves this fixture. Re-arming replaces the target. */
export function arm(req: PlacementRequest): void {
  current = req;
  notify();
}

/** Cancel without placing (Escape, a context switch, a project load). Idempotent. */
export function disarm(): void {
  if (!current) return;
  current = null;
  notify();
}

/**
 * Take the armed request and disarm in one step.
 *
 * One step deliberately: the click handler must not be able to place twice, and a caller that read
 * then cleared would leave a window where a second click during the same frame places again.
 */
export function consume(): PlacementRequest | null {
  const req = current;
  if (req) { current = null; notify(); }
  return req;
}

export function get(): PlacementRequest | null { return current; }

export function subscribe(cb: Listener): () => void {
  subs.add(cb);
  try { cb(current); } catch (e) { console.error('[placement] subscriber threw', e); }
  return () => { subs.delete(cb); };
}
