# ArtLux — OSC (external control, LiDAR tracking, and OSC tracks)

ArtLux can **receive OSC** over UDP for two purposes:

1. **External control** — drive the timeline transport and the state-machine from a console,
   QLab, TouchOSC, a show controller, etc.
2. **LiDAR blob tracking** — ingest live tracked-object ("blob") positions from the venue's
   tracking system and visualize them in the 3D Scene, mapped onto the floor/wall zones.

And it can **send OSC** from the timeline: an **OSC track** is a lane whose curve is sent as OSC
messages to one or more `IP:port` destinations, e.g. Arduino boards with Ethernet shields. See
[Sending OSC from the timeline](#sending-osc-from-the-timeline-osc-tracks) below.

No external library — a small, self-contained OSC 1.0 codec lives in the main process.

---

## For users — setup & use

### 1. Enable OSC receive
**Preferences ▸ OSC / Tracking**:

- **OSC receive** — bind the UDP listener.
- **Listen port** — installation default **`10000`**.
- **Bind address** — which network card to listen on. Leave **All** for every interface, or click a
  chip to bind to one NIC. **Bind to *this* machine's IP** (e.g. `192.168.61.32`), **not** the
  server's. Binding an address that isn't on a local card fails with `EADDRNOTAVAIL` (handled
  gracefully — OSC just stays off).
- **Control prefix** — namespace for control messages, default `/artlux`. Tracking addresses
  (`/SOL`, `/MUR`, `/SOL_MUR`) are handled separately, so they never collide with control.

Confirm the bind in the logs: `[osc] listening on 192.168.61.32:10000` (or `udp/10000` for All).

### 2. External control addresses
Under the control prefix (default `/artlux`):

| Address | Args | Action |
|---|---|---|
| `/artlux/transport/play` | — | start the timeline |
| `/artlux/transport/pause` | — | pause |
| `/artlux/transport/stop` | — | pause + return to 0 |
| `/artlux/transport/seek` | `f` seconds | jump the playhead |
| `/artlux/transport/loop` | `i` 0/1 | toggle the loop region |
| `/artlux/state/trigger` | `s` id | fire a named state-machine transition |
| `/artlux/state/<id>` | — | same, id in the address |
| `/artlux/scene/recall` | `s` id | recall a scene by id (the same path the cue bus uses) |
| `/artlux/cue/fire` | `s` id | fire a cue by id |

Transport messages flow through the same intent path the timeline's state-machine uses, so the app
stays the single writer of play/pause.

### 3. See the LiDAR blobs in 3D
1. Open the **3D Scene** window.
2. In the bottom-right panel → **Lighting** → enable **Tracking zones (LiDAR)**.
3. With the tracking system sending, the **SOL** (floor) and **MUR** (wall) zones appear at real
   scale with a glowing marker per active blob.

### 4. Project the blobs onto the real floor/wall (1:1)
Blobs are a **Surface content type**, so they flow through the normal projector-output pipeline.

1. Add a surface → Inspector → **Content** → **Tracking**. Pick **Source** (`SOL` floor / `MUR`
   wall / `SOL_MUR` combined). Options: **Blob size**, **Show IDs**, **Flip H/V**, **Rotate**,
   **Calibrate** (overlay), and **Background** (a timeline layer drawn under the blobs).
2. Two projectors: one surface **TRACKING → SOL** routed to the floor projector, one **TRACKING →
   MUR** to the wall projector (**Outputs** panel → enable on a display).
3. Tick **Calibrate** → each output projects its zone border + grid + corner labels + amber **U/V**
   axis arrows.
4. **Align** (Outputs → Align) → drag the corner-pin / Bézier so the projected border matches the
   physical edges.
5. Confirm orientation: a person stands at a known corner; if the blob is mirrored, toggle **Flip
   H/V** / **Rotate** until it lands on them. Turn **Calibrate** off (or keep faint).

**Video under the blobs**: set **Background** to a timeline layer — one surface then carries the
video + blobs and projects on a single projector. The video is decoded once in the main window and
streamed to the projector under the locally-rendered blobs.

---

### 5. OSC Monitor (sniffer) — test the LiDAR feed

**View ▸ OSC Monitor…** (`Ctrl+Shift+M`) opens a live sniffer of the raw incoming OSC stream — the
fastest way to answer *“is the tracker actually sending blobs to this machine?”* without the 3D
Scene or a projector.

- **Status strip** — a coloured dot (green = receiving, amber = listening but **0 msg/s**, grey =
  OSC receive disabled), the bind target (`*:10000`), live **msg/s**, the number of distinct
  addresses, and the total **active blobs**.
- **Blob cards** — one per surface seen (`SOL` / `MUR` / `SOL_MUR`): `active / total` blob slots and
  the zone size in metres. A card turns **green** while it has active blobs — the at-a-glance check.
- **Address table** — every OSC address with its update **rate (Hz)**, total count, and last
  value(s). Type in the **filter** box to narrow by address substring (e.g. `MUR`).
- **Pause** freezes the view, **Clear** resets the counters, and **Raw log** streams the literal
  `address  args` lines for deep inspection.

It taps the OSC stream directly, so it shows the **raw wire** — including live blobs even while a
recorded take is replaying over them, and addresses the normal router ignores. It’s read-only and
adds no load when closed.

No tracker on the bench? You can drive it with synthetic blobs:

```
node scripts/lidar-emitter.cjs [host] [port] [nBlobs]   # e.g. 127.0.0.1 10000 3
```

Going on site to sync with the real tracker (incl. the "1 person = 2 blobs" check)? Follow the
field checklist in [TRACKING_SYNC.md](TRACKING_SYNC.md).

## Venue setup (61fps installation)

| Device | IP | Role |
|---|---|---|
| **Tracking server** | **192.168.61.21** | emits OSC; websocket on :8080 (ArtLux uses the OSC path) |
| LiDAR #1 / #2 (SOL) | .201 / .202 | floor sensors |
| LiDAR #3 (MUR) | .203 | wall sensor |
| OSC receivers | .31–.34, port **10000** | destinations the server sends to — ArtLux is one of these |
| ArtLux machine | **192.168.61.32** (OSC #2) | binds here, listens on 10000 |

The server **sends** OSC *to* the receivers; ArtLux **binds** to its own NIC and receives. `.21` is
the *source*, never the bind address.

---

## Protocol reference (tracking)

OSC over UDP, **one value per message** (leaf addresses, not bundled args; bundles are also decoded):

```
/<surface>/specs/Scalex                 float  zone width  (meters)
/<surface>/specs/Scaley                 float  zone height (meters)
/<surface>/blobs/blob<n>/id             int    tracking id; 0 = inactive slot
/<surface>/blobs/blob<n>/tx             float  world x, meters, origin = CENTER, [-Scalex/2 .. Scalex/2]
/<surface>/blobs/blob<n>/ty             float  world y, meters, origin = CENTER, [-Scaley/2 .. Scaley/2]
/<surface>/blobs/blob<n>/u              float  normalized x, [0..1], origin = BOTTOM-LEFT
/<surface>/blobs/blob<n>/v              float  normalized y, [0..1], origin = BOTTOM-LEFT (Y up)
```

- `<surface>` ∈ **`SOL`** (floor, content map #0) | **`MUR`** (wall, #1) | **`SOL_MUR`** (floor+wall
  as one plane, #2). `<n>` = blob slot index from 0; `id == 0` means the slot is empty.
- **Coordinates**: `u/v` are normalized with a **bottom-left origin** (Y up). For screen/surface
  space (top-left, Y down) flip to `1 - v`. `tx/ty` are meters about the zone center.
- Each field arrives as its own message, so the parser **accumulates** per `(surface, slot)`.
- Zones are **5.825 × 3.125 m** each in the current install; the 3D viz auto-sizes from the
  `specs/Scale*` values when the system sends them, else falls back to those defaults.

### 3D mapping (TrackingViz)
The floor (`SOL`) lies on `y=0`, the wall (`MUR`) on `z=0`, sharing the edge along the x-axis at the
origin. `u → x` across the width (centered); `v` runs up each zone (`SOL` toward the wall edge,
`MUR` up the wall). `SOL_MUR` treats them as one plane: `v` 0–0.5 = floor, 0.5–1 = wall.

---

## Sending OSC from the timeline (OSC tracks)

An **OSC track** is a timeline lane whose value is **sent**, not applied inside ArtLux. Add one with
**+ OSC** under the timeline's lanes. Each track carries its own settings (the sliders button in its
gutter):

| Setting | What it does |
|---|---|
| **Address** | The OSC address sent, e.g. `/led`. Must start with `/`. Case-sensitive on every receiver. |
| **Type** | `int` → type tag `i` (the curve is rounded) · `float` → `f` · `bool` → `T`/`F` with no payload (on at **≥ 0.5**). The track decides the tag: a `float` track at exactly `1.0` still sends a float. |
| **Range** | The lane's axis. Keys are clamped to it. `bool` is fixed at 0–1. |
| **Destinations** | One or more `host:port`. **Every enabled destination gets every message** (fan-out). Untick one to pause it without deleting it. A `x.x.x.255` address is a broadcast to that network. |
| **Max rate** | At most this many messages per second per track (default **30**). A deferred change is always delivered, so a fast fade still ends exactly on its last value. |
| **Re-send every** | Re-send the current value every N seconds even if unchanged (default **off**). UDP has no delivery receipt, so this is how a board that rebooted catches up. |

**When it sends.** A track sends when its value **changes**, once the value has been rounded to its
type. A `bool` ramp from 0 to 1 sends one message, and a hold curve sends one per step. It follows the
same clock as every automation lane: during playback, **while scrubbing**, and on a seek. A lane on the
**Global** timeline rides the show clock and keeps sending under every scene. A lane on a scene's
timeline rides that scene's playhead (see [SCENE-TIMELINES.md](SCENE-TIMELINES.md)). Each message
carries exactly **one argument**. Only the main editor window sends, never a projector window. Nothing
is sent during an offline **bake**.

**When it stops.** Switching a track off (**⚡**), deleting it, or recalling a scene that does not
contain it stops sending. **Nothing is sent on stop**: the device keeps the last value it received,
just as a DMX fixture holds its last frame. For a defined end state, put a key at the end of the curve.

**Debugging aids built into the track:**

- **sent N** next to the lane's live value: the messages this track has put on the wire. If it is not
  going up, ArtLux is not sending (track off, value not changing, no destination).
- **Send now** (paper-plane button): re-sends the current value immediately.
- **Test** buttons in the settings: send the low or high value right now, even with the track off.
- **Per-destination status** in the settings: how many datagrams the OS accepted, or the error it
  refused one with. `EHOSTUNREACH` / `ENETUNREACH` means no network card on this machine is on that
  address range, which is the usual cause with a direct cable. A yellow **No network card here is on
  a.b.c.x** warning flags the same thing before sending. It assumes a `/24` network, so treat it as a
  hint.
- **Loopback**: a new track points at `127.0.0.1:10000`. With OSC receive on, **View ▸ OSC Monitor**
  shows exactly what it sends. Keep that loopback as a second destination while you debug a board.

"Accepted" is not "received": UDP gives no receipt, so a board that is unplugged still counts as sent.
The hands-on setup (PC fixed IP, one board, several boards, a layer-by-layer checklist) is the
[OSC → Arduino tutorial](../examples/osc-arduino/tuto/README.md), which ships two Arduino sketches.

---

<!-- audience:contributor -->

## Architecture

> **LiDAR tracking is now the `@artlux/plugin-lidar-tracking` plugin** — the store, 3D viz, smoothing,
> GPU blob compositor and projector rendering live under `plugins/lidar-tracking/src/`. Only OSC
> transport/control (the codec, IPC, and the control-message router) remains in core.

- **Main** `src/main/transport/oscManager.ts` — zero-dependency OSC 1.0 codec over `dgram`
  (decodes single messages **and** `#bundle`s; encodes for the send scaffold). `start(port, cb,
  address?)` binds to one NIC or all interfaces; `localAddresses()` lists this host's IPv4 NICs for
  the picker; graceful no-throw on bad bind. Chosen over the `osc` npm package because
  `electron.vite.config.ts` bundles main-process deps and `osc`'s optional serialport/ws requires
  would risk the build.
- **IPC** `src/main/ipc.ts` — `OSC_CONFIGURE` (bind/unbind), `OSC_LOCAL_ADDRS` (NIC list), `OSC_SEND`
  (scaffold); each received packet's messages are forwarded to the renderer as `OSC_MESSAGE`.
  `OSC_SEND_BATCH` carries one frame of OSC-track output (`OscOutPacket[]`, typed args) and
  `OSC_SEND_STATUS` returns per-destination counters + the last OS send error.
- **OSC tracks (send)** — an OSC track is an `AutomationLane` with an `osc: OscTrackConfig` block and
  `targetPath = osc.<lane id>` (`types.ts`; `sanitizeOscTrackConfig` repairs it on load and
  re-derives the path from the id). The `osc` namespace provider is `src/renderer/services/oscOut.ts`,
  registered in `host/plugins.ts`. `compileAutomation` (`services/timeline.ts`) derives an OSC lane's
  def from the lane itself (`oscLaneDef`) instead of `enumerate()`, and calls `oscOut.bind()`. `write()`
  only records the value. `frameEnd()` + a 25 ms pump (running only while a track is bound) quantise,
  change-detect, rate-limit, keep-alive, and send everything in **one** IPC hop. Main
  (`oscManager.sendBatch`) encodes with explicit type tags on one broadcast-enabled send socket. The
  UI is `components/timeline/AutomationLane.tsx` (gutter buttons) + `OscTrackSettings.tsx`, and
  `+ OSC` is in `Timeline.tsx`. Project import re-mints the id **and** the path (`projectImport.ts`).
- **Preload** `src/preload/index.ts` — `configureOsc`, `onOscMessage`, `listLocalAddrs`, `sendOsc`.
- **Renderer routing** `src/renderer/services/oscController.ts` — handles **control** messages only:
  control prefix → `timeline.dispatchTransportIntent` + `triggerSmTransition`. It no longer touches
  tracking; the `@artlux/plugin-lidar-tracking` plugin taps the same OSC stream independently, wiring
  `window.artlux.onOscMessage` → `trackingStore.ingest` in its own subscription (see
  `plugins/lidar-tracking/src/plugin.renderer.ts`).
- **Tracking store** `plugins/lidar-tracking/src/trackingStore.ts` — render-free pub/sub (like
  `dmxSignal`): accumulates per-surface specs + blob slots, coalesces notifications to one per
  animation frame, exposes active blobs + a `snapshot`/`applySnapshot` for bridging.
- **3D viz** `plugins/lidar-tracking/src/TrackingViz.tsx` — reconstructs the SOL/MUR zones
  and renders instanced, bloom-lit blob markers; updates matrices in `useFrame` (no React
  re-renders).
- **Bridge** — `Simulator3D` lives only in the **3D Scene window**, which never sees OSC directly
  (OSC reaches the main window only). So `App` streams a `{ t: 'tracking' }` snapshot over the
  existing MessagePort (~30 fps), `SceneApp` ingests it via `trackingStore.applySnapshot`. Same
  pattern as the transport/frame streams (`src/renderer/scene/bridge.ts`).
- **Settings** — `AppSettings.osc*` (renderer) ↔ `OscConfig` (shared); `Scene3D.trackingViz` gates
  the viz; persisted with the rest of preferences.

### Projection (TRACKING surface content)
- **`SourceType.TRACKING`** content (`trackingSource`, `blobSize`, `showIds`, `flipH/flipV`,
  `rotate`, `calibration`, `bgLayerId`). Smoothing (`plugins/lidar-tracking/src/blobMotion.ts` —
  One-Euro + bounded prediction) and the blob-instance + overlay compute live in
  **`plugins/lidar-tracking/src/trackingRenderer.ts`**.
- **GPU compositor** — blobs are drawn on the GPU (no CPU radial-gradient rasterization):
  **`plugins/lidar-tracking/src/blobPass.ts`** (WebGL2: radial-falloff blob discs + textured quads,
  premultiplied alpha, per-context program cache). The **editor stage** renders into a per-surface
  WebGL2 canvas (`plugins/lidar-tracking/src/trackingDrawable.ts`, with a 2D fallback). The
  **projector** renders background + blobs +
  overlay **straight into `ProjectorGL`'s source FBO** (`drawTracking` → `warpFromTexture`) — no
  intermediate canvas, no per-frame full-canvas upload — then warps it with the existing
  corner-pin/Bézier.
- **Projector bridge** — `ProjectorApp` runs `blobMotion`/`trackingRenderer` locally, fed by the
  bridged `{ t: 'tracking' }` snapshot; the background timeline layer streams as `{ t: 'layerFrame' }`.
  GL note: every draw disables the vertex attrib arrays it enabled (the blob pass + warp share one
  context; a stale array → out-of-bounds read → GPU-process crash).

---

<!-- audience:operator -->

## Recording & replaying the blob feed

The live blob stream can be **recorded into takes** and replayed from the timeline with no tracker
present (for authoring and rehearsal). See [TRACKING_TAKES.md](TRACKING_TAKES.md).

---

## Troubleshooting

- **No blobs / `ping 192.168.61.21` is 100% loss** → the tracking **server is down or unreachable**.
  Being on the `.61` subnet isn't enough; confirm the server is up before expecting data.
- **`[osc] socket error … EADDRNOTAVAIL`** → the **Bind address** isn't a local NIC. Use this
  machine's IP (`192.168.61.32`) or **All**, not the server's `.21`.
- **OSC enabled but nothing in logs** → open **View ▸ OSC Monitor** (`Ctrl+Shift+M`): an **amber**
  dot with **0 msg/s** confirms the listener is up but no packets are arriving (server/network),
  whereas a green dot with no blob cards means OSC is arriving but carries no `/…/blobs/…`
  addresses. Also check the **Listen port** is `10000` and a firewall isn't blocking inbound UDP on
  the chosen NIC.
- **Projected blobs mirrored / rotated vs. the real floor** → toggle **Flip H / Flip V / Rotate** on
  the Tracking content until a person at a known spot lines up (the **Calibrate** overlay's U/V
  arrows show the data orientation).
- **Projected zone doesn't match the physical edges** → use **Outputs → Align** (corner-pin /
  Bézier) with **Calibrate** on, dragging the projected border onto the real floor/wall edges.
- **Control does nothing** → verify the sender uses the **Control prefix** (`/artlux/...`) and that
  the timeline/state-machine is in a state that accepts the transition.
