# Offline bake — a surface's content rendered non-realtime to MP4 + AAC

> **Status:** 🟩 **BUILT — Phases 0–3 complete, on branch `offline-bake`, ready to merge.**
> Verified end-to-end against a real project (`tide.artlux`, two LAYER surfaces over 10 scenes): 20
> frames in 525 ms with sound, output decoded back and checked for content (mean luminance 95.5/255,
> not black). Usage docs ship with it: [docs/BAKE.md](../docs/BAKE.md).
>
> §0 records what the review passes and the on-rig runs changed — including one design that would have
> failed silently on the first GO, one that would have produced corrupt video, and three hangs found
> only by running it. **Remaining:** the cross-project import decision (§0.8), a boot probe, and alpha
> (Phase 5, named and not built).

## Context

Expensive scenes — a shader graph, a stacked timeline, text over video, several 4K layers — cost more
GPU per frame than the machine can hold at a constant rate. The ask: **pre-render them**. Run each
surface's content *off the clock*, as slow as it needs to be, and write a file the show plays back as an
ordinary cheap video decode. Non-realtime is the point — a bake that had to keep up would reintroduce
the problem it exists to solve.

**Decisions already taken:** one MP4 **per surface**; audio must be **exact** (a real JUCE offline
render, not a second JS mixer); the surface plays the bake with a **one-click bypass** back to live.

---

## 0. What the review passes changed — read this first

### ⚠ 0.1 The storage design was wrong, and it would have failed silently on the first GO

The draft swapped `Surface.content` to the baked file and kept the original in `bakedFrom`. **That
cannot work**, and the failure is invisible:

- A Scene captures `surfaces` — **placement *and* content** ([docs/SCENES.md](../docs/SCENES.md) → *What a
  Scene captures*).
- Unlike fixtures — which get a look/rig allow-list split — **surfaces are restored wholesale**.
  `sceneLook.ts:39` says so in as many words: *"it pairs with `scene.surfaces`, which a recall restores
  wholesale."*
- The state machine recalls a scene **on entering every state, including its initial one, on load**
  (`recallScene` entry action, [docs/SCENES.md](../docs/SCENES.md) §*Triggering scenes*).

So: bake → the live document points at the MP4 → the FSM enters its initial state → it recalls a scene
captured *before* the bake → the content reverts to the shader. **The bake silently never plays.** This
is the identical failure SCENES.md already records twice: a head "patched after the scenes were stored"
reverted "within seconds, silently", and a group that "reads as correctly configured, and drives nothing".

**The repo has already solved this class three times and names the rule: *project-scope data must not
ride a look snapshot*.** It is why `assets`, `groups`, `trackingZones` and `projectorOutputs` are all
explicitly **not captured**. A bake is an asset plus a binding, so it belongs in that same category.

⇒ **`Surface.content` is never modified.** Bakes live in a project-scope `ProjectData.bakes[]` and are
applied as a *rendering substitution* (§4.5). The UX is unchanged — the surface plays the baked file,
one click back to live — but scenes, cues, the FSM and OSC recalls can no longer fight it, and **no
scene needs re-capturing after a bake.**

### ⚠ 0.2 "mp4 and hap need no codec changes" was FALSE for mp4 — silently corrupt output

`VideoCodecContribution.thumbnail()` reads like a frame-exact one-shot, and for **HAP it is**
(`decodeFrameRaw(path, idx)` awaits an exact index; HAP is random-access per frame). For **mp4 it is
not**: `thumbnail()` is `return d.frame(timeSec, false)`
([mp4Decoder.ts:560-578](../plugins/mp4/src/mp4Decoder.ts#L560)), and `frame()` never blocks — on a miss it
returns *"the earliest buffered frame so we show something"*
([mp4Decoder.ts:366-372](../plugins/mp4/src/mp4Decoder.ts#L366)). Invisible in a filmstrip, corrupt in a
bake. `preRoll` is no substitute: it is explicitly *"is there a decoded BUFFER here"*, it is optional,
and its contract says it **must never seek**. ⇒ **a new `frameExact?()` is mandatory work** (§4.2).

### 0.3 The bake does not need the frame engine at all

`verify-invariants.cjs:769` forbids specifically a `domReady` gate and an
`if (!previewCanvas|surfacePreviews…) return`; an offline gate trips neither. More importantly the bake
wants *pictures*, not LED sampling — so it never calls `tick()` and the engine's only change is to
**stand down** while offline. That removes the Art-Net question by construction and shrinks the blast
radius (§4.1).

### 0.4 Also found

- **Baking trades GPU cost for renderer RAM.** `mp4Decoder` retains **every compressed sample** of the
  track ([mp4Decoder.ts:111](../plugins/mp4/src/mp4Decoder.ts#L111); `residentBytes` sums them at :215). A
  10-minute 1080p bake at 20 Mbps is ~1.5 GB resident, **per baked surface**. Pre-existing for any long
  mp4 surface — but baking makes long mp4 surfaces the normal case (§7).
- **Two new determinism holes:** the shader plugin's `iFrame` is a module-level `frameCounter++` per
  *draw*, never reset ([shaderContext.ts:59,314](../plugins/shader/src/shaderContext.ts#L59)); and its
  feedback buffers are path-dependent ([shaderContext.ts:423](../plugins/shader/src/shaderContext.ts#L423)).
- **A false alarm, retired.** The watchdog does *not* relaunch mid-bake: its render heartbeat is App's
  own rAF ([App.tsx:765](../src/renderer/App.tsx#L765)), independent of `frameEngine`.
- **Bonus the new design unlocks:** a baked surface is an ordinary VIDEO, so projector windows can
  decode it **locally** instead of being streamed `ImageBitmap`s — the same win `hapLocal` already gets.
- **Incidental, unrelated to this feature, worth recording: `Cue.restartMedia` is dead.** It is authored
  in [CueBankPanel.tsx:384](../src/renderer/components/CueBankPanel.tsx#L384) and persisted
  (`types.ts:2014`), and **nothing reads it** — `applyCues` never mentions it. A cue's "restart media"
  checkbox does nothing today. Not this plan's job to fix; do not build on it.

### ✅ 0.5 Phase 0 is DONE — measured, not assumed (2026-09-11)

Run on the **Intel dev box** (not the RTX machine) with a throwaway Electron app driving WebCodecs
directly — no ArtLux boot, no single-instance lock, so it did not disturb a dev session. Electron 42.4.1
/ **Chromium 148.0.7778.265**. `VideoEncoder`, `AudioEncoder` and `VideoFrame` all present.

| Config | Supported |
|---|---|
| `avc1.640028` 1080p — prefer-hardware / prefer-software / no-preference | ✅ all three |
| `avc1.640034` **4K** prefer-hardware | ✅ |
| `hvc1.1.6.L123.00` 1080p (**HEVC**) | ❌ **not supported** |
| `vp09.00.10.08` (VP9) / `av01.0.04M.08` (AV1) 1080p | ✅ |
| `mp4a.40.2` 48 kHz **stereo** | ✅ |
| `mp4a.40.2` 48 kHz **5.1** | ❌ **not supported** |
| `opus` 48 kHz stereo | ✅ |

**Throughput, hardware H.264, real encode of changing content:**

| | frames | wall | fps |
|---|---|---|---|
| 1080p60 | 300 | 2 517 ms | **119.2** |
| 4K | 120 | 3 347 ms | **35.8** |

**Three conclusions that feed the design:**

1. **The encoder is not the bottleneck — the content is.** 1080p60 encodes at ~2× realtime on the
   *Intel* box; the RTX machine has NVENC and is a floor above this. So the non-realtime loop will be
   waiting on shader/decode work, which is exactly the thing this feature exists to spend time on.
2. **❌ HEVC encode is unavailable — drop `hvc1` from the offered list.** H.264 is the format; VP9 and
   AV1 exist as alternatives but neither is a better fit for re-decode through `plugins/mp4`. Probe at
   runtime rather than hardcoding, since another machine may differ.
3. **⚠ AAC is STEREO-ONLY here, and that reshapes §4.3's output stage** (see there). A multichannel or
   ambisonic show cannot put its full bus in the MP4.

### ✅ 0.6 Phase 1 progress, and what the harness proved (2026-09-12)

**Built:** `engine/renderClock.ts` (the one clock) + the offline gate in both rAF loops +
`timeline.stepFrame()` + re-anchoring on every mode flip; `frameExact()` and `sourceInfo()` on
`VideoCodecContribution`, implemented for HAP and mp4. Guards: `npm run verify` is green
(**183** invariants — one of them new and mutation-tested — and 11 doc checks), plus
`npm run test:renderclock` (22 assertions) and `npm run test:frame-exact`.

**⭐ `npm run test:frame-exact` is the important one, and it earned its keep immediately.** It encodes
48 frames whose every pixel is a flat grey encoding that frame's own index, through WebCodecs +
mediabunny into a real MP4 with real GOPs, then reads them back through the real `FileDecoder` in
FORWARD, BACKWARD and RANDOM order and recovers the index from the pixels. Ground truth never touches
the code under test.

It caught **two bugs in `frameExact` that a forward-only test would have shipped**:

1. **`flush()`-to-drain poisoned the decoder.** Flushing looked like the obvious way to force the
   queue out — and it works once. But a flushed `VideoDecoder` treats what follows as a
   discontinuity, so every delta frame fed afterwards decoded to nothing: 17/48 correct, then the
   same stale picture forever. The fix that was supposed to prevent silent corruption was itself
   producing it. Drain by **yielding**; flush only at end-of-track, where there is no "afterwards".
2. **End-of-track eviction returned a confident wrong frame.** Asking "what is the best decoded frame
   at or before the target" is a question about the *buffer*, and at the end of a track nothing is
   left to feed while eviction has already retired the wanted frame. It returned frame 43 for frames
   44, 45 **and** 46. The target is now derived from the **container's sample table**, so a miss is
   checkable and becomes a re-seek instead of a plausible picture.

A third, found while fixing those: `samples[].ts` is `(cts / timescale) * 1e6` and is routinely
**fractional**, while an `EncodedVideoChunk` timestamp is a `long long` — so strict equality against
the decoded frame's timestamp matches nothing. A 2 µs window absorbs the coercion and is still four
orders of magnitude tighter than the gap between frames.

**And the measurement that justifies the whole SDK addition:** on the same backward pass,
`thumbnail()` returned the **wrong frame 48 times out of 48**. The draft plan's "mp4 and hap need no
codec changes" would not have been subtly wrong; it would have baked entirely wrong pictures.

⚠ **HAP's `frameExact` is written but UNTESTED** — nothing in the toolchain can *write* a HAP file, so
there is no round trip to run. It is five lines over `decodeFrameRaw`, which `thumbnail()` already uses
in production, and unlike mp4 it needs no seek-and-decode-forward (every HAP frame is a keyframe) — but
it has not been proven and must be on the on-rig list.

### ✅ 0.7 The rest of Phase 1's seams, and the determinism they forced (2026-09-12)

**Built since 0.6:** `timeline.compositeInto()` + `hasSolo()`; `contentSource.prepareExact()` /
`releaseExact()` with an awaited `<video>` seek; `ContentSourceProvider.offlineSafe`; and the three
shader fixes that flag turned out to require. `npm run verify` green at **184** invariants (two new,
both mutation-tested).

**`compositeInto` is the third caller of the one `compositeLayers`**, never a second copy — so
`enabled` / `muted` / `solo` / `opacity` / `blendMode` and back-to-front timeline order keep exactly
one definition, and the existing guard was extended to cover it (plus `anySoloActive`, extracted so
the compositor and the render ask the same question). `hasSolo()` exists because a solo *elsewhere*
legitimately makes a ticked track composite black — correct, matching the program, and indistinguishable
from a renderer bug unless the render refuses up front.

**`prepareExact` is where "exact or nothing" becomes policy.** `getDrawable` is synchronous and must
never stall a show, so a render does not ask it to behave differently — it *settles* each source at
the wanted time first, awaiting, and only then composites. The refusals are the substance: a live
source, or a codec with no `frameExact`, resolves **false** and the surface is refused **by name**.

**⚠ The `<video>` path carries a weaker guarantee than the codec path, and the plan should not pretend
otherwise.** `frameExact` is answered from the container's own sample table, so "the frame at t" is
checkable; a `<video>` gives us the platform's seek and nothing to verify it against. It is the best
available for formats no codec plugin claims — and since the WebCodecs mp4 path is on by default, it
is the minority case.

**`offlineSafe` defaults to NO, and that default is the feature.** A source wrongly treated as live is
refused with a message its author can act on; one wrongly treated as deterministic bakes a frozen or
jittering picture that reads as a bug in the renderer. Declared on **TEXT** (its `getDrawable` ignores
`timeSec` entirely — what moves type is automation writing `content.textX/…` before compositing) and,
after the fixes below, on **SHADER**. A new invariant asserts no live plugin (ndi, spout,
lidar-tracking, mediapipe, augmenta) ever claims it, because the flag is one word among a dozen
provider fields and the way it reaches a live source is a copy-paste, not a decision.

**Declaring the shader deterministic forced three real fixes** — it was not a flag, it was a debt:

1. `iWallTime` read `performance.now()`, so a shader would animate at *wall* speed inside a render
   stepping at its own pace.
2. `iFrame` was a module-level `frameCounter++` per draw, never reset — so a baked shader depended on
   how much else had been drawn in the session before the render started. Not reproducible even by
   baking the same range twice in a row. Offline it is now a function of time.
3. **Feedback buffers carried in from the live show.** Path-dependence *within* a render is fine (a
   fixed-rate walk is more reproducible than a display-rate one); inheriting the live session's
   accumulated state across the boundary is not. Every feedback texture is now dropped on each mode
   flip, so a render starts cold and the show does not inherit the render's state on the way out.

### ✅ 0.8 Phases 2 and 3 are built (2026-09-12)

**Phase 2 — a bake is project data.** `ProjectData.bakes` + `services/bakeStore` + one substitution at
the top of `surfaceMedia.getDrawable`, so every consumer (2D preview, LED sampler, projector pump, 3D
texture) gets it without learning what a bake is. `host.bakes` (add / setEnabled / remove / subscribe)
is the write path back through the document. **`Surface.content` is never touched**, which is the whole
point — §0.1. A new invariant (mutation-tested) asserts the store exists, the compositor consults it,
`mapAssetPaths` visits the file, and **`buildSceneSnapshot` does NOT capture it**.

⚠ **The bake is ADDRESSED BY TIME, not played.** It goes through the codec's seekable *layer* path at
`t - startSec`, not the free-running surface path — which would have been simpler and would have drifted
away from the show within a minute, which is the very thing this feature exists to prevent.

**Phase 3 — sound comes from the real graph.** `offlineBegin` / `offlinePull` / `offlineEnd` in
`engine.cpp` (~120 lines, no new dependencies), plus the read-ahead fix: offline, a clip is built with
`setSource(reader, 0, nullptr, rate)`, because `BufferingAudioSource` returns **silence** on underrun
rather than blocking, and a faster-than-realtime pull makes that the normal case rather than an edge
one. `npm run test:audio-offline` proves the three properties that matter, with **no device and no UI**:
the graph runs detached, a playing clip reaches the output (peak 0.5), and **two renders of the same
range are byte-identical** (0 differing samples).

The render pulls **sound first, then the picture**, per frame — not a preference: audio-reactive shaders
read the live device spectrum tap, and with the device detached every one of them would render flat
unless the block has already passed through the analyser when the frame is drawn.

**What the measurements forced, and it is visible in the UI:** AAC is stereo-only here (§0.5), so a
multichannel or ambisonic show cannot put its whole bus in an MP4 — binaural is already two channels and
is the right stereo rendering of a spatial show. Sound is optional and **never fatal**: no addon, or no
AAC encoder, produces a silent file plus an `audioNote` saying so, because a silent render of good
pictures is still worth having and must simply not be mistaken for one with sound.

**⚠ Deviation from §5.2, recorded rather than silently skipped: `bakes` do NOT travel across a
cross-project import.** Carrying them means growing `ImportPatch` and its three consumers; carrying them
*without* remapping would be unsafe (a stale `surfaceId` still resolves, against the source project), so
the choice is carry-and-remap or neither. Not carrying degrades safely — the imported surface plays its
live content, which is correct, just slower. The decision and the recipe are written into
`projectImport.ts` beside the other four fields it deliberately does not remap.

**A guard found five pre-existing gaps.** Widening the id-bearing-field invariant to scan
`shared/protocol.ts` (it only read `renderer/types.ts`, so everything declared in protocol.ts had always
been invisible to it) immediately surfaced `docId`, `pluginId`, `rigIds`, `sourceSurfaceId` and
`sliceIds` as unmentioned. All five are legitimately not carried; each now has its decision written down,
which is exactly what that guard asks for.

### Confirmed directly — do not re-derive

- `contentSource.getDrawable(key, content, timeSec)` **already takes an explicit time**, and surfaces
  already ride `timeline.getShowTime()` ([contentSource.ts:545-564](../src/renderer/services/contentSource.ts#L545)).
  Generative content is already a pure function of `t`.
- `SpatialBus::prepareToPlay(blockSize, sr)` is **entirely device-free** — it rebuilds scratch buffers,
  the BFormat, the binauralizer, the speaker decode, the master gain + chain, and **every clip's
  transport, encoder and chain**, touching no `AudioDeviceManager`
  ([engine.cpp:132-165](../native/audio-engine/src/engine.cpp#L132)). *(`spatialProbe()` also runs
  device-free but builds its **own** local encoder/BFormat/binauralizer, so it proves libspatialaudio is
  device-independent, not that the bus is. The bus is verified directly, above.)*
- The read-ahead trap is real: `transport->setSource(reader, 32768, &readThread, rate)`
  ([engine.cpp:1099](../native/audio-engine/src/engine.cpp#L1099)).
- `EffectChain::process` **passes dry on a channel-count mismatch** ([effects.h:324](../native/audio-engine/src/effects.h#L324)).
- `LayerBlendMode` is a **Layer** property applied by the single `compositeLayers`
  ([timeline.ts:1365](../src/renderer/services/timeline.ts#L1365)); **surfaces have no blend modes** —
  `globalAlpha` + `source-over` only ([frameEngine.ts:456](../src/renderer/engine/frameEngine.ts#L456)).
- A core generative EFFECT renders at **96×96**, and `fire()` calls `Math.random()` twice
  ([surfaceFx.ts:8-9, 90, 99](../src/renderer/gpu/surfaceFx.ts#L8)).
- `.mp4` is already in `ASSET_CATEGORIES.video` — the baked file needs **no** projectFolder change.
- Electron's renderer↔main port **silently nulls transferred ArrayBuffers**; copy, never transfer
  ([framePort.ts:50-60](../src/renderer/engine/framePort.ts#L50)).

---

## 1. The limitation today

No export, capture or encode path of any kind exists — verified across `src/`, `plugins/`, `packages/`,
`native/`, every `package.json` and the electron-builder config: **zero** hits for `MediaRecorder`,
`VideoEncoder`, `AudioEncoder`, `captureStream`, `ffmpeg` or any muxer. The only media dependency is
`mp4box` (a *de*muxer). The only "bake" in the tree bakes calibration UVs.

Four wall clocks stand between the app and a frame-stepped render:

| Where | What |
|---|---|
| [timeline.ts:106-163, 909-1147](../src/renderer/services/timeline.ts#L106) | `playhead`/`showTime`, both `(now - anchor)/1000` off the rAF argument |
| [transitions.ts:158](../src/renderer/services/transitions.ts#L158) | scene/cue fades stamp `startMs: performance.now()` |
| [frameEngine.ts:422, 621](../src/renderer/engine/frameEngine.ts#L422) | `transitions.sample()` / `lightingCue.tick()` fed `performance.now()` |
| [shaderContext.ts:312, 314](../plugins/shader/src/shaderContext.ts#L312) | `iWallTime`, and `iFrame`'s free-running counter |

## 2. What "lifted" looks like

Select surfaces → pick a range and an output size → the app stops the show and renders every frame as
slowly as it needs to, writing one MP4 per surface plus one exact soundtrack. Frame *n* is identical on
every run, and identical to what the surface shows live at that `showTime`.

**Semantics, decided — and it is what makes this simple: a bake captures a surface's CONTENT, and
nothing else.** Position, rotation, z-order, per-surface opacity, global brightness — and **every
projector-side correction: corner-pin, Bézier warp, soft edge, gamma, calibration, NVAPI** — all stay
live and apply to the baked file exactly as they did to the original (§4.7). That is why the bake needs
neither the frame engine, nor the automation overlay, nor the transition overlay, and why a bake
**survives re-calibration** instead of being invalidated by it.

---

## 3. Placement: core or plugin

**A cross-process plugin `plugins/bake` (`/main` + `/renderer`), plus four small core seams.** It owns a
heavy main-side resource (the file writer) and a renderer-side UI + frame source — the `show-control`
shape. The seams are **corrections to core clocks the app wants anyway**, plus one project-scope array.

1. **`src/renderer/engine/renderClock.ts` — NEW, ~40 lines, React-free, zero imports.** The one answer to
   "what time is this frame": `now()` returns `performance.now()` live and the stepped value offline;
   plus `isOffline()`, `beginOffline()`, `stepTo(ms)`, `endOffline()`. The four wall-clock reads above
   become `renderClock.now()`. **A net simplification** — today they are four independent epochs.
2. **`timeline.ts` — an offline step mode**, a third mode beside live and `external` (the mirror mode
   that already proves the clock can be *told*: [setExternalShowTime](../src/renderer/services/timeline.ts#L1779)).
   `frame(now)` already derives everything from its argument, so this is: suspend the rAF while
   `renderClock.isOffline()`, and expose `stepFrame()` calling the same `frame()` body. **No second loop,
   no forked `frame()`.**
3. **`contentSource.getDrawable` — an exact, awaited branch for VIDEO**, gated on
   `renderClock.isOffline()`. This makes the function's *own documented contract* finally true for video.
4. **`ProjectData.bakes?: BakeEntry[]`** in `src/renderer/types.ts` — project-scope, exactly like
   `assets`. **Not captured by scenes, not touched by cues, not recalled by the FSM** (§4.5).

Everything else — driver, encoder, muxer, dialog, progress panel, file writer — is plugin.

---

## 4. Design

### 4.1 The loop — audio first, then the frame; the engine merely stands down

Audio-reactive shaders read the **live device spectrum tap**
([audioTap.ts:66](../plugins/shader/src/audioTap.ts#L66) → `audio:getSpectrum` ← `MeteringAudioSource`,
engine.cpp:775-778). With no device open that tap reads silence, so **every audio-reactive shader would
bake flat** unless the audio block for *t* is pushed into the analyser *before* the frame for *t* is
drawn. That inverts the obvious order:

```
beginOffline()                                    // frameEngine + timeline rAFs stand down
for frame f:
  1. renderClock.stepTo(t_f)
  2. audio: reconcile() at t_f
     n = round((f+1)*sr/fps) - round(f*sr/fps)    // sample cursor — fps/sr rarely divides evenly
     pcm = offlinePull(n) → push to SpectrumAnalyser → AudioEncoder.encode
  3. timeline.stepFrame()                         // layers, stacks, program, automation, FSM
  4. await every source exact at t_f               // §4.2 — this IS the non-realtime property
  5. drawable = surfaceMedia.getDrawable(s)        // the SAME accessor the live path uses
  6. draw → export canvas → new VideoFrame(canvas, {timestamp: t_f})
     → VideoEncoder.encode → muxer → pluginSend to main → file
endOffline()
```

**The frame engine is never called.** Consequences, all good: no Art-Net during a bake *by construction*,
no interaction with `engineRunning`/`outputEnabled`, no `packAndPublish`, nothing to argue about with
invariant `:808`. Step 6 must **yield each frame** (it does — every step is awaited) so the main thread
never looks hung.

### 4.2 Making video exact — the one SDK addition

Add to `VideoCodecContribution`:

```ts
/**
 * OPTIONAL — the frame EXACTLY at a source time, awaited. For offline/non-realtime rendering.
 * Unlike frame()/layerFrame()/thumbnail(), this must not return a neighbour: resolve null rather
 * than approximate. A host baking a file cannot tell a near-miss from a hit, and a silently wrong
 * frame is a corrupt deliverable.
 */
frameExact?(layerKey: string, path: string, timeSec: number): Promise<CanvasImageSource | null>;
```

| Path | Work |
|---|---|
| **HAP** | ~5 lines — `hapDecode.decodeFrameRaw(path, idx)` is already exact and awaited; it is what `thumbnail()` does. |
| **mp4** | ~30 lines in `FileDecoder`: pump and await until a decoded frame covers `wantUs`, then return *that* frame — never the earliest-buffered fallback. All machinery (`pump`, `buffer`, `wantUs`, `lastFrameTs`) exists. |
| **plain `<video>`** | The await-`onseeked` pattern from [thumbnailCache.ts:93-101](../src/renderer/services/thumbnailCache.ts#L93) — a *pattern* to copy, not code to reuse (`grab()` downscales to thumbnail size). |

**A codec without `frameExact` is REFUSED, not approximated.** Optional keyword, mandatory behaviour.
Silent approximation is the failure class this repo has paid for repeatedly.

Free verification: `lastFrameTs`/`generation()` already exist *"so consumers can tell a fresh frame from a
repeat"* — the bake asserts the generation advances every frame, catching a missed exact frame **before
`frameExact` is written**.

### 4.3 Offline audio — the native trio

New in `native/audio-engine/src/engine.cpp`, ~150 lines, **no new dependencies** (`juce_audio_formats` is
already linked):

- `offlineBegin({ sampleRate, blockSize, channels })` — `setOutputChannels(n)` **before**
  `prepareToPlay(block, sr)` (a width mismatch passes the master chain **dry**, effects.h:324), with no
  `deviceManager` involvement.
- `offlinePull(n) → Float32Array` — `bus.getNextAudioBlock(info)` on the calling thread.
- `offlineEnd()`.

**The determinism trap:** clips are built with a read-ahead thread (engine.cpp:1099) and
`BufferingAudioSource` **returns silence on underrun rather than blocking**, so a faster-than-realtime
pull would drop out differently every run. Offline must construct with `setSource(reader, 0, nullptr,
rate)` — synchronous disk reads. *(`AudioTransportSource::prepareToPlay` blocking on disk is a live-path
hazard and exactly what we want offline.)*

Driver changes in `plugin.renderer.ts`: the drift re-lock at line 850 is **disabled** (it exists only to
correct a free-running device), and **every `loadClip` and every conform must resolve before sample 0** —
today a scene's sting is decoded on entry and loses its first few ms, acceptable live and a defect baked.

Everything downstream is already deterministic: no RNG, no wall clock, no dither anywhere in `effects.h`,
and the binauralizer uses the built-in MIT HRTF (`HAVE_MIT_HRTF ON`), so the bake is identical across
machines.

**⚠ The OUTPUT stage is constrained by Phase 0: AAC here is stereo-only (§0.5).** The offline pull can
produce whatever the bus is configured for — binaural stereo, or a 5.1/7.1/ambisonic speaker decode — but
only two channels can ride the MP4. So the bake's audio stage is:

| Engine output mode | What goes in the MP4 | Why |
|---|---|---|
| **Binaural** (the spatial path) | the bus output **as-is** | it is *already* stereo, and it is the correct stereo rendering of a spatial show — no downmix, no loss of placement |
| **Speakers, 2 ch** | as-is | nothing to do |
| **Speakers, >2 ch** | **BS.775 downmix** to stereo, **plus** a multichannel WAV sidecar | see below |

Reuse [`plugins/audio/src/audioFold.ts`](../plugins/audio/src/audioFold.ts) for the downmix — it is
already "the ONE copy, shared by both processes", carries the BS.775 coefficients and the
*"DOWNMIX, NEVER TRUNCATE"* rule (a naive L/R take drops the centre channel, i.e. the dialogue), and is
deliberately free of `node:` and DOM imports. It currently exposes only an Int16 path (`toInt16`); add a
`foldToStereoF32` beside it so `AudioEncoder` gets floats **from the same coefficients**, rather than a
second downmix appearing somewhere. Its `measureFold`/`gainFor` peak policy should apply too, so a bake
cannot silently clip.

**A multichannel show therefore gets the WAV sidecar as the authoritative audio**, and the MP4's stereo
track as a convenience/preview. Say so in the UI — an operator who bakes a 7.1 show and finds stereo in
the file must not have to guess why.

### 4.4 Encoding — WebCodecs, and deliberately not ffmpeg

**`VideoEncoder`** with `hardwareAcceleration: 'prefer-hardware'` → MediaFoundation → NVENC/QuickSync/AMF.
**H.264 (`avc1`) is the format** — §0.5 measured **HEVC encode as unsupported** on this Chromium 148
build, so `hvc1` is *not* offered; probe at runtime rather than hardcoding, since another machine may
differ. VP9 and AV1 are supported but neither is a better fit for re-decode through `plugins/mp4`.
Muxing via **`mediabunny`** (MPL-2.0, zero deps, tree-shakable, `StreamTarget`). Audio via
**`AudioEncoder`** with `mp4a.40.2` — **stereo only** (§4.3).

Three reasons this beats bundling ffmpeg, in order of weight:

1. **No codec code ships.** The encoder is the OS's, so ArtLux inherits the machine's H.264/HEVC licence
   exactly as `plugins/mp4`'s *decoder* already does. libx264 would add a GPL obligation and patent
   exposure to a tree whose licence is **an open question deferred to later in 2026**
   (`plans/licensing-relicensing.md`). MPL-2.0 is per-file weak copyleft on an unmodified dependency.
2. **No new binary, no new process.** There is precedent for fetched binaries (`opencv_world4110.dll`,
   64 MB) but **nothing in the app spawns a child process** except the watchdog — no lifecycle,
   cancellation or stdout-parsing pattern exists to copy.
3. Decode-side WebCodecs is already proven on this codebase and on the target RTX hardware.

⚠ **`mp4a.40.2` is unavailable on desktop Linux**, and stereo-only everywhere (§0.5). Both fall back
the same way — video-only MP4 + a WAV sidecar, stated in the UI. Bake is an authoring operation on the
build PC; the venue matrix is unaffected. **Probe `isConfigSupported` at bake time and report what was
actually chosen**, never assume.

⚠ **Stream the file out; never buffer it.** A 10-minute 1080p bake is gigabytes. Encoded chunks are
structured-cloneable, so `StreamTarget` pushes them over `pluginSend('bake:chunk')` and main appends to an
open handle. **Copy, never transfer** (framePort.ts:50-60).

### 4.5 ⭐ How a bake is stored and applied — the part that makes it safe

```ts
// ProjectData.bakes — project scope, the same category as `assets`. Scenes do not capture it,
// cues do not patch it, the FSM does not recall it.
interface BakeEntry {
  id: string;
  surfaceId: string;
  contentSig: string;      // fingerprint of the content that was baked (see below)
  clock: 'show' | 'playhead';   // WHICH clock the range is measured on — see below
  startSec: number;
  endSec: number;
  fps: number; width: number; height: number;
  path: string;            // the MP4, in assets/video/
  audio?: 'embedded' | 'sidecar' | 'none';
  enabled: boolean;        // the "Use live" bypass
  createdAt: string;
}
```

**⚠ `clock` is not cosmetic — a bake must be measured on the clock its content actually rides.** A
generative surface (EFFECT / shader / text) rides the **show** clock (`surfaceMedia.ts:245`); a
`LAYER`/`PROGRAM` surface rides the bound document's **playhead**. Key a LAYER bake to showTime and it
drifts out of its own range the first time a scene is recalled. The precedent to copy is automation,
which already makes exactly this per-lane choice — `timeline.ts:899`:
`const t = rt.clock === 'show' ? showTimeSec : playheadSec`. Use the same two-value field and the same
resolution, so there is one rule in the app rather than two.

**One seam applies it:** the top of `surfaceMedia.getDrawable(s)`. If an enabled, non-stale bake covers
this surface at the current time *on its own clock*, return its frame at `t - startSec`; otherwise fall
through to the authored content exactly as today. Every consumer — the 2D preview, the WebGPU sampler,
the projector pump, the 3D texture — already goes through that one function, so there is nothing else to
teach.

**⚠ The cold-start gate will not wait for a bake unless told.** `surfaceMedia.pendingMedia()` judges
readiness from `content.type === VIDEO|IMAGE` with a url — and a bake is deliberately not in `content`,
so a show could start with the baked file still opening and fall back to the *expensive* live content for
the first seconds, which is the opposite of the point. The bake plugin must register a `boot` probe for
its own files. A local file always arrives, so a bounded probe does not violate SDK.md's *"never block on
something that may never arrive"*.

**Why this is safe against the state machine, point by point:**

| Path | What happens |
|---|---|
| **Scene recall / FSM state entry** (`App.tsx:1825`, `stateMachine.ts:239`) | Restores `surfaces` wholesale — *the authored content*, which is what the bake's fingerprint expects. The substitution re-applies on top. **Nothing to re-capture.** |
| **Capture / Update Scene** (`App.tsx:1661`) | `buildSceneSnapshot` sees the authored content, never the bake. A scene captured before or after a bake is byte-identical. |
| **Cues** | `surfaceParams()` ([paramPath.ts:229-261](../src/renderer/services/paramPath.ts#L229)) publishes **no** `content.type`/`url`/`layerId`, so no authorable cue can swap content. A hand-written entry could (`setByPath` at `App.tsx:2405` is ungated) — and it would change the authored content, so the fingerprint stops matching and the bake **steps aside by itself**. Self-correcting, no special case. |
| **OSC `/scene/recall`, the tablet, the scheduler** | All funnel through the same `handleRecallScene`. Same answer. |
| **Scene/cue fades** | `SURFACE_FADEABLE` ([paramPath.ts:34-35](../src/renderer/services/paramPath.ts#L34)) is geometry + opacity + numeric leaves. Content never animates — and under this design it never *changes*, so there is no swap to glitch. |
| **Operator edits the shader** | Fingerprint mismatch ⇒ the bake is marked **stale** and steps aside. Re-bake is one click, and the original was never destroyed. |

**`contentSig`** is a stable hash of the resolved `SurfaceContent` minus transient fields — and for
`LAYER`/`PROGRAM` content it **must include the bound document key**, because track ids are minted per
scene (`defaultTimeline()` has no layers; `handleCaptureScene` deep-clones preserving ids) so the same
`layerId` shows different material in different scenes.

**The fingerprint is what gives per-scene correctness from one project-scope array.** A surface that is a
shader in scene A and a video in scene B gets the bake in A (sig matches) and its live content in B (sig
does not). No per-scene bake storage, and no re-saving a state after a bake.

**Three further consequences, all good:**

- **Zero changes to App.tsx's scene machinery.** An exclusion modelled on `SCENE3D_NOT_A_LOOK` would have
  to be added at **three** sites in one edit — the capture (`App.tsx:1661`), the recall (`App.tsx:1825`)
  and the dirty-diff normalizer (`App.tsx:1779-1792`) — or the "unstored look" chip lights permanently
  and can never be cleared. Keeping bakes off the `Surface` object touches none of them.
- **It sidesteps an aliasing trap.** `App.tsx:1825` assigns the snapshot's array object *directly* into
  live state, so after a recall `scene.surfaces === surfaces`. Any merge-on-recall would have to replace
  that assignment rather than wrap it. We never go near it.
- **No media churn on recall.** Because `content` never changes, `contentSource.reconcileMedia`
  ([contentSource.ts:382-396](../src/renderer/services/contentSource.ts#L382)) sees no url change and opens
  nothing — so a recall cannot open a decode window on the baked file. That is the clip-boundary-black
  class the swap design would have walked straight into. The bake plugin holds the file open itself via
  `codecResidency.retain(path, 'bake:<entryId>', codecId)` — owner keys are arbitrary, so this needs no
  new refcount.

**And it removes the nested-`SurfaceContent` problem entirely:** `bakes` is a flat, project-level array,
so §5 shrinks from "four sites and a remap" to "one array, mirroring `assets`".

> **The alternative, named and rejected: bake per scene via Update Scene.** This works *today with zero
> mechanism* — bake, then `handleUpdateScene` on that scene. It is rejected because it inherits the known
> trap that per-scene LAYER routing already has ([PROGRESS.md:1036-1041](../docs/PROGRESS.md),
> [SCENE-TIMELINES.md:240-258](../docs/SCENE-TIMELINES.md)): *"skip the save and the next GO onto that state
> restores the surfaces as they were… and those surfaces go black."* It would make a bake something the
> operator must remember to re-save on every state that uses it, and the bypass would be per-scene too.
> One forgotten Update Scene is a black surface at a venue.

### 4.6 ⭐ Baking a track stack — exactly what is ticked, at the right size and rate

A surface fed by the timeline names its tracks in the **Tracks** checklist
([ContentEditor.tsx:69-95](../src/renderer/components/ContentEditor.tsx#L69) — "ticking" is the code's own
word). Ticking **one** writes `layerId` (no stack, no canvas, no composite); **two or more** writes
`layerIds` and the surface composites them. The bake must reproduce that exactly.

**What gets baked — one function, never a second copy.** The ticked set is
`layerIds ?? [layerId]`, and it must go through the *existing* `compositeLayers`
([timeline.ts:1365](../src/renderer/services/timeline.ts#L1365)) with `only = new Set(chosen)`. That single
function is the only definition of what `enabled`/`muted`/`solo`/`opacity`/`blendMode` mean, and
`verify-invariants.cjs:3580` exists precisely to stop a second copy appearing. Expose it as
`timeline.compositeInto(ctx, w, h, ids)` — a third caller of the one function is exactly what that guard
wants. Two behaviours to carry across, both easy to get wrong:

- **Z-order is the track stack's, not the tick order.** Storage is already kept in timeline order.
- **⚠ `solo` is judged across the WHOLE timeline, not within the ticked subset.** A soloed track
  elsewhere makes a ticked-but-unsoloed track vanish — deliberately, so a surface goes dark exactly as
  the program does. The bake must inherit that, which means a bake run with a stray solo active bakes
  black. Refuse, or warn loudly, when any solo is live at bake time.

**Resolution — do NOT reuse the live stack canvas.** `buildStack`
([timeline.ts:1404-1427](../src/renderer/services/timeline.ts#L1404)) sizes it for *runtime*, and all three
of its rules are wrong for an export:

1. It is an **area budget**, not the source size: `budget = side * (side * 9/16)`, then
   `w = √(budget·a)`, `h = √(budget/a)`. A 1:1 surface fed by a 1920-wide track gets **1440×1440**, on
   purpose ("a stack costs what the program costs").
2. It is **grow-only**. Forcing it up for a bake would permanently raise the live compositing cost for
   the rest of the session — a bake that makes the show slower afterwards.
3. `maxW` comes from `drawableWidth(layerDrawable(id))` — **whatever clip is under the playhead right
   now**. A bake started on a 720p clip would size to 720p and upscale the 4K clip later in the range.

⇒ The bake composites into **its own canvas** at a size chosen **once**, from the **maximum native size
across the whole baked range** (scan the clips in `[start, end)` on the ticked tracks), clamped and
operator-overridable. The same applies to a `PROGRAM` surface, whose canvas is additionally **16:9-locked**
and re-probed only every 30 builds (`PROGRAM_PROBE_EVERY`, timeline.ts:1319).
A **single** ticked track needs none of this: `getLayerDrawable(id)` already returns the native drawable.

**Frame rate — never `engineFps`.** That is the *decode ask rate* (default 30) and
[frameEngine.ts:197-210](../src/renderer/engine/frameEngine.ts#L197) documents at length that it is not an
output rate. The document's own `Timeline.fps` is the honest default — it is what the ruler counts in and
what `frameSec()` already drives parking and seeking by — but note it is declared as *"frame rate for
HH:MM:SS:FF timecode (default 30)"* ([types.ts:786](../src/renderer/types.ts#L786)) and `defaultTimeline()`
mints `fps: 30`. **So a project left at the default with 60p content would bake at 30 and halve the
motion.** Default to `max(Timeline.fps, highest native fps among the clips in range)`, show both numbers,
and let the operator override.

**⚠ The SDK cannot answer either question today.** `VideoCodecContribution` exposes `aspect(path)` and
**no width, height, fps or duration** ([renderer.ts:228-230](../packages/sdk/src/renderer.ts#L228)). Add
alongside `frameExact?()`:

```ts
/** OPTIONAL — native metadata for sizing an export and for clip duration on drop. */
sourceInfo?(path: string): { width: number; height: number; fps: number; durationSec: number } | null;
```

Both codecs already hold it (mp4 derives fps at [mp4Decoder.ts:201](../plugins/mp4/src/mp4Decoder.ts#L201)
and keeps `durUs`; hap has `info.fps`/`frameCount`). **This closes a gap the ROADMAP already tracks** —
`VideoCodecContribution` having no `duration()` is why an OS-file drop of an unprobeable format lands on
a hardcoded 5 s clip. Fallback when a codec omits it: measure width/height off a decoded drawable
(`drawableWidth` already exists) and fall back to the document fps.

### 4.7 ⛔ The bake is UPSTREAM of the projector — what it must never contain

**A bake contains flat, unwarped, unblended, ungraded content, in the surface's own space.** Everything
the projector does to put that picture on a wall stays **live** and is applied to the baked file exactly
as it was to the original:

| Never baked | Where it lives, and stays |
|---|---|
| Corner-pin homography | `projector/homography.ts` (`squareToQuad`/`applyH`) |
| Bézier / grid-mesh warp | `projector/warp.ts` (`makeBezierWarp`/`evalBezier`, `WarpGrid`) |
| Soft-edge blend, blend gamma, black lift, colour gain | `projector/blendGlsl.ts` (`SOFT_EDGE_GLSL`, `softEdgeShare`) |
| Output gamma | `ProjectorGL` `uGamma` |
| Calibration / MPCDI replay | `ProjectorCalibration`, the calibrated render path in `ProjectorGL` |
| NVAPI hardware scanout warp | `projector/nvwarpApply.ts` (driver-side — downstream even of GL) |
| Alignment aids | `projector/aidRaster.ts` |
| Surface `rotation`, `content.opacity`, `globalBrightness` | applied at composite time, `frameEngine.ts:456` |

**This is guaranteed by construction, not by discipline**, and that is the point of taking the source
from `surfaceMedia.getDrawable(s)` (§4.1 step 5). The main window rasterises content and hands the
projector an `ImageBitmap`; **every item above is applied by `ProjectorGL` to that already-rasterised
image**, so the drawable the bake reads has been through none of it.

**Why it matters beyond correctness:**

- **Baking warp would double it.** The baked pixels would be warped once at bake time and again by the
  live projector pipeline — visibly wrong, and wrong in a way that looks like a calibration fault.
- **A bake must survive re-calibration.** Auto-align, a nudged corner-pin, a re-run MPCDI solve, a new
  blend width — all of these must keep working *after* a bake, without re-rendering anything. Bake the
  geometry in and every calibration change silently invalidates every bake in the project.
- It is the same rule the repo already applies to scenes: *"Outputs are the building, not the show"*
  ([docs/SCENES.md](../docs/SCENES.md)) — a scene neither stores nor restores `projectorOutputs`, because
  warp and calibration describe **this room**, not the content. A bake is content.

⚠ **The one adjacent case to decide deliberately: `SLICE`.** A slice crops another surface and is how one
picture spans several projectors (`types.ts:273`) — so a crop *is* content, and baking a slice surface
bakes the split in. **Prefer baking the SOURCE surface** and letting the slices keep reading from it
live: one bake then serves N projectors and the split stays adjustable. Baking slices individually is
allowed, but say in the UI that it freezes the division.

### 4.8 Transparency — the blend question, answered

> *"we composite the text and the video with the blend system, this should be enough to not have this
> black opaque on top of the video file?"*

**Right on the timeline path — and that is the design.** Blend modes are a **Layer** property
(`LayerBlendMode`, types.ts:483) applied by [`compositeLayers`](../src/renderer/services/timeline.ts#L1365).
A surface fed by several tracks already has text-over-video **composited into one canvas before the
surface ever sees it**, so baking that result loses nothing: opaque by construction, plain H.264 exactly
correct.

Two caveats that decide what the bake refuses:

- **`add`/`screen` is not the same picture as `normal`.** Black is neutral under `lighter`/`screen`, so
  re-blending a black-backed bake additively does hide the background — but additive *brightens* what is
  underneath instead of replacing it. A solid caption becomes a glow, anti-aliased glyph edges read
  differently, dark-on-bright is impossible. The bake must **never silently rewrite a layer's authored
  `blendMode`** to make its own output work.
- **Surfaces have no blend modes at all** (frameEngine.ts:456). A *transparent surface stacked over
  another surface* — the natural way to put text over video today — genuinely does go black.

**Therefore:** Phase 1 bakes composites and **refuses** a surface whose result is non-opaque *and* which
has another surface beneath it, naming the fix: put the text on a timeline track in the same stack as the
video, where `compositeLayers` blends it correctly. A timeline clip can already carry any `SurfaceContent`
including TEXT and SHADER (`isContentClip`, types.ts:600), so that advice is actionable today. The
matte-pair design is **Phase 5**, named and not built.

### 4.9 Resolution, and one honest limit

Bake at `max(content native size, the projector output bound to this surface)`, clamped and overridable.
Composite from the **source drawable**, never an existing intermediate — each is fixed or document-scaled:
the WebGL composite is 512², surface previews are `w*512` capped 2048, and the WebGPU atlas is a *sampling
structure sized by LED density*, not a picture.

⚠ **A core generative EFFECT renders at 96×96.** Baking one upscales from 96². Fine for LED output,
useless for a projector — the UI must say so rather than let an operator find out on a wall.

### 4.10 What cannot be baked — refused with a reason, never silently

- **Live sources:** CAMERA, SPOUT, NDI, DMX_IN, and live TRACKING / MEDIAPIPE / AUGMENTA. A *recorded*
  LiDAR take is bakeable. `surfaceMedia.pendingMedia()` already encodes most of this split.
- **A codec with no `frameExact`** (§4.2).
- **`SurfaceEffect.fire`** — `Math.random()` twice (surfaceFx.ts:90, 99). Seed it or refuse it.
- **Shader `iFrame`** — a module-level `frameCounter++` per *draw*, never reset. Derive it from the
  render clock while offline.
- **Shader feedback buffers** — path-dependent. **Not a defect to fix**: a bake stepping at a fixed rate
  is *more* deterministic than live playback. State it; do not refuse it.
- **An interactive surface** — one whose content is driven by trigger zones or tracking. Baking freezes
  the interaction, which is a change of meaning, not a speed-up. Warn explicitly.

---

## 5. ⚠️ Breaking changes

1. **`ProjectData.bakes` must be visited by the asset machinery** — one new array in `mapAssetPaths`,
   **mirroring the existing `out.assets` branch** ([projectFolder.ts:202-204](../src/main/projectFolder.ts#L202))
   almost line for line. Miss it and *Collect Assets* leaves the MP4 on the author's drive **without
   listing it in `missing`** — a clean bill of health on a project that plays nothing. Exactly the failure
   the DDS post-mortem records. `.mp4` is already in `ASSET_CATEGORIES.video`, so no category change.
2. **`projectImport.ts` must remap `bakes[].surfaceId`** through `maps.surface` and **drop** entries whose
   surface did not come across — the same doctrine `remapSurface` already applies to `layerId`/`sliceOf`
   ([projectImport.ts:694-730](../src/renderer/services/projectImport.ts#L694)), because a carried id *still
   resolves against the source project*. Also add `bakes[].path` to the three asset-collection sites
   (lines 302, 309, 414).
3. **A project with `bakes` is forward-incompatible with older builds** — an older build drops the array
   on save and the bakes are lost (the MP4s remain as assets). Coerce, never drop (invariant 6).
4. **`contentSource.getDrawable`'s `timeSec` becomes meaningful for VIDEO.** It is ignored on that branch
   today. This is a *plugin-facing contract* (the comment at 545-563 says so); the change makes it honest,
   but a third-party provider that assumed video ignores it changes behaviour — offline only.
5. **A bake stops the show.** Art-Net, projector windows, the 3D viewport and the FSM all stand still.
   **Refuse outright** under `--broadcast` / `--headless` / while the state machine is running, and
   **disarm the show-control scheduler** for the duration — a wall-clock entry firing a project switch
   mid-bake would be silent corruption.

## 6. Migration & back-compat

Zero project-file migration, and **zero change to any existing field**. `bakes` is a new optional
top-level array; a project without it behaves exactly as today. `SurfaceContent` and `SourceType` are
untouched, so every scene, cue and state-machine snapshot in every existing project stays byte-identical.

## 7. Risk evaluation

| Risk | Verified state | Mitigation |
|---|---|---|
| **A scene recall / FSM state entry reverts the bake** | **Was fatal in the draft design, and unrecoverable.** `buildSceneSnapshot` takes `surfaces` raw (`App.tsx:1661`); `handleRecallScene` does `setSurfaces(scene.surfaces)` wholesale (`App.tsx:1825`); the FSM enters the initial state **on load** (`stateMachine.ts:239`). There is **no** surface-level exclusion precedent. And an FSM recall passes no `origin`, so it defaults to `'show'` — **no dialog** (deliberately: an unattended venue must never sit on a modal) and **no undo record**. The revert is not even `Ctrl+Z`-able | §4.5 — bakes are project-scope and never live in `content`. **This is the reason for the whole storage design.** |
| **Two rAF loops keep running during a bake** (`frameEngine`, `timeline`) and re-drive codecs at the wrong time | The most important *correctness* gate | Both check `renderClock.isOffline()`. |
| **Projector geometry ends up in the bake ⇒ double warp** | Guaranteed *by construction* today: warp/blend/gamma/calibration/NVAPI are all applied by `ProjectorGL` to the already-rasterised image, downstream of `surfaceMedia.getDrawable` | §4.7. The danger is a later "optimisation" that sources bake frames from a projector-side capture instead. **Add an invariant check** naming `getDrawable` as the only permitted bake source. |
| **Baking trades GPU for renderer RAM** | `mp4Decoder` retains every compressed sample (:111, :215) — ~1.5 GB for a 10-min 1080p bake at 20 Mbps, per surface | Size the bitrate deliberately (a baked shader is low-entropy and compresses well); warn above a byte threshold; surface `residentBytes` in the bake UI. |
| `verify-invariants.cjs:769` | **Checked: the regex forbids `domReady` and an `if (!previewCanvas\|surfacePreviews…) return` specifically.** An offline gate trips neither, and the bake never calls `tick()` | Still owe a **new check** asserting the stand-down is engine-owned and lives in `engine/` — "when you add a rule, add a check". |
| `:841` — nothing under `engine/` imports React | `renderClock.ts` lands there | 40 lines, zero imports. |
| `:855` / `:883` — per-second telemetry never in App/Timeline state | Bake progress ticks at frame rate | `useSyncExternalStore` over a plugin store, or direct DOM writes (the `AutomationLane` idiom). |
| **Watchdog `render-stall` relaunches mid-bake** | **Checked: FALSE ALARM.** The heartbeat is App's *own* rAF (App.tsx:765), independent of `frameEngine` | Nothing to do — but do not move the heartbeat into the engine later. |
| **Watchdog `unresponsive`** → relaunch after `renderStallSec` | Real, and the first build HIT IT. ⚠ **`await` is not a yield** — awaiting an already-resolved promise continues in a *microtask*, and microtasks drain before the event loop paints. A generative surface settles with no I/O, so the entire render ran in one macrotask: frozen UI, progress bar that never rendered once, `unresponsive` on a long range | An explicit `setTimeout(0)` macrotask, gated on ~16 ms of elapsed time (per frame would cost minutes over a long render). Plus one before the first frame, so the busy state paints at all. |
| **The bake poisons `perfMonitor` / Prometheus / the fps HUD** | Real; the inverse of invariant `:1194` | Pause or tag `perfMonitor` while offline. Refused in broadcast, so only the editor HUD is affected. |
| **A second `GPUDevice`** | `plans/webgpu-unified-device.md` records nine failed runs sharing a device | The export composite is a **2D canvas** (`drawImage` takes `VideoFrame`/`ImageBitmap` directly, as `paintSurfacePreviews` already does). No new device. |
| **`deactivate()` / quit with a bake in flight** | `deactivateMainPlugins` is now actually called | Cancel the job, close the encoder and the file handle. Interacts with `closeGuard` (`:2091`). |
| **`mediaAccess` admission** | A rendered file the renderer previews **403s**, indistinguishable downstream from an undecodable file | `mediaAccess.allowPath(out)` on completion (src/main/mediaAccess.ts:52). |
| **OSC / cue / tablet transport commands mid-bake** | They write the transport the offline clock owns | Gate the transport funnel while offline; report "busy", do not queue. |
| **Undo** | `SHOW_ENGINE` never records | One undo entry per bake completion / bypass toggle. |
| **Rebuilding `audio_engine.node` while the app runs** | `LNK1104` → a stale addon that reads as a code bug | Close the app first. |
| **Docs gate** | `npm run verify` hard-fails on a `docs/*.md` with no manifest row | §9. |

## 8. Verification

- **Phase 0 gate, before anything else.** In *this* Electron build on the RTX machine, probe
  `VideoEncoder.isConfigSupported({ codec:'avc1.640028', width:1920, height:1080,
  hardwareAcceleration:'prefer-hardware' })` and `AudioEncoder.isConfigSupported({ codec:'mp4a.40.2' })`,
  and measure achievable encode fps. Get the number first; a software fallback is acceptable, not knowing
  which is running is not.
- **The state-machine safety test, and it is the one that matters most.** Bake a surface in a project
  with ≥2 states whose scenes were captured **before** the bake, then let the FSM cycle: `--headless
  --project=<file>` with a `dgram` listener. The bake must survive every GO, and **Use live** must
  survive them too. This is the exact failure the draft design had.
- **Determinism harness — `scripts/test-bake.cjs`.** Bake the same range **twice**, byte-compare. Any
  non-determinism (`fire`, `iFrame`, an unawaited seek, an audio underrun, an ungated live loop) shows up
  immediately. **The highest-value test here.**
- **Exactness harness, needs no encoder.** Assert the codec `generation()` advances on every frame of a
  step-through — catches a missed exact frame *before* `frameExact` exists.
- **Fidelity check.** Render frame *n* offline, grab the same surface live at the same `showTime`, diff.
- **Ticked-stack fidelity, and it is its own test.** Build a surface over three ticked tracks — one
  `muted`, one at 50% `opacity`, one on `blendMode: 'add'` — and confirm the baked frame matches the live
  composite pixel-for-pixel, in **timeline** z-order rather than tick order. Then re-run with an
  unrelated track **soloed** and confirm the bake refuses rather than quietly producing black.
- **Export sizing, across a range.** Bake a range whose ticked tracks change clip resolution partway
  (720p → 4K). The output must be sized for the 4K clip, and the **live stack canvas must be unchanged
  afterwards** — `buildStack` is grow-only, so a bake that resized it would make the show slower for the
  rest of the session.
- **Rate.** Bake 60p content on a document left at the default `fps: 30`; confirm the operator is shown
  both numbers rather than silently getting half the motion.
- **⛔ No geometry in the bake (§4.7), and it needs a projector.** Bake a surface bound to a warped,
  soft-edged, calibrated output. Then, *without re-baking*: nudge the corner-pin, change the blend
  width, and re-run the calibration. Each must take effect live on the baked picture, and the result
  must be **indistinguishable from the same change on the un-baked surface** — any difference is a
  double-warp. Inspect the MP4 itself too: its frames must be flat and rectangular, with no keystone,
  no feathered edge and no gamma lift.
- **Staleness.** Edit the baked shader; the bake must mark stale and the live content must return.
- **Round-trip.** Re-open the baked MP4 through `plugins/mp4` and play it on the surface.
- **Audio, verifiable before any visual work exists.** Drive `offlineBegin/Pull/End` from Node under
  `ELECTRON_RUN_AS_NODE=1`, as `native/audio-engine/test-*.js` already do — **no device, no UI**.
- **Portability.** Collect Assets, then Import the show into a second project: the MP4 travels, and a bake
  whose surface did not come across is dropped with a warning (§5.2).
- `npm run verify` (invariants + docs + tsc); `npm run verify:plugins` after a build.

⚠ **The editor's single-instance lock means the app cannot be run while your `npm run dev` is open.** I'll
ask on the *first* blocked run rather than shipping unverified.

## 9. Effort & phasing

| Phase | Scope | Est. |
|---|---|---|
| ~~**0**~~ | ~~Encoder capability + throughput measurement~~ | ✅ **DONE 2026-09-11** (§0.5) |
| **1** | ◕ *in progress* — ✅ `renderClock` + both offline gates + `stepFrame` + re-anchor; ✅ `frameExact`/`sourceInfo` (mp4 proven, **hap untested**); ✅ `compositeInto`/`hasSolo`; ✅ `prepareExact` + awaited `<video>` seek + `offlineSafe` (text, shader); ⏳ export size/rate resolution, the timeline-LAYER exact path, one surface → silent MP4 | 5–6 d |
| ~~**2**~~ | ✅ **DONE** — `ProjectData.bakes`, `bakeStore`, the one substitution, `host.bakes`, fingerprint/staleness, bypass, `mapAssetPaths`. ⏳ boot probe; ⛔ cross-project import (§0.8) | — |
| ~~**3**~~ | ✅ **DONE** — native trio + read-ahead fix + `npm run test:audio-offline` (determinism proven) + AAC track + streamed write | — |
| **4** | UI (inspector action, modal progress, cancel), multi-surface jobs, re-bake, docs | 2 d |
| **5** | *(named, not built)* alpha via a paired matte video | — |

Phases 1+2 are shippable together and give the whole payoff for silent content. **Phases 1 and 3 each
close a debt the ROADMAP already tracks**: `frameExact` plus the exact-video branch is the *"surface video
has no time coordinate"* gap multi-machine sync depends on, and the offline trio is the first
non-realtime path in the audio engine.

**Documentation ships in the same commits** (CLAUDE.md's gate, machine-checked): `docs/BAKE.md` tagged
`hybrid` with an `<!-- audience:contributor -->` seam, a row in `docs/manifest.json`, a row in **CLAUDE.md's
index table**, `docs/user-guide/20-baking.md` linked from `docs/user-guide/README.md`, and every
`▸ Control` path spelled exactly as the code spells it (verify-docs check 6). **SCENES.md also gains a
line** in its "Not captured" column — that table is where the next person will look.

## 10. Open questions — human decisions

1. **Bake a *scene*, or an arbitrary range?** The plan assumes a range on the show clock, defaulting to
   the bound document's length. Scene-scoped would need the FSM stepped too — but note §4.5's
   `contentSig` already has to carry the bound document key for LAYER content, so scene-scoping is half
   present either way.
2. **`MainJobContribution` — worth it?** There is still **no contribution seam on `@artlux/sdk/main`**
   (IPC-only). A typed `start/cancel/onProgress` registry would be the *first* main-side registry and
   would also serve the unbuilt `MediaSequence` idea. Decide on purpose rather than drifting into a
   channel-name convention.
3. **Keyframe interval / bitrate defaults**, given the RAM finding in §7. `plugins/mp4` decodes from the
   nearest keyframe, so a sparse GOP makes looping and scrubbing expensive; a fat bitrate costs renderer
   RAM for the whole show. Suggest ~1 s GOP and a conservative CRF-equivalent, and document both.
4. **Seed or refuse `SurfaceEffect.fire`?** And: derive shader `iFrame` from the clock, or reset per bake?
5. **Does `frameExact` belong on `VideoCodecContribution`, or is it a second contribution kind?** It is
   the first SDK method that exists purely for non-realtime use.
