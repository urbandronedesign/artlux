# Native Audio Engine — JUCE + libspatialaudio (ambisonic spatialisation, effects, timeline automation, scene/state recall)

> **Status:** ✅ SHIPPED — all phases P0–P6 merged to `main` (`4541743` Wave 3 + `f37f341` P6, 2026-07-14/15). Archived 2026-07-15. *(Post-ship follow-ups still open, tracked in [SEQUENCING.md](../SEQUENCING.md#status-tracker): P6's synthetic acceptance checklist is unrun — no multichannel hardware — and the JUCE licence election gates the first `v*` tag.)* · **Adds:** a net-new native spatial-audio subsystem (NOT a limitation-lift like the other lift plans) · **Placement:** Hybrid (core types + core automation-curve engine + core timeline lane; JUCE engine + spatial UI + device settings as `plugins/audio`) · **Risk:** High · **Breaking changes:** Project-file (additive) + build-toolchain (first C++/CMake native module) + distribution/licensing obligations

## Context — why this, and the decided route

ArtLux has **zero audio today** — it is an installation/show-control tool (Art-Net, projection mapping, timeline, scenes, state machine, headless/watchdog) with no sound at all. Video is decoded with audio explicitly muted ([timeline.ts:104](../../src/renderer/services/timeline.ts#L104), [contentSource.ts:39](../../src/renderer/services/contentSource.ts#L39)); there is no `AudioContext`, no audio asset category, and — critically — **no automation-curve system anywhere** (scenes/cues are snapshot + a single fade, decoupled from the playhead).

Installations increasingly need **spatial multichannel audio locked to the show**: continuous music/ambience beds, scene-triggered stingers, sources positioned in space, and effects — all recallable by scene/state and automatable over the timeline. This plan adds that subsystem.

**Technical route (decided with the user):**
- **Substrate:** a **fully native C++ engine** — JUCE (`AudioDeviceManager` for multichannel/ASIO I/O, `juce_dsp` for effects, `AudioFormatManager` for decode) + **libspatialaudio** (ambisonic encode/decode, binaural HRTF, speaker-array decode), compiled as a **C++ N-API addon**.
- **Spatialisation:** an **ambisonic bus** — every source is encoded to B-format from its 3D position, then decoded either to **binaural HRTF stereo** (laptop/headphones) or to an **N-speaker layout** (up to 8ch). One spatial model, two decoders.
- **Placement:** persisted types + the automation-curve engine + the timeline audio lane are **core**; the JUCE engine + spatialisation UI + device settings ship as a first-party **`plugins/audio`** (the show-control / calibration cross-process precedent).
- **Scope:** a **global audio bed** (survives scene swaps) **plus per-scene one-shot clips**; scene/state recall drives gain/spatial/effect params via the existing fade engine.

## Requirements this must satisfy
1. Stereo playback on a basic laptop (binaural decode of the ambisonic bus).
2. Multichannel output up to 8 channels (speaker-layout decode of the same bus).
3. Native spatialisation engine with HRTF for stereo; a spatialisation UI; spatialisation **automation in the timeline**.
4. Effect chains (filter, reverb, …) with automatable parameters.
5. All of the above recallable by scene / state.

## Architecture at a glance

```
 Renderer (React)                         Main process                    Audio thread (JUCE)
 ─────────────────                        ────────────                    ───────────────────
 timeline.ts frame(playhead) ── transport/seek ─┐
 automationEngine.sample(playhead) ── curves ───┤   audioManager.ts        AudioProcessorGraph
 plugins/audio driver (playhead sub) ── clips ──┼─▶ (loads audio.node, ──▶  ├─ file players (AudioFormatManager)
 Stage.tsx transitions.sample ── param fades ───┘   graceful-degrade)       ├─ juce_dsp effect chains (per bus)
 spatial panel (ambisonic UI) ── positions ─────▶  plugin:<ch> bridge  ◀──  ├─ libspatialaudio: encode→B-format→decode
 device settings ── device/layout ─────────────▶                       ◀──  └─ AudioDeviceManager (ASIO/CoreAudio/WASAPI)
                              level meters ◀───────────── poll ────────────  (binaural stereo OR N-speaker)
```

Control is JS→native N-API calls (like `output-engine`'s `push_frame`); metering polls back over the generic `plugin:<ch>` bridge. The engine renders **sample-accurately against its own audio clock**, periodically re-synced to the timeline playhead (the phase-lock trick the projector windows already use, [timeline.ts:417-428](../../src/renderer/services/timeline.ts#L417)).

## Design / approach — workstreams

### WS1 · Audio asset support (core)
- Add an `audio` category + extensions to `ASSET_CATEGORIES` (`wav`,`aiff`,`flac`,`ogg`,`mp3`,`aac`) and `TYPE_CATEGORY`/`CAT_TYPE`, a new `AssetType` value, and `assets/audio/` folder creation in [projectFolder.ts:15-31,106](../../src/main/projectFolder.ts#L15); add audio MIME cases to [mediaCache.ts:12-24](../../src/renderer/services/mediaCache.ts#L12). Decode is done natively (JUCE `AudioFormatManager`) — audio files are read from disk in **main** and passed to the addon by path (no renderer Blob decode needed).

### WS2 · Core persisted types (core — by doctrine)
- New types in `src/renderer/types.ts` (behavior lives in the plugin, but persisted types stay core, per CLAUDE.md:171): `AudioTrack`, `AudioClip` (path, start/duration/inPoint/sourceDuration, gain, mute, fadeIn/Out, busId, `spatial?:{x,y,z,order}`), `AudioBus` (gain, effect chain `AudioEffect[]{type,params}`, send), and an `AudioMix`/graph container.
- **Global bed:** a new opaque top-level `ProjectData.audio?` field in [protocol.ts:527-546](../../shared/protocol.ts#L527) (mirrors `schedule` at :541), assembled in `buildProjectData` and defaulted in `applyProjectData` ([App.tsx:773-792,795-892](../../src/renderer/App.tsx#L773)).
- **Per-scene one-shots:** an `'audio'` `LayerKind` + audio lane on the core `Timeline` ([types.ts:202,330-346](../../src/renderer/types.ts#L202)) so audio clips ride the existing per-scene timeline scoping; defaulted in `normalizeTimeline` ([types.ts:351-367](../../src/renderer/types.ts#L351)).
- Add a `host.audio` SDK service exactly as `host.show` was added (SDK renderer host services, implemented in App's `pluginHost` memo [App.tsx:1176-1205](../../src/renderer/App.tsx#L1176), no-op in `NOOP_HOST` [host/plugins.ts:38-44](../../src/renderer/host/plugins.ts#L38)).

### WS3 · Automation-curve engine (core — the biggest NEW piece)
There is **no** keyframe/envelope system today (verified: zero hits for automation/keyframe/envelope/lane). Build it once, generically (serves audio spatial + effect params now, non-audio later):
- **Data model:** `AutomationLane { targetPath: string; keyframes: {t,value,curve:'linear'|'hold'|'bezier',c1?,c2?}[] }` scoped to a `Timeline` (global) and/or a scene timeline. `targetPath` reuses the existing dot-path grammar (`audio.<trackId>.spatial.x`, `audio.<busId>.effects.0.cutoff`).
- **Sampler:** evaluate active lanes each frame inside `timeline.ts` `frame()` right after the playhead is computed ([timeline.ts:290](../../src/renderer/services/timeline.ts#L290)); push resolved values into the target (audio engine and/or `StateView`). Sample-accurate audio automation is handled by pushing whole curve segments to the JUCE engine ahead of time, not per-frame scalars.
- **Editor UI (core):** automation lanes render inside `components/timeline/` (lane rendering is core-only — not a plugin seam), added alongside the existing `Lane.tsx`/`TrackHeader.tsx` architecture (docs/TIMELINE.md:21-47).

### WS4 · The JUCE engine (native, in `plugins/audio` + `native/audio-engine`)
- New **C++** crate `native/audio-engine/` (first non-Rust native module): JUCE `AudioDeviceManager` → `AudioProcessorGraph` with per-bus `juce_dsp` effect chains (`IIR`/`StateVariable` filters, `dsp::Convolution` reverb, gain), `AudioFormatManager` file players, and **libspatialaudio** for `encode(position)→B-format→decode` (binaural via MIT/SOFA HRTF, or speaker-array decode for N-channel).
- **N-API surface** (node-addon-api): `configure(deviceCfg)`, `loadClip(id,path)`, `transport(play/seek/stop)`, `pushAutomation(targetPath, segment)`, `setParam(path,value)`, `setSource(position)`, `getMeters()`, `close()`. Own audio thread; JS never touches the audio callback.
- **Loaded in main** by a new `src/main/audioManager.ts` following the `outputManager.ts`/`ndiManager.ts` graceful-degrade loader ([outputManager.ts:25-42](../../src/main/transport/outputManager.ts#L25), [ndiManager.ts:40-67](../../plugins/ndi/src/ndiManager.ts#L40)): probe `process.resourcesPath` → `cwd` → `__dirname/../../native`, catch+log, feature disabled (no crash) if the `.node` is absent.

### WS5 · Renderer plugin (`plugins/audio`, cross-process; show-control template)
- `plugin.main.ts` activates the engine + registers control/meter IPC on `ctx.ipc`; `plugin.renderer.ts` gates to the main window (`if (ctx.window!=='main') return`), registers `ctx.settings` (device/channels/output-mode), `ctx.panels` (spatial editor, `mount:'modal'`), `ctx.clipKinds` (`{kind:'audio',skipVideoSync:true,excludeFromProgram:true}` like [lidar plugin.renderer.ts:50-52](../../plugins/lidar-tracking/src/plugin.renderer.ts#L50)), and consumes `host.audio`.
- A **playhead-subscribed audio driver** (the [trackingPlayback.ts](../../plugins/lidar-tracking/src/trackingPlayback.ts) precedent) `timeline.subscribe(playhead)` schedules clip starts/gains and pushes automation segments to the engine over the `plugin:<ch>` bridge; a meter subscription drives level UI. Barrel-only imports + `"sideEffects": false` (singleton hazard, CLAUDE.md:164).

### WS6 · Scene / state binding (reuse existing machinery)

> ⚠ **CORRECTED IN PLACE (Wave B, 2026-07-12) — this section was wrong, and the two bullets below are kept
> only so the correction has something to point at.** P5 shipped as
> [2026-07-12-audio-scoping-wave-b.md](../../docs/superpowers/plans/2026-07-12-audio-scoping-wave-b.md),
> Tasks 9–10. What it actually took is in the two struck-through bullets' footnotes.

- ~~Extend the dot-path model for an `audio.*` namespace: add handling to `getByPath`/`setByPath`, … and an audio slice on `StateView` threaded through its construction sites.~~ — **NOT WHAT SHIPPED.** `getByPath`/`setByPath` were **not** extended and `StateView` was **not** widened: audio is not in `StateView` and never will be (widening it means touching 9 construction sites and adding two per-frame allocations in `Stage`'s tick). Audio reads/writes go through the **automation-target registry** instead. What was needed: one head-aware `pathLeaf()` helper (the old grammar was hardwired to `<head>.<id>.<leaf>` via `slice(2)` — an audio path is one segment deeper), an `AUDIO_FADEABLE_RE` leaf set + an `isFadeablePath` audio arm, and a registry-driven cue picker.
- ~~Per-frame apply of audio param fades at the existing hook (Stage.tsx:263-274)~~ — **THERE IS NO AUDIO SINK IN `Stage`'s `tick()`.** The `eff*` values it computes feed only the LED mapper and the composite. The real sink is the **audio driver's own `eff`/`effGain` pull-through** in `plugins/audio/src/plugin.renderer.ts`, which reads a layered `lane-override ?? scene-fade ?? authored` value every frame.
- ~~Scene/state recall then works with **no new recall plumbing**~~ — **CORRECTED (Wave B, 2026-07-12).** The
  *recall* plumbing is reusable; the **param model was not extensible.** `paramPath.ts` had **zero**
  occurrences of "audio"; `isFadeablePath`/`getByPath`/`setByPath` are hardcoded head switches whose whole
  grammar is `<head>.<id>.<leaf>` via `slice(2)`; `StateView` is a closed 3-field interface not exported
  from `@artlux/sdk`; `transitions.ts` is typed on `StateView` end-to-end; and there is **no
  `paramPathRegistry`**. Worse, `automationOverlay.owns()` — the rule that makes "a lane always wins over a
  scene fade" true — is a **core-only** map, so it could never see that an audio lane owned
  `audio.master.gain`, and `setByPath` on an `audio.*` path was a **silent no-op**.
  P5 therefore required: a head-aware `pathLeaf`, an `AUDIO_FADEABLE` leaf set, a registry-driven cue
  picker, `writeFade` / `releaseFade` / `releaseAllFades` / `getLive` on the SDK's
  `AutomationTargetProvider`, a **second override layer** in the audio plugin read *under* the automation
  one, a `FadeLeg.log` flag (the fade engine interpolated linearly over log-curve params like `cutoff`),
  and `Scene.audio?: CueEntry[]` + a `CaptureTarget` interface so the picker could commit to a **scene**
  and not only to the selected cue. See
  [2026-07-12-audio-scoping-wave-b.md](../../docs/superpowers/plans/2026-07-12-audio-scoping-wave-b.md), Tasks 9–10.
- **Global bed** clips live on `ProjectData.audio`. ~~They survive swaps~~ — **they survive swaps *and no
  longer restart*: they ride the new SHOW CLOCK** (`showTime`), which a scene recall does not reset. **Per-scene**
  clips are `Timeline.audio` and ride the **playhead**, restarting with their timeline. *The clock follows the
  container.* See [docs/TIMELINE.md](../../docs/TIMELINE.md#the-show-clock-wave-b--one-transport-two-playheads).

### WS7 · Spatialisation UI (plugin modal panel, + optional stage overlay)
- A `mount:'modal'` panel (`ctx.panels.register`, mounted at [App.tsx:1930-1932](../../src/renderer/App.tsx#L1930)) with a 2D/3D positioner per source, ambisonic-order selector, per-bus sends, and HRTF/speaker-layout picker. Positions are automatable (WS3) and fadeable (WS6).

### WS8 · Output / device config (settings)
- A `SettingsSection` (device selection, channel count, **output mode** = binaural-stereo vs speaker-layout, speaker-layout definition, ambisonic order), persisted under `AppSettings.plugins['audio']` (self-defaulted, the [ShowControlSettings.tsx:13-18](../../plugins/show-control/src/ShowControlSettings.tsx#L13) idiom).

### WS9 · Build / packaging / licensing
- New **C++/CMake** build path: node-addon-api + node-gyp/CMake, `electron-rebuild` for Electron 42's ABI; extend `scripts/copy-native.cjs` + electron-builder `extraResources`; per-OS CI. COOP/COEP **not** needed (native path, no AudioWorklet/SharedArrayBuffer). **Licensing:** JUCE is dual-licensed (commercial or AGPLv3); libspatialaudio is LGPL-2.1 (dynamic-link or comply). See [`NOTICE`](../../NOTICE) and juce.com for current terms — specific tier/revenue figures were purged from this plan during the licensing pass as unverifiable from memory; a confidently-wrong licence figure is worse than none.

## ⚠️ Breaking changes (warn loudly)
- **Persisted `.artlux`:** all additive optional (`ProjectData.audio`, `Timeline` audio lane + automation, per-clip audio fields) with `normalize*()` defaults ⇒ **old projects load unchanged, no version bump** ([types.ts normalize pattern](../../src/renderer/types.ts#L351)). New `AssetType`/category is additive.
- **Build toolchain (the real break):** introduces the **first C++/CMake native module** into a Rust-only native tree — new build scripts, per-OS CI, Electron-ABI rebuild, and packaging wiring. A dev/CI break, not a runtime one; the loader graceful-degrades if the addon is missing.
- **SDK:** additive `host.audio` service + new contributions (settings/panel/clip-kind) — no removal, no existing-contract change. Generic `plugin:<ch>` bridge ⇒ **no IPC contract break**.
- **Core-invasive (additive but wide):** the automation-curve engine touches the core timeline (`Timeline` type, `timeline.ts` frame loop, `components/timeline/` lane UI) and `paramPath.StateView` is threaded through several sites.
- **Distribution/legal:** JUCE + libspatialaudio license obligations become a shipping requirement.

## Risk evaluation — **High** (largest feature to date)
Blast radius (grepped): `timeline.ts` `frame()` (new per-frame automation sampler — perf-sensitive), `paramPath.StateView` + its construction sites, `Stage.tsx:263-274` apply hook, `projectFolder.ts` assets, `App.tsx` persistence loader, `components/timeline/` lane UI, and the whole native build/CI/packaging surface. Top risks:
1. **Audio↔video sync / drift** — the hardest real-time problem; mitigated by curve-ahead scheduling + periodic playhead re-sync (projector phase-lock pattern).
2. **New C++/JUCE toolchain × 3 OSes** — build/ABI friction (EBUSY-class rebuild pain, on top of the existing Rust flow); the single biggest engineering cost.
3. **The automation-curve engine is itself a large new core subsystem** (data model + sampler + editor UI) with value beyond audio.
4. **Licensing gate** (JUCE dual-license election — see [`NOTICE`](../../NOTICE) / juce.com) + **LGPL compliance** (libspatialaudio linkage).
5. **Headless audio** — headless boots the full App ([main/index.ts](../../src/main/index.ts)) with `?headless=1`; the plugin host activates as `'main'` and the audio plugin opens the device on activation, same as any other window (and P6's settings-subscribe fix makes it open the machine's real layout, not binaural/2ch). **The code path is wired; audible confirmation on hardware is a pending P6 acceptance check — not yet heard.**
Singleton/barrel hazard applies to `plugins/audio`. WebGPU/WebGL parity: N/A.

## Migration & back-compat
Additive optional fields + `normalize*()` defaults; `ProjectData.version` stays `'1.1'`; projects without audio load silently. Engine absent/unbuilt ⇒ graceful degrade (no sound + a `[audio] unavailable` log), identical to the other native modules.

## Verification (repo patterns — no unit runner)
- `npx tsc -p tsconfig.json --noEmit` across the new core types + plugin.
- **Spike gate (Phase 0):** a bare JUCE N-API addon opens a device and plays a file from JS in Electron 42 — proves the toolchain + ABI before anything else.
- `npm run dev` + a `.artlux` test fixture: an audio clip on a lane → **hear it**, watch meters; a keyframed spatial path → source moves in sync with the playhead; a filter/reverb bus with an automated cutoff → audible sweep.
- **Multichannel:** route to an 8-ch interface (or a virtual multichannel device) and confirm discrete per-channel output; **binaural:** headphone HRTF check.
- **Scene/state:** bind audio gain/spatial to scenes + a state, confirm recall + fade and that the global bed survives a scene swap while a per-scene one-shot restarts.
- **Graceful degrade:** rename `audio.node`, relaunch, confirm no crash + the unavailable log.
- **Headless:** with headless transport wired, `--headless --project=<fixture>` produces audio to the configured device.

## Effort & phasing — **XL**, gated
- **P0 Spike:** JUCE↔Electron N-API addon plays a file (de-risks the toolchain).
- **P1:** core types + WS1 assets + stereo playback (global timeline) + device settings.
- **P2:** ambisonic bus + libspatialaudio (binaural first, then speaker decode) + spatial UI.
- **P3:** effect chains (juce_dsp) + effect params.
- **P4:** the core automation-curve engine + timeline automation lanes.
- **P5:** scene/state binding (paramPath) + global-bed/per-scene scoping.
- **P6 (complete):** multichannel hardening (ASIO, speaker layouts), headless wiring, packaging/CI/licensing.
Ship P0–P1 behind the graceful-degrade loader so the tree stays releasable throughout.

## Open questions / decisions
1. **Ambisonic order** — 1st-order (cheap, 4ch bus, fine for ≤8 speakers) vs 3rd-order (16ch, sharper imaging)? Recommend **1st-order** for v1.
2. **libspatialaudio vs SAF** — start with libspatialaudio (LGPL, simpler); keep SAF (Spatial_Audio_Framework) as an upgrade path for higher-order decoders.
3. **JUCE license** — elect a tier per current terms at [`NOTICE`](../../NOTICE) / juce.com (figures not restated here — see the licensing-pass rationale in WS9); avoid AGPL (viral).
4. **Per-scene audio crossfade** — the one-transport invariant gives no true cross-scene audio dissolve today; accept restart-on-swap for per-scene one-shots, keep continuous material on the global bed.
5. **Automation-curve engine ownership** — build it as a **general core feature** (usable for non-audio params later) rather than audio-only? Recommend yes.
6. **mp3 decode** — JUCE mp3 needs an enable flag/format; confirm we ship wav/flac/ogg first and gate mp3.
7. **Device config scope** — per-machine (prefs) vs per-project; recommend prefs, since hardware differs by venue.
