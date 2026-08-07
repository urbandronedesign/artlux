# R5b — There is no undo for any timeline edit (and no document history to wire it into)

> **Deliverable:** this document, saved as `plans/timeline-undo.md` and indexed in `plans/README.md`.
> **Status:** ☑ **SHIPPED** — confirmed against the tree 2026-07-29. `DocSnapshot` and the `SHOW_ENGINE`
> gate are in `App.tsx`, and `scripts/verify-invariants.cjs` carries a dedicated *"Undo/redo: the
> document-history safety rules"* block that cites this plan and asserts the `MAX_DEPTH` cap plus "the
> show never records". *(This header read "Draft" until the reconciliation; the plan text below is the
> original proposal and has not been rewritten to past tense.)* · **Placement:** **Core** (`src/renderer/hooks/useHistory.ts`, `src/renderer/App.tsx`, both menu mirrors) · **Risk:** 🔴 **High** — this widens the one history primitive from a single array to the whole document, and it adds a snapshot to the commit path that Timeline.tsx already calls *"THE EXPENSIVE PATH"* ([Timeline.tsx:472-475](../src/renderer/components/timeline/Timeline.tsx#L472)) · **Breaking changes:** no schema change, no IPC change; **two loud behavior removals** (a scene recall / cue GO stops being undoable) and **one loud behavior addition** (Ctrl+Z now reverts documents, not just fixtures)

---

## 1. Context — what R5b actually is

**This is neither a pure wiring plan nor a greenfield build. It is a WIDENING plan, and the distinction is the whole document.**

The seed brief's framing — *"`handleTimelineChange` does not call `recordHistory()`"* — is true, and it is the smaller half of the truth. The larger half:

```ts
// src/renderer/App.tsx:914-917
const handleTimelineChange = (next: Timeline) => {
    if (activeSceneId) setScenes(prev => prev.map(s => s.id === activeSceneId ? { ...s, timeline: next } : s));
    else setTimeline(next);
};
```

**Adding `recordHistory()` to line 915 would fix nothing.** `recordHistory` is `record` from `useHistory<Fixture[]>` ([App.tsx:109-125](../src/renderer/App.tsx#L109)), and `useHistory` snapshots exactly one value — its `present` ([useHistory.ts:14](../src/renderer/hooks/useHistory.ts#L14)), whose `T` is `Fixture[]`. A `record()` inside `handleTimelineChange` would deep-clone the **fixtures array** onto `past` ([useHistory.ts:46-47](../src/renderer/hooks/useHistory.ts#L46)) and then the timeline would change anyway. Ctrl+Z would restore an unchanged fixtures array and leave the clip exactly where the bad drag put it.

So the accurate statement of R5b is:

> **There is no document history in this app. There is a `Fixture[]` history.** `surfaces` (App.tsx:134), `timeline` (:190), `scenes` (:142), `cueBanks` (:143), `scene3D` (:183), `stateMachine` (:196), `audioMix` (:149), `globalBrightness` (:140), `groups` (:141), `assets` (:197), `projectorOutputs` (:244), `controllers` (:151) and `schedule` (:146) are all plain `useState` and are outside the history model entirely.

### What already exists (so we do NOT build a second system)

| Piece | Site | State |
|---|---|---|
| The hook | [`useHistory.ts:13`](../src/renderer/hooks/useHistory.ts#L13) — `present`/`past`/`future`, API `state / set / undo / redo / canUndo / canRedo / record` (:3-11) | ✅ exists, generic in `T` |
| The one instantiation | `App.tsx:109-125` — **the only `useHistory` call in the repo** | ✅ exists, `T = Fixture[]` |
| The keybinding | `App.tsx:318-345` — Ctrl/Cmd+Z → `undo()`, Shift → `redo()` (:320-323); Ctrl/Cmd+Y → `redo()` (:324-327) | ✅ exists, **no typing guard** |
| Native menu | `menu.ts:60-61` — `passthrough('Undo', 'CmdOrCtrl+Z', 'undo')` / Redo. `passthrough` sets `registerAccelerator: false` **deliberately** (menu.ts:18-22) so the renderer keydown owns the shortcut | ✅ exists |
| Renderer menu | `MenuBar.tsx:64-65` → dispatched at `MenuBar.tsx:154` | ✅ exists |
| The dispatch | `App.tsx:1524` `dispatchMenu` → `case 'undo': undo()` / `case 'redo': redo()` (:1544-1545) | ✅ exists |
| The per-gesture coalescing precedent | `Stage.tsx:557-560` — the moved-latch | ✅ exists |
| `canUndo` / `canRedo` | destructured at `App.tsx:114-115` and **never referenced again** | ⚠️ dead |
| `reset()` | **does not exist** — `HistoryResult` has no reset (useHistory.ts:3-11) | ❌ missing |
| Depth cap / eviction | **does not exist** — `record()` is `setPast(prev => [...prev, snapshot])` (useHistory.ts:47) | ❌ missing |
| A document-shaped snapshot | **does not exist** | ❌ missing |

**Everything on the plumbing side is already there. What is missing is the SHAPE of `T`, a `reset()`, a depth cap, and a line between an operator and a show.** That is the plan.

The codebase already knows. `Timeline.tsx:305-306`, in a comment about a cross-document automation clobber, says it in as many words:

> *"handleTimelineChange does not recordHistory(), so THERE IS NO UNDO."*

### The live bugs the current shape already ships (they are not hypothetical, and widening fixes them for free)

- **`recordHistory()` against the wrong slice.** `addSceneModel` (App.tsx:377), `handleUpdateModel` (:389), `handleRemoveModel` (:390) each `recordHistory()` then `setScene3D(...)`. The snapshot taken is `fixtures`. **Adding or deleting a 3D model is unundoable *and* pushes a junk entry.** Same for `handleCreateState` (:889), which mutates `scenes` + `stateMachine`.
- **Torn undo.** `handleRecallScene` (:791-847) records, then replaces `surfaces` (:796), `fixtures` (:797), `globalBrightness` (:798), `groups` (:799), `scene3D` (:800), `projectorOutputs` (:801). Undo restores **only the fixtures** — producing a state that never existed.
- **Undo across a project open.** `applyProjectData` (:1116) and `resetToNewProject` (:1285) both **`record()`**, pushing the *outgoing* project's fixtures onto `past`. Nothing ever clears the stack. **After File→Open, one Ctrl+Z pastes the previous project's fixture array into the newly-opened project.** Today that is bad. After widening, without a `reset()`, that is *the entire previous project*.

### Why now

Two Wave B CRITICALs were drags that committed into the wrong document. What made them lethal rather than annoying was that authored work was destroyed **with no way back** — precisely the sentence `Timeline.tsx:306` writes about itself.

---

## 2. Requirements

1. **Every operator edit to a timeline document is undoable**, whichever document is bound (the global `timeline`, or the active scene's own `scene.timeline`).
2. **One undo entry per operator gesture.** Not per pointermove, not per keystroke.
3. **A show event is never an undo entry.** An FSM hop, a cue GO, an OSC message, the tablet remote and the wall-clock scheduler mutate state with nobody in the room; none of them may push history. After a night of unattended running, the stack must be *exactly as the operator left it*.
4. **The undo stack is bounded** — in depth and in bytes — and it is **cleared** on File→New / File→Open.
5. **Undo restores the whole document**, not one slice: no torn states.
6. **Ctrl+Z inside a text field edits the text field**, not the show.
7. **Both menu mirrors stay identical.** `src/main/menu.ts` and `src/renderer/components/MenuBar.tsx` change together or not at all.
8. Persisted types are unchanged. No `.artlux` schema change, no version bump, no normalizer.

---

## 3. Architecture at a glance

```
                       OPERATOR EDITS                          SHOW EVENTS
                  (a human in the editor)              (FSM · OSC · cue GO · tablet · scheduler)
                            │                                        │
   TimelinePanel.onChange   │                     cueBus.requestRecall / requestFireCue / requestFireColumn
   (App.tsx:2457, :2659)    │                       (services/cueBus.ts:16 · oscController.ts:31-40
                            │                        · services/timeline.ts:133 · App.tsx:1762-1764)
                            ▼                                        │
              ┌──────────────────────────┐                           ▼
              │  handleTimelineChange    │              App.tsx:1691-1693 subscriptions
              │  (App.tsx:914)           │                           │
              │  ── THE OPERATOR SEAM ── │                           ▼
              │  record() HERE           │           recallByRefRef (:968-971) → handleRecallScene(:791)
              └────────────┬─────────────┘           fireCueRef/fireColumnRef  → applyCues(:978)
                           │                                         │
                           │                          ┌──────────────┴──────────────┐
                           │                          │  origin === 'show'          │
                           │                          │  ⇒ NO record()              │
                           ▼                          └──────────────┬──────────────┘
                    setScenes / setTimeline  ◄─────────────────────  ┘
                           │                          (and: FSM setLoop App.tsx:1685-1686,
                           ▼                           asset delete :1435, relink :1488-1494 —
              useHistory<DocSnapshot>                  all write setScenes/setTimeline DIRECTLY,
              past ─ present ─ future                  bypassing handleTimelineChange by construction)
              + reset()  + depth cap
                           │
                           ▼
              App.tsx:1581-1591 effect re-fires on [activeTimeline, activeSceneId]
              → timelineEngine.setData + trackingPlayback.setData + postMessage to every projector port
```

**Two facts make this tractable, and both were verified by reading the code, not assumed:**

**(A) The operator seam already exists and is already clean.** `handleTimelineChange` is passed to exactly two places — `TimelinePanel` at `App.tsx:2457` (dock) and `App.tsx:2659` (fullscreen). Grep for `handleTimelineChange` across `src/` returns those two prop sites and nothing else. **Every non-operator writer of a timeline document bypasses it and calls `setScenes`/`setTimeline` directly:**

| Non-operator writer of the bound timeline doc | Site | Route |
|---|---|---|
| FSM / OSC / tablet `setLoop` transport intent | `App.tsx:1682-1687` | `setScenes(...)` / `setTimeline(...)` **direct** |
| Asset delete (strips takes + clips) | `App.tsx:1435` | `setTimeline(t => ...)` **direct** |
| Asset relink (global doc + **every scene's** timeline + the bed) | `App.tsx:1488-1495` | `setTimeline` / `setScenes` **direct** |

So **`record()` inside `handleTimelineChange` records operator edits and nothing else, by construction.** That is not a convention to be remembered — it is the shape of the code today, and this plan's job is to write it down and make it load-bearing.

**(B) Invariant 7 is universal, so granularity is free.** See §5.1 — every commit site in the timeline subtree fires `onChange` exactly once per gesture. There is nothing to coalesce.

**The one thing that is NOT clean is the *look* path**, and it must be fixed *before* the snapshot is widened, not after — see §5.2.

---

## 4. ⚠️ Correction to the ground truth (read this before designing anything)

The ground-truth brief states:

> *"The one place that would need a Stage-style latch is anything that commits repeatedly under one continuous gesture — the region/in-out drag at `Timeline.tsx:892` commits on every pointermove (`regionDragRef` writes `onChangeRef.current(...)` per move, not on release) and the layer-height resize at `:702`. Those two would each write one history entry per frame under a naive 'record inside handleTimelineChange' rule."*

**This is false. Both were read; both draft locally and commit exactly once.**

- **Region / in-out drag** — `startRegionDrag`'s `move` handler ends at `setRegionDrag({ edge, t: ... })` ([Timeline.tsx:881](../src/renderer/components/timeline/Timeline.tsx#L881)); it never touches `onChangeRef`. The single `onChangeRef.current(...)` is at **`:892`, inside `done(commit)`**, reached only from `up` (`:894`) or `cancel` (`:895`). Its own comment says so (`:851-854`): *"Committing that per pointermove would be brutal, so — same as ClipBlock and AutomationLane — the drag holds a local draft (regionDrag) and commits ONCE on…"*
- **Layer-height resize** — `startResize`'s `move` ends at `setResizeDraft({...})` (`:691`). The single commit is at **`:702`, inside `done(commit, ev)`** (`:693-703`), guarded by `docKey` (`:698`) and by a "the track is gone" bail (`:701`).

**Consequence: no latch is needed anywhere in the timeline.** The plan is simpler than the brief assumed, and any design built on that paragraph would have added a coalescer for a problem that does not exist. (Correct that paragraph wherever it is cached.)

---

## 5. Design / approach — workstreams

### 5.1 · WS1 — Granularity: enumerate every commit site and prove one-per-gesture

The rule is: **one `onChange(timeline)` == one operator gesture == one undo entry, recorded inside `handleTimelineChange` immediately before the write.** No latch, no debounce, no timer.

That rule is only safe if *every* writer really is one-shot. Every site was read. All of them are:

| # | Gesture | Commit site | Shape |
|---|---|---|---|
| 1 | clip **move / trim-L / trim-R** | `Timeline.tsx:455` (`endDrag`) | draft (`setDraft` :429/:433/:437) → **one** commit in `endDrag`; `pointercancel` abandons (`:458`), `docKey` mismatch abandons (`:454`) |
| 2 | **blade** (click) | `:616` (`onBlade`) | discrete |
| 3 | **blade at playhead** (`C`) | `:929` | discrete |
| 4 | **delete clip** (lift/ripple, Del/Backspace) | `:926` (`deleteSelected`) ← `useTimelineKeys.ts:49` | discrete; guarded against no-op fan-out (`:915-921`) |
| 5 | **delete audio clip** | `:609` (`onAudioRemoveClip`) | discrete; membership-guarded (`:609`) |
| 6 | **automation keyframe** drag | `AutomationLane.tsx:148` — `commit(d)` inside `done(true)` (`:138-149`) | draft (`setDraft` :136) → **one** commit on release; `pointercancel` abandons (`:154`), `docKey` abandons (`:147`) |
| 7 | keyframe **add / remove / curve-cycle / key-at-playhead / lane enable** | `AutomationLane.tsx:166`, `:171`, `:178`, `:195`, `:189` — all → `Timeline.tsx:310` `patchLane` → `onChangeRef` (`:314`) | discrete |
| 8 | **add automation lane** | `Timeline.tsx:326` | discrete |
| 9 | **timeline audio clips** (drag/trim/delete) | `:482` (`commitAudioClips('timeline')`) | **one** commit on pointerup — `Timeline.tsx:475`: *"Both are called EXACTLY ONCE, on pointerup. Never per pointermove. (Invariant 7.)"* |
| 10 | **audio track** patch / remove / add | `:732`, `:741`, `:751` | discrete; the *continuous* ones (gain fader, name) draft inside `AudioLane` and land here once on release/blur (`:714-715`) |
| 11 | **video layer** add / patch / remove | `:712`, `:625`, `:629` | discrete |
| 12 | **layer reorder** | `:676`, inside `done(commit)` | draft (`setOrderDraft` :661 — *"DRAFT ONLY — no document write mid-gesture"*) → **one** commit |
| 13 | **layer height resize** | `:702`, inside `done(commit, ev)` | draft (`setResizeDraft` :691) → **one** commit ⟵ *see §4* |
| 14 | **tracking**: add lane / remove take | `:811`, `:840` | discrete |
| 15 | **tracking: record a take** | `:838` (`stopRecord`) | **one** commit — but *after two awaits* (`:827`, `:831`); `docKey` re-checked at `:834` |
| 16 | **drop take → clip** | `:943` | discrete |
| 17 | **drop asset/file → clip** | `:955`, `:961` (and the async `addClip` after `ensureBlobUrl`, `:962-964`) | one commit per drop |
| 18 | **drop audio asset** | `place()` after `probeAudioDuration` (`:807`) | one commit per drop, async |
| 19 | **markers** add / delete / note | `:846` (`M`), `:1193`, `:1194` | discrete; the note field drafts locally and commits on **blur/Enter** (`TimelineRuler.tsx:108-111`) |
| 20 | **in / out** (`I`, `O`) | `:847`, `:848` | discrete |
| 21 | **in/out region drag** | `:892`, inside `done(commit)` | draft (`setRegionDrag` :881) → **one** commit ⟵ *see §4* |
| 22 | **loop flag** (Shift+L) | `:843` | discrete |
| 23 | **Length** / **FPS** | `:1160`, `:1161` | `NumField` **commits on BLUR / ENTER only — never per keystroke** (`TimelineToolbar.tsx:52`, `:99-122`); Escape discards |
| 24 | **"Fix Length"** one-click | `:235` (`fixLength`) | discrete |

**24 sites, 24 one-shot commits.** The three that abandon (`docKey` mismatch, `pointercancel`, "nothing moved" at `:675`) return *before* calling `onChange`, so they correctly record nothing. The four async ones (#15, #17, #18) commit late but exactly once — and because the snapshot is taken *inside* `handleTimelineChange* at commit time, they snapshot the document as it is when the write lands, which is the correct pre-image.

**The in-tree precedent for coalescing still matters — for the OTHER slice.** `Stage.tsx` streams fixture drags to state at 60 Hz (`onUpdateFixtures` → raw `setFixtures`, `App.tsx:2229`/`:2335` — i.e. `useHistory`'s history-free `set`, `useHistory.ts:51-53`) and coalesces with a per-gesture moved-latch:

```
Stage.tsx:557-560   if (!state.hasMoved) { state.hasMoved = true; onRecordHistory(); }
Stage.tsx:735/:749  dragState.current.hasMoved = false;   // reset on mouseup / mousedown
```

That latch must be **preserved exactly** — it is the only thing standing between a fixture drag and 60 entries per second. **And the 3D gizmos' divergent variant must be brought into line with it:** `ModelObject.tsx:120`, `PlaneObject.tsx:46` and `FixtureGizmo.tsx:34` each call `onRecordHistory()` on **`mouseDown` with no moved-latch**, so a *click* on a gizmo that never drags pushes an entry. Today that entry is a cheap duplicate fixtures array; after widening it is a document snapshot. Add the `hasMoved` latch to all three (WS5).

### 5.2 · WS2 — The line between an OPERATOR EDIT and a SHOW EVENT

**This is the trap, and half of it is already sprung.**

#### The write side (timeline documents) — already correct, must be made load-bearing

Per §3(A): `handleTimelineChange` is reachable only from `TimelinePanel`'s `onChange` (App.tsx:2457, :2659). Every show-driven writer of a timeline document (`App.tsx:1685-1686`, `:1435`, `:1488-1494`) goes straight to `setScenes`/`setTimeline`. **Recording inside `handleTimelineChange` therefore records operator edits only.**

Write the doctrine down, in a comment on `handleTimelineChange`:

> **`handleTimelineChange` IS THE OPERATOR SEAM. It is what `record()` means.** Every caller of it is a human gesture in the timeline panel (App.tsx:2457, :2659) — there are no others. Any writer of the bound timeline document that is NOT a human gesture (an FSM entry action, an OSC message, a cue GO, the scheduler, an asset relink) **must call `setScenes`/`setTimeline` directly and must NOT route through here** — routing a show event through this function fills an unattended install's undo stack with changes nobody made. The three that exist today already do (App.tsx:1685-1686, :1435, :1488-1494). Keep it that way.

#### The look side (`fixtures` / `surfaces` / `brightness`) — **BROKEN TODAY, and widening makes it catastrophic**

Two functions call `recordHistory()` and are reached by the show:

**`handleRecallScene` — `App.tsx:792`.** The chain, verified end to end:

```
services/timeline.ts:133   smContext(): recallScene: (id, fadeSec) => cueBus.requestRecall(id, fadeSec)
services/cueBus.ts:16      requestRecall → subs
App.tsx:1691               cueBus.subscribeRecall(ref => recallByRefRef.current(ref, fadeSec))
App.tsx:968-971            recallByRefRef.current → handleRecallScene(scene)
App.tsx:792                recordHistory()
```

**`applyCues` — `App.tsx:980`**, reached by `fireCueRef` (App.tsx:1692) and `fireColumnRef` (:1693).

Every show source lands on one of those two:

| Show source | Entry point | Lands on |
|---|---|---|
| **FSM** state entry — `recallScene` action | `services/timeline.ts:133` → `cueBus.requestRecall` | `handleRecallScene` → **`recordHistory()` (:792)** |
| **FSM** entry action — `fireCue` | `services/timeline.ts:133` → `cueBus.requestFireCue` | `applyCues` → **`recordHistory()` (:980)** |
| **OSC** — recall | `services/oscController.ts:31,33` → `requestRecall` | `handleRecallScene` → **:792** |
| **OSC** — fire cue | `oscController.ts:35,37` → `requestFireCue` | `applyCues` → **:980** |
| **OSC** — fire column | `oscController.ts:40` → `requestFireColumn` | `fireColumn` → `handleRecallScene` (:1038) **or** `applyCues` (:1039) — history either way |
| **Show-control plugin / tablet remote / wall-clock scheduler** | `App.tsx:1762-1764` `host.show.recallScene / fireCue / fireColumn` → the same `cueBus` | the same two |

**So the 3am failure is not a risk this plan must avoid — it is shipping right now.** An FSM hopping states all night pushes one history entry per recall, into a stack with **no depth cap** (`useHistory.ts:47`) that **nothing ever clears**. The operator arrives in the morning, presses Ctrl+Z, and undoes *an FSM recall from 04:12* rather than their own last edit. Today each junk entry is a cheap fixtures array. **After the widening, each junk entry is a whole-document snapshot** — so the widening would turn a slow leak into an unbounded one and make the undo stack actively useless. **WS2 is therefore a prerequisite of WS3, not a follow-up.**

#### Where the line is enforced — two functions, one argument, fail-safe default

Thread an explicit origin. There are exactly two call sites to change:

```ts
type EditOrigin = 'operator' | 'show';

// App.tsx:791 — DEFAULT IS 'show'. A future caller that forgets the argument records NOTHING,
// which is the safe failure: a missed undo entry is an annoyance; a stack filled by an empty
// venue is a broken feature.
const handleRecallScene = (scene: Scene, origin: EditOrigin = 'show') => {
    if (origin === 'operator') recordHistory();
    …
};
const applyCues = (cues: Cue[], origin: EditOrigin = 'show') => {          // App.tsx:978
    if (!cues.length) return;
    if (origin === 'operator') recordHistory();
    …
};
```

- The **show** callers already pass nothing: `recallByRefRef` (`App.tsx:971`), `fireCueRef` (:1026), `fireColumn` (:1038-1039). They inherit `'show'` and stop recording. **No other change is needed on the entire FSM/OSC/cueBus/scheduler/tablet path** — the default does it.
- The **operator** callers (the Scene panel's GO, the cue deck's GO in `CueBankPanel`) pass `'operator'` explicitly — *if* we decide a recall should be undoable at all (**§10 Q1**).

#### The second enforcement, and the stronger one: **the unattended process has no history at all**

`SHOW_ENGINE = BROADCAST || HEADLESS` (`App.tsx:73`). In that mode `App` returns a 1×1 offscreen div containing only `<Stage>` (`App.tsx:2219-2244`) — no menus, no timeline panel, no operator. **But the Ctrl+Z keydown effect at `App.tsx:318-345` is registered above that early return, so it runs in broadcast too**, and `record()` is still reachable through the recall/cue path.

Gate the whole primitive on the mode: when `SHOW_ENGINE`, `record()` is a no-op and `undo`/`redo` are no-ops, and the keydown listener is not registered at all. **In the venue with nobody in the room, the undo stack does not exist.** That closes the 3am problem twice — once by origin, once by mode — and it costs three lines.

### 5.3 · WS3 — Widen the snapshot, and pay for it with structural sharing (not with a deep clone)

#### What `T` becomes

A renderer-local snapshot of the undoable document slices. **This introduces no persisted type** — per CLAUDE.md doctrine (persisted types stay CORE; only behavior moves), and this type is neither persisted nor sent over IPC. It is a plain interface next to the hook:

```ts
// A snapshot of the UNDOABLE document. Deliberately NOT ProjectData: `assets` (the managed library),
// `schedule`, `controllers` and `settings` are not authored edits in the sense Ctrl+Z means, and
// undoing a projector-output config mid-show is a footgun, not a feature. See §10 Q4.
interface DocSnapshot {
  fixtures: Fixture[]; surfaces: Surface[]; groups: FixtureGroup[];
  scenes: Scene[];                       // ← each carries its OWN cloned timeline (types.ts:1003)
  timeline: Timeline;                    // the global doc
  cueBanks: CueBank[]; stateMachine: StateMachine; audioMix: AudioMix;
  scene3D: Scene3D; globalBrightness: number;
}
```

`useHistory` stays generic and stays the ONE history system. What changes inside it: `record()` stops deep-cloning, `record()` caps depth, and a `reset()` is added.

#### The memory problem, with real numbers

**Today the snapshot is cheap precisely because it snapshots almost nothing.** A `Fixture` (`types.ts:62-84+`) is scalars plus `segments?` and `colorData: RGBW[]` — and **`colorData` is never populated in React state**: every writer sets it to `[]` (App.tsx:123, 579, 763, 797, 1068, 1120, 1260, 1278); live colour rides `dmxSignal`. A 200-fixture rig is ~50-100 KB and the `JSON.parse(JSON.stringify(...))` round-trip (`useHistory.ts:46`) is sub-millisecond.

**A document snapshot is a different animal, and `scenes` is the elephant.** Every scene carries a full cloned `Timeline` (`App.tsx:773` — `structuredClone(activeTimeline)`; `Scene.timeline` at `types.ts:1003`). A 20-scene show whose scenes each hold ~30 clips + ~10 automation lanes × ~50 keyframes is on the order of **30-50 KB of JSON per scene timeline ⇒ ~1 MB per snapshot**. Keep `useHistory.ts:46` as written and **every keyframe nudge deep-clones every scene's timeline** — a multi-millisecond main-thread JSON round-trip **added to the commit path that `Timeline.tsx:472-475` already calls THE EXPENSIVE PATH** (`timelineEngine.setData` → `clampPlayheadIntoDoc` + `warmMedia` + `pruneStaleLayers` + `compileAutomation` + a **structured-clone `postMessage` of the whole document to every projector port**, `App.tsx:1588-1590`). With no cap (`useHistory.ts:47`), 200 nudges ⇒ **~200 MB retained, for the life of the process, across project opens.** That is not a feature; that is the leak the watchdog's own comment already warns about (`watchdog.ts:6-9`: *"applyProjectData has no teardown for … undo history"*).

#### The fix: snapshot by REFERENCE

**Every writer in this tree already updates immutably.** `handleTimelineChange` spreads (`App.tsx:915`); every `Timeline.tsx` commit builds `{ ...tl, … }` (`:314-317`, `:455`, `:625`, `:629`, `:676`, `:702`, `:892`); `Stage` builds a new fixtures array before calling `onUpdateFixtures` (`:727`). Nothing mutates a state object in place. **Therefore a snapshot does not need to copy anything — it can hold the current object references**, and React's own immutable-update discipline guarantees they are never mutated out from under it.

- `record()` becomes `setPast(p => cap([...p, snapshotOfCurrentRefs]))` — one object of ~10 pointers. **Cost per record: tens of bytes and no serialisation.** The expensive path stays exactly as expensive as it is today.
- Retained memory becomes **only the deltas**: 100 keyframe nudges on one scene retain 100 superseded copies of *that one scene's* timeline (~4 MB), while the other 19 scenes are shared pointers, retained once.
- This is a **prerequisite**, not an optimisation: with the JSON round-trip left in place, WS3 puts a whole-project serialise on every pointerup of a running show.

⚠️ **This is the one assumption in the plan that must be human-verified before it ships (§10 Q2).** If *any* writer mutates state in place, a reference snapshot silently records the post-edit value and undo becomes a no-op. The path to audit first is the 3D commit path (`onCommitModel` / `onCommitFixture3D`, `App.tsx:628-633`), because it is the one that already diverges from the Stage precedent.

#### Depth cap and reset

```ts
const MAX_DEPTH = 100;   // FIFO: drop the OLDEST entry, never the newest
const cap = (p: T[]) => (p.length > MAX_DEPTH ? p.slice(p.length - MAX_DEPTH) : p);
const reset = useCallback((next: T) => { setPresent(next); setPast([]); setFuture([]); }, []);
```

**`reset()` is mandatory, not nice-to-have.** `applyProjectData` (`App.tsx:1116`) and `resetToNewProject` (`:1285`) call `record()` today, pushing the outgoing project onto `past`. After widening, one Ctrl+Z following File→Open would restore **the entire previous project** — every scene, every timeline, the state machine — over the one just opened. Both call sites become `reset(...)` instead of `record()`.

#### Undo must re-drive the engine, and it already does

Restoring `scenes` / `timeline` changes `activeTimeline` (`App.tsx:207`), which re-fires the effect at `App.tsx:1581-1591`: `timelineEngine.setData` + `trackingPlayback.setData` + a `postMessage` to every projector port. **No new fan-out code is needed.** Note its guard (`:1587`): it only pushes when the editor binding matches the engine's active pool — the same rule an edit already obeys, so an undo behaves exactly like the edit it reverses. State-machine restores likewise re-fire `App.tsx:1697`.

### 5.4 · WS4 — Keybindings

`App.tsx:318-345`, three changes:

1. **Add the typing guard the Ctrl+Z branch is missing.** Ctrl+A three lines below it already does the check (`App.tsx:329-331`), and so does the timeline's own key hook (`useTimelineKeys.ts:30-31`). Today Ctrl+Z in a text field calls `e.preventDefault()` (`:322`) — killing the field's native undo — and reverts the fixture array instead. **After widening it would revert the entire document while the operator is trying to un-type a character in the Length field.** Requirement 6. Reuse the exact predicate:
   ```ts
   const el = e.target as HTMLElement | null;
   const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
   if (typing) return;   // let the field's native undo run
   ```
2. **Do not register the listener at all when `SHOW_ENGINE`** (WS2).
3. Leave Ctrl+Y → redo (`:324-327`) as-is, but note it appears in **neither** menu (see WS5).

### 5.5 · WS5 — Both menus, and the 3D gizmo latch

**The menus already carry Undo/Redo and already dispatch correctly** — `menu.ts:60-61` → `IPC.MENU_ACTION` → `App.tsx:1557` → `dispatchMenu` (`:1524`) → `undo()` / `redo()` (`:1544-1545`); `MenuBar.tsx:64-65` → `MenuBar.tsx:154` → the same `dispatchMenu`. **So the menu work is not "add the items". It is deciding whether to light up `canUndo`/`canRedo` (`App.tsx:114-115`, destructured and never used), and doing it in BOTH mirrors or NEITHER.**

The asymmetry that makes this a real decision:

- `MenuBar.tsx` is a renderer component — it can read `canUndo`/`canRedo` from props and grey the items out for free.
- `menu.ts` builds a **static template once** (`template()`, `menu.ts:24`). Reflecting `canUndo` in the native menu means a new IPC channel (`renderer → main: history-state`) plus a `Menu.setApplicationMenu(...)` **rebuild on every history change** — i.e. on every keyframe nudge. That is real churn in the main process for a cosmetic gain.

**Recommendation: ship NEITHER.** Leave both menus always-enabled; `useHistory.ts:22`/`:33` already make `undo`/`redo` no-ops when the stack is empty. The menus stay byte-for-byte in agreement, which is the house rule, and no per-edit IPC is added. If a human wants greying (§10 Q3), it must land in both mirrors in the same commit.

Two mirror defects worth fixing while both files are open (cheap, and they are divergences today):
- **Ctrl+Y** is handled in the keydown (`App.tsx:324-327`) but is advertised in **neither** menu.
- Redo's accelerator is `CmdOrCtrl+Shift+Z` in `menu.ts:61` and `Ctrl+Shift+Z` in `MenuBar.tsx:65` — consistent in effect, but the renderer mirror hard-codes `Ctrl` where the native one is platform-aware.

**Also in WS5:** add the `Stage.tsx:557-560` moved-latch to `ModelObject.tsx:120`, `PlaneObject.tsx:46` and `FixtureGizmo.tsx:34` (§5.1), so a gizmo *click* stops pushing an entry. `handleCommitFixture3D` (`App.tsx:628-633`) deliberately does not re-record ("history already recorded at drag-start") — that stays true.

---

## 6. ⚠️ Breaking changes (warn loudly)

- **Persisted `.artlux` schema: ❌ NOT TOUCHED.** `DocSnapshot` is a renderer-local interface, never serialised, never sent over IPC. No `ProjectData.version` bump. No normalizer. Old and new projects load identically. **Zero migration.**
- **`shared/protocol.ts` / IPC / preload: ❌ unchanged** — *provided* §10 Q3 is answered "no menu greying". Wiring `canUndo` into the native menu would add an IPC channel; that is the only path in this plan that touches the contract.
- **`@artlux/sdk` and plugins: ❌ unchanged.** No plugin consumes `useHistory`, `recordHistory` or `handleTimelineChange` (grep: every `onRecordHistory` site is core — `Stage.tsx`, `Simulator3D/*`, `HeadlessRunner.tsx:101`). The audio plugin's fade-layer contract is untouched.
- **⚠️ BEHAVIOR REMOVAL #1 — a scene recall and a cue GO stop being undoable.** They record today (`App.tsx:792`, `:980`) and they will not after WS2 (unless §10 Q1 says operator-initiated recalls should). **Who notices:** an operator who clicks GO on the wrong scene and reaches for Ctrl+Z. **Why it is right anyway:** the recall is *not destructive* — the scene it came from still exists and can be recalled again — whereas today's undo of a recall restores only `fixtures` and leaves the recalled `surfaces` / `globalBrightness` / `scene3D` / `projectorOutputs` standing (`App.tsx:796-801`), producing **a torn state that never existed**. We are removing a broken affordance, not a working one. Say so in CHANGELOG.
- **⚠️ BEHAVIOR REMOVAL #2 — Ctrl+Z no longer works inside text fields as a document undo.** It becomes the *field's* native undo (WS4). This is a fix, and it is also a habit change.
- **⚠️ BEHAVIOR ADDITION (the loud one) — Ctrl+Z now reverts the WHOLE DOCUMENT.** An operator whose muscle memory is "Ctrl+Z nudges a fixture back" will now find it also reverts their last timeline edit, their last 3D-model move, their last scene creation — because those are all now in the same linear stack. There is **one undo stack, not one per panel.** That is the correct model for a document, and it will surprise people. It also means an undo *while a scene is bound* reverts an edit that may have been made against the *global* document (or another scene) — the stack is document-wide, not per-binding. **The alternative (a stack per bound document) is a genuinely different design; it is §10 Q5.**
- **⚠️ BEHAVIOR CHANGE — the undo stack is now cleared on File→New / File→Open** (`reset()`, WS3). Today it survives, which is the bug that pastes the previous project's fixtures across an open.
- **No UI is removed.** Both menus keep exactly the items they have.

---

## 7. Risk evaluation — 🔴 **High**

Not because the diff is large — it is not — but because it puts a new write on the hottest, most invariant-laden path in the app, and because it changes what a keystroke every operator uses reflexively does.

**Blast radius, grepped:**
- `useHistory` — **one** instantiation, `App.tsx:109-125`. Widening `T` re-types `record`/`undo`/`redo` at that one site. `set` is `setFixtures`, used at `App.tsx:2229`/`:2335` (Stage's 60 Hz drag) and in ~14 handlers — **all of those keep working only if `set` keeps its `Fixture[]` meaning**, which it cannot once `T` is a document. **This is the sharpest edge in the whole plan:** `useHistory`'s `state`/`set` pair currently *is* the fixtures `useState`. Widening `T` means `fixtures` must come out of the hook and become a plain `useState` again, with the hook holding a snapshot assembled from all the slices. Every one of the ~20 `setFixtures` call sites must keep working unchanged. Plan for it explicitly in P2; it is the step most likely to produce a silent regression.
- `recordHistory` — 14 direct call sites (`App.tsx:377, 389, 390, 572, 587, 596, 657, 792, 889, 980, 1063, 1116, 1259, 1285`) + 2 prop paths (`:2346` → Stage, `:2395` → Simulator3D → 3 gizmos) + 2 deliberate no-ops (`:2240`, `HeadlessRunner.tsx:101`). **Four of the 14 change meaning** (:792, :980 → origin-gated; :1116, :1285 → `reset`), and **four are fixed for free** (:377, :389, :390, :889 — the wrong-slice ones).
- `handleTimelineChange` — 2 prop sites (`App.tsx:2457`, `:2659`), both `TimelinePanel`. Nothing else.

**Top things most likely to break in practice:**

1. **The `set`/`fixtures` untangling (above).** A `setFixtures` that silently stops updating `fixtures`, or a `record()` that snapshots a stale `fixtures` because it now reads from a different `useState`, is a regression with no type error. This is where a mistake hides.
2. **A reference snapshot against an in-place mutation** (§5.3, §10 Q2). Symptom: undo appears to do nothing for one specific slice. Silent, and it will be blamed on the timeline.
3. **A snapshot on the expensive path.** If the deep clone is *not* removed, every pointerup adds a whole-project JSON round-trip to a path that already does `setData` + `warmMedia` + `compileAutomation` + a structured-clone `postMessage` to every projector (`App.tsx:1588-1590`). Watch frame time in the Perf tab (Ctrl/Cmd+Alt+P, `App.tsx:337-341`) during a keyframe drag.
4. **Undo fighting a live FSM.** If the state machine is enabled in the editor and the operator undoes an edit to the scene the machine is *currently playing*, `activeTimeline` changes under a running pool and `setData` re-fires mid-show. The existing pool guard (`:1587`) makes this well-defined, not undefined — but "well-defined" is not "desirable". **§10 Q6.**
5. **Redo semantics.** `record()` clears `future` (`useHistory.ts:48`). Once show events stop recording, an FSM hop no longer nukes the redo stack — which is *better*, and also a change: a redo can now survive a recall, and land on a document the show has since moved on from.
6. **Memory in a long editing session.** `MAX_DEPTH = 100` with structural sharing bounds it; without the cap, a superseded scene timeline is retained per entry, forever.

**Not at risk:** WebGPU/WebGL parity (no render-path change), the native engine, Art-Net output (`Stage`'s rAF is untouched), the projector `MessagePort` bridge (it re-fans-out through the *existing* effect), plugin singletons (no new module, no alias import), the watchdog.

---

## 8. Migration & back-compat

- **No project migration.** Nothing persisted changes. A project saved before this lands and a project saved after are byte-identical in shape.
- **No prefs migration.** `MAX_DEPTH` is a module constant, not a pref (unless §10 Q3 makes it one).
- **Downgrade is trivially safe** — the history lives only in renderer memory.
- **The undo stack does not survive a process restart, and must not start to.** `watchdog.ts:6-9` explains why the watchdog relaunches instead of reloading: *"applyProjectData has no teardown for media-cache blob URLs / decode pools / **undo history**, so a fresh process each recovery avoids accumulated leaks."* Persisting history would invalidate that reasoning. Out of scope, deliberately.

---

## 9. Verification (repo patterns — **there is no test runner; do not plan unit tests**)

**Gates:** `npx tsc -p tsconfig.json --noEmit` · `npm run build` · `npm run verify:plugins` · the design-token grep (per CLAUDE.md:26 / `docs/UI-UX-AUDIT.md` — this plan adds no new UI, so it should be a clean no-op; run it to prove that).

`tsc` earns its keep here: widening `T` is exactly the kind of change the compiler catches at all ~20 `setFixtures`/`recordHistory` sites. **Get to a clean `tsc` before touching a menu.**

**Human live smoke test — the only thing that actually proves this works.** Build a fixture project with ≥3 scenes, each with its own timeline (≥10 clips, ≥2 automation lanes), an FSM that hops between them, and a projector output attached.

*Proves the feature:*
1. **The Wave B scenario.** Drag a clip → release → Ctrl+Z. **Expect:** the clip returns to where it was, and the projector shows it back (the fan-out re-fires via `App.tsx:1581-1591`). Redo → it moves again.
2. **Scene-scoped.** Enter author mode on scene S. Nudge a keyframe → Ctrl+Z. **Expect:** S's automation reverts; the **global** timeline is untouched; the bound pill still says S.
3. **One entry per gesture, not 60.** Drag a clip slowly across the lane for ~3 seconds, release. Ctrl+Z **once**. **Expect:** it lands back at its origin in ONE press. Same for a keyframe drag, a layer reorder, an in/out region drag, and a layer-height resize (§4 — these were the four suspected of per-frame commits; they are not).
4. **Every commit site.** Walk the 24 rows of §5.1 and confirm each is one undo press.
5. **The wrong-slice fixes.** Add a 3D model → Ctrl+Z → **the model is gone** (today it is not). Create a state → Ctrl+Z → the scene *and* its `SmState` node are gone.

*Proves the 3am problem is closed — this is the acceptance test that matters:*
6. **Leave it running.** Enable the FSM with recalls + a `setLoop` entry action. Make **one** operator edit (nudge a clip), note it. Let the machine hop for 10+ minutes with nobody touching the app. Then press Ctrl+Z **once**. **Expect: it undoes YOUR clip nudge** — not an FSM recall. Confirm the stack did not grow (temporarily log `past.length`, or watch renderer heap in the Perf tab, Ctrl/Cmd+Alt+P).
7. **OSC.** Fire 50 recalls + cue GOs over OSC (`oscController.ts:31-40`). **Expect:** stack depth unchanged.
8. **Broadcast.** Launch `--broadcast --project=<fixture>`, press Ctrl+Z. **Expect: nothing happens** (SHOW_ENGINE gate, WS2) — and no history is ever built.

*Proves nothing regressed:*
9. **Text fields.** Type `900` into the Length field, press Ctrl+Z **before** blurring. **Expect:** the *field* un-types a character. The document does **not** revert. Repeat in a marker-note field and a fixture-name field.
10. **The Stage latch survives.** Drag a fixture across the 2D stage for 3 seconds → one Ctrl+Z restores it (`Stage.tsx:557-560`). Click a fixture without moving it → Ctrl+Z does **not** consume an entry (`:749` resets `hasMoved`).
11. **The gizmo latch (new).** *Click* a 3D gizmo without dragging → Ctrl+Z does **not** revert the previous edit (today it consumes a junk entry).
12. **Project open clears the stack.** Open project A, edit it, File→Open project B, press Ctrl+Z. **Expect: nothing happens.** (Today this pastes A's fixtures into B — and after widening, without `reset()`, it would paste *all of A*.)
13. **Depth cap.** Nudge a keyframe 150 times. **Expect:** the 101st-from-last is gone, the last 100 undo cleanly, renderer heap is flat-ish, and the drag stays smooth (no JSON round-trip on the commit path).
14. **Headless output.** `--headless --project=<fixture>` with a dgram ArtDmx listener → output is byte-identical to before the change.

---

## 10. Effort & phasing

**Size: M/L.** Small diff, high blast radius. The `set`/`fixtures` untangling (§7.1) is the load-bearing step, not the timeline wiring.

Land in **four commits, in this order — the order is not negotiable**, because widening the snapshot before drawing the operator/show line would ship an FSM that fills an unbounded stack with megabyte snapshots:

- **P0 — Harden the hook, no behavior change.** `useHistory.ts`: add `reset()`, add `MAX_DEPTH` + FIFO eviction, replace the JSON deep clone (`:46`) with a reference snapshot. `T` is still `Fixture[]`. **Verify:** the fixtures history behaves exactly as it does today (test 10), and Stage's 60 Hz drag still coalesces to one entry.
- **P1 — Draw the line.** `EditOrigin` on `handleRecallScene` (`App.tsx:791`) and `applyCues` (`:978`), defaulting to `'show'`; the `SHOW_ENGINE` gate on `record`/`undo`/`redo` and on the keydown registration. `T` is *still* `Fixture[]`. **Verify:** tests 6, 7, 8 pass *now*, before the snapshot grows. This commit alone fixes a live leak.
- **P2 — Widen `T`.** Pull `fixtures` out of the hook into its own `useState`; make `T = DocSnapshot`; `record()` assembles it from the live slices; `undo`/`redo` fan the restored slices back out to the setters. `applyProjectData` (`:1116`) and `resetToNewProject` (`:1285`) switch from `record()` to `reset()`. **This is the commit that can silently regress `setFixtures` — get `tsc` clean, then run tests 5, 10, 12.**
- **P3 — Wire the timeline and tidy the edges.** `record()` in `handleTimelineChange` (`App.tsx:914`) + the doctrine comment; the typing guard on the Ctrl+Z branch (`:320-323`); the moved-latch on the three 3D gizmos; the two menu mirrors (per §10 Q3 — most likely: change nothing but the Ctrl+Y advertisement, in both). **Verify:** tests 1-4, 9, 11.

Each commit is independently shippable and independently revertable. **P1 is worth landing even if the rest slips** — it stops an unattended install from growing an unbounded junk stack tonight.

---

## 11. Open questions / decision points

1. **Should an OPERATOR-initiated scene recall or cue GO be undoable at all?** They record today (`App.tsx:792`, `:980`), so removing it is a user-visible removal (§6). The argument for **no**: a recall is not destructive (the scene still exists; recall it again), and today's undo of one is *torn* — it restores `fixtures` and leaves the recalled `surfaces`/`brightness`/`scene3D`/`projectorOutputs` standing (`:796-801`). The argument for **yes**: the operator clicked GO on the wrong scene and the *live look* is now wrong; after widening, the undo would no longer be torn, so the objection evaporates. **This plan assumes YES for operator-origin and NO for show-origin, but the decision belongs to a human.** It is one boolean at two call sites.
2. **Is every state writer truly immutable?** §5.3's reference-snapshot design (the thing that makes the memory arithmetic work) depends on it. Every writer read for this plan spreads — but "every writer I read" is not "every writer". **Audit the 3D commit path first** (`onCommitModel` / `onCommitFixture3D`, `App.tsx:628-633`, and the three gizmos), because it already diverges from the Stage precedent. If a mutator is found: fix the mutator, do not reinstate the deep clone.
3. **Do we surface `canUndo`/`canRedo` at all?** They exist and are dead (`App.tsx:114-115`). Greying the items out is free in `MenuBar.tsx` and **expensive in `menu.ts`** (a static `template()` → needs an IPC channel + `Menu.setApplicationMenu` rebuild on *every* history change). **Recommendation: NO, in both mirrors** — the house rule is that the two menus never diverge, and a per-edit IPC to grey a menu item is a bad trade. If a human wants it, it must land in both files in one commit. *(Related, and cheap: should the operator see undo **depth** anywhere — a StatusBar hint? Today nothing does.)*
4. **What is in `DocSnapshot`?** This plan proposes the authored document (fixtures, surfaces, groups, scenes, timeline, cueBanks, stateMachine, audioMix, scene3D, globalBrightness) and **excludes** `assets` (the managed library), `schedule`, `controllers`, `projectorOutputs` and `settings`. Undoing a projector-output config or a controller mapping mid-show is a footgun, not a feature — but that is a judgement call, and `projectorOutputs` in particular *is* written by `handleRecallScene` (`:801`), so excluding it from the snapshot means a recall's output change is not reverted by an undo of that recall. **Decide the boundary explicitly.**
5. **One stack, or one stack per bound document?** This plan ships **one linear document-wide stack** (§6). That means an undo while scene S is bound can revert an edit the operator made to the *global* timeline five minutes ago, which will read as "Ctrl+Z did something I can't see". A per-binding stack is a materially different design (and a second history system, which the brief forbids by default). **Recommend one stack; name the surprise in the docs.**
6. **Should undo be blocked while the state machine is running?** An undo that rewrites the scene the FSM is currently playing re-fires `setData` on a live pool (`App.tsx:1581-1591`, guarded at `:1587`). Well-defined, but is it what anyone wants? Options: allow it (status quo of this plan), block it with a toast while `stateMachine.enabled`, or allow it and warn once.
7. **Should the other destructive operator edits join the stack?** They are outside R5b's letter but inside its spirit, and two of them tell the user the truth today: **asset relink** (`App.tsx:1488-1495`, whose confirm reads *"can't be undone"*, `:1460`) rewrites the global timeline, **every scene's timeline**, and the bed — it is the single most destructive operation in the app. **Asset delete** (`:1435`, confirm at `:1427`). **`fixLength`** (`Timeline.tsx:233-236`) is a one-click document write whose own comment notes it happens *"with no undo"* (`:206`, `:231`) — it routes through `onChange`, so **P3 makes it undoable for free**, and its comment should be corrected. The `surfaces` mutators (`handleAddSurface` :429, `handleRemoveSurface` :450, `handleMoveSurface` :441, `handleUpdateSurface` :564, and **the 2D surface drag** — `Stage.tsx:520` `onSurfaceMove` → raw `setSurfaces`, `App.tsx:2224`/`:2329`) record nothing either, and `surfaces` **is** in the snapshot — so they would need the same treatment (and the surface drag needs the Stage moved-latch) or undo will restore surfaces the operator did not expect to move. **This is the biggest scope question in the plan: is R5b "the timeline", or is it "the document"?** The architecture here is the document; the wiring is scoped to the timeline. Someone must say where P3 stops.
   *Update 2026-08-07: the **state-graph editor** joined the stack — every graph edit records through `patch()` in `StateGraphEditor.tsx` (time-coalesced per gesture), wired via `onRecordHistory` in `adapters.tsx` and guarded by `verify:invariants`; `handleCreateState` records too.*
   *Update 2026-08-07 (later): **scene deletion, surface deletion, and the scene3D writers** (add/remove model, scene config) joined as well — all guarded by a second invariant, which also asserts the gizmo COMMIT paths stay record-free (the latch already recorded). The surfaces mutators turned out to already record (this Q's list was stale). **Still deliberately out: asset relink/delete** — `assets` is excluded from `DocSnapshot` (Q4), so recording them would produce a torn undo: clips restored, library entry still gone. Their confirms keep saying "can't be undone", truthfully.*
