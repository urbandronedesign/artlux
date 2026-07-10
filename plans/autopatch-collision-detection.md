# Auto-Patch Collision Detection & Locked-Range Reservation

> **Status:** Draft · **Lifts:** Tutorial Set #6 (Patch & Prove) — auto-patch silently overlapping locked manual addresses, plus the controller/output split-brain for un-bucketed fixtures · **Placement:** Core · **Risk:** Medium · **Breaking changes:** None required for the detector (UI-only); **Project-file behavior hazard** if reservation is enabled (addresses recompute differently on the next patch — no silent file migration, but saved-show addresses can move)

## 1. The limitation today

Verified against current code (line numbers re-checked, they had *not* drifted materially from the seed):

- **Locked rows are skipped but never reserved.** `src/renderer/services/addressing.ts:21-22` — `fixtures.map((f) => { if (f.patchLocked) return f; ... })`. A locked fixture is returned untouched and, critically, **the per-controller cursor is not advanced past its span**. The cursor (`cursors` map, `:14-19`) only advances for auto-patched fixtures at `:31-33` (`total = cur.channel + f.ledCount*cpp; cur.universe += floor(total/512); cur.channel = total%512`). Result: an auto-patched fixture can be packed *on top of* a locked fixture's manually chosen `universe/startAddress`. Nothing detects or prevents the overlap.
- **Packing math** (`addressing.ts:28-33`) confirmed: `cpp = f.channelsPerPixel ?? 4`, consumes `ledCount*cpp` channels, wraps at 512, may span universes. Correct in isolation — it simply has no awareness of locked occupants.
- **Controller/output split-brain.** `addressing.ts:23-25` buckets a fixture with no/invalid `controllerId` into `defaultControllerId` else `controllers[0]?.id` (`real`). For the **non-locked** path, `:34` writes `controllerId: real` back, so a "Global" fixture is silently re-homed onto `controllers[0]` and its address is computed against that controller's `startUniverse` cursor. But `Stage.tsx:359-364` resolves output as `f.controllerId ? controllerMap.get(...) : undefined`, falling through to the global `AppSettings` target when `controllerId` is undefined. The split-brain therefore fully manifests for a **`patchLocked` fixture with no `controllerId`**: it is *skipped* by auto-patch (so `controllerId` stays `undefined`), its address was authored by hand, yet Stage sends it to the **global Preferences IP** — while a sibling non-locked "Global" fixture gets forcibly bucketed into `controllers[0]` and sent to *that* controller's IP. Two rows the UI both label "Global" (`RoutingModal.tsx:112`) emit to different destinations.
- **The Routing UI shows a Span but cannot warn.** `RoutingModal.tsx:40-46` computes a per-fixture `span()` string (`${ch}ch · U0-U1`); the Span column is rendered at `:99,121`. Univ/Start inputs are `disabled={!locked}` (`:115-116`). There is **no overlap check** anywhere — `span()` is display-only and never compared across rows.

This forces the caveat in Tutorial Set #6 ("Patch & Prove"): the tuto must tell users to manually verify no two fixtures share channels, because the tool will happily double-book a universe and the DMX Monitor is the only place the clash surfaces (as garbled output).

## 2. What "lifted" looks like

**Detector (phase A, always on):** Routing modal computes absolute channel spans for every fixture *per resolved destination* and flags any pair whose `[startAbs, endAbs]` ranges intersect within the same destination. Overlapping rows get a visible marker (red Span text + a tooltip naming the colliding fixture) and a header count ("2 address conflicts"). Locked-vs-auto and auto-vs-auto overlaps are both caught.

**Reservation (phase B, opt-in):** `autoPatch` treats locked fixtures as occupied ranges and packs auto fixtures *around* them, so a fresh auto-patch produces zero overlaps by construction.

**Acceptance test (runnable):** a tuto fixture file with (a) a locked fixture at U0 ch 1, span 60ch, and (b) three auto fixtures on the same controller.
- *Detector:* before any fix, the Routing modal shows exactly one conflict (auto fixture #1 vs the locked one). Runnable in `npm run dev`.
- *Reservation:* click Auto-patch with reservation on → conflict count drops to 0; the locked fixture keeps U0/ch1; auto fixtures start at ch 61. Verify no channel double-write with `--headless --project=<file>` + a dgram listener parsing ArtDmx(0x5000) — each channel index is written by exactly one fixture.

## 3. Placement: core or plugin (REQUIRED)

**Recommendation: Core.** This is not optional behavior; it is a correctness fix to the address allocator (`renderer/services/addressing.ts`) and the routing editor, both of which are core, non-plugin surfaces. Per the doctrine "CORE STAYS CORE": patch addressing is the persisted-model plumbing (`Fixture.universe/startAddress/controllerId/patchLocked` all live in `renderer/types.ts`) that every output path depends on. A plugin cannot own the address allocator without the host importing plugin behavior into the per-frame output resolution in `Stage.tsx` — exactly the barrel/singleton coupling the doctrine warns against.

- **No new persisted field is required.** The detector is pure derivation from existing `Fixture` fields. Reservation is an algorithm change to an existing pure function. By the doctrine's own rule ("if it adds a persisted field, that field is core"), the *absence* of a new field keeps this cleanly out of migration territory — see §6.
- **Plugin/singleton hazard: N/A.** No plugin, no new singleton, no SDK surface. `autoPatch` is a stateless pure function; adding overlap logic keeps it stateless. Nothing to register, nothing to duplicate.
- **The only "policy" knob** (reserve locked ranges: on/off) belongs in `AppSettings` (prefs), which is core config, not a plugin contribution.

## 4. Design / approach

All changes are **renderer-only**. No main/preload/IPC/GPU/SDK changes.

**`src/renderer/services/addressing.ts` (renderer):**
- Add a pure helper, exported for reuse by the UI:
  ```ts
  export interface Span { fixtureId: string; destKey: string; startAbs: number; endAbs: number; }
  export function fixtureSpans(fixtures: Fixture[], controllers: Controller[], settings: AppSettings): Span[]
  export function findCollisions(spans: Span[]): Array<[string, string]> // fixtureId pairs, same destKey, overlapping
  ```
  `startAbs = universe*512 + (startAddress-1)`, `endAbs = startAbs + ledCount*cpp - 1`. `destKey` must be computed **identically to `Stage.tsx:360-365`**. ⚠️ **Precedence, corrected from the seed:** the actual order is **per-fixture `f.output` override → controller → global default** (`f.output?.protocol || ctrl?.protocol || defaultProtocol`, etc.), *not* controller-first. The wire key Stage builds is `` `${proto}|${ip}|${bcast?1:0}` `` — grouped by protocol/ip/broadcast, **not by controller id**. The detector must reproduce this exact three-way fallback (including `f.output`) or it will mis-group. Factor that resolution into a shared `resolveDest(f, ctrl, settings)` used by both the detector and Stage to guarantee parity (see §7 — this is the main regression risk).
- **Reservation (phase B):** change the loop to two passes. Pass 1: collect locked fixtures' `[startAbs,endAbs]` intervals per cursor key. Pass 2: when advancing a cursor for an auto fixture, if `[candidateStart, candidateEnd]` intersects a reserved interval, bump the cursor to the interval's end+1 and retry (loop until it fits). Guard against infinite loops (reserved intervals sorted; single forward scan). Gate behind `settings.reserveLockedRanges` (default **false** to preserve current addresses — see §5/§6).

**`src/renderer/components/RoutingModal.tsx` (renderer):**
- Compute `collisions` once via `findCollisions(fixtureSpans(...))` (memoized on `[fixtures, controllers, settings]`). ⚠️ **Hooks-order constraint:** `RoutingModal` early-returns `null` at `:38` (`if (!open) return null`). A `useMemo` **must be placed above that early return** (alongside the existing `useEffect :29` and `useDraggableModal :36`) or it becomes a conditional hook and violates the Rules of Hooks. Alternatively compute it as a plain `const` below the return — the modal only renders when open and `findCollisions` is cheap — but do **not** put a hook after `:38`.
- In the Fixtures grid (`:102-127`): if a fixture id is in a collision pair, render its `span()` text in a danger color and add `title="Overlaps <name>"`. Add a header conflict count near the Auto-patch button (`:61`).
- Requires threading `settings` (already a prop, `:13`) into the span cell; controllers/fixtures already in scope.

**`src/renderer/types.ts` (core config):**
- Add optional `reserveLockedRanges?: boolean` to `AppSettings` (not `Fixture` — it is a global patch policy, not per-fixture state). Optional ⇒ old prefs default to `false` ⇒ no behavior change until the user opts in.

**Split-brain fix (surgical, orthogonal to reservation):**
- The cleanest fix is to make `autoPatch` **not overwrite** a deliberately-Global fixture's `controllerId`. Change `addressing.ts:23-25/:34` so the `controllers[0]` fallback is used only for *cursor bucketing*, and `controllerId` is written back **only when the fixture already had a valid one** (or an explicit `defaultControllerId` was passed). This makes the address computation and the Stage output both agree on "Global ⇒ global target." This is a behavior change (see §5) and should ship with, or behind, the same opt-in as reservation, because it moves addresses for shows that relied on the implicit controllers[0] bucketing.

**Data flow:** `App.tsx` already calls `autoPatch(fixtures, controllers)` at `:475,481,492,495,507,512`; pass `settings` through so reservation can read `reserveLockedRanges` (widen the signature to `autoPatch(fixtures, controllers, settings?, defaultControllerId?)` — all call sites are in `App.tsx`, trivial to update).

**Parity:** the render path (`Stage.tsx` per-frame loop) is **not** modified for the detector. If the split-brain fix lands, `Stage.tsx:359-364` and the new `resolveDest` must be the *same* function — this is the only place WebGPU/WebGL/headless all converge, so a single source of truth is mandatory.

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

- **Detector alone: NONE.** Pure UI derivation, additive. No schema, no IPC, no SDK, no keybinding, no saved-file change. Proof: it reads existing `Fixture`/`Controller`/`AppSettings` fields and renders color/text; it writes nothing.

- **⚠️ Reservation: NO file-format break, but a REAL address-stability hazard.** Enabling `reserveLockedRanges` changes what `autoPatch` *produces*. Saved `.artlux` files are **not** re-patched on load (`App.tsx:800-803` loads `data.fixtures` verbatim, only resetting `colorData`/`surfaceId`), so **nothing changes silently on open**. BUT the next time any auto-patch trigger fires — `REPATCH_KEYS = ['ledCount','channelsPerPixel','controllerId','patchLocked']` (`App.tsx:487`), add/remove fixture, or the Auto-patch button — every non-locked fixture that used to pack *through* a locked range will jump to a new address. **Who breaks:** an operator whose physical rig is wired to the addresses a previous auto-patch produced; after one incidental edit their universes shift and the show goes dark/scrambled until re-uploaded to hardware. **Mitigation:** default `reserveLockedRanges = false`; ship reservation strictly opt-in with an explicit in-UI warning ("Auto-patch will re-address auto fixtures around locked ones"); consider a confirm dialog on first enable.

- **⚠️ Split-brain fix: behavior change for implicitly-bucketed shows.** Today a non-locked "Global" fixture gets `controllerId` rewritten to `controllers[0]` (`addressing.ts:34`) and thus emits to `controllers[0].ip`. If we stop overwriting, that same fixture reverts to the **global Preferences IP**, changing its wire destination. **Who breaks:** shows that (perhaps unknowingly) relied on the implicit re-homing to send "Global" fixtures to controller #0. **Mitigation:** gate behind the same opt-in, or provide a one-time "normalize routing" action that makes the implicit bucketing explicit (writes `controllerId` on all fixtures) before the semantics change.

- **`AppSettings.reserveLockedRanges`:** additive optional field. Old prefs load as `undefined ⇒ false`. No prefs break. Note it is **also serialized into the `.artlux` project file** (`AppSettings` is part of `buildProjectData`, `App.tsx:779`), so it becomes a new optional *project* key too — additive and back-compat-safe via the spread-merge load (`:805`), but this is why it counts as a persisted core field (Placement §3), not merely a runtime pref.

## 6. Migration & back-compat

- **No `.artlux` version bump needed.** No new persisted `Fixture`/`Controller` field. The only new persisted key is `AppSettings.reserveLockedRanges?`, optional, defaulting `false`. ⚠️ **Correction from the seed:** `AppSettings` has **no normalizer** — `normalizeTimeline`/`normalizeStateMachine` (`types.ts:351,370`) are for project sub-objects, not settings. Settings load via a plain spread merge over `DEFAULT_SETTINGS` (`App.tsx:805` `setSettings(prev => ({ ...prev, ...data.settings }))`; prefs restore at `:1553`). The correct precedent for an optional settings field is **`mp4WebCodecs?`** (`types.ts:412`), which is *not even present in `DEFAULT_SETTINGS` (`App.tsx:67-82`)* and is read defensively as `settings.mp4WebCodecs ?? false` (`App.tsx:1223`). Follow that exactly: leave it out of `DEFAULT_SETTINGS` (or add `reserveLockedRanges: false` there for clarity) and read it as `settings.reserveLockedRanges ?? false` at the `autoPatch` call site.
- **Old files:** load unchanged (`App.tsx:800-803` does not re-patch). Addresses are byte-stable on open regardless of this feature.
- **Forward compat:** an older app version opening a file saved by a newer one simply ignores `reserveLockedRanges`. ⚠️ **Correction from the seed:** the field does **not** live "in prefs, not the project" — `AppSettings` is persisted in **both** the on-disk prefs (`setPrefs({ appSettings, … })`, `App.tsx:1587`) **and** the `.artlux` project file (`buildProjectData().settings`, `App.tsx:779`, loaded via the same spread-merge at `:805`). Portability is nonetheless unaffected, but for the right reason: the field is *optional* and load is an additive spread merge (`{ ...prev, ...data.settings }`), so an older build silently drops the unknown key and a newer build defaults a missing key via `?? false`. No crash, no schema break, in either direction. Note the practical consequence: a project **saved** with `reserveLockedRanges: true` will carry that flag into whoever opens it — the pref travels with the show.
- **The honest caveat:** back-compat of the *file* is intact; back-compat of *auto-patch output* is deliberately broken when the user opts in. That is the whole point of the feature and must be surfaced, not hidden.

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius (grepped, not guessed):**
- `autoPatch` consumers — all in `App.tsx`: `:475` (add fixture), `:481` (remove), `:492` (repatch-on-update), `:495` (Auto-patch button), `:507` (controller startUniverse change), `:512` (controller removal). Widening the signature touches these six call sites only. `onAutoPatch` is plumbed through `FixtureEditor.tsx`, `RoutingModal.tsx`, `ScenePanel.tsx` but they all call the same `handleAutoPatch` — no signature change there.
- `Fixture` addressing fields (`patchLocked`, `startAddress`, `channelsPerPixel`, `controllerId`) are also read in `Stage.tsx`, `FixtureEditor.tsx`, `InspectorPanel.tsx`, `DMXMonitor.tsx` (from the grep). The detector reads them read-only; only the split-brain fix changes how `controllerId` is *written*, and its consumer of record is `Stage.tsx:359-364`.
- **Destination resolution is duplicated logic.** `Stage.tsx:359-365` computes `destKey` for the per-frame output; the detector must reproduce it exactly. If they diverge, the UI will report "no conflict" while hardware collides (or vice-versa). **This is the single highest-value thing to get right** — extract one `resolveDest`.

**Regression surface:**
- **WebGPU vs WebGL vs headless:** the detector does not touch the render path, so no parity risk from phase A. The split-brain fix touches `Stage.tsx` output resolution, which is shared by both mappers and the headless entry — must be validated on `--headless` (dgram listener) *and* in-app.
- **Per-frame perf:** zero. Detection runs in the modal on a memoized deps change, not in the frame loop.
- **Reservation algorithm:** the interval-skip loop must be provably terminating (sorted reserved intervals, monotonic forward cursor). A bug here could hang the patch on open of the Routing modal / on fixture add.
- **Singleton/projector/MessagePort:** untouched. No plugin, no IPC.

**Overall: Medium.** The detector is Low (additive, read-only). Reservation + split-brain push it to Medium because they change auto-patch output and the shared output-resolution logic. **Top 3 things most likely to break in practice:** (1) detector `destKey` drifting from `Stage.tsx` and mis-reporting; (2) an operator's rig silently re-addressed after enabling reservation and making an unrelated edit; (3) the reservation loop mis-handling a locked fixture that itself spans universes (its reserved interval crosses a 512 boundary).

## 8. Test / verification plan

Repo patterns (per doctrine, no unit runner):
- **`npx tsc -p tsconfig.json --noEmit`** — widened `autoPatch` signature + new exports compile clean across all six call sites.
- **`npm run dev` + exercise:** open Routing on the acceptance fixture (§2). Assert exactly one conflict badge with reservation off; assert Span turns danger-colored on the two overlapping rows; toggle reservation on, click Auto-patch, assert conflict count → 0 and the locked row's U0/ch1 unchanged.
- **`--headless --project=<fixture> ` + dgram listener** parsing ArtDmx(0x5000): build a per-channel writer-count map across all fixtures; assert max writer-count == 1 (no double-book) after reservation, and assert the un-bucketed "Global" fixture's frames arrive at the **global Preferences IP** (split-brain fixed), not `controllers[0].ip`.
- **Back-compat proof:** load an existing pre-feature `.artlux`, confirm addresses are byte-identical to before (no repatch on load), and that with reservation *off* a subsequent Auto-patch reproduces today's addresses exactly.
- Promote the §2 fixture into the tuto Set #6 acceptance set.

## 9. Effort & phasing

**Overall: M.** Detector is S (pure helper + a few RoutingModal cells). Reservation + split-brain is M (algorithm care, opt-in wiring, headless verification).

Rollout order:
1. **Phase A — detector (S), ship first, no flag.** Zero breaking risk; immediately removes the Set #6 caveat's manual-verification step by surfacing clashes.
2. **Phase B — reservation (M), behind `reserveLockedRanges` default off.** Ship with an in-UI warning; gather confidence before considering a default flip (likely never flip it silently).
3. **Phase C — split-brain fix,** behind the same opt-in or paired with a "normalize routing" action. Only after headless parity is confirmed.

## 10. Open questions / decision points

- **Should the split-brain fix ride with reservation or ship separately?** They are logically independent; coupling them simplifies the opt-in story but conflates two behavior changes in one flag.
- **Reserve semantics for a locked fixture that spans multiple universes** — reserve the exact `[startAbs,endAbs]` (correct) vs. whole-universe reservation (simpler, wastes channels). Recommend exact.
- **Should auto fixtures be allowed to fill *gaps before* a locked range** (best-fit) or only pack strictly forward past it (first-fit)? First-fit is simpler and deterministic; best-fit reduces fragmentation but is harder to reason about. Recommend first-fit.
- **Do we ever want a hard block** (refuse to save / warn on engine start) when conflicts exist, or is the visual detector enough? A blocking gate is a UX/keybinding-contract decision for a human.
- **Is `controllers[0]` implicit bucketing relied upon by any existing shipped tuto/show?** Must audit the example `.artlux` fixtures before changing the write-back, or the tuto acceptance set itself may shift addresses.

**Reviewer corrections (adversarial pass, grounded in code):**
- **destKey precedence was inverted** (§4). Stage resolves **`f.output` override → controller → global**, keyed by `` `${proto}|${ip}|${bcast?1:0}` `` (`Stage.tsx:360-365`), not "controller → override → global." The detector's `resolveDest` must include `f.output` or parity fails — corrected.
- **"Field lives in prefs, not the project" was false** (§6). `AppSettings` is persisted in the `.artlux` project file (`buildProjectData:779`, load `:805`) as well as prefs (`setPrefs:1587`). Portability conclusion stands, but the reasoning was rewritten to the real one (optional key + additive spread merge).
- **Migration precedent was mismatched** (§6). `AppSettings` has no normalizer; `normalizeTimeline/StateMachine` don't apply. The real precedent is optional `mp4WebCodecs` read as `?? false` — corrected.
- **Hooks-order hazard added** (§4): `RoutingModal` early-returns at `:38`, so the collision `useMemo` must sit above it or be a plain const. The seed omitted this; it would crash React if implemented naively.
- **Verified sound as drafted:** the split-brain claim (locked no-`controllerId` fixture → global IP vs. auto "Global" fixture forcibly bucketed to `controllers[0]`, `addressing.ts:34` / `Stage.tsx:359`), the six `autoPatch` call sites (`App.tsx:475,481,492,495,507,512`), `REPATCH_KEYS` (`:487`), the no-repatch-on-load path (`:800-803`), and the read-only nature of the detector all check out. `controllerId` is only read in `Stage.tsx:359` + `RoutingModal.tsx:111` + `App.tsx:512` — no missed write-consumer.
