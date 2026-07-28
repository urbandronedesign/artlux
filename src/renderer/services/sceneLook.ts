import type { Fixture } from '../types';

// ── WHAT PART OF A FIXTURE IS "THE LOOK"? — THE ONE PLACE THAT ANSWERS IT ────────────────────
//
// A scene is a LOOK SNAPSHOT. It captures the whole `Fixture[]` because that is the cheapest thing
// to capture — but a Fixture carries two unrelated kinds of data:
//
//   · THE LOOK — the mapping rect it samples through, its effect params, its authored DMX values.
//     This is what an operator means by "store this scene", and it is what a GO must restore.
//   · THE RIG  — its identity, its profile, its patch (universe/address/controller), its wiring
//     (ledCount, colour order, ledmap) and where it physically hangs in the venue. NONE of that
//     changes because the lighting changed. It is the same class of data as `trackingZones`, which
//     was stripped out of the snapshot for exactly this reason (see buildSceneSnapshot).
//
// Restoring the array wholesale therefore made a recall REPLACE THE RIG with the rig as it stood
// when the scene was captured. Reproduced in the running app before this existed: a project holding
// two heads, whose initial state was bound to a scene captured when there was one, lost Head 2
// within nine seconds of opening — and Head 1's start address reverted 1 → 100, so what was left
// was patched at the old addresses. Nothing was logged and nothing looked wrong; the state machine
// simply did what "recall the initial state's scene" has always meant.
//
// The reach is bigger than it sounds, because a recall is not a rare operator action: the FSM
// recalls on entering EVERY state, including its initial one on load. So the rule was "add a
// fixture, re-patch, or move a head — and the next GO undoes it", which is every rig change made
// after the first scene was stored.
//
// ⚠ ALLOW-LIST, NOT DENY-LIST, AND THAT DIRECTION IS THE POINT. A field added to `Fixture` later
// defaults to RIG — the safe side. Forgetting to list a genuinely-look field means "my scene does
// not restore X", which is visible and reported; forgetting to EXCLUDE a rig field means a silent
// revert on GO in front of an audience, which is the bug this file exists to end.
//
// The list is derived, not invented: it is `FIXTURE_FADEABLE` in paramPath.ts (what the app already
// crossfades between two looks) plus the discrete look fields that snap rather than fade, plus the
// authored `dmx` values a scene exists to hold for moving heads.
const FIXTURE_LOOK_KEYS = [
  // The mapping rect — for a pixel fixture this is the sampling window, and the fade engine already
  // animates it between two scenes (FIXTURE_FADEABLE). A light fixture is not on the 2D canvas.
  'x', 'y', 'width', 'height', 'rotation',
  // Which surface it samples. It pairs with `scene.surfaces`, which a recall restores wholesale.
  'surfaceId',
  // Per-fixture standalone effect.
  'source', 'effectId', 'paletteId', 'speed', 'intensity', 'segments',
  // Authored channel values — the look of a moving head, and the reason `Cue`/`Scene` can hold one.
  'dmx',
] as const satisfies ReadonlyArray<keyof Fixture>;

/**
 * Fold a scene's stored fixtures onto the LIVE rig.
 *
 * Membership is the live rig's: a fixture patched since the scene was captured survives the recall,
 * and one deleted since is not resurrected by it. Only the look fields above travel.
 *
 * `colorData` is cleared for the same reason capture strips it — it is the live DMX frame, not a
 * stored value, and the next frame overwrites it anyway.
 */
export function mergeFixtureLook(live: Fixture[], stored: Fixture[] | undefined): Fixture[] {
  if (!stored?.length) return live.map((f) => ({ ...f, colorData: [] }));
  const byId = new Map(stored.map((f) => [f.id, f]));
  return live.map((f) => {
    const snap = byId.get(f.id);
    if (!snap) return { ...f, colorData: [] };   // patched after this scene was stored — leave it alone
    const next: Fixture = { ...f, colorData: [] };
    for (const k of FIXTURE_LOOK_KEYS) {
      // A field the snapshot does not carry expresses no opinion — keep the live value rather than
      // writing `undefined` over it (an old scene predates half these fields).
      if (snap[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = snap[k];
    }
    return next;
  });
}
