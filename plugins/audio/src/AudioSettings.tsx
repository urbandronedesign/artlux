// Audio settings section (Preferences ▸ Audio). Engine status, an output device picker (grouped by driver
// type), sample rate / buffer size, how the ambisonic field is rendered (binaural HRTF for headphones, or a
// decode to a real speaker layout), and a live per-channel meter. Talks to the main-process engine via
// audioClient. Every readout renders what the engine ACTUALLY OPENED, not what was requested.
import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { audioClient } from './audioClient';
import { SPEAKER_LAYOUTS, unitFor, speakerCount, wantedChannels, type SpeakerLayoutId } from './speakerLayouts';
// The table's azimuth is the AMBISONIC one (anticlockwise, positive = left); the number an operator
// reads off the positioner is its mirror. normAngle is the single place that fold happens.
import { normAngle } from '../../../shared/spatial';
import type { DeviceEntry, OpenedCfg, OutputMode, SpeakerLayout } from './audioManager';

interface AudioCfg {
  outputChannels?: number; outputMode?: OutputMode; speakerLayout?: SpeakerLayout;
  deviceType?: string; deviceName?: string; sampleRate?: number; bufferSize?: number;
  // Decoder speaker → device channel (Speaker check below). Absent/short slots default to identity
  // (speaker N → channel N). Persisted machine-scoped, same as the rest of this cfg (Task 2).
  speakerPatch?: number[];
  // Video-clip audio — the venue's switch and the venue's latency trim. Mirrors AudioPluginCfg in
  // plugin.renderer.ts, which is what actually reads them.
  videoAudio?: boolean;   // ABSENT ⇒ ON
  avOffsetMs?: number;
}

// Does any device channel repeat among the first `need` speakers? The native sanitiser (engine.cpp
// Bus::setPatch) no longer DROPS a speaker on a duplicate — it REMAPS the collision to a free channel,
// silently overriding whatever the operator picked. This can't be replicated pixel-for-pixel in the UI
// (the remap depends on the FULL 64-slot pass, not just the speakers this layout uses), so it isn't
// attempted here: this predicate only tells the operator their two dropdowns currently agree, so the
// engine is about to move one of them.
function hasDuplicateChannel(patch: number[] | undefined, need: number): boolean {
  const seen = new Set<number>();
  for (let s = 0; s < need; s++) {
    const dst = patch?.[s] ?? s;
    if (seen.has(dst)) return true;
    seen.add(dst);
  }
  return false;
}

// A patch entry that OUTLIVES a device downgrade. The Speaker check dropdowns below only ever offer
// `opened?.channels` options, so an operator can't SET an over-range channel going forward — but a patch
// commissioned against a LARGER device survives untouched when this machine later opens a SMALLER one (a
// different interface, a multichannel card that dropped out and fell back to onboard stereo): nothing
// re-clamps `speakerPatch` on that change. The engine's write-site then silently DROPS that speaker's audio
// (engine.cpp: `if (dst >= 0 && dst < outCh)`) — no error, no log, just a speaker whose meter never moves.
// `shortChannels` above catches "the LAYOUT needs more speakers than the device has"; it does not catch an
// individual PATCH ENTRY pointing past the device's real channel count, which is this case.
function hasOverRangeChannel(patch: number[] | undefined, need: number, channels: number): boolean {
  for (let s = 0; s < need; s++) {
    const dst = patch?.[s] ?? s;
    if (dst >= channels) return true;
  }
  return false;
}
// The FIRST offending entry's device channel, for the warning's wording — same predicate, one extra return.
function firstOverRangeChannel(patch: number[] | undefined, need: number, channels: number): number | null {
  for (let s = 0; s < need; s++) {
    const dst = patch?.[s] ?? s;
    if (dst >= channels) return dst;
  }
  return null;
}

const SAMPLE_RATES = [0, 44100, 48000, 88200, 96000];
const BUFFER_SIZES = [0, 128, 256, 512, 1024];

// The picker's labels. The COUNTS are not written here: they come from SPEAKER_LAYOUTS, which is the
// table the decoder itself is built from. This used to be a second transcription of the same numbers,
// which is one edit away from a picker that promises six speakers for a layout the decoder gives five.
const LAYOUTS: { id: SpeakerLayout; label: string; speakers: number }[] = ([
  { id: 'stereo', label: 'Stereo' },
  { id: 'quad', label: 'Quad' },
  { id: '5.0', label: '5.0' },
  { id: '5.1', label: '5.1' },
  { id: '7.0', label: '7.0' },
  { id: '7.1', label: '7.1' },
  { id: 'hexagon', label: 'Hexagon (6, ring)' },
  { id: 'octagon', label: 'Octagon (8, ring)' },
  { id: 'cube', label: 'Cube (8, 3D)' },
] as { id: SpeakerLayout; label: string }[]).map((l) => ({ ...l, speakers: speakerCount(l.id) }));

// wantedChannels now lives in speakerLayouts.ts — see the long note there. It moved because the panel
// was not its only caller: plugin.renderer.ts configures the same engine on the broadcast/headless path
// and kept its own `outputChannels ?? 2`, so the two silently disagreed about how many outputs to open.

// ⚠ A PATCH IS LONGER THAN THE LAYOUT YOU ARE LOOKING AT, AND THE TAIL IS REAL COMMISSIONING.
//
// speakerPatch is stored whole and survives a layout change untouched — an octagon ring patched
// [3,2,1,0,7,6,5,4] is still all eight entries after someone drops the selector to Quad to check the
// front of house. What used to destroy it was the next PATCH EDIT: the writer rebuilt the array at the
// CURRENT layout's length, so nudging one channel while Quad was selected wrote back four entries and
// speakers 5-8 were gone. Nothing warned, because both inline warnings only inspect the first `need`
// slots. Back on Octagon the missing rows silently read 5,6,7,8 — plausible, identity, and wrong for a
// venue whose amps are not wired in order. The re-patch is a day's work with a ladder.
//
// So every rebuild spans max(need, patch.length): the visible rows are editable, the invisible tail is
// carried through untouched.
const withPatched = (patch: number[], need: number, slot: number, channel: number): number[] => {
  const next = Array.from({ length: Math.max(need, patch.length) }, (_, i) => patch[i] ?? i);
  next[slot] = channel;
  return next;
};

// "Reset to 1:1" means the speakers you can SEE, for the same reason. Wiping entries for a layout that
// is not on screen is not a reset, it is a deletion the operator did not ask for and cannot see happen.
const resetPatch = (patch: number[], need: number): number[] =>
  Array.from({ length: Math.max(need, patch.length) }, (_, i) => (i < need ? i : patch[i] ?? i));

// Settings are the host AppSettings (generic/unknown at this SDK boundary) — typed loosely here, like the
// other first-party settings sections, and read/patched through the `plugins.audio` slice.
export const AudioSettings: React.FC<{ settings: any; onChange: (patch: any) => void }> = ({ settings, onChange }) => {
  const cfg: AudioCfg = settings?.plugins?.audio ?? {};
  const outCh = wantedChannels(cfg);
  const mode: OutputMode = cfg.outputMode ?? 'binaural';
  const layout: SpeakerLayout = cfg.speakerLayout ?? 'stereo';

  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [device, setDevice] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  // WHAT WE ACTUALLY GOT, not what we asked for. A stereo card asked for 8 channels opens with 2, and a
  // panel that renders the REQUEST describes a rig that does not exist. Every readout below reads this.
  const [opened, setOpened] = useState<OpenedCfg | null>(null);
  // THE REAL SIGNAL. This used to be inferred from configure() returning an empty device name — a guess
  // derived from a side effect, and the reason a dead engine was never surfaced anywhere an operator
  // would look. Defaults true so the warning never flashes while the probe is in flight.
  const [engineUp, setEngineUp] = useState(true);
  // ⚠ A DIFFERENT QUESTION FROM `engineUp`, AND THE ONE THAT ACTUALLY HAPPENS IN A VENUE. `available()`
  // reports only that the .node LOADED — and the addon stays perfectly loaded when the audio interface is
  // UNPLUGGED. So this panel used to print "Native JUCE + ambisonic engine active · output device: <name>"
  // over a silent room, NAMING A DEVICE THAT WAS PHYSICALLY GONE. Read from JUCE's getCurrentAudioDevice()
  // and carried on the meters poll below, which already runs at 10 Hz. Defaults true (no flash on startup).
  const [deviceLive, setDeviceLive] = useState(true);
  const [meter, setMeter] = useState<{ peaks: number[]; speakers: number }>({ peaks: [], speakers: 0 });
  const holds = useRef<number[]>([]);
  // Which Speaker check button is currently held, for its highlight — not the tone state itself (the
  // engine has no "which speaker" concept, only setTestTone(deviceChannel, gain)).
  const [tone, setTone] = useState<number | null>(null);
  // …and the same for the PLACED test, which is a different signal path entirely (see playPlaced).
  const [placed, setPlaced] = useState<number | null>(null);
  // The blip file, fetched once. `null` = asked and unavailable (a read-only userData, say);
  // `undefined` = not asked yet. The two must not be confused or a failed fetch would retry forever.
  const testSrc = useRef<string | null | undefined>(undefined);
  const testLoaded = useRef(false);

  const apply = (c: AudioCfg) =>
    audioClient.configure({
      deviceType: c.deviceType, deviceName: c.deviceName,
      channels: wantedChannels(c), sampleRate: c.sampleRate ?? 0, bufferSize: c.bufferSize ?? 0,
      mode: c.outputMode ?? 'binaural', layout: c.speakerLayout ?? 'stereo',
      patch: c.speakerPatch,
    })
      .then((got) => { setOpened(got); setDevice(got.deviceName); setError(null); })
      .catch((e) => setError(String(e?.message ?? e)));

  // ⚠ THE DEVICE LIST WAS A SNAPSHOT TAKEN ONCE, ON MOUNT, AND NOTHING EVER REFRESHED IT.
  //
  // The load-in order that happens every single time is: laptop on, ARTLux up, Preferences ▸ Audio open,
  // THEN the rack gets powered. The interface that appears thirty seconds later was never in the list and
  // never would be. Worse, the recovery button beside the dead-device badge only re-ran apply() — it
  // retried opening a name that still was not there — directly underneath its own instruction to
  // "reconnect the interface, then press Reconnect". The native side rescans properly on every call
  // (engine.cpp's scanForDevices), so the fresh list was always one IPC away; the panel simply never asked.
  const rescanDevices = React.useCallback(() =>
    audioClient.getDevices().then((d) => { setDevices(d ?? []); }).catch(() => {}), []);

  useEffect(() => {
    let live = true;
    audioClient.available().then((v) => { if (live) setEngineUp(v); }).catch(() => {});
    audioClient.getDevices().then((d) => { if (live) setDevices(d ?? []); }).catch(() => {});
    void apply(cfg); // idempotent engine-side; returns the setup actually opened
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      audioClient.getMeters().then((m) => {
        const peaks = m.peaks ?? [];
        holds.current = peaks.map((v, i) => Math.max((holds.current[i] ?? 0) * 0.92, v));
        setMeter({ peaks: holds.current.slice(), speakers: m.speakers ?? 0 });
        // `!== false`, never a bare assignment: an old main process hands back a meters object with no
        // `deviceLive` field at all, and `undefined` is falsy — a bare read would raise a "no output device"
        // alarm over a perfectly healthy rig. Only an EXPLICIT false lights it.
        setDeviceLive(m.deviceLive !== false);
      }).catch(() => {});   // a rejected poll lights nothing
    }, 100);
    return () => clearInterval(iv);
  }, []);

  // ── THE PLACED TEST — the one that can actually see a mirrored room ──────────────────────────
  //
  // `setTestTone` writes a device channel DIRECTLY: it proves the wiring and is blind to the decode.
  // This instead plays an ordinary clip, positioned at the direction the positioner pad DRAWS for this
  // speaker, so it travels the whole chain — clip → encoder → B-format → decoder → patch → device. If
  // the two buttons on a row light the same physical box, the geometry and the wiring agree. If they
  // light different boxes, the angle convention is mirrored and every source in every show is on the
  // wrong side of the room. Nothing else in the app can tell you that.
  //
  // A RESERVED CLIP ID, and it must stay reserved. The audio driver keys everything by clip id and its
  // syncLoaded() only ever unloads ids in ITS OWN `loaded` map — so a clip loaded from here is invisible
  // to it and will not be swept. That also means a collision with a document's clip id would have the
  // driver and this panel fighting over one engine voice, which the `__` prefix makes impossible
  // (crypto.randomUUID never produces it).
  const TEST_CLIP_ID = '__speaker-check';
  // Only used if loadClip somehow answered without a duration — the real one comes off its meta.
  const SECONDS_FALLBACK = 60;
  // The held speaker, in a ref: playPlaced reads it AFTER its awaits, where the closure's copy is stale.
  const placedRef = useRef<number | null>(null);

  // ⚠ THE REF IS CLEARED SYNCHRONOUSLY, and that is the whole guard. `playPlaced` re-reads it after two
  // awaits (a file generate, then a decode) precisely so a pointerup landing inside them cancels the
  // sound. Clearing only the STATE would leave the ref reading the held speaker until React commits —
  // the noise would start after the operator let go, with nothing held down to stop it, in the room.
  // The clip's own length, so the restart timer below knows when it runs out. Set from loadClip's meta.
  const testDurSec = useRef(0);
  const loopTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ⚠ THE REF IS CLEARED SYNCHRONOUSLY, and that is the whole guard. `playPlaced` re-reads it after two
  // awaits (a file generate, then a decode) precisely so a toggle switched off inside them cancels the
  // sound. Clearing only the STATE would leave the ref reading the held speaker until React commits —
  // the blips would start after the operator switched off, with nothing lit to stop them, in the room.
  const stopPlaced = () => {
    placedRef.current = null;
    setPlaced(null);
    if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
    audioClient.stopClip(TEST_CLIP_ID);
  };

  const playPlaced = async (speakerIndex: number) => {
    // ⚠ THE DEFAULT HERE MUST BE THE ONE apply() SENDS THE ENGINE, WHICH IS 'stereo' (see the layout arg
    // at the configure() call above). It used to be '', and '' is not a layout id: the lookup returned
    // undefined, `sp` was undefined, and playPlaced returned at the !sp guard without a sound.
    //
    // That is worse than it looks, because of WHEN it fires. cfg.speakerLayout is only set once someone
    // CHANGES the dropdown — and the dropdown already shows Stereo, so an operator commissioning a fresh
    // machine has no reason to touch it. They switch to Speaker layout, run the two-button check the
    // panel's own text calls the only way to catch a mirrored room, and get: Wiring blips on both boxes,
    // Placed silent on both. The engine is fine and decoding to stereo the whole time. The panel is the
    // only thing that thinks there is no layout, so every diagnosis points at the rig.
    const list = SPEAKER_LAYOUTS[(cfg.speakerLayout ?? 'stereo') as SpeakerLayoutId];
    const sp = list?.[speakerIndex];
    // An LFE has no direction — placing a source "at" it is meaningless, and the button is disabled
    // for that row rather than playing something that cannot be interpreted.
    if (!sp || sp.lfe) return;
    if (testSrc.current === undefined) testSrc.current = await audioClient.testSource();
    const path = testSrc.current;
    if (!path) return;
    if (!testLoaded.current) {
      const meta = await audioClient.loadClip(TEST_CLIP_ID, path);
      if (!meta) return;                      // no engine — the badge above already says so
      testDurSec.current = meta.durationSec ?? 0;
      testLoaded.current = true;
    }
    // ⚠ RE-CHECKED AFTER THE AWAITS. A generate + decode is two round trips, and a pointerup can land
    // inside them — starting the noise after the operator let go would leave it playing with nothing
    // held down to stop it. `placed` is set by the caller BEFORE this runs, so a cleared value means
    // the gesture is over.
    if (placedRef.current !== speakerIndex) return;
    const v = unitFor(sp);
    audioClient.setClipSpatial(TEST_CLIP_ID, v.x, v.y, v.z);
    audioClient.playClip(TEST_CLIP_ID, 0, 1);    // unity: the level is baked into the file (see SCALE)
    // ⚠ THE ENGINE HAS NO LOOPING TRANSPORT, AND THIS IS NOW A TOGGLE. A press-and-hold could never
    // outlast a 60 s file; a toggle left on while somebody walks the room absolutely can, and it would
    // simply go quiet — which reads as a speaker that just died. So restart it just before it ends.
    //
    // The seam is inaudible by construction: the file is a whole number of beats, and the restart lands
    // in the ~0.6 s of silence between blips, so a few ms of timer drift cannot double or clip one.
    if (loopTimer.current) clearInterval(loopTimer.current);
    const durMs = Math.max(1000, (testDurSec.current || SECONDS_FALLBACK) * 1000 - 400);
    loopTimer.current = setInterval(() => {
      if (placedRef.current === null) return;     // switched off between ticks
      audioClient.playClip(TEST_CLIP_ID, 0, 1);
    }, durMs);
  };


  // A panel closed with a toggle ON would leave the blip playing in the room with nothing on screen to stop it.
  // BOTH signals, and the clip unloaded with them — an engine-resident source nobody can reach again is
  // exactly the orphan the driver's own comments are about.
  useEffect(() => () => {
    // THE TIMER FIRST, AND THIS ORDER MATTERS. playPlaced arms a setInterval that restarts the clip
    // just before it ends (the engine has no looping transport). Stopping the clip without killing the
    // interval leaves a timer that fires ~20 s later and starts it again — blips in the room with no
    // panel on screen to stop them, which is the exact failure this cleanup was written to prevent.
    // placedRef is nulled too: the interval body reads it, and so does the post-await guard.
    if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
    placedRef.current = null;
    audioClient.setTestTone(-1, 0);
    audioClient.stopClip(TEST_CLIP_ID);
    audioClient.unloadClip(TEST_CLIP_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchCfg = (p: AudioCfg) =>
    onChange({ plugins: { ...(settings?.plugins ?? {}), audio: { ...cfg, ...p } } });

  // Every picker patches the cfg and re-applies the WHOLE thing — the engine's guard now keys on the whole
  // setup, so it reopens only when something actually changed.
  const patchAndApply = (p: AudioCfg) => { patchCfg(p); void apply({ ...cfg, ...p }); };

  const setChannels = (ch: number) => patchAndApply({ outputChannels: ch });
  const setMode = (m: OutputMode) => patchAndApply({ outputMode: m });
  const setLayout = (l: SpeakerLayout) => patchAndApply({ speakerLayout: l });

  // `available` is GONE, and its removal is the fix. It was `engineUp && !error` — a single boolean standing
  // in for a question that has THREE answers (no addon / no device / running), and it collapsed the one that
  // matters in a venue into the one that never happens on a working install. The status block below asks the
  // three questions separately. Do not reintroduce a single "is audio ok" flag: there isn't one.
  const pct = (v: number) => `${Math.min(100, Math.round(v * 100))}%`;
  const need = LAYOUTS.find((l) => l.id === layout)?.speakers ?? 2;
  // ⚠ AGAINST WHAT THE DEVICE ACTUALLY OPENED WITH, NOT WHAT WAS ASKED FOR.
  //
  // This compared `need > outCh` — the REQUEST — which is silent in the one case it most needs to fire:
  // ask a 6-output interface for 8 channels, pick Octagon, and the two numbers agree perfectly, so no
  // warning — while the device hands back 6 and speakers 7 and 8 are never heard. Measured on a Scarlett
  // 6i6: asked 8, opened 6, nothing said. The panel a few lines down already knew to use `opened.channels`
  // for exactly this reason (see patchOverRange); this predicate did not.
  //
  // Falls back to the request while `opened` is still null — the first render, before configure() has
  // answered — which is the old behaviour and is correct for a state where nothing is known yet.
  const liveCh = opened?.channels ?? outCh;
  const shortChannels = mode === 'speakers' && need > liveCh;
  // …and WHY it is short changes the fix entirely: raise the channel count, or accept that this interface
  // cannot go higher and pick a layout that fits it.
  const deviceCapped = shortChannels && opened != null && opened.channels < outCh;
  const fitting = LAYOUTS.filter((l) => l.speakers <= liveCh).map((l) => l.label);
  const patchDuplicate = mode === 'speakers' && hasDuplicateChannel(cfg.speakerPatch, need);
  // Gated on `opened` being known — `opened.channels` is what the device ACTUALLY has; `outCh` is only
  // what was REQUESTED, and a stereo card asked for 8 channels opens with 2, so warning off the request
  // would be wrong in exactly the case this exists to catch.
  const patchOverRange = mode === 'speakers' && opened != null && hasOverRangeChannel(cfg.speakerPatch, need, opened.channels);
  const overRangeChannel = patchOverRange && opened ? firstOverRangeChannel(cfg.speakerPatch, need, opened.channels) : null;

  // A held test tone plays in the physical room. If the layout, device, or output mode changes while a
  // speaker is held — including via keyboard, which fires no pointerup on the vanishing button — the
  // button can unmount with the tone still sounding and nothing on screen to stop it. Kill it whenever
  // any of those change.
  // (Both signals, and the placed one ALSO drops its loaded source: reopening the device rebuilds the
  // engine's bus, and a clip that outlived that rebuild is a voice this panel can no longer address.
  // Reloading costs one decode of a 20 s file, on a gesture nobody is timing.)
  useEffect(() => {
    if (tone !== null) { setTone(null); audioClient.setTestTone(-1, 0); }
    if (placed !== null) setPlaced(null);
    // Same orphan-timer hazard as the unmount cleanup above — a layout change unmounts the button but
    // the interval outlives it.
    if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
    placedRef.current = null;
    audioClient.stopClip(TEST_CLIP_ID);
    audioClient.unloadClip(TEST_CLIP_ID);
    testLoaded.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, need, opened?.channels, cfg.deviceType, cfg.deviceName, cfg.speakerLayout]);

  // ── OPTION VALUES ARE INDICES, NOT `${type} ${name}` STRINGS ────────────────────────────────────────
  // Driver type names and device names ROUTINELY CONTAIN SPACES — "Windows Audio (Exclusive Mode)",
  // "Focusrite Scarlett 2i2 USB" — so a space-joined value split back on ' ' silently shreds both fields
  // (`"Windows Audio (Exclusive Mode) Focusrite Scarlett 2i2 USB".split(' ')` gives type "Windows", name
  // "Audio"). That sends configure() a device that matches nothing, the native side rolls back to
  // whatever was already open, and the corrupted {type,name} still gets persisted — so the picker looks
  // wired while silently reopening the wrong box. An index into a flat array can't be corrupted by any
  // character in a name, so that's what the <option value> carries instead.
  //
  // `deviceGroups` is the SAME structure rendered as optgroups below; `flatDevices` is that structure
  // flattened, not a second grouping of `devices` that could put things in a different order.
  const deviceGroups = Object.entries(devices.reduce<Record<string, DeviceEntry[]>>((acc, d) => {
    (acc[d.type] ??= []).push(d); return acc;
  }, {}));
  const flatDevices = deviceGroups.flatMap(([, ds]) => ds);
  const selectedIndex = flatDevices.findIndex((d) => d.type === cfg.deviceType && d.name === cfg.deviceName);
  // 'default' is not a valid array index and can never collide with a real flat-index value — it means
  // "no device picked yet" as well as the explicit "System default" choice, both of which resolve to
  // {deviceType: undefined, deviceName: undefined} (today's "that driver type's default device").
  // ⚠ "NOTHING PINNED" AND "THE PINNED DEVICE IS NOT HERE" ARE DIFFERENT, AND BOTH USED TO RENDER AS
  // "System default". A cfg still naming a renamed or unplugged interface showed a dropdown reading
  // System default while every apply() kept sending the dead name and failing — and re-picking System
  // default, the one obvious escape, fires no onChange at all because the value has not changed. The
  // control was inert by construction, which is a bad thing to hand someone ten minutes into a load-in.
  const savedMissing = !!cfg.deviceName && selectedIndex < 0;
  const selectValue = selectedIndex >= 0 ? String(selectedIndex) : savedMissing ? 'missing' : 'default';

  return (
    <div className="space-y-4">
      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Engine</div>
        {/* ── THREE STATES, NOT TWO. The missing third one is the one that happens in a venue. ──────────
            This block used to ask ONE question — "did the addon load?" — and answer it with a sentence about
            the DEVICE. So when the audio interface was unplugged it went on printing "engine active · output
            device: Focusrite Scarlett 2i2", naming hardware that was physically gone, over a silent room,
            with the show still running. The operator's diagnosis, from the only screen that claims to know,
            was "the audio engine is fine."
            `!deviceLive` is checked FIRST because it is the more specific failure: with no addon there is
            also no device, and telling someone to check their USB cable when the real problem is a missing
            build would send them to the wrong end of the room. */}
        {!engineUp ? (
          <div className="text-mini text-warn">Audio engine unavailable{error ? ` — ${error}` : ''}. Playback is disabled.</div>
        ) : !deviceLive ? (
          <div className="space-y-1.5">
            {/* ⚠ "GONE" AND "NEVER THERE" ARE DIFFERENT SENTENCES, AND ONLY THIS PANEL CAN TELL THEM APART.
                `device` holds the name of the last device we successfully OPENED, and `apply()` never clears
                it on failure — so a non-empty name means we HAD one and lost it. Empty means configure() has
                never succeeded on this machine: there is no audio hardware (a DMX-only or headless install is
                a real deployment for this app). Printing "usually a bumped USB cable" at someone whose machine
                has no sound card at all sends them hunting for a cable that never existed. The Audio Bed's
                badge stays the neutral "no output device", which is true either way; this panel knows more,
                so it says more. */}
            {/* ⚠ THREE CAUSES NOW, BECAUSE THE THIRD ONE SENDS PEOPLE TO THE WRONG END OF THE ROOM.
                This used to branch on `device` alone — i.e. on "has this panel ever opened anything" —
                which is not the same question as "why is there no sound". A Windows update that RENAMES an
                interface between two shows leaves `device` set, so the operator was told their working
                interface had been unplugged and to go check a USB cable, while `error` — holding the
                engine's verbatim "No such device: <old name>" — sat unread in a text-micro line below.
                The saved name simply not being in the device list is a fact this panel can check, so it
                does, and it says the one thing that actually fixes it. */}
            <div className="text-mini text-danger flex items-center gap-1.5">
              <AlertTriangle size={12} className="shrink-0" />
              <span><strong>{savedMissing
                ? 'The saved interface is not on this machine — the room is silent.'
                : device
                  ? 'The output device is gone — the room is silent.'
                  : 'No audio output device — there is no sound.'}</strong></span>
            </div>
            <div className="text-micro text-fg-3">
              {savedMissing ? (
                <>This project is pinned to <span className="text-fg-2">{cfg.deviceName}</span>, and no device by
                that name is present. A driver update that renames an interface does this, as does swapping one
                unit for another — the cable is not the problem.{' '}
                <strong className="text-fg-2">Pick the interface again above, or use system default.</strong></>
              ) : device ? (
                <>The engine is loaded and the show is still running, but <span className="text-fg-2">{device}</span> —
                the interface it was playing through — has disappeared. Usually a bumped USB cable, a driver
                reload, or Windows power-cycling the device.{' '}
                <strong className="text-fg-2">ARTLux will not re-open it on its own.</strong></>
              ) : (
                <>The engine is loaded, but no output device could be opened on this machine. Authoring, saving
                and every non-audio output (DMX, projectors, OSC) work normally — there is simply nowhere to
                send sound.</>
              )}
            </div>
            <div className="text-micro text-fg-3">
              {savedMissing
                ? 'Rescan first — if the interface is powered on now it will appear in the list above.'
                : device
                  ? 'Reconnect the interface, then press Reconnect. Sound returns with no restart.'
                  : 'Connect an output device, then press Reconnect.'}
            </div>
            {/* THE RECOVERY GESTURE, WHICH DID NOT EXIST. configure() used to take (channels, mode, layout) and
                open the DEFAULT device — there was no device picker anywhere in this panel, so "just pick it
                again" was never actually possible. It now re-opens the NAMED device (cfg.deviceType/deviceName),
                so the recovery gesture finally reaches the interface that actually vanished. */}
            {/* RESCAN THEN RETRY. The instruction directly above says "reconnect the interface, then press
                Reconnect" — so the button has to look at the world again, not re-send a name from a list
                captured before the rack was switched on. */}
            <button onClick={() => void rescanDevices().then(() => apply(cfg))}
              className="inline-flex items-center gap-1.5 px-2 h-7 rounded border border-danger/40 bg-danger/10 text-danger text-mini hover:bg-danger/20">
              <RefreshCw size={12} /> Reconnect
            </button>
            {error && <div className="text-micro text-warn">Last attempt failed — {error}</div>}
          </div>
        ) : error ? (
          /* ⚠ BOTH HALVES OF THE OLD SENTENCE WERE FALSE HERE, OVER AUDIBLE SOUND. This branch is only
             reached when the engine is up AND the device is live — so the failure being reported is a
             REJECTED SETUP CHANGE, not a dead engine. The native side handles a failed open by restoring
             the previous device and setup, re-registering the callback, and returning the error so the
             caller knows the REQUEST failed: the show never stops. Telling an operator mid-load-in that
             the audio engine is unavailable and playback is disabled, while the room is still playing,
             is a five-minute panic over a setting that simply did not take. */
          <div className="text-mini text-warn">
            Could not apply that setup — {error}.{' '}
            <span className="text-fg-2">Still playing through {device || 'the current device'}.</span>
          </div>
        ) : (
          <div className="text-mini text-fg-3">Native JUCE + ambisonic engine active · output device: <span className="text-fg-1">{device || 'default'}</span></div>
        )}
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Output device</div>
        <select
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'default') { patchAndApply({ deviceType: undefined, deviceName: undefined }); return; }
            const d = flatDevices[Number(v)];
            if (d) patchAndApply({ deviceType: d.type, deviceName: d.name });
          }}
          className="w-full bg-surface-2 border border-line-1 rounded px-1.5 h-6 text-mini text-fg-1 outline-none"
        >
          <option value="default">System default</option>
          {savedMissing && (
            <option value="missing" disabled>{cfg.deviceName} — not found on this machine</option>
          )}
          {(() => {
            let offset = 0;
            return deviceGroups.map(([type, ds]) => {
              const start = offset;
              offset += ds.length;
              return (
                <optgroup key={type} label={type}>
                  {ds.map((d, j) => (
                    <option key={start + j} value={String(start + j)}>
                      {d.name}{d.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </optgroup>
              );
            });
          })()}
        </select>
        <div className="flex items-center gap-1.5 mt-1">
          <button onClick={() => void rescanDevices()}
            className="inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 bg-surface-2 text-fg-2 text-micro hover:text-fg-1">
            <RefreshCw size={11} /> Rescan
          </button>
          {savedMissing && (
            <button onClick={() => patchAndApply({ deviceType: undefined, deviceName: undefined })}
              className="px-1.5 h-6 rounded border border-line-1 bg-surface-2 text-fg-2 text-micro hover:text-fg-1">
              Use system default
            </button>
          )}
        </div>
        {/* ── THE SENTENCE THAT MAKES MULTICHANNEL POSSIBLE ────────────────────────────────────────────────
            An operator cannot be expected to know that "Windows Audio" and "Windows Audio (Exclusive Mode)"
            are the difference between a stereo downmix and eight discrete outputs. The dropdown groups by
            driver type; this says what the groups MEAN. Do not shorten it to "choose a device".

            ⚠ IT USED TO STOP AT "choose Exclusive Mode", AND THAT SENT AN OPERATOR HUNTING FOR HOURS.
            Exclusive Mode gets the discrete outputs only if the DRIVER exposes them to Windows at all.
            Measured on a Scarlett 6i6, same machine and cables, one hour apart: on the generic USB
            audio-class driver it opened SIX channels on every WASAPI mode; with the vendor driver
            installed it opened TWO, on every mode, at every requested count. Vendor drivers routinely
            publish outputs 1-2 to Windows and route the rest through ASIO alone. Nothing in this panel
            or in the vendor control app reverses that, so the honest advice names ASIO first when the
            group exists — otherwise the panel confidently recommends the option that cannot work, and
            the operator concludes their hardware is broken. (It did. The interface was fine.)

            The ASIO group only appears in an ASIO-enabled build (ARTLUX_ENABLE_ASIO — see NOTICE); the
            conditional keeps the advice truthful in builds where choosing it is impossible. */}
        <div className="text-micro text-fg-3 mt-1">
          Devices are grouped by <span className="text-fg-2">driver type</span>.
          {flatDevices.some((d) => d.type === 'ASIO') ? (
            <>
              {' '}For a multichannel interface prefer <span className="text-fg-2">ASIO</span> — it is the
              card&apos;s own driver, and on many interfaces it is the only route to outputs 3 and up.
              {' '}<span className="text-fg-2">Exclusive Mode</span> is the next best thing and works well on
              cards that publish every output to Windows.
            </>
          ) : (
            <>
              {' '}For a multichannel interface choose <span className="text-fg-2">Exclusive Mode</span> — it
              hands ARTLux the card&apos;s discrete outputs.
            </>
          )}
          {' '}Shared mode routes through the Windows mixer and will usually give you stereo, whatever the
          card can do. Whichever you pick, believe the <span className="text-fg-2">Open:</span> line below
          rather than the card&apos;s spec sheet — it says how many channels you actually got.
        </div>
        {opened && (
          <div className="text-micro text-fg-3 mt-1">
            Open: <span className="text-fg-1">{opened.deviceName || 'default'}</span> ·{' '}
            {opened.channels} ch · {(opened.sampleRate / 1000).toFixed(1)} kHz · {opened.bufferSize} samples
          </div>
        )}
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Spatial output</div>
        <div className="flex items-center gap-1">
          <button onClick={() => setMode('binaural')}
            className={`px-2 h-6 rounded text-mini border ${mode === 'binaural' ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>Binaural (headphones)</button>
          <button onClick={() => setMode('speakers')}
            className={`px-2 h-6 rounded text-mini border ${mode === 'speakers' ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>Speaker layout</button>
        </div>
        <div className="text-micro text-fg-3 mt-1">
          {mode === 'binaural'
            ? 'The ambisonic field is decoded to stereo with an HRTF — a true 3D image, but only over headphones.'
            : 'The same ambisonic field is decoded to a real speaker array. This is the mode for an installation.'}
        </div>

        {mode === 'speakers' && (
          <div className="mt-2 flex items-center gap-2">
            <select value={layout} onChange={(e) => setLayout(e.target.value as SpeakerLayout)}
              className="bg-surface-2 border border-line-1 rounded px-1.5 h-6 text-mini text-fg-1 outline-none">
              {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <span className="text-micro text-fg-3">decoding to {meter.speakers || need} speakers</span>
          </div>
        )}
        {shortChannels && (
          <div className="text-micro text-warn mt-1">
            {deviceCapped ? (
              <>
                This layout needs {need} channels. You asked for {outCh} and the device opened{' '}
                <span className="font-semibold">{liveCh}</span> — it has no more outputs to give, so raising
                the channel count will not help. Only the first {liveCh} speakers will be heard.
                {fitting.length > 0 && (
                  <> Layouts that fit this device: <span className="font-semibold">{fitting.join(', ')}</span>.</>
                )}
              </>
            ) : (
              <>
                This layout needs {need} channels but the device is open with {liveCh} — only the first{' '}
                {liveCh} speakers will be heard. Raise the channel count below.
              </>
            )}
          </div>
        )}
      </div>

      {/* ── VIDEO CLIP AUDIO ────────────────────────────────────────────────────────────────────────
          THE VENUE'S SWITCH, and the reason it exists is a decision rather than a feature: every project
          plays its video clips' own soundtracks, INCLUDING projects authored before that was possible. A
          show that has been silent for a year can start making sound on the first launch after an update,
          and an installation needs to stop it NOW — without opening the timeline, editing clips, or
          re-saving a show file. Machine-scoped like everything else on this panel, so it never travels in
          the `.artlux` and never follows the project to the next machine.
          `patchCfg`, not `patchAndApply`: neither of these touches the device, so re-opening it would be a
          gratuitous dropout in a running room. */}
      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Video clip audio</div>
        <label className="flex items-center gap-2 text-mini text-fg-1 cursor-pointer">
          <input type="checkbox" className="accent-accent" checked={cfg.videoAudio !== false}
            onChange={(e) => patchCfg({ videoAudio: e.target.checked ? undefined : false })} />
          Play the soundtrack inside video clips
        </label>
        <div className="text-micro text-fg-3 mt-1">
          {cfg.videoAudio === false
            ? 'Off — every video clip on every timeline is silent, whatever the project says.'
            : 'On — a clip’s own audio plays with it, through this rig. Silence one clip in its inspector, or a whole track with the speaker button on its header.'}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-mini text-fg-2">A/V offset</span>
          <input type="number" step={5} value={cfg.avOffsetMs ?? 0}
            onChange={(e) => { const v = parseFloat(e.target.value); patchCfg({ avOffsetMs: Number.isFinite(v) && v !== 0 ? v : undefined }); }}
            className="w-20 bg-surface-0 border border-line-1 rounded text-mini num text-fg-1 px-1 py-0.5 outline-none focus:border-accent" />
          <span className="text-micro text-fg-3">ms — positive = audio later</span>
        </div>
        <div className="text-micro text-fg-3 mt-1">
          The constant part of the lag on THIS machine: converter and buffer latency, and the projector's own
          delay. Tune it once with a clapperboard clip. A single clip that needs its own trim has one in its
          inspector; this is added to that.
        </div>
      </div>

      {mode === 'speakers' && (
        <div>
          <div className="text-mini font-semibold text-fg-2 mb-1">Speaker check</div>
          {/* ── COMMISSIONING, AND IT IS THE FIRST HOUR OF EVERY INSTALL ────────────────────────────────
              Hold a speaker to hear pink noise from exactly that one output, then set which device channel
              it should come out of. The tone bypasses the ambisonic decoder entirely — it is testing the
              WIRING, not the decode. */}
          <div className="text-micro text-fg-3 mb-1.5 space-y-1">
            <div>
              Set the channel each speaker is actually wired to — the ring is rarely patched in order.
              Then hold either button to hear that speaker.
            </div>
            {/* ⚠ THE TWO BUTTONS ARE NOT A CONVENIENCE — THEY ANSWER DIFFERENT QUESTIONS, AND ONLY THE
                SECOND ONE CAN SEE A MIRRORED ROOM. Wiring writes the device channel directly and skips
                the decoder; Placed sends a source THROUGH it, from the direction the positioner draws
                for that speaker. Same box from both ⇒ geometry and wiring agree. Different boxes ⇒ every
                source in every show is on the wrong side, and nothing else in the app would tell you. */}
            <div>
              <span className="text-fg-2">Wiring</span> goes straight to the device channel.{' '}
              <span className="text-fg-2">Placed</span> sends a source through the decoder from where the
              positioner draws that speaker. <span className="text-fg-2">Both should light the same box.</span>{' '}
              If they don't, the layout is mirrored against the room.
            </div>
            {/* ⚠ AND THE ONE ASYMMETRY BETWEEN THEM, WHICH WOULD OTHERWISE READ AS A DECODE FAULT.
                setTestTone is written AFTER the master fader on purpose (engine.cpp: "a commissioning
                tone that the house fader can silence is a tone that will have you checking a speaker
                cable while the software is muting it"). The placed source cannot be, because going
                through the whole chain IS the test — so the master fader and any master insert apply to
                it and not to the other button. Silent Placed + working Wiring is very often a master at
                zero, and an operator who does not know that goes looking at the layout. */}
            <div>
              Placed passes the master fader and its inserts; Wiring does not. If Placed is silent and
              Wiring is not, check the master in the Audio Bed before suspecting the layout.
            </div>
          </div>
          {patchDuplicate && (
            <div className="text-micro text-warn mb-1.5">
              Two speakers are set to the same channel — the engine will move one.
            </div>
          )}
          {patchOverRange && overRangeChannel !== null && opened && (
            <div className="text-micro text-warn mb-1.5">
              A speaker is patched to channel {overRangeChannel + 1}, which this device doesn't have
              ({opened.channels} channels) — it will be silent. Re-pick its channel.
            </div>
          )}
          <div className="space-y-0.5">
            {Array.from({ length: need }).map((_, s) => {
              const patch = cfg.speakerPatch ?? [];
              const dst = patch[s] ?? s;
              // The DECODER's own record for this speaker (direction, name, whether it is the LFE) —
              // the same table the positioner pad draws from, so the two cannot disagree about which
              // way "speaker 3" points. Absent for a layout name we do not know, which disables the
              // placed test rather than guessing at a direction.
              // Same default as playPlaced, and for the same reason — this one decides whether the row's
              // Placed button is enabled at all, so a mismatch here disables the control silently.
              const spk = SPEAKER_LAYOUTS[(cfg.speakerLayout ?? 'stereo') as SpeakerLayoutId]?.[s];
              return (
                <div key={s} className="flex items-center gap-1.5">
                  {/* A TOGGLE, NOT A HOLD. Commissioning is done standing in the room, several metres
                      from the keyboard — a press-and-hold pins the operator to the desk, which is the
                      one place from which you cannot tell two speakers apart. Click, walk, listen, come
                      back. Clicking any other speaker's button switches this one off (one tone at a
                      time is the whole point of the test). */}
                  <button
                    onClick={() => {
                      if (tone === s) { setTone(null); audioClient.setTestTone(-1, 0); return; }
                      stopPlaced();                       // never two signals at once
                      setTone(s); audioClient.setTestTone(dst, 0.5);
                    }}
                    className={`px-2 h-6 rounded text-mini border tabular-nums ${tone === s ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}
                  >
                    Speaker {s + 1}{spk?.name ? ` (${spk.name})` : ''}
                  </button>
                  {/* THE PLACED TEST. Disabled for an LFE, which has no direction to place a source at
                      — see speakerLayouts.ts. Pointer capture is what makes a hold survive the pointer
                      wandering off the button: without it a drag off-target strands the noise playing. */}
                  <button
                    disabled={!spk || !!spk.lfe}
                    title={spk?.lfe
                      ? 'The LFE has no direction — there is nowhere to place a source'
                      : `Play a source from ${Math.round(normAngle(-(spk?.azimuth ?? 0)))}° — through the decoder, the way a real clip travels`}
                    onClick={() => {
                      if (placed === s) { stopPlaced(); return; }
                      if (tone !== null) { setTone(null); audioClient.setTestTone(-1, 0); }
                      placedRef.current = s; setPlaced(s); void playPlaced(s);
                    }}
                    className={`px-2 h-6 rounded text-mini border ${placed === s ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'} disabled:opacity-40 disabled:hover:text-fg-2`}
                  >
                    Placed
                  </button>
                  <span className="text-micro text-fg-3">→</span>
                  <select
                    value={dst}
                    onChange={(e) => {
                      patchAndApply({ speakerPatch: withPatched(patch, need, s, Number(e.target.value)) });
                    }}
                    className="bg-surface-2 border border-line-1 rounded px-1.5 h-6 text-mini text-fg-1 outline-none tabular-nums"
                  >
                    {Array.from({ length: opened?.channels ?? outCh }).map((_, c) => (
                      <option key={c} value={c}>Channel {c + 1}</option>
                    ))}
                    {/* ⚠ AN OUT-OF-RANGE STORED CHANNEL MUST STILL APPEAR, OR THE CONTROL CONTRADICTS
                        THE WARNING ABOVE IT. A <select> whose value matches no <option> does not render
                        blank — React falls through its match loop and displays the FIRST option. So a
                        patch commissioned on a 16-out interface, opened on a machine that fell back to
                        onboard stereo, showed "Channel 1" on every over-range row. The warning above said
                        speaker 5 is on a channel this device lacks; the row said Channel 1; channel 1
                        demonstrably worked. The only conclusion available to the operator was that the
                        warning was stale — and both test buttons stayed silent, because they correctly
                        fire at the STORED channel. Render the truth, disabled, so the two agree. */}
                    {dst >= (opened?.channels ?? outCh) && (
                      <option value={dst} disabled>Channel {dst + 1} — not on this device</option>
                    )}
                  </select>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => patchAndApply({ speakerPatch: resetPatch(cfg.speakerPatch ?? [], need) })}
            className="mt-1.5 px-2 h-6 rounded text-mini border bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1"
          >
            Reset to 1:1
          </button>
        </div>
      )}

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Output channels</div>
        <div className="flex items-center gap-1">
          {[1, 2, 4, 6, 8].map((ch) => (
            <button key={ch} onClick={() => setChannels(ch)}
              className={`px-2 h-6 rounded text-mini border ${outCh === ch ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>
              {ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : `${ch}ch`}
            </button>
          ))}
        </div>
        <div className="text-micro text-fg-3 mt-1">Requested — see &quot;Open:&quot; above for what the device actually gave.</div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Sample rate</div>
        <div className="flex items-center gap-1">
          {SAMPLE_RATES.map((r) => (
            <button key={r} onClick={() => patchAndApply({ sampleRate: r })}
              className={`px-2 h-6 rounded text-mini border ${(cfg.sampleRate ?? 0) === r ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>
              {r === 0 ? 'Device default' : `${(r / 1000).toFixed(1)} kHz`}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Buffer size</div>
        <div className="flex items-center gap-1">
          {BUFFER_SIZES.map((b) => (
            <button key={b} onClick={() => patchAndApply({ bufferSize: b })}
              className={`px-2 h-6 rounded text-mini border ${(cfg.bufferSize ?? 0) === b ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}>
              {b === 0 ? 'Device default' : `${b} samples`}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-mini font-semibold text-fg-2 mb-1">Meters</div>
        <div className="space-y-0.5">
          {Array.from({ length: Math.max(2, Math.min(opened?.channels ?? outCh, 8)) }).map((_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-micro text-fg-3 w-4 tabular-nums">{i + 1}</span>
              <div className="flex-1 h-1.5 rounded bg-surface-2 overflow-hidden">
                <div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peaks[i] ?? 0) }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
