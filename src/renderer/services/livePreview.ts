// Imperative, render-free channel for live preview updates while a slider is being
// dragged. Writing here updates a CSS variable (consumed by the stage preview canvas
// filter) and a plain value (read each frame by the Stage rAF loop to drive the GPU
// mapper) — neither path triggers a React re-render, so dragging stays smooth. React
// state is only committed on pointer release.
let brightness = 1;

// ── THE TOP OF THE FIXTURE PRECEDENCE STACK ──────────────────────────────────────────────────
//
//   profile default < authored Fixture.dmx < lighting clip < pose cue < automation lane < LIVE
//
// The packer has named `live override` as that top layer since lighting shipped, and
// services/lightingCue's header calls it "the render-free channel a fader drag writes to" — but
// nothing implemented it, so a fader drag was not live at all. `Slider` commits on pointer RELEASE
// (that is deliberate: a React write per drag tick re-renders the whole app and, through
// handleUpdateFixture, would push an undo entry per tick), which meant the head did not move until
// you let go. Measured on the wire: a four-second pan drag produced ONE transition, at the release.
//
// That is not merely unresponsive — it silently broke take recording, because
// services/lightingRecorder samples the RESOLVED fixture signal and the resolved signal is computed
// from committed state. A busk therefore recorded a STEP, not a movement:
//
//     pan [[0.02, 136.4], [5.68, 136.4], [5.83, 403.6], [10.11, 403.6]]
//
// This map is what closes that hole. It is keyed by (fixture, channel key) rather than by role
// because a fader IS a channel — everything below this layer speaks roles, and converting a drag
// into role space and back would only add a rounding step to a value we already have exactly.
//
// ⚠ AN ENTRY MUST NOT OUTLIVE THE HAND. It sits above a lighting clip, so a stranded entry would
// pin a channel and quietly beat the show. Retirement is therefore belt AND braces: `release`
// marks the entry settling, and it retires either the moment the committed value catches up (frame
// exact, no flicker across React's commit) or after SETTLE_MS regardless, whichever comes first.
const SETTLE_MS = 500;
interface LiveChannel { v: number; settlingAt: number | null }
const channels = new Map<string, LiveChannel>();
const key = (fixtureId: string, channelKey: string): string => `${fixtureId}\u0000${channelKey}`;

export const livePreview = {
  get brightness() {
    return brightness;
  },
  setBrightness(v: number) {
    brightness = v;
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--preview-brightness', String(v));
    }
  },

  /** A fader under a hand right now. Called per drag tick; never touches React. */
  setFixtureChannel(fixtureId: string, channelKey: string, v: number): void {
    channels.set(key(fixtureId, channelKey), { v, settlingAt: null });
  },

  /**
   * The hand let go. The entry keeps driving until the committed value catches up, so the handover
   * from this layer back to `Fixture.dmx` costs no frame in which the rig snaps to the old value.
   */
  releaseFixtureChannel(fixtureId: string, channelKey: string): void {
    const e = channels.get(key(fixtureId, channelKey));
    if (e && e.settlingAt === null) e.settlingAt = performance.now();
  },

  /** Lets the packer skip the per-channel lookup entirely when nothing is being dragged. */
  get liveChannels(): number { return channels.size; },

  /**
   * What the live layer says this channel is, or undefined.
   *
   * `authored` is the committed value (`Fixture.dmx[key]`), and passing it in is what makes
   * retirement exact rather than timed: a released entry stands down the first frame the document
   * agrees with it.
   */
  readFixtureChannel(fixtureId: string, channelKey: string, authored: number | undefined): number | undefined {
    const k = key(fixtureId, channelKey);
    const e = channels.get(k);
    if (!e) return undefined;
    if (e.settlingAt !== null
      && ((authored !== undefined && authored === e.v) || performance.now() - e.settlingAt > SETTLE_MS)) {
      channels.delete(k);
      return undefined;
    }
    return e.v;
  },

  /** Project load, or a fixture deleted under a drag. */
  clearFixtureChannels(): void { channels.clear(); },
};
