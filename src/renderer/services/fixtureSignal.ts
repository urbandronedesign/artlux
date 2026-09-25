import type { ChannelRole, Fixture, FixtureProfile, ProfileMode } from '../types';
import { channelValue, modeOf, physicalValue, selectedRange, type ChannelOverride, type RoleOverride } from './profilePack';

// The RESOLVED state of every profiled fixture, once per frame.
//
// The 3D scene already reads `dmxSignal`, but that carries the canonical RGBW pixel buffer — the
// right shape for LED tape and the wrong one for a moving head, which has no pixels, only named
// parameters. Asking the scene to re-derive Pan from raw DMX bytes would put a second, drifting copy
// of the packer's arithmetic in the renderer; the packer already computes these values, so it
// publishes them.
//
// This is the one seam between "what the fixture is doing" and everything that wants to draw it: the
// 3D bodies, the beams, and (later) the take recorder, which captures exactly these role values.
//
// Pan/tilt/zoom are published in DEGREES, not 0..1. Degrees are what a mesh's joint rotation and a
// beam's cone angle actually need, and converting once here beats every consumer carrying the
// profile lookup — see docs/FIXTURE-LIBRARY.md on why the profile stores them that way.

export interface FixtureState {
  id: string;
  /** 0..1, already folded: dimmer × shutter-open. What an intensity should actually be drawn at. */
  intensity: number;
  /** Linear 0..1 RGB from the fixture's colour-mixing channels, or its colour-wheel slot. */
  r: number; g: number; b: number;
  /** Absolute angles in degrees, from the profile's declared range. NaN-free; 0 when unavailable. */
  pan: number; tilt: number;
  /** Beam half-angle in degrees when a zoom channel exists, else undefined (use the lens range). */
  zoomDeg?: number;
  /** The gobo image key currently selected, if the wheel slot names one. */
  goboKey?: string;
  /** True while a strobe/shutter channel is closed — the beam should not be drawn at all. */
  blackout: boolean;
  /**
   * EVERY COLOUR CHANNEL THIS MODE ADDRESSES, unfolded — raw 0..1, keyed by role, exactly as the
   * fixture stores it. `r/g/b` above is the *rendered* colour: emitters summed, dichroic flags
   * applied, then normalised by the peak. That is the right answer for drawing a beam and the wrong
   * one for recording a busk, because it cannot be taken apart again — a warm white at full and a
   * red+green at full both arrive as one RGB triple, and playing that back through an RGBW fixture
   * lights the wrong emitters at the wrong levels.
   *
   * So the resolver keeps both: the fold for the 3D scene, and the originals for capture. Only the
   * roles the MODE emits appear here — an unreachable channel must not be recordable, or a take
   * would promise a colour the rig cannot make.
   */
  emit?: Partial<Record<ChannelRole, number>>;
}

// ── READING A ROLE OUT OF A RESOLVED FIXTURE — one owner, beside the state it reads ──────────
//
// This switch existed THREE times, character-for-character: in the take recorder, in Store Key, and
// in the pose-cue engine. One question, three answers free to drift — the same shape `fixtureKind`
// and `fixtureFootprint` exist to prevent. Add an eighth role and two of the three would have gone
// on silently ignoring it.
//
// ⚠ `ROLES_CAPTURED` MUST STAY THE ROLES THIS FUNCTION CAN RESOLVE, which is why they are adjacent.
// They had already drifted once: both former copies of the list included `'white'` while no copy of
// the switch had a `case 'white'`, so the list promised a role that could not be captured and every
// consumer silently dropped it.
//
// THE FIX FOR THAT WAS TO SHRINK THE LIST, AND SHRINKING IT WAS ONLY HALF AN ANSWER. It made the
// promise honest; it left a tuneable-white rig unrecordable, which is the whole show on a CW/WW or
// RGBW install. The emitters are now resolvable for real, off `st.emit` — see the field's comment.
//
// RED/GREEN/BLUE ARE ANSWERED BY ONE MODEL OR THE OTHER, NEVER BOTH — and that `st.emit ? … : …`
// is load-bearing, not a tidy `??`. A fixture that can NAME its emitters is captured emitter by
// emitter; one that cannot is captured as the rendered triple:
//   · named (`emit` present) — an RGBW head reports its own red channel, and reports NO red at all
//     if it has none. A CW/WW head is the case that matters: with `??` it would fall through to the
//     rendered tint and record red/green/blue *as well as* cold/warm white, so replaying it on a
//     head that has both would drive the same colour twice, and the take would be brighter than the
//     busk. Absent means absent;
//   · unnamed (`emit` undefined) — a CMY head, a colour-wheel head, or a fixture with no colour at
//     all. The fold is the only description of colour it can give: the flags have already been
//     applied, and frameEngine's CMY_FROM_RGB bridge writes those values back through the same
//     dichroic assignment. Losing this branch would re-break the CMY round trip that `SUBTRACTIVE`
//     below exists to keep closed, which is a bug this code has already shipped once.
export function roleValue(st: FixtureState | undefined, role: ChannelRole): number | undefined {
  if (!st) return undefined;
  switch (role) {
    case 'pan': return st.pan;
    case 'tilt': return st.tilt;
    case 'dimmer': return st.intensity;
    case 'red': return st.emit ? st.emit.red : st.r;
    case 'green': return st.emit ? st.emit.green : st.g;
    case 'blue': return st.emit ? st.emit.blue : st.b;
    case 'zoom': return st.zoomDeg;
    // One `case` per emitter, spelled out, rather than the `default: st.emit?.[role]` this obviously
    // wants to be. `verify:invariants` reads the case LABELS out of this function and diffs them
    // against ROLES_CAPTURED — that is the guard that caught the original `white` drift — and a
    // catch-all resolves every role while naming none, so the check would report the whole list as
    // unresolved. Keeping them literal keeps the two lists checkable against each other.
    case 'white': return st.emit?.white;
    case 'coldWhite': return st.emit?.coldWhite;
    case 'warmWhite': return st.emit?.warmWhite;
    case 'amber': return st.emit?.amber;
    case 'uv': return st.emit?.uv;
    case 'lime': return st.emit?.lime;
    case 'indigo': return st.emit?.indigo;
    case 'colorTemp': return st.emit?.colorTemp;
    default: return undefined;
  }
}

/**
 * The roles a busk RECORDS and a pose key STORES — movement, intensity and the colour the rig can
 * actually make. Exactly the set `roleValue` above can resolve, and it must stay that way.
 *
 * THE EMITTERS ARE HERE BECAUSE A LOOK IS NOT ONLY RGB. `white`, `coldWhite`/`warmWhite`, amber,
 * UV, lime and indigo are separate emitters on a real fixture, and on a tuneable-white rig CW/WW
 * *is* the look — recording a busk that dropped them stored a move with no colour in it. They are
 * captured raw, per channel, so the playback drives the same emitters at the same levels rather
 * than an RGB approximation of their sum.
 *
 * `colorTemp` rides along for the same reason in one channel instead of two: a CCT fader is how the
 * other half of the tuneable-white rigs are built, and a take that could not carry it would replay
 * a warm scene cold.
 *
 * Still deliberately narrow — a take is movement and look, not maintenance: no gobo, prism, focus,
 * iris, frost, speed or macro. Cyan/magenta/yellow stay out on purpose; they are read back as RGB
 * and written back through the CMY bridge, so adding them would author the same colour twice.
 *
 * Not to be confused with the roles a generated EFFECT can drive (`ROLES_GENERATABLE` in
 * services/lightingTake.ts) — that is a different question with a different answer, and the overlap
 * between them is what made two lists look like one list drifting.
 */
export const ROLES_CAPTURED: readonly ChannelRole[] = [
  'pan', 'tilt', 'dimmer', 'zoom',
  'red', 'green', 'blue',
  'white', 'coldWhite', 'warmWhite', 'amber', 'uv', 'lime', 'indigo', 'colorTemp',
];

type Listener = (states: ReadonlyMap<string, FixtureState>) => void;
const listeners = new Set<Listener>();
let latest: ReadonlyMap<string, FixtureState> = new Map();

// Emitter roles that add light, and the linear RGB each contributes. Amber/UV/lime are real emitters
// on modern fixtures and leaving them out makes a warm wash render stone cold.
//
// EXPORTED, AND THE ONLY COPY. `services/colorEngine` inverts this table — "what must each emitter
// do to make THIS colour" — and an inverse that disagrees with the forward direction is worse than
// no inverse at all: the solver would author values that resolve back to a different colour than the
// one asked for, and the 3D scene (which reads the fold) would disagree with the wire. So the
// engine imports it rather than keeping its own. Guarded: one owner, like `roleValue`.
export const EMITTERS: Partial<Record<ChannelRole, [number, number, number]>> = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1],
  white: [1, 1, 1], warmWhite: [1, 0.82, 0.62], coldWhite: [0.82, 0.9, 1],
  amber: [1, 0.65, 0.1], uv: [0.28, 0.05, 0.9], lime: [0.72, 1, 0.2], indigo: [0.3, 0.1, 1],
  cyan: [0, 1, 1], magenta: [1, 0, 1], yellow: [1, 1, 0],
};

/**
 * CMY IS A FILTER, NOT AN EMITTER — and getting that backwards made every discharge head black.
 *
 * A MAC 250, a Mac Viper, an Alpha Spot: white lamp, three dichroic flags, and the DMX convention is
 * that 0 = flag OUT. Reading cyan/magenta/yellow off the EMITTERS table above therefore said "no
 * light" for a head that is wide open, so a CMY fixture rendered BLACK in the 3D scene at full
 * dimmer, and `roleValue(st,'red'|'green'|'blue')` published 0 — which is what a busk records and a
 * pose key stores. The colour half of a take on a CMY rig was not merely wrong, it was inverted.
 *
 * The table is kept for the fixtures where those roles really ARE emitters: an RGB(W)+CM LED wash
 * genuinely adds cyan light. The two cases are told apart by whether the mode also emits red/green/
 * blue — a subtractive head never does — rather than by guessing from the fixture's name.
 */
const SUBTRACTIVE: Partial<Record<ChannelRole, 0 | 1 | 2>> = { cyan: 0, magenta: 1, yellow: 2 };
const ADDITIVE_PRIMARIES: ReadonlySet<ChannelRole> = new Set<ChannelRole>(['red', 'green', 'blue']);

/**
 * WHAT KIND OF COLOUR FIXTURE IS THIS MODE — the question `resolveFixture` has to answer before it
 * can read a single colour channel, because a channel's MEANING depends on it: cyan is an emitter
 * on an RGB+CM LED wash and a dichroic flag on a discharge head.
 *
 * EXTRACTED SO THERE IS ONE ANSWER. The packer needs it too: a take stores colour as red/green/blue,
 * and the bridge that lands that on a CMY head (frameEngine's CMY_FROM_RGB) is only correct when the
 * head really is subtractive. It used to apply unconditionally, so on the 17 modes in the shipped
 * library that emit BOTH primaries and CMY (cameo TS 200 FC, Clay Paky Spheriscan, ETC fos/4 PD16 and
 * PD24) a clip driving `red` also drove `cyan` to its complement — the read path and the write path
 * disagreeing about the same fixture. Two copies of a rule this subtle will always end up doing that;
 * one copy cannot.
 */
export interface ColorModel {
  /**
   * The channel keys this MODE actually emits. A colour channel the fixture HAS but the mode does
   * not address is unreachable, and letting it tint anything would show light the rig cannot make.
   */
  inMode: ReadonlySet<string>;
  /**
   * True when cyan/magenta/yellow are dichroic FLAGS multiplying a white lamp (a discharge head),
   * false when they are emitters adding light (an LED wash). Decided from the mode's own channel
   * list — a subtractive head never emits red/green/blue — and never from the model name.
   */
  subtractive: boolean;
}

// A mode is immutable, so its colour model is too. Keyed on the mode OBJECT, exactly like
// profilePack's modePlan cache and for the same reason: a reloaded project brings new objects and
// recomputes by construction, with no invalidation to forget.
const colorModelCache = new WeakMap<ProfileMode, ColorModel>();

export function colorModel(profile: FixtureProfile, mode: ProfileMode): ColorModel {
  const cached = colorModelCache.get(mode);
  if (cached) return cached;

  const inMode = new Set<string>();
  for (const s of mode.slots) if (s) inMode.add(s.channelKey);

  let hasCmy = false;
  let hasPrimaries = false;
  for (const c of profile.channels) {
    if (!inMode.has(c.key)) continue;
    if (SUBTRACTIVE[c.role] !== undefined) hasCmy = true;
    else if (ADDITIVE_PRIMARIES.has(c.role)) hasPrimaries = true;
  }

  const model: ColorModel = { inMode, subtractive: hasCmy && !hasPrimaries };
  colorModelCache.set(mode, model);
  return model;
}

/**
 * Resolve one fixture. Exported so a take recorder and the packer can share the interpretation
 * rather than each inventing its own idea of what "intensity" means.
 */
export function resolveFixture(
  f: Fixture,
  profile: FixtureProfile,
  override?: RoleOverride,
  live?: ChannelOverride,
): FixtureState {
  const mode = modeOf(profile, f.profileMode);
  const out: FixtureState = { id: f.id, intensity: 1, r: 0, g: 0, b: 0, pan: 0, tilt: 0, blackout: false };
  if (!mode) return out;

  // Which channels are reachable, and whether cyan means "add cyan" or "take out red". Both come
  // from colorModel, which the packer's RGB→CMY bridge reads too — see its header.
  const { inMode, subtractive } = colorModel(profile, mode);

  let dimmer = 1;
  let hasEmitter = false;
  let shutterOpen = true;
  // Flag positions, 0 = out. Held apart from r/g/b because they MULTIPLY the lamp rather than add.
  const cmy: [number, number, number] = [0, 0, 0];

  for (const c of profile.channels) {
    if (!inMode.has(c.key)) continue;
    const v = channelValue(f, c, override, live);

    if (subtractive) {
      const axis = SUBTRACTIVE[c.role];
      if (axis !== undefined) { cmy[axis] = v; continue; }
    }

    const emitter = EMITTERS[c.role];
    if (emitter) {
      out.r += emitter[0] * v; out.g += emitter[1] * v; out.b += emitter[2] * v;
      hasEmitter = true;
      // …and keep the original beside the fold, so a busk can record THIS emitter rather than the
      // summed triple it disappears into. Written for every emitter the mode reaches, including
      // cyan/magenta/yellow on an additive wash, where they genuinely are emitters.
      (out.emit ??= {})[c.role] = v;
      continue;
    }

    switch (c.role) {
      case 'dimmer': dimmer = v; break;
      // A CCT fader is colour, not maintenance: it is the other way a tuneable-white fixture is
      // built. Nothing renders it yet (it is not an emitter — it retunes the ones there are), but it
      // is captured, so a take replays a warm scene warm. Raw, because a physical range in kelvin
      // would not survive being retargeted onto a fixture with a different CCT span.
      case 'colorTemp': (out.emit ??= {}).colorTemp = v; break;
      case 'pan': out.pan = physicalValue(c, v) ?? v * 540; break;
      case 'tilt': out.tilt = physicalValue(c, v) ?? v * 270; break;
      case 'zoom': { const z = physicalValue(c, v); if (z !== null) out.zoomDeg = z; break; }
      case 'shutter':
      case 'strobe': {
        // A shutter is a LIST, not a fader: 'Closed' is a band, not the value 0. Read the slot the
        // value falls in and believe its label; a channel with no bands is treated as open.
        const slot = selectedRange(c, v);
        if (slot && /closed|blackout/i.test(slot.label)) shutterOpen = false;
        break;
      }
      case 'colorWheel': {
        const slot = selectedRange(c, v);
        if (slot?.color) {
          const col = hexToRgb(slot.color);
          if (col) { out.r = col[0]; out.g = col[1]; out.b = col[2]; hasEmitter = true; }
        }
        break;
      }
      case 'goboWheel': {
        const slot = selectedRange(c, v);
        if (slot?.goboKey) out.goboKey = slot.goboKey;
        break;
      }
      default: break;
    }
  }

  // A fixture with a dimmer but no colour channels is a white light, not a black one — that is most
  // conventional fixtures, and defaulting them to black would make a whole rig invisible in 3D.
  if (!hasEmitter) { out.r = 1; out.g = 1; out.b = 1; }

  // …then the flags come down over whatever the lamp is. Cyan subtracts red, magenta green, yellow
  // blue — the standard dichroic assignment, and the reason all three OUT is open white rather than
  // black. A colour WHEEL, if the head also has one, has already set r/g/b above and is filtered by
  // the flags exactly as it is on the real fixture.
  if (subtractive) {
    out.r *= 1 - cmy[0];
    out.g *= 1 - cmy[1];
    out.b *= 1 - cmy[2];
  }

  const peak = Math.max(out.r, out.g, out.b);
  if (peak > 1) { out.r /= peak; out.g /= peak; out.b /= peak; }

  out.intensity = shutterOpen ? dimmer : 0;
  out.blackout = !shutterOpen || dimmer <= 0;
  return out;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Called once per frame by the packer, with every profiled fixture it just wrote. */
export function publish(states: ReadonlyMap<string, FixtureState>): void {
  latest = states;
  listeners.forEach((cb) => { try { cb(states); } catch (e) { console.error('[fixture-signal] sub error', e); } });
}

/** The most recent frame — for a consumer mounting mid-show that must not wait a frame to draw. */
export function snapshot(): ReadonlyMap<string, FixtureState> { return latest; }

export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
