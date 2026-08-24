// WHERE THE SPEAKERS ACTUALLY ARE — transcribed from the decoder that will feed them.
//
// These are libspatialaudio's own presets (source/AmbisonicDecoder.cpp, `Configure`), not a plausible
// arrangement of the same names. That distinction is the whole value of the table: the positioner pad
// draws this, an operator reads a physical position off it, and if the drawing and the decoder disagree
// then the pad is a confident lie about where a sound will come from. Ring layouts run CLOCKWISE from a
// different start than the discrete ones do; nobody would guess that, and getting it wrong silently
// mirrors a room.
//
// ── THE ANGLE CONVENTION, AND WHY IT IS NOT THE OBVIOUS ONE ──────────────────────────────────────────
// Azimuth is ANTICLOCKWISE from front, POSITIVE = LEFT — the convention engine.cpp's `toPolar` derived
// from libspatialaudio's coefficients (`azimuth = atan2(-x, z)`). So +30° is front-LEFT, and the sign in
// `unitFor` below is not a typo. Elevation is positive UP.
//
// ── CHANNEL ORDER IS SPEAKER ORDER ───────────────────────────────────────────────────────────────────
// Index `i` here is decoder speaker `i`, which is device channel `i` unless Preferences ▸ Audio ▸ Speaker
// check patches it elsewhere (`speakerPatch`). Stereo therefore reads 0 = L, 1 = R, which is the sanity
// check to run first if any of this ever looks mirrored.

export type SpeakerLayoutId = 'stereo' | 'quad' | '5.0' | '5.1' | '7.0' | '7.1' | 'hexagon' | 'octagon' | 'cube';

export interface Speaker {
  /** Decoder speaker index = channel index before `speakerPatch`. */
  index: number;
  /** Degrees, anticlockwise from front, positive = LEFT. */
  azimuth: number;
  /** Degrees, positive = up. */
  elevation: number;
  /** Short human label ('L', 'SR', 'C'…). Absent for a ring, where the number IS the name. */
  name?: string;
  /**
   * The LFE. It has no direction — libspatialaudio parks it at the centre speaker's angle purely so the
   * array has something to hold — so drawing it on the ring would invent a position that does not exist.
   */
  lfe?: boolean;
}

// A ring, in the direction libspatialaudio builds one: NEGATIVE azimuth step, i.e. CLOCKWISE from front
// seen from above, starting `offset` degrees round.
const ring = (n: number, offset: number): Speaker[] =>
  Array.from({ length: n }, (_, i) => ({ index: i, azimuth: -(i * 360 / n + offset), elevation: 0 }));

// ITU-style discrete layouts: front pair, surrounds, rears, centre — in THAT order, which is the order
// the preset assigns them and therefore the channel order.
const itu = (spec: Array<[number, string]>): Speaker[] =>
  spec.map(([azimuth, name], index) => ({ index, azimuth, elevation: 0, name }));

const L_R: Array<[number, string]> = [[30, 'L'], [-30, 'R']];
const SURR: Array<[number, string]> = [[110, 'SL'], [-110, 'SR']];
const REAR: Array<[number, string]> = [[145, 'BL'], [-145, 'BR']];
const CENTRE: Array<[number, string]> = [[0, 'C']];

const withLfe = (base: Speaker[]): Speaker[] =>
  [...base, { index: base.length, azimuth: 0, elevation: 0, name: 'LFE', lfe: true }];

// The cube is the one 3D layout ArtLux exposes: two square rings, upper at +45° and lower at −45°, on the
// SAME four azimuths. Seen from above they land on top of each other — which is why the pad separates
// them by radius rather than by angle, and says which is which.
const cube = (): Speaker[] => [
  ...Array.from({ length: 4 }, (_, i) => ({ index: i, azimuth: -(i * 90 + 45), elevation: 45 })),
  ...Array.from({ length: 4 }, (_, i) => ({ index: i + 4, azimuth: -(i * 90 + 45), elevation: -45 })),
];

export const SPEAKER_LAYOUTS: Record<SpeakerLayoutId, Speaker[]> = {
  stereo: itu(L_R),
  quad: itu([[45, 'FL'], [-45, 'FR'], [135, 'BL'], [-135, 'BR']]),
  '5.0': itu([...L_R, ...SURR, ...CENTRE]),
  '5.1': withLfe(itu([...L_R, ...SURR, ...CENTRE])),
  '7.0': itu([...L_R, ...SURR, ...REAR, ...CENTRE]),
  '7.1': withLfe(itu([...L_R, ...SURR, ...REAR, ...CENTRE])),
  hexagon: ring(6, 30),
  octagon: ring(8, 0),
  cube: cube(),
};

/**
 * A speaker's direction as the positioner pad's own axes: +x right, +z in front of the listener.
 *
 * Inverse of engine.cpp's `toPolar` (`azimuth = atan2(-x, z)`), so a layout drawn from this and a source
 * placed by dragging the pad are expressed in the same frame — which is the only reason putting them in
 * one picture means anything.
 */
export function unitFor(s: Speaker): { x: number; z: number; y: number } {
  const az = (s.azimuth * Math.PI) / 180;
  const el = (s.elevation * Math.PI) / 180;
  const r = Math.cos(el);
  return { x: -r * Math.sin(az), z: r * Math.cos(az), y: Math.sin(el) };
}

/** Decoder speaker index → the DEVICE channel it is patched to (identity when unpatched). */
export const channelFor = (index: number, patch?: number[]): number => patch?.[index] ?? index;

/** How many speakers a layout has. The table above is the only place that knows, so ask it. */
export const speakerCount = (id?: string): number =>
  SPEAKER_LAYOUTS[(id ?? 'stereo') as SpeakerLayoutId]?.length ?? 2;

/** The device-config fields that determine a channel count. Both AudioCfg (AudioSettings.tsx) and
 *  AudioPluginCfg (plugin.renderer.ts) satisfy this structurally. */
export interface ChannelWants {
  outputChannels?: number;
  outputMode?: string;
  speakerLayout?: string;
}

/**
 * How many device channels a config actually WANTS.
 *
 * ⚠ NOT `outputChannels ?? 2`. A config that names a SPEAKER LAYOUT has already said how many outputs it
 * needs — `quad` needs four — so falling back to 2 there makes the app contradict itself out loud: it
 * asks the interface for two channels and then warns that "this layout needs 4 but the device is open
 * with 2 — raise the channel count", about a request it made itself. An operator reads that as a hardware
 * limit and goes hunting through driver control panels. (It sent one there. The interface had six.)
 *
 * An explicit value always wins, including an explicit 2 under an 8-speaker layout — that is a deliberate
 * choice to audition a big rig on a small one, and the short-channel warning is the right response to it.
 * The fallback only fills a gap, and it fills it with the only number the rest of the config implies.
 *
 * ⚠ IT LIVES HERE, NOT IN THE PANEL, BECAUSE TWO CALLERS CONFIGURE THE SAME ENGINE. AudioSettings' apply()
 * is the editor path; plugin.renderer's applyDeviceCfg is the BROADCAST/HEADLESS path — the one a venue
 * actually runs, where the panel never mounts. While the panel owned this rule privately, the driver kept
 * `outputChannels ?? 2`, so the two disagreed: the panel opened an octagon at 8 channels and reported
 * "Open: 8 ch", and the next unrelated settings change had the driver silently re-open the SAME device at
 * 2 — over a stereo rig, with the panel still showing eight. One owner, both callers.
 */
export const wantedChannels = (c: ChannelWants): number => {
  if (typeof c.outputChannels === 'number' && c.outputChannels > 0) return c.outputChannels;
  if ((c.outputMode ?? 'binaural') !== 'speakers') return 2;   // binaural is a headphone pair, always
  return speakerCount(c.speakerLayout);
};
