# Video-clip audio — a `.mp4`/HAP clip's own soundtrack, through the JUCE engine

> **Status:** ✅ **SHIPPED** — WS0–WS6, conform-first route (the streaming/Media-Foundation route stayed
> demoted to §Fallbacks). Committed `c2eb46e` ("a video clip's own soundtrack, through the JUCE engine"),
> wired through `plugins/audio` (`movDemux`/`conform.main`/`conformClient`/`audioFold`/`wavPcm`),
> `services/videoAudio.ts`, `ClipAudioInspector.tsx`, and the `getVideoAudio` host service. Verified end to
> end in the real app; typecheck, build and `verify:plugins` clean.
> **Deferred, deliberately:** live conform status in the clip inspector ("conforming… / no audio track"), a
> waveform on the video clip, **Conform all** in the Media tab, and a cache-size control in Preferences. All
> four want the same missing seam — the conform's state lives in the audio plugin and the inspector is core —
> and none of them block use: a clip is silent for the second or two it conforms, then plays.
> · **Adds:** the audio track of a timeline **video clip** (mp4 / HAP `.mov` / anything Chromium can demux)
> played by the **native JUCE engine**, on the clip's own playhead, through the commissioned rig
> · **Placement:** **plugin** (`plugins/audio`, both processes) **+ two small core touches** (an additive
> `VideoClip.audio?` / `VideoLayer.audio?`, and one host service) · **Risk:** Low-Medium
> · **Breaking changes:** project-file additive only (normalize-defaulted); one additive SDK field; **and one
> DELIBERATE, DECIDED behaviour change — every existing project starts making sound** (§Breaking changes).
> **No native changes. No new dependency. No new licence obligation.**

## Context — why this, and the decided route

Every video source in ArtLux is silent, by construction and in three separate places: the timeline's per-layer
element is created `el.muted = true` ([timeline.ts:149](../src/renderer/services/timeline.ts#L149)), a surface's
video element likewise ([contentSource.ts:39](../src/renderer/services/contentSource.ts#L39)), and the two GPU
codec paths — HAP and WebCodecs-mp4 — **have no `<video>` element at all**: they decode video frames and
nothing else ([docs/CODECS.md](../docs/CODECS.md)). So "play the clip's sound" is not a matter of unmuting
anything; there is no audio in the pipeline to unmute.

Nor should there be. Unmuting the one path that *does* have an element would send that audio out of the default
Windows device, past the master chain, past the ambisonic decoder, past the commissioned speaker patch — i.e.
**not the rig** ([docs/AUDIO.md](../docs/AUDIO.md) ▸ Devices and speakers). A video clip's sound must reach the
room the way every other sound does: as a **`Clip` in the JUCE engine**.

**A video file's audio is a CONTAINER concern, not a CODEC concern.** The audio track of an `.mp4` is the same
AAC or PCM whether ArtLux decodes its *video* with WebCodecs, with the HAP native decoder, with a plain
`<video>`, or with the DXV plugin that isn't written yet. So this must **not** touch `videoCodecRegistry` and
must **not** be implemented per-codec — and every present and future codec then gets sound for free.

The gap is one thing wide: **the engine cannot open an MP4 or a MOV.** `formats()`
([engine.cpp:47](../native/audio-engine/src/engine.cpp#L47)) registers WAV/AIFF/FLAC/Ogg and nothing that reads
an ISO-BMFF container, so `loadClip()` ([engine.cpp:922](../native/audio-engine/src/engine.cpp#L922)) answers
`"no decoder for <path>"`. Everything *else* already exists: residency, per-frame reconcile against a clock,
seek/drift re-lock, fades, gain, spatialisation, insert chains, mute/solo, master chain, metering, device — all
in [plugin.renderer.ts](../plugins/audio/src/plugin.renderer.ts), written against a clip shape a video clip can
satisfy with no new concepts.

### The route: conform, don't stream

Two ways to close that hole:

| | **Stream** (teach the engine to read MP4) | **Conform** (decode once to a WAV cache) ✅ |
|---|---|---|
| Engine change | a new `AudioFormat` + `IMFSourceReader`, ~400 lines of COM/threading C++ | **none** |
| Who decodes | Media Foundation, on the audio read thread, forever | Chromium's own ffmpeg, once, at import |
| A drift re-seek costs | an MF seek **+ decode-and-discard**, on `artlux-audio-read` | a file offset |
| Platforms | Windows only | all |
| HAP `.mov` | unknown — needs a C++ spike | ffmpeg reads it; a 10-minute devtools check |
| Cost | none at import | seconds of import + disk cache |

**Conform wins, and the deciding argument is the show, not the edit.** What is load-bearing in this codebase is
an unattended installation cycling scenes for a week — and there, a conformed WAV is the cheapest and
most-tested thing the engine can possibly be playing. The driver re-locks a drifting clip by re-issuing
`playClip` at a new offset ([plugin.renderer.ts:546](../plugins/audio/src/plugin.renderer.ts#L546)); on a WAV
that is a seek, on AAC it is a seek plus a decode-and-discard on the thread whose deadline is 10.7 ms and whose
first invariant is *never block the audio thread* ([docs/AUDIO.md](../docs/AUDIO.md) ▸ Invariants). Conforming
also means **the engine's audio path is not touched at all** — which, for a subsystem whose own doc says
*"silence with a UI that says everything is fine is the failure this takes most seriously,"* is worth more than
the elegance of streaming. The import cost lands in the editor, with a "Conforming audio…" state, which is what
Premiere and Resolve have trained every operator to expect.

### And Chromium ships *most* of the decoder — WS0 measured exactly which part

Electron bundles a full ffmpeg, which this repo already leans on for every `<video>` and every blob URL. The
tempting version of this plan was therefore one call — `new OfflineAudioContext(2,1,48000).decodeAudioData(bytes)`
— over the whole file. **WS0 ran that against real media and it does not hold.** Measured, 2026-07-21, on
`Desktop/video-media-samples-master` + `Desktop/DemoVideos` (raw output in §WS0):

| File | Audio track (moov probe) | `decodeAudioData` |
|---|---|---|
| `big-buck-bunny-1080p-30sec.mp4` | `mp4a` + esds, 0.69 MB | ✅ 6 ch @ 48 k, 30.0 s — 158 ms |
| `sintel.mp4` (888 s) | `mp4a` + esds, 16.7 MB | ✅ 2 ch @ 48 k — 3115 ms, **325 MB of PCM in RAM** |
| `hapbig-buck-bunny-…mov` (**HAP**) | **`in24` PCM, 6 ch, 48 k, 24.7 MB** | ❌ **`EncodingError`** |
| `haphapbig-…mov` (**HAP**) | **none** | ❌ `EncodingError` (correct — nothing to decode) |

Three facts fall out, and each one changes the build:

1. **Chromium refuses the HAP `.mov` — the headline case.** Whole-file `decodeAudioData` is therefore not the
   route; it is only ever a *fallback* for containers the demuxer below doesn't recognise.
2. **The HAP master's audio needs no decoder at all.** It is `in24` — linear PCM, in a normal sample table. A
   byte-order/width conversion and a WAV header, entirely in main. **The case that looked hardest is the
   easiest**, once the container is read rather than handed whole to a decoder.
3. **Reading the whole file is absurd on exactly the files that matter.** 24.7 MB of audio sits inside a
   **1048 MB** HAP master; the moov gives the audio track's sample ranges, so the conform reads ~2% of the
   file. And it removes the 325 MB RAM spike `sintel.mp4` demonstrates.

A fourth, unlooked-for: **both** test files' audio is **6-channel** (the bunny mp4's `stsd` claims stereo and
its AAC config is 5.1 — for AAC, only the decoder is authoritative). The engine's non-spatial path is stereo,
so a naive load takes channels 0–1 and **drops the centre channel, i.e. the dialogue.** Downmixing at conform
is a requirement, not a refinement — see Requirement 10.

So: **demux in main, then route by codec** — PCM converted in main, AAC decoded by WebCodecs
(`AudioDecoder` reports `mp4a.40.2`/`mp4a.40.5`/`pcm-s24`/`opus` all supported here), whole-file
`decodeAudioData` as the last-resort fallback. Cross-platform, still zero new dependencies, and now
constant-memory by construction.

## Requirements this must satisfy

1. A video clip on a timeline plays its own audio **through the JUCE engine** — master chain, commissioned
   patch, meters. Not the default device, not the browser.
2. **The audio follows the video edit for free.** Move, trim, blade, slip, delete, undo — no link to maintain.
3. **Codec-agnostic:** identical for `<video>`-path mp4, WebCodecs mp4, HAP `.mov`, future DXV.
4. **Clock doctrine unbroken:** a video clip lives in a `Timeline`, so its audio rides **that timeline's
   playhead** and **restarts on a scene recall**, exactly like `Timeline.audio`. Never `showTime`.
5. A file with **no audio track** is a non-event: no dialog, no retry storm, one log line per path.
6. **No engine, no crash** — the existing load-or-null degrade holds.
7. Works in **`--broadcast` / `--headless`**, where no panel is ever mounted.
8. Zero project-file migration; an old `.artlux` opens byte-identical in behaviour.
9. **The conform is derivable machine state** — never in the `.artlux`, never in the project's `assets/`.
10. **A >2-channel soundtrack is DOWNMIXED, not truncated.** Both WS0 test files are 6-channel; the engine's
    non-spatial path is stereo, so taking channels 0–1 would silently drop the centre channel — the dialogue.
    ITU-R BS.775 coefficients (C at −3 dB, surrounds at −3 dB), applied once at conform.
11. **Bounded memory at conform.** No step may hold a whole video file, or a whole decoded track, in RAM.

## Architecture at a glance

```
 VideoClip (path, start, duration, inPoint)  ──┐
   + VideoClip.audio? (enabled/gain/mute/offset)│  derived, MEMOIZED ON IDENTITY, per frame
   + VideoLayer.audio? (gain/mute/solo)         │
                                                ▼
                    host.audio.getVideoAudio() → { tracks:[vl:<layerId>], clips:[va:<clipId>] }
                                                 │        path: conformOf(clip.path) ── null ⇒ not audible yet
                                                 ▼
   plugins/audio/plugin.renderer.ts ── reconcileContainer(clips, tracks, PLAYHEAD)   ← unchanged function
                                                 │
                                  audio:loadClip(id, "…/userData/audio-conform/<hash>.wav")   ← unchanged channel
                                                 ▼
                     native/audio-engine — UNTOUCHED. A WAV, like every other clip.

 ── the conform, once per source file, off the frame path ────────────────────────────────────
   main:      audio:conformOf(videoPath) → stat(path) → hash(path,mtime,size) → cached wav | null
   main:      demux moov → 'soun' trak → PCM? convert in main : AAC? frames+ASC → renderer WebCodecs
   main:      atomic write to userData/audio-conform/<hash>.wav  (LRU; the tracking-take sidecar pattern)
```

Nothing on the video side is touched. The video clip keeps its blob URL, its HAP ring, its WebCodecs decoder.
The two halves meet only at **the file path and the playhead** — which is also why they cannot drift: neither
chases the other, both are slaved to the same clock.

## Design / approach — workstreams

### WS0 · The spike — ✅ **DONE 2026-07-21**

Two throwaway scripts, both in the session scratchpad: a **moov-only track probe** (Node, reads the metadata
box and nothing else — the walk mirrors [native/hap/src/mov.rs](../native/hap/src/mov.rs)) and an **Electron
decode harness** (hidden `BrowserWindow`, `nodeIntegration`, prints to stdout). Launch note for this machine:
`ELECTRON_RUN_AS_NODE=1` is set in the shell, so the harness must be run as
`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron <main.cjs>` or Electron starts as plain Node and
`app.whenReady` is undefined.

Results are tabulated in §Context. The verdict: **route confirmed, implementation redirected** — conforming is
right, whole-file `decodeAudioData` is not, and the demux-first pipeline in WS1 is what the media actually
requires. `AudioDecoder.isConfigSupported` here: `mp4a.40.2` ✅ · `mp4a.40.5` ✅ · `pcm-s24` ✅ · `opus` ✅
(`flac` needs a `description`, untested).

### WS1 · The conform service — ✅ **BUILT 2026-07-21** (`plugins/audio`, both processes)

Shipped as five modules: [`movDemux.ts`](../plugins/audio/src/movDemux.ts) (moov-only container walk),
[`audioFold.ts`](../plugins/audio/src/audioFold.ts) (the shared fold/gain — one copy, both processes),
[`wavPcm.ts`](../plugins/audio/src/wavPcm.ts) (WAV writer + the PCM branch),
[`conform.main.ts`](../plugins/audio/src/conform.main.ts) (cache, keys, jobs, routing) and
[`conformClient.ts`](../plugins/audio/src/conformClient.ts) (the WebCodecs + last-resort branches), plus
five `invoke` channels in `plugin.main.ts`. Typecheck clean. Measured, on the WS0 media:

| Source | Branch | Time | Result |
|---|---|---|---|
| `hapbig-buck-bunny…mov` (in24 5.1, 1048 MB) | PCM, in main | **212 ms** | 5.50 MB wav, 30.02 s, reads **2.4%** of the file |
| `big-buck-bunny-1080p-30sec.mp4` (AAC) | WebCodecs | 394 ms | 5.50 MB wav, 30.02 s |
| `sintel.mp4` (AAC, 888 s) | WebCodecs | 6.9 s | 149 MB wav, 888.00 s, constant memory |
| `haphapbig-…mov` (picture-only) | — | 2 ms | `null` + a `.none` marker, never asked again |

> ### ⚠ THE BUG THIS WORKSTREAM EXISTED TO FIND: **`in24` IS NOT ALWAYS BIG-ENDIAN.**
>
> `in24` means big-endian 24-bit in the QuickTime spec, and the WS1a HAP master stores it **little-endian**,
> declaring so in an **`enda` atom inside `wave`** — a box the first draft of the demuxer only noticed well
> enough to print. Read the spec's way, that master conforms to **full-scale hash**: crest factor **4.8 dB**
> and RMS **−9.4 dBFS**, where the movie's opening is near-silent. It would have played, at level, in a
> venue, out of a file the operator had every reason to trust.
>
> It was caught by *measuring rather than trusting* — `scratch/check-in24.ts` reads the same bytes both
> ways and asks which one looks like a movie (near-silent open, 15 dB crest) and which looks like noise.
> **Endianness is now read from the file** (`enda`, plus the v2 `lpcm` format flags), never inferred from
> the fourcc.
>
> **Then the fix was cross-validated end to end**, and this is the number to keep: the same movie's
> soundtrack, decoded by two entirely independent paths — Chromium's AAC decoder in the renderer, and the
> hand-written PCM reader in main — now measures **−27.3 dBFS RMS** and **−27.2 dBFS RMS** respectively.
> Agreement to a tenth of a decibel across two codebases is what "the parse is right" looks like.
>
> Second-order consequence: the pre-fix peak of **2.401** (dead on the 2.414 worst case) had "explained
> itself" as a duplicated-stereo test file. It was the corrupted read. **A plausible story for a suspicious
> measurement is not a verification** — the corrected fold peaks at 0.906 and needs no attenuation at all.

Design notes that outlived the build:

### WS1 · design (as built)

One seam, deliberately narrow, so the decoder behind it is replaceable:

```ts
conformAudio(videoPath: string): Promise<string | null>   // → wav path, or null = no audio track
conformOf(videoPath: string): string | undefined          // sync cache hit, for the per-frame derivation
```

**The pipeline, and where each stage runs.** Main demuxes; the codec decides who decodes:

```
 main  ── movDemux(path) ─────────────────────────────────────────────────────────────────
          read ONLY the moov box → the 'soun' trak → { codec, rate, ch, bits, samples[] }
          (samples[] = {offset,size} into the file — so we read 24 MB of a 1 GB HAP master)
              │
              ├─ PCM  (in24 · sowt · twos · lpcm · raw  · fl32 · in32)  ── MAIN, no decoder ───▶ WAV
              │        read the sample ranges, convert width/endianness, ITU downmix, write
              │
              ├─ mp4a (AAC) ─── frames + AudioSpecificConfig (from esds) ──▶ RENDERER
              │        one persistent WebCodecs AudioDecoder, streamed, no seams ──▶ chunks back to main
              │
              └─ anything else ── whole-file decodeAudioData in the RENDERER (works for any mp4
                       Chromium reads; the only stage that is NOT constant-memory, and the only
                       one that can be reached by a file the demuxer didn't understand)
```

- **Main owns the cache and the key.** `audio:conformOf(path)` stats the source and hashes
  `path + mtime + size` — so a re-encoded file re-conforms and a moved-but-identical file does not. Cache dir
  `userData/audio-conform/`, atomic write (temp + rename, as [persistence.ts:53](../src/main/persistence.ts#L53)
  already argues), LRU by total bytes with a configurable ceiling. The LiDAR-take sidecar
  ([persistence.ts:118](../src/main/persistence.ts#L118)) is the precedent for the whole shape.
- **The demuxer is ~150 lines and half-written twice already** — [native/hap/src/mov.rs](../native/hap/src/mov.rs)
  in Rust (it filters `hdlr == 'vide'`; this wants the `'soun'` sibling) and the WS0 probe in JS. It reads
  `moov` only, never `mdat`, then reads sample ranges by offset. **This is what makes the HAP case work at
  all**, and it is why the file-size ceiling disappears: a conform's I/O is proportional to the *audio*, not
  the movie.
- **PCM never leaves main.** `in24` — the HAP master's format — is a width/endianness conversion. No renderer,
  no WebAudio, no IPC of audio payload, and it is the one path that cannot fail for codec reasons.
- **AAC goes to the renderer, framed.** `AudioDecoder` (`mp4a.40.2` confirmed available) with the
  `AudioSpecificConfig` lifted from `esds` as `description`. One decoder for the whole track ⇒ no per-chunk
  priming seams, which is exactly what chunked `decodeAudioData` would have introduced. Output chunks stream
  back to main and are appended; nothing holds the whole track.
- **Downmix at conform, ITU-R BS.775** (Requirement 10): `L' = L + 0.707·C + 0.707·Ls`, likewise right. Applied
  once, in main, as samples are written — never at playback.
- **48 kHz, 16-bit, ≤2 ch out.** Resampling once at conform beats resampling every block at playback; 16-bit
  halves the cache for a difference nobody will hear over a PA.
- **Dedupe like `ensureBlobUrl` does**: a `loading` map keyed by source path, because five clips can point at
  one file and a conform must run once. Concurrent callers share the promise.
- **No audio track ⇒ `null`** (the second HAP sample is exactly this), and the derivation produces no clip.
  Requirement 5 costs nothing.
- **Off the frame path, always.** Kicked from media import and a project-load sweep — never from `tick()`,
  never from the derivation, which only ever does a **synchronous cache read**.
- **Headless-safe:** the PCM path is pure Node; `AudioDecoder`/`OfflineAudioContext` need no visible window and
  no output device, so a `--broadcast`/`--headless` venue machine conforms on first open exactly like the editor.

> The memory ceiling that dominated v2's risk table is now **structural, not a guard**: only the last-resort
> `decodeAudioData` branch can hold a whole track, and it is reachable only by a container the demuxer didn't
> recognise. Keep the size refusal *there* and nowhere else.

### WS2 · The document — ✅ **BUILT 2026-07-21** (core, additive)

`VideoClipAudio` + `VideoLayerAudio` in [types.ts](../src/renderer/types.ts), `audio?` on `VideoClip` and
`VideoLayer`, and `sanitizeClipAudio` wired into `sanitizeClip`. One coercion is deliberately asymmetric and
worth knowing: **junk in `enabled` falls back to ABSENT (audible), never to `false`** — coercing a bad value
into silence would be the one coercion in that file that destroys the operator's sound rather than a number.

### WS2 · design (as built)

```ts
// src/renderer/types.ts — both optional
export interface VideoClipAudio {
  enabled?: boolean;      // ABSENT ⇒ TRUE, in every project, new or legacy (decided — §Breaking changes).
                          // false = deliberately silent. normalizeTimeline stamps NOTHING here.
  gain?: number; mute?: boolean;
  offsetMs?: number;      // per-clip A/V trim (+ = audio later)
  fadeIn?: number; fadeOut?: number;
  spatial?: AudioSpatial; effects?: AudioEffect[];   // the engine gives these away free
}
export interface VideoClip  { /* … */ audio?: VideoClipAudio }
export interface VideoLayer { /* … */ audio?: { gain?: number; mute?: boolean; solo?: boolean } }
```

`VideoLayer.audio.mute` is **deliberately not** the existing `VideoLayer.muted`, which means "excluded from the
program composite" — a visual flag ([types.ts:210](../src/renderer/types.ts#L210)). Conflating them would make
hiding a layer silence it, which no NLE does.

`sanitizeClip` ([types.ts:542](../src/renderer/types.ts#L542)) gains the coerce-don't-drop treatment its audio
twin already has: non-finite `gain`/`offsetMs`/fades → default; a non-object `audio` → `undefined`; malformed
`spatial` → absent (**invariant 6**, and the NaN-poisons-the-shared-B-format hazard at
[plugin.renderer.ts:450-459](../plugins/audio/src/plugin.renderer.ts#L450) applies verbatim to a derived clip).

### WS3 · The derivation — ✅ **BUILT 2026-07-21**

[`services/videoAudio.ts`](../src/renderer/services/videoAudio.ts) (its own module so a throwaway script can
reach it — there is no unit runner), exposed as `timeline.getBoundVideoAudio()`, `host.audio.getVideoAudio()`
and one SDK field. `scratch/test-video-audio.ts` asserts 15 properties and passes: reference stability across
frames, a new array only when clips actually move, blade/trim inheritance, the `va:`/`vl:` namespacing,
ineligible clips deriving nothing, **absent `enabled` ⇒ audible**, the offset folding into `inPoint`, and that
the visual `muted` flag is not the audio one.

### WS3 · design (as built)

A pure function over the bound `Timeline`, exposed beside `getTimelineAudio()`
([packages/sdk/src/renderer.ts:476](../packages/sdk/src/renderer.ts#L476)):

- one derived **track** per video layer: `{ id: 'vl:'+layer.id, ...layer.audio }`;
- one derived **clip** per eligible video clip:
  `{ id: 'va:'+clip.id, trackId: 'vl:'+clip.layerId, path: conformOf(clip.path), start, duration,
     inPoint: clip.inPoint + (audio.offsetMs ?? machineDefaultMs)/1000, gain, mute, fadeIn, fadeOut, spatial, effects }`.

Three properties make this the whole feature rather than a step toward it. **The conform is just a path** — an
unconformed clip yields `path: undefined`, the driver skips it (`!clip.path`,
[plugin.renderer.ts:383](../plugins/audio/src/plugin.renderer.ts#L383)), and it becomes audible on the frame
after the conform lands, with no state machine to write. **The A/V offset folds into `inPoint`** — a synthesized
clip may lie about its trim, so per-clip *and* machine-default latency compensation cost the driver zero lines.
And **the derived clip is recomputed from the video clip**, so blade/trim/slip/move/undo are inherited by
definition: there is no link to keep, hence none to break.

Eligibility: `kind !== 'tracking'`, `!isContentClip(c)` ([types.ts:243](../src/renderer/types.ts#L243)), a
`path`, `audio.enabled !== false`. The `va:`/`vl:` prefixes keep derived ids clear of authored `AudioClip` ids
within the one bound document — all that is required, since the engine never holds two documents at once
([plugin.renderer.ts:188-194](../plugins/audio/src/plugin.renderer.ts#L188)).

> ⚠ **MEMOIZE ON IDENTITY, OR THIS FEATURE COSTS 60 SYNC PASSES A SECOND.** `getVideoAudio()` is read every
> frame and `pruneOrphans` gates on the clip array's **reference**
> ([plugin.renderer.ts:622](../plugins/audio/src/plugin.renderer.ts#L622)). A fresh array per call defeats that
> gate and kicks a full `syncLoaded` — load/unload reconciliation over IPC — on every frame, forever. Cache on
> `[timeline.clips, timeline.layers, conformGeneration, videoAudioEnabled, defaultOffsetMs]` and return the **same array**
> when nothing moved; return the **shared frozen empties** for a timeline with no eligible clips, never fresh
> ones. (`EMPTY_CLIPS`/`EMPTY_TRACKS` there make the same promise for the same reason.) `conformGeneration` is a
> counter the conform service bumps when a conform lands — the one thing that must invalidate the memo without
> any document having changed.

### WS4 · The driver — ✅ **BUILT 2026-07-21** (a third container)

As designed: one more `reconcileContainer` call on the playhead, the `phSeeked` arm, `allClips()`,
`trackOfClip`, and `pruneOrphans`' identity gate. Plus the path translation + memo described below, and the
machine-scoped `videoAudio` kill switch / `avOffsetMs` read off the same settings subscription that re-opens
the device (deliberately BEFORE that function's device-key early-out — otherwise flipping the kill switch
would do nothing until the operator also changed their sound card).

**Verified end to end in the real app** (`--headless --project=…`, the WS0 HAP master on a looping global
timeline): core derives the clip → the driver kicks the conform → `[audio] conformed in24 6ch 30.0s
peak=0.906 gain=1.000 clamped=0` → the generation bumps → the clip loads and starts at the source offset the
playhead asks for (12.81 s against a 13.86 s playhead) → `loaded=1 sounding=1` for the full 30 s → **and it
restarts at `off=0.01` when the global timeline wraps.** Unattended, in the mode a venue actually runs.

> Sharp edge met while testing, worth recording because it will read as a bug to the next person: the user's
> own `project.artlux` has **one scene whose timeline is empty**, and broadcast/headless recalls that scene —
> so the bound document has no clips and nothing sounds, correctly. The clip lives on the GLOBAL timeline.
> "No sound in headless" can mean "the scene you are bound to is empty", not "the audio path is broken".

### WS4 · design (as built)

`reconcileContainer(clips, tracks, clock, nowMs)`
([plugin.renderer.ts:523](../plugins/audio/src/plugin.renderer.ts#L523)) was written to be iterated per
container with its own clock, and its solo/mute scope is already per-container. So:

```ts
reconcileContainer(vid.clips, vid.tracks, playhead, nowMs);   // the THIRD container — playhead
```

plus the same treatment in the three places the bound timeline's audio already gets: the per-frame re-read, the
`phSeeked` hard-resync arm ([:730](../plugins/audio/src/plugin.renderer.ts#L730)), and `allClips()`. It rides
the **playhead**, so `showEnded` must **not** short-circuit it — same reasoning as `Timeline.audio`
([:638](../plugins/audio/src/plugin.renderer.ts#L638)). Loading, unloading, fades, spatial/FX pushes, mute/solo:
all inherited unchanged.

**Optional and cheap:** add `getClipPosition(id)` to the engine (`transport->getCurrentPosition()`, one locked
read) so the drift test compares against the engine's **real** cursor instead of a wall-clock estimate
([:545](../plugins/audio/src/plugin.renderer.ts#L545)). It makes lipsync measurable rather than inferred, and it
benefits the bed and `Timeline.audio` identically. *(This is the only line of native work in the plan, and it is
optional.)*

### WS5 · UI — ✅ **BUILT 2026-07-21**

`Preferences ▸ Audio ▸ Video clip audio` (the kill switch + the machine A/V offset — patched WITHOUT
re-applying the device config, since neither touches the device and re-opening it would be a gratuitous
dropout in a running room), a speaker toggle on the track header writing `VideoLayer.audio.mute`, and
[`ClipAudioInspector.tsx`](../src/renderer/components/timeline/ClipAudioInspector.tsx) — a new inspector for
PATH-BASED video clips, which had none before (only generalized-content clips did). Its gain slider drafts
locally and commits on release (invariant 7), and switching audio back ON writes `undefined` rather than
`true` so a redundant field never lands in a project file.

### WS5 · design (as built)

- **Clip inspector** (video clip): an **Audio** section — enable, gain, mute, A/V offset, fades, and the
  conform state (`conforming… / no audio track / ready`). Continuous controls **draft locally and commit once**
  — invariant 7; `Fader.tsx` is the model.
- **Layer header** ([TrackHeader.tsx:51](../src/renderer/components/timeline/TrackHeader.tsx#L51)): a speaker
  toggle beside the existing visual `M`, writing `VideoLayer.audio.mute`.
- **Preferences ▸ Audio:** **the `Video clip audio` master switch (on by default — the venue's kill switch,
  §Breaking changes)**, the machine-wide default A/V offset (ms), and the conform-cache ceiling + a Clear
  button. All `AppSettings` — machine state, so none of it travels in the `.artlux`
  ([docs/AUDIO.md](../docs/AUDIO.md) ▸ `AppSettings` is the machine).
- **Media tab:** a **Conform all** action, so a venue machine can be primed before doors rather than during.
- **Not in v1:** a waveform on the video clip. `audioPeaks.ts` is path-keyed and reads a decodable file — it
  would now *work* against a conform, which makes this a small v1.1 rather than a new pipeline.

### WS6 · Docs — ✅ **BUILT 2026-07-21**

[AUDIO.md](../docs/AUDIO.md) — the headline table is now **three containers, two clocks**, plus a full
*A video clip's own soundtrack* section (conform, cache, the every-project-starts-audible warning with its
three scopes, lipsync). [CODECS.md](../docs/CODECS.md) — audio is a container concern, do not add it to a
codec. [CHANGELOG.md](../CHANGELOG.md) — under `## Unreleased`, headed **BEHAVIOUR CHANGE** rather than as a
feature, because that is what an operator needs to read first.

### WS6 · design (as built)

[docs/AUDIO.md](../docs/AUDIO.md) gains a **third container** in its two-clocks table (same clock as
`Timeline.audio`, different owner — say it explicitly, because *"which container is it in"* is the question that
doc exists to answer) and a Formats note that video containers are conformed rather than read.
[docs/CODECS.md](../docs/CODECS.md) gains the container-not-codec note. [docs/TIMELINE.md](../docs/TIMELINE.md)
gains the reset-table row. [docs/ASSETS.md](../docs/ASSETS.md) gains the conform cache (derivable, machine-local,
not packed). CHANGELOG under `## Unreleased`.

## ⚠️ Breaking changes (warn loudly)

- **Project file — additive only.** `VideoClip.audio?` / `VideoLayer.audio?` are optional and
  normalize-defaulted; an old project opens identically. A **new** project saved with these fields loses only
  them in an older build (the same forward-incompatibility class as the Wave-3 asset-path change).
- **DECIDED: every project starts with sound — including projects authored before this existed.** `enabled`
  defaults **true** everywhere; there is **no** legacy stamp and no "old files stay silent" path. A show
  authored against silent video will, on the first launch after this ships, play whatever audio its masters
  carry — scratch takes, camera-mic room tone, a stray click track — **over the bed, in a venue, unattended.**
  This is the intended behaviour (sound-by-default is what an operator expects of an NLE), and it is the one
  line of this plan that can surprise someone who never read it. It therefore ships with **three obligations**,
  none of them optional:
  1. **A machine-level kill switch** — `Preferences ▸ Audio ▸ Video clip audio` (on by default, `AppSettings`,
     so it is the venue's switch and not the show's). The gesture for *"the room is making a noise I did not
     author and I need it gone before doors"*, with no document edit and no re-save. Read by the derivation:
     off ⇒ it derives nothing, which silences it at the container rather than per clip.
  2. **The per-layer speaker toggle** (WS5) is the *authored* counterpart — "this layer is picture only" — and
     it must land in the same release, not after it.
  3. **A loud CHANGELOG entry under `## Unreleased`**, phrased as a behaviour change and not as a feature, plus
     a line in [docs/AUDIO.md](../docs/AUDIO.md) ▸ the three silences' neighbourhood: this is the inverse
     failure — *unexpected sound with a UI that says nothing is playing* — and the mixer must be able to show
     where it is coming from.
- **SDK:** `AudioService` gains `getVideoAudio()`. Internal, unstable, one implementor, one consumer.
- **Native: nothing.** `npm run build:audio` and the packaged addon are untouched (unless the optional
  `getClipPosition` lands, which is additive).
- **New machine-local disk usage** under `userData/audio-conform/`, bounded and clearable.

## Risk evaluation — **Low-Medium**

| Risk | Blast radius | Mitigation |
|---|---|---|
| Whole-file decode RAM on a long clip | renderer OOM at import | **Structurally removed** by the demux-first pipeline (WS1); survives only on the last-resort branch, which keeps a size refusal |
| A container the demuxer doesn't parse | falls to `decodeAudioData`, or silent | Measured fallback ladder PCM → AAC → whole-file → `null`; each step logs which branch it took |
| A **6-channel** soundtrack truncated to L/R | **dialogue disappears** — both WS0 files are 6 ch | ITU-R BS.775 downmix at conform (Requirement 10), asserted by a scratch test |
| A fresh derived array per frame | 60 IPC reconcile passes/s, on the audio lock | Identity memo + `conformGeneration` (WS3); a `scratch/` sim asserts reference stability |
| Chromium can't demux some container | that file is silent | WS0 spike; falls back to "no audio track", which is already a graceful path |
| Cache miss at a venue (project moved) | first open conforms everything, at load | Background conform + **Conform all** in Media; open question #4 on packing |
| Stale conform after a re-encode | wrong audio, silently | Key on `path+mtime+size`, not path |
| Lipsync offset (device latency, frame quantization) | perceptible on faces | Per-clip **and** machine-default offset; tuned once per rig with a clapperboard file |
| **An existing show starts making sound it never authored** | **the room, on the first launch after upgrade** | Decided and intended — bounded by the machine kill switch + the per-layer toggle + a behaviour-change CHANGELOG entry, all shipping together (§Breaking changes) |
| Junk `spatial` on a derived clip | **poisons the shared B-format bus — silence or full-scale noise** | The driver's existing engine-door coercion ([:466-473](../plugins/audio/src/plugin.renderer.ts#L466)) covers derived clips too |
| Decode-on-entry latency | a clip's first frames silent on scene entry | Pre-existing and documented ([:330-344](../plugins/audio/src/plugin.renderer.ts#L330)); conformed WAVs make the eventual preload tier *cheaper*, not harder |

## Migration & back-compat

None required. Absent fields read as defaults; a timeline with no eligible clips derives the shared frozen
empties. The conform cache is derivable — delete it and it rebuilds. A machine whose addon failed to build
behaves exactly as today: silent, with the `no audio engine` badge.

## Verification (repo patterns — no unit runner)

1. **WS0 devtools spike** — go/no-go, before anything else is written.
2. **Pure logic:** a `tsc`-checked `scratch/video-audio-derive.mjs` in the style of the simulations the driver's
   own comments cite — asserts (a) derived ids/paths/offsets, (b) **array reference stability across frames**,
   including "a conform landing bumps the generation and only then mints a new array", (c) a blade/trim moves
   the derived clip, (d) an ineligible or unconformed clip derives nothing audible.
3. **Conform round-trip:** conform a known file, then play the resulting WAV through the existing Audio Bed by
   hand — proves the cache before any derivation exists.
4. **In the app** (`npm run dev`): drop an mp4 on a video layer → sound, on the rig, on the meters. Then trim,
   blade, mute the layer, recall a scene (must restart), let the show clock end (must **not** silence a scene's
   video audio), pull the USB interface (`no output device` → Reconnect).
5. **HAP:** the same pass with a HAP `.mov` carrying PCM, and one carrying AAC.
6. **Lipsync:** a clapperboard/beep-flash file; measure, tune the machine default, re-measure.
7. **Unattended:** `--headless --project=<file>` with a video clip in an FSM-cycled scene, cache pre-warmed and
   cold — audio each cycle, no console growth, no leaked engine-resident sources.

## Effort & phasing — **S/M (≈2–3 focused days to hearable)**

| Phase | Contents | Est. |
|---|---|---|
| **0** | WS0 spike — **done, and it redirected WS1** | ✅ |
| **1a** | `movDemux` (moov walk → `'soun'` trak → sample table) + the PCM branch + WAV writer + downmix | 1 d |
| **1b** | the AAC branch (esds → `AudioSpecificConfig` → streaming `AudioDecoder`) + cache/dedupe/IPC | 0.5–1 d |
| **2** | WS2 types/sanitizer + WS3 derivation/SDK + WS4 driver third container | 0.5–1 d |
| **3** | WS5 UI (inspector, layer toggle, offset + cache prefs, Conform all) | 0.5–1 d |
| **4** | WS6 docs + CHANGELOG | 0.5 d |
| *v1.1* | waveform peaks off the conform; MKV/WebM demux if a show ever needs it | — |
| *later* | surface (non-timeline) video audio; audio preload tier; varispeed drift correction instead of re-seek | — |

**Deferred, and why:** a **surface** playing a video ([contentSource.ts:39](../src/renderer/services/contentSource.ts#L39))
is not on the playhead at all — it free-runs and loops on its own element/decoder clock. That is a *fourth*
container whose desired source offset must be polled from the player each frame rather than computed from a
clock (and `reconcileContainer` would need a per-clip desired-offset hook). Strictly additive to this plan, and
the timeline case is the one the shows and the tutorials need first.

## Fallbacks (not needed by WS0's result — kept on record)

WS0 promoted what was fallback #2 into the main line: the self-contained QuickTime/ISO-BMFF walk **is** WS1 now,
because Chromium refused the HAP `.mov` and the PCM inside it needs no decoder. What remains unused:

1. **Rust conform in main** — a `native/media-audio` napi crate using `symphonia` (pure-Rust MP4/AAC/ALAC/PCM,
   MPL-2.0). Worth revisiting only if the AAC branch's IPC round-trip proves awkward, or if a codec turns up
   that Chromium won't decode either. Same seam, same cache. Adds one NOTICE line.
2. **The streaming route (v1 of this plan):** a Media-Foundation-backed `juce::AudioFormat` in the addon. Kept
   on record because it is the *only* option that needs no cache at all — but it is Windows-only, puts a decoder
   on the audio read thread, and the seek cost lands during the show. WS0 makes it look worse than when it was
   drafted: MF would have had to parse the same HAP `.mov` that Chromium's ffmpeg already declined.

## Open questions / decisions

1. ~~Default for pre-existing projects: sound, or silence?~~ **DECIDED 2026-07-21: sound. All projects, new and
   legacy, start audible** — `enabled` absent ⇒ true, no normalizer stamp. The three obligations that come with
   that decision (machine kill switch, per-layer toggle, behaviour-change CHANGELOG) are listed in §Breaking
   changes and are **part of the same release**, not follow-ups.
2. **Conform-cache ceiling and eviction policy** — bytes? age? per-project? Recommend a global byte cap with LRU
   and a visible Clear.
3. Does a video clip's audio deserve its own **linked lane** under the video lane (Premiere-style, visible,
   selectable), or is the inspector enough for v1? Lanes want peaks, which the conform makes nearly free.
4. **Should a packed/portable project carry its conforms?** Machine-local is doctrinally right (derivable, like
   peaks) — but a venue handoff then conforms everything on first open. An opt-in "include conformed audio" in
   Pack would trade folder size for a cold-start guarantee.
5. Should video-clip audio be **spatialisable** in v1? The engine gives it away free, and "place the video's
   sound where the surface is" is a genuinely compelling mapping feature — but it is a new authoring surface.
   Recommend: ship the field, expose the UI in v2.
6. `getVideoAudio()` on `AudioService`, or a new `host.video` service? (Recommend `AudioService` — the consumer
   is the audio driver, and the two-containers-two-clocks doctrine lives there.)
