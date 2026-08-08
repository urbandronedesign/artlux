# Syphon — macOS GPU video receive

**Syphon** shares GPU textures between apps on **macOS** (the macOS analogue of [Spout](SPOUT.md) on
Windows). ArtLux receives a Syphon server as a **live content source**, so output from Resolume,
MadMapper, TouchDesigner, Isadora, VDMX, Millumin, After Effects (with a Syphon plugin) etc. can be
pixel-mapped onto fixtures with no file or network hop. It's the local-GPU sibling of [NDI](NDI.md)
(network video).

Shipped as the first-party plugin **`@artlux/plugin-syphon`** (see [PLUGINS.md](PLUGINS.md)):
main-process native receiver + a refcounted renderer content source.

**The frame never leaves the GPU.** ArtLux takes the server's texture and draws it — nothing is read
back to system memory, nothing is resized, and there is no resolution or quality setting, because
nothing is resampled. Whatever resolution the server publishes is what gets mapped.

## Requirements & platform

- **macOS only.** On Windows/Linux the source type is unavailable and the app degrades gracefully
  (feature hidden / a `[syphon] unavailable` log, never a crash). On Windows the equivalent is
  [Spout](SPOUT.md).
- **Nothing to install.** Syphon is embedded in the sender applications themselves — there is no
  runtime, no service and no system extension to add. If an app publishes a Syphon server, ArtLux
  can see it.
- Backed by the native **`syphon-receiver`** addon (`native/syphon-receiver`, built by
  `npm run build:syphon` → `syphon-receiver.node`, gitignored). If it isn't built/loaded, Syphon is
  simply absent — see [DEVELOPMENT.md](DEVELOPMENT.md).

## Using it

1. Start a **Syphon server** in another app on the same Mac.
2. In ArtLux, set a **surface's content** (or a timeline clip) to **Syphon**.
3. Pick the **server**. The list reads **`App — Name`**, because a Syphon server's own name is often
   blank and the application is what identifies it. **Leave it on *Active server*** to follow
   whichever server is running — a show then keeps working if the server's exact name changes.
4. Map fixtures onto that surface as usual — Syphon frames sample per-LED like any other content.

There is nothing to tune. No resolution cap, no frame-rate setting, no quality trade-off: the texture
is shared as-is, and the receiver follows the server's own frame rate rather than the engine's.

> **Engine rate does not apply to Syphon.** *Preferences ▸ Engine ▸ Engine rate* governs how often the
> renderer computes a frame, and it does **not** throttle a Syphon source: a receiver polled below its
> server's rate is *sampled* at the wrong rate off an unrelated clock, which shows up as uneven motion
> rather than a lower frame rate. Syphon follows the server.

### A beat of nothing after switching servers is normal

When you pick a different server, ArtLux and that application have to introduce themselves before any
picture can arrive, and frames the server published *before* ArtLux connected are not replayed. The
surface is briefly empty and then fills. That is the connection completing, not a fault — if it stays
empty for more than a moment, read the next section.

## When Syphon says "not compatible"

Syphon is **GPU-only by design**. If the texture cannot be shared, ArtLux tells you and shows nothing —
it does **not** fall back to a slower, softer picture. That is deliberate: a silent fallback turns
something you can fix into something you can only wonder about.

The reason appears **in the content inspector**, right under the server picker, and on the **startup
splash** next to the Syphon plugin. Three cases:

| What it says | What it means | What to do |
|---|---|---|
| *The Syphon receiver did not load. Syphon is macOS-only.* | The native receiver is missing — you're not on macOS, or the addon wasn't built. | On macOS, run `npm run build:syphon`. On Windows use [Spout](SPOUT.md) instead. |
| *This build cannot share GPU textures, which Syphon requires.* | The app build lacks the GPU texture-sharing support Syphon needs. | Update to a current build. |
| *The GPU refused the shared texture.* | The system declined to hand the server's surface to ArtLux. | Rare on macOS — see below. |

### There is no "both apps on the same GPU" problem here

If you have used [Spout](SPOUT.md) on Windows you will be looking for this section, because on Windows
it is the failure that catches everyone out: a texture shared on one graphics card cannot be read by an
app running on another, and a laptop with two GPUs will quietly put the two apps on different ones.

**macOS does not work that way.** A Syphon frame travels as an `IOSurface`, which is not tied to one
graphics adapter, so there is nothing to configure and nothing to match. Apple Silicon has a single
unified GPU in any case. If a share is refused here, it is not the two-GPU problem — check that both
apps are on the same machine and that the server is actually publishing.

Still stuck? [NDI](NDI.md) works across machines at the cost of a network hop and a compression pass.

<!-- audience:contributor -->

## Architecture (brief)

Same topology as [Spout](SPOUT.md), and notable mostly for the three pieces of Spout that **do not
exist here**. Design record: [plans/syphon-plugin.md](../plans/syphon-plugin.md).

- **No re-share.** Spout must copy the sender's texture through its own D3D11 device
  (`native/spout-receiver/src/share.rs`) because Spout's handle is a legacy DX9 token Electron cannot
  duplicate. Syphon's transport primitive **is** an `IOSurface`, which is exactly what Electron's
  `sharedTexture` API wants on darwin — so the server's surface goes straight across.
- **No format table.** Syphon servers publish `kCVPixelFormatType_32BGRA` explicitly, so the pixel
  format is always `bgra`. The receiver asserts it and refuses anything else rather than
  reinterpreting bytes.
- **No Metal, no OpenGL.** `SyphonClientBase -newSurface` (public via the framework's
  `SyphonSubclassing` module) returns the `IOSurfaceRef` directly, so no `MTLDevice` is created.
- **Ownership is inverted relative to Windows, and this is the local leak hazard.** Electron
  **retains** the surface on import rather than taking ownership (Chromium's
  `electron_api_shared_texture.cc`), so the `+1` that `newSurface` hands us is still ours afterwards
  and must be released per frame. On Windows Electron duplicates the NT handle instead. A missed
  release is the exact twin of a missed `VideoFrame.close()` in the renderer.
- **Poll rate:** follows the **server**, gated on `hasNewFrame` — which, unlike Spout's
  `is_frame_new()`, is backed by the server's published frame ID and is therefore truthful. So the
  poll is *gated* rather than rate-limited: a poll above the server's rate costs one lock and one
  integer compare, not a re-delivered frame. Spout's ceiling has no counterpart here; do not copy it
  over.
- **Nothing in Syphon is synchronous.** The client/server handshake is `CFMessagePort` traffic
  delivered on run-loop turns, so everything must be created and used on the **main thread** (Electron's
  main process runs a Cocoa run loop, so this is free). Frames published before a client attaches are
  not replayed, which is why `receiveShared()` returning nothing right after a connect is ordinary.
- **The Objective-C is Objective-C.** `syphon-sys/src/shim.m` behind a flat C ABI, rather than
  `objc2` `msg_send!`, so clang checks every selector against Syphon's own headers. The plugin was
  written on a Windows machine and compiled only by CI, where an unchecked selector would have been
  invisible.
- **Delivery is a shared texture, not IPC**, over the preload's **generic** shared-texture relay —
  the same road Spout uses, with `'syphon'` as the channel. It needed no changes to carry a second
  producer, which is what it was built generic for.
- **Renderer:** a **refcounted** content source so multiple surfaces/clips share one receiver.
- **Model:** `SourceType.SYPHON` stays a core enum value in `renderer/types.ts` (persisted projects
  need zero migration); only the *behaviour* lives in the plugin.

<!-- audience:operator -->

## Related

- [SPOUT.md](SPOUT.md) — the Windows sibling. Same feature, different OS.
- [NDI.md](NDI.md) — network video (cross-machine), and the fallback when a local share is impossible.
- [SURFACES.md](SURFACES.md) — the content/mapping model.
- [PLUGINS.md](PLUGINS.md) / [SDK.md](SDK.md) — the plugin + content-source contribution architecture.

<!-- audience:contributor -->

## Source map

| Path | Role |
|---|---|
| [`plugins/syphon/`](../plugins/syphon/) | the plugin (`/main` native manager + `/renderer` content source) |
| `plugins/syphon/src/sharedTexture.main.ts` | import the IOSurface, hand it over, release our reference |
| `native/syphon-receiver/` | native crate → `syphon-receiver.node` |
| `native/syphon-receiver/syphon-sys/src/shim.m` | the Objective-C: directory, client, IOSurface |
| `native/syphon-receiver/syphon-sys/examples/selftest.rs` | loopback test — a Syphon server and client in one process |
| `scripts/build-syphon.sh` | fetch + build Syphon.framework, the crate, and the addon |
| `.github/workflows/syphon.yml` | the macOS CI gate |
| `src/preload/index.ts` | the generic shared-texture relay into the main world |
