# Shaders — operator-authored generative content and a reusable effect library (`@artlux/plugin-shader`)

**Branch:** `shader-content` · **Written:** 2026-08-10 · **Revised twice the same day** (in-app editor → decisions locked)

> # ⚠ STATUS: PLAN ONLY — NOTHING IS BUILT
>
> Every open question in the two earlier drafts is now closed. The schema, the worked examples and
> the MadMapper comparison that produced several of these answers are in
> [shader-schema.html](shader-schema.html) — read it first if you want the pictures.

## 0 · The decisions, locked

| | Decision | Why it was not a coin toss |
|---|---|---|
| **Language** | **GLSL ES 3.00** on WebGL2 | The only dialect that runs on both a WebGPU venue machine and the WebGL-fallback machine shows are *built* on — and the one with a corpus to start from |
| **Entry point** | **`vec4 shaderColor(vec2 uv)`** — resolution-free, not Shadertoy's `mainImage` | One file has to serve a 60-LED strip and a 4K projector. MadMapper reached the identical signature for the identical reason ([§3.1](#31--the-entry-point-is-resolution-free)) |
| **Authoring** | **An editor in the app** (CodeMirror 6) | [§5](#5--the-editor) |
| **v1 capability** | Generative content, automatable params, **plus sound-reactive inputs and previous-frame feedback** | Both are one header line each once the param system exists, and they are most of what separates *alive* from *looping* ([§6](#6--audio-and-trails-are-input-types-not-subsystems)) |
| **Reuse** | An effect is a **folder**; the library lives in `userData` and **copies into the project on use** | Without copy-in a show renders black at the venue and nothing on the authoring machine warns you ([§7](#7--the-library)) |
| **Starters** | **Written in-house**, covering **both** the projection and the LED families | Shadertoy's default licence is CC BY-NC-SA 3.0 — share-alike, contagious, and this repo is public ([§7.4](#74--what-ships-in-the-box)) |
| **Audience** | **Anyone using ArtLux**, not just the author | This is the decision with the longest reach — see immediately below |
| **Surface FX** | **NOT in v1.** A separate contribution, designed for but not built | [§10](#10--surface-fx-is-a-different-feature-and-that-is-the-point) |

### 0.1 "Anyone using ArtLux" is the constraint that reorders the work

Written for one expert, this is a text box and a compile button. Shipped to unknown authors, three
things change and they change the *order*, not just the polish:

1. **Safety lands before the editor, not after it.** An author who does not know GLSL well will write
   an unbounded loop, and an unbounded loop is a driver TDR that takes down the whole machine
   ([§8](#8--the-risk-no-other-content-source-has)). The runtime must already refuse to die before
   anyone is handed a keyboard. In this plan the whole of Phase 1 is that, and the editor is Phase 2.
2. **The starter library is the teaching mechanism, not a bonus.** Nobody learns from an empty file.
   **New** offers templates, never a blank buffer, and the intended path in is *duplicate a starter and
   change a number*.
3. **Error messages are a feature with a budget.** A wrong line number is worse than no line number,
   because it sends someone hunting through code that is fine ([§3.2](#32--the-wrapper-and-the-line-number-debt)).

---

## 1 · What this is

A surface's content can be a fragment shader written inside ArtLux. It renders per frame, fixtures
sample it like any other picture, projector outputs show it, its parameters sit on the timeline, and
finished effects accumulate in a library that outlives the project they were written for.

---

## 2 · The seam already exists

**The rendering half needs zero core changes.** `SurfaceContent.type` is an *open string space* and
unknown types dispatch through `contentSourceRegistry` — the default branch of `getDrawable`
(`src/renderer/services/contentSource.ts:589-592`) and the comment above `SurfaceContent`
(`src/renderer/types.ts:246-252`). The content half is a plugin registering a `ContentSourceProvider`
with `type: 'SHADER'`, a `getDrawable`, an `editor` fragment and a `pickerButton`. No enum value,
**no project-file migration**. Same shape `ndi` and `mediapipe` took.

**A shader canvas costs what a camera costs.** Every content source is already a `CanvasImageSource`
uploaded per frame with `copyExternalImageToTexture` (`gpu/WebGPUMapper.ts:648`). "Render on the
mapper's shared `GPUDevice` and skip a copy" buys nothing — the copy happens regardless. That is what
frees the language choice from the mapper's WebGPU-ness.

**It supersedes the built-in effects without breaking them.** Five hardcoded names in `gpu/effects.ts`
baked into a WGSL `switch` (`effectColor`, `WebGPUMapper.ts:66`), plus a **CPU** 96×96 `putImageData`
loop in `gpu/surfaceFx.ts`. `'EFFECT'` keeps working forever — projects persist `effectId`/`paletteId`
— and the five ship again as GLSL starters that behave identically.

**The multiplier is `AutomationTargetRegistry`** (`packages/sdk/src/renderer.ts:69`). A declared param
becomes a timeline lane, an OSC target and a state-machine value with no new core code, because the
registry resolves a dot-path by its head and hands the rest to the owning plugin.

---

## 3 · The shader contract

### 3.1 The entry point is resolution-free

```glsl
vec4 shaderColor(vec2 uv)   // uv is 0..1 across the surface. Never a pixel count.
```

This is the correction MadMapper's documentation forced, and it is load-bearing. Their materials use
`vec4 materialColorForPixel(vec2)` because a material renders *directly at the output's resolution*.
ArtLux has the same problem twice over: the mapper uploads a surface into an atlas rect **sized to
that surface's LED density** (`WebGPUMapper.ts:653`), while a projector wants its native raster. A
pixel-based signature forces the author to care which one they are feeding; a normalised one means
they never find out.

`iAspect` is supplied for shaders that need round circles. Shadertoy's `mainImage(out, in)` is
accepted through a thin adapter that defines `fragCoord`/`iResolution` in terms of the real render
size, so pasted code runs — it just isn't the documented way to write a new one.

### 3.2 The wrapper and the line-number debt

The plugin wraps the author's text: `#version 300 es`, precision, uniforms, the palette and audio
helpers, resolved `#include`s ([§7.4](#74--what-ships-in-the-box)), and a `main()` that calls
`shaderColor`. **Every line the wrapper adds shifts every reported error.**

The wrapper is generated, so its line count is known exactly — but it is *not constant*, because
`#include` resolution injects a variable number of lines. Keep a **line map** from wrapped line to
(file, line) and translate every diagnostic through it. Getting this wrong points a novice author at
code they did not write; it is the single cheapest way to make the feature feel broken.

### 3.3 Uniforms, and the clock that will generate bug reports

`iResolution`, `iAspect`, `iFrame`, the declared params, and:

**`getDrawable`'s `timeSec` for surfaces is the SHOW clock, not wall time.** The comment at
`contentSource.ts:556-563` says out loud that this changed and that any provider assuming a
monotonic never-pausing clock is now wrong with nothing to warn it. A shader on `iTime` therefore
**scrubs with the timeline and freezes when the transport is stopped** — correct, deterministic,
seekable, and guaranteed to read as *"my shader is broken"* the first time someone opens one parked.

- **`iTime`** — show time. Default. Scrubs, freezes when stopped.
- **`iWallTime`** — free-running. For ambient content that must move regardless.

The editor's preview runs on `iWallTime` so a shader is authorable with the transport stopped, and
**labels itself**, because a silent divergence between preview and stage is a ghost hunt.

### 3.4 Palettes are an input type

`gpu/palettes.ts` already builds the 256×N RGBA LUT the mapper samples by `(colorIndex, paletteId)`.
Bind it and expose `vec3 palette(int id, float t)` with a `"TYPE": "palette"` input. An operator's
shader inherits ArtLux's gradients, a palette becomes an automatable parameter, and the five legacy
effects can be re-authored to behave identically — which is the migration story for `'EFFECT'`.

---

## 4 · The header

An **ISF-compatible subset** — a JSON object in a leading block comment — because that is what the
public shader library and MadMapper/VDMX already emit, so a downloaded shader arrives with its knobs
already described.

Supported `TYPE`s: `float`, `bool`, `long` (enum), `color`, `point2D`, **`palette`**
([§3.4](#34--palettes-are-an-input-type)), **`audioFFT`**, **`audio`**
([§6](#6--audio-and-trails-are-input-types-not-subsystems)). Anything else — `image` above all — is
**rejected with a message naming the type and what to do instead**, never silently dropped.

Each declared input becomes a typed inspector control, an `AutomationTargetDef` under
`shader.<surfaceId>.<name>`, and therefore a timeline lane / OSC address / state-machine value.

**Values live on the surface, not in the file.** The header declares the knob and its default; the
operator's setting persists in `SurfaceContent`, so recompiling never resets a show. A param that
disappears from the header keeps its stored value — it usually comes back on the next save — but
stops being shown.

**Do not copy MadMapper's `GENERATORS`.** They put modulation sources (dampers, envelopes, pass-through
channels) in the header. ArtLux already routes every automatable parameter through one registry the
timeline, OSC and state machine all read. A second, header-local modulation system beside it means two
ways to animate one number, and the failure is invisible until an operator's OSC and a header damper
disagree.

---

## 5 · The editor

**CodeMirror 6, in a dock panel.** New dependency: `@codemirror/{state,view,commands,language,search,lint,autocomplete}`
plus `@codemirror/lang-cpp` (~250–400 KB, tree-shaken).

Why not Monaco: its advantage is language-server intelligence and **there is no GLSL language
server**, so both editors need a hand-written completion source and Monaco's ~5 MB and worker
plumbing buy nothing.

Why CodeMirror specifically, beyond size: the app asks *"is the operator typing?"* with
`tagName === 'INPUT' || 'TEXTAREA' || isContentEditable` in at least four places — `App.tsx:598`,
`components/timeline/hooks/useTimelineKeys.ts:36`, `shell/ContextRail.tsx:27`,
`timeline/StateGraphEditor.tsx:412`. CodeMirror's editable surface is a `contenteditable` div, so
**all four already hold with no edit**. A canvas-drawn editor would break every one, and the first
symptom would be pressing space inside a shader and starting the show.

`@fontsource/ibm-plex-mono` is already a dependency, so the editor inherits the design system's face.

Required, given unknown authors:

- **The compile log in the gutter** via CodeMirror's `lint` API, translated through the line map, plus
  the raw log in a collapsible block — a driver sometimes says something useful that maps to no line.
- **A static completion source** from the uniforms, the declared params, the include libraries and the
  GLSL ES 3.0 builtins. Cheap (`autocompletion` with a fixed list) and disproportionately useful,
  because uniform names are the part nobody can guess.
- **Templates on New** ([§0.1](#01-anyone-using-artlux-is-the-constraint-that-reorders-the-work)) — never a blank buffer.
- Search, bracket matching, multi-cursor, comment-toggle: the defaults, unabridged.

### 5.1 Compile on command, never on keystroke

**`Ctrl+Enter` compiles.** Compile-as-you-type is not a convenience here — a half-typed `for (;;)` is
a TDR, and an editor that compiles what you have typed *so far* will find one. Auto-compile-on-idle
may exist as an opt-in on a machine driving nothing; it is **hard-off under `--broadcast`** whatever
the pref says.

**Do not steal `Ctrl+S`** — it means *save the project*, and a second meaning inside one panel is how
work gets lost. `Ctrl+S` keeps its global meaning and additionally flushes the shader buffer.

### 5.2 The text must not enter the document undo stack

Undo/redo is a document-wide snapshot stack (`useHistory<DocSnapshot>`, `App.tsx:254`). A snapshot per
keystroke would turn the show's history into a text buffer, and one `Ctrl+Z` on the stage would rewind
someone's shader by a character. **CodeMirror owns its text history**; the shader reaches the document
as *one* undoable step on save — the same granularity as renaming a surface.

### 5.3 The preview, and where the panel lives

A live preview inside the editor panel, from the same shared context, at low resolution — without it,
authoring means writing in one panel and hunting for the affected surface in another, and a shader not
yet bound to a surface would have nowhere to appear at all.

**A dock panel, not a new workspace context.** The shell has nine contexts and a standing rule against
adding one so two things can share a screen; the workspace is dockable, so an editor that wants half
the window gets it by being dragged there, and the panel maximises the way the timeline already does.
Register it in the Surfaces context's manifest and **bump that context's `layoutRev`**, or an operator
who has already opened that workbench keeps their banked layout and never sees the panel appear.

---

## 6 · Audio and trails are input types, not subsystems

MadMapper's documentation settles both, and settles them the same way: as *parameter types*, which
means each inherits the inspector control, the automation lane and the storage rules for free.

**Sound-reactive** — `"TYPE": "audioFFT"` (a spectrum) or `"audio"` (a waveform), delivered as a small
1D texture, with `SIZE` and an **attack / decay / release** envelope in the header. The envelope is
what makes it musical rather than jittery, and it belongs in the declaration, not in every author's
shader. ArtLux already has the audio engine to feed it; the work is a tap, an FFT and an envelope
follower, not a subsystem.

**Trails and feedback** — a header flag grants a `lastFrame` sampler holding the shader's own previous
output. One ping-pong FBO per surface. **No cycles, no cross-surface ordering, no graph** — which is
exactly why this is safe in v1 while sampling *another surface* is not. Trails, decay and
reaction-diffusion are most of what people want feedback for.

The ping-pong buffer has one honest cost: it is a full-resolution texture pair per surface that
declares the flag. Off by default, allocated only on demand, and released when the flag goes away.

---

## 7 · The library

Two tiers, and keeping them distinct is what keeps the UI honest:

- **A shader** — the code, with its param *declarations*.
- **An effect** — a shader **plus values, a name and a thumbnail**. Several effects can share one
  shader. This is what an operator reaches for and what the browser shows.

### 7.1 An effect is a folder

Following MadMapper, and simpler than the index-plus-cache the previous draft proposed:

```
userData/shaders/Breathing Plasma/
  shader.frag        ← the code + its header
  values.json        ← this effect's parameter values
  thumbnail.png      ← rendered once, on save
```

Export is a folder copy. Import is a folder copy. There is no index to corrupt and no thumbnail cache
to invalidate. **Do not build an online library** — MadMapper has one; it is a product, not a feature,
and a folder that exports covers the actual need.

### 7.2 The rule that keeps a show from breaking at the venue

**A project must never resolve content out of the user library at render time.** The venue PC has a
different `userData`. Using a library effect **copies it into `<project>/assets/shaders/`**, and the
render path reads only from there — the existing copy-in asset doctrine (`docs/ASSETS.md`) applied to
a new asset kind. It is the one rule here whose violation is invisible on the authoring machine.

Two consequences, both of which must be *visible* rather than merely true:

1. **Editing a library entry does not retro-change projects that used it** — correct, because a show
   that worked last night must work tonight, and surprising. The inspector shows provenance:
   *"from library: Breathing Plasma · differs"*, with explicit **Update from library** and **Publish
   to library**. Nothing syncs implicitly in either direction.
2. **Editing a project's shader changes every surface in that project using it** — the point of
   reuse, and it must be stated *before the fact*: a usage count in the editor header
   (*"used by 3 surfaces"*), not discovered afterwards.

### 7.3 The browser

A library panel in the browser column: search, tags from the header's `CATEGORIES`, thumbnails, drag
onto a surface, and New / Duplicate / Rename / Delete / Reveal in folder.

Thumbnails render offscreen at low resolution into the same single context, **sequentially** — a grid
of forty previews each grabbing a context would trip the browser's context cap
([§8](#8--the-risk-no-other-content-source-has)) and silently kill the earliest ones.

### 7.4 What ships in the box

Written in-house, both families, because a shader that reads well at 4K often looks like noise on 60
LEDs and the docs have to make that difference concrete:

- **LED family** — the five legacy effects re-authored (Solid, Rainbow, Palette Flow, Wave, and Fire,
  which is the interesting port since it is stateful and now has `lastFrame` to be stateful *with*),
  plus a chase and an energy meter. 1D-along-the-strip, palette-driven.
- **Projection family** — an SDF shape field, a noise/fBm field, a plasma, a radial sweep, and one
  audio-reactive piece. Full-frame, big-reading.

Plus **bundled `#include` libraries** — common (constants, colour conversion), noise (value/fBm/worley)
and SDF primitives. Nobody should paste a hash function to get started, and for an audience that may
not know GLSL well this is most of the floor. WebGL has no `#include`, so this needs a resolver in the
compile step, and the resolver is what makes the line map ([§3.2](#32--the-wrapper-and-the-line-number-debt))
non-trivial.

---

## 8 · The risk no other content source has

**A user-authored fragment shader is arbitrary GPU code, and an unbounded loop is a driver TDR** —
which does not kill the surface but the machine's graphics: every window, the show, every output.
Shipping the editor to unknown authors raises the probability from "someone might" to "someone will".

Therefore **all of this is Phase 1, before the editor exists**:

- **A pre-compile lint** rejecting loops with no compile-time bound. Crude, catches the common
  accident, **is not a sandbox** and must never be documented as one.
- **A per-surface frame budget** — exceed it for N consecutive frames and the surface disables itself,
  keeps its last frame, and reports through `services/faultReporter`. `docs/WATCHDOG.md` is the
  neighbouring doctrine.
- **A compile failure keeps the last good program running.** A typo saved during a show costs an error
  message, not the wall. A shader that has *never* compiled renders black and says why.
- **`webglcontextlost` handling.** A driver reset must rebuild the context and recompile every live
  program, or all shader surfaces stay dead until the app restarts.
- **No compiling on the show path**, ever ([§5.1](#51--compile-on-command-never-on-keystroke)).

One implementation rule, because its failure is silent:

> **ONE WebGL2 context, N framebuffers, N programs** — shared by surfaces, the editor preview and the
> library thumbnails. Browsers cap live contexts (~16) and **drop the oldest without an error**, so a
> rig with twenty shader surfaces would lose the first ones with nothing in the log.

Fill-rate is the budget, not draw calls — the lighting-beam work learned this the expensive way.
Measure at 720p / 1080p / 4K in Phase 0 before promising anything.

---

## 9 · The projector path

Projector windows self-render `IMAGE` / `EFFECT` / `TRACKING` locally and stream everything
hardware-decoded from the main window as ImageBitmaps (`projector/ProjectorApp.tsx:26`); their
compositor is **WebGL2** (`projector/ProjectorGL.ts`). A GLSL shader joins `SELF_RENDER`.

**The source text crosses the window boundary; the pixels never do.** Main broadcasts the compiled
source over `plugin:` IPC to every renderer window, each compiles its own program, and each renders at
the resolution *it* needs — LED density in the main window, native raster in the projector. Nothing
per-frame crosses the MessagePort. This is drawn in [shader-schema.html](shader-schema.html), figure 1.

Not through `projector/bridge.ts`: that bridge carries per-frame and config traffic, shader source is
neither, and plugin activation already runs in projector windows.

---

## 10 · Surface FX is a different feature, and that is the point

MadMapper separates **Materials** (generate a picture, `materialColorForPixel`) from **Surface FX**
(process the picture that is there, `fxColorForPixel`, reading the surface through a `FX_NORM_PIXEL`
macro). They are different questions, and modelling the second as "the first with an extra input" is
precisely what makes the cross-surface sampling graph hard — ordering, cycles, and a full-resolution
copy per link.

**Not in v1.** Design for it and do not build it: keep the wrapper generator, the header parser, the
param→automation bridge and the library able to carry a second entry-point kind, so Surface FX later
is a new contribution rather than a rewrite. A file written now must not need editing then.

---

## 11 · Phasing

Safety precedes the editor; the editor precedes the params; the library comes last because it is worth
nothing until there is something worth putting in it.

| Phase | What | Done when |
|---|---|---|
| **0 · Spike** | `type: 'SHADER'`, one hardcoded shader, **one shared context** from the first commit, `getDrawable` returns its canvas. Fill-rate measured at 720p/1080p/4K, on the fallback machine too | A shader is visibly on a surface and sampled by fixtures, with numbers for what it costs |
| **1 · The runtime survives abuse** | `shaderColor` + Shadertoy adapter, wrapper + **line map**, loop lint, frame budget + auto-disable, last-good-program, `webglcontextlost` recovery | A deliberately hostile shader disables itself and the app keeps running |
| **2 · The editor** | CodeMirror panel, lint gutter through the line map, completion source, `Ctrl+Enter`, in-panel preview on `iWallTime`, single-step undo, templates on New | Someone who has never written GLSL can open a template, change a number and see it |
| **3 · The knobs** | ISF-subset header → typed controls → `automationTargets`; the `palette` type | A shader param is drawn as a timeline lane and moves the picture |
| **4 · Alive** | `audioFFT` / `audio` inputs with ADSR; the `lastFrame` flag + ping-pong | A shader pulses with the audio bed and leaves trails |
| **5 · The library** | Effect folders in `userData`, browser + thumbnails, copy-in, provenance + usage count, `#include` resolver, both starter families | An effect written in one project lands on a surface in another, and the first project still renders after the library entry changes |
| **6 · The venue** | Projector `SELF_RENDER` at native res, `--broadcast` compile lockout | A shader survives a projector output and a broadcast boot with no editor open |
| **Deferred** | Surface FX ([§10](#10--surface-fx-is-a-different-feature-and-that-is-the-point)), cross-surface `iChannel`, a MadMapper-material compatibility shim, external-editor watch + conflict UI, a WGSL backend | — |

**Docs are not a phase.** Every phase above ships its usage page in the same commits
([§12](#12--obligations)).

---

## 11.1 · Phase 0 results (2026-08-10) — BUILT, MEASURED, ON THE WIRE

`plugins/shader` exists and renders. Verified the way this repo verifies output: a project with a
SHADER surface and a 60-LED fixture, booted `--headless`, with a `dgram` listener parsing ArtDmx.
**413 frames, universe 0, 512 channels, 412 of them lit, and the peak LED visited all 60 positions
(0 → 59)** — the `strip` comet ran the full length of the strip, so the pixels made the whole trip:
GLSL → ImageBitmap → the mapper's atlas → universe packing → UDP. (Frame 1 is dark, which is the
cold-start gate holding, not a fault.)

**Fill-rate, Intel Iris Xe / ANGLE D3D11** — ms per frame, sustained, GPU-synced. This is the
*authoring* machine and the WebGL-fallback case; the RTX numbers cannot be taken here.

| shader | 640×360 | 1280×720 | 1920×1080 | 3840×2160 |
|---|---|---|---|---|
| plasma | 0.052 | 0.127 | 0.182 | 2.380 |
| rings | 0.020 | 0.048 | 0.162 | 2.413 |
| strip (LED) | 0.019 | 0.047 | 0.138 | 2.371 |
| heavy (64 trig octaves) | 0.332 | 1.279 | 2.845 | 11.302 |
| **+ `transferToImageBitmap`** | +0.02 | +0.06 | **+0.65** | **+2.8** |

Three things follow, and two of them changed the code:

1. **At 720p a shader is free** (~0.05–0.13 ms; ten of them ≈ 1 ms of a 33 ms frame) — so the default
   render size is right and the LED path is not the thing to worry about.
2. **The transfer is not free above 720p.** `transferToImageBitmap` — the mechanism that lets ONE
   context serve N surfaces — costs 0.65 ms at 1080p and 2.8 ms at 4K, which *doubles* a cheap
   shader. It is the measured price of the one-context rule, it is worth paying, and it is another
   reason a projector output should self-render in its own window (Phase 6) rather than be fed
   pixels from here.
3. **Resizing the shared canvas per frame at 4K KILLED THE GPU PROCESS** (`exit_code=34`),
   reproducibly, twice, with no hostile shader involved — and every compile afterwards returned
   failure with an **empty info log**, i.e. black surfaces and nothing to read. So `RENDER_HEIGHTS`
   now stops at 1080p in the main window (nothing is lost: the atlas rect discards finer detail
   anyway), and `ensure()` asks `gl.isContextLost()` rather than trusting the event. The plan's TDR
   section was written about hostile shaders; the first real context loss came from *our own resize
   path*.

Also found, and left alone deliberately: **`ContentSourceProvider.pickerButton` is declared by the
SDK and consumed by nothing.** Every plugin content type (NDI, Spout, Tracking, MediaPipe, Augmenta)
hand-writes a button in `components/ContentEditor.tsx`, so SHADER does too. Rendering these from the
registry is the obvious cleanup and a separate one — doing it here alone would give the plugins that
still declare a button two of them.

**Bench harness:** throwaway, in the session scratchpad (an Electron main + a page, so the numbers
come from the shipping Chromium/ANGLE stack rather than a browser). Not committed.

## 12 · Obligations

- **The documentation gate.** Net-new feature: `docs/SHADERS.md` ships in the *same commits* as each
  phase, with a `docs/manifest.json` entry, and `npm run verify` must pass. Almost entirely `usage` —
  the operator writes the shader, so the uniform reference, the header schema, the clock semantics
  ([§3.3](#33--uniforms-and-the-clock-that-will-generate-bug-reports)) and the copy-in rule
  ([§7.2](#72--the-rule-that-keeps-a-show-from-breaking-at-the-venue)) are operator documentation. The
  uniform table and the supported `TYPE` list are **generated** into `<!-- generated:x -->` blocks from
  the plugin's own source — a hand-written uniform table is guide chapter 15 all over again.
- **Licence hygiene.** No shipped starter derives from a Shadertoy shader unless its author granted
  something permissive; the site default is CC BY-NC-SA 3.0, share-alike and contagious, and this repo
  is public. Documented in the docs page so operators converting shaders for their own shows know
  where the line is.
- **Barrel-only imports.** Host code touches the plugin only through
  `@artlux/plugin-shader/{main,renderer}`; the plugin's own files import each other relatively;
  `"sideEffects": false`. Verify the singleton appears **once** per window bundle with a unique marker
  — the shared WebGL2 context is exactly the kind of singleton that bug duplicates.
- **New invariants** as the code lands: one context not N; a compile failure keeps the last good
  program; shader text never enters `DocSnapshot` per keystroke; the library is never read on the
  render path.
- **Verify by running it**, in the mode it ships in — a `--broadcast` boot with a shader surface and no
  editor open, not just the editor.

---

## 13 · Still to verify (do not guess)

1. Does an unknown plugin-contributed content type already work as a **timeline clip**, or only as
   surface content? `getDrawable`'s callers include clips; confirm rather than assume.
2. Does the **asset registry / Media Library** accept a non-media asset kind (a shader folder) without
   a special case — listing, copy-in, relink, portable export? The library's copy-in rides on it.
3. Does a projector window's plugin activation run early enough to receive the first source broadcast,
   or must it request one on activate? (Assume it must; verify.)
4. What should `getDrawableGeneration` return for a shader? It yields `undefined` for anything not
   `VIDEO` — "assume it changed" — right for a moving shader, wasteful for a static one whose params
   have not moved. `surfaceFx.ts` already solved this with a param-equality cache; consider it only
   after Phase 0 says whether it matters.
5. Does CodeMirror's `contenteditable` surface behave under the dockable workspace's direct style
   writes during a pane drag (`PersistentLayer` writes styles at pointer rate)? It is a normal docked
   panel, not a persistent viewport element, so it should — worth watching once, in the real app.
