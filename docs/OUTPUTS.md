# ArtLux — Projector outputs & Broadcast mode

Send each **Surface** to a real **projector** (its own fullscreen output, with corner-pin / Bézier
warp, soft-edge blend, gamma, and MSAA), and run a show with no editor UI via **Broadcast mode**.

This is the video-output counterpart to the LED engine: the same surfaces that drive Art-Net fixtures
can also be projected onto physical surfaces. Added in **v0.6.0**.

---

## For users

### Send a surface to a projector
1. Connect the projector as an extra display.
2. Open **Outputs** (top-bar monitor icon).
3. For a surface: tick **On**, then pick its **Display**. A frameless **fullscreen** window opens on
   that projector showing the surface's content. The editor keeps focus; LED output keeps running.
4. **Re-scan** re-enumerates displays after plugging/unplugging.

Outputs are saved in the project. Electron display IDs aren't stable across reboot/replug, so each
output also stores the display **label** and re-binds by label if the saved ID is gone.

### Name a projector, and find it in the room
An output carries its own **Label** (row ▸ gear ▸ *Label*) — *Stage Left*, *Ceiling 3* — because a
surface is named for its picture and a projector for where it hangs, and on a wall of six the two
vocabularies stop matching the first time an output is re-pointed. Blank falls back to the surface
name, so an unnamed rig reads exactly as it always did. Saved with the project (`ProjectorOutput.name`).

**Identify** (the row's tag icon, or **Identify all** in the header) puts that label on the projection
itself, with the bound display and the window's actual raster under it — which is how "the picture is
wrong" becomes "that cable is in the wrong port". It is transient App state, never persisted, and an
output switched off drops out of it. Drawn as a DOM overlay over the content behind a scrim: therefore
**unwarped** (readable whatever the corner-pin/calibration/blend is doing) and **absent from an NDI
send**, on the same reasoning as the cold-start sign — an NDI consumer is another machine's input, not
a person who needs to be told things.

### Alignment aids (physical setup, before any warp)
Outputs ▸ **Alignment aids** puts a pattern on **every live output at once** — Grid, Blend, Focus,
Greys, Bars, 1:1, White, Black — for aiming, overlapping, focusing and matching the real machines.
Each output is tinted its own hue (the first three are the additive primaries, so an overlap reads as
their mix), and **Blend** draws the output's real `SoftEdge` as a hatched band with its inner boundary
bright and a *ladder* across it: matching a neighbour's ladder matches zoom, aim and roll at once.

Two design points that are load-bearing:
- **Drawn unwarped, in the raw raster by default** (DOM/SVG over the canvas, outside the warp pipeline).
  You are adjusting where the projector's *light* goes, so an aid that moved with the corner-pin would
  hide the error being hunted. An output with a residual warp says so on the projection.
- **The band comes from the output's real `softEdge`, not from the `render` payload** — under NVAPI
  scanout warp the GPU is deliberately handed a flat soft edge (the double-blend guard), while the band
  still physically exists on the wall.

**Follow the warp** (the checkbox beside Dim) is the other half of a rig setup: once the machine is
hung and you are shaping the picture in software, an unwarped grid answers a question nobody is asking.
It sends the pattern through the *same* corner-pin / Bézier mesh the content takes, as a second blended
GL pass — `ProjectorGL.setOverlay()` + `DrawOpts.overlay`, geometry shared with the content pass so the
two cannot bend differently.

How it is built, and why each piece is where it is:
- **The live SVG node is serialised and rasterised** (`projector/aidRaster.ts`), never re-drawn in
  Canvas2D — one source for the picture, so a pattern added tomorrow warps the day it is added.
  Re-rasterised on pattern / size / soft-edge changes only; **`dim` never reaches the texture**, so
  dragging Dim costs nothing.
- **The scrim moves into the GL pass with the pattern**, drawn in raster space immediately under it.
  It has to: the aid sits *on* the scrim, and a scrim left in the DOM would sit on top of the canvas
  and therefore on top of the warped aid — measured at dim 90%, which put the grid at 10% brightness
  and made it unreadable. `dim` stays a uniform, so the slider still costs nothing.
- **The 1:1 checker and the WARPED banner stay in the DOM.** The checker measures *device* pixels, so
  bending it destroys the only thing it is for, and the banner is a message to a person — it also goes
  away in warp mode, where the aid and the picture agree by construction. `WARPABLE_AIDS` in
  `OutputsPanel` is the one list that decides which patterns can take the warp at all.
- **A warped aid IS in the picture, so it reaches an NDI send and any capture** (`captureRGBA` reads
  the resolved framebuffer). The raw-raster aid, like Identify and the cold-start sign, does not. That
  is a real difference in kind, not an oversight: the pattern is now content.
- **The DOM copy is hidden only once the texture is resident** (`aidWarped`), so a failed rasterisation
  degrades to the raw-raster aid rather than to a blank wall.
- **No photometrics.** Soft edge, gamma, brightness, colour gain and black lift are all identity on the
  overlay pass: an aid is compared against a *neighbour's*, and feathering it would dim it to nothing
  exactly in the overlap where the comparison happens.
- **On the baked-calibration path the pattern stays in the raster** — a baked map is raster→content and
  has no inverse to bend an aid through. It is still drawn (through the identity mesh) rather than
  skipped, so the aid cannot vanish on a calibrated output.

Transient App state (like Identify), never persisted. Design + what was left out:
[plans/projector-alignment-aids.md](../plans/projector-alignment-aids.md).

### Align it onto the real surface
Click **Align** on the row, then work **on the projector**:
- **Corner-pin** (default): drag the four corners (TL/TR/BR/BL) onto the physical surface. A green
  perspective-correct calibration grid shows the mapping.
- Arrow keys nudge the selected handle (**Shift** = ×10), **R** resets, **Esc** finishes.

### Curved surfaces — Bézier warp
Open the row's **gear** ▸ tick **Bézier warp**. The mapping becomes a bicubic patch with **16 control
points** (4 corners + 12 curve handles). In **Align**, drag any control point; curved iso-lines + a
faint control net show the warp. Use it for cylinders, cyclorama corners, domes, angled walls.

### Spanning one picture across several projectors
Outputs ▸ **Spans**. Pick the surface you want to span (a video, an effect, or **Timeline** for the
whole show composite), press **New span**, then set **Cols** × **Rows** and one **Overlap %**.

That cuts the surface into overlapping **slices**. Each slice is an ordinary Surface, so it gets its
own output row underneath the source — its own display, its own corner-pin/Bézier alignment, its own
gamma and colour match — while the source itself is decoded **once**, no matter how many projectors
it feeds. The overlap number also writes each slice's soft edge, so the seams are set up with the cut
rather than after it.

The map under the controls draws the cut over the live picture: drag a piece to move it, drag an edge
to resize it. Either one **unlinks** the span (🔗), so the grid stops overwriting your hand-tuning;
press ⟳ **Regenerate** to go back to a clean grid. **Align span** puts the alignment grid up on every
projector of the wall at once, which is the only way to see where the overlaps actually land.

Deleting a span deletes the pieces it made. The source surface is left alone.

> A slice can also be made by hand — Inspector ▸ Content ▸ **Slice**, pick a surface and type the
> crop. The span wizard just does that N times and works out the overlaps for you.

### Overlapping projectors — soft-edge blend
In the gear panel, set per-edge **Soft edge %** (L/R/T/B feather) and **Blend γ**. Each output fades
its overlapping edge so two projectors sum to even brightness across the seam. A span sets the
feathers for you; these fields are for tuning them afterwards, or for a rig you wired by hand.

**Blend γ is your projector's gamma** (≈2.2), not a shape control — the ramp is `alpha^(1/γ)`, which
is what makes the two halves of an overlap sum to exactly 100% of full light. Measure it per machine
with **Auto-measure (camera)** in the same panel. Setting it wrong is what a dark or bright band in
the middle of an otherwise well-aligned seam looks like.

> ⚠ Before 2026-07-21 the ramp was `alpha^γ` — inverted — so the middle of every seam emitted about
> **7%** of full light instead of 100%: a black band exactly where the blend should be invisible.
> Shows saved with soft edge already set will look different (correct) after this fix.

### Per-screen gamma
The gear panel has an **Output γ** slider per output — correct a projector that's darker/brighter than
the rest without touching the others.

### Quality & performance
- **Anti-aliasing**: outputs render with 4× **MSAA** and at the display's native resolution (crisp on
  4K).
- **Performance mode**: the Outputs header has an **FPS cap** (Off / 60 / 30 / 24) that throttles all
  projector output windows — the biggest easy GPU saving for multi-projector / 4K rigs. It now covers a
  **calibrated** output's 3D render too, which it did not before: the cap used to throttle only the
  warp/blend stage while the venue re-render above it ran at display rate, so on a calibrated rig it was
  throttling the cheap half. Measured on the laptop, capping a calibrated output took the editor from
  17.3 to ~20 fps — **real, but small next to simply not having the output open, which is worth 60**.
  15 and 30 measured the same, so if the cap is not buying you anything, the cost is the window
  existing rather than the rate it draws at.

### Content that works
File **video / image**, **effects**, and **timeline layers** render independently in each projector at
native resolution. Live **camera / Spout / DMX-in** are streamed from the main window to the output.

---

## Broadcast (show) mode

Run only the outputs + Art-Net, with **no editor interface** — for an installed show / playback
machine.

```bash
ArtLux.exe --broadcast --project="C:\path\to\show.artlux"
```

- Loads the project (or the **last-opened** one if `--project` is omitted), opens every **enabled**
  output fullscreen, and streams Art-Net/sACN — no editor window.
- **Control**: a **system-tray icon** (tooltip = project name, right-click ▸ **Quit Broadcast**) and a
  global **Ctrl/Cmd+Shift+Q** hotkey.
- From the editor, **File ▸ Launch in Broadcast Mode** saves the current project and relaunches
  straight into the show.

> Difference from `--headless`: headless is engine-only (Art-Net, invisible, **no projectors**);
> broadcast adds the fullscreen projector outputs + tray control.

### Quitting (both modes)
Quitting is clean from anywhere — editor **and** broadcast — including when a frameless fullscreen
projector window is focused. The shortcut differs by platform, because what can reach that focused
output differs:

| | Editor | Broadcast |
|---|---|---|
| **macOS** | **⌘Q** (application menu ▸ Quit) | **⌘⇧Q** (global hotkey) or tray ▸ Quit |
| **Windows/Linux** | **Ctrl+Shift+Q** (global hotkey); **File ▸ Quit** shows it | **Ctrl+Shift+Q** or tray ▸ Quit |

On macOS the menu bar belongs to the *application*, not the window, so a menu accelerator already
reaches a frameless output and no global grab is needed — which matters, because a global grab is
system-wide and would take ⌘Q away from every other app on the machine. Broadcast builds no menu, so
there it is a global hotkey on every platform. Any quit path runs the
same teardown: unregister the shortcut, destroy the tray, and close every projector window.

---

## USB DMX (ENTTEC DMX USB Pro)

A DMX interface plugged into the machine, alongside — or instead of — Art-Net/sACN over the network.

**Setting one up.** Routing → **+ Controller** → protocol **USB DMX**. The IP box becomes a *device
picker* listing the USB devices attached right now, by their own product name; press the refresh
button beside it if the widget was plugged in after the app started. Patch fixtures to that
controller as usual.

You never type a COM port. A port saved in a project but not currently attached stays selected and
is marked *not connected*, so carrying a show to another machine does not silently clear it.

### What a controller drives — keeping LED and light traffic apart

A rig with an **Art-Net LED node** and a **USB-DMX widget** is two wires carrying two kinds of
fixture, and until now nothing connected them. `autoPatch`'s `defaultControllerId` is `undefined` at
every call site, so an unassigned fixture fell to **`controllers[0]`** — the first controller in the
array, whatever it happened to be. Every new moving head landed on the Art-Net node; with the widget
created first it went the other way, and 180-channel LED strips were addressed onto a device that
transmits **one** universe.

**Routing → the `Drives` column.** Set a controller to **LED**, **Light**, or **Any**. Auto-patch
then sends an unassigned fixture to a box that claims its kind, and the header gains one-click
**All Light → \<widget\>** / **All LED → \<node\>** (assigning forty heads used to be forty dropdown
clicks). A new controller defaults by protocol — USB DMX ⇒ Light, Art-Net/sACN ⇒ LED — and switching
an existing controller's protocol re-defaults it *unless* you set it by hand.

> **Absent means "any", and that is exactly the old behaviour.** The fallback chain is: a controller
> that declares this kind → an unclassified one → `controllers[0]`. With nobody declaring anything,
> rung 3 wins and patching is **byte-identical to before**, which is why this shipped without
> re-addressing saved rigs. That last rung is invariant-guarded; deleting it would make an
> unclassified rig silently re-patch on load.

**A report, never a rule.** Running movers over Art-Net is an ordinary rig, so a fixture on a
controller that claims the other kind is *badged*, not refused — with one click to move it to the
matching device. Setting `drives` **does** re-patch, so "my addresses moved" is an expected outcome
of changing what a box drives.

A `enttec` row also shows its fixture count beside its real capacity (`4fx · 1u`), so an overflow is
predictable before auto-patch rather than badged after it.

### A fixture that will not light — check its own Routing first

A fixture's destination is resolved on three rungs, and the first one that answers wins:

**its own Routing override → its controller → the global default** (Preferences ▸ DMX Output).

So a fixture patched to a perfectly configured USB widget still sends over the network if its *own*
Protocol is set to Art-Net. The controller is never consulted, the widget is never opened, and the
Routing screen shows nothing wrong — because nothing is wrong there. This is the single most common
reason a correctly-patched head stays dark.

**Fixture ▸ Routing** now ends with the answer, so you never have to reason it out:

```
Sends to  USB DMX COM3 · from Controller 1     ← inherited, which is normally what you want
Sends to  Art-Net 127.0.0.1 · fixture override ← this fixture ignores its controller
```

- **Protocol** — `Default`, Art-Net, sACN, or **USB DMX**. `Default` means *"no opinion — use my
  controller"*, and its label spells out where that lands for this particular fixture. Choosing
  `Default` is how you route a fixture to a widget in almost every case, because the controller
  already knows the port.
- **Device** — replaces Target IP when the destination is USB DMX, listing attached interfaces by
  their own product name. `↻` rescans, for a widget plugged in after the app opened. Leave it on
  `Default` to follow the controller's port.
- A USB destination with **no device** is called out in the panel: it transmits nowhere.

### One widget, one universe

A DMX USB Pro transmits a single universe (the Mk2's second port is not addressed yet). `autoPatch`
respects that: a fixture that lands past the device's last universe is flagged `patchOverflow` and
badged in Routing, rather than being addressed somewhere the widget will never transmit. An
unpatched-looking fixture is a question an operator can answer; a fixture that silently never lights
is not.

### Why the failure mode drove the design

`sender_loop` in the native engine is one thread driving every network destination. If a serial write
happened inline and a widget were slow, unplugged, or its driver blocked, **Art-Net would stop
mid-show** — a whole rig going dark because one USB device was pulled.

So each port gets its own writer thread and a **single-slot mailbox**: the pacer drops the latest
frame in and returns immediately. A frame that cannot be written is overwritten by the next one,
which is correct rather than regrettable — DMX is a state protocol, and a frame from 40 ms ago has no
value once a newer one exists. The widget behaves the same way (ENTTEC's docs say it drops rather
than queues).

Verified by patching a fixture to a **nonexistent** port and leaving it running: 446 Art-Net frames
delivered, the network head still outputting correctly, and one log line —
`[output-engine] serial open failed on COM99`. Loud once, show carries on.

**Confirmed on hardware 2026-09-01** with a real ENTTEC DMX USB Pro on COM3 driving a Cameo MOVO BEAM
100, alongside an Art-Net universe. Both ran together — `universes 2`, Art-Net steady at 60 pkt/s with
the widget transmitting — and **unplugging the widget mid-run did not disturb Art-Net at all**: the
network universe held 60 pkt/s across the yank while the USB port failed and released itself. That is
the design working exactly as written above.

### A widget that dies comes back on its own

The same test found the other half missing. A failed write parked the port for the life of the
process, and **nothing in the app ever called `outputManager.close()`** — the only thing that cleared
it — so plugging the widget back in did nothing. Recovery required relaunching ArtLux. A one-frame USB
glitch therefore cost the moving lights for the rest of the show, and it was easy to miss precisely
*because* Art-Net was unaffected: half the rig kept working and every gauge stayed healthy.

Now a dead writer is reaped and re-opened on a **2-second backoff** ([serial.rs](../native/output-engine/src/serial.rs)),
so a replugged widget resumes by itself. Retries are silent — an absent widget would otherwise write a
log line every two seconds all night — but a successful re-open still logs
`[output-engine] serial DMX open on COM3`, so recovery is visible. The failure logs once, as
`serial write failed on COM3 — releasing it, will retry`.

**Watch it in Prometheus.** `artlux_output_universes` counts a serial destination whether or not the
widget is attached, so on its own it cannot tell a lit rig from an unplugged interface. Two series
can: **`artlux_output_serial_ok`** and **`artlux_output_serial_down`**. Alert on
`artlux_output_serial_down > 0`.

### Details worth knowing

- **Paced at 40 Hz**, independent of the app's frame rate: the widget's own output rate tops out at
  40 packets/second and discards the rest.
- **The frame format needed no new field.** A serial target is `protocol == 2` with the COM path
  travelling in the same slot the network protocols use for their address
  ([frameCodec.ts](../shared/frameCodec.ts), [serial.rs](../native/output-engine/src/serial.rs)).
- **The packet**: `0x7E | label | len_lo | len_hi | 0x00 | channels… | 0xE7`. Label 6 is *Output Only
  Send DMX Packet*; note the end delimiter is `0xE7`, **not** `0x7E`. Four Rust unit tests pin the
  framing byte-for-byte (`cargo test -p artlux-output-engine`) because a wrong length or end byte
  makes the widget ignore the packet silently — the rig simply does not light, with nothing in a log.
- **USB DMX needs the native engine.** The pure-TypeScript fallback transport has no serial support,
  and explicitly drops those targets with a warning rather than blasting UDP at a host called "COM3".
- **Verified on a real DMX USB Pro** (FTDI `VID_0403+PID_6001`) on 2026-09-01, in 15-channel mode at
  address 1. The baud used to open the port (115200) is confirmed working; the DMX wire itself runs at
  250 kbaud on the widget's far side. **The Mk2's second port is still unconfirmed** — see ENTTEC's API
  spec v1.44 if it is ever needed.
- **`artlux_output_pps` over-reports USB DMX.** It counts a packet when a frame is *queued* to a port,
  but the writer paces to the widget's 40 Hz ceiling and drops the rest by design — so a 60 fps show
  reads 60 where 40 are transmitted. Use `artlux_output_serial_ok` / `_down` for widget health, not pps.

<!-- audience:contributor -->

## For developers / architecture

### Data model — `Controller.drives`
`drives?: 'pixel' | 'light'` on `Controller` ([types.ts](../src/renderer/types.ts)). Additive and
optional with the default at the read site, so no `ProjectData.version` bump and no migration. ⚠ A
project saved with it set is read by an **older build** as unclassified, which reverts that rig to
`controllers[0]` — worth a CHANGELOG line at release.

`crossKindPatches(fixtures, controllers)` in
[addressing.ts](../src/renderer/services/addressing.ts) is the pure report behind the badge.

### Data model (`shared/protocol.ts`)
- `ProjectorOutput { surfaceId, enabled, displayId, displayLabel?, cornerPin, warp?, softEdge?,
  gamma? }`, persisted as `ProjectData.projectorOutputs[]`. Global perf: `ProjectData.projectorFpsCap`
  (0 = uncapped).
- `CornerPin { tl,tr,br,bl }` normalized display-space corners.
- `BezierWarp { points:[16] }` — bicubic 4×4 control net (row-major, corners at indices 0,3,15,12).
- `SoftEdge { left,right,top,bottom,gamma }` — feather fractions 0..0.5; `gamma` is the **projector's**
  gamma and the ramp is `alpha^(1/gamma)` (partition of *light*, not of signal — see the type's header).
- `OutputSpan { id, name, sourceSurfaceId, cols, rows, overlapX, overlapY, sliceIds[], linked }`,
  persisted as `ProjectData.outputSpans[]`. **Authoring metadata only** — nothing reads it at runtime.
  The truth lives on the members: each slice's `SurfaceContent.sliceRect` and its output's `SoftEdge`.
  `App.applySpan` is the single writer that turns a grid into surfaces + outputs.

### Slices — one picture across several projectors (`SourceType.SLICE`)
A slice is a Surface whose content is a **cropped region of another Surface**
(`SurfaceContent { type: SLICE, sliceOf, sliceRect }`). It resolves in
`services/surfaceMedia.getDrawable` — the one seam the Stage composite, the per-surface WebGPU LED
sampler, the projector frame pump and the projector window all pass through — so spanning needed no
change to the output layer, the projector IPC, the SDK, the calibration plugin, NVAPI or NDI.

- The source's drawable is blitted into a per-slice offscreen canvas sized to the crop; the blit is
  skipped when the source's generation and the rect are both unchanged.
- `getDrawableGeneration` and `getContentAspect` delegate to the source (× the crop), so the frame
  pump's repeated-frame skip keeps working and each piece auto-fits to its own aspect.
- The pump therefore ships an **already-cropped, slice-sized** `ImageBitmap` — less IPC traffic than
  one unsliced output, not more.
- Slices **do not nest** and cannot slice themselves; both are refused with a one-time console warning
  (any sub-region is expressible as one rect on the original, and refusing it removes every cycle).
- `services/outputSpan.ts` holds the grid math (`spanTiles`, `tileSize`, `clampRect`) — pure, so it is
  provable with a throwaway `tsc`-checked script rather than a projector rig.
- A projector window syncs only its own surface, so `MainToProjector.config` carries `sources[]` (the
  surface a slice crops). That lets a sliced effect/image still render locally at display rate; a
  sliced video is still streamed, cropped, from the one decode in the main window.

### Windows & bridge (`src/main/projector.ts`)
- One frameless, fullscreen `BrowserWindow` per enabled output, positioned on the target display
  **before** `setFullScreen` (Windows multi-monitor) and shown with `showInactive()` so the editor
  keeps focus. Tracked in a `Map<surfaceId, {win, displayId}>`; `screen` watchers handle hot-plug.
- Bridged to the main window with a `MessageChannelMain` (one port pair each), the same pattern as the
  3D Scene window. The bridge works with the main window **hidden** (used by broadcast mode).

### Renderer (`src/renderer/projector/`)
- `projector.html` / `projector.tsx` → `ProjectorApp`: receives a `render` config + transport over the
  port, **self-renders** image/effect/tracking content via `services/surfaceMedia` (native res), or draws
  transferred `ImageBitmap`s for everything hardware-decoded — camera/Spout/DMX-in/NDI **and** file video
  and timeline layers — then warps it. It runs its own timeline in mirror mode and its own plugin host to
  do so.
- `ProjectorGL.ts`: **WebGL2** with a **4× multisampled FBO** resolved via `blitFramebuffer` (WebGL1
  `antialias` fallback). One fragment shader does warp geometry + soft-edge feather + gamma. Draw
  buffer sized by `devicePixelRatio` (= the display's `scaleFactor`) for native-res output.
- `homography.ts`: corner-pin via the perspective-correct vertex `q` trick + Heckbert `squareToQuad`
  (used for the calibration grid).
- `warp.ts`: Bézier — `makeBezierWarp` seeds a flat patch from the corner-pin; `evalBezier` (bicubic
  Bernstein); `tessellateBezier(n)` → a `WarpGrid` mesh the GL renderer draws (24× per axis).

### Main-window glue (`src/renderer/App.tsx`)
- Holds `projectorOutputs` state + a single reconciler (`useEffect` on surfaces/outputs/displays) that
  opens/moves/closes output windows and re-matches displays by label.
- A `projectorPortsRef` map handles each output's port; pushes the `render` config + transport; a
  ~30 fps frame pump `createImageBitmap`s drawables and transfers them. The streamed set is
  `{CAMERA, SPOUT, DMX_IN, NDI, VIDEO, LAYER, PROGRAM}` (`App.tsx` `STREAMED`) — i.e. **file video and
  timeline layers stream too**, not just live singular sources, because decoding the same media per
  window exhausts the GPU's concurrent hardware-decode sessions. Only `{IMAGE, EFFECT, TRACKING}`
  self-render (`ProjectorApp.tsx` `SELF_RENDER`); HAP layers are the exception that decode locally in
  mirror windows, having no hardware-session limit.
- **Broadcast branch**: gated on the `?broadcast=1` query (set by main). It auto-loads the project,
  then renders **only the offscreen `Stage`** — every output/projector effect above still runs, so
  Art-Net flows and outputs open without any editor chrome.

### Broadcast launch (`src/main/index.ts`)
- `--broadcast` → create the main window **hidden**, load `index.html?broadcast=1&project=…`,
  `setupBroadcastControls()` (Tray + `globalShortcut` Ctrl/Cmd+Shift+Q). `before-quit` unregisters the
  shortcut, destroys the tray, and `closeAllProjectors()`.
- File-menu **Launch in Broadcast Mode** → App saves, then `relaunchBroadcast(path)` IPC
  (`APP_RELAUNCH_BROADCAST` → `app.relaunch({args: [...relaunchArgs(), '--broadcast', '--project='+path]});
  app.exit(0)`).
- **All four relaunch sites** (this one, the calibration profile, the watchdog self-heal and the
  playlist switch) build argv with **`runProfile.relaunchArgs()`** — never by hand. It re-passes the app
  path when unpacked *and* adds **`--built-renderer`**, which every window builder honours through
  `runProfile.rendererDevUrl()` instead of reading `ELECTRON_RENDERER_URL` itself.

  **Why (this bit is load-bearing in dev).** `app.relaunch` spawns the successor with *this* process's
  environment — there is no `env` option — so it inherits electron-vite's `ELECTRON_RENDERER_URL`. But
  the `app.exit(0)` is exactly what makes electron-vite tear that dev server down. Without the flag the
  successor points at a dead port for its whole life: main boots, argv is right, the tray appears,
  `/metrics` answers `mode="broadcast"` — and the renderer never paints, so **no projector output ever
  opens and the menu item looks like it did nothing**. Out of `npm run dev`, broadcast therefore runs the
  **built** renderer, so `npm run build` must be current for it to reflect your renderer edits (main
  refuses the relaunch with a dialog if `out/renderer/index.html` is missing). Guarded by
  `npm run verify:invariants`.
- **A failed renderer load is fatal in a show mode.** `did-fail-load` (main frame, ignoring
  `ERR_ABORTED`) logs and calls `app.exit(1)` under `--broadcast`/`--headless`: those windows are
  invisible by design, `ready-to-show`/`did-finish-load` never fire on a failed load, and the watchdog
  arms on `did-finish-load` — so without this the process lingers with no output, no log and nothing
  armed to notice, holding the metrics port, the Art-Net socket and the audio device. The editor is left
  alone (visible window, Chromium's own error page).

### Build
`electron.vite.config.ts` adds the `projector` HTML rollup input (alongside `index` and `docs`).
electron-builder ships it automatically (`out/**/*`).
