# DMX I/O Fidelity: channelsPerPixel-correct Monitor + configurable DMX-in universes

> **Status:** Draft · **Lifts:** Tutorial Set #6 (Patch & Prove) — the DMX Monitor's hardcoded x4 channels/pixel (wrong for 3-channel fixtures) and the DMX-in loopback's hardcoded universe range (an sACN back rig on universe 8 is invisible) · **Placement:** Core (renderer wiring only; no persisted field required) · **Risk:** Low · **Breaking changes:** None (UI-only math fix + a better-computed value for an already-existing IPC field)

## 1. The limitation today

Two independent defects, both pure implementation gaps (no physics/OS constraint):

**(a) DMX Monitor hardcodes 4 channels/pixel.** `src/renderer/components/DMXMonitor.tsx`:
- Line 84: `channels = fixtures.reduce((acc, f) => acc + f.ledCount * 4, 0)` — the "Channels" stat.
- Line 88 and line 120: `endAbs = startAbs + f.ledCount * 4 - 1` — used to compute the touched-universe count (line 89, the "Universes" stat) and the per-fixture `U:` span badge (lines 121–123).

Every one of these assumes RGBW/4 channels per pixel. The rest of the app is `channelsPerPixel`-aware and defaults to 4 only when unset:
- `src/renderer/components/RoutingModal.tsx:41` — `const ch = f.ledCount * (f.channelsPerPixel ?? 4)` (the authoritative Routing "Span" column).
- `src/renderer/services/addressing.ts:28,31` — auto-patch consumes `ledCount * (channelsPerPixel ?? 4)` channels and wraps at 512.
- `src/renderer/components/Stage.tsx:387,404–416` — the packer writes 3 channels/pixel when `cpp === 3` (line 413 only writes the W channel when `cpp === 4`).

Result: for a 3-channel fixture the Monitor over-reports channel count by 33% and can display a spurious extra universe in the `U:` badge, directly contradicting the Routing Span shown one panel over. This is the exact "the numbers don't agree" caveat Set #6 has to warn about.

Note (state it, don't change it): the Monitor's live pixel *canvas* indexing is **correct** and must stay `*4`. `DMXMonitor.tsx:29–44` reads `packet.pixels`, which `dmxSignal` documents as a "Raw RGBW linear buffer (canonical)" (`src/renderer/services/dmxSignal.ts:13`) and `Stage.tsx:404–416,420` always packs at 4 bytes/pixel via `offset++` per LED regardless of `cpp`. So `offsetRef.current * 4` (line 30) and `fixture.ledCount * 4` (line 31), plus `fixtureOffsets` accumulating by `ledCount` (line 97), all index the canonical buffer correctly. Only the *wire-footprint* math (stats + span badge) is wrong. The W-fold-back (lines 37–44) that reconstitutes white for the preview is also fine.

**(b) DMX-in loopback only listens on a hardcoded universe set.** `src/renderer/services/contentSource.ts:121–127` — `reconcileDmx()` auto-enables the receiver when any `DMX_IN` consumer exists and calls `window.artlux.configureInput({ enabled: true, protocol: 'both', universes: [0,1,2,3,4,5,6,7] })` (line 125), hardcoded. Main-side (`src/main/transport/input.ts:54–66`) only joins sACN E1.31 multicast groups `239.255.x.x` for those universes; the fallback when the list is empty is `[0,1,2,3]` (line 62 — the seed's "[0..7]" was a drift; verify: it is `[0, 1, 2, 3]`). A back rig on sACN universe 8 is never joined, so its frames never arrive — the loopback mirror shows nothing.

Scope nuance that shrinks the blast radius: the hardcoded range **only** limits **sACN**. Art-Net is received on a plain UDP bind to port 6454 (`input.ts:44–51`) with no per-universe membership, so Art-Net universe 8 already works. The bug is sACN-only.

Second nuance: `input:frame` is delivered only to the main editor window (`src/main/ipc.ts:52–56`, `getWindow()?.webContents.send(IPC.INPUT_FRAME, ...)`). The projector BrowserWindow never receives DMX-in frames, so in practice DMX-in is an editor-only source today. That bounds where the fix has to work.

## 2. What "lifted" looks like

**(a)** In the Monitor, a fixture with `channelsPerPixel: 3` and `ledCount: 60` reports **180** channels (not 240), its `U:` badge matches the Routing modal's Span, and the "Universes" total counts only genuinely-touched universes. RGBW (4) fixtures are byte-identical to today.

**(b)** With a fixture patched to sACN universe 8 and a `DMX_IN` surface active, incoming E1.31 frames on universe 8 reach `getInputCanvas()` and drive the surface. The set of joined universes is derived from the union of all patched fixtures' universe spans (loopback = "mirror my own rig"), so it tracks the project automatically.

Acceptance test (runnable, extends the Set #6 fixture):
1. `examples/state-machine/*.artlux` already carry `channelsPerPixel: 3` fixtures. Open one, open Routing and the Monitor side by side — the Channels/Span numbers now agree for every 3-channel fixture. (Regression check: an RGBW fixture is unchanged.)
2. Add/patch a fixture to universe 8 (sACN controller), add a `DMX_IN` surface. Run `--headless` is not applicable (DMX-in is a UI content source), so: `npm run dev`, then emit an sACN packet for universe 8 (a 5-line dgram sender to `239.255.0.8:5568`, or a lighting console). The DMX-in surface lights up. Before the fix it stays black.

## 3. Placement: core or plugin (REQUIRED)

**Core.** Justification against the doctrine:

- **(a)** is a correction to a first-party monitoring component (`DMXMonitor.tsx`) that reads a first-party enum field (`Fixture.channelsPerPixel`, `renderer/types.ts:85`). It is display math, not swappable behavior — there is no contribution surface here and inventing one would be over-engineering. Core.
- **(b)** touches the built-in shared DMX-in receiver, which the module comment in `contentSource.ts:8–12` explicitly lists as a **core** singleton ("built-in live receivers (camera / DMX-in) are shared single-instance singletons"), in contrast to Spout/NDI/TRACKING which were deliberately moved to plugins. Moving DMX-in out is out of scope and unrelated to this limitation.
- **No persisted field is added** under the primary (derive-from-fixtures) approach, so the "persisted field is core by rule" clause does not bite. If a human later chooses the explicit-setting alternative (§10), that setting **would** be a persisted `AppSettings` field and is **core by rule** — it may not live in a plugin.
- **Barrel/singleton hazard:** not triggered. No new plugin, no new npm-package singleton, no mixing of alias + relative imports. `reconcileDmx` remains a private function in the existing `contentSource` module singleton; we add at most one setter beside it in the same file.

## 4. Design / approach

### Fix (a) — Monitor honors `channelsPerPixel` (renderer, UI-only)

`src/renderer/components/DMXMonitor.tsx` — introduce the same `cpp` the rest of the app uses and swap the three `* 4` wire-footprint sites (leave the canvas `* 4` sites untouched):

- Line 84 (stats reduce): `acc + f.ledCount * (f.channelsPerPixel ?? 4)`.
- Line 88 (touched-universe scan): `startAbs + f.ledCount * (f.channelsPerPixel ?? 4) - 1`.
- Line 120 (per-fixture badge): `startAbs + f.ledCount * (f.channelsPerPixel ?? 4) - 1`.

Optionally factor `const wireChannels = (f: Fixture) => f.ledCount * (f.channelsPerPixel ?? 4)` to keep the three sites in lockstep with `RoutingModal.span()` and `addressing.ts`. **Do not** touch lines 30–31, 44, or 97 (canonical-buffer indexing).

### Fix (b) — DMX-in universes derived from patched fixtures (renderer wiring)

The `universes: number[]` field on `InputConfig` (`shared/protocol.ts:246–250`) already exists and already flows preload → IPC → main. We only need to compute a good value and re-apply it when it changes.

1. **`src/renderer/services/contentSource.ts`** — add module state + a setter, and make `reconcileDmx` use it:
   ```ts
   let dmxUniverses: number[] = [0,1,2,3,4,5,6,7]; // fallback until fixtures report in
   export function setDmxInputUniverses(universes: number[]): void {
     const next = universes.length ? Array.from(new Set(universes)).sort((a,b)=>a-b) : [0,1,2,3,4,5,6,7];
     if (next.length === dmxUniverses.length && next.every((u,i)=>u===dmxUniverses[i])) return;
     dmxUniverses = next;
     if (dmxActive) window.artlux?.configureInput?.({ enabled: true, protocol: 'both', universes: dmxUniverses }); // re-join live
   }
   ```
   In `reconcileDmx` (line 125) replace the literal with `universes: dmxUniverses`.
2. **`src/renderer/components/Stage.tsx`** — Stage already owns `fixtures` and the universe-span math. Add a `useEffect` (next to the `syncSurfaces` effect at line 93) that computes the union of every fixture's touched universes (same loop as `DMXMonitor` lines 87–89, `cpp`-aware) and calls `contentSource.setDmxInputUniverses(...)`, keyed on `[fixtures]`. This keeps the derivation in the one component that already re-runs on patch changes.
3. **`src/main/transport/input.ts`** — no change required functionally, but consider re-joining membership on reconfigure. `configureInput` already calls `stop()` first (line 38) which closes and recreates `sacnSock`, so a new `universes` list is honored on every call. Verify `stop()`/rebind has no race under rapid patch edits; the ~33 ms flush timer and socket rebind are cheap. (Optional hardening: debounce the Stage effect by a frame.)

Data flow: `patch edit → Stage effect → contentSource.setDmxInputUniverses → (if active) configureInput IPC → main input.configureInput → stop()+rebind sACN sock joining new groups`.

No WebGPU/WebGL path is touched (this is I/O + a monitor readout, not the mapper). No parity concern.

### Explicitly out of scope

- `dmxInput.ts:28` `PX_PER_UNIVERSE = 170` (RGB-triple visualization of incoming DMX) is unrelated to both defects — leave it.
- Making the projector window receive DMX-in frames (`ipc.ts:54` main-window-only) is a separate latent gap; note in §10, do not fix here.

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**None. Proven surface by surface:**

- **Persisted `.artlux` schema:** unchanged. No new/renamed/removed field. `channelsPerPixel` already exists (`types.ts:85`) and is already written by `App.tsx:750,762` and present in the example fixtures. Old files load identically.
- **`shared/protocol.ts` IPC contract:** unchanged. `InputConfig.universes: number[]` (line 249) already exists; we send a different *value*, not a different *shape*. `IPC.INPUT_CONFIGURE` / `IPC.INPUT_FRAME`, `configureInput`/`onDmxInput` (`protocol.ts:645–646`, `preload/index.ts:23–25`) are untouched.
- **`@artlux/sdk` surface:** untouched. No SDK type re-exported or changed. `setDmxInputUniverses` is an internal renderer function, not exported from any package barrel.
- **Saved prefs / `AppSettings`:** untouched under the primary approach (no new field). ⚠️ **If** the explicit-setting alternative is chosen instead (§10), that adds an optional `AppSettings` field — additive + `?`-optional + normalized default, still non-breaking, but it becomes a **core persisted field by rule**.
- **Plugin contracts / registries:** untouched. `contentSourceRegistry` and the Spout/NDI/TRACKING providers are not involved.
- **Keybindings / UI contracts:** the Monitor's displayed numbers change for 3-channel fixtures — that is the *intended* correction, not a regression. RGBW fixtures render byte-identical.

## 6. Migration & back-compat

No migration needed. No `normalize*()` change, no schema version bump. Both fixes read `channelsPerPixel ?? 4`, so any fixture that predates the field (or omits it) behaves exactly as today (4 channels). Forward/backward: a file saved by the new build is indistinguishable from one saved by the old build (no bytes changed by these fixes), so it opens on any app version.

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius — every consumer of what we touch (grepped, not guessed):**

- **`DMXMonitor.tsx`** is imported/rendered only at `App.tsx:26,1832`. The change is internal to `useMemo`/render math; no props/exports change. Blast radius = this one panel.
- **`Fixture.channelsPerPixel`** consumers (unchanged contract, we only start reading it in one more place): `RoutingModal.tsx:41,117`, `addressing.ts:28`, `Stage.tsx:387`, `FixtureEditor.tsx:67,191`, `InspectorPanel.tsx:275–284`, `App.tsx:487,750,762`, `FixtureTemplate` (`types.ts:517`). We add a read; we mutate none of them.
- **`InputConfig` / `configureInput` / `INPUT_CONFIGURE`** consumers: renderer `contentSource.ts:125` (the site we edit), preload `index.ts:23`, main `ipc.ts:52` → `input.ts:36`. That is the entire chain — no other caller constructs an `InputConfig`. We change one argument value and add one setter.
- **`setDmxInputUniverses`** (new): one caller (`Stage.tsx`). No other module.
- **`dmxSignal.publish`** (canonical buffer): produced only at `Stage.tsx:420`; consumed by `DMXMonitor.tsx:28` and the 3D sim. We do **not** change the buffer or its indexing, so these consumers are untouched.

**Regression surface:**
- WebGPU vs WebGL: **not touched** — no mapper/WGSL/GPUMapper change. Zero parity risk.
- Per-frame perf: **negligible.** The Stage effect runs on `fixtures` change, not per frame; `configureInput` only re-fires when the derived universe set actually changes (guarded by the equality check in the setter).
- Singleton duplication: **none** — no new package/plugin; the setter lives in the existing `contentSource` singleton.
- Projector MessagePort bridge: **`DMX_IN` is a `STREAMED` (not `SELF_RENDER`) surface type on the projector (`ProjectorApp.tsx:19–20,130`)** — a DMX-in surface is rendered by the *editor* and mirrored over the frame port, so `ProjectorApp` passes `[]` to `syncSurfaces` for it (line 130: `self ? [m.surface] : []`) and **never acquires a `DMX_IN` consumer**. It therefore never reaches `reconcileDmx`→`configureInput` for DMX at all. Consequence: there is **no** cross-process `configureInput` contention — the editor window is the *sole* caller in practice, so `dmxUniverses` derivation lives only where the fixtures do. (Independently reinforcing this: DMX-in frames are main-window-only, `ipc.ts:54`.) Behavior there is unchanged from today. (The generic "last writer to main wins" caveat for `configureInput` is moot here because only one process ever calls it for DMX.)
- Headless entry: DMX-in is a UI content source; headless doesn't composite surfaces — unaffected.

**Overall risk: Low.** Top things most likely to break in practice:
1. **sACN socket rebind churn.** Every `configureInput` does `stop()`+recreate the socket (`input.ts:38,54–66`). Rapid patch edits could thrash the bind. Mitigation: the setter's equality guard + an optional one-frame debounce in the Stage effect.
2. **Over-joining universes.** A project with fixtures scattered across universes 0 and 200 would `addMembership` for a sparse set — harmless (each is a cheap multicast join) but verify no per-universe cost blows up for pathological patches; cap or coalesce if needed.
3. **Someone "fixes" the canvas `*4` too.** The correct-by-design canonical-buffer indexing (lines 30–31) looks like the same bug as the stats. A reviewer must be told (and a code comment added) that those stay `*4`.

## 8. Test / verification plan

Repo patterns (`docs/DEVELOPMENT.md`):
- **`npx tsc -p tsconfig.json --noEmit`** — types clean (new setter + Stage effect).
- **`npm run dev` + exercise (fix a):** open an `examples/state-machine/*.artlux` (has `cpp:3` fixtures), place Routing modal next to the Monitor dock — assert Channels total and every `U:` badge equal the Routing Span column. Flip a fixture to RGBW(4) and confirm the number matches `ledCount*4` (unchanged path).
- **`npm run dev` + sACN emitter (fix b):** patch a fixture to universe 8 on an sACN controller, add a `DMX_IN` surface, send an E1.31 packet to `239.255.0.8:5568` (small dgram script; the E1.31 layout parsed at `input.ts:26–34` — universe at byte 113, DMX from byte 126). Surface lights up. Remove the universe-8 fixture → derivation drops the join → surface goes dark again. Baseline: on the pre-fix build the surface never lights for universe 8.
- **Regression:** confirm Art-Net universe 8 already worked before and still does (unaffected by the sACN membership change). Confirm the 3D sim / canonical preview are byte-identical (we didn't touch the buffer).

## 9. Effort & phasing

**Size: S.** Fix (a) is ~3 line edits in one file. Fix (b) is a ~10-line setter + one `useEffect`, no schema/IPC/SDK/migration work.

Safe rollout order:
1. Land fix (a) alone (UI-only, zero I/O risk) — it resolves half the Set #6 caveat immediately and is trivially reviewable.
2. Land fix (b) behind the existing fallback: if `setDmxInputUniverses` is never wired, `reconcileDmx` still uses the `[0..7]` default, so the setter can be merged before the Stage wiring with no behavior change. Wire Stage last.
No feature flag/setting is warranted for Low-risk correctness work; the fallback array is the safety net.

## 10. Open questions / decision points

1. **Derive-from-fixtures vs explicit setting.** Primary recommendation: derive (zero persisted field, self-tracking, non-breaking). But derivation means "loopback mirrors my own rig" — it will **not** join a universe that no fixture is patched to. If the workflow is "monitor an *external* console on arbitrary universes unrelated to my patch," an explicit `AppSettings.dmxInputUniverses?: number[]` (core persisted field, additive/optional, normalized default `[0..7]`) is the right call. **A human must pick the semantics.** Hybrid is possible (derive ∪ explicit override).
2. **Should the join include universes beyond fixtures?** E.g. always also join `[0..7]` so casual senders on low universes keep working even without matching fixtures. Cheap; decide whether to union the derived set with the legacy default.
3. **Projector DMX-in (out of scope but adjacent):** `input:frame` is main-window-only (`ipc.ts:54`). If DMX-in-on-projector is ever wanted, main must fan `INPUT_FRAME` to all windows and the projector needs a universe source (it has no fixtures). Not part of this plan — flag for a separate ticket.
4. **Membership churn cap.** Do we need to debounce/limit `configureInput` re-fires on live patch editing, or is the setter's equality guard sufficient? Likely sufficient; confirm during dev exercise.

**Reviewer rebuttals (corrections to the draft, verified against code):**
- The draft's §7 projector bullet claimed the projector "could still call `reconcileDmx`" and that "its `dmxUniverses` stays the fallback," implying the projector emits a competing `configureInput` with `[0..7]`. **Wrong mechanism.** `DMX_IN ∈ STREAMED` and `∉ SELF_RENDER` (`ProjectorApp.tsx:19–20`), so `ProjectorApp` hands `[]` to `syncSurfaces` for a DMX-in surface (line 130) — the projector never acquires a DMX-in consumer and never calls `configureInput` for DMX. There is thus a single `configureInput` writer (the editor) in practice; the "last-writer-wins" watch item was a non-issue and has been removed. Correction is in the safe direction (fewer moving parts), so Placement/Risk/Breaking are unchanged.
