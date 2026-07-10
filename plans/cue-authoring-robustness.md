# Cue-Authoring Robustness: array-safe param writes + per-entry fade/transition UI

> **Status:** Draft · **Lifts:** Tutorial Set #4 (Cue Deck) — capturing/authoring a cue on a fixture with no `segments[]` silently corrupts the fixture, and per-entry `fadeSec`/`transition` overrides are JSON-only with no Edit-mode UI · **Placement:** Core · **Risk:** Low · **Breaking changes:** None (both are internal-behavior + additive-UI; the two `CueEntry` fields already exist)

## 1. The limitation today

Two independent defects in the same authoring path.

**(a) `setIn` corrupts array parameters when the array is absent.**
`setIn` (`src/renderer/services/paramPath.ts:84-96`) is the copy-on-write nested setter behind `setByPath` (`:67-81`). It only takes the array branch when the *current* container is **already** an array (`Array.isArray(obj)`, `:88`). When the container is missing it falls to the object branch (`:93-95`) and writes a **string numeric key** into a plain object:

```
setByPath(view, 'fixtures.<id>.segments.0.speed', 0.5)
  → setIn(fixture, ['segments','0','speed'], 0.5)
    → copy['segments'] = setIn( fixture.segments ?? {} , ['0','speed'], 0.5)   // segments absent ⇒ {}
      → copy['0']     = setIn( {} , ['speed'], 0.5)  ⇒  { speed: 0.5 }
  ⇒ fixture.segments === { "0": { speed: 0.5 } }     // a PLAIN OBJECT, not an array
```

Downstream consequences of that non-array `segments`:
- `WebGPUMapper.fixtureSegments` (`src/renderer/gpu/WebGPUMapper.ts:149-152`) tests `f.segments && f.segments.length`; `{"0":…}.length` is `undefined` → falls back to the implicit whole-fixture segment. The authored value is silently **ignored**, and the bogus object is now persisted.
- `Stage.tsx` change-detection does `f.segments ? f.segments.map(…)` (`src/renderer/components/Stage.tsx:203` and `:222`). A plain object is truthy but has **no `.map`** → **`TypeError` on the next render hash** → the Stage pump throws. This is a real crash vector, not just dead data.
- `collectFadeableTargets` (`paramPath.ts:159`) and `InspectorPanel.tsx:118` (`hasSegs = !!(segs && segs.length)`) **both guard on `.length`**, exactly like the mapper — so a non-array `segments` degrades to the whole-fixture branch (its `segs!.map` at `InspectorPanel.tsx:131` sits *behind* that guard and is never reached). These are **silent-ignore**, not crash, sites. **The sole hard-crash vector is `Stage.tsx:203`/`:222`**, which gate `.map` on truthiness alone (`f.segments ? f.segments.map(…)`) with **no `.length` check** → a truthy `{"0":…}` object hits `.map` → `TypeError` in the layout-signature `useMemo` that runs every render.

**Reachability (important, and it lowers the *real-world* severity):** the Edit-mode capture picker `fixtureParams` (`paramPath.ts:126-135`) exposes **only** `x/y/width/height/rotation` — it does **not** expose `speed`, `intensity`, or any `segments.N.*` path. `surfaceParams` (`:105-124`) similarly gates `effectId/paletteId/speed/intensity` behind `content.type === 'EFFECT'` (`:115-121`). So the corrupting `segments.N.*` path **cannot be produced by the capture UI at all** — it only enters a cue via **hand-edited `.artlux` JSON**. `collectFadeableTargets` guards segment emission with `Math.min(...length)` (`:159`), so scene-diff never emits a segment path for a segmentless fixture either. Net: the corruption is a **latent trap for JSON authors**, fired through `applyCues` (`App.tsx:710`) and then re-hit **every frame** by the fade engine (`transitions.ts:82`).

**(b) Per-entry `fadeSec`/`transition` overrides are honored but not editable.**
`CueEntry.transition?` / `CueEntry.fadeSec?` already exist (`src/renderer/types.ts:479-480`) and are **already applied at fire time**: `applyCues` uses `e.transition ?? cue.transition` and `e.fadeSec ?? cue.fadeSec` (`App.tsx:708`). But the Edit inspector renders each entry as only `label + value + delete` (`CueBankPanel.tsx:254-259`); the fade/transition controls (`:237-245`) exist **only at the cue level**. So per-entry overrides are **JSON-only** — the exact caveat Set #4 has to document as "edit the file by hand."

## 2. What "lifted" looks like

- **Robustness:** authoring/firing a cue entry whose path targets a non-existent structural slot (a `segments.N.*` on a fixture with no segment `N`) **never corrupts the fixture and never crashes the Stage**. It is a safe no-op: cues *patch existing* parameters, they never *create structure*.
- **UI:** in Edit mode, each cue entry row exposes an optional per-entry Fade (seconds) and Transition selector that default to "inherit (cue)". Setting them writes `CueEntry.fadeSec`/`transition`; clearing them removes the override.

**Acceptance test (runnable, no new fixtures needed):** take `examples/state-machine/*` (or any `.artlux` with a fixture that has no `segments`). Hand-add a cue with an entry `{ "path": "fixtures.<id>.segments.0.speed", "value": 0.5 }`. Fire it. **Before:** `fixture.segments` becomes `{"0":{speed:0.5}}`, save→reload shows a broken fixture / Stage throws. **After:** firing is a no-op for that entry, `fixture.segments` stays `undefined`, no throw, and `tsc` + `--headless` output is byte-identical to not firing it. Second test: in Edit mode select a cue with ≥1 entry, set one entry's Fade to `3s` / transition `linear`, fire, observe that entry fades over 3 s while the others use the cue default.

## 3. Placement: core or plugin (REQUIRED)

**Core.** Both changes live in files that are unambiguously core by the doctrine:
- `paramPath.ts` and `transitions.ts` are the core parameter-addressing/fade engine consumed by App's cue + scene recall paths. `setIn` is a **correctness fix to core state mutation** — it cannot be a plugin.
- The per-entry UI is in `CueBankPanel.tsx`, a core component, and writes `CueEntry.fadeSec`/`transition`, which are **persisted project fields already in `renderer/types.ts`** — "persisted types stay core" by rule. No new field is introduced, so there is nothing a plugin *could* own here.
- **No plugin, no new singleton, no SDK surface** → the barrel/singleton duplication hazard does **not** apply. There is no package-alias-vs-relative-import risk to manage because nothing new is registered or activated.

## 4. Design / approach

**renderer — `src/renderer/services/paramPath.ts` (the load-bearing change).**
Fix `setIn` so it is *array-path-safe by refusing to create structure*, which is the correct cue semantic (cues patch existing leaves; `getByPath` already returns `undefined` for missing slots, and `captureEntry` at `CueBankPanel.tsx:111-112` already bails on `undefined`). Two rules:

1. When the current key is a numeric index but the container is **not** an array (or the index is out of range), **return `obj` unchanged** (skip) rather than fabricating `{"0":…}`.
2. When descending would require creating a missing intermediate container, only create it for **object** keys; for a **numeric** next-key, treat a missing container as a skip.

Sketch (replaces `:84-96`):

```ts
const isIndex = (k: string) => /^(0|[1-9]\d*)$/.test(k);

function setIn(obj: Record<string, unknown>, keys: string[], value: unknown): Record<string, unknown> {
  if (keys.length === 0) return obj;
  const [k, ...rest] = keys;
  if (Array.isArray(obj)) {
    const idx = Number(k);
    if (!isIndex(k) || idx >= obj.length) return obj;          // never extend/append via a cue
    const arr = obj.slice();
    arr[idx] = rest.length === 0 ? value : setIn((arr[idx] ?? {}) as Record<string, unknown>, rest, value);
    return arr as unknown as Record<string, unknown>;
  }
  if (isIndex(k)) return obj;                                    // numeric key into a non-array ⇒ skip (was the corruption)
  if (rest.length === 0) return { ...obj, [k]: value };
  const child = obj[k];
  if (child == null || typeof child !== 'object') return obj;    // don't fabricate missing nested structure
  return { ...obj, [k]: setIn(child as Record<string, unknown>, rest, value) };
}
```

> **Why "coerce to an array" is a TRAP, not the fix.** The tempting one-liner — make the missing container `[]` when the next key is numeric — would turn the silent-corruption bug into a **worse** bug: it produces `segments = [{ speed: 0.5 }]`, a length-1 array that `fixtureSegments` (`WebGPUMapper.ts:150`) now **accepts** and hands to the shader with `start/stop/source/effectId` all `undefined` → `NaN` LED ranges → malformed/black output. A partial `Segment` is not a valid `Segment`. The correct invariant is **skip**, matching the read side.

**renderer — `src/renderer/components/CueBankPanel.tsx` (UI).**
In the entry list (`:253-262`), add per-entry Fade + Transition controls beside `EntryValue`. Both are optional overrides with an explicit "inherit" state:
- Fade: a number input bound to `e.fadeSec`; empty ⇒ `fadeSec` omitted. Update via the existing `patchCue`/`entries.map` pattern (mirror `setEntryValue` at `:119`, add `setEntryFade`/`setEntryTransition`).
- Transition: a `<select>` with an extra `''` = "cue default" option ahead of `TRANSITIONS` (`:31`); `''` ⇒ `transition` omitted.
Gate these behind fadeable/number entries where sensible (reuse `isFadeablePath`) so they don't clutter discrete entries, but this is cosmetic. No signature changes; `applyCues` already reads the fields.

**shared / main / preload / gpu:** untouched. Render path (WebGPU WGSL, WebGL fallback) is not modified — the WebGL mapper (`services/GPUMapper.ts`) has no segment logic at all, so there is no parity work; the fix only *prevents* bad data from ever reaching either mapper.

**Optional repair migration (see §6):** coerce an already-corrupted non-array `segments` back to `undefined` at load.

## 5. ⚠️ Breaking changes (REQUIRED)

**None.** Proof, surface by surface:

- **Persisted `.artlux` schema:** no new/renamed/removed field. `CueEntry.fadeSec?`/`transition?` (`types.ts:479-480`) **already exist and are already optional**; the UI merely writes fields the loader already reads. Old files load unchanged; new files with per-entry overrides are readable by older builds because those builds *already apply* `e.fadeSec ?? cue.fadeSec` (`App.tsx:708`) — **forward-compatible**.
- **`shared/protocol.ts` IPC contract:** not touched. No channel, type, or `ArtluxApi` change.
- **`@artlux/sdk`:** not touched. `setIn` is **not exported** (module-private in `paramPath.ts`); `getByPath`/`setByPath`/`isFadeablePath` **signatures are unchanged**.
- **Saved prefs / keybindings / plugin contracts:** untouched.
- **Behavioral change (not a compat break):** firing a hand-authored cue entry that targets a non-existent segment slot changes from "corrupt the fixture (and possibly crash Stage)" to "no-op." Any `.artlux` that *relied on* the corruption is impossible — the corruption produced ignored/broken output, never a feature.

## 6. Migration & back-compat

- **No version bump required.** No schema change; `normalize*()` helpers (`types.ts:351,370`) don't need a new entry for the core fix.
- **Optional repair of already-corrupted files:** a fixture whose `segments` was corrupted in a prior session persists as `{"0":…}`. Add a one-line coercion in the fixtures loader (`App.tsx:803`, the `data.fixtures.map(f => …)` spread): `segments: Array.isArray(f.segments) ? f.segments : undefined`. This is defensive and safe (a non-array `segments` is *always* garbage), and it also protects `Stage.tsx:203`'s `.map` from throwing on legacy corrupted files. Recommended but not strictly required by the fix itself.
- **Forward/backward:** a project saved by the new build loads in an older build (per-entry fields already understood; `setIn` fix is load-agnostic). A project saved by an old build loads in the new build (optional repair only *improves* it).

## 7. Risk evaluation for the codebase (REQUIRED) — **Low**

**Blast radius of `setIn`** (grepped, not guessed): `setIn` is private; its only caller is `setByPath` (`paramPath.ts:75`). `setByPath` has exactly **two** consumers:
- `src/renderer/services/transitions.ts:82` — per-frame fade application. Now segment/absent-slot legs are safe no-ops instead of per-frame corruption.
- `src/renderer/App.tsx:710` — `applyCues` entry commit.
Both benefit; neither changes behavior for the paths that actually flow through the UI (`x/y/width/height/rotation`, `content.*`, `globalBrightness` — all existing leaves), because the new guards only alter the previously-corrupting branch (numeric key into a non-array / missing container).

`getByPath` consumers (`CueBankPanel.tsx:111`, `App.tsx:707`, `paramPath.ts:145`) are **not touched**. `collectFadeableTargets` (used by scene recall, `App.tsx:593`) is **not touched** and already length-guards segments.

**Regression surface:**
1. **WebGPU vs WebGL parity:** unaffected — render path unchanged; the fix strictly reduces the set of states that reach the mappers.
2. **Per-frame perf (`transitions.ts:82`):** one regex/`isIndex` test per skipped level; negligible, and only on paths that previously *corrupted* (rare).
3. **Projector MessagePort bridge / headless entry:** both consume the same committed `fixtures[]`; preventing corruption can only help. No new IPC.

**Top things most likely to break in practice:**
1. **Over-strict skip semantics** — if some *legitimate* existing path relied on `setByPath` creating structure. Grep confirms none do: all UI-authored paths address existing leaves, and full-state commits (scene recall) use `setFixtures`/`setSurfaces`, not `setByPath`. Low.
2. **The "coerce to array" temptation** during review — flagged loudly in §4; must land as *skip*, not *create*.
3. **UI "inherit" encoding** — a per-entry Fade of `0` is a valid override (snap), which must be distinguishable from "no override." Use empty-string/undefined for inherit, never `0`. This is the one genuine footgun in the UI half.

## 8. Test / verification plan

Repo patterns (`docs/DEVELOPMENT.md`), no unit runner:
1. `npx tsc -p tsconfig.json --noEmit` — types clean (no signature change expected).
2. **Corruption fixture:** hand-edit a copy of an `examples/state-machine` `.artlux`: add a cue entry `fixtures.<id>.segments.0.speed` on a segmentless fixture. `npm run dev`, fire it. Assert: no console `TypeError` from `Stage.tsx`, `fixture.segments` stays `undefined` (inspect via devtools / re-save and diff the JSON), Stage keeps rendering.
3. **Headless parity:** `--headless --project=<fixture>` with a `dgram` listener parsing ArtDmx `0x5000`; fire the corrupting cue via OSC/cueBus; assert the output frame is identical to the never-fired baseline (proves the entry is an inert no-op, not a silent output change).
4. **Per-entry UI:** dev build, Edit mode, set one entry's Fade to 3 s / `linear`, fire; visually confirm that entry ramps over 3 s while sibling entries use the cue default; re-save and confirm the JSON has `fadeSec`/`transition` only on that entry, and clearing them removes the keys.
5. **Back-compat:** load a pre-change `.artlux` (no per-entry fields) and, if the optional repair is included, a file with a pre-corrupted `segments` object; confirm both load without error.

## 9. Effort & phasing

**Size: S.** Two files for the core work (`paramPath.ts` ~12 lines; `CueBankPanel.tsx` ~2 handlers + a couple of inputs), plus an optional one-liner in `App.tsx`. No IPC, no schema, no GPU, no plugin wiring.

**Rollout order (each independently shippable):**
1. Land the `setIn` skip-fix + the optional `App.tsx:803` repair first — pure robustness, no user-visible change, no flag needed.
2. Land the per-entry UI second — additive, writes already-honored fields.
No feature flag warranted; neither step changes existing project behavior. If desired, the UI can hide per-entry controls behind the existing Edit-mode gate only (it already is).

## 10. Open questions / decision points

- **Skip vs. permissive-create:** confirmed recommendation is **skip** (cues patch existing leaves). If product wants cues to be able to *add* a segment, that is a much larger feature (needs a full valid `Segment`, an authoring UI, and `fixtureSegments` semantics) and is explicitly out of scope here.
- **Should the capture picker expose fixture `speed`/`intensity`/segments at all?** Today `fixtureParams` (`:126-135`) omits them, so those cue entries are JSON-only regardless of this fix. Surfacing them is a separate enhancement; decide whether it belongs with this ticket or the broader "cue picker coverage" work.
- **Related, out of scope (do not silently fold in):** fixture-level `speed`/`intensity` are ignored once `segments` exist (`WebGPUMapper.ts:150-151` returns segments and drops `f.speed/intensity`). That is a *flatten-semantics* decision, not a corruption bug — flag it, don't fix it here.
- **Ship the optional repair migration?** It is safe and cheap and also hardens `Stage.tsx:203` against legacy corrupted files; recommend yes, but it is a judgment call since it mutates on load.

**Review rebuttal (§1 accuracy):** the original draft listed `InspectorPanel.tsx` among the sites that "assume an array" alongside the Stage crash. Verified against `InspectorPanel.tsx:118` — it guards with `hasSegs = !!(segs && segs.length)` (same shape as `WebGPUMapper.ts:150`), so a corrupted non-array `segments` **degrades to whole-fixture, it does not throw**; its `.map` (`:131`) is behind that guard. Corrected in §1: the *only* hard-crash consumer is `Stage.tsx:203`/`:222`, which gate `.map` on truthiness with no `.length` check. This does not change Placement/Risk/Breaking (Stage crash is still real and still fixed by the skip), only the precision of the consumer enumeration.
