import type { ThreeEvent } from '@react-three/fiber';

// Who wins when two things are under the pointer.
//
// The venue screens are big flat planes and the LEDs are 12mm spheres sitting ON them, so a screen is
// almost always NEARER the camera than the fixture drawn over it. r3f dispatches nearest-first, and the
// screen/model handlers call stopPropagation() — so a click aimed squarely at a glowing LED selected
// the screen behind it and the fixture was, in practice, unpickable. Measured before this existed: of
// 649 probe clicks across the LED bands, 648 selected a screen and exactly one hit a fixture (in the
// sliver where the strip overhangs the screen edge).
//
// The rule: THE MORE SPECIFIC TARGET WINS. A screen is a backdrop and covers most of the view; a
// fixture is the thing you were aiming at. So a model/plane yields when an LED is anywhere in the same
// intersection list — it simply does not stopPropagation, and r3f carries the click on to the LED mesh
// behind it. Clicking a screen where there is no LED (the overwhelming majority of its area) is
// unaffected.

/** Marks the LED instanced mesh in `userData` so hit-tests can recognise it without importing it. */
export const LED_PICK = 'artluxLedPick';

/** True when the LED mesh is among the things under the pointer for this event. */
export function ledUnderPointer(e: ThreeEvent<MouseEvent>): boolean {
  const hits = e.intersections;
  if (!hits || hits.length === 0) return false;
  return hits.some((i) => (i.object as { userData?: Record<string, unknown> })?.userData?.[LED_PICK] === true);
}
