// audio — renderer activation. Registers the Audio settings section + the 'audio' clip-kind (every
// window), and — in the main window only — configures the native engine and runs the AUDIO SCHEDULER.
//
// ONE TRANSPORT, TWO PLAYHEADS, TWO CONTAINERS. THE CLOCK FOLLOWS THE CONTAINER, NOT THE PANEL:
//
//   · THE BED (ProjectData.audio, host.audio.getMix()) rides the SHOW CLOCK
//     (host.show.getStatus().showTime). A scene recall does NOT move that number, so the bed plays
//     straight through a GO. It is NOT on the bound document's playhead: a recall restarts that number,
//     and an inferred seek off it used to stop and restart a five-minute ambient bed on every GO.
//
//   · A TIMELINE'S OWN AUDIO (Timeline.audio, host.audio.getTimelineAudio()) rides the PLAYHEAD, and
//     therefore RESTARTS WITH ITS TIMELINE. That is its contract, not a bug: a scene's sting begins at
//     the scene's top, every time it is recalled.
//
// The two are reconciled by ONE function against TWO clocks (reconcile → reconcileContainer), and the
// clock is passed together with the clip array so it can never be applied to the wrong one — which is
// the entire bug class this file exists to keep dead. Mute/solo are scoped PER CONTAINER for the same
// reason (two mixes, two clocks).
//
// The native engine owns sample-accurate playback; this driver is a SCHEDULER. Each frame it reconciles
// which clips should be sounding and starts/stops/re-syncs them. onPlayhead fires every frame INCLUDING
// WHILE PAUSED (the clock just freezes), so pause is detected by polling host.show.getStatus().playing —
// never by "the callback stopped". Big jumps (beyond wall-clock expectation) hard-resync, PER CLOCK;
// small seeks + live retime/gain edits are caught per-clip by comparing each sounding clip's desired vs
// estimated source offset — which is ALSO why the show clock's park (getStatus().showEnded) must
// short-circuit the BED: drift re-locking against a frozen number re-seeks forever. `showEnded` is
// BED-SCOPED — the show ending must not silence a scene's own audio, which is on the playhead and knows
// nothing about the show's end.
//
// The engine has NO envelope (it takes a flat gain per clip), so a clip's fadeIn/fadeOut is a
// JS-scheduled gain, recomputed each frame from the clip-local time (fadeGain). Bus effects and sends
// are later phases.

import type { RendererPlugin, RendererPluginContext, RendererHostServices } from '@artlux/sdk/renderer';
import { setIpc, audioClient } from './audioClient';
import { setAudioHost } from './audioHost';
import { AudioSettings } from './AudioSettings';
import { AudioBedPanel } from './AudioBedPanel';
import type { AudioEffectSpec, ClipMeta, OutputMode, SpeakerLayout } from './audioManager';
import { MASTER_BUS_ID } from './effectDefs';
import {
  audioAutomationProvider, autoOrFadeGain, autoOrFadeTrackGain, autoOrFadeMasterGain,
  applyClipLayers, applyBusLayers, hasAnyOverride, takeDirty, boundGain,
} from './automationTargets';

interface AudioPluginCfg { outputChannels?: number; outputMode?: OutputMode; speakerLayout?: SpeakerLayout }

// Minimal structural view of the two persisted containers the driver reads (host.audio.getMix() and
// host.audio.getTimelineAudio()). The concrete AudioMix/TimelineAudio live in the host types; we only read
// these fields, so a local shape avoids a cross-package import. Both containers hold the SAME clip and
// track shapes — which is why one reconcile serves both.
interface BedClip { id: string; trackId: string; path: string; start: number; duration: number; inPoint: number; gain?: number; mute?: boolean; fadeIn?: number; fadeOut?: number; spatial?: { x: number; y: number; z: number }; effects?: AudioEffectSpec[] }
interface BedTrack { id: string; gain?: number; mute?: boolean; solo?: boolean }
interface BedBus { id: string; gain?: number; effects?: AudioEffectSpec[] }
interface Bed { tracks: BedTrack[]; clips: BedClip[]; buses: BedBus[] }
// The BOUND timeline's own audio — same clip/track shape, no buses (there is exactly ONE output chain,
// and an output chain cannot be per-scene).
interface TlAudio { tracks: BedTrack[]; clips: BedClip[] }

const SEEK_THRESHOLD = 0.2;  // s — tick-level clock jump beyond wall-clock expectation ⇒ hard resync (per clock)
const SYNC_THRESHOLD = 0.05; // s — per-clip source-offset drift (retime / missed small seek) ⇒ re-seek

let unsubTick: (() => void) | null = null;
let unsubMix: (() => void) | null = null;

// The fallbacks for a junk container, as SHARED FROZEN CONSTANTS — never fresh literals. readTlAudio runs
// EVERY FRAME and pruneOrphans gates on the clip array's IDENTITY, so a fresh `[]` per call would defeat
// that gate for exactly the malformed document the fallback exists to survive: pruneOrphans would see a
// "new" array 60×/s and kick a syncLoaded pass on every frame, forever. (App.tsx's EMPTY_TIMELINE_AUDIO
// makes the same guarantee one layer up, for the legacy doc with no `audio` at all; this is the same
// promise held against a host that hands us something worse than undefined. Frozen: the driver only ever
// reads and spreads these.)
const EMPTY_CLIPS = Object.freeze([]) as unknown as BedClip[];
const EMPTY_TRACKS = Object.freeze([]) as unknown as BedTrack[];
const EMPTY_BUSES = Object.freeze([]) as unknown as BedBus[];

function readBed(host: RendererHostServices): Bed {
  const mix = (host.audio.getMix() as Partial<Bed>) ?? {};
  return {
    tracks: Array.isArray(mix.tracks) ? mix.tracks : EMPTY_TRACKS,
    clips: Array.isArray(mix.clips) ? mix.clips : EMPTY_CLIPS,
    buses: Array.isArray(mix.buses) ? mix.buses : EMPTY_BUSES,
  };
}
function readTlAudio(host: RendererHostServices): TlAudio {
  const a = (host.audio.getTimelineAudio() as Partial<TlAudio>) ?? {};
  return {
    tracks: Array.isArray(a.tracks) ? a.tracks : EMPTY_TRACKS,
    clips: Array.isArray(a.clips) ? a.clips : EMPTY_CLIPS,
  };
}

export const plugin: RendererPlugin = {
  manifest: { id: 'audio', name: 'Audio', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    setIpc(ctx.ipc);
    ctx.settings.register({ id: 'audio', title: 'Audio', Component: AudioSettings });
    // Audio clips carry no visual — keep them off the video-sync path and out of the PROGRAM composite.
    // MUST register in every window (main + projector), like tracking/mediapipe/augmenta.
    ctx.clipKinds.register({ kind: 'audio', excludeFromProgram: true, skipVideoSync: true });
    // Audio Bed authoring panel (global bed → ProjectData.audio). Modal, toggled from View ▸ Audio Bed.
    ctx.panels.register({ id: 'audio-bed', mount: 'modal', menuAction: 'audio-bed', title: 'Audio Bed', Component: AudioBedPanel });

    // Only the main editor/broadcast window drives the engine + bed playback.
    if (ctx.window !== 'main') return;

    const host = ctx.host as RendererHostServices;
    setAudioHost(host); // let the Audio Bed panel reach host.audio/host.show
    ctx.automationTargets.register(audioAutomationProvider); // the 'audio.*' namespace: bed gain/position/effect params

    // Open the device once on startup (default device, persisted channel count). Idempotent engine-side.
    const s0 = host.settings.get() as { plugins?: Record<string, unknown> };
    const cfg = (s0.plugins?.['audio'] as AudioPluginCfg) ?? {};
    void audioClient
      .configure(cfg.outputChannels ?? 2, cfg.outputMode ?? 'binaural', cfg.speakerLayout ?? 'stereo')
      .catch(() => { /* engine absent → no-op */ });

    // ── Audio scheduler: TWO containers, TWO clocks ───────────────────────────────────────────
    let bed: Bed = readBed(host);            // ProjectData.audio — the BED. Show clock.
    let tlAudio: TlAudio = readTlAudio(host); // the BOUND timeline's own audio. Playhead.
    // The bed changes only through App state, so it is re-read on the host fan-out. The BOUND timeline's
    // audio is re-read EVERY FRAME (top of tick) instead: a recall repoints the engine and mainSeeks the
    // playhead synchronously, in the same frame this driver ticks in, while App's re-render is still a
    // frame away. Caching this one across that gap would reconcile the OUTGOING scene's clips against the
    // INCOMING scene's playhead — restarting a clip that begins at t=0 from its top for a frame or two, on
    // every GO. host.audio.getTimelineAudio() reads the ENGINE's bound document, so a per-frame read is
    // always the doc the playhead belongs to. (It is a ref read + two Array.isArray checks; the fan-out is
    // still what drives syncLoaded, i.e. what actually loads and unloads engine-resident sources.)
    const refreshTlAudio = () => { tlAudio = readTlAudio(host); };
    // Last frame's clip arrays, by REFERENCE — the cheap change detector for pruneOrphans below.
    let prevBedClips: BedClip[] = bed.clips;
    let prevTlClips: BedClip[] = tlAudio.clips;
    // EVERY per-clip map below (loaded/sounding/sentGain/sentOffset/…) is keyed by CLIP ID and is SHARED
    // across both containers. Clip ids are UUIDs, so they cannot collide — and sharing means one
    // syncLoaded, one reconcile-shaped code path, and no chance of the two drifting apart.
    const allClips = (): BedClip[] => [...bed.clips, ...tlAudio.clips];
    const loaded = new Map<string, ClipMeta>();   // clip source loaded in the engine
    const loading = new Set<string>();            // loads in flight (dedupe overlapping syncLoaded runs)
    const failed = new Set<string>();             // sources that failed to decode (don't retry every bed edit)
    // PATHS already reported as undecodable. `failed` is keyed by clip ID and is CORRECTLY cleared when a
    // clip leaves both containers (a re-added or re-pointed clip must get another try) — but that means an
    // FSM cycling a scene whose sting has a broken path re-attempts the decode on EVERY entry, and would
    // otherwise re-log on every entry too: an unattended installation cycling a show for a week would grow
    // a renderer console of millions of identical lines. The RETRY is deliberate (an operator who fixes the
    // file on disk gets sound back on the next recall, with no restart); only the LOG is deduped, per
    // source, for the lifetime of the window.
    const warnedPaths = new Set<string>();
    // THE PATH each id was loaded (or attempted) FROM. `loaded` alone is keyed by clip ID, and an id is NOT
    // a source: `handleAddScene` captures a scene with `structuredClone(activeTimeline)`, so a scene's
    // Timeline.audio inherits the global doc's clip ids VERBATIM — ids are now legitimately shared across
    // containers and across documents. Re-point one copy at another file (a re-link, a Save-As that remaps
    // asset paths onto the same ids, a hand-merged project) and an id-keyed residency check would say
    // "already loaded" and go on playing THE OTHER FILE, silently, forever. Comparing the path is what
    // makes the check a check on the SOURCE rather than on the NAME of the source.
    const srcPath = new Map<string, string>();
    let loadGen = 0;                              // generation of the newest syncLoaded pass — see syncLoaded
    const sounding = new Set<string>();           // clips the engine is currently playing
    const sentGain = new Map<string, number>();   // last gain pushed, per sounding clip
    const sentOffset = new Map<string, number>(); // last source offset seeked, per sounding clip
    const sentWallMs = new Map<string, number>(); // wall-clock (ms) at that seek — to estimate engine drift
    const sentSpatial = new Map<string, string>(); // last ambisonic position pushed ('' = non-spatial)
    const sentEffects = new Map<string, string>(); // last effect chain pushed, per clip (JSON)
    let sentMaster = '';                           // last master chain pushed (JSON)
    let sentMasterGain = NaN;                      // NaN ⇒ never pushed, so the first sync always lands
    let prevPlaying = false;
    let prevShowTime = 0;   // the BED rides the SHOW clock — see tick()
    let prevPlayhead = 0;   // the BOUND timeline's own audio rides the PLAYHEAD — its own seek test
    let prevWallMs = 0;

    // Track lookup spans both containers. Ids are UUIDs, so "the bed's first, else the bound timeline's"
    // is just "find it", not a precedence rule. (Solo/mute are NOT looked up through here — they are
    // container-scoped; see audibleIn.)
    const trackOfClip = (clip: BedClip): BedTrack | undefined =>
      bed.tracks.find((t) => t.id === clip.trackId) ?? tlAudio.tracks.find((t) => t.id === clip.trackId);
    // THE CLIP'S FADE ENVELOPE at a given container-clock time. Linear in gain (not dB) — this is a
    // clip-edge fade, not a mix fade, and every DAW draws it as the straight line the lane draws.
    //
    // The engine takes a FLAT gain per clip and has no envelope of its own, so the ramp is JS-scheduled:
    // reconcileContainer re-pushes gain only when it actually CHANGES (sentGain), so a steady clip costs
    // ZERO IPC and a fading one costs one setClipGain per frame — precisely what a moving automation lane
    // already costs, on the same audio lock.
    //
    // Overlapping fades on a clip shorter than fadeIn + fadeOut MULTIPLY, which is the correct and
    // conventional behaviour (the clip simply never reaches unity). The lane's trim clamps each fade to
    // the clip's duration, so neither can exceed it on its own. Every guard here is against a fade that
    // reached us anyway: a negative or zero length is ignored (no division), and the ratios are clamped at
    // 0 so a tLocal outside [0, duration] — which reconcileContainer's window test forbids, but which a
    // NaN duration would not — can never produce a negative gain.
    const fadeGain = (clip: BedClip, tLocal: number): number => {
      let g = 1;
      const fi = clip.fadeIn ?? 0;
      if (fi > 0 && tLocal < fi) g *= Math.max(0, tLocal / fi);
      const fo = clip.fadeOut ?? 0;
      if (fo > 0) {
        const left = clip.duration - tLocal;
        if (left < fo) g *= Math.max(0, left / fo);
      }
      return g;
    };
    // AUTOMATION **AND SCENE/CUE FADES** READ THROUGH HERE — and the read ORDER is the priority:
    //
    //     lane override  ??  scene/cue fade  ??  the authored value
    //
    // Neither writer touches the bed or the engine. reconcile() below re-reads the clip from its container
    // every frame, so a value pushed straight to the engine would be overwritten with the AUTHORED one on
    // the same frame, 60 times a second. Every driver read of an automatable leaf therefore goes through
    // `eff`/`effGain`, and A LANE ALWAYS WINS OVER A SCENE FADE because the lane's value SHADOWS the fade's
    // in the very read that reaches the engine — no owns() query, no race, no ordering to get wrong.
    // Disabling the lane doesn't "restore" anything: the fade is simply visible again, one layer down.
    //
    // ⚠ Do not conflate this with `fadeGain` above. That is a CLIP's fadeIn/fadeOut ENVELOPE (a property of
    // the clip's own edges); the `fade` layer inside automationTargets is a scene/cue RECALL. Two different
    // things that both got called "fade", kept apart by module.
    //
    // (These enumerate the BED's and the bound timeline's clips alike — they are path lookups, keyed by clip
    // id, so a Timeline.audio clip a cue fades is honoured too.)
    // `tLocal` is the clip-local time on the clip's OWN container clock: the envelope is a property of the
    // clip's position in ITS timeline, so passing it in is what keeps the two clocks from crossing.
    //
    // ⚠ boundGain IS THE ENGINE DOOR (see automationTargets). The lane and the fade are already clamped to
    // the target's declared range; the PERSISTED clip/track gain never was — sanitizeAudioClip coerces it
    // for finiteness only. A `"gain": 20` in the file played at 20×. It is bounded HERE, per factor, and
    // NOT in the normalizer, which would persist the clamp on the next save and destroy the authored value.
    const effGain = (clip: BedClip, tLocal: number) =>
      boundGain(autoOrFadeGain(clip.id) ?? clip.gain)
      * boundGain(autoOrFadeTrackGain(clip.trackId) ?? trackOfClip(clip)?.gain)
      * fadeGain(clip, tLocal);
    /** The clip as it should SOUND: authored, with the scene fade laid on, with the lane's leaves over that. */
    const eff = (clip: BedClip): BedClip => (hasAnyOverride(clip.id) ? applyClipLayers(clip) : clip);
    // MUTE **AND SOLO** — solo has been persisted and silently ignored since Wave 3, and the lane's gutter
    // now offers the button, so ignoring it would make the button a lie.
    //
    // Scoped PER CONTAINER, and the container's track list is passed in rather than looked up: soloing a
    // BED track silences the other BED tracks, not the bound timeline's audio, and vice versa. They are two
    // mixes on two clocks; a solo reaching across them would make no sense to an operator.
    const anySolo = (tracks: BedTrack[]) => tracks.some((t) => t.solo);
    const audibleIn = (clip: BedClip, tracks: BedTrack[]) => {
      const tr = tracks.find((t) => t.id === clip.trackId);
      if (clip.mute || tr?.mute || !loaded.has(clip.id)) return false;
      if (anySolo(tracks) && !tr?.solo) return false; // solo is INVERTED: any solo ⇒ every non-soloed track is silent
      return true;
    };

    const startClip = (clip: BedClip, srcOffset: number, tLocal: number, nowMs: number) => {
      const g = effGain(clip, tLocal);
      audioClient.playClip(clip.id, srcOffset, g); // playClip seek is a SOURCE offset
      sounding.add(clip.id); sentGain.set(clip.id, g); sentOffset.set(clip.id, srcOffset); sentWallMs.set(clip.id, nowMs);
    };
    const stopSounding = (id: string) => {
      audioClient.stopClip(id);
      sounding.delete(id); sentGain.delete(id); sentOffset.delete(id); sentWallMs.delete(id);
    };
    const stopAllSounding = () => {
      audioClient.stopAll();
      sounding.clear(); sentGain.clear(); sentOffset.clear(); sentWallMs.clear();
    };

    // Reconcile engine-resident sources with BOTH containers (`allClips()`). Removed clips are
    // stopped+unloaded FIRST — a fire-and-forget path that is never blocked by a slow load (so deleting a
    // sounding clip silences it immediately). New clips load behind an in-flight guard; a clip removed
    // while its load is pending is unloaded once the load resolves rather than orphaned in the mixer.
    //
    // "Removed" INCLUDES "belongs to the scene we just left": leaving a scene drops its Timeline.audio from
    // `allClips()`, so its sources are unloaded, and re-entering it loads them again (asynchronously — its
    // clips are inaudible until the decode lands, exactly as on a first drop). The bed is never affected.
    //
    // ⚠ KNOWN LIMITATION — NO AUDIO PRELOAD TIER YET. Because residency tracks the two LIVE containers, a
    // scene's sting is decoded on ENTRY, every entry. pruneOrphans now starts that decode on the recall
    // FRAME (rather than a React commit later), but a decode is not instant, and reconcileContainer starts
    // a clip at `clip.inPoint + tLocal` — i.e. wherever the playhead has REACHED by the time the source
    // lands. So a clip at start=0 loses its first few ms: for a percussive sting, that is its attack. And an
    // FSM cycling scenes re-decodes the same files on every cycle, forever, unattended.
    //
    // The fix is a preload tier, not a change here: `timelinePreloader.warm(scene.id, tl)` is ALREADY called
    // for every scene recall (App.tsx swapTimelineForScene) and by the FSM look-ahead effect — it warms
    // VIDEO only. Teaching it to keep audio sources engine-resident (path-keyed, LRU) would make entry
    // sample-accurate and end the re-decode churn. Doing it HERE is not possible: the driver sees only the
    // two bound containers, so it cannot tell "this scene departed" (keep it warm) from "this clip was
    // DELETED" (unload it now) — that distinction lives in App, which is why the preloader is the seam.
    // Tracked as a Wave-B follow-up; until it lands, author a scene's sting with a few ms of head, and do
    // not rely on a zero-start sting for a hard musical hit.
    //
    // GENERATION-GUARDED. The pass snapshots `allClips()` and then awaits one decode at a time, so a GO
    // mid-pass would otherwise leave it decoding the DEPARTED scene's snapshot to completion — every
    // remaining clip fully decoded over IPC and then thrown away by the post-await re-check below.
    // Residency stays correct either way, but on a GO-GO-GO sequence the driver would spend its whole
    // decode budget on scenes that are already gone, CONTENDING WITH THE LIVE SCENE'S LOADS — i.e. adding
    // latency to exactly the cue the operator is waiting to hear. `loadGen` is bumped by every new pass, so
    // an outrun pass stops before STARTING any further decode.
    //
    // The guard is at the top of the loop body and nowhere else, deliberately: a decode already IN FLIGHT
    // is always completed and stored. A concurrent newer pass SKIPS an id it finds in `loading` (it expects
    // this pass to finish it), so bailing out of a resolved load would strand that clip unloaded with
    // nobody left to pick it up. Bail before you start, never after.
    const syncLoaded = async () => {
      const myGen = ++loadGen;
      const clips = allClips();
      // id → path. A clip whose PATH changed is NOT the same source, even though it is the same id — see
      // `srcPath`. Treat it as removed (unload) so the loop below reloads it from the new file.
      const wanted = new Map<string, string>();
      for (const c of clips) wanted.set(c.id, c.path);
      const stale = (id: string) => !wanted.has(id) || wanted.get(id) !== srcPath.get(id);
      for (const id of [...loaded.keys()]) {
        if (stale(id)) {
          if (sounding.has(id)) stopSounding(id);
          audioClient.unloadClip(id);
          loaded.delete(id);
          srcPath.delete(id);
          // The engine dropped the source AND its chain — forget what we pushed, so a clip that comes
          // back (undo, re-add) gets its position and effects re-sent rather than assumed still applied.
          sentSpatial.delete(id);
          sentEffects.delete(id);
        }
      }
      // A re-added clip gets another try — and so does a clip RE-POINTED at a different file after the old
      // one failed to decode. `failed` must never outlive the source it is about.
      for (const id of [...failed]) if (stale(id)) { failed.delete(id); srcPath.delete(id); }
      for (const clip of clips) {
        if (loadGen !== myGen) return; // a newer pass owns the containers now — don't start another decode
        if (loaded.has(clip.id) || loading.has(clip.id) || failed.has(clip.id) || !clip.path) continue;
        loading.add(clip.id);
        srcPath.set(clip.id, clip.path); // record the ATTEMPTED path, so a failure is remembered per-source
        try {
          const meta = await audioClient.loadClip(clip.id, clip.path);
          if (meta) {
            // Re-check against a FRESH allClips(): the containers can have changed across the await (a
            // scene recall swapped the bound timeline out from under this load). Same id AND same path —
            // an id re-pointed mid-decode is not the source we just decoded.
            const live = allClips().find((c) => c.id === clip.id);
            if (live && live.path === clip.path) {
              loaded.set(clip.id, meta);
              // Push THIS clip's position + effects immediately, before awaiting the next load. The
              // moment it lands in `loaded` it becomes audible() — and the playhead tick is rAF-driven,
              // so reconcile() can start it on the very next frame. Deferring the push to the end of the
              // pass would let it begin life dry and dead-centre while the rest of the bed decodes.
              pushClipParams(eff(live)); // eff(), not the raw clip — a lane may already own some of its leaves
            } else {
              audioClient.unloadClip(clip.id); // removed (or re-pointed) while loading → don't leave it resident
              srcPath.delete(clip.id);
              if (live) {
                // Still wanted, but from a DIFFERENT file: re-pointed while this decode was in flight. Any
                // concurrent pass SKIPPED this id because it was in `loading`, so nothing else will pick
                // the new source up. Re-run once the `finally` below has released the id. This fires only
                // on an actual re-point, so it cannot loop.
                void Promise.resolve().then(() => { void syncLoaded().then(syncClips); });
              }
            }
          } else {
            // NO META, NO THROW — the engine is ABSENT (plugin.main's graceful degrade: with the native
            // addon missing, audioManager.loadClip returns null and the invoke RESOLVES null; see
            // audioClient.ts:21). That is not a bad source, so the id must NOT go into `failed` — it stays
            // retryable, and the next container change picks it up. But it is not in `loaded` either, and
            // `srcPath` is only ever cleaned for ids in one of those two maps — so without this the ATTEMPT
            // record written at the top of the loop would outlive the clip itself (the one hole in
            // srcPath's cleanup). Drop it here and the invariant holds unconditionally:
            //     srcPath's keys ⊆ loaded ∪ failed ∪ in-flight.
            srcPath.delete(clip.id);
          }
        } catch {
          // Undecodable / missing source (loadClip rejects). Skip it and remember: one bad clip must never
          // abort the pass (that would silence every clip after it) nor retry-storm on every bed edit.
          failed.add(clip.id);
          // Deduped per SOURCE (see warnedPaths): the retry cadence is one attempt per scene entry, and a
          // show cycling that scene unattended for days must not log the same broken path a million times.
          if (!warnedPaths.has(clip.path)) {
            warnedPaths.add(clip.path);
            console.warn('[audio] clip failed to load (retried on each re-entry; logged once):', clip.path);
          }
        } finally { loading.delete(clip.id); }
      }
    };

    // Push one clip's ambisonic position (or clear it back to non-spatial), and its insert chain. Both
    // are change-detected: dragging a source around the pad must not spam IPC, and EVERY setClipEffects
    // takes the audio lock, so re-sending an unchanged chain would tax the audio thread for nothing.
    // Only a LOADED clip can be pushed — the engine attaches these to a source it holds, so a push for an
    // id it hasn't loaded is silently dropped.
    const pushSpatial = (clip: BedClip) => {
      const s = clip.spatial;
      const key = s ? `${s.x},${s.y},${s.z}` : '';
      if (sentSpatial.get(clip.id) === key) return;
      if (s) audioClient.setClipSpatial(clip.id, s.x, s.y, s.z);
      else audioClient.clearClipSpatial(clip.id);
      sentSpatial.set(clip.id, key);
    };
    const pushEffects = (clip: BedClip) => {
      const fx = clip.effects ?? [];
      const key = JSON.stringify(fx);
      if (sentEffects.get(clip.id) === key) return;
      audioClient.setClipEffects(clip.id, fx);
      sentEffects.set(clip.id, key);
    };
    // Spatial BEFORE effects: flipping a clip spatial changes its chain's channel count (the engine runs
    // a spatial source's chain in mono), which forces a rebuild — effects-first would just throw it away.
    const pushClipParams = (clip: BedClip) => { pushSpatial(clip); pushEffects(clip); };

    const syncMaster = () => {
      const authored = bed.buses.find((b) => b.id === MASTER_BUS_ID);
      const master = authored ? applyBusLayers(authored) : undefined;
      const mfx = master?.effects ?? [];
      const mkey = JSON.stringify(mfx);
      if (sentMaster !== mkey) { audioClient.setMasterEffects(mfx); sentMaster = mkey; }
      // laneOvr ?? sceneFade ?? authored. NOTE the `authored === undefined` hole this leaves open: a project
      // that has never touched the master has no master BUS, so a scene fading `audio.master.gain` still
      // lands — autoOrFadeMasterGain() is a path lookup, not a bus read. That is deliberate: D5's headline
      // recall must work on a bed the operator never opened the mixer for.
      // Bounded at the same door, for the same reason: the master BUS's persisted gain has no normalizer at
      // all (normalizeAudioMix's buses are a shape guard — its own comment says so), and the native side
      // jlimits at 4.0, i.e. +12 dB. The faders, the cue door and the automation engine all cap at 1.5.
      const mgain = boundGain(autoOrFadeMasterGain() ?? master?.gain);
      if (sentMasterGain !== mgain) { audioClient.setMasterGain(mgain); sentMasterGain = mgain; }
    };
    const syncClips = () => {
      for (const clip of allClips()) if (loaded.has(clip.id)) pushClipParams(eff(clip));
      syncMaster();
    };

    // ONE reconcile, iterated over EACH container with ITS OWN clock. `clips`, `tracks` and `clock` travel
    // TOGETHER — the container's clock can never be applied to the wrong array, and its solo/mute scope
    // can never leak into the other one. That is the entire bug class this wave exists to kill, closed by
    // the signature rather than by a comment.
    //
    // `clock` — NOT "playhead". Naming it `playhead` would be a standing invitation to feed the bound doc's
    // time to the bed again (the bed takes st.showTime; the bound timeline's audio takes the playhead).
    const reconcileContainer = (clips: BedClip[], tracks: BedTrack[], clock: number, nowMs: number) => {
      for (const clip of clips) {
        const inWindow = clock >= clip.start && clock < clip.start + clip.duration;
        const isSounding = sounding.has(clip.id);
        const tLocal = clock - clip.start;   // clip-local time — the fade envelope's input
        const ok = audibleIn(clip, tracks);
        if (inWindow && ok && !isSounding) {
          startClip(clip, clip.inPoint + tLocal, tLocal, nowMs);
        } else if (isSounding && (!inWindow || !ok)) {
          stopSounding(clip.id);
        } else if (isSounding) {
          // In-window, audible, already sounding — track live gain (which now MOVES, every frame, during a
          // fadeIn/fadeOut) and re-lock after a retime / small seek the tick-level detector missed.
          const g = effGain(clip, tLocal);
          if (sentGain.get(clip.id) !== g) { audioClient.setClipGain(clip.id, g); sentGain.set(clip.id, g); }
          const desired = clip.inPoint + tLocal;
          // Estimate where the engine's source cursor is now (it advanced in real time since the last seek).
          // During steady playback desired ≈ estimated (both derive from performance.now); a retime or a
          // small seek the tick-level detector missed makes them diverge → re-seek to re-lock to the clock.
          // ⚠ THIS IS WHY A FROZEN CLOCK IS A DEFECT AND NOT A NO-OP: park `clock` and `desired` freezes
          // while `estimated` runs on, so this fires every ~50 ms forever, re-seeking to the same offset —
          // a buzz. reconcile()'s `showEnded` arm exists to keep a parked clock out of here entirely.
          const estimated = (sentOffset.get(clip.id) ?? desired) + (nowMs - (sentWallMs.get(clip.id) ?? nowMs)) / 1000;
          if (Math.abs(desired - estimated) > SYNC_THRESHOLD) {
            audioClient.playClip(clip.id, desired, g);
            sentOffset.set(clip.id, desired); sentWallMs.set(clip.id, nowMs);
          }
        }
      }
    };
    // A SOUNDING CLIP THAT HAS LEFT BOTH CONTAINERS IS STOPPED HERE, ON THE FRAME IT DISAPPEARS.
    //
    // reconcileContainer can only stop a clip it ITERATES, and a clip that is gone from its container is
    // never iterated again — so without this, silencing the outgoing scene's audio would be left entirely
    // to syncLoaded's unload pass, which runs off App's fan-out, i.e. a React commit later. That is a
    // guaranteed audible tail on every GO, and if the fan-out ever failed to fire (a dep dropped from that
    // effect, a container swapped by a path App doesn't re-render for) the outgoing scene's audio would
    // simply play FOREVER, over the incoming scene, in a venue, with nobody there. The driver must not need
    // to be TOLD to go silent.
    //
    // Gated on array IDENTITY (not content): the clip arrays are replaced wholesale by the engine's swap()
    // and by every commit, so a reference compare catches every real change for two compares a frame and
    // allocates nothing on the steady path. (That is also why host.audio.getTimelineAudio() must return a
    // CONSTANT for a document with no `audio` — App.tsx's EMPTY_TIMELINE_AUDIO. A fresh literal per call
    // would defeat this gate and run the whole body 60×/s.)
    //
    // ...AND IT MUST NOT NEED TO BE TOLD TO GO LOUD, EITHER. The container the driver reconciles comes from
    // the ENGINE (host.audio.getTimelineAudio() → timeline.getBoundAudio(), read every frame). But the only
    // thing that LOADS the incoming clips' sources is App's `useEffect(…, [audioMix, activeTimeline])` — a
    // REACT-STATE-sourced signal. Those two co-move today (every timelineEngine.swap() call site also sets
    // activeSceneId — all five checked), but nothing ENFORCES it: add one swap() that doesn't touch
    // activeSceneId (a future FSM path, a plugin-driven recall) and you get a scene whose audio container is
    // bound, reconciled, and PERMANENTLY SILENT — no error, no log, nothing on the mixer to see it. So the
    // identity gate the driver already owns kicks the load pass itself. syncLoaded is idempotent
    // (loaded/loading/failed/srcPath guards) and generation-guarded, so the fan-out's own call a commit
    // later is a no-op — and until then this has ALREADY started the decode, which is a whole React commit
    // shaved off the latency of a scene's sting.
    const pruneOrphans = () => {
      if (bed.clips === prevBedClips && tlAudio.clips === prevTlClips) return;
      prevBedClips = bed.clips; prevTlClips = tlAudio.clips;
      void syncLoaded().then(syncClips); // the containers moved: load what arrived, unload what left
      if (sounding.size === 0) return;
      const live = new Set(allClips().map((c) => c.id));
      for (const id of [...sounding]) if (!live.has(id)) stopSounding(id);
    };

    // THE TWO CLOCKS, ROUTED. `showEnded` is BED-SCOPED and nothing else: the SHOW being over says nothing
    // about a scene that is still looping underneath it.
    const reconcile = (showTime: number, playhead: number, showEnded: boolean, nowMs: number) => {
      // THE SHOW IS OVER (global loop off, the show clock PARKED at showEnd — a frozen number). Reconciling
      // the bed against it is not a no-op, it is a 50 ms buzz loop (see the drift re-lock above). Stop the
      // BED and skip it. `stopSounding` per clip, NOT stopAllSounding() — that clears the shared sent*
      // maps wholesale and would take the bound timeline's clips down with it.
      if (showEnded) { for (const c of bed.clips) if (sounding.has(c.id)) stopSounding(c.id); }
      else reconcileContainer(bed.clips, bed.tracks, showTime, nowMs);      // THE BED — show clock
      reconcileContainer(tlAudio.clips, tlAudio.tracks, playhead, nowMs);   // the BOUND timeline's own audio — playhead
    };

    // TWO CLOCKS, TWO SEEK TESTS.
    //
    // `ctx.onPlayhead` drives the cadence (it fires every frame, INCLUDING while paused — the clock just
    // freezes — which is why pause is detected by polling `playing`, never by "the callback stopped"). Its
    // argument is the BOUND DOCUMENT's playhead, which is the right number for Timeline.audio and the WRONG
    // one for the bed; the bed takes host.show.getStatus().showTime.
    //
    // A seek is not signalled, it is INFERRED: anything that displaces a clock by >200 ms in one frame,
    // forward or backward, beyond wall-clock expectation, reads as a seek on THAT clock and hard-resyncs
    // THAT container. The two containers want OPPOSITE things from a scene recall, and this is where they
    // get them:
    //
    //   · showSeeked — THE BED. A recall does NOT move showTime, so this stays FALSE and the bed plays on.
    //     (On the old wiring the bed rode the playhead, every GO looked like a seek, and stopAllSounding()
    //     restarted a five-minute ambient bed from its top. That is the bug this whole split exists to kill.)
    //     It still goes true, correctly, on: a real user seek while the global doc is bound; Stop; a project
    //     open; the GLOBAL timeline's own loop wrap (the SHOW looped — restarting the bed there is right);
    //     and SHORTENING THE GLOBAL LENGTH BELOW showTime, which hard-cuts the bed and ends the show (a
    //     documented, audible consequence of telling the show it is shorter than it has already run —
    //     setGlobalDoc's own comment says so).
    //
    //   · phSeeked — THE BOUND TIMELINE'S OWN AUDIO. A recall mainSeeks the playhead to the scene's
    //     in-point, so this DOES go true and that container hard-resyncs at its new position. That is "it
    //     restarts with its timeline", exactly as specified — and it is the same test the bed used to be
    //     (wrongly) subjected to.
    //
    // A seek on ONE clock resyncs ONLY that container (per-clip stopSounding, never stopAllSounding) — a
    // global stop here would put the bed's restart back on every scene recall through the back door.
    //
    // AND ONE THING THAT IS NOT A SEEK AND MUST NOT BE TREATED AS PLAYBACK EITHER: THE PARKED SHOW CLOCK.
    // With the global loop off the show clock parks at showEnd and STOPS ADVANCING — while `playing` can
    // still be true, because a scene is looping underneath. Reconciling the BED against a frozen number is
    // not a no-op: `desired` (derived from the clock) freezes while `estimated` (derived from the wall
    // clock) keeps advancing, so the drift test at SYNC_THRESHOLD trips every ~50 ms and re-seeks every
    // sounding clip back to the SAME source offset — forever. That is a 50 ms buzz loop, not silence, and
    // the park frame's own Δ (≈ −0.04 s at 60 Hz on a 30 fps doc) is far under SEEK_THRESHOLD, so
    // `showSeeked` never catches it. (Simulated: 272 re-seeks to the identical offset in 15 s of parked
    // show.) `st.showEnded` is the signal, and it is passed to reconcile() — where it is BED-SCOPED. THE
    // SHOW ENDING MUST NOT SILENCE A SCENE'S OWN AUDIO: that container is on the playhead and knows nothing
    // about the show's end (a looping scene keeps its sting looping over a finished bed — that is the two
    // clocks, heard separately).
    //
    // WHEN THE SHOW CLOCK COMES BACK, THE BED RESTARTS VIA ONE OF THE ARMS BELOW — and WHICH one depends on
    // the path, so do not go looking for a jump that some of them never make:
    //   · Play from the parked end / a project open → showSeek() to the global in-point: a −60 s jump,
    //     `showSeeked` is true, the seek arm stops the bed's clips and reconcile() restarts them from the top.
    //   · Stop → Play                               → Stop drops `playing`, so the pause arm runs first;
    //     Play then re-enters through the `!prevPlaying` resume arm.
    //   · THE GLOBAL LENGTH RAISED WHILE PARKED     → the un-park is NOT a jump. The park re-anchors
    //     showOriginMs to the raw end every frame, so the clock resumes CONTINUOUSLY: Δclock = 0.05 s vs
    //     Δwall = 0.017 s ⇒ |Δ| = 0.033 s, far under SEEK_THRESHOLD. `showSeeked` is FALSE and recovery runs
    //     through the plain normal-advance arm, whose `inWindow && !isSounding` branch restarts the clip at
    //     the resumed offset (60.02 s, not 0). Same outcome, different arm.
    //     (Simulated: scratch/showEnded-recovery-arms.mjs prints the arm taken for all three.)
    const tick = (playhead: number) => {
      // The BOUND timeline's audio, re-read EVERY FRAME — see refreshTlAudio. A recall repoints the engine
      // synchronously, in this very frame; the container and the playhead must never be a frame apart.
      // Then silence anything that just left both containers, before any clock is looked at.
      refreshTlAudio();
      pruneOrphans();
      // The automation sampler ran moments ago, in the same frame (timeline.ts calls it just before it
      // notifies its subscribers, of which this is one — so a curve's value reaches the engine on the
      // frame it was sampled, not the next). Push whatever it moved. Only the owners it actually touched:
      // an unchanged value never gets here, because the sampler gates on a half-step epsilon and every
      // push costs an acquisition of the engine's audio lock.
      const moved = takeDirty();
      if (moved.size > 0) {
        for (const clip of allClips()) if (moved.has(clip.id) && loaded.has(clip.id)) pushClipParams(eff(clip));
        if (moved.has(MASTER_BUS_ID)) syncMaster();
      }
      const nowMs = performance.now();
      const st = host.show.getStatus();
      const playing = st.playing;
      const showTime = st.showTime;
      const expectedDelta = prevPlaying ? (nowMs - prevWallMs) / 1000 : 0;
      const showSeeked = Math.abs((showTime - prevShowTime) - expectedDelta) > SEEK_THRESHOLD;
      const phSeeked = Math.abs((playhead - prevPlayhead) - expectedDelta) > SEEK_THRESHOLD;

      if (prevPlaying && !playing) {
        stopAllSounding();                                                    // paused → freeze BOTH containers
      } else if (playing && !prevPlaying) {
        stopAllSounding(); reconcile(showTime, playhead, st.showEnded, nowMs); // resume → hard resync both
      } else if (playing) {
        // Surgical, per container. stopSounding(id) deletes only THAT clip's sent* entries; stopAllSounding()
        // clears the shared maps wholesale and would drag the other container down with it. Do not
        // "simplify" these back to stopAllSounding().
        if (showSeeked) for (const c of bed.clips) if (sounding.has(c.id)) stopSounding(c.id);
        if (phSeeked) for (const c of tlAudio.clips) if (sounding.has(c.id)) stopSounding(c.id);
        reconcile(showTime, playhead, st.showEnded, nowMs);
      }
      prevPlaying = playing; prevShowTime = showTime; prevPlayhead = playhead; prevWallMs = nowMs;
    };

    void syncLoaded().then(syncClips);
    // Fires on EITHER container changing (App's fan-out watches the bed AND the bound timeline), which is
    // what loads/unloads engine-resident sources across a scene recall. tick() re-reads tlAudio itself
    // every frame; this refresh is for the syncLoaded() that runs right here, outside any frame.
    unsubMix = host.audio.subscribe(() => {
      bed = readBed(host);
      refreshTlAudio();
      void syncLoaded().then(syncClips);
    });
    unsubTick = ctx.onPlayhead(tick);
  },

  deactivate(): void {
    unsubTick?.(); unsubTick = null;
    unsubMix?.(); unsubMix = null;
    audioClient.stopAll();
  },
};
