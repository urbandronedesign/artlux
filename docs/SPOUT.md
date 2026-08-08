# Spout — Windows GPU video receive

**Spout** shares GPU textures between apps on **Windows** (the Windows analogue of Syphon on macOS).
ArtLux receives a Spout sender as a **live content source**, so output from TouchDesigner, Resolume,
Notch, MadMapper, OBS (with a Spout plugin), etc. can be pixel-mapped onto fixtures with no file or
network hop. It's the local-GPU sibling of [NDI](NDI.md) (network video).

Shipped as the first-party plugin **`@artlux/plugin-spout`** (see [PLUGINS.md](PLUGINS.md)):
main-process native receiver + a refcounted renderer content source.

**The frame never leaves the GPU.** ArtLux takes the sender's texture and draws it — nothing is read
back to system memory, nothing is resized, and there is no resolution or quality setting, because
nothing is resampled. Whatever resolution the sender publishes is what gets mapped.

## Requirements & platform

- **Windows only.** On macOS/Linux the source type is unavailable and the app degrades gracefully
  (feature hidden / a `[spout] unavailable` log, never a crash).
- **The sender must be on the same GPU as ArtLux.** This is the one requirement that catches people
  out — see [When Spout says "not compatible"](#when-spout-says-not-compatible) below.
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

There is nothing to tune. No resolution cap, no frame-rate setting, no quality trade-off: the texture
is shared as-is, and the receiver follows the sender's own frame rate rather than the engine's.

> **Engine rate does not apply to Spout.** *Preferences ▸ Engine ▸ Engine rate* governs how often the
> renderer computes a frame, and it does **not** throttle a Spout source: a Spout receiver polled below
> its sender's rate is *sampled* at the wrong rate off an unrelated clock, which shows up as uneven
> motion rather than a lower frame rate. Spout follows the sender.

## When Spout says "not compatible"

Spout is **GPU-only by design**. If the texture cannot be shared, ArtLux tells you and shows nothing —
it does **not** fall back to a slower, softer picture. That is deliberate: a silent fallback turns
something you can fix into something you can only wonder about.

The reason appears **in the content inspector**, right under the sender picker, and on the **startup
splash** next to the Spout plugin. Three cases:

| What it says | What it means | What to do |
|---|---|---|
| *The Spout receiver did not load. Spout is Windows-only.* | The native receiver is missing — you're not on Windows, or the addon wasn't built. | On Windows, rebuild the native modules. Elsewhere, use [NDI](NDI.md) instead. |
| *This build cannot share GPU textures, which Spout requires.* | The app build lacks the GPU texture-sharing support Spout needs. | Update to a current build. |
| *The GPU refused the shared texture… the sender is running on a different graphics card.* | ArtLux and the sender are on **different GPUs**. | Put both on the same GPU — see below. |

### Both apps on the same GPU

A texture shared on one graphics card cannot be read by an app running on another, so this bites on
**laptops and desktops with two GPUs** (an integrated Intel/AMD chip plus a discrete NVIDIA/AMD card):
Windows may quietly put ArtLux on one and your sender on the other.

Fix it in the OS, not in ArtLux — **Windows Settings ▸ System ▸ Display ▸ Graphics**, then set *both*
ArtLux **and** the sender app to the **same** GPU (on a venue machine, the discrete one). NVIDIA
Control Panel ▸ *Manage 3D settings* ▸ *Program Settings* does the same job.

If you cannot get both onto one GPU, [NDI](NDI.md) does not have this constraint — it costs a network
hop and a compression pass, but it works across GPUs and across machines.

<!-- audience:contributor -->

## Architecture (brief)

- **Main:** `spoutManager` (in `@artlux/plugin-spout/main`) owns the native `spout-receiver` addon and
  the receive loop; a **single module identity** (barrel + relative imports) guarantees exactly one
  native load.
- **Delivery is a shared texture, not IPC.** `sharedTexture.importSharedTexture` imports the handle in
  main and `sendSharedTexture` hands it to the renderer's frame, where the **preload's generic
  shared-texture relay** turns it into a `VideoFrame` and forwards it into the main world with
  `window.postMessage`. A `VideoFrame` is a `CanvasImageSource`, so it satisfies
  `ContentSourceProvider.getDrawable()` with no SDK change. This is a **first-party preload seam**, not
  the plugin IPC bridge — a shared texture cannot be structured-cloned, and `sharedTexture` lives in
  the preload's isolated world. The relay is deliberately generic (the sender names a channel) so NDI
  and future GPU sources can use it.
- **Re-sharing is mandatory** (`native/spout-receiver/src/share.rs`). Electron requires an **NT
  handle** and duplicates it; Spout's NT mode is an opt-in its senders rarely set, and the default is a
  legacy DX9-style token that is not a kernel object, so importing it fails with *"Unable to duplicate
  handle."* The addon therefore opens the sender's texture on its own D3D11 device and copies it into
  one it created with `MISC_SHARED_NTHANDLE` — entirely in VRAM. D3D11 rejects that flag without
  `SHARED_KEYEDMUTEX`, which is also the interlock the copy needs; key 0, because that is what Dawn
  acquires.
- **There is no CPU path, and one must not be re-added.** Guarded by `verify:invariants` ("Spout
  delivers GPU textures only"). The receiver must close every `VideoFrame` it replaces — they are
  references to GPU images, and a missed close leaks a full-resolution allocation per frame.
- **Poll rate:** follows the **sender**, floor 60, capped. Not the engine — that judders. And not
  higher, because Spout's `is_frame_new()` depends on the sender publishing frame counts and answers
  "yes" forever against one that does not, so polling above the sender's rate re-delivers the same
  picture at full price.
- **Renderer:** a **refcounted** content source (via `contentSource`) so multiple surfaces/clips can
  share one receiver; the receiver is released when the last consumer drops it.
- **Model:** `SourceType.SPOUT` stays a core enum value in `shared/protocol.ts` /
  `renderer/types.ts` (persisted projects need zero migration); only the *behaviour* lives in the
  plugin.

<!-- audience:operator -->

## Related

- [NDI.md](NDI.md) — network video (cross-machine), the Spout sibling, and the fallback when two GPUs
  cannot be avoided.
- [SURFACES.md](SURFACES.md) — the content/mapping model.
- [PLUGINS.md](PLUGINS.md) / [SDK.md](SDK.md) — the plugin + content-source contribution architecture.

<!-- audience:contributor -->

## Source map

| Path | Role |
|---|---|
| [`plugins/spout/`](../plugins/spout/) | the plugin (`/main` native manager + `/renderer` content source) |
| `plugins/spout/src/sharedTexture.main.ts` | import + hand-off of the GPU texture |
| `native/spout-receiver/` | native Rust crate → `spout-receiver.node` |
| `native/spout-receiver/src/share.rs` | the D3D11 re-share (why Spout's own handle will not do) |
| `src/preload/index.ts` | the generic shared-texture relay into the main world |
