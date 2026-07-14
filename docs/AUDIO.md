# Audio — architecture & usage

ArtLux plays **object-based, spatialised audio** in step with the show. Sound is not a track bolted to the
side of the video timeline: it rides the same transport, it is recalled by the same Scenes, and it is
automated by the same curve engine that drives everything else. The engine is a native **JUCE** addon with
**libspatialaudio** ambisonics — every source is a *point in a field*, encoded into a shared B-format bus
and decoded to headphones (HRTF binaural) or to a real speaker array.

Shipped in **Wave 3** (`v0.22.0`). For the hands-on course, start at
**[`examples/audio/`](../examples/audio/README.md)** — five ready-to-open projects and a six-chapter
tutorial.

> ### The one thing to understand before anything else: **two containers, two clocks.**
>
> | | Lives in | Rides | A Scene recall… |
> |---|---|---|---|
> | **The BED** | `ProjectData.audio` — **one per project** | the **SHOW clock** (`showTime`) | **does not touch it.** It plays straight through. |
> | **A timeline's OWN audio** | `Timeline.audio` — one per timeline, **so one per Scene** | the **PLAYHEAD** | **restarts it**, with its timeline. |
>
> The bed is the house music, the room tone, the thing that must not stutter when you fire a cue. A
> timeline's own audio is the scene's *sting* — the thing that **should** fire again every time you enter it.
> Almost every question about ArtLux audio ("why did it restart?", "why *didn't* it restart?") is answered by
> asking which container the clip is in. See [TIMELINE.md — the show clock](TIMELINE.md).

---

## Where it lives

```
native/audio-engine/
  src/engine.cpp        the whole engine: SpatialBus (ambisonic encode → binaural/speaker decode),
                        Clip (transport + encoder + effect chain), master chain + fader, metering,
                        device management, and the N-API surface
  CMakeLists.txt        JUCE + libspatialaudio, fetched at configure time
                        → build with `npm run build:audio`  ⚠ THE DEV APP MUST BE CLOSED

plugins/audio/          the audio subsystem is A PLUGIN. Core knows nothing about sound.
  plugin.main.ts        main-process side: the IPC handlers (audio:configure/getMeters/loadClip/…)
  plugin.renderer.ts    THE DRIVER — the frame loop that turns "where is the show" into engine calls
  audioManager.ts       the addon loader (load-or-null: no addon ⇒ perfect silence, never a crash)
  audioClient.ts        the renderer's typed IPC client
  AudioBedPanel.tsx     THE MIXER — bed tracks, the bound timeline's tracks, the clip inspector, master
  AudioSettings.tsx     Preferences ▸ Audio — device, channels, binaural/speakers, per-channel meters
  EffectChain.tsx       the insert-chain editor (used at both scopes)
  Fader.tsx             one fader. Drafts locally, commits once. Read it before touching any control.
  automationTargets.ts  the audio automation PROVIDER: enumerate() the targets, apply() the values
  effectDefs.ts         the FX catalog (types, params, ranges) — one source of truth for UI + engine

src/renderer/components/timeline/
  AudioLane.tsx         one audio track's lane: waveform, drag/trim/blade, fades, gutter (name/M/S/gain)
  audioPeaks.ts         cached waveform peaks — path-keyed, deduped, never on the rAF path
```

**Core owns the documents; the plugin owns the sound.** `ProjectData.audio` and `Timeline.audio` are core
types (`src/renderer/types.ts`) that core persists and normalizes and never listens to. Everything audible
is in `plugins/audio/`.

---

## The signal path

```
 AudioClip (a file, trimmed, with a gain and a fade)
    │
    ├─ insert chain  (AudioClip.effects)          ← "this voice is in a small room"
    │
    ├─ spatial?  ──yes──▶  ambisonic ENCODER  ──▶  shared B-format bus  ──▶  DECODER
    │                      (mono, placed at x/y/z)                          binaural (HRTF)
    │                                                                       or speaker array
    └─ no ────────────────▶  summed straight through  ─────────────────────────┐
                                                                               ▼
                                                          master insert chain (AudioBus.effects)
                                                                               │
                                                                      master fader → device
```

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

The **Audio Bed** panel (`Ctrl+B`, or the ♪ button) is the mixer. It answers *"how loud, what does it sound
like"*. The **timeline lanes** answer *"when"*. The split is not taste — it falls straight out of the two
insert points above.

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

- **Files:** `wav`, `aiff`/`aif`, `flac`, `ogg` (JUCE's `registerBasicFormats`). MP3/AAC are gated behind
  extra codecs and are **not** enabled.
- **Output:** Preferences ▸ Audio — 1/2/4/6/8 channels, **binaural** (HRTF, for headphones) or a **speaker
  layout** (the mode for an installation). The device may open with *fewer* channels than you asked for; the
  master chain is built for what you actually got, and the panel tells you.
- **No addon ⇒ perfect silence, never a crash.** `audioManager` is load-or-null. Authoring, saving and every
  other output (DMX, projectors, OSC) keep working. A **`no audio engine`** badge and a startup notice say so
   — because *silence with a UI that says everything is fine* is the failure this subsystem takes most
  seriously.
- **The device can die under you** (a bumped USB cable, a driver reload). A red **`no output device`** badge
  appears, Preferences says so and names what it lost, and **Reconnect** restores sound with no restart.
  ⚠ **It does not re-open a device by itself** — in an unattended install nobody is there to press Reconnect.
  Tracked for Wave 4.

---

## Invariants (break these and it is audible)

1. **Never block the audio thread.** The audio callback reaches the mixer only by taking `SpatialBus::lock`,
   so *anything* slow done while holding that lock is a dropout — and a dropout resuming mid-waveform is a
   step discontinuity, which is broadband. It is a **click**. `AudioTransportSource::prepareToPlay()` blocks
   on **disk** (it prefills 0.25 s and spins until the reader lands) and `stop()` blocks for up to a second.
   **Both happen outside the lock.** At 48 kHz / 512 the deadline is 10.7 ms — even a warm, page-cached read
   blows it.
2. **The bed rides `showTime`. Never the playhead.** Mirroring the bound document's playhead into anything
   bed-related is a lie the moment a Scene is bound.
3. **A fader drafts locally and commits once** (`Fader.tsx`). One commit is a full document write plus an
   engine re-sync; doing that per `pointermove` is 60 of them a second on a live show.
4. **A gesture can outlive its document.** Seconds pass between a pointerdown and its commit, and a recall in
   that window rebinds the document underneath. Capture Scene makes the ids **byte-identical**, so every
   id-keyed guard *resolves* — against the wrong scene. Continuous controls are keyed on `docKey`
   (identity, never value) and **abandon** rather than write into the scene that is now on the projectors.
5. **Clamp at the engine door, never in the normalizer.** A clamp on load would be persisted on the next save
   and silently rewrite the author's value. The document keeps whatever it says; the *amplifier* gets a number
   that is in range (`boundGain`).

---

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
