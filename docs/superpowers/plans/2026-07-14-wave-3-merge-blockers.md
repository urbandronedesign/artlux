# Wave 3 Merge Blockers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `wave-3-audio` mergeable into `main` by fixing the defects a 16-agent adversarial review confirmed, plus the two verified additions the user accepted into scope.

**Architecture:** Eleven independent fixes, ordered so the destructive ones land first (a non-atomic save can destroy the work you are about to do) and the risky ones land last (the native engine must be rebuilt with the app closed). Two of the seven blockers are cured by *deleting a state* rather than guarding it: making `Scene.timeline` required makes them structurally impossible. Each task ends with a green build and a commit.

**Tech Stack:** Electron 42 · React 19 · TypeScript · Tailwind · JUCE/C++ (N-API) · Node assertion sims

## Global Constraints

- **Branch:** `wave-3-audio`. Repo root: `c:\Users\b.recoules\Downloads\_projets\artlux`.
- **There is NO unit-test framework.** `package.json` has no `test` script. **Do not add one.** The house convention is a hand-rolled Node assertion sim in `scratch/`, which is **gitignored** — see the existing `scratch/showclock-sim.mjs` (99/99) and `scratch/videoseek-sim.mjs`. TDD still applies: **write the failing sim first, watch it fail, then fix.**
- **Gates that must be green before every commit:** `npx tsc --noEmit`, `npm run build`, `npm run verify:plugins`. For any task touching `native/`, also `npm run build:audio`.
- **The dev app must be CLOSED for any native rebuild.** A running app locks `audio_engine.node`; MSVC fails with `LNK1104`, `build:audio` exits non-zero, **and the stale `.node` silently stays on disk** — so a correct fix looks broken. Confirm with `tasklist /FI "IMAGENAME eq electron.exe"` → *No tasks*.
- **Commit message style:** state the DEFECT and the ROOT CAUSE. Label a pre-existing bug **honestly as pre-existing** — never smuggle it in as new breakage. End with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  Write the message to a file and use `git commit -F <file>` — PowerShell here-strings mangle multi-line messages.
- **The two clocks (the invariant this whole wave exists to establish):**
  `playhead` = local time in the **bound** document; resets on a scene recall.
  `showTime` = the **SHOW** clock; survives a scene recall.
  The audio **bed** (`ProjectData.audio`) rides `showTime`. A timeline's **own** audio (`Timeline.audio`) rides the `playhead`.
- **Out of scope — do not let these grow into the merge.** ~30 other confirmed findings go to Wave 4 (Task 11 logs them): the pre-existing blocker at `timeline.ts:876` (a layer black forever after a scene round-trip), Collect Assets silently dropping non-asset files (`projectFolder.ts:365/374`), the uncapped undo-stack deep-clone on every automated GO (`useHistory.ts:47`), the video/audio left-trim corruption (`Timeline.tsx:458/546`), GO-during-a-core-fade (`transitions.ts:136`), and `App.tsx:285` (a lane the engine has DROPPED still renders healthy with a ticking readout, driving nothing).

---

## File Structure

| File | Change | Task |
|---|---|---|
| `src/main/persistence.ts` | `writeJson` becomes atomic (tmp + rename) | 1 |
| `src/renderer/types.ts` | sanitize `effects`; `Scene.timeline` becomes required | 2, 5 |
| `plugins/audio/src/automationTargets.ts` | `enumerate()` must not throw on a junk `effects` | 2 |
| `src/renderer/App.tsx` | New Project resets the bed; Capture Scene strips base lanes; the timeline-less branches die; the bridge streams `showTime` | 3, 5, 6, 10 |
| `src/renderer/services/timeline.ts` | the Length-edit clock desync; `isGlobalDocBound()` collapses; mirror windows are TOLD `showTime` | 4, 5, 10 |
| `src/renderer/components/timeline/Timeline.tsx` | the "plays global" pill dies; base lanes are drawn | 5, 7 |
| `src/renderer/components/timeline/AutomationLane.tsx` | a base lane reads the show clock and renders as shadowed | 7 |
| `src/renderer/components/timeline/StateGraphEditor.tsx` | `hasTimeline` dies | 5 |
| `src/renderer/components/timeline/AudioLane.tsx` | the tooltip's apology dies | 5 |
| `native/audio-engine/src/engine.cpp` | `prepareToPlay` leaves the audio lock; a dead device stops lying | 8, 9 |
| `plugins/audio/src/{plugin.main,audioClient,audioManager,AudioSettings,AudioBedPanel}.ts(x)` | device liveness reaches the UI | 9 |
| `src/renderer/services/surfaceMedia.ts` | an effect surface rides the show clock | 10 |
| `src/renderer/projector/ProjectorApp.tsx` | the mirror receives `showTime` | 10 |
| `docs/DEVELOPMENT.md`, `plans/SEQUENCING.md` | gate 2 stops lying; gate 6 is added | 11 |
| `docs/superpowers/2026-07-12-wave-3-acceptance.md` | S-noTL retires from Sessions 2–5 | 12 |

---

### Task 1: The project save must be atomic

**Why first:** every later task is edited against a project file this bug can destroy.

**Files:**
- Modify: `src/main/persistence.ts:53-61`
- Test: `scratch/atomicsave-sim.mjs` (new, gitignored)

**Interfaces:**
- Produces: `writeJson(path: string, data: unknown): boolean` — unchanged signature, atomic behaviour.

**The defect.** `writeJson` is a bare `writeFileSync` straight onto the target. `writeFileSync` opens with `'w'`, which **truncates first** — so an interrupted save (crash, power cut, full disk, antivirus lock) does not leave you the old project. It leaves a **half-written** one. Confirmed; pre-existing, but Wave 3 lengthened the write window by growing the document (`audioMix`, `Timeline.audio`, automation lanes on every timeline).

- [ ] **Step 1: Write the failing sim**

Create `scratch/atomicsave-sim.mjs`:

```js
// A save must never destroy the project it is replacing. writeFileSync opens with 'w' — it TRUNCATES
// the target before it writes a byte — so an interrupted save leaves a half-written .artlux and the
// operator's show is gone. Atomic replace: write a sibling temp file, then rename over the target.
// rename() on the same volume is atomic on NTFS: the target is either the old file or the new one.
import { writeFileSync, renameSync, readFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'artlux-atomic-'));
const target = join(dir, 'show.artlux');
const GOOD = { name: 'the operator\'s show', scenes: [1, 2, 3] };

// THE OLD WAY — reproduce the destruction.
function writeJsonOld(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  return true;
}
// THE FIX — write beside it, then rename over it.
function writeJsonNew(path, data) {
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    console.error('[persistence] write failed', path, e);
    return false;
  }
}

let fail = 0;
const ok = (c, label, detail = '') => { console.log(`   ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  --  ' + detail : ''}`); if (!c) fail++; };

// A serializer that throws models EVERY mid-write failure: a full disk, an AV lock, a power cut.
// JSON.stringify throws on a BigInt, so this is a real interruption, not a mock.
const POISON = { name: 'half a show', boom: 10n };

console.log('\n== The project exists and is good.');
writeJsonOld(target, GOOD);
ok(JSON.parse(readFileSync(target, 'utf-8')).scenes.length === 3, 'the operator has a saved show', '3 scenes');

console.log('\n== OLD: a save that fails part-way through.');
let threw = false;
try { writeJsonOld(target, POISON); } catch { threw = true; }
ok(threw, 'REPRODUCED: the write throws');
let survived = false;
try { survived = JSON.parse(readFileSync(target, 'utf-8')).scenes.length === 3; } catch { survived = false; }
ok(!survived, 'REPRODUCED: THE OPERATOR\'S SHOW IS GONE', 'the file is truncated or unparseable');

console.log('\n== NEW: the same failure, with an atomic replace.');
writeJsonOld(target, GOOD);                     // restore a good project
const returned = writeJsonNew(target, POISON);  // and fail the same way
ok(returned === false, 'FIXED: the write reports failure instead of throwing');
let intact = false;
try { intact = JSON.parse(readFileSync(target, 'utf-8')).scenes.length === 3; } catch { intact = false; }
ok(intact, 'FIXED: THE OLD PROJECT IS STILL THERE, INTACT', 'the target was never touched');
ok(!existsSync(target + '.tmp'), 'FIXED: no .tmp turd left beside the project');

console.log('\n== ...and a SUCCESSFUL save still replaces the file.');
ok(writeJsonNew(target, { name: 'v2', scenes: [1] }) === true, 'a good save returns true');
ok(JSON.parse(readFileSync(target, 'utf-8')).name === 'v2', 'a good save actually lands');
ok(!existsSync(target + '.tmp'), 'and cleans up after itself');

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? '  ALL ASSERTIONS PASS' : `  ${fail} ASSERTION(S) FAILED`);
console.log('='.repeat(70));
process.exitCode = fail === 0 ? 0 : 1;
```

- [ ] **Step 2: Run it — the OLD assertions must reproduce the destruction**

Run: `node scratch/atomicsave-sim.mjs`
Expected: **all PASS.** The sim carries both implementations, so it proves the old one destroys the file and the new one does not, before you touch `persistence.ts`. If `REPRODUCED: THE OPERATOR'S SHOW IS GONE` prints FAIL, stop — your model of the bug is wrong.

- [ ] **Step 3: Apply the fix**

In `src/main/persistence.ts`, replace `writeJson` (lines 53-61) with:

```ts
// ATOMIC REPLACE, NOT A TRUNCATING WRITE. writeFileSync opens with 'w' — it TRUNCATES the target before
// it writes a byte. So a save interrupted by a crash, a power cut, a full disk or an antivirus lock does
// not leave the operator the OLD project: it leaves a HALF-WRITTEN one, and the show is gone. Wave 3 made
// this likelier by growing the document (audioMix, Timeline.audio, a lane on every timeline).
// Write a sibling temp file, then rename over the target: rename() on the same volume is atomic on NTFS,
// so the file on disk is only ever the whole old project or the whole new one.
function writeJson(path: string, data: unknown): boolean {
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch (e) {
    // The stringify or the write blew up; the target was never touched. Do not leave the turd behind.
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort — the save already failed */ }
    console.error('[persistence] write failed', path, e);
    return false;
  }
}
```

And extend the import on line 2:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/persistence.ts
git commit -F <(printf '%s\n' \
 'fix(persistence): a save that fails must not destroy the show it is replacing' '' \
 'PRE-EXISTING, not Wave 3'"'"'s — persistence.ts is not in the branch diff at all. Found by the' \
 'merge review'"'"'s completeness critic, which noticed the review had partitioned the DIFF and so' \
 'never looked at the code Wave 3 REACHES. This was the highest-consequence path nobody owned.' '' \
 'writeJson did a bare writeFileSync onto the target. writeFileSync opens with '"'"'w'"'"': it' \
 'TRUNCATES the file before writing a byte. So a crash, a power cut, a full disk or an antivirus' \
 'lock part-way through a save does not leave the operator their old project — it leaves a' \
 'HALF-WRITTEN one. The show is gone.' '' \
 'Wave 3 did not cause it but did make it likelier: audioMix, Timeline.audio and an automation' \
 'array on every timeline all lengthen the write window.' '' \
 'Now: write a sibling .tmp, then rename over the target. rename() on the same volume is atomic on' \
 'NTFS, so what is on disk is only ever the whole old project or the whole new one.' '' \
 'scratch/atomicsave-sim.mjs reproduces the destruction and proves the fix.' '' \
 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')
```

---

### Task 2: A junk `effects` field must not crash the app on load

**Files:**
- Modify: `plugins/audio/src/automationTargets.ts:229` (and the `AudioBus` loop below it)
- Modify: `src/renderer/types.ts` — `sanitizeAudioClip` / the bus sanitizer
- Test: `scratch/effects-sanitize-sim.mjs` (new)

**Interfaces:**
- Produces: `sanitizeAudioClip(c)` and the bus sanitizer now guarantee `effects` is an **array of non-null objects with a string `id` and a string `type`**, or absent.

**The defect.** `enumerate()` iterates `c.effects ?? []` with a bare `for…of`. `effects` is one of the two document fields **no sanitizer coerces** — `sanitizeAudioClip` spreads `...c` and coerces only `start/duration/inPoint/sourceDuration/gain/mute/fades`. A `.artlux` carrying `"effects": {"0": {…}}` (the array→object corruption class this repo has **already shipped once** — see the `segments` repair in `applyProjectData`) makes `for…of` throw `TypeError: c.effects is not iterable` inside `compileAutomation`, which runs from a React effect **on every project load and every GO**. Confirmed blocker.

- [ ] **Step 1: Write the failing sim**

Create `scratch/effects-sanitize-sim.mjs`:

```js
// `effects` is the one document field no sanitizer coerces, and automationTargets.enumerate() iterates it
// with a bare for..of. compileAutomation runs on EVERY project load and EVERY GO, with no try/catch around
// enumerate(). So a .artlux carrying "effects": {"0": {...}} — the array->object corruption this repo has
// already shipped once (see the `segments` repair in applyProjectData) — throws on load. The app is dead
// before the operator sees a pixel.
//
// Defence in depth, both halves proven here:
//   1. the SANITIZER coerces `effects` to a well-formed array at the door (types.ts);
//   2. enumerate() is defensive anyway, because a PLUGIN can write a clip the sanitizer never saw.

let fail = 0;
const ok = (c, label, detail = '') => { console.log(`   ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  --  ' + detail : ''}`); if (!c) fail++; };

// ---- the shipped enumerate(), reduced to the line that throws
const enumerateOld = (clip) => { const out = []; for (const fx of clip.effects ?? []) out.push(fx.id); return out; };

// ---- THE FIX, half 2: enumerate() never trusts the document
const asArray = (v) => (Array.isArray(v) ? v : []);
const enumerateNew = (clip) => {
  const out = [];
  for (const fx of asArray(clip.effects)) {
    if (!fx || typeof fx !== 'object') continue;              // a null slot in the array
    if (typeof fx.id !== 'string' || typeof fx.type !== 'string') continue;  // unusable without both
    out.push(fx.id);
  }
  return out;
};

// ---- THE FIX, half 1: the sanitizer coerces at the door
const sanitizeEffects = (v) => {
  if (!Array.isArray(v)) return undefined;                     // {} / 5 / null / "reverb" -> gone
  const out = v.filter(fx => fx && typeof fx === 'object'
    && typeof fx.id === 'string' && typeof fx.type === 'string');
  return out.length ? out : undefined;
};

const HOSTILE = [
  ['array->object (the class already shipped once)', { effects: { 0: { id: 'a', type: 'reverb' } } }],
  ['a bare number',                                   { effects: 5 }],
  ['a string',                                        { effects: 'reverb' }],
  ['null',                                            { effects: null }],
  ['an array with a null slot',                       { effects: [null, { id: 'a', type: 'reverb' }] }],
  ['an array of numbers',                             { effects: [1, 2] }],
  ['an fx with no id',                                { effects: [{ type: 'reverb' }] }],
  ['absent entirely (the common, legal case)',        {} ],
];

console.log('\n== THE SHIPPED CODE — which of these kills the app on load?');
let killed = 0;
for (const [label, clip] of HOSTILE) {
  let threw = false;
  try { enumerateOld(clip); } catch { threw = true; killed++; }
  console.log(`      ${threw ? 'THROWS' : '  ok  '}   ${label}`);
}
ok(killed >= 4, 'REPRODUCED: the shipped enumerate() throws on hostile input', `${killed}/${HOSTILE.length} kill the app`);

console.log('\n== THE FIX — enumerate() must survive every one of them.');
let survivedAll = true;
for (const [label, clip] of HOSTILE) {
  try { enumerateNew(clip); } catch (e) { survivedAll = false; console.log(`      STILL THROWS: ${label} — ${e.message}`); }
}
ok(survivedAll, 'FIXED: enumerate() never throws, whatever the file holds');

console.log('\n== ...and it still enumerates a GOOD clip correctly (no over-filtering).');
ok(enumerateNew({ effects: [{ id: 'fx1', type: 'reverb' }, { id: 'fx2', type: 'delay' }] }).join(',') === 'fx1,fx2',
   'a well-formed chain still yields both effects');

console.log('\n== The SANITIZER coerces at the door, so the rest of the app never sees the junk.');
ok(sanitizeEffects({ 0: { id: 'a', type: 'reverb' } }) === undefined, 'array->object    -> dropped');
ok(sanitizeEffects(5) === undefined,                                  'a number         -> dropped');
ok(sanitizeEffects([null, { id: 'a', type: 'reverb' }]).length === 1, 'null slot        -> filtered, the good fx SURVIVES');
ok(sanitizeEffects([{ type: 'reverb' }]) === undefined,               'no id            -> dropped');
const good = sanitizeEffects([{ id: 'a', type: 'reverb', params: { mix: 0.3 } }]);
ok(good && good[0].params.mix === 0.3, 'a good chain survives WITH its params (we must not eat the operator\'s work)');

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? '  ALL ASSERTIONS PASS' : `  ${fail} ASSERTION(S) FAILED`);
console.log('='.repeat(70));
process.exitCode = fail === 0 ? 0 : 1;
```

- [ ] **Step 2: Run it**

Run: `node scratch/effects-sanitize-sim.mjs`
Expected: **all PASS**, and the console prints `THROWS` on at least four hostile inputs against the shipped code. That is the bug, reproduced.

- [ ] **Step 3: Harden `enumerate()`**

In `plugins/audio/src/automationTargets.ts`, add near the top of the file:

```ts
// A DOCUMENT IS NOT A TYPE. `effects` is one of the two fields no sanitizer coerces, and a PLUGIN can
// write a clip the core sanitizer never saw. compileAutomation calls enumerate() on every project load
// and every GO with no try/catch, so a `for..of` over a non-iterable here is a CRASH ON LOAD — the app
// is dead before the operator sees a pixel. Never iterate the document directly.
function effectsOf(x: { effects?: unknown }): { id: string; type: string; params?: Record<string, unknown> }[] {
  if (!Array.isArray(x.effects)) return [];
  return x.effects.filter((fx): fx is { id: string; type: string; params?: Record<string, unknown> } =>
    !!fx && typeof fx === 'object' && typeof (fx as { id?: unknown }).id === 'string' && typeof (fx as { type?: unknown }).type === 'string');
}
```

Then replace **every** `for (const fx of c.effects ?? [])` and `for (const fx of b.effects ?? [])` in `enumerate()` with `for (const fx of effectsOf(c))` / `for (const fx of effectsOf(b))`.

Run `grep -n "effects ?? \[\]" plugins/audio/src/automationTargets.ts` and confirm it returns **nothing**.

- [ ] **Step 4: Coerce at the door**

In `src/renderer/types.ts`, add beside the other sanitizers:

```ts
// The array->object corruption class this repo has ALREADY SHIPPED once (see the `segments` repair in
// applyProjectData). A hand-edited, older, or partially-written file can carry `"effects": {"0": {...}}`.
// Coerce it here, where the whole document passes through — but do NOT eat a well-formed chain: an fx
// with an id and a type keeps its params, because those are the operator's work.
export function sanitizeEffects(v: unknown): AudioEffect[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((fx): fx is AudioEffect =>
    !!fx && typeof fx === 'object' && typeof (fx as AudioEffect).id === 'string' && typeof (fx as AudioEffect).type === 'string');
  return out.length ? out : undefined;
}
```

Call it from `sanitizeAudioClip` and from the bus sanitizer, e.g.:

```ts
  effects: sanitizeEffects(c.effects),
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` → exit 0.
Run: `npm run build` → exit 0.
Run: `npm run verify:plugins` → exit 0.
Run: `node scratch/effects-sanitize-sim.mjs` → all PASS.

- [ ] **Step 6: Commit**

Message: `fix(audio): a junk 'effects' field must not kill the app on load` — state that `effects` was the one field no sanitizer coerced, that `compileAutomation` runs uncaught on every load and every GO, and that the array→object corruption class has shipped in this repo once already.

---

### Task 3: File ▸ New Project must reset the audio bed

**Files:**
- Modify: `src/renderer/App.tsx` — `resetToNewProject` (~1336-1400)

**The defect.** `resetToNewProject` calls `setSurfaces/setFixtures/setControllers/setGroups/setScenes/setCueBanks/setStateMachine/setProjectorOutputs/setAssets` — and **never `setAudioMix`**. So `audioMixRef` still holds the outgoing show's bed. Two consequences, both confirmed, found by **three independent finders**:

1. **Audible.** `swap(GLOBAL_POOL, timeline, {showClock: 'reset'})` parks `showTime` at 0 — a large backward jump, which the driver reads as a seek — so **every bed clip whose window contains 0 restarts.** Show A's music plays out of the speakers under a brand-new empty project.
2. **Corrupting.** `buildProjectData()` reads the outgoing `audioMix`, so it is **written verbatim into the fresh `.artlux`**, with clip paths pointing into the *old* project's folder and an empty asset library beside them.

The same function also keeps the wall-clock `schedule`.

- [ ] **Step 1: Find the reset**

Run: `grep -n "setAudioMix\|setSchedule\|const resetToNewProject" src/renderer/App.tsx`
Confirm `setAudioMix` appears **nowhere** inside `resetToNewProject`. That absence is the bug.

- [ ] **Step 2: Add the missing resets**

Inside `resetToNewProject`, alongside the other `setX(...)` calls and **before** the `timelineEngine.swap(...)` line:

```tsx
      // THE BED IS PART OF THE SHOW, AND New Project ENDS THE SHOW. Missing this had two teeth:
      // (1) AUDIBLE — swap(..., {showClock:'reset'}) parks showTime at 0, which the driver reads as a
      //     large backward seek, so every bed clip whose window contains 0 RESTARTS. The outgoing show's
      //     music plays out of the speakers underneath a brand-new empty project.
      // (2) CORRUPTING — buildProjectData() reads audioMix, so the old show's bed was written verbatim
      //     into the fresh .artlux, its clip paths pointing into the OLD project's folder, beside an
      //     empty asset library.
      setAudioMix(defaultAudioMix());
      // The wall-clock scheduler belongs to the show that is ending, too — it was living on in memory and
      // being written into the new file.
      setSchedule([]);
```

Both identifiers already exist and need no new imports: `defaultAudioMix` is exported from `types.ts:828` (`() => ({ tracks: [], clips: [], buses: [] })`) and is **already in App.tsx's import list on line 2**; `setAudioMix` is declared at `App.tsx:150` and `setSchedule` at `App.tsx:147`.

- [ ] **Step 3: Verify in the app (this one cannot be simmed — it is React state)**

1. `npm run dev`.
2. Open `WAVE3-ACCEPT`. Press **Play**. Confirm the bed is audible.
3. **File ▸ New Project**, pick a fresh empty folder.
4. **The room must go silent.** If any music continues, the fix did not land.
5. Open the mixer (Audio Bed panel). **It must be empty** — no tracks, no clips.
6. Save. Open the new `.artlux` in a text editor. Its `audio` key must hold an **empty** mix, and there must be **no** clip paths pointing into `WAVE3-ACCEPT-assets`.

- [ ] **Step 4: Gates + commit**

`npx tsc --noEmit` → 0. `npm run build` → 0.
Commit: `fix(document): New Project must end the show — it kept the outgoing bed, playing and persisted`

---

### Task 4: A Length edit must not desynchronise the two clocks

**Files:**
- Modify: `src/renderer/services/timeline.ts:1061-1069` (`setGlobalDoc`)
- Test: extend `scratch/showclock-sim.mjs` (existing, 99/99 — **it must stay green**)

**The defect.** Shorten the global Length below the playhead while **Loop is ON**, on the **Global pill**:

1. `App.tsx` → `setGlobalDoc(timeline)`. `gb` is now 40; `showTime` is 45 ≥ 40; `globalDoc.loop` is true → `showSeekInternal(ga)` → **`showTime = 0`**.
2. `App.tsx` → `setData` → `clampPlayheadIntoDoc` **returns early because `t.loop`** → the **playhead is left at 45**.
3. Next rAF: `t = 45.02 >= 40 && data.loop` → `t = 45.02 % 40` = **5.02**.

Now `playhead = 5.02` and `showTime = 0.02`. Both free-run over the same `[0, 40)` region with the same period, so the **5-second offset is permanent** — in the one state (`clocksCoincident()`, the Global pill) where the engine *asserts the two clocks are the same number*. Confirmed blocker.

**The fix.** `setGlobalDoc`'s job is to keep `showTime` inside the region. When the clocks are coincident, it must land `showTime` where the **playhead** is about to wrap to — not at the region start.

- [ ] **Step 1: Add the failing case to `scratch/showclock-sim.mjs`**

Append a block that models the three steps above and asserts the invariant:

```js
console.log('\n== A LENGTH EDIT MUST NOT SPLIT THE TWO CLOCKS (Global pill, Loop ON).');
// On the Global pill the engine ASSERTS the clocks are the same number (clocksCoincident()). Shortening
// Length below the playhead re-anchored showTime to the region START while the playhead wrapped MODULO —
// and both then free-run over the same region with the same period, so the offset never closes.
{
  const ga = 0, gb = 40, LOOP = true;
  let playhead = 45, showTime = 45;      // playing on the Global pill, clocks coincident

  // (1) setGlobalDoc: showTime >= gb, loop -> the SHIPPED code seeks to the region start
  const showAfterOld = LOOP ? ga : Math.max(ga, gb - 1 / 30);
  // (2) setData: clampPlayheadIntoDoc returns early because t.loop -> the playhead is UNTOUCHED
  // (3) the next rAF wraps the playhead MODULO
  const playAfter = playhead >= gb ? ((playhead - ga) % (gb - ga)) + ga : playhead;

  ok(Math.abs(playAfter - showAfterOld) > 1,
     'REPRODUCED: the shipped code splits the clocks', `playhead=${playAfter.toFixed(2)}  showTime=${showAfterOld.toFixed(2)}`);

  // THE FIX: when the clocks are coincident, showTime must land where the PLAYHEAD lands.
  const showAfterNew = LOOP ? (((showTime - ga) % (gb - ga)) + ga) : Math.max(ga, gb - 1 / 30);
  ok(Math.abs(playAfter - showAfterNew) < 1e-9,
     'FIXED: the clocks stay identical across the Length edit', `both = ${showAfterNew.toFixed(2)}`);
}
```

- [ ] **Step 2: Run it — the REPRODUCED line must pass and the FIXED line must FAIL**

Run: `node scratch/showclock-sim.mjs`
Expected: `REPRODUCED` **PASS**, `FIXED` **FAIL** (you have not written the fix yet), and **the pre-existing 99 assertions all still PASS.**

- [ ] **Step 3: Apply the fix**

In `src/renderer/services/timeline.ts`, replace the body of `setGlobalDoc`:

```ts
  setGlobalDoc(t: Timeline): void {
    globalDoc = t;
    if (external) return;
    const ga = timelineStart(globalDoc), gb = timelineEnd(globalDoc);
    if (showTime < ga) showSeekInternal(ga);
    else if (showTime >= gb) {
      // WRAP, DO NOT REWIND — and only when looping. The playhead is about to wrap MODULO on the next
      // rAF (`t = t % (gb - ga)`) while clampPlayheadIntoDoc leaves it alone (it returns early on `loop`).
      // Rewinding showTime to `ga` here therefore split the two clocks by (playhead % length) — permanently,
      // because both then free-run over the same region with the same period, so the offset never closes.
      // And it split them on the GLOBAL PILL, the one state where clocksCoincident() asserts they are the
      // same number. Land showTime exactly where the playhead is going to land.
      showSeekInternal(globalDoc.loop ? (((showTime - ga) % (gb - ga)) + ga) : Math.max(ga, gb - frameSec(globalDoc)));
    }
  },
```

- [ ] **Step 4: Verify**

Run: `node scratch/showclock-sim.mjs`
Expected: **all assertions PASS**, including the pre-existing 99 and both new ones.

Run: `npx tsc --noEmit` → 0. `npm run build` → 0.

- [ ] **Step 5: Verify in the app**

`npm run dev` → open `WAVE3-ACCEPT` → Global pill → Loop **ON** → Play to ~0:45 → set **Length = 40** → Enter.
The timecode and the bed must stay **together**. Before the fix they drift ~5 s apart and never reconverge.

- [ ] **Step 6: Commit**

`fix(timeline): a Length edit must not split the show clock from the playhead`

---

### Task 5: `Scene.timeline` becomes required — deleting the state that caused two blockers

**Files:**
- Modify: `src/renderer/types.ts:1003` + the scene load path
- Modify: `src/renderer/App.tsx` — lines 860, 963, 978, 1185, 1227, 1545, 1737
- Modify: `src/renderer/services/timeline.ts` — `isGlobalDocBound()` (392-393) and its comment block (381-421)
- Modify: `src/renderer/components/timeline/Timeline.tsx:62, 1167, 1171`
- Modify: `src/renderer/components/timeline/StateGraphEditor.tsx:6, 345`
- Modify: `src/renderer/components/timeline/AudioLane.tsx:267`
- Test: `scratch/laneclock-sim.mjs` (new)

**The root cause (both blockers).** `compileAutomation` decides which clock a lane rides by asking **which document object holds it** — `isGlobalDocBound()` is `data === globalDoc`. That is correct **only** under an unstated invariant:

> **A scene's `timeline.automation` must never contain a lane copied from the global timeline.**

Break it and two things happen at once: the copy is tagged `'scene'` and rides the playhead, **and** `timeline.ts:519` (`base = baseAutomation.filter(l => !activePaths.has(l.targetPath))`) filters the *real* base lane out because the copy shadows it by `targetPath`. The genuine show-clock lane is **deleted from the compile** and replaced by a playhead-riding impostor. A house fade sitting at 0.32 jumps to ~1.0 **in one frame** — and the materialised scene timeline is **saved**, so it recurs on every GO thereafter.

**Why no fix in `timeline.ts` can work.** By the time `compileAutomation` runs, the lane is byte-identical to one the operator drew on that scene. The distinguishing fact was destroyed by the *writer*.

**Why deleting the shape is the fix.** A scene with no timeline of its own is a state **nothing in ArtLux can create** — `handleCreateState` sets `defaultTimeline()`, `handleCaptureScene` clones. It has a read-only label ("plays global") for a state the operator cannot produce, and the app apologises for it in a 60-word tooltip. It is not even the feature it looks like: an absent timeline does not mean "leave the transport alone", it means "bind the global doc and **restart its playhead at 0**". Nobody designed that; it fell out of the data model. Delete it and **writers 2 and 3 become structurally impossible.**

- [ ] **Step 1: Write the failing sim**

Create `scratch/laneclock-sim.mjs`:

```js
// WHICH CLOCK DOES AN AUTOMATION LANE RIDE?
//   a lane of the GLOBAL doc  = a BASE lane  -> the SHOW clock  (survives a GO, like the bed)
//   a lane of a SCENE's doc   = a SCENE lane -> the PLAYHEAD    (restarts on a GO)
// compileAutomation asks the question by DOCUMENT IDENTITY (isGlobalDocBound() = `data === globalDoc`).
// That is only correct while a scene's automation never HOLDS a copy of a global lane. Two writers broke
// it, and the copy also SHADOWS the real base lane by targetPath (timeline.ts:519) — so the genuine
// show-clock lane is deleted from the compile and replaced by a playhead-riding impostor.

let fail = 0;
const ok = (c, label, detail = '') => { console.log(`   ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  --  ' + detail : ''}`); if (!c) fail++; };

const HOUSE = { targetPath: 'audio.master.gain', keyframes: [{ t: 0, v: 1.0 }, { t: 600, v: 0.15 }] };
const sample = (lane, t) => {                       // linear, clamped — enough to show the step
  const k = lane.keyframes; if (t <= k[0].t) return k[0].v; if (t >= k[k.length - 1].t) return k[k.length - 1].v;
  const [a, b] = [k[0], k[1]]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
};

// compileAutomation, reduced to the two lines that decide the clock (timeline.ts:518-526).
function compile(globalDoc, data, baseAutomation) {
  const active = data.automation ?? [];
  const activePaths = new Set(active.map(l => l.targetPath));
  const onGlobalDoc = (data === globalDoc);                                    // isGlobalDocBound()
  const base = onGlobalDoc ? [] : baseAutomation.filter(l => !activePaths.has(l.targetPath));  // :519
  return [
    ...base.map(lane => ({ lane, clock: 'show' })),
    ...active.map(lane => ({ lane, clock: onGlobalDoc ? 'show' : 'scene' })),  // :526
  ];
}
const applied = (lanes, playhead, showTime) =>
  lanes.filter(l => l.lane.targetPath === 'audio.master.gain')
       .map(l => sample(l.lane, l.clock === 'show' ? showTime : playhead))[0];

const SHOW_TIME = 480, PLAYHEAD = 20;               // 8 min into the show; the scene is 20 s in
const CORRECT = sample(HOUSE, SHOW_TIME);           // what the operator drew: ~0.32 at 8 minutes

console.log('\n== The operator draws ONE house fade on the GLOBAL timeline.');
const globalDoc = { automation: [HOUSE] };
const base = [HOUSE];
ok(Math.abs(applied(compile(globalDoc, globalDoc, base), PLAYHEAD, SHOW_TIME) - CORRECT) < 1e-9,
   'on the Global pill it rides the SHOW clock', `gain ${CORRECT.toFixed(2)} at 8:00`);

console.log('\n== WRITER 1 — Capture Scene deep-clones the bound doc, automation and all (App.tsx:781).');
{
  const scene = { automation: structuredClone(globalDoc.automation) };   // the clone IS the bug
  const got = applied(compile(globalDoc, scene, base), PLAYHEAD, SHOW_TIME);
  ok(Math.abs(got - CORRECT) > 0.5, 'REPRODUCED: the house fade SNAPS on recall',
     `applied ${got.toFixed(2)} instead of ${CORRECT.toFixed(2)} — a jump of ${(got - CORRECT).toFixed(2)}`);
  ok(compile(globalDoc, scene, base).length === 1,
     'REPRODUCED: and the REAL base lane is gone — the impostor shadowed it by targetPath');
}

console.log('\n== WRITER 2 — a timeline-less scene materializes a copy on its first edit (App.tsx:923).');
{
  const materialized = { ...globalDoc };                                  // a NEW object, SAME lane array
  const got = applied(compile(globalDoc, materialized, base), PLAYHEAD, SHOW_TIME);
  ok(Math.abs(got - CORRECT) > 0.5, 'REPRODUCED: an ordinary edit (even pressing Loop) flips the clock',
     `applied ${got.toFixed(2)}`);
}

console.log('\n== THE FIX — a scene never HOLDS a base lane. Capture Scene strips them.');
{
  const scene = { automation: [] };                                       // Task 6: automation: []
  const lanes = compile(globalDoc, scene, base);
  ok(Math.abs(applied(lanes, PLAYHEAD, SHOW_TIME) - CORRECT) < 1e-9,
     'FIXED: the house fade keeps riding the SHOW clock', `gain ${CORRECT.toFixed(2)}, unchanged`);
  ok(lanes.length === 1 && lanes[0].clock === 'show',
     'FIXED: NOTHING IS LOST — the base lane is back, tagged show', 'stripping removes the impostor, not the automation');
}

console.log('\n== ...and a lane the operator ACTUALLY draws on the scene still rides the PLAYHEAD.');
{
  const own = { targetPath: 'surfaces.wall.opacity', keyframes: [{ t: 0, v: 0 }, { t: 30, v: 1 }] };
  const scene = { automation: [own] };
  const lanes = compile(globalDoc, scene, base);
  ok(lanes.find(l => l.lane === own).clock === 'scene', 'a scene\'s OWN lane rides the playhead');
  ok(lanes.find(l => l.lane === HOUSE).clock === 'show', 'and the global base lane runs UNDER it, on the show clock');
}

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? '  ALL ASSERTIONS PASS' : `  ${fail} ASSERTION(S) FAILED`);
console.log('='.repeat(70));
process.exitCode = fail === 0 ? 0 : 1;
```

- [ ] **Step 2: Run it**

Run: `node scratch/laneclock-sim.mjs`
Expected: **all PASS.** The sim carries both behaviours, so it proves the mechanism and the fix before you touch a file. If a `REPRODUCED` line FAILS, your model of the bug is wrong — stop.

- [ ] **Step 3: Make `Scene.timeline` required**

`src/renderer/types.ts:1003`:

```ts
  timeline: Timeline;          // every scene owns one. The "absent -> uses the shared global timeline"
                               // shape is GONE: nothing in the UI could create it, it had a read-only
                               // label ("plays global") for a state the operator could not produce, and
                               // it was the root of two merge blockers (the lane-clock retag).
```

In the scene load path, a missing timeline now becomes a real one. `src/renderer/App.tsx:1185`:

```tsx
        return { ...s, accent, timeline: s.timeline ? normalizeTimeline(s.timeline) : defaultTimeline() };
```

- [ ] **Step 4: Collapse the two clock questions into one**

`src/renderer/services/timeline.ts` — **delete** `isGlobalDocBound()` (lines 392-393) **and its comment block (381-391)**, then replace every call to it with `clocksCoincident()`. They now ask the same question and return the same answer.

Trim the comment on `clocksCoincident()` (396-421): the whole argument about *"a scene with NO TIMELINE OF ITS OWN"* describes a state that no longer exists. Keep only the part that says the clocks are coincident on the Global pill and why.

Run `grep -n "isGlobalDocBound" src/renderer/services/timeline.ts` and confirm it returns **nothing**.

- [ ] **Step 5: Simplify every optional-timeline branch**

| File:line | Was | Becomes |
|---|---|---|
| `App.tsx:860` | `scene.timeline ? normalizeTimeline(scene.timeline) : timeline` | `normalizeTimeline(scene.timeline)` |
| `App.tsx:963` | `applied(prev[i].timeline ?? timelineRef.current)` | `applied(prev[i].timeline)` — and delete "rule 2" from the comment block above it: the lazy-materialize it defends no longer exists |
| `App.tsx:1227` | `currentScene?.timeline ? normalizeTimeline(currentScene.timeline) : tl` | `currentScene ? normalizeTimeline(currentScene.timeline) : tl` |
| `App.tsx:1545` | `s.timeline ? relinkTimeline(s.timeline) : s.timeline` | `relinkTimeline(s.timeline)` |
| `App.tsx:1737` | `if (owner?.timeline) setScenes(...)` | `if (owner) setScenes(...)` |

**Leave `App.tsx:212` (`activeScene?.timeline ?? timeline`) alone.** The `?? timeline` fallback is still needed for the **Global** case (no scene bound). It simply can no longer reach the "scene exists but has no timeline" branch.

**`App.tsx:923` (`handleTimelineChange`) needs NO change.** Once every scene owns a timeline, `if (activeSceneId) setScenes(...)` is already correct — the lazy fork evaporates rather than being guarded. That is the point of deleting the shape.

- [ ] **Step 6: Delete the UI for a state that no longer exists**

- `App.tsx:978` — drop `hasTimeline: !!s.timeline` from the plugin-facing scene list. Keep `clipCount: s.timeline.clips.length`.
- `StateGraphEditor.tsx:6` — drop `hasTimeline?: boolean` from `SceneRef`; at `:345`, drop the branch that switches on it.
- `Timeline.tsx:62` — drop `hasTimeline: boolean` from the `scenes` prop type.
- `Timeline.tsx:1167` — the `Film` icon is now unconditional: `<Film size={11} className="text-fg-3 shrink-0" />`
- `Timeline.tsx:1171` — drop the `'plays global'` fallback: `{`${s.clipCount ?? 0} clip${(s.clipCount ?? 0) === 1 ? '' : 's'}`}`
- `Timeline.tsx:1365` — drop `hasTimeline: s.hasTimeline` from the mapped scenes.
- `Timeline.tsx:1168` — delete the comment about the shape.
- `AudioLane.tsx:267` — delete the parenthetical: *"(A scene with no timeline of its own is bound to the GLOBAL one, so it shows the global timeline's tracks under its own name until the first edit forks them into the scene.)"* It describes a fork that can no longer happen.

Run `grep -rn "hasTimeline" src/ plugins/ packages/` and confirm only `hasTimelineRegion` (an unrelated helper in `types.ts:470`) remains.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit`
Expected: exit 0. **TypeScript is doing the work here** — making the field required turns every unhandled optional site into a compile error. If `tsc` is silent, you have found them all.

Run: `npm run build` → 0. `npm run verify:plugins` → 0.
Run: `node scratch/laneclock-sim.mjs` → all PASS.
Run: `node scratch/showclock-sim.mjs` → still green (Task 4 must not regress).

- [ ] **Step 8: Commit**

`refactor(scenes): every scene owns a timeline — deleting the state that caused two clock blockers`

State in the message: nothing in the UI could create a timeline-less scene; it had a read-only "plays global" label for an unreachable state; it was the root of the lane-clock retag; deleting it makes writers 2 and 3 **structurally impossible** and collapses `isGlobalDocBound()` into `clocksCoincident()`.

---

### Task 6: Capture Scene must not clone the global timeline's automation lanes

**Files:**
- Modify: `src/renderer/App.tsx:781` (`handleCaptureScene`)

**The defect.** `timeline: structuredClone(activeTimeline)`. With **Global** bound, `activeTimeline` *is* the global timeline — so the new scene gets a deep clone of it, **automation lanes included**. This is the writer that is reachable **in a project authored today**, with no legacy file involved. It is the blocker that ships.

**Why stripping loses nothing.** With `scene.automation = []`, `activePaths` is empty, so `timeline.ts:519` returns **every** base lane tagged `'show'`. The house fade keeps riding the show clock exactly as before — as the base layer, which is what `baseAutomation` is *for*. **We remove the impostor, not the automation.** Task 5's sim proves it.

- [ ] **Step 1: Apply the fix**

`src/renderer/App.tsx:781`:

```tsx
  const handleCaptureScene = () => {
    const id = generateId();
    // A fresh capture takes the currently-bound timeline as its own (deep-cloned so later edits to other
    // timelines don't mutate it); the snapshot itself is look-only so Update never clobbers it.
    //
    // AUTOMATION IS DELIBERATELY NOT CLONED. On the Global pill `activeTimeline` IS the global doc, so a
    // naive structuredClone handed the new scene a COPY of every BASE lane. compileAutomation decides a
    // lane's clock by document identity, so the copy was retagged 'scene' AND shadowed the real base lane
    // by targetPath (timeline.ts:519) — a house fade on audio.master.gain snapped back to its t=0 value on
    // every recall of that scene, and the damage was persisted to the file.
    // NOTHING IS LOST: with `automation: []` the base layer returns EVERY global lane, tagged 'show', so
    // the fade keeps riding the show clock exactly as it did. We drop the impostor, not the curve.
    const timeline: Timeline = { ...structuredClone(activeTimeline), automation: [] };
    setScenes([...scenes, { id, name: `Scene ${scenes.length + 1}`, fadeSec: 0, ...buildSceneSnapshot(), timeline, accent: nextAccent(scenes.map(s => s.accent), id) }]);
  };
```

- [ ] **Step 2: Verify in the app — this is the blocker, prove it dead**

1. `npm run dev` → open `WAVE3-ACCEPT` → **Global** pill.
2. Add an automation lane on **`audio.master.gain`**: key `1.0` at `t=0`, key `0.15` at `t=280`. (Diamond button in the lane gutter; drag the keys.)
3. Press **Play**. Run to ~2:00. The master fader should be sliding down. Note its value.
4. Press **Capture Scene**.
5. **GO** that scene.
6. **The master must NOT jump.** It must keep descending on the show clock.

Before this fix, the master snaps back to ~1.0 (full gain) on the GO — roughly **+10 dB, in one frame.**

7. Save. Open the `.artlux`. The new scene's `timeline.automation` must be `[]`. The global timeline's `automation` must still hold the lane.

- [ ] **Step 3: Gates + commit**

`npx tsc --noEmit` → 0. `npm run build` → 0. `node scratch/laneclock-sim.mjs` → PASS.

`fix(automation): Capture Scene must not steal the global lanes off the show clock`

---

### Task 7: The operator must be able to SEE the lane that is driving the master

**Files:**
- Modify: `src/renderer/components/timeline/Timeline.tsx` (~303, and the lane render block)
- Modify: `src/renderer/components/timeline/AutomationLane.tsx` (~181, and the gutter)

**Why this is in the merge and not in Wave 4.** Tasks 5+6 make the data correct and the screen **emptier**. Today, Capture Scene's clone at least puts *something* on screen — the wrong lane, on the wrong clock, which is the blocker. Strip it and the panel goes blank while a global lane keeps moving the master with no visible cause. **Our own fix opens this gap, so it must close it in the same breath.** The operator's rule: *they must understand what is happening through the UI.*

**The defect.** `Timeline.tsx:303` is `const lanes: AutoLane[] = timeline.automation ?? []` — the **bound** document's lanes only. GO a scene and the global timeline's lanes vanish from the screen while they keep driving.

**Three things make this correct rather than decorative:**

1. **Source the base lanes.** App already holds them (`setBaseAutomation(timeline.automation)`, `App.tsx:272`). Pass them in as a prop — do **not** reach into the engine from the component.
2. **Render the SHADOWING.** `timeline.ts:519` filters a base lane out when a scene lane shares its `targetPath` — the base one is **not applying**. A naive draw would show **two lanes both claiming to drive master gain**, which is worse than showing none. A shadowed base lane must render as **shadowed**. This makes the precedence rule visible for the first time.
3. **A base lane's readout must sample the SHOW clock.** `AutomationLane.tsx:181` samples `playhead` for every lane. A base lane rides `showTime`; sampling it at the playhead prints a number that is not the number being applied — the same disease we are deleting.

- [ ] **Step 1: Pass the base lanes into the panel, and read the show clock on the tick that already exists**

Only `baseAutomation` needs to cross the prop boundary — the component cannot see the global doc, it only receives the **bound** one. The show clock does *not* need a prop: `Timeline.tsx` already imports the engine and calls `engine.getPlayhead()` on a 100 ms interval.

In `App.tsx`, at **both** `<TimelinePanel ... />` render sites (lines 2523 and 2731), add:

```tsx
  baseAutomation={activeSceneId ? (timeline.automation ?? []) : []}
```

Here `timeline` is the **global** doc (App's own state), not `activeTimeline`. It is `[]` on the Global pill because there the bound doc **is** the base — drawing it twice would duplicate every lane.

In `Timeline.tsx`, add the prop to the component's type (beside `scenes` at line 62):

```tsx
  baseAutomation: AutoLane[];   // the GLOBAL timeline's lanes: the base layer, running under this scene
```

and add the show clock to the existing 10 Hz readout tick. Line 84, beside `autoPlayhead`:

```tsx
  const [autoShowTime, setAutoShowTime] = useState(0); // ~10 Hz SHOW clock — a base lane rides this, not the playhead
```

and extend the interval at line 362 (do **not** add a second interval):

```tsx
    const iv = setInterval(() => { setAutoPlayhead(engine.getPlayhead()); setAutoShowTime(engine.getShowTime()); }, 100);
```

- [ ] **Step 2: Merge base lanes into the panel's lane list, tagged**

In `Timeline.tsx`, replace line 303:

```tsx
  // THE PANEL MUST SHOW WHAT IS ACTUALLY DRIVING THE PARAMETERS — not just the lanes of the bound doc.
  // A GLOBAL lane keeps running underneath every scene (it is the base layer: App.tsx:272 setBaseAutomation),
  // so a scene with no lanes of its own would otherwise show an EMPTY automation area while a house fade
  // slides the master with no visible cause.
  //
  // SHADOWING IS THE PART THAT MATTERS. timeline.ts:519 drops a base lane when a scene lane owns the same
  // targetPath — the base one is NOT applying. Drawing both without saying so would show two lanes each
  // claiming to drive master gain, which is worse than showing none.
  type PanelLane = { lane: AutoLane; origin: 'scene' | 'global'; shadowed: boolean };
  const ownPaths = new Set((timeline.automation ?? []).map(l => l.targetPath));
  const panelLanes: PanelLane[] = [
    ...(timeline.automation ?? []).map(lane => ({ lane, origin: 'scene' as const, shadowed: false })),
    ...baseAutomation.map(lane => ({ lane, origin: 'global' as const, shadowed: ownPaths.has(lane.targetPath) })),
  ];
```

Then render `panelLanes` instead of `lanes`, passing the new fields down:

```tsx
  <AutomationLane
    key={lane.id}
    lane={lane}
    origin={origin}
    shadowed={shadowed}
    playhead={origin === 'global' ? autoShowTime : autoPlayhead}   // a base lane rides the SHOW clock
    onChange={origin === 'global' ? undefined : (next) => commitLane(next)}   // read-only from a scene
    ...
  />
```

- [ ] **Step 3: Render origin and shadowing in the lane**

In `AutomationLane.tsx`, extend the props:

```tsx
  origin: 'scene' | 'global';
  shadowed: boolean;
  onChange?: (lane: AutoLane) => void;   // absent => read-only (a global lane, seen from a scene)
```

In the gutter (beside `{def.label}`), add the badge, and dim a global lane:

```tsx
  {origin === 'global' && (
    <span
      className={`text-micro px-1 rounded ${shadowed ? 'text-fg-3 line-through' : 'text-fg-2'} bg-surface-2`}
      title={shadowed
        ? 'This lane belongs to the GLOBAL timeline and rides the SHOW clock — but THIS SCENE has its own lane on the same parameter, which overrides it. The global one is not applying right now.'
        : 'This lane belongs to the GLOBAL timeline and rides the SHOW clock. It keeps running underneath every scene — that is why this parameter is moving. Edit it on the Global pill.'}>
      GLOBAL
    </span>
  )}
```

Wrap the row in the dimming/strike class:

```tsx
  <div className={`flex border-b border-line-1 ${enabled ? 'bg-surface-1/40' : 'bg-surface-1/20'} ${origin === 'global' ? (shadowed ? 'opacity-30' : 'opacity-60') : ''}`}>
```

Guard every editing control (`onChange({...})`, the Diamond add-key button, `cycleCurve`, `commit`) behind `if (!onChange) return;` so a global lane cannot be edited from a scene — it is edited on the Global pill, where it lives.

- [ ] **Step 4: Verify in the app**

1. `npm run dev` → `WAVE3-ACCEPT` → **Global** → draw a lane on `audio.master.gain`. Confirm the panel shows **one** lane, editable, no badge.
2. Press **Capture Scene**, then **GO** that scene.
3. The panel must now show that lane, **dimmed, badged `GLOBAL`, not editable**, and its readout must track the **show clock** (the same number the master fader is at) — **not** restart from the scene's playhead.
4. Now add a scene lane on the **same** target (`audio.master.gain`).
5. The `GLOBAL` lane must go **struck-through and further dimmed** — it is being overridden. The scene lane must be live and editable.
6. Delete the scene lane. The `GLOBAL` lane must come back to life.

- [ ] **Step 5: Gates + commit**

`npx tsc --noEmit` → 0. `npm run build` → 0.

`feat(automation): the operator can see the global lane that is moving their master — and when a scene overrides it`

---

### Task 8: `addClip` must not block the audio thread

**Files:**
- Modify: `native/audio-engine/src/engine.cpp:245-249` (`SpatialBus::addClip`)

**The defect.**

```cpp
void addClip(const std::string& id, std::unique_ptr<Clip> clip) {
    const juce::ScopedLock sl(lock);
    if (prepared) clip->transport->prepareToPlay(maxBlock, sampleRate);   // <-- BLOCKS, under the lock
    clips[id] = std::move(clip);
}
```

`prepareToPlay` on a `BufferingAudioSource` blocks in a `Thread::sleep(5)` loop until the read-ahead thread has prefilled **0.25 s from disk**. `SpatialBus::getNextAudioBlock` reaches its work only by taking the same `lock`. So the audio callback is **starved for the whole prefill** — an audible click or gap in the bed **on every GO** that loads a clip.

**The file already knows this.** Three lines below, `removeClip` carries a long comment: *"── Stopping: NEVER under the lock ── AudioTransportSource::stop() BLOCKS… calling stop() while holding `lock` is a deadlock that resolves by TIMEOUT: the audio callback is starved for the full second. **Measured on the real device: 1250 ms per stopped clip.**"* The author found this exact class of bug, wrote it down, fixed `stop()` — and left the same mistake in `addClip`.

**Why the fix is trivially safe.** The clip is **not in the `clips` map yet**, so the audio thread cannot reach it. Preparing it outside the lock races nothing. And the clip map is mutated only from the single N-API thread — the same argument `removeClip`'s comment already makes.

- [ ] **Step 1: CLOSE THE DEV APP**

Run: `tasklist /FI "IMAGENAME eq electron.exe"`
Expected: `INFO: No tasks are running which match the specified criteria.`

**If the app is running, `build:audio` fails with `LNK1104` and silently leaves the stale `.node` on disk — your fix will look like it did nothing.**

- [ ] **Step 2: Apply the fix**

`native/audio-engine/src/engine.cpp`, replace `addClip`:

```cpp
  // ── Adding: PREPARE OUTSIDE THE LOCK — same disease as stop(), see the note on removeClip below ──
  // AudioTransportSource::prepareToPlay reaches BufferingAudioSource::prepareToPlay, which BLOCKS in a
  //     do { ScopedUnlock; backgroundThread.moveToFrontOfQueue(this); Thread::sleep(5); }
  //     while (prefillBuffer && bufferValidEnd - bufferValidStart < jmin(sampleRate/4, ...));
  // loop until the read-ahead thread has pulled 0.25 s off DISK. Our audio callback reaches its work only
  // by taking `lock`, so preparing under the lock starved the callback for the whole prefill: an audible
  // click/gap in the BED on every GO that loads a clip.
  //
  // Safe because the clip is not in `clips` yet — the audio thread cannot see it, so there is nothing to
  // race. The map is mutated only from the single N-API thread, so `prepared`/`maxBlock`/`sampleRate`
  // cannot change underneath us between the two short lock holds.
  void addClip(const std::string& id, std::unique_ptr<Clip> clip) {
    bool doPrepare; int mb; double sr;
    {
      const juce::ScopedLock sl(lock);
      doPrepare = prepared; mb = maxBlock; sr = sampleRate;
    }
    if (doPrepare) clip->transport->prepareToPlay(mb, sr);   // BLOCKS — must not hold `lock`
    {
      const juce::ScopedLock sl(lock);
      clips[id] = std::move(clip);
    }
  }
```

- [ ] **Step 3: Build the engine**

Run: `npm run build:audio`
Expected: exit **0**. If it exits non-zero with `LNK1104`, an app still holds the `.node` — go back to Step 1. **A non-zero exit means the old engine is still on disk.**

- [ ] **Step 4: Prove the gap is gone, on the real device**

`npm run dev` → open `WAVE3-ACCEPT` → **Play** the bed → **GO** to **S1** (whose timeline carries `scene-sfx.wav`, a clip not yet resident).

**Listen to the bed at the moment of the GO.** Before the fix there is an audible click/gap as the callback starves. After it, the bed must run through the GO **unbroken**.

Repeat the GO ten times. Not one of them may break the bed.

- [ ] **Step 5: Commit**

`fix(audio/engine): prepareToPlay must not run under the audio lock — the bed clicked on every GO`

State: the file already carried the correct rule for `stop()` ("Stopping: NEVER under the lock", measured at 1250 ms per clip) and `addClip` broke it three lines above. Safe because the clip is not yet in the map.

---

### Task 9: A dead audio device must not report "engine active"

**Files:**
- Modify: `native/audio-engine/src/engine.cpp:490` (`configure`) and add a liveness accessor
- Modify: `plugins/audio/src/plugin.main.ts`, `audioClient.ts`, `audioManager.ts`
- Modify: `plugins/audio/src/AudioSettings.tsx`, `AudioBedPanel.tsx`

**The defect.** `configure`'s guard is `if (opened && ch == openedChannels) return {};`. `opened` is a bool set when we once opened a device and **never invalidated when the device dies**. When the operator's interface is bumped or its driver reloads:

- JUCE closes the device and leaves `getCurrentAudioDevice()` **null**. **The room goes silent.**
- JUCE does **not** recover — verified: `audioDeviceListChanged` only ever retries the **dead device by its old name**, `setAudioDeviceSetup` hard-fails with *"No such device"*, the error is discarded, and the retry block is guarded by `if (currentAudioDevice != nullptr)`, so **plugging the interface back in does nothing either.**
- The operator's diagnostic reflex — open **Preferences ▸ Audio**, which re-applies the **same** channel count — hits the guard, returns `{}` without touching the device, and the panel renders **"Native JUCE + ambisonic engine active"** over a silent room.
- `audio:available` cannot save it: `audioManager.ts:77` is `export const available = !!native` — a **load-time** constant meaning *"did the `.node` load"*, not *"is a device open"*.

**This is exactly the disease already fixed in Session 0: the room is silent and the UI says everything is fine.**

- [ ] **Step 1: CLOSE THE DEV APP** (as Task 8, Step 1). Confirm `tasklist` shows no `electron.exe`.

- [ ] **Step 2: Make the guard ask the device, not a stale bool**

`native/audio-engine/src/engine.cpp`, inside `configure`, immediately after `const int ch = ...`:

```cpp
    // `opened` records that we once CALLED open — NOT that a device is still there. When the interface is
    // bumped or its driver reloads, JUCE closes the device and leaves getCurrentAudioDevice() null, and
    // nothing clears `opened`. The guard below then swallowed the operator's only reflex — open
    // Preferences > Audio, which re-applies the SAME channel count — and returned {} without reopening,
    // over a silent room. (JUCE will not self-heal: audioDeviceListChanged only ever retries the DEAD
    // device by its old name, and its retry block is gated on currentAudioDevice != nullptr, so even
    // re-plugging does nothing.) Ask the device manager whether a device is actually live.
    if (deviceManager.getCurrentAudioDevice() == nullptr) opened = false;
```

And add a public accessor beside `currentDeviceName()`:

```cpp
  // IS A DEVICE ACTUALLY OPEN RIGHT NOW? Distinct from `available` (which only says the .node loaded).
  // The UI needs this to stop reporting a healthy engine over a silent room.
  bool deviceLive() { return deviceManager.getCurrentAudioDevice() != nullptr; }
```

Export it through N-API alongside `currentDeviceName` — copy the binding pattern of the existing `deviceChannels()` export exactly.

- [ ] **Step 3: Carry liveness to the renderer on the poll that already exists**

`plugins/audio/src/plugin.main.ts` — extend the meters handler (it is already polled at 100 ms, so this costs no new IPC):

```ts
    ipc.handle('audio:getMeters', () => ({ ...engine.getMeters(), deviceLive: engine.deviceLive() }));
```

`plugins/audio/src/audioManager.ts` — surface `deviceLive` from the native addon (`return native ? native.deviceLive() : false`).

`plugins/audio/src/audioClient.ts` — widen the meters type with `deviceLive: boolean`.

- [ ] **Step 4: Stop the UI lying**

`plugins/audio/src/AudioSettings.tsx:73` — the engine being *loaded* is not the device being *open*:

```tsx
  // engineUp only says the .node LOADED. A device that died mid-show leaves the addon loaded and the room
  // silent — so the panel used to say "engine active" over silence. Both must be true.
  const available = engineUp && deviceLive && !error;
```

and render the dead-device case explicitly, rather than falling through to `output device: default`:

```tsx
  {engineUp && !deviceLive && (
    <p className="text-warn text-micro">
      The audio device is gone — the room is silent. It was unplugged, or its driver reloaded.
      Pick a device below to reopen it.
    </p>
  )}
```

`plugins/audio/src/AudioBedPanel.tsx` — extend the existing amber badge (the one added for "no audio engine") with a `no audio device` state, using `deviceLive` from the meters poll it already runs.

- [ ] **Step 5: Build and prove it on real hardware**

Run: `npm run build:audio` → exit 0.
Run: `npx tsc --noEmit` → 0. `npm run build` → 0. `npm run verify:plugins` → 0.

Then, with a **USB audio interface**:

1. `npm run dev` → open `WAVE3-ACCEPT` → **Play**. Confirm the bed is audible **through the USB interface**.
2. **Unplug the interface** mid-playback.
3. The mixer must show the amber **`no audio device`** badge — not a healthy mixer.
4. Open **Preferences ▸ Audio**. It must say **the device is gone**, not *"Native JUCE + ambisonic engine active"*.
5. Pick a device from the list. **Audio must come back** without restarting the app.

- [ ] **Step 6: Commit**

`fix(audio): a dead device must not report a healthy engine — and must be recoverable without a restart`

---

### Task 10: Effects on surfaces must ride the show clock

**Files:**
- Modify: `src/renderer/services/surfaceMedia.ts:47`
- Modify: `src/renderer/services/timeline.ts` — add `setExternalShowTime`, and let a mirror window interpolate the show clock
- Modify: `src/renderer/App.tsx:1936` — the transport bridge streams `showTime`
- Modify: `src/renderer/projector/ProjectorApp.tsx:139-141` — the mirror receives it
- Test: `scratch/effectclock-sim.mjs` (new)

**The defect.** `surfaceMedia.ts:47`:

```ts
  return contentSource.getDrawable(s.id, s.content, performance.now() / 1000);
```

An effect **surface** is handed raw wall-clock time. **It never reads the transport.** Pause does nothing; seek does nothing. The `isPlaying` gate *exists* — `syncSurfaces(surfaces, isPlaying)` → `contentSource.setPlaying(isPlaying)` — but that only reaches the **video codecs**; effects are driven by the `timeSec` argument. `contentSource.ts:179` documents it as deliberate (*"clip-local for timeline clips, wall-clock for surfaces"*). It is the wrong design for a show-control app and it is incoherent with a wave whose entire purpose was one transport.

**The decision (user):** an effect surface rides **`showTime`**. A surface belongs to the *show*, not to whichever document is bound; `showTime` survives scene recalls, so an ambient effect keeps running across a GO exactly like the audio bed. **Pause freezes it, seek scrubs it, stop resets it.**

**⚠ The trap that would ship as a regression.** `timeline.ts:1071` — `getShowTime()` is *"Always 0 in mirror windows (they never run it)."* Changing **only** `surfaceMedia.ts` would make every effect on **every projector freeze at zero** — worse than today. The bridge work below is **not optional.**

- [ ] **Step 1: Write the failing sim**

Create `scratch/effectclock-sim.mjs`:

```js
// An effect SURFACE was handed `performance.now() / 1000` — raw wall time. It never read the transport, so
// PAUSE DID NOT FREEZE THE PICTURE and a seek did not move it. And each window has its own performance.now()
// epoch, so the operator's preview and the audience's projector ran the same effect at different phases.
// The show clock fixes all three: pause freezes, seek scrubs, and the mirror is TOLD the number.

let fail = 0;
const ok = (c, label, detail = '') => { console.log(`   ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  --  ' + detail : ''}`); if (!c) fail++; };

const FRAME = 1 / 60;

// The MAIN window's show clock: advances only while playing, re-anchors on a seek.
class ShowClock {
  constructor() { this.showTime = 0; this.playing = false; }
  tick() { if (this.playing) this.showTime += FRAME; }
  seek(t) { this.showTime = t; }
}
// A MIRROR window: it does NOT run the clock. It is TOLD, at ~30 Hz, and interpolates between messages.
class MirrorClock {
  constructor() { this.showTime = 0; this.playing = false; }
  tell(sec, playing) { this.showTime = sec; this.playing = playing; }   // setExternalShowTime()
  tick() { if (this.playing) this.showTime += FRAME; }
}

const oldClock = () => wall;                       // performance.now()/1000 — what shipped
let wall = 100;                                    // the wall clock never stops, whatever the transport does

console.log('\n== THE SHIPPED CODE: pause the transport. Does the picture freeze?');
{
  const before = oldClock();
  for (let f = 0; f < 60; f++) wall += FRAME;      // one second passes, transport PAUSED
  ok(oldClock() !== before, 'REPRODUCED: the effect kept animating through a full second of PAUSE',
     `t went ${before.toFixed(2)} -> ${oldClock().toFixed(2)}`);
}

console.log('\n== THE FIX: the effect rides the SHOW clock.');
{
  const c = new ShowClock(); c.showTime = 100; c.playing = false;
  const before = c.showTime;
  for (let f = 0; f < 60; f++) c.tick();
  ok(c.showTime === before, 'FIXED: PAUSE FREEZES THE PICTURE', `t held at ${before.toFixed(2)}`);

  c.playing = true;
  for (let f = 0; f < 60; f++) c.tick();
  ok(Math.abs(c.showTime - (before + 1)) < 1e-9, 'FIXED: play resumes it from where it stopped');

  c.seek(5);
  ok(c.showTime === 5, 'FIXED: a seek MOVES the effect (the picture follows the transport)');
}

console.log('\n== ...and a GO must NOT restart it (it rides the SHOW clock, like the bed).');
{
  const c = new ShowClock(); c.showTime = 240; c.playing = true;
  const playheadAfterGo = 0;                       // a scene recall resets the PLAYHEAD to 0
  c.tick();
  ok(c.showTime > 240, 'a GO leaves the show clock running', `showTime ${c.showTime.toFixed(2)}, playhead ${playheadAfterGo}`);
}

console.log('\n== THE MIRROR WINDOW: getShowTime() is 0 there. Changing ONLY surfaceMedia would FREEZE it.');
{
  const naive = 0;                                 // what a projector's getShowTime() returns today
  ok(naive === 0, 'REPRODUCED: a naive fix freezes every projector effect at zero — WORSE than the bug');

  const m = new MirrorClock();
  m.tell(240, true);                               // the bridge delivers the main window's showTime
  for (let f = 0; f < 2; f++) m.tick();            // interpolate between 30 Hz messages at 60 fps
  ok(Math.abs(m.showTime - (240 + 2 * FRAME)) < 1e-9,
     'FIXED: the mirror is TOLD the show clock and interpolates', `showTime ${m.showTime.toFixed(4)}`);

  m.tell(240.5, true);                             // and re-anchors on every message, so it cannot drift
  ok(m.showTime === 240.5, 'FIXED: every bridge message re-anchors it — no drift from the main window');
}

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? '  ALL ASSERTIONS PASS' : `  ${fail} ASSERTION(S) FAILED`);
console.log('='.repeat(70));
process.exitCode = fail === 0 ? 0 : 1;
```

- [ ] **Step 2: Run it** — `node scratch/effectclock-sim.mjs` → all PASS.

- [ ] **Step 3: The effect surface reads the show clock**

`src/renderer/services/surfaceMedia.ts:47`:

```ts
// Drawable for a surface this frame, or null if not ready / no content.
export function getDrawable(s: Surface): Drawable | null {
  if (s.content.type === SourceType.LAYER) return timeline.getLayerDrawable(s.content.layerId);
  if (s.content.type === SourceType.PROGRAM) return timeline.getProgramDrawable();
  // THE SHOW CLOCK, not `performance.now()`. A generative surface used to be handed raw wall time, so it
  // NEVER READ THE TRANSPORT: pause did not freeze the picture and a seek did not move it. A surface belongs
  // to the SHOW, not to whichever document is bound, so it rides showTime — which survives a scene recall,
  // exactly like the audio bed. (Mirror windows do not RUN this clock; they are TOLD it over the transport
  // bridge — see setExternalShowTime. Without that, this line would freeze every projector effect at 0.)
  return contentSource.getDrawable(s.id, s.content, timeline.getShowTime());
}
```

- [ ] **Step 4: Let a mirror window be TOLD the show clock**

In `src/renderer/services/timeline.ts`, add to the public API (beside `showSeek`):

```ts
  // MIRROR WINDOWS DO NOT RUN THE SHOW CLOCK — THEY ARE TOLD IT, at ~30 Hz over the transport bridge,
  // exactly as they are told the playhead. Re-anchoring on every message keeps the projector locked to the
  // main window with no drift; the frame loop interpolates between messages so a 60 fps effect surface does
  // not judder at 30 Hz. It never runs the loop / end-stop logic — the main window owns those and streams
  // the RESULT. (showSeek() refuses in external mode, deliberately: a mirror must never MOVE the show.)
  setExternalShowTime(sec: number): void {
    if (!external) return;
    showTime = sec;
    showOriginMs = performance.now() - sec * 1000;
  },
```

And in the frame loop, beside the existing `if (!external) { …show clock… }` block (line 695), add the mirror arm:

```ts
    } else if (playing) {
      // Interpolate between bridge messages. No clamping, no wrap, no end-stop: the main window already
      // applied all of that and sent us the answer.
      showTime = (now - showOriginMs) / 1000;
    }
```

- [ ] **Step 5: Stream it**

`src/renderer/App.tsx:1936`:

```tsx
          const msg = { t: 'transport' as const, playing: timelineEngine.isPlaying(), playhead, showTime: timelineEngine.getShowTime() };
```

`src/renderer/projector/ProjectorApp.tsx:141`:

```tsx
          engine.setPlaying(m.playing); engine.seek(m.playhead); engine.setExternalShowTime(m.showTime);
```

Update the message type wherever it is declared (`grep -rn "t: 'transport'" src/` and follow the type) so `tsc` is satisfied.

- [ ] **Step 6: Verify in the app — this is the bug you reported**

1. `npm run dev` → `WAVE3-ACCEPT` → put an **EFFECT** on a surface (one that visibly animates).
2. **Play.** The effect animates.
3. **Pause.** → **The effect must FREEZE.** (Today it keeps animating — that is the bug.)
4. **Resume.** It continues from where it stopped.
5. **Scrub the ruler while paused.** The effect must **follow**.
6. **Stop.** It must return to its t=0 state.
7. Open a **windowed projector output** (Outputs ▸ *"Windowed (this screen)"*). Play. **The projector's effect must be at the same phase as the Stage preview** — they must animate in lockstep, not drift. Pause: **both** freeze.

- [ ] **Step 7: Gates + commit**

`npx tsc --noEmit` → 0. `npm run build` → 0. `node scratch/effectclock-sim.mjs` → PASS. `node scratch/showclock-sim.mjs` → still green.

`fix(surfaces): an effect must ride the transport — pausing the show now freezes the picture`

---

### Task 11: Close merge gate 2, open merge gate 6, log Wave 4

**Files:**
- Modify: `docs/DEVELOPMENT.md:99-102`
- Modify: `plans/SEQUENCING.md` — the merge-gate table
- Modify: `plans/README.md` — register the Wave 4 backlog additions

**The defect.** `plans/SEQUENCING.md` marks gate 2 (*"It is documented"*) as **✅ landed** — but `docs/DEVELOPMENT.md:99` still says:

> *"**Packaging does not rebuild the engine.** `npm run package` runs `build-audio.cjs --check`, which only asserts the addon exists — it does not build. If `engine.cpp` changed, run `npm run build:audio` before packaging or you ship the old engine."*

while `package.json:24` is `"package": "node scripts/build-audio.cjs && electron-vite build && electron-builder"` — **no `--check`. It builds.** Commit `473d259` changed the behaviour and left the document describing the old one. **Gate 2 exists precisely because "a fresh clone gets a silent app and no way to know why"** — a doc that lies about the build is the failure it was written to prevent.

- [ ] **Step 1: Fix the doc**

`docs/DEVELOPMENT.md`, replace the block at 99-102:

```markdown
**4. Packaging DOES rebuild the engine.** `npm run package` runs `scripts/build-audio.cjs` (no `--check`),
so the addon is compiled from source as part of every package. You do not need to run `npm run build:audio`
first. (`build:native` still calls it with `--optional`, so a Rust-only build does not hard-fail on a
machine with no C++ toolchain. CI starts from a clean clone with no addon at all.)
```

- [ ] **Step 2: Correct the gate table and add gate 6**

In `plans/SEQUENCING.md`, in the Wave 3 merge-gate table:

- Gate 2's status: append `— **re-broken by 473d259 and re-fixed 2026-07-14** (the doc still described the old `--check` contract; the merge review caught it).`
- Add a new row:

```markdown
| **6** | **The merge review's blockers are fixed** | A 16-agent adversarial review of `main...wave-3-audio` (100 commits, 72 code files, ~11k lines) confirmed **39 findings** — 7 blockers, 21 majors, 11 minors. The user triaged the merge bar to *"Wave 3's own defects + the effect clock + two verified additions"*: see [the plan](../docs/superpowers/plans/2026-07-14-wave-3-merge-blockers.md). The rest go to Wave 4. **The gate table above was written before the review existed and did not know about any of this.** | ⏳ in progress |
```

- [ ] **Step 3: Log the out-of-scope findings to Wave 4**

Add the ~30 deferred findings to the Wave 4 backlog in `plans/README.md` / the relevant plan files, each with its file:line and one-line failure scenario. Do **not** create a plan for each; one grouped entry per subsystem is enough. At minimum, these must be written down and must not be lost:

- `timeline.ts:876` — **pre-existing BLOCKER.** `swap()` releases the contentSource for layers the incoming timeline lacks but leaves the outgoing pool's `LayerVid.content` set, so a promoted-again pool refuses to re-acquire and **the layer is black forever.**
- `projectFolder.ts:365/374` — Collect Assets silently leaves any file whose extension is not in `ASSET_CATEGORIES` pointing at the authoring machine, and folds a **failed copy** into the same `skipped` counter as a deliberate no-op.
- `useHistory.ts:47` — every **automated** GO (FSM, scheduler, OSC) and every cue fire pushes an **uncapped deep JSON copy of the whole file** onto the undo stack. Six hours unattended is a leak.
- `Timeline.tsx:458/546` — left-trim clamps `start` at 0 but keeps growing `duration`, on both video and audio clips.
- `transitions.ts:136` — a GO during a running core fade snaps the output to the outgoing fade's endpoint for a frame.
- `App.tsx:285` — `compileAutomation` re-runs when the **audio** target set changes but never when the **core** one does, so a lane the engine has **dropped** still renders with a full curve and a ticking readout, **driving nothing.** *(The user chose the smaller UI fix in Task 7, which does not cure this. The real cure is for the engine to report the value it actually applied, instead of the UI recomputing it.)*
- `engine.cpp:208` — non-spatial clips are summed into **every** device output channel.
- `engine.cpp:309` — `setMasterGain` clamps with `juce::jlimit`, which **passes NaN through unchanged.**
- `audioPeaks.ts:86/91` — waveform peaks decode the **entire** audio file in the renderer with no size cap, and a transient failure becomes a **permanent session-lifetime blacklist** with no user-visible signal.
- `package.json:24` — `package` builds the **audio** engine but neither builds nor checks the **three Rust** addons.

- [ ] **Step 4: Commit**

`docs: gate 2 was falsely green — and gate 6 is the one the gate table never knew about`

---

### Task 12: Regenerate the fixture and rewrite the acceptance script

**Files:**
- Regenerate: `c:\Users\b.recoules\Downloads\_projets\WAVE3-ACCEPT\project.artlux`
- Modify: `docs/superpowers/2026-07-12-wave-3-acceptance.md`

**Why.** Task 5 deletes the timeline-less-scene shape, so **`S-noTL` can no longer be represented.** It is load-bearing in the script at lines ~159, 178, 206-213, 292, 357 and 371, where it is called *"the nastiest reachable form."* Sessions 0, 1 and 2 have **passed**; Sessions 3-12 have **never been run**, so what needs rewriting is mostly tests that have not been executed yet.

The property `S-noTL` protected — **the bed does not restart on a recall** — stays fully covered by tests 2.1 and 2.3 against S1/S2/S3, which own their timelines.

- [ ] **Step 1: Regenerate the fixture without S-noTL**

The generator lives in the session scratchpad (`gen-wave3-project.mjs`). Remove the `S-noTL` scene from the scene list, regenerate, and re-validate:

```bash
node <scratchpad>/gen-wave3-project.mjs
node <scratchpad>/check-wave3-project.mjs
```

Expected: the validator passes and reports **no** scene lacking a `timeline` key.

Then **open it in the app and re-save it**, to confirm it round-trips through the new required-timeline loader without loss.

- [ ] **Step 2: Rewrite the script**

- **Fixture section (~line 159):** delete the `S-noTL` bullet. Replace it with a note: *"Every scene owns its own timeline. The 'plays global' shape was deleted on 2026-07-14 — see [the merge-blocker plan](plans/2026-07-14-wave-3-merge-blockers.md), Task 5 — because it caused two clock blockers and nothing in the UI could create it."*
- **Test 2.2:** rewrite to recall **S3** (which owns a timeline but has no audio of its own) ten times. The bed must not restart. Note in the record that the original 2.2 passed against `S-noTL` **before** the shape was deleted, and that the property is now covered here.
- **Sessions 3, 4, 5:** every *"repeat with S-noTL bound"* / *"the nastiest reachable form"* instruction is retired. Substitute **S1** (looping, with its own audio on `Timeline.audio`) — that is now the sharpest case, because it exercises both audio containers on both clocks at once.
- **Session 3's seek test (~line 357):** keep it. Rewrite the target to **S1**. The hazard it guards — *"an FSM `seek` / OSC `/transport/seek` on entry to a state sets `showTime := 10`"* — is still real; it just no longer needs the deleted shape to reach it.

- [ ] **Step 3: Add the new blocker regressions to the script**

Sessions 0-2 have already passed, so the fixes in this plan need their own manual gates. Add a **Session 2b — the merge-review blockers** with one test per fix:

- **2b.1 — the house fade must not snap.** Global pill, lane on `audio.master.gain` (1.0 @ 0 → 0.15 @ 280). Play to 2:00. **Capture Scene.** GO it. *The master must keep descending. It must NOT jump back to full.*
- **2b.2 — the base lane must be visible.** Under that scene: the panel shows the lane, **dimmed, badged GLOBAL, read-only**, its readout on the **show clock**. Add a scene lane on the same target: the GLOBAL lane goes **struck through**.
- **2b.3 — New Project ends the show.** Play the bed. **File ▸ New Project.** *The room goes silent, the mixer is empty, and the new `.artlux` carries no clip paths into the old project.*
- **2b.4 — the bed must not click on a GO.** Play. GO to S1 ten times. *Not one click or gap in the bed.*
- **2b.5 — a Length edit must not split the clocks.** Global, Loop ON, play to 0:45, set Length 40. *Timecode and bed stay together.*
- **2b.6 — pause freezes the picture.** An EFFECT on a surface. Play, **Pause.** *It freezes.* Scrub: *it follows.* On a windowed projector: *preview and projector are in phase.*
- **2b.7 — a dead device must say so.** (Needs a USB interface.) Play, unplug it. *Amber `no audio device` badge; Preferences ▸ Audio says the device is gone; picking a device brings sound back with no restart.*
- **2b.8 — a corrupt `effects` must not kill the app.** Hand-edit a copy of the fixture: change a bed clip's `"effects": [...]` to `"effects": {"0": {...}}`. Open it. *The app loads. The chain is dropped, not the project.*
- **2b.9 — an interrupted save must not destroy the show.** Save. Confirm no `.tmp` file is left beside the `.artlux`.

- [ ] **Step 4: Commit**

`docs: the acceptance script loses S-noTL and gains the merge-review regressions`

---

## Execution order

Tasks 1 → 2 → 3 → 4 are independent and can land in any order, but **do Task 1 first**: everything after it is edited against a project file the old save path can destroy.

Tasks **5 → 6 → 7 are one chain and must land in order.** Task 5 deletes the state; Task 6 removes the last writer that breaks the invariant; Task 7 closes the visibility gap that 5+6 open. **Do not stop after 6** — that is the state where the data is right and the screen is blank.

Tasks 8 and 9 both rebuild the native engine. **Close the dev app.** Do them back to back so you pay the rebuild once.

Task 10 is independent. Task 11 is documentation. Task 12 depends on Task 5 having landed.

## Definition of done

- All twelve tasks committed.
- `npx tsc --noEmit`, `npm run build`, `npm run build:audio`, `npm run verify:plugins` — all exit 0.
- `scratch/showclock-sim.mjs` (99/99 + the Length-edit case), `laneclock-sim.mjs`, `effectclock-sim.mjs`, `atomicsave-sim.mjs`, `effects-sanitize-sim.mjs`, `videoseek-sim.mjs` — all green.
- **Acceptance script Sessions 2b, 3, 4, 5 pass** (2b is the new one; 3-5 have never been run).
- Merge gate table in `plans/SEQUENCING.md`: gates 1, 2, 5, 6 green; gate 3 (the acceptance script) green through Session 5 at minimum; gate 4 (JUCE licensing) is a **user decision that blocks the first tag, not the merge**.
