# Video codecs — HAP & MP4/WebCodecs

Video decode in ArtLux is **pluggable**. `.mov`/`.mp4` files dispatch through the
**`videoCodecRegistry`** (a `VideoCodec` contribution — see [PLUGINS.md](PLUGINS.md) /
[SDK.md](SDK.md)) from three call sites: **surfaces**, the **timeline**, and **thumbnails**. Two
first-party codecs ship today; the default `<video>` element handles everything else.

| Codec | Plugin | Formats | Path |
|---|---|---|---|
| **HAP** | `@artlux/plugin-hap` | HAP / HAP Q / HAP Alpha in `.mov` (**not** HAP Q Alpha) | native decode (main) → **WebGL2 BC-decompress** on the GPU (renderer) |
| **MP4 / WebCodecs** | `@artlux/plugin-mp4` | `.mp4`/`.m4v` (H.264/H.265) | **WebCodecs** decode + `mp4box` demux, **renderer-only**, **on by default** |
| *(default)* | — (host) | any browser-playable video | HTML `<video>` element |

## HAP (`@artlux/plugin-hap`)

**HAP** is a GPU-friendly intermediate codec (large files, tiny decode cost) — the go-to for
multi-layer, high-resolution playback in VJ/mapping tools.

- **Always on** when a `.mov` is HAP-encoded; no setting required.
- **Pipeline:** a native decoder in **main** produces compressed BC (S3TC/DXT) blocks; the renderer
  **decompresses on the GPU** (WebGL2), so the CPU cost is minimal even at 4K across many layers.
- **The decompression target is an `OffscreenCanvas`**, not a DOM `<canvas>` — it is never displayed,
  only sampled, and an OffscreenCanvas is the version that can exist in a worker once the engine moves
  there. Two ways back, because HAP is the most show-critical codec here: it falls back to a DOM canvas
  automatically when `OffscreenCanvas` or a WebGL2 context on it is unavailable, and a venue can force
  the old path without a rebuild with `localStorage['artlux.hapDomCanvas'] = '1'` (then restart — the
  flag is read when a decoder is created). Both are `verify:invariants`-guarded, and the revert has been
  exercised rather than assumed.
- **The first `VideoCodec` contribution** — its logic (surface player with its own clock, the timeline
  layer's decode ring, and the thumbnail one-shot) moved verbatim out of the host into the plugin, so
  all three paths share one decoder identity.
- A frame is re-uploaded to the GPU only when the decoded index actually advances (no redundant
  uploads).

### Which HAP variants play

| fourcc | Name | Texture(s) | Status |
|---|---|---|---|
| `Hap1` | HAP | RGB DXT1 (BC1) | ✅ |
| `Hap5` | HAP Alpha | RGBA DXT5 (BC3) | ✅ — **this is the transparency-capable variant to export** |
| `HapY` | HAP Q | scaled YCoCg DXT5 | ✅ |
| `HapA` | HAP Alpha-Only | A_RGTC1 (BC4) | ✅ |
| `HapM` | **HAP Q Alpha** | scaled YCoCg **+ a second** A_RGTC1 texture | ❌ **not decoded** |

`HapM` is a **multi-image** format: one frame carries two textures, and the decoder reads one. It is
**refused at open** (`native/hap`: `hap::probe_frame` validates sample 0's section header, so the
container fourcc alone can no longer let a file through), which logs a single line naming the variant
and hands the file to the host's normal fallback — a plain `<video>`, which cannot decode HAP either,
so the surface is black. **Re-export as Hap Alpha (`Hap5`)** for transparency, or Hap Q (`HapY`) if you
do not need it.

⚠ **Why the refusal is at the door.** The renderer's decode-ahead ring re-fills on every rAF, so a frame
that cannot decode used to be re-requested three times a frame, forever — each attempt a real seek +
read of a multi-MB sample in main, each logging a warning. That is a full-speed retry loop with black on
the output, and it costs far more frame rate than the missing picture does. Two guards now stand behind
the open-time check: the ring remembers failed indices and gives up on a file after a few
(`hapDecode.markFailed`), and the main-side decode warns **once per path**.

### One decode serves every window

Every window that shows HAP runs its own decode-ahead ring — the main renderer, plus each projector
output (`ProjectorApp` sets `hapLocal`, so a mirror decodes timeline layers itself rather than consuming
streamed frames at ~30 fps). Two rules keep that from multiplying the work by the number of outputs, and
any future `.mov` codec should inherit both:

- **`hapManager.decode` dedupes in flight and caches recent frames** (byte-bounded, ~48 MB — one 4K
  HapQ frame is ~8.3 MB, so a count-bounded cache would be enormous). Windows asking for the same
  `(path, index)` a frame or two apart share **one** native decode.
- **A mirror decodes only the layers it draws.** `timeline.setLocalLayers()` scopes the mirror's layer
  sync; `ProjectorApp` pushes its surface's layer id on every `config` (plus a `TRACKING` surface's
  background layer, which it wants at display rate). Before this, a projector showing an `IMAGE`
  decoded the whole timeline's video anyway. Guarded by `npm run verify:invariants`.

### The cold-start buffer guarantee applies to every codec

The boot gate does not wait for a first frame, it waits for a **decoded buffer** — a decode-ahead codec
starts empty, so a show armed on "frame 0 exists" opens by missing the next hundred (measured on a
1080p60 HAP show: **167 ring misses in the first ten seconds**). HAP has answered that since the
measurement. **MP4 — the default codec — did not**, so the guarantee silently excluded every `.mp4` in
every show; it now implements `preRoll` too.

Two details worth knowing if you write a codec:

- **`preWarmLayer` exists because `preWarm` is not always enough.** `preWarm(path)` opens whatever the
  *surface* path uses. MP4 keys its **timeline layer** decoder per layer (so each layer scrubs
  independently), and that one opened lazily on its first frame request — returning null while it did.
  The gate could therefore pass while a layer was still demuxing, and the layer stayed black with the
  show already running. HAP omits `preWarmLayer` because its ring genuinely is path-keyed.
- **MP4 pre-rolls ~11 frames, not the 18 that 0.3 s implies.** `MAX_BUFFER` is 12 because holding many
  live 4K `VideoFrame`s stalls NVDEC. Starving the hardware decoder to satisfy a constant would trade a
  real stall for a nominal one, so the target is capped — ~180 ms at 60 fps, within a rounding error of
  HAP's 300 ms ring. A clip shorter than the lead (a two-second sting) is satisfied by reaching its own
  end, or the gate would hold the whole show to its timeout over a clip that is entirely ready.

### Who closes a decoder — `residentBytes` and the residency budget

A codec keys its surface decoder by **path**, so N surfaces on one file cost one decode — and
`closeSurface(path)` therefore may only run when the *last* holder lets go. `services/codecResidency`
is that refcount, for the whole app: surface consumers **and** the timeline's warm pools share one
owner vocabulary, because two independent counts over the same decoder is how warm pools came to hold
decoders that were never freed.

`VideoCodecContribution.residentBytes?(path)` is the optional other half — roughly what a decoder is
holding, so the preloader's budget can bound standby pools by cost rather than by count. HAP reports
its decode ring (raw BC blocks, ~1 MB per 1080p DXT1 frame, ~4 MB per 4K DXT5); mp4 reports the
encoded samples it keeps resident for instant seeking, which for a long clip is most of the file.
Both **under-report** — neither can see GPU-side frames or driver allocations — and the host labels
the number as best-effort for that reason. Omit the method and the budget falls back to counting open
decoders, exactly as omitting `preRoll` falls back to waiting for a first frame.

**Thumbnail decoders are capped (MP4: 4, LRU).** They are the one pool nothing refcounts — `decoders`
is held by the host and `layerDecoders` is freed by `releaseLayer`, but a thumb decoder had no release
path at all, and each holds a whole track's encoded samples so seeks are instant. Scrubbing a filmstrip
across a large library therefore accumulated one resident track per file, permanently. The symptom was
visible before it was understood: measured codec residency climbed **past the size of the entire media
pool**, which is only possible if one file is resident several times over.

## MP4 / WebCodecs (`@artlux/plugin-mp4`)

Frame-accurate `.mp4` decode via the browser **WebCodecs** API + `mp4box` demux — an alternative to the
default `<video>` element.

- **On by default** (`AppSettings.mp4WebCodecs`, absent ⇒ true). Why: **frame-accurate** seeking and
  **no hardware-session cap** — the `<video>` element limits how many decoders run at once, which a
  timeline-heavy show hits, while WebCodecs lets many layers/clips decode independently and hands back
  `VideoFrame`s the engine can use directly.
- **Turning it off** (Preferences ▸ Video) forces every `.mp4` back onto a `<video>` element for the
  whole machine. It is an escape hatch, not the thing that protects you from a bad file — see below.
- **A file it cannot decode declines itself.** `open()` asks **`VideoDecoder.isConfigSupported()`**
  before claiming the file, because demuxing and decoding are different questions: an HEVC profile or a
  10-bit pixel format demuxes perfectly through `mp4box` and then fails at `configure()`. That failure
  surfaces far away — a console warning and no frames — by which point the host has handed the file to
  the codec and dropped the `<video>` that would have played it, so the surface goes **black while the
  app reports it is playing**. Declining at probe time instead lets the existing fallbacks work:
  surfaces revert to a `<video>` (`contentSource`), timeline layers to `syncVideoLayer`, thumbnails to
  the video queue. **This check is what made defaulting the codec on safe**, and `verify:invariants`
  asserts both that it is called and that its result decides the answer.
- **Renderer-only** (no native addon) and a **single module identity** so its decoder/clock singletons
  aren't duplicated.

## Audio is a CONTAINER concern, not a codec one

A video file's soundtrack does **not** go through `videoCodecRegistry` and must never be implemented
per-codec. The audio track of an `.mp4` is the same AAC or PCM whether its *pictures* are decoded by
WebCodecs, by the HAP native decoder, by a plain `<video>`, or by a codec that doesn't exist yet — so it is
read from the container once and conformed to a WAV the audio engine can already play. Every present and
future codec gets sound for free, and a new `VideoCodec` contribution has nothing to do about it.

See [AUDIO.md ▸ A video clip's own soundtrack](AUDIO.md). Worth knowing when adding a codec: Chromium's own
ffmpeg **refuses** a HAP `.mov` outright (`EncodingError`), which is why the conform demuxes the container
itself rather than handing the file to `decodeAudioData`.

## Adding a codec

Implement a `VideoCodecContribution` (surface player + layer sync + thumbnail) and register it in the
host `videoCodecRegistry`; the three call sites then dispatch to it by file type — no host changes. Two
codecs ship today: **HAP** (`.mov`) and **MP4/WebCodecs** (`.mp4`). Two were considered and **dropped** —
**DXV** (2026-07-03) and **DDS image sequences** (2026-07-25: cheap to build, but resolution buys nothing
on the Art-Net path and uncompressed BC blocks cost *more* disk than the same content as HAP). Both are
reasoned out in [ROADMAP.md](ROADMAP.md) — **read the DDS entry before proposing any GPU-texture-on-disk
format**, it also records two SDK gaps (no main-side contribution seam for multi-file assets; no
`duration()` on the codec contract). Since no shipped codec shares an extension, `forPath` first-match
dispatch needs no probe-order work (that only mattered for a second `.mov` codec).

## Related

- [PLUGINS.md](PLUGINS.md) / [SDK.md](SDK.md) — the plugin architecture + the `VideoCodec` contribution
  surface.
- [TIMELINE.md](TIMELINE.md) — the NLE that consumes codecs per layer; [ASSETS.md](ASSETS.md) — the
  media library.
- [NDI.md](NDI.md) / [SPOUT.md](SPOUT.md) — *live* video sources (not file codecs).

## Source map

| Path | Role |
|---|---|
| [`plugins/hap/`](../plugins/hap/) | HAP codec (native decode + WebGL2 BC-decompress) |
| [`plugins/mp4/`](../plugins/mp4/) | MP4/WebCodecs codec (renderer-only, on by default) |
| `src/renderer/host/registries.ts` | `videoCodecRegistry` (where codecs register) |
