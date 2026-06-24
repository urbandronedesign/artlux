# ArtLux — OSC (external control + LiDAR tracking)

ArtLux can **receive OSC** over UDP for two purposes:

1. **External control** — drive the timeline transport and the state-machine from a console,
   QLab, TouchOSC, a show controller, etc.
2. **LiDAR blob tracking** — ingest live tracked-object ("blob") positions from the venue's
   tracking system and visualize them in the 3D Scene, mapped onto the floor/wall zones.

Receive-first: an OSC **send** path exists as a scaffold (not yet wired to UI feedback).
No external library — a small, self-contained OSC 1.0 codec lives in the main process.

---

## For users — setup & use

### 1. Enable OSC receive
**Preferences → OSC / Tracking**:

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

Transport messages flow through the same intent path the timeline's state-machine uses, so the app
stays the single writer of play/pause.

### 3. See the LiDAR blobs in 3D
1. Open the **3D Scene** window.
2. In the bottom-right panel → **Lighting** → enable **Tracking zones (LiDAR)**.
3. With the tracking system sending, the **SOL** (floor) and **MUR** (wall) zones appear at real
   scale with a glowing marker per active blob.

---

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

## Architecture

- **Main** `src/main/transport/oscManager.ts` — zero-dependency OSC 1.0 codec over `dgram`
  (decodes single messages **and** `#bundle`s; encodes for the send scaffold). `start(port, cb,
  address?)` binds to one NIC or all interfaces; `localAddresses()` lists this host's IPv4 NICs for
  the picker; graceful no-throw on bad bind. Chosen over the `osc` npm package because
  `electron.vite.config.ts` bundles main-process deps and `osc`'s optional serialport/ws requires
  would risk the build.
- **IPC** `src/main/ipc.ts` — `OSC_CONFIGURE` (bind/unbind), `OSC_LOCAL_ADDRS` (NIC list), `OSC_SEND`
  (scaffold); each received packet's messages are forwarded to the renderer as `OSC_MESSAGE`.
- **Preload** `src/preload/index.ts` — `configureOsc`, `onOscMessage`, `listLocalAddrs`, `sendOsc`.
- **Renderer routing** `src/renderer/services/oscController.ts` — splits messages: control prefix →
  `timeline.dispatchTransportIntent` + `triggerSmTransition`; tracking → `trackingStore`.
- **Tracking store** `src/renderer/services/trackingStore.ts` — render-free pub/sub (like
  `dmxSignal`): accumulates per-surface specs + blob slots, coalesces notifications to one per
  animation frame, exposes active blobs + a `snapshot`/`applySnapshot` for bridging.
- **3D viz** `src/renderer/components/Simulator3D/TrackingViz.tsx` — reconstructs the SOL/MUR zones
  and renders instanced, bloom-lit blob markers; updates matrices in `useFrame` (no React
  re-renders).
- **Bridge** — `Simulator3D` lives only in the **3D Scene window**, which never sees OSC directly
  (OSC reaches the main window only). So `App` streams a `{ t: 'tracking' }` snapshot over the
  existing MessagePort (~30 fps), `SceneApp` ingests it via `trackingStore.applySnapshot`. Same
  pattern as the transport/frame streams (`src/renderer/scene/bridge.ts`).
- **Settings** — `AppSettings.osc*` (renderer) ↔ `OscConfig` (shared); `Scene3D.trackingViz` gates
  the viz; persisted with the rest of preferences.

---

## Troubleshooting

- **No blobs / `ping 192.168.61.21` is 100% loss** → the tracking **server is down or unreachable**.
  Being on the `.61` subnet isn't enough; confirm the server is up before expecting data.
- **`[osc] socket error … EADDRNOTAVAIL`** → the **Bind address** isn't a local NIC. Use this
  machine's IP (`192.168.61.32`) or **All**, not the server's `.21`.
- **OSC enabled but nothing in logs** → check the **Listen port** is `10000` and a firewall isn't
  blocking inbound UDP on the chosen NIC.
- **Blobs mirrored left↔right vs. the real floor** ("left when facing the wall" convention) → the
  `u → x` mapping sign is flipped relative to the install; a calibration flip can be added.
- **Control does nothing** → verify the sender uses the **Control prefix** (`/artlux/...`) and that
  the timeline/state-machine is in a state that accepts the transition.
