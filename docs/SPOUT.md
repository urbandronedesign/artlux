# Spout — Windows GPU video receive

**Spout** shares GPU textures between apps on **Windows** (the Windows analogue of Syphon on macOS).
ArtLux receives a Spout sender as a **live content source**, so output from TouchDesigner, Resolume,
Notch, MadMapper, OBS (with a Spout plugin), etc. can be pixel-mapped onto fixtures with no file or
network hop. It's the local-GPU sibling of [NDI](NDI.md) (network video).

Shipped as the first-party plugin **`@artlux/plugin-spout`** (see [PLUGINS.md](PLUGINS.md)):
main-process native receiver + a refcounted renderer content source.

## Requirements & platform

- **Windows only.** On macOS/Linux the source type is unavailable and the app degrades gracefully
  (feature hidden / a `[spout] unavailable` log, never a crash).
- Backed by the native **`spout-receiver`** crate (`native/spout-receiver`, built by
  `npm run build:native` → `spout-receiver.node`, gitignored). If the addon isn't built/loaded, Spout
  is simply absent — check it built and loaded (see [DEVELOPMENT.md](DEVELOPMENT.md)).
- Nothing to install for end users beyond a **Spout sender** running on the same machine; Spout runtime
  support is bundled with the sender apps.

## Using it

1. Start a **Spout sender** in another app on the same PC.
2. In ArtLux, set a **surface's content** (or a timeline clip) to **Spout**.
3. Pick the **sender name** (`SurfaceContent.spoutName`). **Leave it empty to follow the active
   sender** — the first/most-recent sender is used, so a show keeps working if the sender's exact name
   changes.
4. Map fixtures onto that surface as usual — Spout frames sample per-LED like any other content.

## Architecture (brief)

- **Main:** `spoutManager` (in `@artlux/plugin-spout/main`) owns the native `spout-receiver` addon and
  the receive loop; a **single module identity** (barrel + relative imports) guarantees exactly one
  native load. Frames cross to the renderer over the plugin IPC bridge.
- **Renderer:** a **refcounted** content source (via `contentSource`) so multiple surfaces/clips can
  share one receiver; the receiver is released when the last consumer drops it. Registered like other
  content-source contributions in the host registries.
- **Model:** `SourceType.SPOUT` stays a core enum value in `shared/protocol.ts` /
  `renderer/types.ts` (persisted projects need zero migration); only the *behaviour* lives in the
  plugin.

## Related

- [NDI.md](NDI.md) — network video (cross-machine), the Spout sibling.
- [SURFACES.md](SURFACES.md) — the content/mapping model.
- [PLUGINS.md](PLUGINS.md) / [SDK.md](SDK.md) — the plugin + content-source contribution architecture.

## Source map

| Path | Role |
|---|---|
| [`plugins/spout/`](../plugins/spout/) | the plugin (`/main` native manager + `/renderer` content source) |
| `native/spout-receiver/` | native Rust crate → `spout-receiver.node` |
