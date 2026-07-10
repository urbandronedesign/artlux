# Video codecs — HAP & MP4/WebCodecs

Video decode in ArtLux is **pluggable**. `.mov`/`.mp4` files dispatch through the
**`videoCodecRegistry`** (a `VideoCodec` contribution — see [PLUGINS.md](PLUGINS.md) /
[SDK.md](SDK.md)) from three call sites: **surfaces**, the **timeline**, and **thumbnails**. Two
first-party codecs ship today; the default `<video>` element handles everything else.

| Codec | Plugin | Formats | Path |
|---|---|---|---|
| **HAP** | `@artlux/plugin-hap` | HAP / HAP Q / HAP Alpha in `.mov` | native decode (main) → **WebGL2 BC-decompress** on the GPU (renderer) |
| **MP4 / WebCodecs** | `@artlux/plugin-mp4` | `.mp4`/`.m4v` (H.264/H.265) | **WebCodecs** decode + `mp4box` demux, **renderer-only**, **opt-in** |
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

## MP4 / WebCodecs (`@artlux/plugin-mp4`)

Frame-accurate `.mp4` decode via the browser **WebCodecs** API + `mp4box` demux — an alternative to the
default `<video>` element.

- **Opt-in:** enable **`mp4WebCodecs`** in Preferences (the `AppSettings.mp4WebCodecs` flag). Off by
  default → `.mp4` uses the normal `<video>` element (unchanged behaviour).
- **Why turn it on:** **frame-accurate** seeking/scrubbing and **no hardware-session cap** — the
  `<video>` element limits how many decoders run at once; WebCodecs lets many layers/clips decode
  independently. Good for timeline-heavy shows.
- **Renderer-only** (no native addon) and a **single module identity** so its decoder/clock singletons
  aren't duplicated.

## Adding a codec

Implement a `VideoCodecContribution` (surface player + layer sync + thumbnail) and register it in the
host `videoCodecRegistry`; the three call sites then dispatch to it by file type. The next planned codec
is **DXV** (Resolume's codec) — see [ROADMAP.md](ROADMAP.md).

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
| [`plugins/mp4/`](../plugins/mp4/) | MP4/WebCodecs codec (renderer-only, opt-in) |
| `src/renderer/host/registries.ts` | `videoCodecRegistry` (where codecs register) |
