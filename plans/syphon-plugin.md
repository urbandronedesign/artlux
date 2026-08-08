# Syphon — macOS GPU video receive (`@artlux/plugin-syphon`)

**Branch:** `syphon` · **Status:** planned, nothing built · **Written:** 2026-08-08

> **Built blind (owner's call, 2026-08-08).** No Mac is available; the whole feature is written on
> Windows and tested on hardware in a few days. The substitute for a Mac is the `macos-latest` CI
> runner plus a loopback selftest — see [§4.8](#48-build-it-blind--and-isolate-the-one-decision-that-cannot-be-settled-blind)
> and [§5.0](#phase-0--the-macos-ci-gate-replaces-the-spike). Read those before starting.

> **CI VERDICT, 2026-08-08 (run `31257760049`, `e4438af`) — the gate is green and four unknowns are
> closed on real macOS.** The framework builds, the Objective-C shim compiles and links, the addon
> loads, and the loopback selftest passes 0-failed/0-warned. Specifically:
>
> | Was open | Now |
> |---|---|
> | §4.3 does bare `SyphonClientBase` work? | **Yes.** No subclass, no Metal, no `MTLDevice`. The fallback beside `artlux_make_client()` stays unused. |
> | §4.2 does the (name, appName) discovery model hold? | **Yes** — reported `selftest — artlux-selftest`, in-process, on a headless runner. The warn-only hedge was unnecessary. |
> | §10 q2 does the picture MOVE behind a reused surface? | **Yes (Syphon half).** Same pointer `0x102b563a0` across both frames, pixels changed `0xFF0000FF → 0xFFFF0000`. |
> | the +1 leak hazard | **Balanced.** Retain count 3 → 3 across 100 acquire/release cycles. |
>
> Also learned, and it belongs on the Mac-day checklist: **nothing in Syphon happens synchronously.**
> The client/server handshake is CFMessagePort traffic delivered on run-loop turns, so frames
> published before a client attaches are not retroactively delivered and the first frames after a
> connect are legitimately absent. `receive_shared` returning `None` there is correct, not a fault.
>
> **Packaging verified too** (run `31258673640`, `420c48e`): `Syphon.framework` lands in
> `Contents/Frameworks`, the shipped addon resolves `@rpath/Syphon.framework/Versions/A/Syphon`, and
> inside-out ad-hoc signing gives `valid on disk` / `satisfies its Designated Requirement` under
> `codesign --verify --strict`. `npm run verify` passes on macOS as well as Windows.
>
> **Still needs the Mac, and only this:** Electron's `importSharedTexture` accepting the surface, and
> whether Chromium re-reads a `SharedImage` it already imported from the same `IOSurface`
> (failure mode: a frozen first frame, not a black one).

The macOS counterpart to [`plugins/spout`](../plugins/spout/). Same job, same shape, same operator
story: take another app's GPU texture on this machine and pixel-map it, with no file, no network hop
and no readback. Reference docs: <https://syphon.info/FrameworkDocumentation/> and the framework
source at <https://github.com/Syphon/Syphon-Framework>.

Read [docs/SPOUT.md](../docs/SPOUT.md) first. This plan is written as a *diff* against Spout, because
that is what it is — and because the four places where Syphon is **not** like Spout are the whole
engineering content of the job.

---

## 1. The headline: Syphon is the easier half of Spout

Spout's hard parts were (a) Spout's share handle is a legacy DX9 token that Electron cannot duplicate,
so the addon must re-share the texture through its own D3D11 device (`native/spout-receiver/src/share.rs`),
and (b) `is_frame_new()` lies, so the poll rate needed a hand-tuned floor and ceiling.

**Neither exists on macOS.** Syphon's transport primitive is an `IOSurface`, which is exactly what
Electron's `sharedTexture` API wants on darwin, and Syphon's frame counter is real. Four verified
facts, each of which deletes a piece of the Spout design:

| Fact | Verified where | What it deletes |
|---|---|---|
| Electron's `SharedTextureHandle.ioSurface` is a `Buffer` holding the raw `IOSurfaceRef` pointer (`sizeof(uintptr_t)` bytes), and Chromium **RETAINs** it rather than taking ownership | `electron/shell/common/api/electron_api_shared_texture.cc` — `GetNativeHandle("ioSurface", …)`, then `ScopedCFTypeRef<IOSurfaceRef>(io_surface, scoped_policy::RETAIN)` | The whole re-share. There is **no `share.rs` equivalent**. |
| Syphon servers create their surface with `kIOSurfaceIsGlobal: YES` and `kCVPixelFormatType_32BGRA`, `bytesPerElement 4` | `SyphonServerBase.m:242-258` | The DXGI→pixel-format table. It is **always `'bgra'`**; there is no unsupported-format branch. |
| `SyphonClientBase` exposes `-newSurface` (public, via the `SyphonSubclassing` module) returning a `+1` `IOSurfaceRef`, plus `-hasNewFrame` and `-isValid` | `SyphonSubclassing.h`, `SyphonClientBase.m:197-205` | **Metal and OpenGL entirely.** No `MTLDevice`, no `SyphonMetalClient`, no GL context. Syphon → `IOSurfaceRef` → Electron, and nothing in between. |
| `hasNewFrame` is backed by the server's published frame ID (`_connectionManager frameID`), not a heuristic | `SyphonClientBase.m:190-205` | Spout's `pollHz()` **ceiling** and the 36%-duplicate-frames measurement behind it. A gated poll can be honest. |

The consequence is a smaller plugin than Spout with a strictly simpler native crate. If the
implementation starts growing a texture-copy step or a format table, something has gone wrong —
go back and re-read this table.

### 1.1 What is *harder* than Spout

Two things, both in discovery, and both must be designed in from the start rather than patched later:

1. **Syphon server identity is a pair, not a name.** A Spout sender is a unique string. A Syphon server
   is described by a dictionary whose `SyphonServerDescriptionNameKey` is *non-unique and frequently
   empty* — many apps publish one unnamed server and are identified only by
   `SyphonServerDescriptionAppNameKey`. A picker that lists names alone will show a column of blanks.
   See [§4.2](#42-what-we-persist-syphonname--syphonappname).
2. **A client does not follow its server.** `SyphonClientBase.isValid` goes `NO` when the server quits
   and *never recovers*. Spout's `Receiver::new(None)` re-resolves on the sender side for us; here the
   manager must watch `isValid`, drop the dead client, and re-resolve from the directory. Without this,
   "Active server" is a lie the first time the sender app restarts — which, in a venue, is every time.
   See [§5.3](#phase-3--the-native-crate-nativesyphon-receiver).

---

## 2. Architecture

Identical topology to Spout; only the middle box changes.

```
Syphon server (Resolume / TouchDesigner / MadMapper / Isadora / VDMX …)
        │  IOSurface (BGRA8, global, refcounted)
        ▼
native/syphon-receiver  ──  SyphonServerDirectory + SyphonClientBase (main thread, Cocoa run loop)
        │  IOSurfaceRef pointer, 8 LE bytes, +1 retained by us
        ▼
plugins/syphon/src/sharedTexture.main.ts  ──  sharedTexture.importSharedTexture({ ioSurface })
        │                                     Chromium RETAINs → WE STILL OWN OUR REFERENCE
        ▼  sendSharedTexture(frame, 'syphon', meta)
src/preload/index.ts  ──  the EXISTING generic shared-texture relay (no change needed)
        │  window.postMessage({ kind:'artlux:shared-texture', channel:'syphon', frame })
        ▼
plugins/syphon/src/syphonReceiver.ts  ──  holds newest VideoFrame, closes the one it replaces
        ▼
syphonContentSource (refcounted) → getDrawable() → the frame engine, unchanged
```

The preload relay was built generic on purpose ("the sender names a channel … because NDI receive and
any future GPU source want the identical road"). **Syphon is that future GPU source, and the relay
needs zero edits.** Confirming that is the single cheapest validation of the whole seam.

---

## 3. File map

New:

| Path | Role |
|---|---|
| `native/syphon-receiver/Cargo.toml` · `build.rs` · `src/lib.rs` | napi crate: directory + client, mac impl + non-mac stubs |
| `native/syphon-receiver/src/client.rs` | the `objc2` calls — the only Objective-C in the tree |
| `plugins/syphon/package.json` | `@artlux/plugin-syphon`, `"sideEffects": false`, `/main` + `/renderer` exports |
| `plugins/syphon/src/main.ts` · `renderer.ts` | the two barrels (barrel-only imports — non-negotiable) |
| `plugins/syphon/src/plugin.main.ts` · `plugin.renderer.ts` | activation + splash `status()` |
| `plugins/syphon/src/syphonManager.ts` | native load, connect, poll, incompatibility latch |
| `plugins/syphon/src/sharedTexture.main.ts` | import + hand-off + **release our IOSurface reference** |
| `plugins/syphon/src/syphonReceiver.ts` | renderer: newest `VideoFrame`, close-on-replace |
| `plugins/syphon/src/syphonContentSource.ts` | refcounted `ContentSourceProvider` |
| `plugins/syphon/src/SyphonEditor.tsx` | server picker (app + name) + incompatibility banner |
| `plugins/syphon/src/syphonHost.ts` | `pollFps()` from `AppSettings.engineFps` |
| `plugins/syphon/src/types.ts` | `SyphonConfig`, `SyphonServerDesc`, `SyphonShare`, `SyphonIncompatibility` |
| `scripts/build-syphon.sh` | fetch + `xcodebuild` Syphon.framework, cargo, copy |
| `docs/SYPHON.md` | the usage page (see [§8](#8-documentation--the-gate)) |

Edited:

| Path | Edit |
|---|---|
| `src/renderer/types.ts` | `SourceType.SYPHON`, `SurfaceContent.syphonName`, `.syphonAppName` |
| `shared/protocol.ts` | mirror if `SourceType` is duplicated there (check at implementation) |
| `electron.vite.config.ts` · `tsconfig.json` | two alias entries each (`/main`, `/renderer`) |
| `src/main/host/plugins.ts` · `src/renderer/host/plugins.ts` | add to `FIRST_PARTY` |
| `scripts/copy-native.cjs` | `{ dir:'syphon-receiver', lib:'artlux_syphon_receiver', out:'syphon-receiver.node', required:false }` — the `.dylib` candidate is already in the probe list |
| `package.json` → `scripts` | `"build:syphon"` |
| `package.json` → `build.mac` | `extraFiles` for the framework, `extraResources` for the `.node` |
| `scripts/mac-adhoc-sign.cjs` | sign inside-out (framework → `.node` → app), not `--deep` |
| `scripts/verify-invariants.cjs` | the Syphon block (see [§7](#7-guards)) |
| `scripts/verify-plugins.cjs` | two single-identity markers |
| `scripts/verify-package-resources.cjs` | the mac resources |
| `docs/manifest.json` | `"SYPHON.md": "hybrid"` + a `$referenceOrder` slot next to `SPOUT.md` |
| `docs/SPOUT.md` · `docs/NDI.md` | cross-links |
| `CLAUDE.md` | doc index row, native-module table row, plugin list |

Untouched, and that is the point: `src/preload/index.ts`, `renderer/engine/frameEngine.ts`,
`services/contentSource.ts`, the SDK.

---

## 4. Decisions

Each of these is a real fork. Recommendation first, then why.

### 4.1 A separate `SourceType.SYPHON`, not a shared "GPU share" type

**Recommend: separate.** A new core enum value + new `SurfaceContent` fields, behaviour in the plugin,
zero project migration — the exact pattern CLAUDE.md's "Core stays core" rule prescribes and that
`NDI`/`SPOUT`/`TRACKING` already follow.

The alternative — one type whose name field is interpreted per-platform — buys one thing: a project
authored on Windows with a Spout surface would light up on a Mac if a same-named Syphon server exists.
That is a narrower win than it sounds (the names rarely match; Syphon identity is a pair) and it costs
a persisted-semantics change to a shipped type, which is the one thing this codebase refuses to do.

**Mitigate the portability cost honestly instead**, in the spirit of Spout's "an honest refusal is
worth more than a degraded picture nobody can account for": when `SourceType.SPOUT` content is opened
on darwin, `SpoutEditor` already renders the `no-native` banner — reword its macOS case to name the
fix (*"Spout is Windows-only. On macOS use Syphon."*) and give `SyphonEditor` the mirror line on
Windows. Two strings, no architecture.

### 4.2 What we persist: `syphonName` + `syphonAppName`

`SurfaceContent` gains **both**, and both empty means "active server" (Spout's convention, preserved).
Resolution goes through `-[SyphonServerDirectory serversMatchingName:appName:]`, which takes exactly
this pair and treats `nil` as "don't care".

Do **not** persist `SyphonServerDescriptionUUIDKey`: the header says it identifies a *server instance*,
so it changes when the sender app restarts — persisting it would produce a project that works until
the first relaunch. The picker displays `AppName — Name` (or just `AppName` when the name is empty),
which is the convention every Syphon client uses.

### 4.3 `SyphonClientBase` + `-newSurface`, not `SyphonMetalClient`

**Recommend `SyphonClientBase`.** `SyphonMetalClient` would mean creating an `MTLDevice`, letting
Syphon wrap the surface in an `MTLTexture`, and then immediately unwrapping it again via
`MTLTexture.iosurface` to hand Electron the thing we already had. `-newSurface` is public (declared in
`SyphonSubclassing.h`, an explicit module of the framework), `SyphonClientBase` is an exported class
(`Exported_Symbols.exp`), and its `initWithServerDescription:options:newFrameHandler:` is a public
designated initializer.

**Risk, and the fallback:** `SyphonClientBase` is written as a base for subclasses; there is a small
chance direct instantiation misbehaves (`-invalidateFrame` is documented as a subclass override point
and is a no-op in the base — which is what we want, since we hold no cached texture). If it does,
the fallback is a ~20-line ObjC++ subclass, or `SyphonMetalClient` + `.iosurface`. **Spike this in
Phase 1 before anything else is built** — the whole "no Metal" simplification rests on it.

### 4.4 Rust napi — but the Objective-C is written in Objective-C

**REVISED DURING IMPLEMENTATION, 2026-08-08.** This section originally said "Rust + `objc2`, raw
`msg_send!`". Building blind changed the answer, and the reason is worth keeping:

> `msg_send!` is **unchecked at the point of writing**. A wrong selector, a wrong nullability or a
> wrong ownership family compiles happily in Rust and misbehaves at runtime — which is precisely the
> one failure mode a compile-only CI gate cannot catch. With a Mac on the desk that is a ten-minute
> discovery; with no Mac for days it is the whole risk of the branch.

So the shape is: **a napi crate whose Objective-C is a real `.m` file**, compiled by `cc` in
`build.rs` and exposed over a flat C ABI. clang checks every selector against Syphon's own headers,
and the Rust side collapses to ~20 `extern "C"` declarations that can be audited by eye. The napi
crate, the `.node` naming and the graceful-degradation pattern are unchanged.

It also split into **two crates**, forced by a real constraint rather than taste:

```
native/syphon-receiver/            artlux-syphon-receiver  (cdylib, napi)
  syphon-sys/                      artlux-syphon-sys       (rlib, the ObjC + FFI)
    src/shim.m  src/shim.h  src/lib.rs
    examples/selftest.rs           ← the loopback test
```

A napi crate's generated registration code references Node's `napi_*` symbols, which resolve only
because a `.node` is linked with `-undefined dynamic_lookup`. An **executable** — a cargo example —
linked against that same crate has no such escape and fails at link time. Putting the Objective-C one
level down is what lets the selftest be an ordinary binary that links no Node at all, and the selftest
is the thing buying back the blindness. A `-sys` crate is the idiomatic shape for this anyway.

Linking in `build.rs` (framework search + link in `syphon-sys`, rpaths in the napi crate):

```rust
println!("cargo:rustc-link-search=framework={FRAMEWORK_DIR}");
println!("cargo:rustc-link-lib=framework=Syphon");
println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");              // dev: framework beside the .node
println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../Frameworks"); // packaged: Contents/Frameworks
```

The `native/audio-engine` cmake-js path stays the exception it is.

### 4.5 Poll gated on `hasNewFrame`, not the `newFrameHandler` block

**Recommend polling.** Spout's poll needed a floor (because sampling below the sender judders) *and* a
ceiling (because `is_frame_new()` lies). Here only the floor's reasoning survives, and `hasNewFrame` is
truthful, so a poll above the server's rate costs one lock and one integer compare and delivers
nothing — it is free, not wasteful. Poll at `clamp(engineFps, 60, 120)` Hz, gate every iteration on
`hasNewFrame`, and **write the comment explaining that the ceiling is inherited caution rather than a
measured constraint**, so nobody later "fixes" it by copying Spout's ceiling rationale into a file
where it is not true.

`newFrameHandler` is the better long-term answer (push, zero idle polls) but it fires on a Syphon
thread and would need a napi `ThreadsafeFunction` plus its lifetime hazards. Named as a follow-up, not
v1.

### 4.6 Hand Syphon's own IOSurface to Electron — do not copy it

**Recommend no copy.** Spout copies because it must (the handle is unusable); Syphon's is directly
usable, so a copy would be pure cost.

The honest caveat: the server writes into the same `IOSurface` we are reading, with no keyed mutex —
Syphon has no interlock and every Syphon client lives with this. Tearing is theoretically possible.
Every other Syphon client accepts it; so do we. **If** tearing is observed on real hardware, the fix is
a Metal blit into our own `IOSurface` — structurally the same move as `share.rs` — and *that* is the
moment to introduce a Metal device, not before. Record the observation in this file if it happens.

### 4.7 Vendoring: build the framework from a pinned source tag

**Recommend `scripts/build-syphon.sh`** that fetches Syphon-Framework at a pinned tag and runs
`xcodebuild -project Syphon.xcodeproj -scheme Syphon -configuration Release`, producing a universal
(`arm64` + `x86_64`) `Syphon.framework` into `native/syphon-receiver/`.

Not a committed binary. `native/ndi/ndi.node` is committed only because the NDI SDK is licence-gated
and cannot be fetched in CI — Syphon is BSD-2-clause with no dependencies and builds in seconds, so
the reason does not transfer. Gitignore the framework like every other build output. Add the
attribution to `NOTICE` (see [ArtLux licensing] — `NOTICE` §2 already has a known error; fix it in the
same pass or leave it alone deliberately, but do not add a third state).

### 4.8 Build it blind — and isolate the one decision that cannot be settled blind

**Owner's call, 2026-08-08: there is no Mac available. Build the whole thing on Windows and test on
hardware in a few days.** That is workable, and this section is what makes it workable rather than a
pile of code nobody has ever compiled.

The danger is not the TypeScript — that typechecks and bundles here. It is the **`#[cfg(target_os =
"macos")]` module in the Rust crate**, which on a Windows machine is *never compiled at all*. Blind
Objective-C-from-Rust with no compiler is a guaranteed pile of wrong selector signatures, wrong
nullability and wrong framework linkage, and none of it is visible until someone opens a Mac.

**So the Mac we do not own is the CI runner.** `.github/workflows/build.yml` already carries
`macos-latest` in its matrix. A second, cheap workflow that fires on every push to this branch turns
"blind" into "compiled, linked and loopback-tested blind" — see [§5.0](#phase-0--the-macos-ci-gate-replaces-the-spike).
That kills the entire *does it build* class of error, which is most of the risk, in ~5 minutes a push.

**And isolate what CI still cannot answer.** §4.3 (does bare `SyphonClientBase` work, or is a subclass
needed?) is a runtime question. Confine it to **one function** — `fn make_client(desc) -> Retained<AnyObject>`
in `client.rs`, with the `SyphonMetalClient` fallback written and `#[allow(dead_code)]` beside it — so
swapping it on the day is a five-line change and not a redesign. Same for §4.6: keep the "hand over
Syphon's own surface" call site to a single line so a Metal blit can be slotted in behind it.

---

## 5. Phases

Reordered for blind-build: everything Windows-verifiable is finished and green first, the CI gate
stands in for the spike, and only genuinely un-simulatable work waits for hardware.

### Phase 0 — The macOS CI gate (replaces the spike)

`.github/workflows/syphon.yml`, `on: push: branches: [syphon]` plus `workflow_dispatch`,
`runs-on: macos-latest`. Land this **first**, before a line of Rust, so the first crate commit gets a
verdict. Steps:

1. `scripts/build-syphon.sh` — fetch Syphon-Framework at a pinned tag, `xcodebuild`, universal binary.
2. `cargo build --release --manifest-path native/syphon-receiver/Cargo.toml` — **the actual gate.**
   Every ObjC selector, every `objc2` type, the framework link, the rpath args.
3. `otool -L native/syphon-receiver/syphon-receiver.node` — assert the `@rpath/Syphon.framework`
   entry is there and no absolute build-machine path leaked in.
4. `cargo run --example selftest` — the loopback test below.
5. `npm ci && npm run verify && npm run build`.
6. *(once Phase 6 lands)* `npx electron-builder --dir`, then `codesign --verify --deep --strict` the
   `.app` and re-run `otool -L` on the packaged `.node`. This is the step that catches the signing and
   `extraFiles`-layout problems that dev mode structurally cannot.

**The loopback selftest is the interesting part.** A cargo `example` (the pattern already used for the
launcher — see [ArtLux launcher verification]) that, in one process with no GPU and no second app:

- creates a `SyphonMetalServer` (or a `SyphonServerBase` subclass) named `artlux-selftest`,
  publishes a frame of known solid colour;
- reads `[[SyphonServerDirectory sharedDirectory] servers]` and asserts the entry appears, with the
  expected `Name`/`AppName` keys — **this validates the discovery model, §4.2, without a Mac**;
- builds a client via `make_client`, asserts `isValid`, asserts `hasNewFrame`;
- calls `-newSurface`, asserts non-null, asserts `IOSurfaceGetWidth/Height` and
  `IOSurfaceGetPixelFormat == 'BGRA'`;
- `IOSurfaceLock` + read one pixel, asserts the known colour — **proving the frame is real, not just
  a non-null pointer**;
- publishes a *second, different* frame and asserts `hasNewFrame` flips and the pixel changes —
  **this is open question 3 (same pointer every frame → does the picture actually move?) answered
  without hardware**;
- kills the server and asserts `isValid` goes `NO`, then asserts the manager's re-resolve path finds
  nothing — **§5.3's "a client does not follow its server", tested**;
- asserts a `CFGetRetainCount` balance across a hundred acquire/release cycles — **the leak guard**.

That is four of §10's five open questions and both of §1.1's hard parts, closed on a machine we do
not own. What it cannot reach is Electron: `importSharedTexture` needs a GPU process and a real
Syphon *server in another app*. Those two, and only those two, wait for the Mac.

**Cost note:** artlux is public so CI minutes and artifact storage are unbilled ([ArtLux CI artifact
storage]) — but keep this workflow off `v*` tags and off `main` so it never delays a release build.

### Phase 1 — `docs/SYPHON.md`

Per **THE DOCUMENTATION RULE**, the usage page ships with the feature, not after it. Writing it first
also forces the operator-facing decisions (what the picker shows, what each failure says) before they
get made by accident in a `.tsx`. `docs/manifest.json` + `$referenceOrder` in the same commit;
`npm run verify:docs` must pass.

### Phase 2 — Scaffolding

`plugins/syphon/` with the two barrels, `package.json` (`"sideEffects": false`), the aliases in
`electron.vite.config.ts` + `tsconfig.json`, `SourceType.SYPHON` + the two `SurfaceContent` fields,
and registration in both `host/plugins.ts` files. Plugin activates, `status()` reports
`{ state:'off', detail:'macOS only' }` on Windows. Nothing receives yet. `npm run verify` green on
Windows — **this whole plan must keep the Windows build clean at every commit.**

### Phase 3 — The native crate `native/syphon-receiver`

Mirrors `spout-receiver` exactly, including the non-mac stubs so CI stays green.

```rust
#[napi] pub fn list_servers() -> Vec<SyphonServerDesc>   // { name, app_name }
#[napi] pub fn connect(name: String, app_name: String) -> napi::Result<()>
#[napi] pub fn disconnect()
#[napi] pub fn receive_shared() -> Option<SyphonShare>   // { surface: Buffer(8), width, height }
#[napi] pub fn release_surface(surface: Buffer)          // ← the macOS-specific one. See below.
```

Four things this crate must get right:

- **Everything on the main thread.** `SyphonServerDirectory` and `SyphonClientBase` are
  `CFMessagePort`/distributed-notification driven and need run-loop turns on the thread that created
  them. Electron's main process runs a Cocoa run loop, so main-thread-only is both correct and free.
  Create the directory **at plugin activation, not on the first `list_servers()`** — it needs to have
  been alive for a moment to have heard the announcements, and an operator who opens the picker to an
  empty list will conclude their sender is broken.
- **Re-resolve on `isValid == NO`.** Every poll: if the client has gone invalid, drop it and try to
  rebuild from the directory using the stored `(name, appName)` — or, when both are empty, the current
  first server. This is what makes "Active server" and a sender restart survivable. Cap the retry to
  the poll rate; no backoff needed, the lookup is a dictionary scan.
- **Return `+1` and say so.** `-newSurface` is a `new…` method: the caller owns a reference.
  We hand the pointer to JS and JS hands it to Chromium, which **retains** it (verified above) — so
  **we** must `CFRelease` it after `importSharedTexture` returns. Hence `release_surface`. Getting this
  wrong leaks a full-resolution surface per frame, the macOS twin of the missed `VideoFrame.close()`.
  This is the one place where the Syphon path is *more* fiddly than Spout's, where Chromium duplicates
  the NT handle and the addon's own copy is closed by the addon.
- **No format branch.** `pixelFormat` is `'bgra'`. Assert `IOSurfaceGetPixelFormat == 'BGRA'` and
  return `None` if not — a defensive check for a future Syphon, not a supported path.

`scripts/build-syphon.sh` + `npm run build:syphon` land here; `copy-native.cjs` gains the crate.

### Phase 4 — Main-process half

`syphonManager.ts` (native load with the three-candidate path probe, connect/poll/stop, the
`Incompatibility` latch — `'no-native' | 'no-shared-texture' | 'import-failed'`) and
`sharedTexture.main.ts` (import → `sendSharedTexture(…, 'syphon', meta)` → `release_surface`).

Carry across, verbatim in spirit, the two Spout hazards that cost real time there:

- Check `win.isDestroyed()` **and** touch `frame.url` before importing. Electron logs
  "Render frame was disposed…" internally rather than throwing, so a `try`/`catch` around the send
  sees nothing and reports a delivery that never happened.
- A `/disposed|destroyed/i` message is teardown, **not** an import failure — returning `false` for it
  would latch the GPU path off for the rest of the session after any reload.

`plugin.main.ts` wires `syphon:list` / `syphon:configure` / `syphon:incompatible` over the generic
bridge and reports `status()` to the splash: `off` + `"macOS only"` off darwin (the splash must not cry
wolf on Windows, exactly as Spout must not on a Mac).

### Phase 5 — Renderer half

`syphonReceiver.ts`, `syphonContentSource.ts` (refcounted by consumer key, most-recently-acquired
wins), `syphonHost.ts`, `SyphonEditor.tsx`, `plugin.renderer.ts`.

`syphonReceiver.ts` is a near-copy of `spoutReceiver.ts` with `channel === 'syphon'` — **including the
comment block on why closing a frame on replacement is safe for async readers.** That measurement
(181 frames closed, 181 bitmaps resolved, 0 rejections) is what stops the retirement queue being
rewritten; a copy of the file without it will grow one back, and `verify:invariants` should require it
here too.

`SyphonEditor.tsx` differs from `SpoutEditor.tsx` in exactly one way that matters: options are
`AppName — Name` and carry the pair. Keep `"Active server"` as the empty default.

### Phase 6 — Packaging, signing, guards

`build.mac.extraResources` for `syphon-receiver.node`; `build.mac.extraFiles` for
`Frameworks/Syphon.framework` (electron-builder's mac `extraFiles` are relative to `Contents/`, which
is how the framework reaches `Contents/Frameworks` and the `@loader_path/../Frameworks` rpath resolves).

**`scripts/mac-adhoc-sign.cjs` must change.** It currently runs `codesign --deep` on the `.app`;
`--deep` is deprecated by Apple and unreliable for nested frameworks. Sign inside-out: the framework
first, then each `.node`, then the app. An unsigned or wrongly-signed nested Mach-O does not warn on
Apple Silicon — it refuses to load, and the failure surfaces as `[syphon] native receiver unavailable`,
which reads exactly like "you didn't build it". Budget time for this; it is the likeliest source of a
confusing afternoon. (We ship unsigned-by-decision and unnotarized — see [ArtLux code signing]; ad-hoc
is about *loadability*, not Gatekeeper.)

Guards in [§7](#7-guards). `verify-package-resources.cjs` learns the mac set.

---

## 6. What this plan does **not** do

- **No Syphon *send*.** ArtLux sends NDI per projector output; `SyphonMetalServer` is the obvious mac
  analogue and a natural Phase 7, but it is a separate feature with its own docs obligation. Out of
  scope, named here so it is not re-derived from scratch later.
- **No OpenGL client.** `SyphonOpenGLClient` exists and we need nothing from it.
- **No change to `scripts/preflight.ps1`**, which errors out on macOS by design. A mac preflight is a
  real gap ([docs/INSTALL.md](../docs/INSTALL.md) is Windows-shaped) but it is not this branch's job.
- **No Linux story.** Electron's `nativePixmap` path is "to be implemented" in Electron itself.

---

## 7. Guards

`npm run verify:invariants` — a new block, mirroring *"Spout delivers GPU textures only"*. Every check
below encodes a specific way this can silently break:

| Check | The bug it prevents |
|---|---|
| `syphonReceiver.ts` contains no `ImageData` / `putImageData` / pixel-buffer vocabulary | someone re-adds a readback path "as a fallback" |
| `syphonReceiver.ts` calls `.close()` | a leaked GPU image per frame |
| `syphonReceiver.ts` still mentions `createImageBitmap` | the close-on-replace measurement note gets dropped and the retirement queue comes back |
| `sharedTexture.main.ts` calls `releaseSurface` (or the crate's equivalent) after every `importSharedTexture` | **the macOS-specific leak** — Chromium retains, so our `+1` is ours to drop |
| `syphonManager.ts` mentions `Incompatibility` | a machine that cannot do this stops being told |
| `lib.rs` contains no readback symbol | ditto, on the native side |
| the crate's non-mac path is a stub returning `None` | a Windows build that fails to compile |

`npm run verify:plugins` — two single-identity markers, same shape as Spout's:
`{ plugin:'syphon', where:'renderer', marker:'syphon:configure' }` and
`{ plugin:'syphon', where:'main', marker:'syphon] native receiver loaded' }`.
This is the guard that catches the barrel-vs-relative import mistake that duplicated a singleton once
already. Verify by hand too: `grep -o "<marker>" out/.../*.js | wc -l` must be **1** per window bundle.

`npm run verify:docs` — `SYPHON.md` tagged `hybrid` in `docs/manifest.json` therefore **must** carry an
`<!-- audience:contributor -->` marker, or the check fails (an unmarked hybrid silently declares its
implementation half to be operator documentation).

---

## 8. Documentation — the gate

`docs/SYPHON.md`, structured like `docs/SPOUT.md` and written **in Phase 1**:

- **Requirements & platform** — macOS only; a Syphon server on the same machine; nothing to install
  (Syphon is embedded in the sender apps, there is no runtime).
- **Using it** — start a server, set surface content to Syphon, pick `App — Name`, leave it empty to
  follow the active server, map fixtures.
- **Engine rate does not apply** — same warning as Spout, same reason.
- **When Syphon says "not compatible"** — the three-row table. Note the *good* news explicitly: the
  "both apps on the same GPU" section that dominates `SPOUT.md` **has no Syphon equivalent**, because
  `IOSurface`s are not bound to a single adapter. Say so; an operator arriving from the Windows page
  will look for it.
- `<!-- audience:contributor -->` **Architecture (brief)** — the four-fact table from §1, the
  "we retain, Chromium retains, we release" ownership rule, and the poll/`hasNewFrame` note including
  *why the ceiling is not Spout's ceiling*.
- **Related / Source map.**

Also: `CLAUDE.md` doc-index row, native-module table row and the shipped-plugins sentence; a
cross-link in `docs/SPOUT.md` ("the macOS sibling") and in `docs/NDI.md`; `docs/PLUGINS.md`'s plugin
list if it enumerates them.

---

## 9. Verifying it

Split in two, because we are building blind. **Everything in 9A must be green before the Mac arrives**
— hardware time is the scarce resource and it should not be spent on compile errors.

### 9A — Without a Mac (Windows + CI, continuous)

| What | Where | Catches |
|---|---|---|
| `npm run verify` (invariants + docs + `tsc`) | Windows, every commit | the TS half, the doc gate, the new guards |
| `npm run build` | Windows | bundling, the aliases |
| `verify:plugins` marker count = 1 per bundle | Windows | the barrel-vs-relative duplicate-singleton bug |
| `cargo build --release` (mac target) | CI | **every line of Objective-C-from-Rust** |
| `otool -L` | CI | framework linkage + rpath |
| `cargo run --example selftest` | CI | discovery, client lifecycle, IOSurface contents, frame advance, retain balance |
| `electron-builder --dir` + `codesign --verify --strict` | CI, from Phase 6 | the signing and `extraFiles` layout |

**The Windows build must stay clean at every commit.** The two ways this branch can break it: a
`verify:invariants` check written so it fires off-darwin, and a `copy-native.cjs`/`build.mac` edit
that makes a missing artifact fatal rather than optional. Both are avoidable; both are easy to do by
accident.

### 9B — On the Mac (the day it arrives)

There is no test runner, and per [ArtLux workflow] the verification is *run the app and watch the
logs*. In order — and note that 1, 2, 5, 6 and 7 are cheap because CI already proved the crate works:

1. `npm run build:syphon && npm run dev`. Expect `[syphon] native receiver loaded` — its absence is
   either the build or the ad-hoc signature, and the two look identical from JS. Check with
   `codesign -dv --verbose=4` and `otool -L native/syphon-receiver/syphon-receiver.node`.
2. A known server. **Simple Server** from the Syphon SDK is the reference; Resolume/MadMapper/
   TouchDesigner/VDMX for real content. Confirm the picker shows `App — Name` and that an unnamed
   server is still identifiable.
3. Watch for `[syphon] GPU shared-texture path active — WxH bgra, no readback` **once**. Its absence
   with a picture present would mean a CPU path exists, which is the thing that must not exist.
4. **Leak watch — the one macOS-specific hazard.** Run 10+ minutes at 1080p60 and watch VRAM/memory.
   A missed `CFRelease` on the `IOSurfaceRef` and a missed `VideoFrame.close()` produce the *same*
   symptom, so instrument both sides before concluding which. `Instruments → Allocations` filtered to
   `IOSurface` distinguishes them.
5. **Server restart while connected**, with the picker on "Active server" *and* on an explicit pick.
   The picture must come back without operator action — this is §4.2/§5.3 and it is the thing most
   likely to be quietly wrong.
6. Resize the server's output mid-run (the surface identity changes). Expect a clean re-import.
7. Multiple surfaces + a timeline clip on the same server → one receiver, refcount released on the
   last consumer.
8. **Verify in the mode it ships in.** Per [ArtLux test the target mode]: also launch the *packaged*
   `.app` (not `npm run dev`) with `--broadcast`, from a project whose surface is already Syphon. The
   packaged run is the only one that tests the framework's rpath, the ad-hoc signature and the
   `extraFiles` layout — three things dev mode cannot fail on.

---

## 10. Open questions

Marked by who can answer them, since we are building blind.

1. **§4.3 — does bare `SyphonClientBase` work?** *(CI selftest closes this.)* Fallback costs ~20 lines
   of ObjC++; per §4.8 it is confined to `make_client`, so it threatens a function, not the design.
2. **Does the picture actually move?** Syphon's server reuses one surface until the size changes, so
   unlike Spout (a fresh copy per frame) we hand over an identical pointer repeatedly. *(CI selftest
   closes the Syphon half: publish two frames, assert the pixel changes.)* **The Chromium half stays
   open until the Mac** — whether `importSharedTexture` re-reads a `SharedImage` it has already
   imported from the same `IOSurface`, or caches. This is the single largest surviving unknown, and
   its failure mode is a **frozen first frame**, not a black one. If it bites, the fix is the Metal
   blit from §4.6 — which is why that call site stays one line.
3. **Universal binary.** `arm64` only, or `x86_64` too? The framework build and the Rust target must
   agree with whatever `build.mac` targets. *(Answerable now, on Windows — read the electron-builder
   config and decide before writing `build-syphon.sh`.)*
4. **Does macOS ship any other blocker for the venue build?** Per [ArtLux venue GPU + platforms],
   WebGPU is default-on for macOS/M1 and audio works; NDI, calibration and NVAPI do not. Syphon
   closes the biggest remaining hole in a mac build, which is worth saying in `docs/INSTALL.md` when
   the mac story is written up — but that is a separate piece of work.

---

## 11. Estimate

Blind-build ordering. Roughly: CI gate + `build-syphon.sh` ½ day · docs ½ day · scaffolding ½ day ·
crate + selftest 2 days (longer than the original 1½ — the loopback test is extra work, and it is the
work that buys the blindness back) · main ½ day · renderer ½ day · packaging + signing ½ day blind and
½ day on hardware.

**Everything except the last item can be written on Windows and proven by CI.** On-hardware time then
collapses from "verify the whole feature" to §9B's list, of which only steps 3, 4 and 8 — the Electron
import, the leak watch and the packaged `--broadcast` run — are genuinely irreducible. Call it half a
day at the Mac if CI has been green, and a full day if we skipped the CI gate to save an afternoon.
