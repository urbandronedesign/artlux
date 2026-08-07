# Take recording — out of the timeline, into the workbench and the library

> **Status:** ✅ **BUILT and PUSHED** — branch `take-recording` (2026-08-06/07, off `main@5a44124`),
> on `origin` at `66dc0dd`. **Not merged.** Verified in the running app against the live LiDAR emitter.
> **The guide's screenshots are deliberately NOT re-captured on this branch** — see §7.

Not a limitation-lift plan and it carries no §1–§10 template: this is the record of a change that was
scoped, built and verified in one session, written down because three of its findings outlive it.

---

## 1. What was wrong, and the diagnosis that mattered

Recording a take — LiDAR blobs, or a busk of the moving heads — lived in a 40 px strip under the
timeline toolbar (`TakesBin.tsx`), reachable only by pulling the drawer up with `Ctrl+T`. In
Calibration and Preferences, which declare no `bottom`, it could not be reached **at all**.

Both recorders are **transport-independent** and say so in their own headers. So the drawer was never
the reason they lived there. **The COMMIT was.** `Timeline.tsx` owned the naming, the `.lblob` write,
the doc-key guard across two awaits, the replay-cache seed and the auto-created lane — so the button
had to be wherever that function was.

> `docs/ROADMAP.md` had recorded the opposite: *"TakesBin (tightly timeline-**engine**-coupled … inverting
> it would over-fit the SDK)"*, under **Left core on purpose**. Both halves were wrong. The recorders
> never touched the engine, and the only SDK addition was `ContextAction.live`, which is generic. The
> lesson is the transferable part and is now written into ROADMAP beside the original claim:
> **"too coupled to invert" was a claim about a FILE, and the real coupling was one function that could
> simply be moved.**

## 2. What shipped

| Commit | |
|---|---|
| `d5e58c6` | recording leaves the timeline for two dock panels |
| `6df1dcd` | a recorded LiDAR take belongs to the project, not to the scene that was on air |
| `092a760` | deleting a take from the library sweeps every timeline |

- **`services/takeRecorder.ts`** — the one owner of both commits, with an App-installed host binding
  (`setHost`, the `frameEngine.setHost` idiom). Every door calls it: two dock panels, two action-bar
  buttons, the status chip, two shortcuts.
- **Two dock panels**, `core.dock.lightingTakes` (in `3d` + `scenes`) and `core.dock.trackingTakes`
  (in `3d` + `show`) — `contexts/panels/takes.tsx`.
- **`ContextAction.live`** (SDK) — run-time state on a bar button: REC + an elapsed clock written to a
  DOM ref, never through React. Plus **`.stayPut`**, so arming from `Ctrl+K` no longer teleports the
  workbench.
- **A REC chip in the StatusBar** — the only surface besides the menu bar that renders in *every*
  context. It names the destination and is a `<button>` that stops everything.
- **`Ctrl+Shift+R` / `Ctrl+Alt+R`**, global scope.
- **A tracking take is a PROJECT asset** — its ref goes to the **global** document, so it appears in
  the Media Library and drops onto **any** timeline. Migration hoists stranded scene-local takes on
  open.
- `TakesBin.tsx` **deleted**.

## 3. The two decisions worth re-reading before changing this

**Two panels, not one.** The recorders are different instruments and `TakesBin` papered over it — its
own header comment described only the tracking half, because the lighting controls were bolted into the
same strip afterwards. A lighting take is scoped to the **selected lights** and *their order is the
show*; a tracking take has no target at all. One panel needs an "arm" line that is meaningful for half
of it.

**A LiDAR take is captured REALITY; a lighting take is authored PERFORMANCE.** That single sentence
settles where each lives, and it is the answer to give if anyone asks why they behave differently:

| | LiDAR take | Lighting take |
|---|---|---|
| what it is | a recording of what the venue did | a busk of *these* heads in *this* look |
| stored as | a `.lblob` on disk + a ref | inline, keyframe-fitted |
| lives on | the **global** doc = the project library | the timeline it was recorded against |
| reusable by | every scene | the scene it belongs to (`Capture Scene` clones it) |

Documented for the operator in `docs/LIGHTING-SHOW.md` ▸ *"A lighting take belongs to ONE timeline — and
a LiDAR take does not"*, and the Lighting Takes panel names the document its list belongs to, so the
asymmetry is met before it costs anything.

**Rejected:** migrating takes into `ProjectData.assets`. It is arguably the cleaner model and literally
"in my media library", but it changes the persisted project shape, needs a migration for every existing
project, and contradicts a documented decision in `TRACKING_TAKES.md`. Putting the ref on the global doc
needed **no** migration of the file format and made three existing comments true instead of aspirational.

## 4. What only RUNNING it found — eight defects, none of which a typechecker sees

1. **`record-take` disabled itself MID-TAKE.** Its `enabled()` asked for a fixture selection and nothing
   ever re-ran it, so clicking empty space in the 3D scene turned off the only stop button while capture
   continued. `live.enabled` wins while recording.
2. **Every refusal was a `console.warn` nobody saw.** Mandatory to fix once a shortcut can arm from a
   workspace with no visible record button.
3. **A tracking stop with zero frames returned silently** — the "no tracker connected" case, which is
   how most people meet it.
4. **The lighting doors offered work they cannot do.** A take is built from the resolved ROLE signal,
   which only a moving head has, so selecting six LED strips promised *"6 fixtures"* and returned
   nothing. Fixed in the **host binding**, so the shortcut cannot arm what the bar and panel refuse —
   and it also stops empty parts shifting every real one along and misaligning the phase spread.
5. **The REC chip's destination was frozen at arm time.** It only re-renders on start/stop, and the
   bound document is exactly what moves while you are not looking. Observed live: armed against
   "Scene 1", the FSM stepped to "Scene 2", the take went with it, the chip still said Scene 1.
6. **A take recorded while a scene was bound was invisible to the Media library** and unplaceable
   anywhere else — the whole of §2's third commit.
7. **Deleting a take swept only the global doc**, leaving scene clips pointing at a recording that no
   longer exists: a clip that can neither play nor be relinked, because there is nothing to relink to.
8. **The delete confirm lied.** One message for both branches — *"leaves those references reading as
   missing (recoverable)"* — while the take branch deletes placements outright.

## 5. Guards added (`npm run verify` — 124 checks)

- **the take commit has exactly one owner** — the append must go through `commitGlobal` (the library is
  the global doc), and a doc-key guard must still span the two awaits. It caught its own author twice
  during this work.
- **the lidar plugin is imported through its barrel only** — `tsconfig.json` **and**
  `electron.vite.config.ts` both alias the `/*` subpath, so a deep import typechecks, builds, runs and
  silently forks `trackingStore`. Nothing guarded it before.
- **removing and relinking a library asset reach the scenes** — this is the **second** time that bug
  shape shipped in that one function; the relink comment already records the first.
- `shellSignature()` now hashes `ActionBar.tsx` + `StatusBar.tsx`. It was blind to both, despite their
  being in every screenshot in the guide.

## 6. Verified how

`npm run verify` green, then the running app with `scripts/lidar-emitter.cjs` feeding port 10000 and OSC
input enabled through `window.artlux.configureOsc`:

- both panels render in their contexts; `3d`'s dock is **eight tabs** (worth an eye at 1280 px)
- REC agrees across the action bar, the panel and the status chip; the clock ticks
- **deselect mid-take and the stop is still clickable** (defect 1)
- refusals arrive as toasts, including from `Ctrl+Shift+R` on a rig with no moving heads
- a real take commits with its auto-created `Tracking` lane and its density sparkline
- **`Ctrl+Alt+R` arms from Preferences** — the reachability the whole move exists for
- recorded with Scene 1 bound → chip read `REC tracking → Media library` → the take appeared in
  **Media Library** → a **real drag-and-drop** (CDP drag interception) placed it on a scene lane whose
  own `trackingTakes` is empty, so the payload fallback is what resolved it
- deleted through the media panel's own `Remove from library` → confirm read *"Its 3 placements will be
  removed from every timeline and scene"* → the scene's lane came back empty

## 7. Not done

- **`npm run docs:capture` — deliberately NOT on this branch** (owner's call). The guide's screenshots
  still show the Takes bin, and `verify:docs` will keep saying so on every run until someone re-shoots
  them. That warning is **working as designed, not waiting on this branch**:
  `scripts/lib/shell-signature.cjs` says in its own header that it *"REPORTS rather than fails: a
  one-line CSS change in the shell should make the screenshots suspect, not block a merge behind a
  three-minute app run."*

  Three reasons it does not belong here. `docs:capture` **re-shoots the whole guide in one pass**, so it
  would land ~18 rewritten PNGs on a code branch, most of them unrelated to takes. The shell will move
  again before this merges, and a re-capture is only worth its diff once. And the harness **leaks the
  machine's LAN IP and the tablet PIN into the images** without `redactPrivate()` — a real hazard on a
  public repo, and a reason to run it deliberately rather than as a branch chore.

  ⇒ **Re-capture on `main` after this merges**, as its own commit. Until then the stale pictures are
  measured and announced, which is exactly what the signature exists for.
- **`host.takes`.** `TrackingTakesDock` is registered **host-side** even though the recorder belongs to
  the lidar plugin, because no SDK service can write a timeline — `RendererHostServices` has ten
  services and `ShowService` is read-mostly with two narrow writers. That is the next extraction, in the
  shape `show-control` set with `host.show`. Recorded in `docs/ROADMAP.md` and `docs/PLUGINS.md`.
- **Deleting a take does not delete its `.lblob`** from `assets/tracking/`. Consistent with every other
  asset type; call it out if that is not wanted.
- **Lighting takes stay per-scene** — deliberate (§3), not an omission.

## 8. Harness notes (this cost real time; read before driving the shell over CDP)

- **`ELECTRON_RUN_AS_NODE=1` is set in this environment.** `npm run dev` dies with
  `Cannot read properties of undefined (reading 'getVersion')` until you `Remove-Item Env:ELECTRON_RUN_AS_NODE`.
- **HMR breaks a `setHost` service.** Editing `services/takeRecorder.ts` reloads the module with a fresh
  `host = null` while App's `[]`-deps install effect does **not** re-run, so every call silently no-ops.
  Restart the app after touching a host-bound singleton; do not debug the symptom.
- **`page.mouse.drop()` leaves the left button down.** Every later `page.mouse.click` throws
  `'left' is already pressed`. Call `page.mouse.up()` after a drop, and `setDragInterception(false)` in
  a `finally` — a killed probe leaves interception armed and the next run's clicks vanish.
- **Selectors that bit:** the rail is labelled by `shortTitle` text (`3D`, `Cues`), not `title`; the
  action bar is the `h-8` strip carrying `Save Project` (`div.h-8.shrink-0` is the *menu* bar); dock tabs
  are not `<button>`s; the scene pill is a custom dropdown whose rows read `Scene 3` + `2 clips` in
  separate nodes, so `textContent` concatenates to `Scene 32 clips`.
- ⚠ **Never automate a fuzzy selector onto a destructive control.** A `/remove|delete/i` match over
  `title`/`aria-label` found a **scene delete** and opened *"Delete scene Scene 1?"* against the
  operator's live project. It was cancelled and nothing was lost. The media panel's own control is
  `button[title="Remove from library"]` — target the exact one, and close the app without saving after a
  destructive test so the on-disk project is untouched.
