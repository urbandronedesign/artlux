import type { ColorValue } from '../types';

// The live COLOUR-LANE layer: what each fixture's colour lane is currently asking for.
//
// The third of the trio — automationOverlay addresses parameters by dot-path, lightingOverlay
// addresses a group by role, and this one carries ONE COLOUR PER FIXTURE. It is deliberately not
// either of the others:
//
//   · not automationOverlay, because a colour is not a number and there is no single path it could
//     be laid over the StateView at (it becomes three or four channel values, chosen per fixture);
//   · not lightingOverlay, because that is role space and the whole point of a colour lane is that
//     the roles are not decided until the packer knows WHICH FIXTURE is asking. Publishing solved
//     roles here would mean solving without the profile, which is the thing that cannot be done.
//
// So the value stays a colour until the last possible moment — the packer's role override, which is
// the one place that has the fixture, its profile and its mode in hand. See services/colorEngine.
//
// ── PRECEDENCE ───────────────────────────────────────────────────────────────────────────────
//   profile default < authored Fixture.dmx < lighting clip < pose cue < COLOUR LANE
//                   < automation lane < live override
//
// A colour lane sits ABOVE a lighting clip and BELOW a per-channel automation lane, and both halves
// are deliberate. It beats a clip because it is a lane — the app's oldest precedence rule is "a lane
// always wins", and an operator who draws a colour on a fixture means it more than a clip that
// happens to be running. It loses to a per-channel lane because that is MORE SPECIFIC: someone who
// drew a Blue curve on this exact channel asked for something narrower than "make this fixture
// cyan", and the narrower instruction wins. That is also why the colour row has to SAY when a
// channel lane is shadowing it — see trap A in plans/colour-track.md.

let current = new Map<string, ColorValue>();
/** Rebuilt each frame, then swapped in — so readers never observe a half-written frame. */
let building = new Map<string, ColorValue>();
let active = false;

/** Start a frame. Reuses the previous frame's map to avoid per-frame allocation. */
export function begin(): void {
  const swap = building;
  building = current;
  current = swap;
  building.clear();
}

/**
 * Contribute one fixture's colour. LTP — latest wins, no merging.
 *
 * There is no HTP here and there must not be: "highest takes precedence" is a rule about
 * INTENSITIES, where two sources both raising a level is a thing that composes. Two sources asking
 * for different colours do not compose — averaging red and green gives a yellow neither asked for,
 * and taking "the higher colour" is not a sentence that means anything.
 */
export function set(fixtureId: string, value: ColorValue): void {
  building.set(fixtureId, value);
  active = true;
}

/** Finish a frame: what was built becomes what is read. */
export function commit(): void {
  const swap = current;
  current = building;
  building = swap;
  active = current.size > 0;
}

/** The colour this fixture's lane is asking for, if any. */
export function get(fixtureId: string): ColorValue | undefined {
  return current.get(fixtureId);
}

/** True when any lane is driving anything — lets the packer skip the lookup entirely. */
export function isActive(): boolean { return active; }

/** Drop everything (project load, transport stop). */
export function clear(): void {
  current.clear();
  building.clear();
  active = false;
}
