// WHERE A SOUND IS, AND HOW LOUD IT IS FOR BEING THERE — one model, shared by core and the audio plugin.
//
// ── WHY THIS REPLACED {x, y, z} ────────────────────────────────────────────────────────────────────
//
// A source used to be authored as a point in metres. It never was one. `engine.cpp` encodes with
// libspatialaudio's `AmbisonicEncoder`, whose own header says it "only takes the source's azimuth and
// elevation into account" — `toPolar` computes a distance and the encoder discards it. So moving a
// source from 1 m to 6 m along the same bearing was INAUDIBLE, while the pad, the readout and three
// automation targets all reported metres to two decimal places. A UI confidently describing a
// dimension the engine does not have.
//
// The model now says what the engine actually does, plus the one thing an operator kept reaching for:
//
//   angle        WHICH WAY, in degrees. The only part the encoder has ever used.
//   elevation    HOW HIGH, in degrees. Likewise.
//   attenuation  HOW FAR, expressed as what "far" is actually allowed to mean here: a level.
//
// ── ANGLE IS CLOCKWISE FROM FRONT, AND THE ENGINE'S IS NOT ────────────────────────────────────────
//
// 0 = front, 90 = RIGHT, 180 = behind, 270 = left — the bearing an operator reads off a room plan.
// The ambisonic convention underneath is the mirror of it (`azimuth = atan2(-x, z)`, POSITIVE = LEFT),
// and the two are only ever converted in `directionOf` / `angleOfVector` below. Getting this backwards
// does not fail: it silently mirrors the room, which looks right, reads right, and puts every sound on
// the wrong side. It is the same hazard the speaker table carries (plugins/audio/speakerLayouts.ts),
// and it is why each direction is expressed in exactly one function.
//
// ── ANGLE IS UNBOUNDED, AND THAT IS THE POINT ─────────────────────────────────────────────────────
//
// The widget always READS 0–360, but the stored and automated number may run past it. An automation
// lane interpolates between keyframes, so a bounded angle makes a full orbit unexpressible (0 → 360 is
// a lane that does not move) and makes 350 → 10 sweep BACKWARDS through 180, sending a sound the long
// way across the room at exactly the moment it should cross the front. Unbounded, "two turns over eight
// bars" is one straight ramp, and the short way round is simply the shorter number.
//
// ── ATTENUATION IS A LEVEL, NOT A DISTANCE CUE ────────────────────────────────────────────────────
//
// 0 = at the listener, full level. 1 = far away, silent. It is applied as GAIN, folded into the number
// the driver already pushes — no delay line, no doppler on a moving source, nothing added to the audio
// thread. libspatialaudio's `AmbisonicEncoderDist` would give real distance cues (propagation delay and
// the W-panning interior effect) and was deliberately not used: it puts a per-source delay line in the
// path, and a source moving along a delay that slides is a pitch artefact in a show bed.
//
// So the positioner pad's radius is LEVEL, not distance — the ring is full level with a well-defined
// bearing, and the centre is silence. That is not a compromise, it is where the singularity belongs:
// direction is undefined at zero radius, and at zero radius the source cannot be heard anyway.

/** A source's position. Absent on a clip ⇒ the clip is not spatialised at all. */
export interface SpatialPos {
  /** Degrees, CLOCKWISE from front (0 front, 90 right, 180 behind, 270 left). UNBOUNDED — see above. */
  angle: number;
  /** Degrees, −90 (directly below) … +90 (directly above). */
  elevation: number;
  /** 0 = at the listener (full level) … 1 = far (silent). Applied as gain. */
  attenuation: number;
  /** Ambisonic-order override for this source (default: the project/device setting). */
  order?: number;
  /**
   * MIGRATION ARTEFACT, AND ONLY THAT.
   *
   * The vector this position was converted FROM, kept so an automation lane written against the old
   * `spatial.x` / `.y` / `.z` paths still lands where it used to. Those lanes carry ONE axis each and
   * the others came from the authored vector — so replaying one needs that vector at its original
   * magnitude: an x-sweep of ±3 against z = 1.5 is ±63°, and against a unit z it would be ±71.6°.
   * Close, wrong, and wrong in the one direction nobody would think to check.
   *
   * It is inert unless such a lane exists, and it is DROPPED the moment the position is re-authored:
   * once the operator has moved the source themselves, the vector it used to be is not a fact about
   * anything. See `resolveLegacyAxes`.
   */
  legacyVec?: { x: number; y: number; z: number };
}

/** The old shape, as it still appears in unmigrated documents. */
interface LegacyVec { x: number; y: number; z: number; order?: number }

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

const finite = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? n : undefined;

/** Fold an unbounded angle into [0, 360) — for DISPLAY. Never for storage: see the header. */
export const normAngle = (deg: number): number => ((deg % 360) + 360) % 360;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * The gain a given attenuation produces.
 *
 * Quadratic, so it follows the inverse-square falloff of a real room across the 0–1 range and reaches
 * TRUE SILENCE at 1 rather than merely getting quiet. A linear law sounds like a fader rather than like
 * distance; an inverse-square law with a floor never actually goes away, which makes "fade it out into
 * the distance" impossible to author exactly.
 */
export const attenGain = (attenuation: number | undefined): number => {
  const a = clamp01(finite(attenuation) ?? 0);
  const g = 1 - a;
  return g * g;
};

/**
 * The unit direction a position points at, in the ENGINE's frame: +x right, +y up, +z front.
 *
 * Unit length on purpose — the encoder ignores magnitude, so anything else would be a number with no
 * meaning travelling to the audio thread. Attenuation is NOT applied here; it is a gain, and it is
 * folded in where gain is pushed.
 */
export function directionOf(p: SpatialPos): { x: number; y: number; z: number } {
  const el = (finite(p.elevation) ?? 0) * RAD;
  // CLOCKWISE from front → the mirror of the ambisonic azimuth. See the header.
  const az = (finite(p.angle) ?? 0) * RAD;
  const r = Math.cos(el);
  return { x: r * Math.sin(az), y: Math.sin(el), z: r * Math.cos(az) };
}

/** A vector's bearing, in this model's degrees. The inverse of `directionOf`'s horizontal half. */
export const angleOfVector = (x: number, z: number): number => normAngle(Math.atan2(x, z) * DEG);

/** A vector's elevation, in degrees. */
export const elevationOfVector = (x: number, y: number, z: number): number =>
  Math.atan2(y, Math.hypot(x, z)) * DEG;

/**
 * Coerce ANY stored spatial into the current model, or `undefined` for something that is not one.
 *
 * Accepts both shapes and is IDEMPOTENT, which is what lets it live in the sanitizers rather than in a
 * one-shot load step: `spatial` appears on the bed, on the global timeline's audio, on every scene's
 * timeline audio, and on every video clip's audio block, and a migration that had to be remembered at
 * each of those is a migration that will be forgotten at one of them.
 *
 * ⚠ A MIGRATED POSITION GETS `attenuation: 0`, NOT SOME NUMBER DERIVED FROM ITS OLD DISTANCE. The old
 * distance was inaudible (the encoder discarded it), so deriving attenuation from it would CHANGE THE
 * SOUND of every existing show on upgrade — quietly, and in proportion to how far the author happened
 * to have dragged a dot that never did anything. Full level is the only value that preserves what the
 * project actually sounded like.
 */
export function migrateSpatial(raw: unknown): SpatialPos | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Partial<SpatialPos> & Partial<LegacyVec>;
  const order = finite(s.order);

  // Already current. Checked FIRST and on `angle`, because a migrated position may still carry
  // `legacyVec` and would otherwise be re-migrated from its own artefact on every normalize.
  const angle = finite(s.angle);
  if (angle !== undefined) {
    const lv = s.legacyVec;
    const legacyVec = lv && finite(lv.x) !== undefined && finite(lv.y) !== undefined && finite(lv.z) !== undefined
      ? { x: lv.x, y: lv.y, z: lv.z } : undefined;
    return {
      angle,
      elevation: finite(s.elevation) ?? 0,
      attenuation: clamp01(finite(s.attenuation) ?? 0),
      ...(order !== undefined ? { order } : {}),
      ...(legacyVec ? { legacyVec } : {}),
    };
  }

  // The old vector. A malformed one reads as NO position — i.e. the clip is simply not spatial, which
  // is the answer the old sanitizer gave too, and is always recoverable by ticking the box again.
  const x = finite(s.x), y = finite(s.y), z = finite(s.z);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return {
    angle: angleOfVector(x, z),
    elevation: elevationOfVector(x, y, z),
    attenuation: 0,
    ...(order !== undefined ? { order } : {}),
    legacyVec: { x, y, z },
  };
}

/**
 * Fold any LEGACY per-axis automation values laid over a position back into it.
 *
 * An old lane targets `audio.clip.<id>.spatial.x` (or `.y`, `.z`), and the override layer writes that
 * leaf straight onto the spatial object — so what arrives here is a current position wearing one to
 * three vector axes. Rebuild the vector from `legacyVec` (the magnitudes those lanes were authored
 * against), substitute the driven axes, and read the bearing back out.
 *
 * Returns the position unchanged when no legacy axis is present, which is every position in every
 * document written since the migration — so this costs three property tests on the hot path.
 */
export function resolveLegacyAxes(p: SpatialPos): SpatialPos {
  const o = p as SpatialPos & Partial<LegacyVec>;
  const hx = finite(o.x), hy = finite(o.y), hz = finite(o.z);
  if (hx === undefined && hy === undefined && hz === undefined) return p;
  // No `legacyVec` means the position was re-authored after migration; the lane has no basis to
  // combine against any more, so fall back to the CURRENT direction at unit length. The lane still
  // drives its axis — it just does so against where the source is now, which is the honest answer.
  const base = p.legacyVec ?? directionOf(p);
  const x = hx ?? base.x, y = hy ?? base.y, z = hz ?? base.z;
  if (x === 0 && y === 0 && z === 0) return p;          // degenerate: keep the authored bearing
  return { ...p, angle: angleOfVector(x, z), elevation: elevationOfVector(x, y, z) };
}
