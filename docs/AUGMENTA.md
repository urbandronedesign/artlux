# Augmenta tracking (`plugins/augmenta`)

Optical people/object tracking as a **content/tracking source** — an [Augmenta](https://augmenta.tech)
box + camera streaming tracked objects over **OSC** replacing (or complementing) the LiDAR tracker.
Each tracked object becomes a normalized position that maps onto a surface exactly like a LiDAR blob,
so a show gets body-driven interactive mapping from a self-contained, pre-calibrated sensor.

It is a **standalone, renderer-only first-party plugin** modeled on `plugins/mediapipe` /
`plugins/lidar-tracking` (the canonical tracking-plugin templates): a render-free pub/sub store, a
content-source drawable, a projector data+GPU channel, a 3D scene-viz overlay, a debug monitor, and a
settings section — but fed by the Augmenta box's **OSC v2 / Fusion** output instead of a webcam or
LiDAR. The blob **look** (disc + heading triangle + comet trail) is the LiDAR renderer; the store
**shape** (a whole object list per bundle) is the MediaPipe shape, because Augmenta emits a full object
set per OSC frame.

## How it fits together

```
Augmenta box / Fusion  →  OSC v2 over UDP  →  the app's shared OSC listener (oscManager, MAIN process)
  → window.artlux.onOscMessage(...)                            [preload bridge; multiple subscribers]
  → augmentaStore.ingestBundle(msgs)   /au/scene + /au/person·object {enter,update,leave}
       parse per-object args, flip centroid y (top-left → bottom-left), upsert by id, drop stale ghosts
  → augmentaStore (render-free pub/sub, serializable snapshot)
       ├─ motion — One-Euro smoothing + prediction + trails, keyed by the box's stable id
       ├─ ContentSourceProvider(AUGMENTA) → augmentaDrawable → GPU markers/trails on the surface
       ├─ ProjectorChannel('augmenta')    → snapshot → MessagePort → projector windows self-render
       ├─ SceneViz(augmentaViz)           → field rectangle + object markers in the 3D simulator
       └─ Augmenta Monitor panel + Preferences section (OSC status + setup guidance)
```

OSC arrives **only in the main editor window** (it owns the UDP socket; projector windows receive
object snapshots over the projector bridge and render the markers themselves). Augmenta **shares the
app's single OSC listener** — it does *not* open its own port. Point the box's OSC output at the app's
OSC listen port; the `/au/…` messages fall through the host control router (which only claims the
`/artlux` prefix) to the plugin. **No main-process half, no native crate, no transport changes.**

## Files

| File | Purpose |
|---|---|
| `plugin.renderer.ts` | Activation — registers the content source, clip kind, projector channel, scene-viz, panel, settings + the OSC tap. |
| `augmentaStore.ts` | Render-free pub/sub store + the **OSC v2 parser** (`ingestBundle`); `snapshot()`/`applySnapshot()` bridge. |
| `motion.ts` | One-Euro smoothing + bounded prediction + trails, keyed by the Augmenta id (no re-association — the box assigns identity). |
| `augmentaRenderer.ts` | Shared compute: marker instances, trails, calibration/`#id` overlay, orientation transform; source aspect from the field metres. |
| `blobPass.ts` | Self-contained WebGL disc/heading/trail/quad primitives (a copy of the LiDAR `blobPass`). |
| `augmentaDrawable.ts` / `augmentaProjector.ts` | Stage GL canvas / projector-FBO render of `AUGMENTA` content. |
| `AugmentaViz.tsx` | r3f scene overlay: the field rectangle (real metres) + a marker per object (gated on `scene.augmentaViz`). |
| `AugmentaMonitor.tsx` | Augmenta Monitor modal — live `/au/` OSC sniffer: msg/s, address table, object count, field size, raw log. |
| `augmentaSettings.tsx` / `augmentaContentEditor.tsx` | Preferences section (OSC status + guidance) / per-surface inspector fragment. |
| `augmentaHost.ts` | Stashes `ctx.host` for the panel's settings reads + a reactive settings hook. |

Core edits are minimal (persisted enum/fields stay core, behavior lives in the plugin):
`SourceType.AUGMENTA` (`renderer/types.ts`), `Scene3D.augmentaViz` (`shared/protocol.ts`), a picker
button (`ContentEditor.tsx`), a 3D toggle (`ScenePanel3D.tsx`), and a menu item (`MenuBar.tsx`). No
plugin-local settings — Augmenta reuses the core OSC / Tracking receive settings.

## The OSC protocol

Augmenta Fusion (or a Node) streams, per tracking frame, a scene message plus one message per object.
Unlike the LiDAR protocol (one leaf value per message), Augmenta packs a whole object's fields into one
message's argument list. The v1 `/au/person*` addresses are still emitted by v2 for backward
compatibility; the parser accepts both the `person` and `object` spellings and the enter/update/leave
verbs, tolerantly.

```
/au/scene            [frame(i), objectCount(i), sceneWidth(f, m), sceneHeight(f, m)]
/au/personUpdated    [pid(i), oid(i), age(i), centroid.x(f), centroid.y(f), velocity.x(f), velocity.y(f),
/au/personEntered     depth(f), boundingRect.x(f), boundingRect.y(f), boundingRect.w(f), boundingRect.h(f),
                      highest.x(f), highest.y(f), highest.z(f)]
/au/personWillLeave  [pid(i), ...]   → remove that id
```

Centroid is normalized `[0..1]` with a **top-left** origin; the store flips `v = 1 − centroid.y` to the
blob system's bottom-left origin so the shared render math applies unchanged. The parser is deliberately
**positional + defensive** (missing trailing args stay 0) so a firmware field-order surprise degrades
gracefully rather than crashing.

> **The exact wire schema is finalized on hardware.** Firmware/Fusion versions differ in address
> spelling and argument order. Open **View → Augmenta Monitor** with the real box streaming, read the
> actual `/au/…` addresses + argument order, and adjust `augmentaStore.upsertFromArgs` if they differ.

## Using it

1. **Enable OSC receive** and set the listen port in **Preferences → OSC / Tracking**.
2. Configure the **Augmenta box (Fusion)** to send its **OSC v2** output to this machine on that port.
3. Open **View → Augmenta Monitor…** — confirm `/au/…` messages are arriving (the status dot turns
   green) and check the live object count + field size.
4. Select a surface → content type **Augmenta**. Configure marker size / trails / IDs / calibration
   overlay / flip / rotate in the inspector.
5. Toggle **Augmenta field + objects** in the 3D scene panel for the simulator overlay.
6. Open a projector output on the surface — the markers self-render there via the snapshot bridge.

### Testing without the box

`scripts/augmenta-emitter.cjs` speaks the Augmenta OSC v2 protocol so you can drive the whole pipeline
in dev without hardware:

```bash
node scripts/augmenta-emitter.cjs [host] [port] [nObjects]   # default 127.0.0.1 12000 3
```

Point it at the app's OSC listen port; each object orbits the field so motion / smoothing / heading /
trails are visible.

## Scope + roadmap

v1 ships **Augmenta object positions as a tracking source** — content source, projector self-render, 3D
field viz, OSC monitor, settings. The 3D viz places objects at their **real-world field position**
directly (the box reports the field size in metres), so unlike MediaPipe there is **no floor-calibration
wizard** — Augmenta is pre-calibrated. The store keeps a `setReplaySource` hook, so additive later (not
built yet): record/replay **takes** (mirror the LiDAR `trackingRecorder`/`trackingPlayback`), feeding
the world position into the content-mapping path (world-space surfaces/effects), a dedicated Augmenta
UDP port (a main-process half), and the modern Augmenta JSON/WebSocket transport.
