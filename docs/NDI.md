# ArtLux — NDI (network video)

NDI® lets ArtLux **receive** a network video stream as a Surface's content, and **send** each
projector output as its own NDI source for other software (Resolume, OBS, vMix, media servers,
recorders). It's the cross-platform, network counterpart to Spout. Added in **v0.7.0**.

NDI® is a registered trademark of Vizrt NDI AB.

---

## For users — installation & use

### 1. Install the NDI Runtime (one time)
ArtLux ships the NDI integration, but the actual NDI runtime library is provided by Vizrt (free).
Install either:

- **NDI Tools** — <https://ndi.video/tools/> (recommended: also gives **Studio Monitor** to view
  output and **Test Patterns** to generate a test source), or
- **NDI Runtime** only — the minimal runtime.

On Windows, `winget install NDI.NDITools` (or `NDI.NDIRuntime`) works too.

Without it, ArtLux shows an **“Install NDI Tools”** hint where NDI is used and disables NDI gracefully —
the rest of the app is unaffected.

### 2. Receive an NDI stream onto a Surface
1. Select a Surface → Inspector → **Content** → **NDI**.
2. Pick a source from the dropdown (refresh ↻ to re-scan), or leave **First source**.
3. The stream drives the surface (and any fixtures sampling it). One live NDI source at a time.

### 3. Send a projector output as NDI
1. Open **Outputs**, enable a surface on a display (so its projector window is live).
2. Open the row's **gear** → tick **Send as NDI**.
3. The warped output is published as **“ArtLux — <surface name>”** at ≤720p, ~30 fps. Confirm in
   **NDI Studio Monitor** / your receiver. In **Broadcast mode** (`--broadcast`) the cap lifts to
   ≤1080p for full-HD show output (the editor keeps ≤720p for lighter preview).

---

## For developers — build & maintenance

The real NDI addon (`native/ndi/ndi.node`) is **committed as a prebuilt** (Windows x64), built once
against the gated NDI 6 SDK — so **CI and end users never need the SDK**. You only rebuild it when
`native/ndi/src/` changes.

### Toolchain to rebuild the addon (Windows)
1. **NDI 6 SDK** — <https://ndi.video/for-developers/ndi-sdk/> (free, short form). Installs to
   `C:\Program Files\NDI\NDI 6 SDK` and sets `NDI_SDK_DIR`. Provides the headers + import lib that
   `grafton-ndi` links.
2. **LLVM** (libclang, for `grafton-ndi`'s bindgen) — `winget install LLVM.LLVM`. Set
   `LIBCLANG_PATH` to `C:\Program Files\LLVM\bin` when building.
3. **NDI Runtime** (to run/test) — `winget install NDI.NDITools`.

### Rebuild + commit
```bash
# with NDI_SDK_DIR set (by the SDK installer) and LIBCLANG_PATH pointing at LLVM\bin
LIBCLANG_PATH="/c/Program Files/LLVM/bin" npm run build:ndi
git add native/ndi/ndi.node && git commit -m "build(ndi): refresh prebuilt addon"
```
`build:ndi` = `cargo build --release --features ndi` → `scripts/copy-ndi.cjs` copies the dll to the
committed `native/ndi/ndi.node`. (Default `npm run build:native` does **not** build the NDI crate, so
it never overwrites the prebuilt; the `ndi` cargo feature is off by default → stubs, so SDK-less
machines still compile the crate.)

### Live test (NDI Tools)
- Launch **Test Patterns** (an NDI source), then with the NDI runtime dir on PATH:
  ```bash
  PATH="/c/Program Files/NDI/NDI 6 Runtime/v6:$PATH" node -e "
    const ndi=require('./native/ndi/ndi.node');
    console.log(ndi.runtimeAvailable(), ndi.listSources());"
  ```
  Expect `true ["… (Test Pattern)"]`; `recvFrame()` returns a 720p RGBA frame. `sendCreate`+`sendFrame`
  publishes a source visible in **Studio Monitor**. (Validated against NDI 6 Tools.)

---

## Architecture

- **Native addon** `native/ndi/` (napi-rs, mirrors `spout-receiver`): `runtimeAvailable`,
  `cpuSupported`, `listSources`, `recvConnect/recvDisconnect/recvFrame`,
  `sendCreate/sendFrame/sendDestroy`, `setRecvCap`. Real impl via **grafton-ndi** behind the `ndi`
  cargo feature; stubs otherwise. `recvFrame` downscales to a runtime cap (≤1280×720 default,
  raised to ≤1920×1080 via `setRecvCap` in Broadcast mode).
- **Main** `src/main/transport/ndiManager.ts`: loads `ndi.node` (graceful if absent),
  60 Hz receive poll, multi-instance send. **`ensureNdiOnPath()`** prepends the NDI runtime dir
  (`NDI_RUNTIME_DIR_V6` + known fallbacks) so the linked `Processing.NDI.Lib.x64.dll` is found before
  `require`. IPC: `NDI_AVAILABLE/LIST/CONFIGURE/FRAME` (receive) + `NDI_SEND_CONFIGURE/NDI_SEND_FRAME`.
- **Receive (renderer)**: `services/ndiReceiver.ts` → `getNdiCanvas()`; wired into `surfaceMedia` as a
  single-live source (`SourceType.NDI`, `SurfaceContent.ndiName`); Inspector content button.
- **Send (renderer)**: per-output `ProjectorOutput.ndiSend`; the projector window's
  `ProjectorGL.captureRGBA()` reads back the warped result (≤720p, or ≤1080p in Broadcast; Y-flipped) → `sendNdiFrame` IPC →
  `ndiManager`. App reconciles senders (named `ArtLux — <surface>`); `before-quit` tears them down.

### Packaging
`win.extraResources` ships `native/ndi/ndi.node` (Windows only — NDI is Windows-first). `build/installer.nsh`
is a template to silently install the NDI Runtime during install/update once you bundle the redist.

## Troubleshooting
- **“NDI runtime not found” in the app** → install NDI Tools/Runtime; the addon links
  `Processing.NDI.Lib.x64.dll`, found via `NDI_RUNTIME_DIR_V6`.
- **`runtimeAvailable` false in a script** → the NDI DLL isn't on the process PATH; add
  `C:\Program Files\NDI\NDI 6 Runtime\v6` (the app does this automatically via `ensureNdiOnPath`).
- **Rebuild fails “NDI header not found”** → install the NDI 6 SDK (`NDI_SDK_DIR`).
- **Rebuild fails “Unable to find libclang”** → install LLVM + set `LIBCLANG_PATH`.
