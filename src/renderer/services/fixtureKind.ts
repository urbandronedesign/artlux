import type { Fixture, FixtureGroup, FixtureProfile } from '../types';

// ── WHAT KIND OF FIXTURE IS THIS? — THE ONE PLACE THAT ANSWERS IT ────────────────────────────
//
// ArtLux has two physically different things called "Fixture", on two different wires:
//
//   · an LED fixture   — tape, panel, pixel bar. An array of RGB/W cells, driven by SAMPLING the
//                        surface it is mapped onto, occupying ledCount × channelsPerPixel channels.
//                        Typically Art-Net/sACN to an LED controller.
//   · a LIGHT fixture  — moving head, wash, beam, PAR. Named DMX parameters driven by AUTHORED
//                        role values (pan/tilt in degrees), occupying its MODE's footprint.
//                        Typically a USB-DMX widget.
//
// The engine has always branched correctly between them; what it lacked was a NAME for the branch.
// The test was open-coded in ten files, in TWO different forms that quietly disagree —
// `f.profileId` in the packer and the footprint owner, `f.profileId && profiles.has(...)` in the 3D
// scene. Those are different questions, and a fixture whose profile does not resolve fell between
// them: profiled to the packer (which writes nothing for it), pixel to the 3D scene (which drew it
// as a stray LED sphere). Nothing named that state, so nothing could report it.
//
// This module is modelled on `fixtureFootprint` in addressing.ts, deliberately and for the same
// reason: one formula, one owner, so the packer, the patch, the inspector and the 3D scene cannot
// drift. `verify:invariants` enforces that no other file re-derives the kind.
//
// THE KIND IS DERIVED, NEVER PERSISTED. `profileId` is already the truth — it is the field that
// actually changes the fixture's behaviour — and a second stored copy would be free to disagree
// with it. Deriving also means ZERO project migration: every `.artlux` on disk already carries the
// answer.

/** The two kinds of fixture. `'light'` iff the fixture carries a DMX profile. */
export type FixtureKind = 'pixel' | 'light';

/**
 * What kind of fixture this is. Cheap, and deliberately profile-map-free, so it can be called from
 * a render path or a hot loop without threading the profile registry through.
 *
 * THIS IS THE ONLY DEFINITION. Do not write `f.profileId ? … : …` to ask this question.
 */
export const fixtureKind = (f: Fixture): FixtureKind => (f.profileId ? 'light' : 'pixel');

export const isLight = (f: Fixture): boolean => !!f.profileId;
export const isPixel = (f: Fixture): boolean => !f.profileId;

/**
 * The THREE-way truth, for the consumers that need to tell a working light from a broken one.
 *
 * `'light-unresolved'` is a fixture carrying a `profileId` we have no profile for — the same case
 * `fixtureFootprint()` returns 0 for, rather than falling back to the pixel formula. It is a real,
 * reportable state (the project was opened on a machine whose library lacks that profile, and the
 * project did not embed it), NOT a third kind of fixture: it is a LIGHT we cannot describe.
 *
 * Consumers that render must handle it explicitly. Treating it as a light crashes on the absent
 * profile; treating it as a pixel draws an LED strip where a moving head should be. Both were
 * happening before this existed.
 */
export type FixtureKindState = 'pixel' | 'light' | 'light-unresolved';

export type ProfileLookup = ReadonlyMap<string, FixtureProfile> | undefined;

export function lightState(f: Fixture, profiles?: ProfileLookup): FixtureKindState {
  if (!f.profileId) return 'pixel';
  return profiles?.has(f.profileId) ? 'light' : 'light-unresolved';
}

/** A light whose profile actually resolved — what the 3D mover renderers and the packer need. */
export const isResolvedLight = (f: Fixture, profiles?: ProfileLookup): boolean =>
  lightState(f, profiles) === 'light';

/**
 * This fixture's profile, or `undefined` for a pixel fixture AND for an unresolved light.
 *
 * The guarded-resolution idiom `f.profileId ? profiles.get(f.profileId) : undefined` was open-coded
 * at four sites — the ternary exists only because `.get(undefined)` does not typecheck, so it reads
 * like a kind branch while being no such thing. Collapsing it here keeps those sites honest and
 * leaves `verify:invariants` free to ban the bare boolean test outright, with no allow-list of
 * "files that are really just resolving".
 */
export function profileOf(f: Fixture, profiles?: ProfileLookup): FixtureProfile | undefined {
  return f.profileId ? profiles?.get(f.profileId) : undefined;
}

// ── The words ────────────────────────────────────────────────────────────────────────────────
// One place, so a label in the browser list, a section header, a routing badge and a toast can
// never disagree — and so that changing the vocabulary is one edit rather than a grep.
//
// "LED fixture" / "Light fixture" over the console-native "Pixels" / "Fixtures": the latter implies
// a light is the *default* kind of fixture and a pixel strip is the special case, which is backwards
// for this app and confusing in a browser list where both are siblings.

export const KIND_LABEL: Record<FixtureKind, string> = {
  pixel: 'LED Fixture',
  light: 'Light Fixture',
};

export const KIND_LABEL_PLURAL: Record<FixtureKind, string> = {
  pixel: 'LED Fixtures',
  light: 'Light Fixtures',
};

export const KIND_LABEL_FR: Record<FixtureKind, string> = {
  pixel: 'Fixture LED',
  light: 'Projecteur',
};

// ── Groups ───────────────────────────────────────────────────────────────────────────────────

/**
 * The kind of a GROUP, derived from its members. Not persisted, for the same reason the fixture's
 * kind is not: the members are the truth.
 *
 * `'mixed'` matters. A lighting take/sequence is authored in ROLE space (pan in degrees, dimmer
 * 0..1), and a role value has nowhere to land on a pixel strip — so a lighting clip pointed at a
 * mixed group silently drives only some of it. An EMPTY group is `'empty'` rather than defaulting
 * to a kind, because "a group of nothing" must not read as "a group of lights" to a clip that is
 * about to be aimed at it.
 */
export type GroupKind = FixtureKind | 'mixed' | 'empty';

export function groupKind(g: FixtureGroup, fixtures: readonly Fixture[]): GroupKind {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  let pixel = false, light = false;
  for (const id of g.fixtureIds) {
    const f = byId.get(id);
    if (!f) continue;              // a dangling id is not a kind — ignore it, don't guess
    if (isLight(f)) light = true; else pixel = true;
    if (pixel && light) return 'mixed';
  }
  return pixel ? 'pixel' : light ? 'light' : 'empty';
}
