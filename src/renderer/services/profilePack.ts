import type { Fixture, FixtureProfile, ProfileChannel, ProfileMode } from '../types';

// Packing a PROFILED fixture (a moving head / wash / beam) into DMX bytes.
//
// Kept pure and separate from Stage's frame loop on purpose: this is fiddly fixed-point arithmetic
// whose failure mode is "the head points somewhere else", which is invisible in a code review and
// obvious only on a real rig. A pure module can be checked by a throwaway tsc script against
// hand-computed byte arrays (see docs/DEVELOPMENT.md → Testing).
//
// A pixel fixture and a profiled fixture differ in what a channel MEANS:
//   · pixel   — every channel is a colour component of one LED, so the whole span is gamma-corrected
//               and reordered by the strip's wiring (RGB/GRB/…);
//   · profile — a channel is a named parameter at a fixed offset in the mode. Pan is not a colour.
//
// ⚠ NO GAMMA HERE, EVER. The pixel packer runs every byte through the gamma LUT because those bytes
// are light intensities. A profile channel is not: gamma-correcting Pan moves the head to the wrong
// angle, gamma-correcting a gobo index selects a different gobo, and gamma-correcting a strobe rate
// changes the speed. The LUT must not reach this file.

/** A fixture's mode: the one it names, else the profile's first. Mirrors addressing.resolveMode. */
export function modeOf(profile: FixtureProfile, key?: string): ProfileMode | undefined {
  if (key) {
    const named = profile.modes.find((m) => m.key === key);
    if (named) return named;
  }
  return profile.modes[0];
}

/**
 * One emitted DMX slot, resolved against a specific mode.
 *
 * `bytes` is the count of bytes THIS MODE emits for the channel, which is NOT the same as the
 * channel's own `resolution`. A profile declares Dimmer as 16-bit because the fixture has a
 * "Dimmer fine" channel, but a 14-channel mode may only include the coarse one — and scaling a 0..1
 * value by 65535 when only one byte will be written throws the low half away and, worse, makes the
 * value depend on a byte nobody sends. The MODE is authoritative for what goes on the wire.
 */
interface Slot {
  channel: ProfileChannel;
  /** 0 = most significant. */
  byte: number;
  /** How many bytes this mode emits for this channel (1..3). */
  bytes: number;
}

/** Null entries are reserved-but-unused channels: they still occupy their slot and are written 0. */
export type ModePlan = Array<Slot | null>;

// A mode's plan is immutable, so compute it once per mode object. Keyed on the mode itself, so a
// reloaded project (new objects) recomputes rather than serving a stale plan.
const planCache = new WeakMap<ProfileMode, ModePlan>();

export function modePlan(profile: FixtureProfile, mode: ProfileMode): ModePlan {
  const cached = planCache.get(mode);
  if (cached) return cached;

  const byKey = new Map(profile.channels.map((c) => [c.key, c]));
  // Count the bytes this mode actually emits per channel, before building the plan.
  const bytesPerChannel = new Map<string, number>();
  for (const slot of mode.slots) {
    if (!slot) continue;
    bytesPerChannel.set(slot.channelKey, (bytesPerChannel.get(slot.channelKey) ?? 0) + 1);
  }

  const plan: ModePlan = mode.slots.map((slot) => {
    if (!slot) return null;
    const channel = byKey.get(slot.channelKey);
    // A slot naming a channel the profile does not define cannot be emitted meaningfully, but it
    // MUST still consume its DMX offset — dropping it would shift every later channel of this
    // fixture by one. Write it as a reserved slot (0) instead. The build-time validator rejects
    // profiles like this, so in practice only a hand-edited user profile can reach here.
    if (!channel) return null;
    return { channel, byte: slot.byte, bytes: bytesPerChannel.get(slot.channelKey) ?? 1 };
  });

  planCache.set(mode, plan);
  return plan;
}

/**
 * The authored 0..1 value of one channel on one fixture.
 *
 * The bottom of the precedence stack. Overlays (a lighting clip, an automation lane) do not write
 * here — they lay their values over the fixture BEFORE the packer sees it, exactly as the pixel path
 * already does with automationOverlay, so this function only ever reads committed state.
 */
export function channelValue(
  f: Fixture,
  channel: ProfileChannel,
  override?: RoleOverride,
  live?: ChannelOverride,
): number {
  // THE TOP OF THE STACK — a fader under a hand right now, in the channel's OWN normalised space.
  // It is read before the role override for the reason services/livePreview spells out: everything
  // below speaks roles, but a fader is a channel, and a drag must beat the clip that happens to be
  // running the way an operator's hand beats everything else.
  const now = live?.(f, channel);
  if (now !== undefined) {
    const c = now < 0 ? 0 : now > 1 ? 1 : now;
    return channel.invert ? 1 - c : c;
  }
  // A LIGHTING CLIP speaks in roles and physical units; the fixture stores normalised channel
  // values. Converting here — with THIS fixture's own range — is what lets one clip drive a mixed
  // rig, and what makes a movement recorded on a 540° head land at the same ANGLE on a 630° one.
  const fromClip = override?.(f.id, channel);
  if (fromClip !== undefined) {
    const normalised = channel.min !== undefined && channel.max !== undefined
      ? valueFromPhysical(channel, fromClip) ?? fromClip
      : fromClip;
    const c = normalised < 0 ? 0 : normalised > 1 ? 1 : normalised;
    return channel.invert ? 1 - c : c;
  }
  const raw = f.dmx?.[channel.key];
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : channel.default;
  const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
  return channel.invert ? 1 - clamped : clamped;
}

/**
 * Resolves a role-space override for one channel of one fixture, in the ROLE's unit (degrees for
 * pan/tilt, 0..1 otherwise), or undefined to fall through to the fixture's authored value.
 *
 * Passed in rather than read from a singleton so this module stays pure and checkable: the caller
 * (Stage) is the one that knows the precedence stack and whether an automation lane has already
 * claimed the path.
 */
export type RoleOverride = (fixtureId: string, channel: ProfileChannel) => number | undefined;

/**
 * The LIVE layer: what a fader is doing to one channel of one fixture RIGHT NOW, in that channel's
 * own normalised 0..1 space — the same space `Fixture.dmx` stores, so the handover back to the
 * committed value on release is an identity, not a conversion.
 *
 * Takes the whole fixture rather than its id because retiring a released entry is decided by
 * comparing against that fixture's authored value; see services/livePreview.
 */
export type ChannelOverride = (f: Fixture, channel: ProfileChannel) => number | undefined;

/**
 * Emit one profiled fixture's channels, in mode order, through the caller's channel writer.
 *
 * `writeCh` is Stage's existing per-fixture writer: it owns the 512-channel spill to the next
 * universe and the lazy universe registration, so this function must not know about universes at
 * all. Exactly `mode.footprint` bytes are written — no more, no fewer — which is what keeps the
 * packer in agreement with fixtureFootprint() and therefore with the patch.
 */
export function packProfiled(
  f: Fixture,
  profile: FixtureProfile,
  mode: ProfileMode,
  writeCh: (value: number) => void,
  override?: RoleOverride,
  live?: ChannelOverride,
): void {
  const plan = modePlan(profile, mode);
  for (const slot of plan) {
    if (!slot) { writeCh(0); continue; }
    const value = channelValue(f, slot.channel, override, live);
    // Fixed point over the bytes this mode emits, most-significant byte first.
    const max = 256 ** slot.bytes - 1;
    const raw = Math.round(value * max);
    const shift = 8 * (slot.bytes - 1 - slot.byte);
    writeCh((raw >> shift) & 0xff);
  }
}

/**
 * The DMX byte a discrete channel's value currently selects, and the range it falls in.
 * Used by the inspector (to show "Eclipse" rather than 0.42) and by the 3D scene (gobo + wheel
 * colour). Returns null for a continuous channel.
 */
export function selectedRange(channel: ProfileChannel, value: number) {
  if (!channel.ranges?.length) return null;
  const byte = Math.round(Math.max(0, Math.min(1, value)) * 255);
  return channel.ranges.find((r) => byte >= r.from && byte <= r.to) ?? null;
}

/** The 0..1 value that lands in the middle of a discrete range — what picking a slot should author. */
export function valueForRange(range: { from: number; to: number }): number {
  return Math.round((range.from + range.to) / 2) / 255;
}

/**
 * A channel's value expressed in its PHYSICAL unit (degrees for pan/tilt), or null when it has no
 * declared range. This is the form takes are recorded in and the form the 3D scene aims with — see
 * docs/FIXTURE-LIBRARY.md on why pan/tilt are stored in degrees.
 */
export function physicalValue(channel: ProfileChannel, value: number): number | null {
  if (channel.min === undefined || channel.max === undefined) return null;
  return channel.min + (channel.max - channel.min) * Math.max(0, Math.min(1, value));
}

/** The inverse of physicalValue — degrees back to the 0..1 the fixture stores. */
export function valueFromPhysical(channel: ProfileChannel, physical: number): number | null {
  if (channel.min === undefined || channel.max === undefined) return null;
  const span = channel.max - channel.min;
  if (span === 0) return 0;
  return Math.max(0, Math.min(1, (physical - channel.min) / span));
}
