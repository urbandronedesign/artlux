# P6 — Multichannel Hardening, Rig Commissioning, Headless Audio · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An eight-speaker installation can be commissioned on a venue machine, by someone who did not author the show, without a code change.

**Architecture:** Three landable chunks, in a forced order. **(1)** The project file stops carrying the machine's configuration — this must land first, because every feature after it adds *more* machine-specific state and would otherwise widen the leak. **(2)** The native engine gains a real device setup (driver type + device name + sample rate + buffer size) instead of always opening the OS default. **(3)** The ambisonic decoder gains a speaker→channel patch and a test tone, so a rig can be identified and wired. ASIO stays an off-by-default build flag; headless is verified and its dead fork deleted.

**Tech Stack:** Electron 42 · React · TypeScript (⚠ `strict` is **OFF** — a green `tsc` is weaker evidence than it looks) · C++17 N-API addon (cmake-js) · JUCE 8.0.14 · libspatialaudio 0.4.0.

**Spec:** [2026-07-14-p6-multichannel-design.md](../specs/2026-07-14-p6-multichannel-design.md) · **Branch:** `p6-audio-multichannel` (cut from `main` @ `cd31dbe`)

## Global Constraints

- **There is NO unit-test framework and none may be added.** The house convention is hand-rolled Node assertion sims in **`scratch/`, which is gitignored** (`.gitignore:51`). TDD still applies: **write the failing sim FIRST, run it, watch it fail, then fix.** Sims **model the logic in plain JS** (see `scratch/newproject-sim.mjs`) rather than importing TypeScript; a sim may also read source text with `readFileSync` as a drift guard (see `scratch/atomicsave-sim.mjs`). Runner: `node scratch/gates.mjs` (add `--native` to include `build:audio`).
- **Gates before every commit:** `npx tsc --noEmit`, `npm run build`, `npm run verify:plugins`. Plus `npm run build:audio` for any task touching `native/`.
- **⚠ THE BUILD TRAP — read this before Task 3.** A running dev app **locks `audio_engine.node`**. MSVC then fails with `LNK1104`, the build **exits non-zero, and silently leaves the STALE `.node` in place** — so a correct fix looks broken and you will debug code that is not running. **CLOSE THE APP before `npm run build:audio`,** and afterwards confirm the addon is newer than your source: `ls -l native/audio-engine/build/Release/audio_engine.node native/audio-engine/src/engine.cpp`.
- **Commit messages state the DEFECT and the ROOT CAUSE**, and label a pre-existing bug honestly as pre-existing. Write the message to a file and use `git commit -F <file>` — PowerShell here-strings mangle multi-line messages.
- **There is no multichannel hardware.** (Established at Wave-3 acceptance test 2.10.) Verification is **synthetic** — a virtual multichannel device, or the built-in output set to **7.1 Surround** in Windows Sound. Say so in the acceptance doc. **A synthetic pass is not a venue pass.**

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/renderer/types.ts` | `AppSettings` (loses `reserveLockedRanges`); new `PatchPolicy` | 1 |
| `src/renderer/services/addressing.ts` | `autoPatch()` takes a `PatchPolicy`, not `AppSettings` | 1 |
| `src/renderer/components/RoutingModal.tsx` | patch-policy checkbox reads a prop, not `settings` | 1 |
| `shared/protocol.ts` | `ProjectData`: drop `settings`, add `reserveLockedRanges` | 1, 2 |
| `src/renderer/App.tsx` | `buildProjectData` / `applyProjectData` / `resetToNewProject`; the 6 `autoPatch` call sites | 1, 2 |
| `native/audio-engine/src/engine.cpp` | device setup, `{type,name}` enumeration, speaker patch, test tone | 3, 5 |
| `native/audio-engine/CMakeLists.txt` | `ARTLUX_ENABLE_ASIO` option | 7 |
| `plugins/audio/src/audioManager.ts` | native binding types + null-safe wrappers | 4, 5 |
| `plugins/audio/src/plugin.main.ts` | IPC handlers | 4, 5 |
| `plugins/audio/src/audioClient.ts` | renderer client | 4, 5 |
| `plugins/audio/src/AudioSettings.tsx` | device/driver/rate/buffer pickers; Speaker check | 4, 6 |
| `plugins/audio/src/plugin.renderer.ts` | startup `configure()` call | 4 |
| `src/renderer/HeadlessRunner.tsx`, `src/renderer/headless.tsx` | **deleted** | 8 |

---

## Task 1: `reserveLockedRanges` moves to the project

**The defect this prevents:** Task 2 removes `settings` from the project file. `reserveLockedRanges` is the **one** show-scoped field inside `AppSettings` — a patch policy governing how auto fixtures are addressed *around* locked ranges. If it is not moved first, Task 2 silently loses it and every project's DMX addressing changes on the next Auto-Patch.

**Files:**
- Modify: `src/renderer/types.ts:975` (remove field), and add `PatchPolicy`
- Modify: `src/renderer/services/addressing.ts:69-76`
- Modify: `src/renderer/components/RoutingModal.tsx:85`
- Modify: `shared/protocol.ts` (`ProjectData`)
- Modify: `src/renderer/App.tsx` — 6 `autoPatch` call sites (`:590, :596, :607, :612, :624, :629`), `buildProjectData:1174`, `applyProjectData:1203`, `resetToNewProject`
- Test: `scratch/patchpolicy-sim.mjs`

**Interfaces:**
- Produces: `PatchPolicy { reserveLockedRanges: boolean }` (exported from `types.ts`); `autoPatch(fixtures, controllers, policy: PatchPolicy, defaultControllerId?)`; `ProjectData.reserveLockedRanges?: boolean`; `readPatchPolicy(data: any): PatchPolicy` (exported from `types.ts`).

### ⚠ The trap: why `PatchPolicy.reserveLockedRanges` is REQUIRED, not optional

`autoPatch`'s third parameter is today `settings?: AppSettings`. If you change it to an **all-optional** type — `policy?: { reserveLockedRanges?: boolean }` — then **every existing call site still type-checks**, because an object with all-optional properties structurally accepts *any* object, including an `AppSettings` that no longer has the field. The flag would read `undefined` forever and `tsc` would stay green. **`strict` is off in this repo; a green `tsc` proves less than you think.**

Making the property **required** is what forces `tsc` to name all six call sites.

- [ ] **Step 1: Write the failing sim**

Create `scratch/patchpolicy-sim.mjs`:

```js
// reserveLockedRanges is the ONE show-scoped field inside AppSettings. Task 2 stops persisting
// AppSettings to the project file, so this field must move to ProjectData first — or every project's
// DMX addressing silently changes on the next Auto-Patch.
//
// This sim models readPatchPolicy(): the new field wins; a LEGACY project (which carried the flag inside
// data.settings) must still be honoured; absent means false.

let fail = 0;
const ok = (c, label, detail = '') => {
  console.log(`   ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  --  ' + detail : ''}`);
  if (!c) fail++;
};

// THE MODEL — mirror of readPatchPolicy() in src/renderer/types.ts.
const readPatchPolicy = (data) => {
  const legacy = data?.settings?.reserveLockedRanges;
  return {
    reserveLockedRanges:
      typeof data?.reserveLockedRanges === 'boolean' ? data.reserveLockedRanges
      : typeof legacy === 'boolean' ? legacy
      : false,
  };
};

console.log('\n readPatchPolicy — the migration');
ok(readPatchPolicy({ reserveLockedRanges: true }).reserveLockedRanges === true,
   'new field, true');
ok(readPatchPolicy({ reserveLockedRanges: false }).reserveLockedRanges === false,
   'new field, false');
ok(readPatchPolicy({ settings: { reserveLockedRanges: true } }).reserveLockedRanges === true,
   'LEGACY project — the flag lived inside settings, and must survive the move');
ok(readPatchPolicy({}).reserveLockedRanges === false,
   'absent ⇒ false (the documented default)');
ok(readPatchPolicy({ reserveLockedRanges: false, settings: { reserveLockedRanges: true } }).reserveLockedRanges === false,
   'BOTH present ⇒ the new field wins (a re-saved project must not resurrect the legacy value)');
ok(readPatchPolicy(null).reserveLockedRanges === false,
   'null data ⇒ false, not a throw');

console.log(fail === 0 ? '\n patchpolicy-sim: ALL PASS\n' : `\n patchpolicy-sim: ${fail} FAILED\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it — it must FAIL**

Run: `node scratch/patchpolicy-sim.mjs`

It will **PASS**, because the model is self-contained. That is expected and it is **not** the test's point: this sim pins the migration table *before* you write the real `readPatchPolicy`, so the implementation has a spec to match rather than the other way round. **Copy the model verbatim into `types.ts` in Step 3 — if you find yourself editing the sim to match the code, you have inverted the test.**

- [ ] **Step 3: Add `PatchPolicy` + `readPatchPolicy` and remove the field from `AppSettings`**

In `src/renderer/types.ts`, **delete** lines 974-977 (the `// Patch policy` comment and `reserveLockedRanges?: boolean;`) from `AppSettings`, and add near the other `normalize*` helpers:

```ts
// ── PATCH POLICY — the ONE show-scoped field that used to live in AppSettings ────────────────────────
// AppSettings is THE MACHINE (see its own header) and is no longer written to a project file. This flag
// is not the machine: it governs how THIS PROJECT'S auto fixtures are addressed around its locked ranges,
// so it must travel WITH the show or the same rig patches differently on a different laptop.
//
// ⚠ `reserveLockedRanges` is REQUIRED here, and that is load-bearing. autoPatch() used to take
// `settings?: AppSettings`. An all-OPTIONAL policy type would structurally accept an AppSettings that no
// longer has the field — every call site would still compile, the flag would read `undefined` forever,
// and tsc would stay green. `strict` is off in this repo; a green tsc is weaker evidence than it looks.
// Required ⇒ the compiler names every call site.
export interface PatchPolicy {
  reserveLockedRanges: boolean;
}

// The new field wins; LEGACY projects carried the flag inside `data.settings`, which is no longer read
// (see App.tsx applyProjectData). Absent ⇒ false, the documented default.
export function readPatchPolicy(data: any): PatchPolicy {
  const legacy = data?.settings?.reserveLockedRanges;
  return {
    reserveLockedRanges:
      typeof data?.reserveLockedRanges === 'boolean' ? data.reserveLockedRanges
      : typeof legacy === 'boolean' ? legacy
      : false,
  };
}
```

- [ ] **Step 4: Retype `autoPatch`**

In `src/renderer/services/addressing.ts`, change the import to include `PatchPolicy` and replace lines 69-76's head:

```ts
export function autoPatch(
  fixtures: Fixture[],
  controllers: Controller[],
  policy: PatchPolicy,
  defaultControllerId?: string,
): Fixture[] {
  const ctrlById = new Map(controllers.map((c) => [c.id, c]));
  const reserve = policy.reserveLockedRanges;
```

If `AppSettings` is now an unused import in this file, remove it.

- [ ] **Step 5: Run `tsc` and let it name the call sites**

Run: `npx tsc --noEmit`
Expected: **errors at `App.tsx:590, 596, 607, 612, 624, 629`** ("Argument of type 'AppSettings' is not assignable to parameter of type 'PatchPolicy'") and at `RoutingModal.tsx:85` and `addressing.ts` if `AppSettings` is still imported. **If tsc is green here, Step 3's `reserveLockedRanges` is optional — go back and make it required.**

- [ ] **Step 6: Thread the policy through App**

In `src/renderer/App.tsx`, beside the other document state (near `const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);` at `:139`):

```tsx
// Patch policy — SHOW state (it addresses this project's fixtures), not machine state. It used to live in
// AppSettings, which no longer travels in the project file.
const [patchPolicy, setPatchPolicy] = useState<PatchPolicy>({ reserveLockedRanges: false });
```

Replace `settings` with `patchPolicy` in all six `autoPatch(...)` calls (`:590, :596, :607, :612, :624, :629`). In `buildProjectData` (`:1174`) add `reserveLockedRanges: patchPolicy.reserveLockedRanges,`. In `applyProjectData` (`:1203`) add `setPatchPolicy(readPatchPolicy(data));`. In `resetToNewProject`'s returned clean document add `reserveLockedRanges: false,` and call `setPatchPolicy({ reserveLockedRanges: false });`.

In `shared/protocol.ts`, add to `ProjectData`:

```ts
  reserveLockedRanges?: boolean; // patch policy: pack auto fixtures AROUND locked ranges (was AppSettings)
```

- [ ] **Step 7: Fix `RoutingModal`**

`RoutingModal.tsx:85` reads `settings.reserveLockedRanges` and calls `onUpdateSettings({...})`. Give the component `patchPolicy: PatchPolicy` and `onUpdatePatchPolicy: (p: Partial<PatchPolicy>) => void` props, pass them from App (`onUpdatePatchPolicy={(p) => setPatchPolicy(prev => ({ ...prev, ...p }))}`), and change the input to:

```tsx
<input type="checkbox" checked={patchPolicy.reserveLockedRanges} onChange={(e) => onUpdatePatchPolicy({ reserveLockedRanges: e.target.checked })} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
```

- [ ] **Step 8: Gates**

Run: `npx tsc --noEmit && npm run build && npm run verify:plugins && node scratch/patchpolicy-sim.mjs`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -F scratch/msg-t1.txt
```

Message (`scratch/msg-t1.txt`):

```
refactor(patch): move reserveLockedRanges out of AppSettings into the project

DEFECT (latent, enabled by the next commit): AppSettings is about to stop being
written to the project file (it is the machine, not the show — App.tsx:1390 says
so). reserveLockedRanges is the ONE show-scoped field inside it: it governs how
THIS project's auto fixtures pack around its locked ranges. Left where it was, it
would have vanished from every project and the next Auto-Patch would have silently
re-addressed the rig.

ROOT CAUSE: the field was filed by storage location (a settings blob) rather than
by ownership (whose data is it — the machine's, or the show's).

autoPatch()'s policy parameter is REQUIRED, not optional, and that is deliberate:
an all-optional policy type structurally accepts an AppSettings that no longer has
the field, so all six call sites would have compiled clean while the flag read
undefined forever. `strict` is off here; a green tsc had to be forced to mean
something.
```

---

## Task 2: `AppSettings` stops travelling in the project file

**The defect:** Author a show on a laptop in **binaural / 2 ch**. Open it at the venue on a machine configured **octagon / 8 ch**. The instant the project opens, the venue machine flips to binaural stereo — and `App.tsx:2411` writes that back into the machine's prefs, so it **sticks**. The eight-speaker ring plays a headphone mix.

**Root cause:** `App.tsx:1186` writes `settings` **into** the `.artlux`; `App.tsx:1215` merges it back on open — *shallowly*, so the file's whole `plugins` object **replaces** the machine's. `Prefs.appSettings` (`protocol.ts:585`) already persists these per-machine. The project file's copy is a duplicate that overrides the real one.

**Files:**
- Modify: `src/renderer/App.tsx:1186` (remove `settings,`), `:1215` (stop reading it), `resetToNewProject`
- Modify: `shared/protocol.ts` — `ProjectData.settings` removed
- Modify: `src/renderer/types.ts` — document the contract on `AppSettings` and on `AppSettings.plugins`
- Test: `scratch/venue-settings-sim.mjs`

**Interfaces:**
- Consumes: `readPatchPolicy` / `ProjectData.reserveLockedRanges` (Task 1).
- Produces: the invariant every later task depends on — **`AppSettings` is machine-scoped and is never persisted to a project.** Tasks 4 and 6 store the device, driver type, sample rate, buffer size and speaker patch in `AppSettings.plugins.audio` **because of this task**.

- [ ] **Step 1: Write the failing sim**

Create `scratch/venue-settings-sim.mjs`:

```js
// THE VENUE LOAD-IN BUG.
//
// App.tsx:1390 states the contract in this codebase's own words: settings are "the machine, not the show."
// App.tsx:1186 then writes `settings` INTO the .artlux, and :1215 merges it back on open — SHALLOWLY, so
// the file's whole `plugins` object REPLACES the machine's. App.tsx:2411 then writes the result back to
// prefs, so it STICKS.
//
// Author in binaural/2ch on a laptop. Open at the venue on an octagon/8ch rig. The ring plays a headphone
// mix, permanently.
//
// Prefs.appSettings (protocol.ts:585) ALREADY persists these per-machine. The project file's copy is a
// duplicate that overrides the real one. The fix is to delete the duplicate.

let fail = 0;
const ok = (c, label, detail = '') => {
  console.log(`   ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  --  ' + detail : ''}`);
  if (!c) fail++;
};

const LAPTOP_AUTHORED = {                      // what the author's machine looked like
  artNetIp: '192.168.1.50',
  plugins: { audio: { outputChannels: 2, outputMode: 'binaural', speakerLayout: 'stereo' } },
};
const VENUE_MACHINE = {                        // what the show machine is configured for
  artNetIp: '10.0.0.7',
  plugins: { audio: { outputChannels: 8, outputMode: 'speakers', speakerLayout: 'octagon' } },
};

// ── THE OLD BEHAVIOUR (what we are deleting) ──────────────────────────────────────────────────────────
const openOld = (machine, file) => (file.settings ? { ...machine, ...file.settings } : machine);
// ── THE NEW BEHAVIOUR: the file has no settings, and a legacy file's settings are IGNORED ─────────────
const openNew = (machine, _file) => machine;

const legacyFile = { version: '1.2', settings: LAPTOP_AUTHORED };  // authored before this commit
const newFile = { version: '1.2' };                                 // authored after (no settings key)

console.log('\n the venue load-in — a project must not reconfigure the building');

const old = openOld(VENUE_MACHINE, legacyFile);
ok(old.plugins.audio.speakerLayout === 'stereo',
   'OLD: the laptop\'s stereo layout overwrote the venue\'s octagon', 'this is the bug, reproduced');
ok(old.artNetIp === '192.168.1.50',
   'OLD: the laptop\'s Art-Net IP overwrote the venue\'s', 'DMX would have gone to the wrong subnet too');

const fixedLegacy = openNew(VENUE_MACHINE, legacyFile);
ok(fixedLegacy.plugins.audio.speakerLayout === 'octagon',
   'NEW: a LEGACY file still carrying settings is IGNORED — the venue keeps octagon');
ok(fixedLegacy.plugins.audio.outputChannels === 8,
   'NEW: the venue keeps its 8 channels');
ok(fixedLegacy.artNetIp === '10.0.0.7',
   'NEW: the venue keeps its Art-Net target');

const fixedNew = openNew(VENUE_MACHINE, newFile);
ok(fixedNew.plugins.audio.speakerLayout === 'octagon',
   'NEW: a file authored after this commit carries no settings at all');

// The single-machine case must be UNCHANGED — prefs already hold these values.
const SAME = { ...VENUE_MACHINE };
ok(JSON.stringify(openNew(SAME, newFile)) === JSON.stringify(SAME),
   'one machine, no change: prefs already held these values, so nothing moves');

console.log(fail === 0 ? '\n venue-settings-sim: ALL PASS\n' : `\n venue-settings-sim: ${fail} FAILED\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `node scratch/venue-settings-sim.mjs`
Expected: **ALL PASS.** The two `OLD:` assertions *assert the bug exists* — they are the reproduction. The `NEW:` assertions pin the contract you are about to implement.

- [ ] **Step 3: Add the drift guard**

This is the half a behavioural model cannot cover: `buildProjectData` closes over React state and cannot be imported. The field list has **already drifted three times** (`App.tsx:1398`). Guard it in source. Append to `scratch/venue-settings-sim.mjs`:

```js
// ── DRIFT GUARD (source-level; precedent: scratch/atomicsave-sim.mjs) ──────────────────────────────────
// buildProjectData() closes over React state and cannot be imported, so the behavioural model above cannot
// see the real thing. This field list has ALREADY DRIFTED THREE TIMES (App.tsx:1398). Read the source.
import { readFileSync } from 'node:fs';

const app = readFileSync('src/renderer/App.tsx', 'utf-8');
const build = app.slice(app.indexOf('const buildProjectData = () => ({'));
const body = build.slice(0, build.indexOf('});') + 3);

ok(!/^\s*settings,\s*$/m.test(body),
   'buildProjectData does NOT write `settings` into the project file');
ok(/reserveLockedRanges/.test(body),
   'buildProjectData DOES write reserveLockedRanges (the one show field rescued in Task 1)');
ok(!/data\?\.settings|data\.settings/.test(app.slice(app.indexOf('const applyProjectData'), app.indexOf('const applyProjectData') + 4000)),
   'applyProjectData does NOT merge the file\'s settings over the machine\'s');

console.log(fail === 0 ? '\n venue-settings-sim: ALL PASS\n' : `\n venue-settings-sim: ${fail} FAILED\n`);
process.exit(fail === 0 ? 0 : 1);
```

Delete the earlier `console.log`/`process.exit` pair so the file exits once, at the end.

- [ ] **Step 4: Run the guard — it must FAIL**

Run: `node scratch/venue-settings-sim.mjs`
Expected: **FAIL** — `buildProjectData does NOT write settings` and `applyProjectData does NOT merge...` both fail, because the code still does both. **This is the real failing test.**

- [ ] **Step 5: Delete the duplicate**

In `src/renderer/App.tsx`:
- `:1186` — **delete** the `settings,` line from `buildProjectData`.
- `:1215` — **delete** `if (data?.settings) setSettings(prev => ({ ...prev, ...data.settings }));` and put the contract in its place:

```tsx
      // ── A PROJECT DOES NOT RECONFIGURE THE BUILDING ────────────────────────────────────────────────
      // `settings` is NOT read from the file, and `buildProjectData` no longer writes it. AppSettings is
      // the MACHINE — the sound card, the Art-Net target, the OSC port — and `Prefs.appSettings` already
      // persists it per-machine. Carrying a second copy in the .artlux meant OPENING A SHOW REPATCHED THE
      // VENUE: a project authored in binaural/2ch flipped an octagon/8ch rig to a headphone mix, and
      // :2411 wrote that back to prefs so it stuck.
      //
      // Legacy files still HAVE a `settings` key. It is deliberately ignored — that is the fix, not an
      // oversight. The one show-scoped field it used to hold is rescued by readPatchPolicy() below.
      setPatchPolicy(readPatchPolicy(data));
```

In `shared/protocol.ts`, **remove** `settings: unknown;` from `ProjectData` and leave a tombstone:

```ts
  // `settings` REMOVED (P6): AppSettings is the machine, not the show — it lives in Prefs.appSettings.
  // Legacy files still carry the key; it is ignored on load. See App.tsx applyProjectData.
```

In `resetToNewProject`'s returned clean document, **remove** any `settings` entry if present.

- [ ] **Step 6: Document the contract on the type**

In `src/renderer/types.ts`, above `export interface AppSettings` (`:954`):

```ts
// ── THE MACHINE, NOT THE SHOW ───────────────────────────────────────────────────────────────────────
// AppSettings describes THIS COMPUTER and THIS BUILDING: the sound card, the Art-Net target, the OSC
// listener, the output gamma. It is persisted in `Prefs.appSettings` (per-machine) and is **NEVER written
// to a project file** — opening a show must not repatch the venue. (It used to be written to both, and the
// file's copy won: a project authored in binaural/2ch flipped an octagon rig to a headphone mix.)
//
// Adding a field here? Ask whose data it is. If the answer is "the show's", it belongs in ProjectData —
// as `reserveLockedRanges` now does.
```

And on `plugins` (`:981`), append to the existing comment:

```ts
  // ⚠ MACHINE-SCOPED, like everything else in AppSettings: this namespace is NOT persisted to a project
  // file. Its three consumers today are all hardware/network prefs — `audio` (the output device),
  // `show-control` (the LAN port + PIN), `mediapipe` (the camera). A plugin needing PER-PROJECT data puts
  // it in ProjectData, not here; anything left here does not travel with the show.
  plugins?: Record<string, unknown>;
```

- [ ] **Step 7: Gates**

Run: `npx tsc --noEmit && npm run build && npm run verify:plugins && node scratch/venue-settings-sim.mjs && node scratch/patchpolicy-sim.mjs`
Expected: all green, drift guard now passing.

- [ ] **Step 8: Manual check — the one thing the sim cannot see**

1. `npm run dev`. Preferences ▸ Audio → set **Speaker layout / octagon / 8ch**. Close Preferences.
2. **File ▸ Save As** → `venue-test.artlux`.
3. Preferences ▸ Audio → set **Binaural / 2ch**. File ▸ **Save As** → `laptop-test.artlux`.
4. **Open `venue-test.artlux`.** Preferences ▸ Audio must **still say Binaural / 2ch** — the machine's current setting — **not** octagon. The project did not reconfigure the machine.
5. Open the two `.artlux` files in a text editor: **neither contains a `"settings"` key.**

- [ ] **Step 9: Commit**

Message (`scratch/msg-t2.txt`):

```
fix(persistence): a project no longer reconfigures the machine that opens it

DEFECT: opening a show REPATCHED THE BUILDING. Author on a laptop in binaural/2ch,
open at the venue on a machine configured octagon/8ch, and the instant the project
loaded the venue flipped to binaural stereo — an eight-speaker ring playing a
headphone mix. App.tsx:2411 then wrote that back into the machine's prefs, so it
STUCK. The Art-Net target and the OSC port travelled the same way.

ROOT CAUSE: AppSettings was persisted TWICE — in Prefs.appSettings (correct,
per-machine) and again inside the .artlux (App.tsx:1186) — and on open the FILE's
copy won (App.tsx:1215, a shallow merge, so the file's whole `plugins` object
replaced the machine's). App.tsx:1390 already stated the contract in as many words
— settings are "the machine, not the show" — while the code two lines up did the
opposite.

FIX: delete the duplicate. `settings` is no longer written to a project and no
longer read from one; legacy files keep the key and it is IGNORED. The one
show-scoped field it held (reserveLockedRanges) moved to ProjectData in the
previous commit.

Rejected: a MACHINE_KEYS list stripped on read and write. It would exist to protect
a single field, and App.tsx:1398 records that an override list in this exact
function HAS ALREADY FAILED THREE TIMES. Moving the one field leaves no list to
drift.

BREAKING: opening a project no longer changes this machine's outputs. Same machine,
no visible change (prefs already held these values). Across machines, the venue now
keeps its own sound card, Art-Net target and OSC port — which is the point.
```

---

## Task 3: The engine can open a named device (native)

**⚠ CLOSE THE DEV APP before this task.** See Global Constraints.

**The defect:** ArtLux has never been able to choose an output device. `engine.cpp:549` is `initialiseWithDefaultDevices(0, ch)` — always the OS default. Plug an 8-channel interface into a venue machine and ArtLux plays the laptop speakers. The **Reconnect** button re-opens the *default*, so the only recovery gesture in the app can send sound to the wrong box.

**Root cause of the multichannel gap** — and it is *not* the missing ASIO the P6 heading assumed: **WASAPI exclusive mode**, which is what delivers discrete 8-channel output on Windows, **is already compiled into the addon and already enumerated** (JUCE 8.0.14 registers shared / exclusive / shared-low-latency / DirectSound at `juce_AudioDeviceManager.cpp:328-331`). Nothing selects it. And `engine.cpp:589`'s `names.removeDuplicates(false)` then collapses the four driver types one device is listed under into a single row, **destroying the only thing that told them apart.**

**Files:**
- Modify: `native/audio-engine/src/engine.cpp` — `Engine::configure` (`:529-564`), `listOutputDevices` (`:584-591`), the `Configure` (`:690-699`) and `GetDevices` (`:701-707`) N-API bindings
- Test: `scratch/devicesetup-sim.mjs`

**Interfaces:**
- Produces (the N-API surface Task 4 consumes):
  - `configure(cfg) → { deviceName, deviceType, sampleRate, bufferSize, channels }` — the setup **actually opened**, which may differ from what was asked (a device can open with fewer channels or a different rate). `cfg = { deviceType?, deviceName?, channels?, sampleRate?, bufferSize?, mode?, layout? }`; an empty/absent `deviceName` means *that type's default device* (today's behaviour, preserved).
  - `getDevices() → { type: string, name: string, isDefault: boolean }[]`.

- [ ] **Step 1: Write the failing sim**

Create `scratch/devicesetup-sim.mjs`:

```js
// ARTLUX HAS NEVER BEEN ABLE TO CHOOSE AN OUTPUT DEVICE.
//
// engine.cpp:549 is initialiseWithDefaultDevices(0, ch) — always the OS default. In a venue you plug in an
// 8-channel interface and ArtLux plays the laptop speakers. The Reconnect button (added in the Wave-3 merge
// pass) re-opens the DEFAULT, so the one recovery gesture in the app can send sound to the wrong box.
//
// And the multichannel lever was never ASIO: WASAPI EXCLUSIVE mode is already compiled in and already
// enumerated (JUCE 8.0.14, juce_AudioDeviceManager.cpp:328-331). Nothing selects it — and
// engine.cpp:589's removeDuplicates() collapses the four driver types a device is listed under into ONE
// row, destroying the only thing that told them apart.

let fail = 0;
const ok = (c, label, detail = '') => {
  console.log(`   ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  --  ' + detail : ''}`);
  if (!c) fail++;
};

// What JUCE actually enumerates on a Windows box with one interface + the built-in card.
const RAW = [
  { type: 'Windows Audio',                  name: 'Speakers (Realtek)' },
  { type: 'Windows Audio',                  name: 'MOTU UltraLite' },
  { type: 'Windows Audio (Exclusive Mode)', name: 'Speakers (Realtek)' },
  { type: 'Windows Audio (Exclusive Mode)', name: 'MOTU UltraLite' },
  { type: 'DirectSound',                    name: 'Speakers (Realtek)' },
  { type: 'DirectSound',                    name: 'MOTU UltraLite' },
];

console.log('\n enumeration — the dedupe destroys the driver type');
const OLD = [...new Set(RAW.map((d) => d.name))];               // engine.cpp:589 today
ok(OLD.length === 2, 'OLD: six rows collapse to two names', OLD.join(', '));
ok(!OLD.some((n) => /Exclusive/.test(n)),
   'OLD: EXCLUSIVE MODE IS UNREACHABLE — the row that carries discrete 8ch is gone');

const NEW = RAW;                                                 // {type,name} pairs, no dedupe across types
ok(NEW.length === 6, 'NEW: every (type, device) pair survives');
ok(NEW.some((d) => d.type === 'Windows Audio (Exclusive Mode)' && d.name === 'MOTU UltraLite'),
   'NEW: the interface is selectable in EXCLUSIVE mode — the multichannel path');

console.log('\n configure() — what you ASK for is not what you GET');
// The device can open with fewer channels than requested (8 on a stereo card gives 2) or at a different
// rate. configure() must return what was ACTUALLY opened, or the UI reports a rig that does not exist.
const openDevice = (req, caps) => ({
  deviceType: req.deviceType,
  deviceName: req.deviceName || caps.defaultName,
  channels: Math.min(req.channels ?? 2, caps.maxChannels),
  sampleRate: caps.rates.includes(req.sampleRate) ? req.sampleRate : caps.rates[0],
  bufferSize: caps.buffers.includes(req.bufferSize) ? req.bufferSize : caps.buffers[0],
});

const STEREO_CARD = { defaultName: 'Speakers (Realtek)', maxChannels: 2, rates: [48000], buffers: [480] };
const EIGHT_CH = { defaultName: 'MOTU UltraLite', maxChannels: 8, rates: [44100, 48000, 96000], buffers: [128, 256, 512] };

const got = openDevice({ deviceType: 'Windows Audio (Exclusive Mode)', deviceName: 'MOTU UltraLite', channels: 8, sampleRate: 48000, bufferSize: 256 }, EIGHT_CH);
ok(got.channels === 8 && got.sampleRate === 48000 && got.bufferSize === 256,
   'the 8ch interface opens as asked, at a PINNED rate and buffer');

const short = openDevice({ deviceType: 'Windows Audio', deviceName: '', channels: 8, sampleRate: 96000, bufferSize: 128 }, STEREO_CARD);
ok(short.channels === 2,
   'a stereo card asked for 8ch reports 2 BACK', 'the UI must show what it GOT, not what it asked for');
ok(short.sampleRate === 48000 && short.bufferSize === 480,
   'an unsupported rate/buffer falls back, and says so');
ok(short.deviceName === 'Speakers (Realtek)',
   'an EMPTY deviceName means "that type\'s default" — today\'s behaviour, preserved');

console.log('\n the idempotence guard must key on the WHOLE setup');
// engine.cpp:547 returns early when the CHANNEL COUNT matches. Change only the device (same channel count)
// and the early return fires: the picker would appear to work and change nothing.
const sameChannels = (a, b) => a.channels === b.channels;                                  // today
const sameSetup = (a, b) => a.channels === b.channels && a.deviceName === b.deviceName
  && a.deviceType === b.deviceType && a.sampleRate === b.sampleRate && a.bufferSize === b.bufferSize;
const A = { deviceType: 'Windows Audio', deviceName: 'Speakers (Realtek)', channels: 2, sampleRate: 48000, bufferSize: 480 };
const B = { ...A, deviceName: 'MOTU UltraLite' };
ok(sameChannels(A, B) === true,
   'OLD guard: switching DEVICE at the same channel count looks "already open"', 'the picker would do NOTHING');
ok(sameSetup(A, B) === false,
   'NEW guard: the setup differs ⇒ reopen');

console.log(fail === 0 ? '\n devicesetup-sim: ALL PASS\n' : `\n devicesetup-sim: ${fail} FAILED\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `node scratch/devicesetup-sim.mjs`
Expected: **ALL PASS.** This sim's job is to pin the contract — in particular the **idempotence-guard trap**: `engine.cpp:547` returns early when only the *channel count* matches, so a device picker built on top of it would appear to work and **change nothing**. That is the bug this sim exists to prevent you shipping.

- [ ] **Step 3: Rewrite `Engine::configure`**

In `native/audio-engine/src/engine.cpp`, replace `configure` (`:529-564`). Keep the dead-device invalidation comment block — it is still true and still load-bearing.

```cpp
  struct DeviceCfg {
    juce::String type;    // '' = keep the current device type
    juce::String name;    // '' = that type's default device
    int channels = 2;
    double sampleRate = 0; // 0 = the device's default
    int bufferSize = 0;    // 0 = the device's default
    OutMode mode = OutMode::Binaural;
    juce::String layout { "stereo" };
  };

  struct OpenedCfg { juce::String deviceName, deviceType; double sampleRate = 0; int bufferSize = 0; int channels = 0; };

  juce::String configure(const DeviceCfg& c, OpenedCfg& out) {
    // Decode mode/layout is applied live (decoder-only) — changing it never reopens the device.
    bus.setMode(c.mode, c.layout);
    const int ch = juce::jlimit(1, 64, c.channels);

    // ⚠ THE DEVICE CAN DIE UNDER US, AND `opened` DOES NOT KNOW. Nothing sets it false when the HARDWARE
    // goes away — a bumped USB cable, a driver reload, a Windows power-management cycle. JUCE knows
    // (getCurrentAudioDevice() returns nullptr); the engine simply never asked. Without this line the
    // Reconnect button takes the early return below and does nothing, and the only way back is a restart.
    if (deviceManager.getCurrentAudioDevice() == nullptr) opened = false;

    // ⚠ THE GUARD KEYS ON THE WHOLE SETUP, NOT JUST THE CHANNEL COUNT. It used to compare `ch` alone —
    // so SWITCHING DEVICE at the same channel count (the entire point of a device picker) would have hit
    // this early return and CHANGED NOTHING. The picker would have looked wired and been inert.
    if (opened && ch == openedChannels && c.type == openedType && c.name == openedName
        && c.sampleRate == openedRate && c.bufferSize == openedBuffer) {
      out = lastOpened;
      return {}; // already open on exactly this config — don't interrupt playback
    }

    if (opened) { deviceManager.removeAudioCallback(&player); player.setSource(nullptr); deviceManager.closeAudioDevice(); opened = false; }

    // First call: initialise() is what builds the device-type list that setCurrentAudioDeviceType() needs.
    if (!initialised) {
      deviceManager.initialise(0, ch, nullptr, true);
      initialised = true;
    }
    if (c.type.isNotEmpty() && c.type != deviceManager.getCurrentAudioDeviceType())
      deviceManager.setCurrentAudioDeviceType(c.type, true);

    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager.getAudioDeviceSetup(setup);
    setup.outputDeviceName = c.name;      // '' ⇒ the type's default device
    setup.inputDeviceName = {};
    setup.sampleRate = c.sampleRate;      // 0 ⇒ device default
    setup.bufferSize = c.bufferSize;      // 0 ⇒ device default
    setup.useDefaultInputChannels = false;
    setup.inputChannels.clear();
    setup.useDefaultOutputChannels = false;
    setup.outputChannels.clear();
    setup.outputChannels.setRange(0, ch, true);
    juce::String err = deviceManager.setAudioDeviceSetup(setup, true);
    if (err.isNotEmpty()) return err;

    // The device can open with FEWER channels than we asked for (8 on a stereo card gives 2), and at a
    // different rate/buffer than requested. The master chain must be built for what we ACTUALLY got, or it
    // sees a channel-count mismatch every block and passes dry. Push it BEFORE addAudioCallback — that is
    // what triggers prepareToPlay, which builds it.
    int actual = ch;
    if (auto* dev = deviceManager.getCurrentAudioDevice()) {
      actual = juce::jmax(1, dev->getActiveOutputChannels().countNumberOfSetBits());
      out.deviceName = dev->getName();
      out.sampleRate = dev->getCurrentSampleRate();
      out.bufferSize = dev->getCurrentBufferSizeSamples();
    }
    out.deviceType = deviceManager.getCurrentAudioDeviceType();
    out.channels = actual;
    bus.setOutputChannels(actual);
    if (!readThread.isThreadRunning()) readThread.startThread();
    player.setSource(&metering);
    deviceManager.addAudioCallback(&player);
    opened = true;
    openedChannels = ch; openedType = c.type; openedName = c.name;
    openedRate = c.sampleRate; openedBuffer = c.bufferSize;
    lastOpened = out;
    return {};
  }
```

Add the new members beside `opened` / `openedChannels`:

```cpp
  bool initialised = false;
  juce::String openedType, openedName;
  double openedRate = 0;
  int openedBuffer = 0;
  OpenedCfg lastOpened;
```

- [ ] **Step 4: Rewrite `listOutputDevices`**

Replace `:584-591`:

```cpp
  struct DeviceEntry { juce::String type, name; bool isDefault; };

  // ⚠ NO removeDuplicates(). One physical interface is enumerated under FOUR driver types — WASAPI shared,
  // WASAPI exclusive, WASAPI shared-low-latency, DirectSound — all under the SAME NAME. The old dedupe
  // collapsed them into one row and threw away the only thing that told them apart, which is why EXCLUSIVE
  // MODE — the thing that delivers discrete 8-channel output on Windows — was already compiled in, already
  // enumerated, and completely unreachable.
  std::vector<DeviceEntry> listOutputDevices() {
    std::vector<DeviceEntry> out;
    juce::OwnedArray<juce::AudioIODeviceType> types;
    deviceManager.createAudioDeviceTypes(types);
    for (auto* t : types) {
      t->scanForDevices();
      const auto names = t->getDeviceNames(false);
      const int def = t->getDefaultDeviceIndex(false);
      for (int i = 0; i < names.size(); ++i)
        out.push_back({ t->getTypeName(), names[i], i == def });
    }
    return out;
  }
```

- [ ] **Step 5: Rewrite the N-API bindings**

Replace `Configure` (`:690-699`) and `GetDevices` (`:701-707`):

```cpp
// configure(cfg) — cfg: { deviceType?, deviceName?, channels?, sampleRate?, bufferSize?, mode?, layout? }
// Returns the setup ACTUALLY OPENED: { deviceName, deviceType, sampleRate, bufferSize, channels }. It can
// differ from what was asked (a stereo card asked for 8ch reports 2 back) and the UI must show what it GOT.
static Napi::Value Configure(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  Napi::Object o = info.Length() > 0 && info[0].IsObject() ? info[0].As<Napi::Object>() : Napi::Object::New(env);
  const auto str = [&](const char* k, const char* dflt) -> std::string {
    return o.Has(k) && o.Get(k).IsString() ? o.Get(k).As<Napi::String>().Utf8Value() : std::string(dflt);
  };
  const auto num = [&](const char* k, double dflt) -> double {
    return o.Has(k) && o.Get(k).IsNumber() ? o.Get(k).As<Napi::Number>().DoubleValue() : dflt;
  };
  Engine::DeviceCfg cfg;
  cfg.type = juce::String(str("deviceType", ""));
  cfg.name = juce::String(str("deviceName", ""));
  cfg.channels = (int) num("channels", 2);
  cfg.sampleRate = num("sampleRate", 0);
  cfg.bufferSize = (int) num("bufferSize", 0);
  cfg.mode = (str("mode", "binaural") == "speakers") ? OutMode::Speakers : OutMode::Binaural;
  cfg.layout = juce::String(str("layout", "stereo"));

  Engine::OpenedCfg got;
  juce::String err = ensureEngine().configure(cfg, got);
  if (err.isNotEmpty()) { Napi::Error::New(env, ("audio configure failed: " + err).toStdString()).ThrowAsJavaScriptException(); return env.Null(); }

  auto r = Napi::Object::New(env);
  r.Set("deviceName", Napi::String::New(env, got.deviceName.toStdString()));
  r.Set("deviceType", Napi::String::New(env, got.deviceType.toStdString()));
  r.Set("sampleRate", Napi::Number::New(env, got.sampleRate));
  r.Set("bufferSize", Napi::Number::New(env, got.bufferSize));
  r.Set("channels", Napi::Number::New(env, got.channels));
  return r;
}

// getDevices() → [{ type, name, isDefault }]. One physical device appears once PER DRIVER TYPE — that is
// the point, not a bug: the type is what decides whether you get discrete multichannel.
static Napi::Value GetDevices(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const auto devs = ensureEngine().listOutputDevices();
  auto arr = Napi::Array::New(env, devs.size());
  for (size_t i = 0; i < devs.size(); ++i) {
    auto d = Napi::Object::New(env);
    d.Set("type", Napi::String::New(env, devs[i].type.toStdString()));
    d.Set("name", Napi::String::New(env, devs[i].name.toStdString()));
    d.Set("isDefault", Napi::Boolean::New(env, devs[i].isDefault));
    arr.Set((uint32_t) i, d);
  }
  return arr;
}
```

`DeviceCfg`, `OpenedCfg` and `DeviceEntry` must be **public** members of `Engine` for the bindings to name them.

- [ ] **Step 6: Build the addon — WITH THE APP CLOSED**

Run: `npm run build:audio`
Expected: exit 0. Then **confirm you are running the code you just wrote** — a failed link leaves the stale `.node` behind and exits non-zero, which is easy to miss in a long log:

Run: `ls -l native/audio-engine/build/Release/audio_engine.node native/audio-engine/src/engine.cpp`
Expected: the `.node` mtime is **newer** than `engine.cpp`. If it is not, the link failed — **re-read the build output for `LNK1104` and close the app.**

- [ ] **Step 7: Gates + commit**

Run: `npx tsc --noEmit && npm run build && npm run verify:plugins && node scratch/devicesetup-sim.mjs`

> `tsc` will still be green here: `audioManager.ts` calls `native.configure(ch, mode, layout)` against a hand-written `interface NativeAudio`, which TypeScript cannot check against the C++. **The JS side is now lying about the addon's signature** and Task 4 fixes it. Do not stop here — the app will throw at runtime until Task 4 lands. If you must stop, stop *after* Task 4.

Message (`scratch/msg-t3.txt`):

```
feat(audio/native): the engine can open a NAMED device on a NAMED driver type

DEFECT: ArtLux has never been able to choose an output device. engine.cpp:549 was
initialiseWithDefaultDevices() — always the OS default. Plug an 8-channel interface
into a venue machine and ArtLux plays the laptop speakers; the only fix was to
change the WINDOWS default. The Reconnect button added in the Wave-3 merge pass
re-opens the DEFAULT too, so the one recovery gesture in the app could send sound
to the wrong box.

ROOT CAUSE, and it is NOT the missing ASIO the P6 plan assumed: WASAPI EXCLUSIVE
mode — which is what delivers discrete 8-channel output on Windows — is ALREADY
compiled into the addon and ALREADY enumerated (JUCE registers shared / exclusive /
shared-low-latency / DirectSound). Nothing ever selected it. engine.cpp:589 then
called removeDuplicates() on the flattened name list, collapsing the four driver
types one device is listed under into a single row and DESTROYING THE ONLY THING
THAT TOLD THEM APART.

configure() now takes a full setup (type, name, channels, sample rate, buffer) and
RETURNS WHAT WAS ACTUALLY OPENED — a stereo card asked for 8 channels reports 2
back, and the UI must show what it got, not what it asked for.

Also fixed, and it would have made the picker inert: the idempotence guard keyed on
the CHANNEL COUNT alone, so switching device at the same channel count — the entire
point of a device picker — took the early return and did nothing.
```

---

## Task 4: The device picker (JS + IPC + UI)

**Files:**
- Modify: `plugins/audio/src/audioManager.ts:43-64` (`NativeAudio`), `:93-96` (wrappers)
- Modify: `plugins/audio/src/plugin.main.ts:17-22`
- Modify: `plugins/audio/src/audioClient.ts:14-17`
- Modify: `plugins/audio/src/AudioSettings.tsx`
- Modify: `plugins/audio/src/plugin.renderer.ts:112-117`

**Interfaces:**
- Consumes: `configure(cfg) → OpenedCfg`, `getDevices() → DeviceEntry[]` (Task 3); `AppSettings.plugins.audio` is machine-scoped (Task 2).
- Produces: `AudioCfg { outputChannels?, outputMode?, speakerLayout?, deviceType?, deviceName?, sampleRate?, bufferSize? }` persisted in `AppSettings.plugins.audio`.

- [ ] **Step 1: Retype the native binding**

In `plugins/audio/src/audioManager.ts`, add above `interface NativeAudio`:

```ts
// The setup we ASK the engine for. An absent deviceName means "that driver type's default device" —
// today's behaviour, preserved. sampleRate/bufferSize of 0 mean "the device's default".
export interface DeviceCfg {
  deviceType?: string;
  deviceName?: string;
  channels?: number;
  sampleRate?: number;
  bufferSize?: number;
  mode?: OutputMode;
  layout?: SpeakerLayout;
}
// What the engine ACTUALLY OPENED — not what we asked for. A stereo card asked for 8 channels reports 2
// back. The UI must render THIS, or Preferences describes a rig that does not exist.
export interface OpenedCfg {
  deviceName: string; deviceType: string; sampleRate: number; bufferSize: number; channels: number;
}
// One physical interface appears once PER DRIVER TYPE. That is the point: the type is what decides whether
// you get discrete multichannel (WASAPI *exclusive*) or a shared mix (WASAPI shared).
export interface DeviceEntry { type: string; name: string; isDefault: boolean }
```

Change the two members of `NativeAudio` and their wrappers:

```ts
  configure(cfg: DeviceCfg): OpenedCfg; // throws on failure
  getDevices(): DeviceEntry[];
```

```ts
const NO_DEVICE: OpenedCfg = { deviceName: '', deviceType: '', sampleRate: 0, bufferSize: 0, channels: 0 };
export function configure(cfg: DeviceCfg): OpenedCfg { return native ? native.configure(cfg) : NO_DEVICE; }
export function getDevices(): DeviceEntry[] { return native ? native.getDevices() : []; }
```

- [ ] **Step 2: Update the IPC handler**

`plugins/audio/src/plugin.main.ts` — replace the `audio:configure` handler (`:17-21`):

```ts
    // configure(cfg) — the WHOLE setup in one object (type, device, channels, rate, buffer, mode, layout).
    // Returns what was ACTUALLY opened, which can differ from what was asked.
    ipc.handle('audio:configure', (cfg) => engine.configure((cfg ?? {}) as engine.DeviceCfg));
```

- [ ] **Step 3: Update the renderer client**

`plugins/audio/src/audioClient.ts` — replace `configure` and `getDevices` (`:14-17`):

```ts
  configure: (cfg: DeviceCfg): Promise<OpenedCfg> =>
    (ipc?.invoke('audio:configure', cfg) as Promise<OpenedCfg>) ??
    Promise.resolve({ deviceName: '', deviceType: '', sampleRate: 0, bufferSize: 0, channels: 0 }),
  getDevices: (): Promise<DeviceEntry[]> =>
    (ipc?.invoke('audio:getDevices') as Promise<DeviceEntry[]>) ?? Promise.resolve([]),
```

Add `DeviceCfg`, `OpenedCfg`, `DeviceEntry` to the type-only import from `./audioManager`.

- [ ] **Step 4: Update the startup configure**

`plugins/audio/src/plugin.renderer.ts:112-117`:

```ts
    // Open the device once on startup, from the MACHINE's persisted setup (AppSettings is machine-scoped —
    // see types.ts; a project can no longer overwrite this). Idempotent engine-side.
    const s0 = host.settings.get() as { plugins?: Record<string, unknown> };
    const cfg = (s0.plugins?.['audio'] as AudioPluginCfg) ?? {};
    void audioClient
      .configure({
        deviceType: cfg.deviceType, deviceName: cfg.deviceName,
        channels: cfg.outputChannels ?? 2, sampleRate: cfg.sampleRate ?? 0, bufferSize: cfg.bufferSize ?? 0,
        mode: cfg.outputMode ?? 'binaural', layout: cfg.speakerLayout ?? 'stereo',
      })
      .catch(() => { /* engine absent → no-op */ });
```

Widen `AudioPluginCfg` (wherever it is declared in that file) to carry `deviceType?: string; deviceName?: string; sampleRate?: number; bufferSize?: number;`.

- [ ] **Step 5: Build the pickers**

In `plugins/audio/src/AudioSettings.tsx`, widen `AudioCfg`, hold the opened setup in state, and replace `apply`:

```tsx
interface AudioCfg {
  outputChannels?: number; outputMode?: OutputMode; speakerLayout?: SpeakerLayout;
  deviceType?: string; deviceName?: string; sampleRate?: number; bufferSize?: number;
}

const [devices, setDevices] = useState<DeviceEntry[]>([]);
// WHAT WE ACTUALLY GOT, not what we asked for. A stereo card asked for 8 channels opens with 2, and a
// panel that renders the REQUEST describes a rig that does not exist. Every readout below reads this.
const [opened, setOpened] = useState<OpenedCfg | null>(null);

const apply = (c: AudioCfg) =>
  audioClient.configure({
    deviceType: c.deviceType, deviceName: c.deviceName,
    channels: c.outputChannels ?? 2, sampleRate: c.sampleRate ?? 0, bufferSize: c.bufferSize ?? 0,
    mode: c.outputMode ?? 'binaural', layout: c.speakerLayout ?? 'stereo',
  })
    .then((got) => { setOpened(got); setDevice(got.deviceName); setError(null); })
    .catch((e) => setError(String(e?.message ?? e)));

// Every picker patches the cfg and re-applies the WHOLE thing — the engine's guard now keys on the whole
// setup, so it reopens only when something actually changed.
const patchAndApply = (p: AudioCfg) => { patchCfg(p); void apply({ ...cfg, ...p }); };
```

Add a **Device** block above *Spatial output*. Group the flat `DeviceEntry[]` by `type` so the driver type is visible — it is the thing that decides whether you get discrete multichannel:

```tsx
<div>
  <div className="text-mini font-semibold text-fg-2 mb-1">Output device</div>
  <select
    value={`${cfg.deviceType ?? ''} ${cfg.deviceName ?? ''}`}
    onChange={(e) => {
      const [deviceType, deviceName] = e.target.value.split(' ');
      patchAndApply({ deviceType, deviceName });
    }}
    className="w-full bg-surface-2 border border-line-1 rounded px-1.5 h-6 text-mini text-fg-1 outline-none"
  >
    <option value={' '}>System default</option>
    {Object.entries(devices.reduce<Record<string, DeviceEntry[]>>((acc, d) => {
      (acc[d.type] ??= []).push(d); return acc;
    }, {})).map(([type, ds]) => (
      <optgroup key={type} label={type}>
        {ds.map((d) => (
          <option key={`${type} ${d.name}`} value={`${type} ${d.name}`}>
            {d.name}{d.isDefault ? ' (default)' : ''}
          </option>
        ))}
      </optgroup>
    ))}
  </select>
  {/* ── THE SENTENCE THAT MAKES MULTICHANNEL POSSIBLE ────────────────────────────────────────────────
      An operator cannot be expected to know that "Windows Audio" and "Windows Audio (Exclusive Mode)"
      are the difference between a stereo downmix and eight discrete outputs. The dropdown groups by
      driver type; this says what the groups MEAN. Do not shorten it to "choose a device". */}
  <div className="text-micro text-fg-3 mt-1">
    Devices are grouped by <span className="text-fg-2">driver type</span>. For a multichannel interface
    choose <span className="text-fg-2">Exclusive Mode</span> — it hands ArtLux the card's discrete outputs.
    Shared mode routes through the Windows mixer and will usually give you stereo, whatever the card can do.
  </div>
  {opened && (
    <div className="text-micro text-fg-3 mt-1">
      Open: <span className="text-fg-1">{opened.deviceName || 'default'}</span> ·{' '}
      {opened.channels} ch · {(opened.sampleRate / 1000).toFixed(1)} kHz · {opened.bufferSize} samples
    </div>
  )}
</div>
```

Add **Sample rate** and **Buffer size** pickers using the same `patchAndApply` idiom, offering `[44100, 48000, 88200, 96000]` and `[128, 256, 512, 1024]` plus a `0 = device default` entry. Wire the existing `setChannels` / `setMode` / `setLayout` handlers to `patchAndApply` as well, and change the "Uses the system default output device." caption (`:198`) — it is now false.

Point the **Reconnect** button (`:145`) at `void apply(cfg)`, and replace its comment: it now re-opens the **named** device, so the recovery gesture reaches the interface that actually vanished. Replace the "Detected output devices" list (`:215-224`) — it was decorative and is now the picker.

Drive the channel meters off `opened.channels` rather than `outCh` (the request).

- [ ] **Step 6: Gates**

Run: `npx tsc --noEmit && npm run build && npm run verify:plugins`
Expected: green.

- [ ] **Step 7: Manual check — the synthetic rig**

1. Set the Windows built-in output to **7.1 Surround** (Sound ▸ Speakers ▸ Configure), or install a virtual multichannel device.
2. `npm run dev` → Preferences ▸ Audio. The device dropdown must be **grouped by driver type**, with the same physical device appearing under *Windows Audio* **and** *Windows Audio (Exclusive Mode)*.
3. Pick the device under **Exclusive Mode**, channels **8**, sample rate **48000**, buffer **256**.
4. The "Open:" line must report **8 ch · 48.0 kHz · 256 samples**. **If it reports 2 ch, the device did not open with 8** — that is a true reading, not a UI bug; check the Windows speaker configuration.
5. Play a bed. **Switch device** in the dropdown. Sound must move to the other device **without a restart** (this is what the whole-setup idempotence guard buys).

- [ ] **Step 8: Commit**

Message (`scratch/msg-t4.txt`):

```
feat(audio): Preferences can pick the output device, driver type, rate and buffer

DEFECT: the "Detected output devices" list in Preferences was DECORATIVE. It
enumerated every device, highlighted the open one, and could not select any of them
— configure() always opened the OS default. A venue plugged in an 8-channel
interface and ArtLux played the laptop speakers.

ROOT CAUSE: listOutputDevices() flattened the driver type out of the enumeration
(see the previous commit), so there was nothing to select WITH; and the panel's
only lever was a channel count.

The dropdown groups by driver type and says what the groups mean, because an
operator cannot be expected to know that "Windows Audio" and "Windows Audio
(Exclusive Mode)" are the difference between a stereo downmix and eight discrete
outputs.

Every readout now renders WHAT WAS OPENED, not what was requested: a stereo card
asked for 8 channels reports 2 back, and the panel says 2. Reconnect re-opens the
NAMED device — so the recovery gesture finally reaches the interface that vanished.
```

---

## Task 5: Speaker patch + test tone (native)

**⚠ CLOSE THE DEV APP.**

**The defect:** Under speaker decode, `engine.cpp:229-231` writes decoder speaker `s` → device channel `s`, **1:1, with no patch**. In a venue the octagon's speaker 1 is rarely on the interface's output 1 — and there is no way to discover which physical box is which. That is the first hour of every install, and today it can only be done by re-plugging cables.

**Files:**
- Modify: `native/audio-engine/src/engine.cpp` — the `Bus` (patch state + tone), the speaker write (`:225-232`), `Engine::configure`, N-API
- Test: `scratch/speakerpatch-sim.mjs`

**Interfaces:**
- Produces: `configure(cfg)` gains `patch?: number[]`; new `setTestTone(deviceChannel: number, gain: number)` (`deviceChannel < 0` ⇒ off).

- [ ] **Step 1: Write the failing sim**

Create `scratch/speakerpatch-sim.mjs`:

```js
// A LAYOUT YOU CANNOT WIRE UP IS A DROPDOWN, NOT A RIG.
//
// engine.cpp:229-231 writes decoder speaker s -> device channel s, 1:1, with no patch. In a venue the
// octagon's speaker 1 is rarely on the interface's output 1, and there is no way to discover which physical
// box is which. Today the only remedy is a ladder and a cable.

let fail = 0;
const ok = (c, label, detail = '') => {
  console.log(`   ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  --  ' + detail : ''}`);
  if (!c) fail++;
};

const OUT_CH = 8;
// Model of the speaker write: decoder speaker s carries energy `e[s]`; where does it land on the device?
const render = (energy, patch) => {
  const dev = new Array(OUT_CH).fill(0);
  for (let s = 0; s < energy.length && s < OUT_CH; s++) {
    const dst = patch ? patch[s] : s;               // no patch ⇒ 1:1 (today)
    if (dst >= 0 && dst < OUT_CH) dev[dst] += energy[s];
  }
  return dev;
};

const only = (s) => Array.from({ length: OUT_CH }, (_, i) => (i === s ? 1 : 0));

console.log('\n the patch');
ok(render(only(3), null)[3] === 1, '1:1 today — speaker 3 lands on channel 3');

// The venue's octagon is wired to the interface in an order nobody chose.
const VENUE = [4, 5, 6, 7, 0, 1, 2, 3];             // decoder speaker s -> device channel VENUE[s]
const patched = render(only(0), VENUE);
ok(patched[4] === 1, 'patched — decoder speaker 0 lands on device channel 4');
ok(patched.filter((v) => v > 0).length === 1, 'and ONLY on channel 4 — no leakage');

// The whole ring must be a permutation: every speaker somewhere, nothing doubled up.
const ring = VENUE.map((_, s) => render(only(s), VENUE).findIndex((v) => v === 1));
ok(new Set(ring).size === OUT_CH, 'every decoder speaker lands on a DISTINCT device channel');
ok(ring.every((c) => c >= 0), 'no speaker is dropped');

console.log('\n the patch must be VALIDATED, not trusted');
// A patch out of range, or short, or duplicated, arrives from persisted prefs — which a human can edit.
const sanitize = (p, n) => {
  const out = Array.from({ length: n }, (_, i) => i);           // identity
  if (!Array.isArray(p)) return out;
  const used = new Set();
  for (let s = 0; s < n; s++) {
    const v = p[s];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n && !used.has(v)) { out[s] = v; used.add(v); }
  }
  // any speaker whose entry was rejected keeps identity — but identity may now COLLIDE with a used channel.
  for (let s = 0; s < n; s++) if (!used.has(out[s])) used.add(out[s]); else if (p?.[s] === undefined) { /* identity kept */ }
  return out;
};
ok(sanitize(null, 8).every((v, i) => v === i), 'a missing patch ⇒ identity');
ok(sanitize([9, 9, 9], 8)[0] === 0, 'out-of-range entries fall back to identity — never write past the buffer');
ok(sanitize([1, 0], 8).slice(0, 2).join() === '1,0', 'a valid partial patch is honoured');

console.log('\n the test tone must BYPASS the decoder');
// A tone routed through the ambisonic encoder/decoder proves the DECODER works — which we already know —
// and proves NOTHING about the patch, which is the thing being commissioned. A test tone that routes
// through the thing under test is not a test.
const toneViaDecoder = (ch) => render(only(ch), VENUE);          // WRONG: goes through the patch AND decode
const toneDirect = (ch) => { const d = new Array(OUT_CH).fill(0); d[ch] = 1; return d; };  // RIGHT
ok(toneDirect(4)[4] === 1 && toneDirect(4).filter((v) => v > 0).length === 1,
   'a direct tone on device channel 4 lights channel 4, and only channel 4');
ok(toneViaDecoder(0)[4] === 1,
   'a tone through the decoder would light channel 4 when you asked for 0 — proving nothing about the wiring');

console.log(fail === 0 ? '\n speakerpatch-sim: ALL PASS\n' : `\n speakerpatch-sim: ${fail} FAILED\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `node scratch/speakerpatch-sim.mjs`
Expected: **ALL PASS** — it pins the patch semantics, the sanitiser, and the one rule that makes the tone worth anything.

- [ ] **Step 3: Patch + tone in the `Bus`**

In the `Bus` class (`engine.cpp`, near `setMode` at `:149`), add — **all under the same `lock` the audio callback already holds at `:172`**, which is the existing control-method contract (`:243`):

```cpp
  // Decoder speaker index → DEVICE CHANNEL. A venue's ring is almost never wired 1:1, and there is no
  // ladder in the audio callback. Sanitised on the way in: an out-of-range or duplicated entry keeps
  // identity, so a hand-edited prefs file can never make the callback write past the buffer.
  void setPatch(const std::vector<int>& p) {
    const juce::ScopedLock sl(lock);
    patch.assign(kMaxSpeakers, -1);
    std::vector<bool> used(kMaxSpeakers, false);
    for (int s = 0; s < kMaxSpeakers; ++s) {
      const int v = s < (int) p.size() ? p[(size_t) s] : s;
      if (v >= 0 && v < kMaxSpeakers && !used[(size_t) v]) { patch[(size_t) s] = v; used[(size_t) v] = true; }
    }
    for (int s = 0; s < kMaxSpeakers; ++s)                       // anything rejected falls back to a free channel
      if (patch[(size_t) s] < 0 && !used[(size_t) s]) { patch[(size_t) s] = s; used[(size_t) s] = true; }
  }

  // ⚠ THE TONE BYPASSES THE DECODER, AND THAT IS THE ENTIRE POINT. It is written straight onto a DEVICE
  // CHANNEL, after the decode and after the master chain. A tone routed through the ambisonic encoder
  // would prove the DECODER works — which we already know — and prove nothing about the PATCH, which is
  // the thing being commissioned. A test tone that routes through the thing under test is not a test.
  //
  // It is written BEFORE metering (the metering source wraps this bus), so the operator sees the channel
  // light up in Preferences — which is how the rig is verified with no hardware at all.
  void setTestTone(int deviceChannel, float g) {
    const juce::ScopedLock sl(lock);
    toneCh = deviceChannel; toneGain = g;
  }
```

Members:

```cpp
  static constexpr int kMaxSpeakers = 64;   // configure() clamps channels to 64; the patch must cover it
  std::vector<int> patch;                   // decoder speaker → device channel (identity by default)
  int toneCh = -1;                          // -1 = off
  float toneGain = 0.0f;
  float pinkB0 = 0, pinkB1 = 0, pinkB2 = 0; // Paul Kellet's economy pink filter — no allocation, no state reset needed
  juce::Random toneRng;
```

Replace the speaker write (`:225-232`):

```cpp
      } else if (mode == OutMode::Speakers && decoderOk && nSpeakers > 0) {
        for (int s = 0; s < nSpeakers; ++s)
          std::fill(speakerBuf[(size_t) s].begin(), speakerBuf[(size_t) s].begin() + n, 0.0f);
        decoder.Process(&bformat, (unsigned) n, speakerPtrs.data());
        for (int s = 0; s < nSpeakers; ++s) {
          const int dst = (s < (int) patch.size()) ? patch[(size_t) s] : s;   // decoder speaker → device channel
          if (dst >= 0 && dst < outCh)                                        // never write past the device
            info.buffer->addFrom(dst, info.startSample, speakerBuf[(size_t) s].data(), n);
        }
      }
```

And at the **very end** of `getNextAudioBlock`, after `masterGain.process(mctx);`:

```cpp
    // ── TEST TONE: post-everything, straight onto a device channel ──────────────────────────────────
    // Deliberately AFTER the master fader: a commissioning tone that the house fader can silence is a tone
    // that will have you checking a speaker cable while the software is muting it.
    if (toneCh >= 0 && toneCh < outCh && toneGain > 0.0f) {
      float* d = info.buffer->getWritePointer(toneCh, info.startSample);
      for (int i = 0; i < n; ++i) {
        const float w = toneRng.nextFloat() * 2.0f - 1.0f;   // white
        pinkB0 = 0.99765f * pinkB0 + w * 0.0990460f;         // → pink (Kellet). Broadband: a speaker is far
        pinkB1 = 0.96300f * pinkB1 + w * 0.2965164f;         //   easier to localise by ear than a sine, and
        pinkB2 = 0.57000f * pinkB2 + w * 1.0526913f;         //   a sine can null against a room mode.
        d[i] += (pinkB0 + pinkB1 + pinkB2 + w * 0.1848f) * 0.2f * toneGain;
      }
    }
```

- [ ] **Step 4: Thread the patch through `configure` + expose the tone**

Add `std::vector<int> patch;` to `Engine::DeviceCfg`, and in `Engine::configure`, beside `bus.setMode(...)`:

```cpp
    bus.setPatch(c.patch);   // live, decoder-only — changing the patch never reopens the device
```

In the `Configure` N-API binding, read the array:

```cpp
  if (o.Has("patch") && o.Get("patch").IsArray()) {
    auto a = o.Get("patch").As<Napi::Array>();
    for (uint32_t i = 0; i < a.Length(); ++i)
      cfg.patch.push_back(a.Get(i).IsNumber() ? a.Get(i).As<Napi::Number>().Int32Value() : (int) i);
  }
```

Add the tone binding and register it in `Init`:

```cpp
// setTestTone(deviceChannel, gain) — deviceChannel < 0 turns it off. Pink noise, straight onto a DEVICE
// CHANNEL, bypassing the decoder and the master fader (see Bus::setTestTone).
static Napi::Value SetTestTone(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const int ch = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Int32Value() : -1;
  const double g = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : 0.5;
  ensureEngine().setTestTone(ch, (float) g);
  return env.Undefined();
}
```

```cpp
  exports.Set("setTestTone", Napi::Function::New(env, SetTestTone));
```

with `void setTestTone(int ch, float g) { bus.setTestTone(ch, g); }` on `Engine`.

- [ ] **Step 5: Build (APP CLOSED) and verify freshness**

Run: `npm run build:audio`
Then: `ls -l native/audio-engine/build/Release/audio_engine.node native/audio-engine/src/engine.cpp`
Expected: exit 0, and the `.node` **newer** than `engine.cpp`.

- [ ] **Step 6: Gates + commit**

Run: `npx tsc --noEmit && npm run build && npm run verify:plugins && node scratch/speakerpatch-sim.mjs`

Message (`scratch/msg-t5.txt`):

```
feat(audio/native): speaker→channel patch and a commissioning test tone

DEFECT: nine speaker layouts, and no way to wire any of them up. engine.cpp:229-231
wrote decoder speaker s -> device channel s, 1:1, with no patch — but a venue's
octagon is almost never wired to the interface in that order, and there was no way
to discover which physical box was which. The only remedy was a ladder and a cable,
which a ceiling ring in a gallery does not offer.

ROOT CAUSE: the decoder's speaker ORDER was treated as if it were the rig's channel
PATCH. They are unrelated: one is a property of the ambisonic decode, the other of
whoever pulled the cables.

The tone is written straight onto a DEVICE CHANNEL — after the decode, and after
the master fader. Both are deliberate. Through the decoder it would prove the
decoder works (which we know) and nothing about the patch (which is what is being
commissioned): a test tone that routes through the thing under test is not a test.
And behind the master fader it could be silenced by the software while an installer
is up a ladder checking the speaker cable.

The patch is SANITISED on the way in — out-of-range and duplicate entries fall back
to identity — because it arrives from a prefs file a human can edit, and the audio
callback must never be able to write past the buffer.
```

---

## Task 6: Speaker check (UI)

**Files:**
- Modify: `plugins/audio/src/audioManager.ts`, `plugin.main.ts`, `audioClient.ts` (the `setTestTone` passthrough)
- Modify: `plugins/audio/src/AudioSettings.tsx` (the Speaker check block; `speakerPatch` in `AudioCfg`)

**Interfaces:**
- Consumes: `setTestTone(deviceChannel, gain)`, `configure({ ..., patch })` (Task 5).
- Produces: `AudioCfg.speakerPatch?: number[]`, persisted in `AppSettings.plugins.audio` (machine-scoped, per Task 2).

- [ ] **Step 1: Plumb `setTestTone`**

`audioManager.ts` — add to `NativeAudio` and export a wrapper:

```ts
  setTestTone(deviceChannel: number, gain: number): void; // deviceChannel < 0 = off
```
```ts
export function setTestTone(deviceChannel: number, gain: number): void { native?.setTestTone(deviceChannel, gain); }
```

`plugin.main.ts` — fire-and-forget, beside the other `ipc.on` handlers:

```ts
    ipc.on('audio:setTestTone', (ch, g) => engine.setTestTone(Number(ch) ?? -1, g == null ? 0.5 : Number(g)));
```

`audioClient.ts`:

```ts
  // Commissioning only. Pink noise straight onto a DEVICE CHANNEL, bypassing the decoder and the master
  // fader. deviceChannel < 0 stops it. Never call this from the playhead tick.
  setTestTone: (deviceChannel: number, gain = 0.5): void => { ipc?.send('audio:setTestTone', deviceChannel, gain); },
```

- [ ] **Step 2: The Speaker check block**

In `AudioSettings.tsx`, add `speakerPatch?: number[]` to `AudioCfg`, pass `patch: cfg.speakerPatch` in `apply()`'s `configure` call, and render this **only when `mode === 'speakers'`**, below the layout picker:

```tsx
{mode === 'speakers' && (
  <div>
    <div className="text-mini font-semibold text-fg-2 mb-1">Speaker check</div>
    {/* ── COMMISSIONING, AND IT IS THE FIRST HOUR OF EVERY INSTALL ────────────────────────────────────
        Hold a speaker to hear pink noise from exactly that one output, then set which device channel it
        should come out of. The tone bypasses the ambisonic decoder entirely — it is testing the WIRING,
        not the decode. */}
    <div className="text-micro text-fg-3 mb-1.5">
      Hold a speaker to hear it. Set the channel each speaker is actually wired to — the ring is rarely
      patched in order.
    </div>
    <div className="space-y-0.5">
      {Array.from({ length: need }).map((_, s) => {
        const patch = cfg.speakerPatch ?? [];
        const dst = patch[s] ?? s;
        return (
          <div key={s} className="flex items-center gap-1.5">
            <button
              onPointerDown={() => { setTone(s); audioClient.setTestTone(dst, 0.5); }}
              onPointerUp={() => { setTone(null); audioClient.setTestTone(-1, 0); }}
              onPointerLeave={() => { setTone(null); audioClient.setTestTone(-1, 0); }}
              className={`px-2 h-6 rounded text-mini border tabular-nums ${tone === s ? 'bg-accent text-black border-transparent' : 'bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1'}`}
            >
              Speaker {s + 1}
            </button>
            <span className="text-micro text-fg-3">→</span>
            <select
              value={dst}
              onChange={(e) => {
                const next = Array.from({ length: need }, (_, i) => patch[i] ?? i);
                next[s] = Number(e.target.value);
                patchAndApply({ speakerPatch: next });
              }}
              className="bg-surface-2 border border-line-1 rounded px-1.5 h-6 text-mini text-fg-1 outline-none tabular-nums"
            >
              {Array.from({ length: opened?.channels ?? outCh }).map((_, c) => (
                <option key={c} value={c}>Channel {c + 1}</option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
    <button
      onClick={() => patchAndApply({ speakerPatch: Array.from({ length: need }, (_, i) => i) })}
      className="mt-1.5 px-2 h-6 rounded text-mini border bg-surface-2 text-fg-2 border-line-1 hover:text-fg-1"
    >
      Reset to 1:1
    </button>
  </div>
)}
```

with `const [tone, setTone] = useState<number | null>(null);` in the component.

⚠ **The tone must stop on unmount.** A modal closed mid-hold leaves pink noise running in the room with no UI to stop it:

```tsx
// A panel closed mid-hold would leave pink noise playing in the room with nothing on screen to stop it.
useEffect(() => () => { audioClient.setTestTone(-1, 0); }, []);
```

- [ ] **Step 3: Gates**

Run: `npx tsc --noEmit && npm run build && npm run verify:plugins`

- [ ] **Step 4: Manual check — THE P6 ACCEPTANCE GATE**

On the synthetic 8-channel rig, with **Speaker layout / octagon / 8 ch** and the meters visible:

1. Hold **Speaker 1** → **meter 1 lights, and only meter 1.** Release → it stops.
2. Hold each of Speakers 2–8 in turn → meters 2–8, one at a time. **This is the identify pass.**
3. Set **Speaker 1 → Channel 5**. Hold Speaker 1 → **meter 5 lights**, not meter 1. *The patch is live.*
4. **Reset to 1:1.**
5. Play a bed clip with a spatial position and orbit it around the ring → the energy **walks around the meters in ring order**, with no gaps and no channel stuck on.
6. Close Preferences **while holding a speaker** → the noise **stops**.

- [ ] **Step 5: Commit**

Message (`scratch/msg-t6.txt`):

```
feat(audio): Speaker check — identify each speaker, patch it to its real channel

DEFECT: nine speaker layouts and no way to commission any of them. An installer
could not tell which physical box was speaker 3, and if the ring was not wired 1:1
to the interface — it never is — the only remedy was to re-plug the cables.

Hold a speaker to hear pink noise from exactly that output; set the channel it is
actually wired to. The tone bypasses the ambisonic decoder AND the master fader
(engine.cpp): through the decoder it would test the decode rather than the wiring,
and behind the fader the software could silence it while somebody is up a ladder
checking a cable.

The tone is killed on unmount — a panel closed mid-hold would otherwise leave noise
playing in the room with nothing on screen to stop it.
```

---

## Task 7: ASIO — an off-by-default build flag

**The decision, recorded:** ASIO needs the **Steinberg ASIO SDK** — not redistributable, separately licensed, each builder must download it. **Neither the author nor the maintainer has an ASIO device**, so enabling it would ship a completely unverified driver path *and* drag a third licence into the default build, on top of a JUCE tier that has **not been elected** and a statically-linked LGPL library. **We ship nothing we cannot hear.**

**Files:**
- Modify: `native/audio-engine/CMakeLists.txt:63-73`
- Modify: `docs/DEVELOPMENT.md`

- [ ] **Step 1: The CMake option**

Replace `JUCE_ASIO=0` (`:67`) with:

```cmake
# ── ASIO: OFF by default, and that is a decision, not an oversight ───────────────────────────────────
# ASIO needs the Steinberg ASIO SDK, which is NOT redistributable and carries its own licence — it cannot
# be vendored here, and CI cannot fetch it. On top of that we have no ASIO hardware to test against, and
# this project ships nothing it cannot hear.
#
# WASAPI *exclusive* mode is compiled in unconditionally and is what delivers discrete multichannel output
# on Windows (see AudioSettings' device picker, which groups devices by driver type). ASIO buys lower
# latency, which a show bed does not need.
#
# To build with ASIO: download the SDK, then
#     cmake -DARTLUX_ENABLE_ASIO=ON -DASIO_SDK_DIR=C:/path/to/asiosdk/common
# See docs/DEVELOPMENT.md ▸ ASIO. NOTE: doing so adds a THIRD licence obligation (Steinberg's) to a build
# that already carries JUCE's — which is NOT YET ELECTED (see NOTICE) — and libspatialaudio's LGPL.
option(ARTLUX_ENABLE_ASIO "Build with ASIO support (requires the Steinberg ASIO SDK)" OFF)
set(ASIO_SDK_DIR "" CACHE PATH "Path to the ASIO SDK 'common' directory")
```

and after `target_compile_definitions`:

```cmake
if(ARTLUX_ENABLE_ASIO)
  if(NOT ASIO_SDK_DIR OR NOT EXISTS "${ASIO_SDK_DIR}/iasiodrv.h")
    message(FATAL_ERROR "ARTLUX_ENABLE_ASIO=ON but ASIO_SDK_DIR does not contain iasiodrv.h. See docs/DEVELOPMENT.md.")
  endif()
  target_compile_definitions(${PROJECT_NAME} PRIVATE JUCE_ASIO=1)
  target_include_directories(${PROJECT_NAME} PRIVATE ${ASIO_SDK_DIR})
  message(STATUS "ArtLux: ASIO ENABLED — this adds Steinberg's licence terms to this build.")
else()
  target_compile_definitions(${PROJECT_NAME} PRIVATE JUCE_ASIO=0)
endif()
```

Remove `JUCE_ASIO=0` from the unconditional `target_compile_definitions` block so it is not set twice.

- [ ] **Step 2: Document it**

Add an **ASIO (optional)** section to `docs/DEVELOPMENT.md`, next to the existing audio-build instructions: what it buys (lower latency), what it costs (a third licence, an SDK that cannot be vendored, and **no test coverage — we have no ASIO hardware**), how to fetch the SDK from steinberg.net, and the exact `cmake` invocation. State plainly that **WASAPI exclusive mode is the supported multichannel path** and that ASIO is unnecessary for a show bed.

- [ ] **Step 3: Verify the default build is unchanged**

Run (**app closed**): `npm run build:audio`
Expected: exit 0, and the CMake output does **not** contain `ASIO ENABLED`.

- [ ] **Step 4: Commit**

Message (`scratch/msg-t7.txt`):

```
build(audio): ASIO behind an off-by-default flag, and say why

The P6 plan assumed ASIO was the missing multichannel lever. It is not: WASAPI
EXCLUSIVE mode was already compiled into the addon and already enumerated, and it
is what delivers discrete 8-channel output on Windows. ASIO buys lower latency,
which a show bed does not need.

Enabling it would cost: the Steinberg ASIO SDK (not redistributable, separately
licensed, un-vendorable, un-fetchable by CI), a THIRD licence obligation on a build
whose JUCE tier is still UNELECTED (see NOTICE), and a driver path shipped with
ZERO test coverage — nobody on this project has an ASIO device.

We ship nothing we cannot hear. ARTLUX_ENABLE_ASIO=OFF, with the SDK path and the
licence consequence documented for anyone who needs it.
```

---

## Task 8: Headless — verify it, then delete the fork

**The situation:** the P6 plan's headless risk cites `HeadlessRunner.tsx:95`, which is **dead code**. `src/main/index.ts:141` boots the *full* `App` with `?headless=1`; the plugin host activates as `'main'`; the audio plugin opens the device on activation (`plugin.renderer.ts:112`). Headless audio is very likely **already working**. Prove it, then delete the fork `main/index.ts:145` has been carrying (*"Delete in a follow-up"*).

**Files:**
- Delete: `src/renderer/HeadlessRunner.tsx`, `src/renderer/headless.tsx`, `src/renderer/headless.html`
- Modify: `electron.vite.config.ts:62` — **remove the `headless:` rollup input.** It points at `src/renderer/headless.html`; a build input naming a deleted entry **fails the bundle**, so this is not optional cleanup, it is part of the deletion.
- Modify: `src/main/index.ts:145-146` (drop the dead-code note)
- Modify: `plans/audio-engine.md` — risk 5 and the P6 line

- [ ] **Step 1: Prove headless audio works — BEFORE deleting anything**

Use an examples project that has a bed (`examples/audio/`).

Run: `npm run build && npx electron . --headless --project=examples/audio/<a-project>.artlux`

Expected: **you hear the bed.** The console logs the audio engine loading and the device opening. **If it is silent, STOP** — headless is not wired, this task is no longer a deletion, and the plan needs revising before you go further.

- [ ] **Step 2: Delete the fork**

```bash
git rm src/renderer/HeadlessRunner.tsx src/renderer/headless.tsx src/renderer/headless.html
```

Then **remove the `headless:` rollup input at `electron.vite.config.ts:62`** (`headless: resolve(__dirname, 'src/renderer/headless.html')`). A build input naming a deleted entry **fails the bundle** — this is part of the deletion, not tidying after it.

Grep for stragglers: `grep -rn "HeadlessRunner\|headless\.tsx\|headless\.html" src electron.vite.config.ts package.json`
Expected after the edit: **no hits.**

Rewrite `src/main/index.ts:141-146` to drop the "retained as dead code / delete in a follow-up" note; keep the explanation of what headless *is*.

- [ ] **Step 3: Correct the stale plan text**

In `plans/audio-engine.md`:
- **Risk 5** (`:117`) says *"headless doesn't drive transport today (HeadlessRunner.tsx:95)"* — false, and citing a file that no longer exists. Replace with: headless boots the full App (`main/index.ts`), the plugin host activates as `'main'`, and the audio plugin opens the device on activation; **verified in P6**.
- **WS9** (`:102`) still quotes *"JUCE Starter is free under $20k/yr revenue (else $800 perpetual Indie)"*. The licensing pass purged those figures everywhere else because **they cannot be verified from memory and a confidently-wrong licence figure is worse than none.** Replace with a pointer to `NOTICE` and juce.com.
- Mark **P6 complete** in the phasing list (`:139`).

- [ ] **Step 4: Gates**

Run: `npx tsc --noEmit && npm run build && npm run verify:plugins`
Expected: green. **A green `build` here is the real proof the fork was unreferenced.**

Re-run headless once more after the deletion to be certain nothing regressed:
Run: `npx electron . --headless --project=examples/audio/<a-project>.artlux` → **you still hear the bed.**

- [ ] **Step 5: Commit**

Message (`scratch/msg-t8.txt`):

```
chore(headless): verify headless audio, delete the dead HeadlessRunner fork

Headless audio was never wired — and then it silently was. When headless stopped
booting its own minimal entry and started booting the full App with ?headless=1
(main/index.ts), it inherited the plugin host, the show engine and media playback
for free. The audio plugin activates as 'main' and opens the device on activation,
so the bed has been playing in headless ever since, unverified and undocumented.

VERIFIED in P6: `--headless --project=<a bed>` produces sound.

HeadlessRunner.tsx / headless.tsx have been dead since that change — main/index.ts
said so in a comment ("retained as dead code for one release ... Delete in a
follow-up") and the P6 plan's own headless risk still CITED HeadlessRunner.tsx:95
as evidence that headless could not drive transport. A plan reasoning from a dead
file is how a phase gets scoped to build something that already exists.

Also corrected in plans/audio-engine.md: the $20k/$800 JUCE figures the licensing
pass purged everywhere else (unverifiable from memory; a confidently-wrong licence
figure is worse than none — see NOTICE).
```

---

## Task 9: Docs, acceptance, and the honest verdict

**Files:**
- Modify: `docs/AUDIO.md` — a **Devices and speakers** section
- Modify: `docs/user-guide/07-audio.md` — commissioning a rig
- Create: `docs/superpowers/2026-07-14-p6-acceptance.md`
- Modify: `CHANGELOG.md` — the breaking change from Task 2
- Modify: `plans/SEQUENCING.md` — P6 row

- [ ] **Step 1: `docs/AUDIO.md`**

Add **Devices and speakers**, covering: the driver-type distinction (*shared vs exclusive*, and that exclusive is the multichannel path); that `configure()` reports **what was opened**, not what was asked; the speaker patch; that the test tone **bypasses the decoder and the master fader**, and why; and that **ASIO is off by default** with a pointer to `docs/DEVELOPMENT.md`.

Also state the machine/show split — **`AppSettings` is the machine and does not travel in the `.artlux`** — because that is now load-bearing for anyone deploying a show.

- [ ] **Step 2: `docs/user-guide/07-audio.md`**

Add a **Commissioning a speaker rig** section, written for an operator standing in a venue: pick the interface **under Exclusive Mode**, set the channel count, choose the layout, then **hold each speaker in Speaker check and set the channel it is actually wired to.** Plain, numbered, no jargon.

- [ ] **Step 3: The acceptance document**

Create `docs/superpowers/2026-07-14-p6-acceptance.md` from the manual checks in Tasks 2, 4, 6 and 8 (the venue load-in; the device/rate/buffer picker; the identify + patch pass; headless).

**It must open with this, in these words:**

> **⚠ THIS IS A SYNTHETIC PASS, NOT A VENUE PASS.**
> There is no multichannel hardware on this project (established at Wave-3 acceptance test 2.10). Every
> multichannel result below was obtained against a **virtual** 8-channel device or a built-in card switched
> to 7.1 Surround. That proves the device opens with 8 discrete channels, that the ambisonic decode lands
> energy on the speaker index it claims, and that the patch routes it where it says.
>
> **It does NOT prove:** ASIO, real driver behaviour, real converter latency, or that eight physical
> speakers are wired the way the layout thinks they are. Those close on hardware, or they do not close.

- [ ] **Step 4: `CHANGELOG.md`**

Under **Breaking**:

```markdown
- **A project no longer reconfigures the machine that opens it.** `AppSettings` — the audio device, the
  Art-Net target, the OSC port — is the *machine*, not the show, and is no longer written into `.artlux`
  files (it already persisted per-machine in prefs). Previously, opening a show authored on another
  computer overwrote the local audio and network configuration and made it stick: a project authored in
  binaural/2 ch would flip an octagon/8 ch venue rig to a headphone mix. Existing projects keep the old
  key; it is now **ignored on load**. The one show-scoped field it carried (`reserveLockedRanges`, the
  patch policy) moves into the project file proper and is migrated automatically.
```

- [ ] **Step 5: `plans/SEQUENCING.md`**

Tick **P6** in the Wave 3 phase list. Record the synthetic-verification caveat **in the gate table itself**, not only in the acceptance doc — a gate table that says "passed" without saying "on a virtual device" is how a phase reads as closed when it is not.

- [ ] **Step 6: Link check + final gates**

Run: `node scratch/check-docs-links.mjs`
Expected: every link resolves. (The last archive pass shipped broken links in **three** directions; do not skip this.)

Run (**app closed**): `node scratch/gates.mjs --native`
Expected: `tsc`, `build`, `verify:plugins`, `build:audio` and every sim green.

- [ ] **Step 7: Commit**

Message (`scratch/msg-t9.txt`):

```
docs(p6): devices, speaker commissioning, and an honestly-labelled synthetic pass

The acceptance document opens by saying what it does NOT prove. There is no
multichannel hardware on this project (Wave-3 test 2.10), so every multichannel
result was obtained against a virtual 8-channel device. That proves the device
opens with 8 discrete channels, that the decode lands energy on the speaker index
it claims, and that the patch routes it where it says. It proves nothing about
ASIO, real driver behaviour, converter latency, or how the speakers are actually
wired.

A synthetic pass is not a venue pass, and a gate table that says "passed" without
saying "on a virtual device" is how a phase reads as closed when it is not.

CHANGELOG records the breaking change: opening a project no longer reconfigures the
machine that opens it.
```

---

## Self-review

**Spec coverage.** §1 → Tasks 1–2. §2 → Tasks 3–4. §3 → Tasks 5–6. §4 → Task 7. §5 → Task 8. §6 → the manual checks in Tasks 2/4/6/8, consolidated in Task 9. **No gaps.**

**Type consistency.** `PatchPolicy` / `readPatchPolicy` (Task 1) are consumed by name in Task 2. `DeviceCfg` / `OpenedCfg` / `DeviceEntry` are defined in C++ (Task 3), mirrored in TS (Task 4), and extended with `patch` (Task 5) and `speakerPatch` (Task 6) — the C++ field is `patch`, the persisted prefs field is `speakerPatch`, and Task 6's `apply()` maps one to the other. `setTestTone(deviceChannel, gain)` is identical across C++, `audioManager`, `plugin.main` and `audioClient`.

**The forced order, and why it cannot be reshuffled.**
- **Task 1 before Task 2** — Task 2 deletes the container `reserveLockedRanges` lives in.
- **Task 2 before Task 4** — Task 4 stores five new machine-specific keys in `AppSettings.plugins.audio`. Landing it first would mean five more keys leaking into every `.artlux`.
- **Task 3 before Task 4** — between them the JS `NativeAudio` interface *lies about the addon's signature*, and `tsc` cannot see it. **The app will throw at runtime until Task 4 lands. Do not stop between them.**
- **Task 5 before Task 6** — the UI calls an addon export that does not exist yet.
- **Task 8 last of the code tasks** — it deletes files; do it once everything else is proven green.
