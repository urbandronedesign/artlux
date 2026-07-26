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
