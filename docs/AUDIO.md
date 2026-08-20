# Audio — architecture & usage

ArtLux plays **object-based, spatialised audio** in step with the show. Sound is not a track bolted to the
side of the video timeline: it rides the same transport, it is recalled by the same Scenes, and it is
automated by the same curve engine that drives everything else. The engine is a native **JUCE** addon with
**libspatialaudio** ambisonics — every source is a *point in a field*, encoded into a shared B-format bus
and decoded to headphones (HRTF binaural) or to a real speaker array.

Shipped in **Wave 3** (its changelog sits under **v0.22.0** in `CHANGELOG.md`). `package.json` is at
**v0.24.0**; note the last *tagged/distributed* release is **v0.21.0** — v0.22.0–v0.24.0 were prepared
but not tagged (see the CHANGELOG header). For the hands-on course, start at
**[`examples/audio/`](../examples/audio/README.md)** — five ready-to-open projects and a six-chapter
tutorial.

> ### The one thing to understand before anything else: **three containers, two clocks.**
>
> | | Lives in | Rides | A Scene recall… |
> |---|---|---|---|
> | **The BED** | `ProjectData.audio` — **one per project** | the **SHOW clock** (`showTime`) | **does not touch it.** It plays straight through. |
> | **A timeline's OWN audio** | `Timeline.audio` — one per timeline, **so one per Scene** | the **PLAYHEAD** | **restarts it**, with its timeline. |
> | **A VIDEO CLIP's own soundtrack** | nowhere — **derived** from the video clips on a timeline | the **PLAYHEAD** | **restarts it**, with its timeline. |
>
> The bed is the house music, the room tone, the thing that must not stutter when you fire a cue. A
> timeline's own audio is the scene's *sting* — the thing that **should** fire again every time you enter it.
> Almost every question about ArtLux audio ("why did it restart?", "why *didn't* it restart?") is answered by
> asking which container the clip is in. See [TIMELINE.md — the show clock](TIMELINE.md).
>
> The third one is **not a document**: there is no list of video-clip audio anywhere in a `.artlux`. It is
> recomputed from the video clips themselves every frame, which is why a blade, a trim, a slip or an undo
> carries the sound with the picture and cannot desynchronise it — there is no link to maintain. Only *how it
> sounds* is authored (`VideoClip.audio`), never *when*.

---

<!-- audience:contributor -->

## Where it lives

```
native/audio-engine/
  src/engine.cpp        the transport + the bus: SpatialBus (ambisonic encode → binaural/speaker decode),
                        Clip (transport + encoder + chain), the master fader, metering, device
                        management, and the N-API surface
  src/effects.h         the DSP: GainFx / FilterFx / ReverbFx / DelayFx / CompFx, and EffectChain.
                        build() ALLOCATES (JS thread, never under the lock); setParams()/process() are
                        allocation-free and run under it. `buildable()` is where a master reverb is
                        refused — read its header comment before touching anything in here.
  CMakeLists.txt        JUCE 8 + libspatialaudio, fetched at configure time
                        → build with `npm run build:audio`  ⚠ THE DEV APP MUST BE CLOSED

plugins/audio/src/      the audio subsystem is A PLUGIN. Core knows nothing about sound.
  plugin.main.ts        main-process side: the IPC handlers (audio:configure/getMeters/loadClip/…)
  plugin.renderer.ts    THE DRIVER — the frame loop that turns "where is the show" into engine calls
  audioManager.ts       the addon loader (load-or-null: no addon ⇒ perfect silence, never a crash)
  audioClient.ts        the renderer's typed IPC client
  audioHost.ts          the host handle, set once by the driver — how the provider and the mixer reach
                        host.audio / host.show without a prop drill
  AudioBedPanel.tsx     THE MIXER — bed tracks, the bound timeline's tracks, the clip inspector, master
  AudioSettings.tsx     Preferences ▸ Audio — device, channels, binaural/speakers, per-channel meters
  EffectChain.tsx       the insert-chain editor (used at both scopes)
  Fader.tsx             one fader. Drafts locally, commits once. Read it before touching any control.
  automationTargets.ts  the audio automation PROVIDER: enumerate() the targets; write() / writeFade()
                        the two override layers; release() / releaseFade() to hand a path back;
                        get() (authored) and getLive() (what is actually sounding)
  effectDefs.ts         the FX catalog (types, params, ranges) — one source of truth for UI + engine

src/renderer/components/timeline/
  AudioLane.tsx         one audio track's lane: waveform, drag/trim/blade, fades, gutter (name/M/S/gain)
  audioPeaks.ts         cached waveform peaks — path-keyed, deduped, never on the rAF path
```

**Core owns the documents; the plugin owns the sound.** `ProjectData.audio` and `Timeline.audio` are core
types (`src/renderer/types.ts`) that core persists and normalizes and never listens to. Everything audible
is in `plugins/audio/`.

---

<!-- audience:operator -->

## The signal path

```
 AudioClip (a file, trimmed, with a gain and a fade)
    │
    ├─ SPATIAL ──▶ fold to MONO ──▶ insert chain (1 ch) ──▶ ambisonic ENCODER ──┐
    │              ⚠ mono FIRST      (AudioClip.effects)     placed at x/y/z    │
    │                                                                    shared B-format bus
    │                                                                           │
    │                                                                        DECODER
    │                                                              binaural (HRTF) │ speaker array
    │                                                                              │
    └─ NOT SPATIAL ──▶ insert chain (2 ch) ──▶ summed straight through ────────────┤
                                                                                   ▼
                                                            master insert chain (AudioBus.effects)
                                                                                   │
                                                                          master fader → device
```

### ⚠ The downmix comes BEFORE the chain, and that is a correctness fix, not an optimisation

A spatial clip's chain is **mono (1 ch)**. A flat clip's is **stereo (2 ch)**. The engine folds a spatial
source to mono *first* and only then runs its inserts — and the reason is worth knowing, because the obvious
ordering is a trap:

> **`juce::dsp::Reverb` in stereo deliberately DE-correlates L and R** — that decorrelation is what makes it
> sound wide. And the very next thing the engine does to a spatial clip is **fold it to mono**. Run the
> reverb first and you would be **comb-filtering that decorrelated field against itself.** So: downmix,
> *then* process. (`native/audio-engine/src/effects.h`, header comment.)

This is also why the **Spatial checkbox is not automatable** while the three position **axes** are: flipping
it changes the chain's channel count (2 ⇔ 1) and **forces a full rebuild** — and a rebuild allocates, which
must never happen on the audio thread. You can fly a source across the room sixty times a second. You cannot
rebuild its DSP graph sixty times a second.

### The positioner pad draws the DECODER's rig, and auditions without writing

Two things about the pad are easy to get wrong, and both were wrong until they were fixed.

**It auditions on every pointermove; it writes once, on release.** Invariant 7 says a continuous control
must not write the document per frame — a `setMix` is an App re-render, an automation recompile and an
engine lock per clip, sixty times a second while somebody idly drags a source round the room. It says
nothing about the ENGINE. So the pad (and the height fader beside it) push the position straight to
`setClipSpatial` on every move and commit the document exactly once, which is how a control whose whole
purpose is *hearing where the sound goes* can be both live and cheap. A gesture whose document rebound
under it (`docKey`) stops being audible at the same instant it stops being committable — a sound that goes
on moving after a recall is describing a document nobody is looking at.

**The speaker markers are transcribed from libspatialaudio's own presets**, not from the names of the
layouts (`plugins/audio/src/speakerLayouts.ts`, checked against `source/AmbisonicDecoder.cpp`). This
matters more than it sounds: the ring layouts (Hexagon, Octagon, Cube) run **clockwise** from a different
start angle than the discrete ITU ones do, and azimuth is **anticlockwise, positive = LEFT** — the
convention `engine.cpp`'s `toPolar` derived from the decoder's coefficients. Get either backwards and the
pad silently mirrors the room: it would look right, read right, and place every sound on the wrong side.

Each marker carries the **device channel** it is patched to (`speakerPatch`, identity when unpatched), not
the speaker ordinal — the number that is useful is the one written on the back of the interface. A marker
whose channel is beyond what the device actually opened with is drawn **amber**: that is the
`hasOverRangeChannel` case, where the engine's write site silently drops the speaker's audio
(`if (dst >= 0 && dst < outCh)`) and its meter simply never moves. The LFE is drawn off the ring, because
it has no direction — libspatialaudio parks it at the centre speaker's angle only so the array has
something to hold. **Binaural** draws no rig at all, because there isn't one.

### There are exactly TWO insert points, and there never will be a third

**A spatial source is a point in a field.** It cannot be summed into a bus *before* it is placed — the
encoder needs each source's signal on its own. So there is no per-track insert, and there cannot be one.
Effects live at two scopes:

| Scope | Field | Runs | Use it for |
|---|---|---|---|
| **Clip** | `AudioClip.effects` | on the source, **before** encoding | *character*: reverb, filter, delay — "put this voice in a room, then place the room" |
| **Master** | `AudioBus.effects` (`ProjectData.audio.buses`, id `master`) | on the **decoded** N-channel output | *protection*: a compressor/limiter to keep the rig safe, a corrective filter |

This is the standard **object-audio** convention, and it is forced by the engine rather than chosen.

> ### ⚠ **A reverb on the master is silently DROPPED.**
> `juce::dsp::Reverb` is a **≤ 2-channel** processor. The master chain runs *after* the ambisonic decode,
> where the signal may be 8 channels wide — so a reverb there would pass **dry** and you would hear nothing
> change. The engine drops it rather than pretend (`engine.cpp`, `SetMasterEffects`). **Put reverb on the
> clip**, which is where it belongs anyway: it places the source in a space, and then the space moves with
> it. The master bus is where a **compressor** goes.

---

## The mixer, and where each control actually lives

The **Audio Bed** panel — **View ▸ Audio Bed…** — is the mixer. It answers *"how loud, what does it sound
like"*. The **timeline lanes** answer *"when"*. The split is not taste — it falls straight out of the two
insert points above.

> It is a **plugin modal**, registered with `menuAction: 'audio-bed'` (`plugin.renderer.ts`), and that
> registration is **unconditional** — the panel opens and renders even when the native addon failed to load.
> It will simply have nothing to make sound with, and it says so (see the badges below). **There is no
> keyboard shortcut for it.**

| You want to… | Do it |
|---|---|
| place / trim / blade / fade a clip | its **lane**, on the timeline |
| a track's name, mute, solo, gain | the lane's **gutter** |
| a clip's gain, mute, position, FX | the **clip inspector** — select the clip on a lane, shape it in the Audio Bed |
| the house level, master FX | the **master strip**, bottom of the Audio Bed |
| add a bed track | **`+ Bed`** in the Audio Bed header, *or* the `+` on the bed lanes' gutter — same door |

**The clip inspector follows the timeline selection**, across *both* containers. While a Scene is bound the
timeline draws no bed lanes at all (the bed rides the show clock; the ruler is the scene's), so the only
audio clip you can select there is a **timeline** clip — and the inspector writes it, by id, into whichever
document core has bound.

---

## Automation

Audio is an automation **provider** (`automationTargets.ts`). It publishes its targets into the same registry
the core parameters use, so an audio lane on the timeline is the same object as any other lane.

### The target paths

| Path | Range | Notes |
|---|---|---|
| `audio.master.gain` | 0 – 1.5 | the house level — *the* lane a show recall exists to move |
| `audio.master.fx.<fxId>.<param>` | per the FX catalog | e.g. `audio.master.fx.fx_comp.thresholdDb` |
| `audio.track.<trackId>.gain` | 0 – 1.5 | |
| `audio.clip.<clipId>.gain` | 0 – 1.5 | |
| `audio.clip.<clipId>.spatial.<x\|y\|z>` | −6 – 6 m | only when the clip **is** spatial |
| `audio.clip.<clipId>.fx.<fxId>.<param>` | per the FX catalog | |

**These are BED paths.** The provider enumerates `ProjectData.audio` and nothing else, so a clip in a
`Timeline.audio` has no lane and no fade over it. And because Capture Scene deep-clones a timeline, clip ids
**alias across containers** — an id from a scene's audio will happily *resolve* against a bed path of the
same name. Anything reading these paths must gate on the container first.

### Which clock a lane rides

A lane's clock is decided by **which document it lives in**:

- a lane on the **global** timeline rides the **SHOW clock**, so it keeps driving underneath every Scene;
- a lane on a **Scene's** timeline rides that scene's **playhead**, and restarts with it.

While a Scene is bound, the timeline panel draws the **global** lanes too — dimmed, badged **`GLOBAL`**,
read-only (you edit them on the Global pill, where they live). If a scene lane owns the *same* `targetPath`,
the global one is **struck through**: the engine has filtered it out and it is not applying.

### The read order — `lane ?? scene/cue fade ?? authored`

Three layers can write the same parameter, and the priority is fixed:

```
 authored   the value in the document (what the fader says)
   ↑
 fade       a Scene or Cue recall faded it here — AND IT PERSISTS after the fade lands
   ↑
 lane       an automation lane owns it, and it wins
```

**What the mixer draws is what the engine is playing** — the faders read the layered value, not the document.
When a layer owns a fader it says so:

- **`FADE`** — the fader still works. Moving it is a real **takeover** (it drops the fade *and* its in-flight
  leg). This is the recovery gesture, and it is the whole reason `releaseFade()` exists.
- **`LANE`** — the fader goes **read-only**. Only the automation engine may drop a lane, so a move there
  would land in the document, change nothing audible, and be overwritten on the next frame. Switch the lane
  off (the ⚡ in its gutter) to take the parameter back.

---

## Formats, devices, degradation

- **Files:** `wav`, `aiff`/`aif`, `flac`, `ogg` — decoded natively (JUCE's `registerBasicFormats`).
  **`mp3` is CONFORMED, not decoded natively**: JUCE's mp3 decoder is a build flag
  (`JUCE_USE_MP3AUDIOFORMAT`) that attaches JUCE's own patent disclaimer to every build, and ArtLux does
  not take on a licence obligation it can avoid — so an mp3 goes down the same path a video's soundtrack
  does (*A video clip's own soundtrack*, below), decoded once by **Chromium** into a cached WAV. One table
  decides this for both processes: `plugins/audio/src/conformFormats.ts`. AAC/`m4a` are **not** accepted in
  the library at all — nothing conforms a bare one, so importing it would draw a clip that cannot sound.
- **Video containers** (`mp4`/`m4v`/`mov`/`mkv`/`webm`) are **conformed**, not opened: the engine still only
  ever plays a WAV. See *A video clip's own soundtrack* below.
- **Output:** Preferences ▸ Audio — 1/2/4/6/8 channels, **binaural** (HRTF, for headphones) or a **speaker
  layout** (the mode for an installation). The device may open with *fewer* channels than you asked for; the
  master chain is built for what you actually got, and the panel tells you.
### Three silences, three badges, three different fixes

*Silence with a UI that says everything is fine* is the failure this subsystem takes most seriously. So every
way the room can go quiet has its own badge in the Audio Bed header, and they must never be confused.

| Badge | What it means | Fix |
|---|---|---|
| **`no audio engine`** (amber) | The native addon did **not load**. `audioManager` is load-or-null, so authoring, saving, DMX, projectors and OSC all keep working — there is simply nothing to make sound with. A startup notice says so too. | Built from source: `npm run build:audio`, **with the app closed**. |
| **`no output device`** (red) | The engine is loaded and the show is running, but **the audio interface has gone** — a bumped USB cable, a driver reload, Windows power-cycling the device. | Reconnect it, then **Preferences ▸ Audio ▸ Reconnect**. Sound returns with no restart. ⚠ **ArtLux does not re-open a device by itself** — in an unattended install nobody is there to press it. Tracked for Wave 4. |
| **`show ended`** (amber) | **Not a fault — the show is over.** The global timeline's Length ran out with **Loop off**, so the show clock **parked** and the driver correctly stopped the bed. But the transport still reports *playing* (a scene may be looping underneath), the Play button stays lit, and the readout freezes over a silent room. **This is the one an unattended install hits first** — the default project is 60 s with Loop **off**, so it reaches the end in one minute. | Raise the global **Length**, turn global **Loop** on, or **Stop → Play**. An installation's global timeline should essentially always loop. |

---

## A video clip's own soundtrack

Drop an `.mp4` or a `.mov` on a video track and **it plays its own audio**, on the clip's playhead, through
this rig — the master chain, the commissioned patch, the meters. No linking, no separate import, no audio
lane. It is codec-agnostic by construction: the sound lives in the *container*, so a HAP `.mov`, a WebCodecs
`.mp4`, a plain `<video>` file and the DXV plugin that isn't written yet all behave identically.

### It is CONFORMED, not decoded live

The engine cannot open an MP4 — it registers WAV/AIFF/FLAC/Ogg and nothing that reads an ISO-BMFF container.
Rather than put a video decoder on the audio read thread (where a seek would land *during the show*, against
a 10.7 ms deadline), the soundtrack is decoded **once**, at import, into a 16-bit WAV cached per machine in
`userData/audio-conform/`. What plays in the venue at 3am is a plain WAV.

- The cache key is `path + mtime + size`, so **re-encoding a file in place re-conforms it** and moving a
  project does not.
- It is **derivable machine state**: never in the `.artlux`, never in the project's `assets/`. Delete it and
  it rebuilds. A project handed to a venue conforms on first open.
- Only the audio is read — a HAP master's soundtrack is ~2% of the file.
- A file with **no audio track** is remembered as such and never re-examined.
- **Multichannel is downmixed, not truncated** (ITU-R BS.775). A 5.1 film folded by taking channels 1–2
  would drop the centre channel, which is the dialogue. The fold is measured first so it cannot clip.

### ⚠ Every project starts with sound — including the ones authored before this existed

`VideoClip.audio.enabled` is **absent by default and absent means audible**, in a project made today and in
one made two years ago. A show that has been silent for a year can start playing whatever its masters carry —
a scratch take, room tone off a camera mic — on the first launch after an update. That is intended, and these
are the three ways to stop it:

| Scope | Where |
|---|---|
| **Everything, this machine** | **Preferences ▸ Audio ▸ Video clip audio** — off. The venue's switch: no document edit, no re-save, and it does not travel with the project. |
| One **track** | the **speaker button** on the track header — *not* the `M` beside it, which is the picture flag for the Program composite |
| One **clip** | select it → **Audio ▸ On** in the inspector |

This is the inverse of the three silences below — *unexpected sound with a UI that says nothing is playing* —
so it gets the same treatment: one named cause, one place to fix it.

### Lipsync

Audio and picture are both slaved to the playhead; neither chases the other. What is left is the constant
latency of the rig, and there are two trims that add together: **Preferences ▸ Audio ▸ A/V offset** (this
machine — converters, buffer, projector delay; tune once with a clapperboard clip) and the per-clip **Offset**
in the inspector (this file). Positive means audio later.

---

## Devices and speakers

Preferences ▸ Audio (`AudioSettings.tsx`) picks **which device the engine opens** and how the decoded field
reaches the room. Two things about that panel decide whether an install is discrete multichannel or a stereo
downmix wearing a multichannel layout, and one thing about it is machine state that a show file must never carry.

### Shared vs Exclusive Mode — only one of them is the multichannel path

On Windows, one physical interface appears **twice** in the device dropdown, grouped by **driver type**: once
under **Windows Audio** (shared) and once under **Windows Audio (Exclusive Mode)**. They are the same card,
opened two different ways —

| | Shared (`Windows Audio`) | Exclusive Mode |
|---|---|---|
| Routes through | the Windows mixer | nothing — ArtLux owns the device outright |
| Channels you actually get | usually **stereo**, whatever the card can do | the card's **real, discrete** channel count |
| Right for | a laptop check, headphones, sharing the box with other apps | **the eight-speaker rig** |

**For a multichannel installation, pick the interface listed under Exclusive Mode.** Shared mode will accept
an 8-channel request without complaint and hand back stereo — no error, no warning — which is exactly why
the panel never trusts what was asked for.

### The panel reports what was OPENED, not what was asked for

`configure()` — and the **"Open:"** line under the device picker — always reflects what the device **actually
gave you**: `Open: <device> · 2 ch · 48.0 kHz · 256 samples`. A stereo card asked for 8 channels opens with 2,
and that line says so; the channel/rate/buffer buttons above it are the *request*, not the result. When
commissioning a rig, that line is the one to believe.

### The speaker patch

In Speaker-layout mode, each speaker in the layout gets a **patch**: a dropdown (`Speaker N → Channel …`)
naming which of the device's actual output channels that speaker's decoded signal comes out of. Ambisonic
decode order and the physical wiring of a ring are two different orderings, and the patch is where the gap
between them is closed. Two speakers pointed at the same device channel raises an inline warning — the
engine remaps the collision to a free channel rather than dropping either speaker.

### Speaker check — and why the tone bypasses the decoder *and* the master fader

The **Speaker check** block (Speaker-layout mode only) holds a per-speaker button: hold it and pink noise
plays from exactly the device channel that speaker is currently patched to; release it and it stops.
`setTestTone(deviceChannel, gain)` writes that noise **straight onto a device channel**, upstream of both the
ambisonic decoder and the master fader (`Bus::setTestTone`, `native/audio-engine/src/engine.cpp` — written
before metering, so the signal that lights the meter is the signal in the room). That is deliberate, not an
oversight:

- **It tests the wiring, not the decode.** A silent Speaker 3 means the fault is between the device and the
  cabinet, not in the ambisonic math — the tone never touches the decoder that math runs.
- **The house fader cannot silence it.** A commissioning tone that the master could mute would be useless for
  telling "the fader is stuck at zero" apart from "the wire is dead."

### `AppSettings` is the machine — it does not travel in the `.artlux`

The output device, driver type, sample rate, buffer size, speaker patch, Art-Net target and OSC port all live
in `AppSettings`, which is **machine state**, not show state: it persists per-machine in prefs and is **no
longer written into project files**. Opening a project authored on a different computer leaves the local
device, patch and network configuration untouched. This is load-bearing for anyone deploying a show — commission
the venue machine once, and every project opened on it plays through the rig you patched, never through
whatever the authoring laptop happened to have set. See the CHANGELOG's Breaking entry for what happens to a
legacy `.artlux` that still carries the old `settings` key.

### ASIO

Off by default, behind a build flag — WASAPI exclusive mode (above) is the supported multichannel path. See
[DEVELOPMENT.md → ASIO (optional)](DEVELOPMENT.md#asio-optional) for the build flag and why it isn't on by
default.

---

<!-- audience:contributor -->

## Invariants (break these and it is audible)

> **These are NAMED, not numbered — deliberately.** The codebase already cites numbered invariants
> (*"Invariant 7"*, *"invariant 6"*) in dozens of source comments, and those numbers come from the Wave-3
> plans, not from any list in `docs/`. A fresh 1–5 here would collide head-on: what a reader would call
> "AUDIO.md invariant 3" is what forty source comments already call **invariant 7**. Where a rule *is* one of
> the project's numbered ones, the number is given.

- **Never block the audio thread.** The audio callback reaches the mixer only by taking `SpatialBus::lock`, so
  *anything* slow done while holding that lock is a dropout — and a dropout resuming mid-waveform is a step
  discontinuity, which is broadband. It is a **click**. `AudioTransportSource::prepareToPlay()` blocks on
  **disk** (it prefills 0.25 s and spins until the reader lands); `stop()` blocks for up to a second; and
  `EffectChain::build()` **allocates**. **All three happen outside the lock.** At 48 kHz / 512 the deadline is
  **10.7 ms** — even a warm, page-cached read blows it.
- **The bed rides `showTime`. Never the playhead.** Mirroring the bound document's playhead into anything
  bed-related is a lie the moment a Scene is bound.
- **Draft locally, commit once — *this is the project's invariant 7*** (`Fader.tsx`, and every continuous
  control in the timeline). One commit is a full document write, an engine re-sync (a lock per clip) and a
  recompile of every automation lane; doing that per `pointermove` is sixty of them a second on a live show.
- **A gesture can outlive its document.** Seconds pass between a pointerdown and its commit, and a recall in
  that window rebinds the document underneath. Capture Scene makes the ids **byte-identical**, so every
  id-keyed guard *resolves* — against the wrong scene. Continuous controls are keyed on `docKey` (identity,
  never value) and **abandon** rather than write into the scene that is now on the projectors.
- **Coerce, do not drop — *this is the project's invariant 6***. A junk field in a `.artlux` must not delete
  the operator's work and must not crash the app. It reads as its default.
- **Clamp at the engine door, never in the normalizer.** A clamp on load would be persisted on the next save
  and would silently rewrite the author's value. The document keeps whatever it says; the *amplifier* gets a
  number that is in range (`boundGain`).

---

<!-- audience:operator -->

## See also

- **[`examples/audio/`](../examples/audio/README.md)** — five projects + the six-chapter tutorial. Start here.
- [TIMELINE.md](TIMELINE.md) — the transport, the show clock, and the reset table (every transport event ×
  both clocks).
- [SCENES.md](SCENES.md) / [SCENE-TIMELINES.md](SCENE-TIMELINES.md) — what a Scene captures, and why every
  Scene owns a timeline.
- [STATE-MACHINE.md](STATE-MACHINE.md) — driving all of it unattended.
- [PLUGINS.md](PLUGINS.md) / [SDK.md](SDK.md) — the host surface audio is built on (`host.audio`,
  `host.show`, the automation-target registry).
- [DEVELOPMENT.md](DEVELOPMENT.md) — building the native engine. **Close the app first.**
