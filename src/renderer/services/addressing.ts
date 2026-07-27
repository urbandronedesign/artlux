import type {
  Fixture, Controller, FixtureKind, OutputProtocol, PatchPolicy, FixtureProfile, ProfileMode,
} from '../types';
import { fixtureKind, isLight } from './fixtureKind';

// Automatic DMX patch (S5). Packs each fixture's channels sequentially per
// controller: starting at the controller's startUniverse + channel 1, consuming
// ledCount × channelsPerPixel channels and wrapping at the 512-channel boundary
// (a fixture may span universes — the Stage packer handles that). Fixtures with
// `patchLocked` keep their manual universe/startAddress. With `reserveLockedRanges`
// on, auto fixtures pack AROUND locked ranges (default off = today's behaviour,
// where locked rows are skipped but their channels are NOT reserved). Fixtures with
// no/invalid controller share one implicit bucket.

const GLOBAL = '__global__';

// ── DMX footprint — THE ONE PLACE that answers "how many channels does this fixture occupy?" ────
//
// This used to be `f.ledCount * (f.channelsPerPixel ?? 4)`, open-coded in SEVEN places: three here,
// the DMX-in universe span in Stage, two in the DMX monitor, one in the fixture editor and one in
// the routing modal. That was survivable only while there was exactly one kind of fixture.
//
// A PROFILED fixture's footprint is its MODE's, and the pixel formula gives the wrong answer for
// it. Miss a single site and the failure is silent and evil: auto-patch overlaps two fixtures, or
// the collision detector disagrees with what the packer actually writes, and the symptom is "half
// my rig is dead" at a load-in. addressing.ts already carries the rule that IT and Stage must never
// drift on destination resolution; this is the same rule for span. `verify:invariants` enforces
// that no file outside this one multiplies `ledCount`.
export type ProfileMap = ReadonlyMap<string, FixtureProfile>;

/** The mode a fixture uses: its named one, else the profile's first. */
export function resolveMode(profile: FixtureProfile, key?: string): ProfileMode | undefined {
  if (key) {
    const named = profile.modes.find((m) => m.key === key);
    if (named) return named;
  }
  return profile.modes[0];
}

/**
 * Channels this fixture occupies, starting at `startAddress`.
 *
 * An UNRESOLVED profile (a `profileId` we have no profile for) deliberately returns 0 rather than
 * falling back to the pixel formula. Falling back would quietly hand back a plausible-but-wrong
 * span and mis-patch the whole rig around it; 0 makes the fixture claim nothing, which the UI can
 * see and report. Projects embed the profiles they use precisely so this does not happen in a
 * venue — see the resolution order in docs/FIXTURE-LIBRARY.md.
 */
export function fixtureFootprint(f: Fixture, profiles?: ProfileMap): number {
  if (isLight(f)) {
    const profile = profiles?.get(f.profileId!);
    if (!profile) return 0;
    const mode = resolveMode(profile, f.profileMode);
    return mode ? Math.max(0, mode.footprint) : 0;
  }
  return f.ledCount * (f.channelsPerPixel ?? 4);
}

// The wire destination a fixture resolves to: per-fixture output override → controller → global
// default. This resolution MUST match Stage.tsx's per-frame output loop (same fixtures, same wires);
// both call resolveDest so the collision detector and the real output can never drift apart.
export interface Dest {
  protocol: OutputProtocol;
  ip: string;
  broadcast: boolean;
  /** 'enttec' only: the USB serial port path. Part of the identity of the wire. */
  port?: string;
}
export interface DestDefaults { protocol: OutputProtocol; ip: string; broadcast: boolean; }

export function resolveDest(f: Fixture, ctrl: Controller | undefined, def: DestDefaults): Dest {
  return {
    protocol: f.output?.protocol || ctrl?.protocol || def.protocol,
    ip: f.output?.ip || ctrl?.ip || def.ip,
    broadcast: f.output?.broadcast ?? ctrl?.broadcast ?? def.broadcast,
    port: f.output?.port || ctrl?.port,
  };
}

// Group key for fixtures sharing a wire (protocol|ip|broadcast). Collisions are per-destination,
// not per-controller — two controllers can point at the same IP. Matches Stage.tsx's destinations key.
// For a USB widget the PORT is the wire — two 'enttec' controllers on COM3 and COM4 are two
// different destinations, and both have no IP at all. Folding the port into the key is what keeps
// the collision detector honest for them.
export const destKey = (d: Dest): string =>
  d.protocol === 'enttec'
    ? `enttec|${d.port ?? ''}`
    : `${d.protocol}|${d.ip}|${d.broadcast ? 1 : 0}`;

/**
 * How many universes a controller can physically emit.
 *
 * A USB widget drives ONE (the Mk2's second port is not addressed yet). autoPatch otherwise walks a
 * controller's universes upward without bound, so a rig needing four universes would be assigned
 * four on a device that can send one — silently, and visible only as "three quarters of my rig is
 * dead". Capping here makes the overflow show up as an unpatched fixture instead.
 */
export function universeCapacity(ctrl: Controller | undefined): number {
  return ctrl?.protocol === 'enttec' ? 1 : Infinity;
}

// Absolute [startAbs, endAbs] channel span of a fixture on its resolved destination.
export interface Span { fixtureId: string; destKey: string; startAbs: number; endAbs: number; }

export function fixtureSpans(
  fixtures: Fixture[],
  controllers: Controller[],
  def: DestDefaults,
  profiles?: ProfileMap,
): Span[] {
  const ctrlById = new Map(controllers.map((c) => [c.id, c]));
  return fixtures.map((f) => {
    const ctrl = f.controllerId ? ctrlById.get(f.controllerId) : undefined;
    const startAbs = f.universe * 512 + (f.startAddress - 1);
    const endAbs = startAbs + Math.max(0, fixtureFootprint(f, profiles) - 1);
    return { fixtureId: f.id, destKey: destKey(resolveDest(f, ctrl, def)), startAbs, endAbs };
  });
}

// Every unordered pair of fixtures whose channel ranges intersect on the same destination.
// O(n²) within each destination bucket — fine for realistic fixture counts, and only run in the
// Routing modal on a memoized deps change (never in the frame loop).
export function findCollisions(spans: Span[]): Array<[string, string]> {
  const byDest = new Map<string, Span[]>();
  for (const s of spans) {
    const arr = byDest.get(s.destKey);
    if (arr) arr.push(s); else byDest.set(s.destKey, [s]);
  }
  const out: Array<[string, string]> = [];
  for (const arr of byDest.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        // Half-open? No — both endAbs are inclusive last channels, so intervals touch iff they overlap.
        if (arr[i].startAbs <= arr[j].endAbs && arr[j].startAbs <= arr[i].endAbs) {
          out.push([arr[i].fixtureId, arr[j].fixtureId]);
        }
      }
    }
  }
  return out;
}

/**
 * Which controller an UNASSIGNED fixture of this kind belongs to.
 *
 * This used to be a bare `controllers[0]` — the first controller in the array, whatever it happened
 * to be. `defaultControllerId` is undefined at every call site, so that was the real rule, and on a
 * rig with an Art-Net LED node and a USB-DMX widget it put every new moving head on the Art-Net node
 * (or, with the widget created first, every 180-channel LED strip on a device that transmits ONE
 * universe). Nothing connected "this is a light" to "it belongs on the lighting interface".
 *
 * The last rung is the OLD BEHAVIOUR, deliberately: with no controller declaring `drives`, rung 1
 * finds nothing, rung 2 finds `controllers[0]` (it is unclassified), and the result is byte-identical
 * to before. That is the property that lets this ship without re-addressing anyone's saved rig.
 */
function fallbackFor(controllers: Controller[], kind: FixtureKind): string | undefined {
  return controllers.find((c) => c.drives === kind)?.id      // a box that says it drives this kind
    ?? controllers.find((c) => !c.drives)?.id                // an unclassified box (every old project)
    ?? controllers[0]?.id;                                   // today's behaviour, last
}

/**
 * Fixtures patched onto a controller that says it drives the OTHER kind.
 *
 * A REPORT, not a rule. Movers over Art-Net is a perfectly ordinary rig, and LED tape on a DMX
 * widget is a small one — neither is refused. What was missing is that the operator could not SEE
 * the divergence: an unclassified controller says nothing, and a wrong one says nothing either.
 *
 * A controller with no `drives` is never reported (it has made no claim to contradict), and neither
 * is a fixture with no resolved controller.
 */
export interface CrossKindPatch { fixtureId: string; controllerId: string; fixture: FixtureKind; drives: FixtureKind }

export function crossKindPatches(fixtures: Fixture[], controllers: Controller[]): CrossKindPatch[] {
  const ctrlById = new Map(controllers.map((c) => [c.id, c]));
  const out: CrossKindPatch[] = [];
  for (const f of fixtures) {
    if (!f.controllerId) continue;
    const ctrl = ctrlById.get(f.controllerId);
    if (!ctrl?.drives) continue;
    const kind = fixtureKind(f);
    if (ctrl.drives !== kind) out.push({ fixtureId: f.id, controllerId: ctrl.id, fixture: kind, drives: ctrl.drives });
  }
  return out;
}

export function autoPatch(
  fixtures: Fixture[],
  controllers: Controller[],
  policy: PatchPolicy,
  defaultControllerId?: string,
  profiles?: ProfileMap,
): Fixture[] {
  const ctrlById = new Map(controllers.map((c) => [c.id, c]));
  const reserve = policy.reserveLockedRanges;
  // ONE resolver for both passes below. The reserve pass (which harvests locked fixtures' ranges)
  // and the assign pass MUST agree about which bucket a fixture lands in — they already carried a
  // comment saying so, as two hand-copied expressions. Now they cannot drift.
  const bucketOf = (f: Fixture): string | undefined =>
    (f.controllerId && ctrlById.has(f.controllerId) ? f.controllerId : undefined)
    ?? (defaultControllerId && ctrlById.has(defaultControllerId) ? defaultControllerId : undefined)
    ?? fallbackFor(controllers, fixtureKind(f));

  // The packing bucket a fixture belongs to — the SAME rule for locked and auto fixtures, so a
  // locked fixture's reserved range lands in the exact bucket the auto fixtures on its controller
  // pack into.
  const bucketFor = (f: Fixture): string => bucketOf(f) ?? GLOBAL;

  // Phase B: reserved absolute intervals per bucket, harvested from locked fixtures, sorted ascending.
  const reserved = new Map<string, Array<[number, number]>>();
  if (reserve) {
    for (const f of fixtures) {
      if (!f.patchLocked) continue;
      const startAbs = f.universe * 512 + (f.startAddress - 1);
      const endAbs = startAbs + fixtureFootprint(f, profiles) - 1;
      const key = bucketFor(f);
      const arr = reserved.get(key);
      if (arr) arr.push([startAbs, endAbs]); else reserved.set(key, [[startAbs, endAbs]]);
    }
    for (const arr of reserved.values()) arr.sort((a, b) => a[0] - b[0]);
  }

  const cursors = new Map<string, { universe: number; channel: number }>();
  const cursorFor = (cid: string) => {
    let cur = cursors.get(cid);
    if (!cur) { cur = { universe: ctrlById.get(cid)?.startUniverse ?? 0, channel: 0 }; cursors.set(cid, cur); }
    return cur;
  };

  return fixtures.map((f) => {
    if (f.patchLocked) return f;
    const real = bucketOf(f);
    const key = real ?? GLOBAL;
    const cur = cursorFor(key);
    const need = fixtureFootprint(f, profiles);

    // Phase B: hop the cursor forward past every reserved (locked) interval this fixture would
    // straddle. Intervals are sorted ascending and the cursor only ever moves forward, so this
    // single pass terminates — no infinite loop even for a locked fixture that spans universes.
    if (reserve) {
      const intervals = reserved.get(key);
      if (intervals) {
        let abs = cur.universe * 512 + cur.channel;
        for (const [rs, re] of intervals) {
          if (abs <= re && rs <= abs + need - 1) abs = re + 1; // overlap → jump past this range
        }
        cur.universe = Math.floor(abs / 512);
        cur.channel = abs % 512;
      }
    }

    const universe = cur.universe;
    const startAddress = cur.channel + 1;
    const total = cur.channel + need;
    cur.universe += Math.floor(total / 512);
    cur.channel = total % 512;

    // A device that can only emit N universes must not be handed N+1. Overflow is reported as
    // `patchOverflow` rather than silently assigned: an unpatched-looking fixture is a question the
    // operator can answer, whereas a fixture addressed on universe 2 of a one-universe USB widget
    // just never lights and gives no clue why.
    const ctrl = real ? ctrlById.get(real) : undefined;
    const base = ctrl?.startUniverse ?? 0;
    const overflow = universe - base >= universeCapacity(ctrl);

    const patched = { ...f, universe, startAddress, ...(overflow ? { patchOverflow: true as const } : {}) };
    if (!overflow && f.patchOverflow) delete (patched as { patchOverflow?: boolean }).patchOverflow;
    return real ? { ...patched, controllerId: real } : patched;
  });
}
