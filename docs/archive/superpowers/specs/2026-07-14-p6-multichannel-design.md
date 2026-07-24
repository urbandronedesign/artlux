# P6 — Multichannel hardening, rig commissioning, headless audio

> **Status:** Design, approved 2026-07-14 · **Branch:** `p6-audio-multichannel` (cut from `main` @ `cd31dbe`)
> · **Closes:** the last open phase of [plans/audio-engine.md](../../../plans/archive/audio-engine.md) (P6)
> · **Risk:** Medium — one change (§1) touches the project-file contract, not just audio.

**Goal, in one sentence:** *an eight-speaker installation can be commissioned on a venue machine, by
someone who did not author the show, without a code change.*

---

## 0 · What P6 turned out to be

The plan's P6 line reads *"multichannel hardening (ASIO, speaker layouts), headless wiring,
packaging/CI/licensing."* Reading the tree first — before designing — showed that **three of those four
are already done or nearly done, and the two things that actually block a venue load-in are not in the
line at all.**

| P6 heading | Reality in the tree |
|---|---|
| Speaker layouts | **Already built (P2).** [engine.cpp:72](../../../native/audio-engine/src/engine.cpp#L72) has a real libspatialaudio decoder with nine presets; [AudioSettings.tsx:12](../../../plugins/audio/src/AudioSettings.tsx#L12) exposes them with a channel-shortfall warning. |
| Headless wiring | **Almost certainly already works, by accident.** The P6 risk note cites `HeadlessRunner.tsx:95` — **dead code.** [main/index.ts:141](../../../src/main/index.ts#L141) now boots the *full* `App` with `?headless=1`; plugins activate as `'main'`; the audio plugin opens the device on activation ([plugin.renderer.ts:112](../../../plugins/audio/src/plugin.renderer.ts#L112)). Needs **verifying**, not building. |
| Packaging / CI | Done — `extraResources` ships the addon, `build-audio.cjs` builds it. |
| Licensing | **Recorded, not decided** (`NOTICE`, README ▸ Licensing). Gates the first `v*` tag. Out of scope here — it is the owner's call, not an engineer's. |
| ASIO | Off (`JUCE_ASIO=0`). See §4 — **it is probably the wrong lever.** |
| *(not in the heading)* | **You cannot choose an output device.** See §2. |
| *(not in the heading)* | **The show file overwrites the venue's audio config.** See §1. |

### The two findings that reshaped the phase

**A. ArtLux has never been able to choose an output device.**
[engine.cpp:549](../../../native/audio-engine/src/engine.cpp#L549) is `initialiseWithDefaultDevices(0, ch)`
— always the OS default. `listOutputDevices()`
([:584](../../../native/audio-engine/src/engine.cpp#L584)) enumerates every device, **flattens the names,
discards which driver type each came from**, and nothing consumes the result except a decorative
"Detected output devices" list in Preferences.

In a venue: you plug in an 8-channel interface and ArtLux plays out the laptop speakers. The only
recourse is to change the *Windows* default. Worse — the **Reconnect button** added in the Wave-3 merge
pass re-opens the *default* device, so if the default moved when the interface vanished, the one recovery
gesture in the application sends sound to the wrong box.

**B. The show file carries the machine's audio configuration.**
[App.tsx:1390](../../../src/renderer/App.tsx#L1390) states the contract in the codebase's own words —
settings are *"the machine, not the show."* But [App.tsx:1186](../../../src/renderer/App.tsx#L1186) writes
`settings` **into the `.artlux`**, and [App.tsx:1215](../../../src/renderer/App.tsx#L1215) merges it back on
open — *shallowly*, so the file's whole `plugins` object **replaces** the machine's.

> Author the show on a laptop in **binaural / 2 ch**. Carry the `.artlux` to the venue. Open it on the show
> machine, which is configured **octagon / 8 ch**. The instant the project opens, the venue machine flips to
> binaural stereo — and [App.tsx:2411](../../../src/renderer/App.tsx#L2411) writes that back into the machine's
> prefs, so it **sticks**. The eight-speaker ring plays a headphone mix.

This is the audio plan's own **open question 7** (*"device config scope — per-machine (prefs) vs
per-project; recommend prefs"*) — recommended, never resolved, and currently resolved the wrong way. Every
feature below (device name, driver type, sample rate, speaker patch) is *more* machine-specific than what
already leaks, so **§1 must land before anything else or P6 makes the leak worse.**

---

## 1 · Machine ≠ show

**The rule, and it is one sentence:** `AppSettings` **is the machine. It is never written to a project
file.**

`Prefs.appSettings` ([protocol.ts:585](../../../shared/protocol.ts#L585)) **already** persists it
per-machine. The project file's copy is a duplicate that overrides it on load. Delete the duplicate.

### Why not a machine-keys list

The obvious fix is a `MACHINE_KEYS` array, stripped on write and on read. **Rejected.** Of `AppSettings`'
16 fields, exactly **one** is show-scoped (`reserveLockedRanges` — a patch policy about how auto fixtures
are addressed *around* locked ranges; the fixtures it addresses live in the project). Every other field is
this computer or this building: Art-Net IP/port/protocol/broadcast/sync/fps/keep-alive, output gamma, the
OSC listener (whose own comment says *"this machine's address"*), the help language, the WebCodecs decode
path, and the whole `plugins` namespace.

A list to protect one field is a list that will drift — and this file has **already lost that bet three
times** ([App.tsx:1398](../../../src/renderer/App.tsx#L1398): *"it HAS NOW FAILED THREE TIMES"*). Move the
one field and there is no list.

### Changes

- `ProjectData.settings` — **removed.** `buildProjectData()` stops writing it; `applyProjectData()` stops
  reading it. Old files keep the key; it is **ignored**, which is precisely the behaviour we want.
- `ProjectData.reserveLockedRanges?: boolean` — new, defaulted `false`. On load, back-fill from a legacy
  `data.settings.reserveLockedRanges` when the new field is absent, so existing projects keep their patch
  policy.
- `AppSettings.plugins` — document the contract **on the type**: this namespace is machine-scoped and is
  not persisted to the project. A plugin needing per-project data puts it in `ProjectData`. (Verified true
  today: the three consumers — `audio` (device), `show-control` (LAN port + PIN), `mediapipe` (camera) —
  are all machine-scoped. None stores show data.)

### The behaviour change, stated plainly

**Opening a project no longer reconfigures this machine's outputs.** On a single machine nothing changes —
prefs already hold the same values. Across machines, the venue keeps its own Art-Net target, its own OSC
port, and its own sound card. A project mailed to a colleague who has never configured ArtLux will open
with *their* defaults, not the author's. That is the contract, and it is the point. **CHANGELOG: breaking.**

---

## 2 · Device identity — pick the box, not the default

`configure()` moves from `initialiseWithDefaultDevices(0, ch)` to
`setCurrentAudioDeviceType(type)` + `setAudioDeviceSetup(setup, true)` — both verified present in the JUCE
8.0.14 source we pin and build against (`juce_audio_devices/audio_io/juce_AudioDeviceManager.h`:
`setAudioDeviceSetup` at :251, `setCurrentAudioDeviceType` just below it).
`AudioDeviceSetup` carries **outputDeviceName, sampleRate, bufferSize, outputChannels** as one struct — so
device, rate and buffer are one call, not three features.

> Line numbers here are into JUCE's own tree, which CMake fetches at configure time into the gitignored
> `native/audio-engine/build/_deps/juce-src/`. They are cited, not linked — a link into a build directory
> resolves on one machine and nowhere else. Re-check them against the pinned tag (8.0.14) if JUCE is bumped.

### The dedupe bug

[engine.cpp:589](../../../native/audio-engine/src/engine.cpp#L589) calls `names.removeDuplicates(false)`.
One physical interface is enumerated under **four driver types** — WASAPI shared, WASAPI **exclusive**,
WASAPI shared-low-latency, DirectSound (JUCE 8.0.14, `juce_AudioDeviceManager.cpp:328-331`) — all under the
*same name*. The dedupe collapses them to one row and **throws away the only thing that distinguished
them.**

`listOutputDevices()` therefore starts returning `{ type, name }` pairs. This matters because **WASAPI
exclusive mode is what delivers discrete 8-channel output on Windows** — and it is *already compiled into
the addon*, already being enumerated, and has never been selectable.

### Changes

- `listOutputDevices() → { type, name }[]`; no dedupe across types.
- `configure({ deviceType, deviceName, sampleRate, bufferSize, channels, mode, layout, patch })`.
  Empty `deviceName` ⇒ that type's default (today's behaviour, preserved).
- Preferences ▸ Audio: driver-type picker, device picker, sample-rate and buffer-size pickers (populated
  from the *selected device's* supported values, not a hardcoded list).
- **Reconnect is repaired for free** — it re-opens the *named* device, not the default.
- Persisted in `AppSettings.plugins.audio`, which §1 has just made machine-scoped. **This is why §1 goes
  first.**

---

## 3 · Commissioning — test tone + speaker patch

Under speaker decode, [engine.cpp:229-231](../../../native/audio-engine/src/engine.cpp#L229) writes decoder
speaker `s` → device channel `s`, **1:1, with no patch**. In a real venue the octagon's speaker 1 is rarely
on the interface's output 1 — and there is no way to discover which physical box is which. That is the
first hour of every installation.

### Changes

- **`speakerPatch: number[]`** — decoder speaker index → device channel index. Replaces the hardcoded 1:1.
  Defaults to identity. Machine-scoped (§1).
- **Speaker check** block in Preferences ▸ Audio: click a speaker in the layout → pink noise from exactly
  that one output, for as long as it is held.

### The one design rule that makes the test tone worth anything

**The tone is injected AFTER the decoder, straight onto a device channel.** If it went through the
ambisonic encoder/decoder it would prove the *decoder* works — which we already know — and prove nothing
about the *patch*, which is the thing being commissioned. A test tone that routes through the thing under
test is not a test.

---

## 4 · ASIO — opt-in, and unbuilt by default

ASIO requires the **Steinberg ASIO SDK**: not redistributable, separately licensed, each builder must
download it. JUCE ships no ASIO headers.

**We ship nothing we cannot hear.** Neither the author nor the maintainer has an ASIO device, so enabling
it now would ship a completely unverified driver path — and drag a *third* licence (Steinberg's) into the
default build, on top of a JUCE tier that has **not been elected** and a statically-linked LGPL library.

**Decision:** `ARTLUX_ENABLE_ASIO=OFF` CMake option + documented SDK-fetch instructions in
`docs/DEVELOPMENT.md`. A venue that needs ASIO can build it. The default build gains no new licence
obligation.

WASAPI **exclusive** mode is the lever P6 actually needed, it is already in the binary, it needs no SDK,
and — unlike ASIO — we can verify it (§6).

---

## 5 · Headless — verify, then delete the fork

Headless audio is very likely already working: `--headless` boots the full `App`, the plugin host
activates as `'main'`, and the audio plugin opens the device on activation. P6 **proves** it
(`--headless --project=<fixture>` with a bed → the meters move, the room makes noise), then **deletes
`HeadlessRunner.tsx` and `headless.tsx`** — which [main/index.ts:145](../../../src/main/index.ts#L145) has
been carrying as dead code awaiting exactly this ( *"Delete in a follow-up"* ), and which is the file the
P6 plan's own risk note still cites.

The stale P6 text in `plans/audio-engine.md` (risk 5, and the `$20k` JUCE figure at WS9 that the licensing
pass already purged elsewhere) is corrected in the same pass.

---

## 6 · Verification — synthetic, and honest about it

**There is no multichannel hardware.** (Established during Wave-3 acceptance test 2.10.) P6 is therefore
gated on a **synthetic rig**, and the acceptance document will say so *in those words* rather than let the
phase read as passed.

**The rig:** a virtual multichannel device (VB-Audio Hi-Fi Cable / Voicemeeter Potato), or the built-in
output switched to **7.1 Surround** in Windows Sound.

**The gate** — using the per-channel meters that already exist (`kMaxMeterCh = 8`,
[engine.cpp:477](../../../native/audio-engine/src/engine.cpp#L477)):

1. The device opens with **8 discrete channels** under WASAPI exclusive, at a **pinned** sample rate and buffer.
2. A test tone on decoder speaker *N* lights **meter *N*, and only meter *N*.** (Proves the patch.)
3. After remapping speaker *N* → channel *M*, the same tone lights **meter *M*.** (Proves the patch is *live*.)
4. An ambisonic source panned around the octagon walks the energy around the meters **in ring order.**
   (Proves the decode and the patch agree.)
5. Opening a project authored on a different config **does not change** the device, layout, or patch. (§1.)
6. `--headless` with a bed produces sound and moving meters. (§5.)

**What this does NOT prove, and must be written down as such:** ASIO, real driver behaviour, real
converter latency, and whether eight physical speakers are wired the way the layout thinks they are. Those
close on hardware, or they do not close. **A synthetic pass is not a venue pass.**

---

## Out of scope

- **The JUCE licence election** — still the owner's call; still gates the first `v*` tag.
- **Wave 4** (`timeline-undo` → `renderer-error-containment`) and the ~30 deferred review findings in
  `plans/README.md`.
- **Wave-3 acceptance Sessions 3–12**, still never run (post-merge hardening, not a P6 gate).
- Ambisonic order > 1, SOFA/HRTF file loading, per-speaker delay/EQ (real room alignment). Filed, not built.

## House constraints (carried from Wave 3)

- **No unit-test framework, and none may be added.** TDD via hand-rolled Node assertion sims in the
  gitignored `scratch/`. Write the failing sim first.
- Gates before every commit: `npx tsc --noEmit`, `npm run build`, `npm run verify:plugins`, plus
  `npm run build:audio` for anything touching `native/`.
- **The dev app must be CLOSED for a native rebuild.** A running app locks `audio_engine.node`; MSVC fails
  `LNK1104`, the build exits non-zero and **silently leaves the stale `.node` in place** — so a correct fix
  looks broken.
- Commit messages state the **defect** and the **root cause**, and label a pre-existing bug honestly as
  pre-existing.
