// Four beat channels — kick, snare, mid, high — by the classic algorithm.
//
// ── HOW IT WORKS ─────────────────────────────────────────────────────────────────────────────────
// A beat is not "loud". A beat is LOUDER THAN THE LAST SECOND WAS. So each channel keeps a rolling
// history of its own energy and fires when the instant energy exceeds the history's average by a
// margin — and the margin itself comes from the history's VARIANCE, which is what makes one detector
// work on a sparse dub track and a wall of distorted guitar without being retuned.
//
// That is Patin's frequency-selected energy algorithm (GameDev.net, 2003), the one behind most VJ
// software and demoscene visualisers. Two honest deviations from the paper:
//
//   · It runs on the BANDS the analyser already produces, not on raw sample energy, because the FFT
//     is computed anyway and re-deriving energy from samples would be a second, disagreeing answer.
//     Those bands are dB-normalised 0..1, so the paper's regression constants — fitted to raw energy —
//     do not carry over. The shape (threshold falls as variance rises) is kept; the numbers are
//     re-fitted below and named, rather than copied and quietly wrong.
//   · The history is TIME-based, not a fixed count of blocks. The paper assumes a fixed analysis rate;
//     this is fed from a render loop, which stutters. A one-second window measured in seconds survives
//     a dropped frame, where "the last 43 samples" silently becomes a two-second window.
//
// ── WHAT THE CHANNELS ARE ────────────────────────────────────────────────────────────────────────
// Four, split where the drums are, on the 16 log bands the analyser reports (40 Hz … 16 kHz):
//
//   0 KICK   40–180 Hz     the kick drum and the bass fundamental
//   1 SNARE  180–550 Hz    snare body, toms, the low end of most vocals
//   2 MID    550–3.5 kHz   melody, guitars, vocal presence
//   3 HIGH   3.5–16 kHz    hats, cymbals, air
//
// They overlap nothing and cover everything, which matters: a channel that shares a band with its
// neighbour fires twice for one hit.

export const CHANNELS = ['kick', 'snare', 'mid', 'high'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_COUNT = 4;

/** First band (inclusive) and last band (exclusive) of each channel, over the analyser's 16 bands. */
const RANGES: [number, number][] = [
  [0, 4],   // kick   — bands 0–3   ≈ 40–180 Hz
  [4, 7],   // snare  — bands 4–6   ≈ 180–550 Hz
  [7, 12],  // mid    — bands 7–11  ≈ 550–3.5 kHz
  [12, 16], // high   — bands 12–15 ≈ 3.5–16 kHz
];

/** One second of history, the length the original algorithm uses and a good one: long enough to know
 *  what "normal" is, short enough to follow a track that changes section. */
const WINDOW_SEC = 1.0;

/**
 * The threshold curve. A steady signal (low variance) needs a big jump to count as a beat; a signal
 * that is already jumping around (high variance) is a track with dynamics, where insisting on the same
 * margin would detect nothing at all.
 *
 * `HI` and `LO` bracket it so a pathological history cannot make the detector either deaf or hysterical.
 */
const THRESH_HI = 1.9;   // quiet, steady material: needs to be nearly twice the average
const THRESH_LO = 1.25;  // busy material: a quarter above average is a hit
const VAR_FULL = 0.02;   // variance at which the threshold has fallen all the way to THRESH_LO

/** Below this, it is silence or room tone and nothing is a beat however it compares to its own history. */
const ENERGY_FLOOR = 0.005;

/** A drum hit is one event even though its energy stays high for a moment. 100 ms ≈ 600 BPM ceiling. */
const REFRACTORY_SEC = 0.1;

/**
 * RE-ARMING, which the refractory alone cannot do.
 *
 * A held note or a long crash stays above the threshold for as long as it rings, and a refractory of
 * 100 ms simply spaces the false triggers 100 ms apart — a 400 ms sustain counted FOUR beats. So a
 * channel fires on the RISING EDGE only: after a hit it is disarmed until its energy comes back down
 * to about its own average, which happens between two drum hits and does not happen inside one.
 */
const REARM_RATIO = 1.05;

/** How fast the visible pulse falls after a hit. ~250 ms, the same envelope the bands use. */
const PULSE_FALL_PER_SEC = 4.0;

interface ChannelState {
  history: { t: number; e: number }[];
  lastHit: number;
  pulse: number;
  count: number;
  armed: boolean;
}

function fresh(): ChannelState {
  return { history: [], lastHit: -1e9, pulse: 0, count: 0, armed: true };
}

export class BeatDetector {
  private ch: ChannelState[] = RANGES.map(fresh);
  private lastT = -1;

  /** Pulse per channel, 1 at the hit and decaying — what a shader reads. */
  readonly pulses = new Float32Array(CHANNEL_COUNT);
  /** Beats counted since start, per channel. Lets a shader step on every kick. */
  readonly counts = new Float32Array(CHANNEL_COUNT);
  /** True only on the update a beat was detected. */
  readonly hits = [false, false, false, false];

  /** Forget everything — a new track, or audio that stopped and started. */
  reset(): void {
    this.ch = RANGES.map(fresh);
    this.lastT = -1;
    this.pulses.fill(0);
    this.counts.fill(0);
    this.hits.fill(false);
  }

  /**
   * Feed one analyser frame. `bands` is the 16 values; `now` is seconds (any monotonic clock).
   */
  update(bands: Float32Array, now: number): void {
    const dt = this.lastT < 0 ? 1 / 60 : Math.max(0, Math.min(0.25, now - this.lastT));
    this.lastT = now;

    for (let c = 0; c < CHANNEL_COUNT; c++) {
      const st = this.ch[c];
      const [from, to] = RANGES[c];

      // Energy as the mean SQUARE of the channel's bands. Squaring widens the gap between a hit and
      // the material around it, which is the whole signal this algorithm reads.
      let e = 0;
      for (let b = from; b < to; b++) e += bands[b] * bands[b];
      e /= to - from;

      // Roll the window before comparing, so a beat is measured against the past and not against
      // itself — including itself would raise the average by exactly the thing being tested.
      const cut = now - WINDOW_SEC;
      while (st.history.length && st.history[0].t < cut) st.history.shift();

      let hit = false;
      if (st.history.length >= 8 && e > ENERGY_FLOOR) {
        let sum = 0;
        for (const h of st.history) sum += h.e;
        const avg = sum / st.history.length;

        let vs = 0;
        for (const h of st.history) { const d = h.e - avg; vs += d * d; }
        const variance = vs / st.history.length;

        const k = Math.min(1, variance / VAR_FULL);
        const threshold = THRESH_HI + (THRESH_LO - THRESH_HI) * k;

        if (st.armed && e > avg * threshold && now - st.lastHit > REFRACTORY_SEC) {
          hit = true;
          st.armed = false;
          st.lastHit = now;
          st.count++;
          st.pulse = 1;
        } else if (!st.armed && e <= avg * REARM_RATIO) {
          st.armed = true;
        }
      }

      st.history.push({ t: now, e });
      st.pulse = Math.max(0, st.pulse - PULSE_FALL_PER_SEC * dt);

      this.hits[c] = hit;
      this.pulses[c] = st.pulse;
      this.counts[c] = st.count;
    }
  }
}
