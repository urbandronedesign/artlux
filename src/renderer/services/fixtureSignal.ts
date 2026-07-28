import type { ChannelRole, Fixture, FixtureProfile } from '../types';
import { channelValue, modeOf, physicalValue, selectedRange, type RoleOverride } from './profilePack';

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
}

// ── READING A ROLE OUT OF A RESOLVED FIXTURE — one owner, beside the state it reads ──────────
//
// This switch existed THREE times, character-for-character: in the take recorder, in Store Key, and
// in the pose-cue engine. One question, three answers free to drift — the same shape `fixtureKind`
// and `fixtureFootprint` exist to prevent. Add an eighth role and two of the three would have gone
// on silently ignoring it.
//
// ⚠ `ROLES_CAPTURED` MUST STAY THE ROLES THIS FUNCTION CAN RESOLVE, which is why they are adjacent.
// They had already drifted: both former copies of the list included `'white'`, and no copy of the
// switch had a `case 'white'` — because a white EMITTER is folded into r/g/b by the table above and
// never reaches `FixtureState` as its own field. So the list promised a role that could not be
// captured, and every consumer silently dropped it. Removing it changes no behaviour; it removes a
// false promise.
export function roleValue(st: FixtureState | undefined, role: ChannelRole): number | undefined {
  if (!st) return undefined;
  switch (role) {
    case 'pan': return st.pan;
    case 'tilt': return st.tilt;
    case 'dimmer': return st.intensity;
    case 'red': return st.r;
    case 'green': return st.g;
    case 'blue': return st.b;
    case 'zoom': return st.zoomDeg;
    default: return undefined;
  }
}

/**
 * The roles a busk RECORDS and a pose key STORES — deliberately narrow: a take is movement and
 * look, not maintenance. Exactly the set `roleValue` above can resolve, and it must stay that way.
 *
 * Not to be confused with the roles a generated EFFECT can drive (`ROLES_GENERATABLE` in
 * services/lightingTake.ts) — that is a different question with a different answer, and the overlap
 * between them is what made two lists look like one list drifting.
 */
export const ROLES_CAPTURED: readonly ChannelRole[] =
  ['pan', 'tilt', 'dimmer', 'red', 'green', 'blue', 'zoom'];

type Listener = (states: ReadonlyMap<string, FixtureState>) => void;
const listeners = new Set<Listener>();
let latest: ReadonlyMap<string, FixtureState> = new Map();

// Emitter roles that add light, and the linear RGB each contributes. Amber/UV/lime are real emitters
// on modern fixtures and leaving them out makes a warm wash render stone cold.
const EMITTERS: Partial<Record<ChannelRole, [number, number, number]>> = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1],
  white: [1, 1, 1], warmWhite: [1, 0.82, 0.62], coldWhite: [0.82, 0.9, 1],
  amber: [1, 0.65, 0.1], uv: [0.28, 0.05, 0.9], lime: [0.72, 1, 0.2], indigo: [0.3, 0.1, 1],
  cyan: [0, 1, 1], magenta: [1, 0, 1], yellow: [1, 1, 0],
};

/**
 * Resolve one fixture. Exported so a take recorder and the packer can share the interpretation
 * rather than each inventing its own idea of what "intensity" means.
 */
export function resolveFixture(f: Fixture, profile: FixtureProfile, override?: RoleOverride): FixtureState {
  const mode = modeOf(profile, f.profileMode);
  const out: FixtureState = { id: f.id, intensity: 1, r: 0, g: 0, b: 0, pan: 0, tilt: 0, blackout: false };
  if (!mode) return out;

  // Only the channels this MODE emits: a colour channel the fixture has but the mode does not
  // address is not reachable, and letting it tint the beam would show light the rig cannot make.
  const inMode = new Set<string>();
  for (const s of mode.slots) if (s) inMode.add(s.channelKey);

  let dimmer = 1;
  let hasEmitter = false;
  let shutterOpen = true;

  for (const c of profile.channels) {
    if (!inMode.has(c.key)) continue;
    const v = channelValue(f, c, override);

    const emitter = EMITTERS[c.role];
    if (emitter) {
      out.r += emitter[0] * v; out.g += emitter[1] * v; out.b += emitter[2] * v;
      hasEmitter = true;
      continue;
    }

    switch (c.role) {
      case 'dimmer': dimmer = v; break;
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
