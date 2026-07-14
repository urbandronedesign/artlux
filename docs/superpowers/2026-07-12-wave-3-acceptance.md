# Wave 3 — Acceptance test script + close-out

Branch `wave-3-audio` @ `a7ba256`. Nothing here has been run by a human except Wave A (transport bar), which
you already passed. Everything else in this document is **first contact**.

Two parts only: **Part 1** is what you do at the app. **Part 2** is what must be true to merge.

---

## ⚠️ READ THIS FIRST — the bug you are going to report that is not a bug

**A fresh project's global timeline is `Length 60 s, Loop OFF`. The global timeline's Length is now the SHOW's
length, and the audio bed lives inside it. So: drop a 6-minute music bed on a new project, press Play, and the
music STOPS DEAD AT 1:00 and stays silent — even while a looping scene keeps playing its picture and its own
audio, and even while the Play button stays lit.**

That is **by design** (`defaultTimeline()` — `duration: 60, loop: false`). The show ended. The bed is part of the
show.

The app's only signal that this happened is the **amber `show ended` badge in the Audio Bed panel**. Three things
fix it: raise the global Length, turn global Loop ON, or Stop → Play.

**The one thing that IS a bug:** the bed silent with **no `show ended` badge lit**. That combination — Play lit,
picture moving, room silent, badge dark — is the single most dangerous reading on the panel. Report that
immediately.

Second most likely false report: *"I shortened my global timeline and the music died."* You shortened the show.
Same rule (test 2.4).

---

# PART 1 — THE TEST SCRIPT

Sessions are ordered by dependency, then by cost. Do them in order. Tick as you go.

| # | Session | Time | You need |
|---|---------|------|----------|
| 0 | Build & repo gates | 20 min | terminal, app CLOSED |
| 1 | Build the fixture | 40 min | the assets listed below |
| 2 | The headline: the bed never restarts | 45 min | fixture, ears, stopwatch |
| 3 | The show's length: park, wrap, hard-cut | 40 min | fixture |
| 4 | Seek, exit-to-global, reconverge | 40 min | fixture + one FSM state |
| 5 | Cheap regressions (C5, I3, I1) | 20 min | fixture |
| 6 | Audio lanes — authoring | 50 min | fixture, React DevTools |
| 7 | The driver — mixer, solo/mute/fades | 45 min | fixture |
| 8 | Fades, cues and scenes carrying audio | 60 min | dev console + a cue bank |
| 9 | The FSM rig (C3 / C4 / I5 / I6) | 45 min | an FSM with a timed hop |
| 10 | Collect Assets & portability (C1, K-group) | 45 min | the 2-file WAV fixture |
| 11 | Junk-JSON tolerance (C2, M2, M3, M1) | 40 min | a text editor, **monitors down** |
| 12 | The soak | 30 min unattended | patience |

Total ≈ **8 hours**, splittable. Sessions 0–5 are the ones that decide whether Wave 3 merges; if you only have
one evening, do 0–5 and 10.

**Tags:** **[BLOCKER]** = Wave 3 cannot merge if this fails. **[REGRESSION]** = proves a fixed defect stays
fixed. **[WATCH]** = cannot be proven by hand in a smoke test; look for it in the soak.

---

## SESSION 0 — Build & repo gates (20 min)

The dev app must be **CLOSED** for any native step. A running app locks `audio_engine.node`; the link fails with
`LNK1104` and **silently leaves the stale addon in place**, so a working fix looks broken.

- [x] **0.1 [BLOCKER]** — the tree builds, and it builds the audio engine. ✅ **PASSED** (2026-07-13, `67ecdbf`)
  **DO:** with the app closed, run each; every one must exit 0.
  ```
  npx tsc -p tsconfig.json --noEmit
  npm run build
  npm run build:audio          # strict — must actually compile the JUCE addon
  npm run verify:plugins       # runs against BUILT output; a stale dist/ will lie
  node scratch/showclock-sim.mjs   # every assertion PASS
  ```
  **EXPECT:** exit 0 everywhere; `showclock-sim` prints all PASS.
  **IF IT FAILS:** `build:audio` failing is **gate 1** — tell Claude the exact cmake/cmake-js error and whether
  the app was closed. (Gate 1, SEQUENCING.md.)
  **RESULT:** all five exit 0; `build:audio` genuinely relinks the addon (`audio_engine.vcxproj ->
  audio_engine.node`); `showclock-sim` prints **99/99 assertions PASS**.

- [x] **0.2 [BLOCKER]** — the packaged app has sound. ✅ **PASSED** (2026-07-13, heard by ear)
  **DO:** `npm run package`. Open the packaged app (not the dev app). Load a wav on the bed. Press Play.
  **EXPECT:** you hear it.
  ⚠ **This test's premise changed under `473d259`.** `package` is **no longer** gated by `build-audio.cjs
  --check`; it now runs the **strict build** (`package: node scripts/build-audio.cjs && electron-vite build &&
  electron-builder`). `--check` only asserted the addon EXISTS, never that it was CURRENT — so you could edit
  `engine.cpp`, package, and ship the PREVIOUS engine. It cannot refuse to build any more; it builds.
  **ALSO CHECK:** `resources/audio-engine.node` exists in the packaged app **and postdates the newest C++
  source**. A binary older than `engine.cpp` is the silent-stale-engine failure wearing a passing grade.
  **IF IT FAILS (silently, i.e. it packages and there's no sound):** the loader graceful-degrades and you get a
  complete audio UI with no sound. Tell Claude: *"package succeeded and the packaged app is silent"*.

- [x] **0.3** — graceful degrade still degrades. ✅ **PASSED** (2026-07-13) — **after a fix; it FAILED as first run.**
  **DO:** rename `audio-engine.node` away. Start the app.
  **EXPECT:** app starts, audio UI renders, no crash, and a **visible** notice that the engine is missing.
  **IF IT FAILS:** a crash is a blocker; a *silent* dead engine with no notice is gate 1's other half — report it.
  **RESULT — this test did its job.** First run: no crash, audio UI rendered — and **no notice**. The only
  warning in the app was an inline line inside **Settings ▸ Audio**, which you reach only by already suspecting
  the answer. The mixer drew a complete, healthy-looking UI over a silent room: gate 1's other half, exactly.
  **Root cause:** the renderer could not *ask* whether the engine had loaded. `audioManager` exported
  `available` and **nothing consumed it**; the UI inferred a dead engine from `configure()` returning an empty
  device string — a guess derived from a side effect.
  **Fixed** (`1bd9d6d`, `073e336`, `67ecdbf`; spec:
  `docs/superpowers/specs/2026-07-13-audio-engine-missing-notice-design.md`): an `audio:available` IPC probe
  (mirroring `calib:available` / `ndi:available`), a **dismissible startup modal**, and a persistent amber
  **`no audio engine`** badge in the Audio Bed panel header — because the modal is dismissible, and without the
  badge the app would look healthy again the moment you closed it. **No "don't show again":** a warning you can
  silence forever is how a machine ends up mute with nobody knowing.
  **RE-TEST BOTH HALVES.** Engine hidden → modal + badge. Engine restored → **no** modal, **no** badge, sound
  plays. A warning that is always on is as useless as one that never fires.

- [x] **0.4** — the source gates. ✅ **PASSED** (2026-07-13)
  ⚠ **Three of these gates were broken as written, and are corrected below.** Two matched **their own text in
  this document** (they were unscoped, so `git grep` found the very lines that specify them). The third banned an
  identifier that has since become load-bearing.
  ```
  git grep -n "text-\[[0-9]" -- src/renderer/components/timeline/ plugins/audio/
  git grep -n "transport: 'preserve'" -- src/ plugins/          # SCOPED: was matching this file
  git grep -n "getStatus().playhead" -- plugins/audio/
  git grep -n "'audio'" -- src/renderer/services/automationTargets.core.ts
  git grep -n "only ever one running transport" -- src/ plugins/  # SCOPED: was matching this file
  ```
  ~~`git grep -n "prevPlayhead" -- plugins/audio/`~~ — **RETIRED. Do not restore it.** This gate was written when
  the bed was the audio driver's only container, and it meant *"the bed must not ride the playhead."* Since
  `Timeline.audio` became a **second** container (`f335263`, `06b5a9a`), a playhead-based seek test is not merely
  legal but **required**: `plugins/audio/src/plugin.renderer.ts:675-687` keeps two, and they are what this suite
  is built to prove — `showSeeked` (from `prevShowTime`) stops **only `bed.clips`**, `phSeeked` (from
  `prevPlayhead`) stops **only `tlAudio.clips`**. That is the bed-rides-the-show-clock / scene-audio-rides-the-
  playhead split behind tests 2.4, 3.2 and 4.5. Deleting `prevPlayhead` would stop a scene's own audio ever
  resyncing on a scene scrub. **What the gate MEANT still holds** and is asserted by `getStatus().playhead`
  above, plus `showclock-sim`'s row-4 driver assertion.
  *(Plan: Global Constraints "Verification reality"; Final gate #10.)*

---

## SESSION 1 — Build the fixture (40 min)

Build this **once**. Half the tests need it. Keep it. Call it **`WAVE3-ACCEPT`**.

**Source assets — keep them OUTSIDE the project folder** (Session 10 needs that):

| File | What | Why |
|---|---|---|
| `bed5min.wav` | 3–5 min of music with a **melody or vocals** — NOT a drone | you must hear "it kept playing" vs "it jumped to the top" by ear alone |
| `scene-sfx.wav` | a short distinctive loop (a beep every second) | tells scene audio apart from the bed |
| `a.mp4` | video, used **only** on the global timeline | Collect Assets coverage |
| `b.mp4` | video, used **only** on one scene's own timeline | Collect Assets coverage |
| `c.png` | image, used **only** in a scene's look snapshot | set a surface to it, capture the scene, then change the live surface to an Effect so the global doc no longer references it |
| `d.wav` | 5–20 s audio, used **only** on the bed | Collect Assets coverage |
| `roomA/loop.wav` + `roomB/loop.wav` | **different audible content**, identical name, identical format and length → **identical byte size** (e.g. 8 bars @120 bpm = 16.000 s, 48k/24-bit stereo = 4,608,044 bytes each) | Session 10, defect **C1**. Build these now — a bounce of two different 16 s loops out of any DAW at the same settings does it. |

**Project structure:**
1. **Global timeline:** Length **300 s**, Loop **OFF**, fps 30. `a.mp4` on a layer spanning 0→300.
2. **The BED:** Audio Bed panel → add a BED track → drop `bed5min.wav` at 0:00. Add a second BED track (needed for
   solo). Drop `d.wav` on it somewhere.
3. **S1** — its own timeline, Length **20 s**, **Loop ON**, obviously different picture (`b.mp4`), plus
   `scene-sfx.wav` on **its own** `Timeline.audio` lane at its 0:00.
4. **S2** — its own timeline, different picture, different length.
5. **S3** — its own timeline, different picture. (Uses `c.png` in its look snapshot — see the table.)
6. ~~**S-noTL** — a scene with **NO timeline of its own**.~~ ⚠ **DELETED 2026-07-14 — THIS SHAPE NO LONGER
   EXISTS.** The merge review found that a timeline-less scene was the root of **two automation-clock
   blockers**, and the cure was to delete the state: `Scene.timeline` is now **required** (merge-blocker plan,
   task 5). You cannot author one, and the loader defaults a missing timeline to an **empty** one.
   **If your fixture predates 2026-07-14 it still carries S-noTL** — recalling it now gives you an empty
   timeline and a **black output**, which is correct and will look like a bug. **Delete the scene:** Scenes
   tab → hover its cell → trash. (All four tests that used S-noTL have been rewritten: **2.2, 3.5, 4.5, 4.7**.)
7. **A global automation lane on the master.** Bind **Global**, open the timeline's automation lane for
   `audio.master.gain`, and draw a **slow ramp down** across the first ~60 s. This is what tests 2.8 and 4.7
   ride, and it is the single highest-value thing in the fixture: it is the lane the +9.6 dB blocker moved.
8. **Save.** Keep a **stopwatch** (your phone) at hand — several tests are "did it keep time".

**Where you can SEE the show clock** — you will need these constantly:
- Timeline toolbar: **`♪ BED m:ss`** — appears **only while a scene is bound**.
- Audio Bed panel header: **`♪ m:ss`** + scrub slider + the amber **`show ended`** badge.
- The bed's audio lanes are drawn on the timeline **only while Global is bound**. They vanish under a scene **on
  purpose**. That is a designed signal, not a bug.

---

## SESSION 2 — The headline: the bed never restarts (45 min)

*This is the entire point of Wave 3B. If only one session survives, it is this one.*

> ### ✅ SESSION 2 PASSED — 2026-07-13. All of 2.1 → 2.7, including 2.7 on a **windowed** projector output
> (Outputs → display → *Windowed (this screen)* — no second monitor needed; `docs/CALIBRATION.md:99-107`).
> **The bed does not restart.** Not on a GO, not through S-noTL ten times, not across six loop wraps of S1,
> not across a 30 s pause. The picture and the scene's own beep restart underneath it, exactly as designed.
> Run against the hand-authored `WAVE3-ACCEPT` fixture (see Session 1).
>
> **Two defects were found while running it. Neither is a bed defect; both are recorded below.**
>
> ### ⚠ AND THIS ✅ IS STALE — SESSION 2 MUST BE RE-RUN (2026-07-14).
> That run is a true record of the code **as it was on 2026-07-13**. It is not evidence about the code you are
> about to merge. The merge review changed the scene model underneath this session: `Scene.timeline` became
> **required** (task 5), Capture Scene stopped cloning the global automation lanes (task 6), `swapTimelineForScene`
> and `clocksCoincident()` were rewritten, and `setGlobalDoc` was fixed for a Length edit that split the two
> clocks (task 4). **Every one of those is on the recall path this session tests.** The bed's own mechanism
> (`showTime`) was not touched and the property should hold — but "should hold" is what a ✅ is supposed to
> replace. **2.2 no longer tests what it used to test** (its subject was deleted; see below), and **the run
> above never exercised Capture Scene with a live global lane, which is where the +9.6 dB blocker actually
> lived.** Re-run 2.1 → 2.8. It is 45 minutes.

---

## ⚠ FINDINGS FROM THE ACCEPTANCE RUN (2026-07-13)

| # | Finding | Status |
|---|---|---|
| 1 | **A missing audio engine announced nothing.** Rename `audio-engine.node` away and the app degrades *perfectly* and says nothing — a healthy-looking mixer over a silent room. The only warning was buried in Settings ▸ Audio. **Root cause: the renderer could not *ask* whether the engine had loaded** — `audioManager` exported `available` and nothing consumed it; the UI inferred a dead engine from `configure()` returning an empty device string. | ✅ **FIXED** — `audio:available` IPC probe (mirroring `calib:`/`ndi:`), a dismissible startup modal, and a persistent `no audio engine` badge. `1bd9d6d`, `073e336`, `67ecdbf`. Spec: `specs/2026-07-13-audio-engine-missing-notice-design.md`. Test **0.3** now passes. |
| 2 | **The picture went BLACK on pause, on stop, on a scrub and on a clip-position drag** — on the main window *and* every projector. **PRE-EXISTING, not Wave 3's** (byte-identical on `main`, blame `af8f727f`, 2026-06-22). Invisible until now because it only bites plain `<video>` clips — HAP and GPU-decoded MP4 take the codec path, which holds its frame. Meanwhile `docs/TIMELINE.md:99` promised *"the output doesn't cut to black."* | ✅ **FIXED** — `2fe6fb5`. Two defects, one cause: (a) a `!playing ||` short-circuit re-seeked the `<video>` **60×/s to the position it was already at**, so it never finished a seek and `readyState` never reached the `>= 2` the drawable gate demands; (b) **nothing retained a frame** — `buildProgram()` clears before compositing, so an undrawable layer is not *frozen*, it is *black*. Now: consult the drift in both states, and hold the last good frame across a seek. |
| 3 | **Effects keep animating while the transport is PAUSED.** Pause the show and generative content carries on moving — so effects run on a clock that is not the transport's. Noticed as a contrast while diagnosing #2 (the effect surfaces were the only ones that did *not* go black). | ✅ **FIXED 2026-07-14 — `07ae260`** (merge-blocker task 10; the user put it *on* the merge bar). `surfaceMedia.ts:47` handed an effect surface `performance.now()/1000` — **raw wall time**. It never read the transport at all. The `isPlaying` gate existed but only ever reached the video codecs; an effect is driven by the `timeSec` argument, and wall time does not stop. `contentSource.ts:179` documented it as deliberate — *"clip-local for timeline clips, wall-clock for surfaces"* — which is the wrong call for a show-control app and incoherent with a wave whose whole purpose was one transport. Effects now ride the **SHOW clock** (so a GO does not restart an ambient background, exactly like the bed). ⚠ **Half the fix is the projector:** `getShowTime()` is 0 in a mirror window, so changing only `surfaceMedia` would have **frozen every projector effect at zero** — strictly worse than the bug. The show clock is now streamed over the transport bridge (`setExternalShowTime`), so the preview and the audience are in phase. **Test 2.8b.** |
| 4 | **The `⏮`/`⏭` transport buttons were never built.** They are in the transport sketch (`plans/timeline-transport-and-audio-scoping.md:98`) but Wave A's plan narrowed to *"the three controls that never had a button: Stop, Set In, Set Out"* and they silently dropped out. Wave A passed its own acceptance because it did everything **its** plan asked. | 📋 **LOGGED** — `plans/transport-edit-point-navigation.md`, held on `feat-transport-skip` until Wave 3 merges (same file). Not a Wave 3 concern. |

- [ ] **2.1 [BLOCKER] — the bed survives GO.** *(Plan T-A1 / reset-table row 4.)*
  **DO:** 1. Bind Global. 2. Play. 3. Let the bed reach **~0:45** — somewhere with an unmistakable melodic
  landmark. 4. GO on S1. Then S2. Then S3. Then S1 again. Keep going for a **full minute**, listening.
  **EXPECT:** the music **does not flinch** — no gap, no click, no restart, no pitch or level glitch, ever. The
  **picture** restarts on every GO. `♪ BED` appears in the toolbar and **keeps climbing** in real time. The
  transport never pauses. The bed's lanes disappear from the ruler while a scene is bound (correct).
  **IF IT FAILS:** if the music jumps back to 0:00 on a GO, the bed is riding the *playhead* and not the show
  clock — this is the original bug and Wave 3 does not merge. Tell Claude: *which* GO (first? every one?), and
  whether `♪ BED` reset with it or kept climbing (that discriminates the clock from the driver).

- [ ] **2.2 — the timeline-less scene is GONE, and an old project carrying one loads sanely.** *(Merge-blocker
  plan, task 5. Replaces the old 2.2, which tested a shape that no longer exists.)*
  **WHY THIS CHANGED.** The old 2.2 asked whether entering a **timeline-less scene** restarted the bed — the one
  state in which the global *document* was bound while the two clocks stood minutes apart. It passed. But the
  merge review found that this state was **the root of two automation-clock blockers**: any lane copied into a
  scene from the global timeline got retagged to the scene clock *and* shadowed the real base lane by
  `targetPath`, so a house fade on `audio.master.gain` **snapped +9.6 dB on every GO and persisted to disk**.
  No fix in `timeline.ts` could work — by the time it ran, the impostor was byte-identical to a lane the
  operator had drawn. **So the state was deleted.** `Scene.timeline` is required; two of the three writers that
  could break the invariant are now structurally impossible.
  **DO:** try to make a scene with no timeline. You can't — Capture Scene always mints one. Then open a
  **pre-2026-07-14 project** that still has an S-noTL scene (your old fixture will do) and recall it.
  **EXPECT:** it loads without error and the scene recalls to an **empty timeline** (black output). It does
  **not** crash, and it does **not** silently start playing the global timeline. Delete the scene and re-save.
  **IF IT FAILS:** a white screen or a load error here means the loader's `normalizeTimeline(s.timeline)`
  default is not holding. Tell Claude what the console says.
  **THE PROPERTY THE OLD 2.2 PROTECTED — "the bed does not restart on a recall" — is still fully covered**, by
  2.1 and 2.3 against S1/S2/S3. Nothing was lost by deleting this test; a reachable hazard was.

- [ ] **2.3 [BLOCKER] — a scene's loop wrap does not touch the bed.** *(T-A2 / row 7.)*
  **DO:** GO to S1 (Loop ON, 20 s). Let it wrap **six times**, listening.
  **EXPECT:** S1's picture and its beep restart every lap. The bed runs straight through all six laps. `♪ BED`
  climbs monotonically, 20 s per lap, never resetting.
  **IF IT FAILS:** the scene's wrap is being read by the audio driver as a seek. Tell Claude whether the bed
  **restarts** (a seek) or **stutters/clicks** (a drift resync — different cause).

- [ ] **2.4 — the two clocks, heard side by side.** *(T-F2 / Task 6 #2–3.)*
  **DO:** bed at 1:00. GO S1. Wait. GO S2. GO back S1. GO back Global.
  **EXPECT:** the bed plays straight through the lot. S1's own beep starts **from S1's top every single time**.
  Back on Global, the *global* timeline's own audio restarts, and the bed still hasn't stopped.
  **IF IT FAILS:** the clock is following the ruler a lane is drawn next to, instead of the container it lives in.

- [ ] **2.5 — pause/resume is seamless on both clocks.** *(T-A4 / row 14.)*
  **DO:** play. At bed ~0:45, Pause (Space). **Wait 30 real seconds** by the stopwatch. Play.
  **EXPECT:** the bed resumes from **0:45** — not 1:15, not 0:00 — with no click. While paused, the `♪` readout
  holds a **stable** number; it does not drift.
  **IF IT FAILS:** if it comes back 30 s further along, the anchor went stale while paused. That is a **drift**
  signature and it accumulates over every pause of the day. Tell Claude the number you paused at and the number
  it resumed at.

- [ ] **2.6 — Stop returns the bed to the GLOBAL in-point.** *(T-A3 / T5 / row 1.)*
  **DO:** Set In on **Global** at 5 s. Set In on **S1** at 20 s. Bind S1. Play until the bed is at ~1:00. Stop.
  Play.
  **EXPECT:** on Stop the bed goes silent and its clock returns to the **global** in-point (5 s) — not S1's 20 s,
  which means nothing to the bed. The picture returns to **S1's own** in-point. Play resumes the bed from 5 s.
  **IF IT FAILS:** `♪` reading a scene-relative number after Stop = the show clock has no underrun test of its
  own against `globalStart` (row 13).

- [ ] **2.7 [REGRESSION] — projector windows are unaffected.** *(Row 17.)*
  **DO:** open a projector output window. Re-run 2.1.
  **EXPECT:** the projector stays phase-locked through every GO and every loop wrap. No new stutter, no snap.
  Audio still comes only from the main window.

---

## SESSION 2b — The merge review's regressions (30 min) — **ADDED 2026-07-14**

*The 16-agent review of the merge diff confirmed **39 findings**. These are the ones the user put on the merge
bar, and they are the tests that did not exist when Session 2 was first run. **The headline one is 4.7** — it
lives in Session 4 because that is where the automation tests are, but if you only have ten minutes, run 4.7.*

- [ ] **2.8 [BLOCKER] — the mixer shows what is SOUNDING.** *(Merge-blocker plan, task 13. **Found by the user
  during the 4.7 run**, which is the best possible provenance for a UI defect.)*
  **DO:** with the global master lane ramping (fixture item 7), open the **Audio Bed** and watch the **master
  fader** while the ramp descends.
  **EXPECT:** the thumb **slides down with the sound**, greyed out, wearing a **`LANE`** badge. Grab it — it
  **refuses**. Switch the lane off (the ⚡ in its timeline gutter) and it comes **back to life** at the authored
  value. Now do the same with a **scene/cue fade** on the master instead of a lane: the thumb follows, badge
  reads **`FADE`**, and it **stays grabbable** — moving it *takes the parameter back*.
  **WHY IT MATTERS:** the driver plays `lane ?? fade ?? authored`; the panel drew `authored` and nothing else.
  A house fade slid the room to 0.32 and **the fader sat frozen at 1.00** — a panel asserting a level the engine
  was not playing. It also made every takeover a **jump**: nudging that frozen fader committed from *the thumb*,
  slamming the house 0.2 → 1.05 in one frame (**+14.4 dB**) from the single most natural gesture there is.
  **IF IT FAILS:** tell Claude which fader (master / track / clip) and whether the badge appeared at all.
  *(**Passed live 2026-07-14** on the master.)*

- [ ] **2.8b [BLOCKER] — PAUSE FREEZES THE PICTURE, and the projector agrees.** *(Task 10 — this is FINDINGS #3,
  which sat 🔴 OPEN through the whole first acceptance run.)*
  **DO:** put a **generative effect** on a surface (Surfaces → content → an effect, not a video). Play. **Pause.**
  Then **scrub**. Then **Stop**. Then open a **windowed projector** showing the same surface and watch both at
  once.
  **EXPECT:** pause **freezes** the effect dead. A scrub **moves** it. Stop returns it to its t=0 state. And the
  Stage preview and the projector are **in phase** — the operator sees what the audience sees.
  **WHY IT MATTERS:** the effect was handed **raw wall-clock time** and never read the transport at all. Worse,
  each window ran *its own* `performance.now()`, whose epoch is that window's navigation start — so the same
  effect sat at a **different phase** in the preview than on the projector, permanently.
  **IF IT FAILS:** if the projector's effect is **frozen at zero** while the preview animates, the show clock is
  not reaching the mirror over the transport bridge — tell Claude, this is the half of the fix that matters.

- [ ] **2.8c [BLOCKER] — File ▸ New Project makes the room go SILENT.** *(Task 3.)*
  **DO:** with the bed **playing audibly**, File ▸ New Project.
  **EXPECT:** **silence, immediately.** An empty mixer. **Listen for a click, not just for silence** — a hard
  cut is a fault too. Then save the new project and inspect the `.artlux`: `audio` must be empty and there must
  be **no clip paths pointing into the old project's folder**.
  **WHY IT MATTERS:** New Project reset everything *except* `audioMix` and `schedule`. The outgoing show's bed
  kept sounding into the new empty project **and was written verbatim into the fresh file**, with its clip paths
  still aimed at the old project's assets. Three independent reviewers found this one.

- [ ] **2.8d — a corrupt `effects` field does not kill the app on load.** *(Task 2.)*
  **DO:** in a saved `.artlux`, hand-edit an audio clip's `"effects"` from `[...]` to `{"0": {...}}` (the
  array→object corruption this repo has already shipped once — the `segments` repair). Also try `"effects": "x"`.
  Load it.
  **EXPECT:** it **loads**. The chain reads as empty. No white screen.
  **WHY IT MATTERS:** `enumerate()` iterated `effects` with a bare `for..of`, and **nothing sanitized that
  field**. It runs on **every project load and every GO**. And a *string* is iterable — so `"reverb"` did not
  crash, it silently emitted **six automation targets with null ids**.

- [ ] **2.8e — an interrupted save does not destroy the show it is replacing.** *(Task 1. Hard to stage; do it
  once.)*
  **DO:** open a project you do not mind losing. Fill the disk, or kill the app process **during** a save.
  **EXPECT:** the original `.artlux` is **intact**. At worst there is a leftover `.tmp` beside it.
  **WHY IT MATTERS:** `writeJson` was a bare `writeFileSync` straight onto the target — and `writeFileSync`'s
  **first act is to TRUNCATE the file to zero bytes**, before a single byte of the new project is written. A
  crash, a power cut, a full disk or an AV lock in that window left the operator's project as `{\n  "name": `.
  It is now tmp + atomic rename.

### The two native-engine tests — **THE ONLY THINGS LEFT ON THE MERGE BAR**

*Both need real hardware and real ears. No sim can close either.*

- [ ] **2.9 [BLOCKER] — the bed does not CLICK on a GO.** *(Merge-blocker plan, task 8. `23cb500`.)*
  **DO:** a long bed, playing, **loud enough to hear detail**. Three scenes, each with **its own audio clip**
  on its `Timeline.audio` (that is what forces a decode on entry). **GO between them ten times**, listening to
  the bed — not to the stings.
  **EXPECT:** the bed runs through all ten **without a click, a gap, a tick or a dropout**. Nothing.
  **WHY IT MATTERS:** `addClip` called `AudioTransportSource::prepareToPlay` **while holding the audio lock**,
  and that call **blocks on disk** — it prefills 0.25 s of audio on a background reader thread and spins in
  5 ms sleeps until it lands. The audio thread reaches its own callback only by taking that same lock, so it
  produced **no samples at all** for the whole prefill. At 48 kHz/512 the deadline is 10.7 ms; even a **warm,
  page-cached read blows it**. The signal then resumed mid-waveform — a step discontinuity, which is broadband.
  That is the click. And the driver has **no audio preload tier**, so a scene's sting is decoded **on entry,
  every entry** — one blocking prepare under the audio lock **on every GO, all night.**
  **IF IT FAILS:** tell Claude whether the click is on **every** GO or only on scenes whose audio is **not yet
  warm in the OS page cache** (GO to a scene, leave, come back — the second entry should be the quiet one).
  That discriminates a remaining lock-hold from a plain decode-latency gap, which is a different bug.

- [ ] **2.10 [UNVERIFIED — needs a device you can take away] — kill the audio output device, mid-show.**
  *(Task 9. `5eb821d`. **NOT a merge blocker — see the box below.**)*

  > ### ⚠ THIS TEST HAS NEVER BEEN RUN, AND THE MERGE PROCEEDED ANYWAY. HERE IS EXACTLY WHY.
  > The author had **no audio interface they could physically disconnect** (2026-07-14). The decision to merge
  > without it rests on one property, and if that property is ever falsified this reasoning is void:
  > **the engine change is a strict no-op while a device is alive.** It is one line —
  > `if (deviceManager.getCurrentAudioDevice() == nullptr) opened = false;` — and on a working rig that
  > pointer is never null, so `opened` is never touched and `configure()` behaves exactly as it did before.
  > The renderer half cannot false-alarm either: **every** degraded read of `deviceLive` defaults to **true**
  > (no addon, dead bridge, old main process, and a `!== false` test rather than a bare read), so a missing
  > field or a failed poll lights *nothing*.
  > **What is unverified is the RECOVERY path, not the running-show path.** The risk of merging is that a dead
  > device stays as badly handled as it is on `main` today — not that a working one breaks.
  > **Run this the first day hardware is available.**

  **DO — and you do NOT need a USB interface for this.** Windows will take the device away for you:
  **Settings ▸ System ▸ Sound ▸ All sound devices ▸ <your current output> ▸ Don't allow.** That makes
  `getCurrentAudioDevice()` return `nullptr` — **the identical code path** an unplugged cable takes — and it
  is reversible in one click (*Allow*). With an interface, just pull the cable.
  **DO:** show running, bed audible. Kill the device. Watch the **Audio Bed** header and open
  **Preferences ▸ Audio**. Then restore the device and press **Reconnect**.
  **EXPECT:** within ~100 ms a red **`no output device`** badge appears in the Audio Bed. Preferences says
  **"The output device is gone — the room is silent"**, *names the device it lost*, and offers a **Reconnect**
  button. Press it (after restoring the device) and **sound returns with no restart**; the badge clears by
  itself on the next meter tick.
  **ALSO CHECK THE OTHER SENTENCE.** On a machine that has **never** had an output device, Preferences must say
  **"No audio output device — there is no sound"** — *not* "gone", and *not* a word about USB cables. Sending
  someone hunting for a cable that never existed is its own small lie.
  **WHY IT MATTERS:** `configure()`'s guard keyed on an `opened` bool that **nothing ever set false when the
  device died**, so the room went silent, JUCE did not recover, and the app **could not be recovered without a
  restart**. Meanwhile Preferences printed *"Native JUCE + ambisonic engine active · output device: <the dead
  one>"* — because its only probe reported whether the **`.node` had loaded**, which is a different question
  entirely. And the fix's own design assumed a device picker **that does not exist**: `configure()` opens the
  *default* device and the panel lists devices read-only, so the Reconnect button had to be **built**.
  **⚠ IT DOES NOT AUTO-RECOVER, AND THE BADGE IS NOT A CURE.** Nothing polls `configure()`. In an attended show
  that is fine. **In an unattended install nobody is there to press Reconnect, and the room stays silent until
  someone visits.** Auto-recovery is logged to Wave 4. Do not let this test's pass be read as more than it is.

---

## SESSION 3 — The show's length: park, wrap, hard-cut (40 min)

**Re-read the box at the top of this document before starting this session.** This is the group most likely to
fail and the failure is audible. *(Plan Group B; DC2/DC2b/DC3/DC4; rows 8, 9, 11b, 12, 19.)*

- [ ] **3.1 [BLOCKER] — the parked show goes silent and STAYS silent (no 50 ms buzz).** *(T-B1 / T8 / row 9.)*
  **DO:** 1. Global: Length **60 s**, Loop **OFF**. 2. Bed = `bed5min.wav`. 3. Bind **S1** (Loop ON, 5 s if you
  can, else 20 s). 4. Play. 5. **Wait past 60 s.** 6. Keep listening **another full minute**.
  **EXPECT:** at 60 s the bed **stops dead and stays silent**. The scene keeps looping — picture *and* its own
  beep. The transport does **not** pause. The state machine does **not** hop. The Audio Bed panel's amber
  **`show ended` badge lights**, with its tooltip. `♪` freezes at ~0:59.967 (one frame inside 60 — normal NLE
  parking, not a bug).
  **IF IT FAILS:** **if you hear a ~50 ms fragment of the bed repeating forever, that is a FAIL** — the park is
  not published to the driver and it is reconciling against a frozen clock. Tell Claude: *"the bed buzzes at the
  park"*. If the badge does **not** light while the bed is silent: the park happened but was never published —
  that is the undiagnosable-in-a-venue case and it is a blocker too.

- [ ] **3.2 [BLOCKER] — the scene's own audio must SURVIVE the park.** *(T-F7 / Task 6 #8 / Final gate #8.)*
  Same run as 3.1, listen specifically for this:
  **EXPECT:** the **bed** dies. **S1's beep keeps looping** with S1's picture.
  **IF IT FAILS:** if the scene's audio dies too, the driver called `stopAllSounding()` instead of the
  per-container stop — `showEnded` must be **bed-scoped**. Tell Claude: *"the park killed the scene's audio too."*

- [ ] **3.3 [BLOCKER] — recovering a parked show.** *(T-B2 / T8b / row 12.)*
  **DO:** from the parked state: press **Stop**, then **Play**. Then get parked again and this time revive it
  from an **FSM state whose entry action is `play`**, hopped into **while the scene is still looping** (so
  `playing` was never false).
  **EXPECT:** both routes restart the show clock at the global in-point and **the bed comes back from the top**.
  **IF IT FAILS:** the FSM route is the one that breaks silently. If it fails, an unattended show that ran out its
  global Length has a **permanently dead bed** for the rest of the session and nothing revives it short of a human
  driving to the venue. Blocker. Tell Claude which route failed.

- [ ] **3.4 — un-parking by lengthening the show.** *(T-B3 / rows 11b, 19.)*
  **DO:** parked and still playing, drag the **global** Length from 60 up to **300**.
  **EXPECT:** the bed **resumes from 0:60** and runs on. It does not restart from 0. The badge clears.

- [ ] **3.5 [WATCH] ⚠ — shortening the global Length mid-show HARD-CUTS the bed.** *(T-B4 / T12 / row 11b.)*
  **DO:** bed playing at ~**2:00** with **a scene bound**. Drag the **global** Length down to **30 s**.
  **EXPECT:** the bed **hard-cuts and stops**. The show is over. It must **not buzz**, must **not pause the
  transport**, and the **state machine must not move** — no hop, no `onTimelineEnd`, no phantom recall.
  **This is not a bug — it is the accepted breaking change**, and it is in the CHANGELOG. You are testing that it
  is *clean*, not that it doesn't happen. ~~Repeat with **S-noTL** bound (the nastiest reachable form).~~
  **Now repeat with GLOBAL bound and Loop ON** — that is the nastiest *reachable* form since S-noTL was deleted,
  and the merge review found a **blocker** in it (task 4): shortening the Length below the playhead while Loop
  is on re-anchored `showTime` to the region start while the playhead wrapped **modulo**, permanently splitting
  the two clocks **in the one state where the code asserts they are the same number**. Expect them to stay
  locked: the toolbar's `♪` and the Audio Bed's `♪` must read the **same** number afterwards.
  **IF IT FAILS:** an FSM hop here is a blocker (it means an *edit* can advance an unattended show). Two `♪`
  readouts that disagree while Global is bound is *also* a blocker — tell Claude both numbers.

- [ ] **3.6 — global Loop ON: the bed wraps WITH the show.** *(T-B5 / T9 / DC4 / row 8.)*
  **DO:** Global Length **60 s**, Loop **ON**. Play. Let it lap **four times**, stopwatch in hand. Keep the
  **State lane visible**.
  **EXPECT:** the music hard-restarts from the top of the track on every wrap. **That is correct** — the *show*
  looped. Each lap is 60 s ± a frame on your stopwatch. **The State lane's current-state readout must NOT move on
  the wrap.**
  **IF IT FAILS:** laps that creep longer or shorter each lap = accumulation instead of derivation (**drift**). A
  state hop **once per lap** = the show clock is pulsing `hitEnd` and **the bed's loop is driving your state
  machine** — an unattended install would walk itself through its whole cue stack overnight. Both blockers.

- [ ] **3.7 [BLOCKER] — the Loop button flips the bed between WRAP and PARK, live.** *(T-B6 / T9b / row 19.)*
  **DO:** wrapping as in 3.6, toggle global **Loop OFF** mid-lap. Let it reach 60 s. Then do the same toggle from
  an **FSM `setLoop` entry action**.
  **EXPECT:** Loop ON → the bed wraps. Loop OFF → the bed **stops at 60 s and stays silent** + `show ended` badge.
  Same two behaviours by hand and from the FSM.
  **WHY YOU MUST KNOW THIS:** an unattended state machine can reach this switch, and it flips the bed between
  "restarts every lap" and "stops forever."

---

## SESSION 4 — Seek, exit-to-global, reconverge (40 min)

*(Plan Group C + Group D; rows 2, 3, 5, 6, 13; DC5, DC5b.)*

- [ ] **4.1 [BLOCKER] — the pill back to Global RECONVERGES and does not pause.** *(T-C1 / T3 / row 5.)*
  **DO:** play, bind S1, run to ~1:30 (bed at 1:30, S1's playhead somewhere else entirely). Click the pill back to
  **Global**.
  **EXPECT:** the **bed keeps playing, uninterrupted**. The **picture jumps to where the bed is** (~1:30 on the
  global ruler) — *not* back to 0, *not* to the scene's playhead. The transport **keeps running**; it does **not**
  pause. Bed lanes reappear under the playhead, consistent with what you hear.
  **THE SHARPEST DRIFT TEST IN THE WHOLE SUITE:** in that instant, compare the timeline playhead with the Audio
  Bed panel's `♪`. Reconverge *is* `playhead := showTime` — **they must be identical, and stay identical.** A
  difference of even one second means a clock has drifted, and you just learned it in one glance.
  **IF IT FAILS:** a **pause** on exit is the old `clampPlayheadIntoDoc` behaviour, which used to stop the
  transport and kill the bed. A rewind to 0 means the reconverge never happened.

- [ ] **4.2 — deleting the bound scene reconverges the same way.** *(T-C2 / T3c / row 6.)*
  **DO:** playing, S2 bound, bed at ~1:00. **Delete S2** while it is bound.
  **EXPECT:** identical to 4.1 — bed uninterrupted, picture lands on the show clock, no pause, no black frame.

- [ ] **4.3 [BLOCKER] ⚠ — exiting a PARKED show must not fire a phantom recall.** *(T-C3 / T3b / DC5b.)*
  *The subtlest defect in the wave. Only a human can see it.*
  **DO:** 1. Build the parked state (Global 60 s, Loop OFF, S1 looping, run past 60 s). 2. Add an FSM state bound
  to S1 with an **`onTimelineEnd`** transition to a **different, visually obvious** state. 3. While parked, click
  the pill back to **Global**. 4. Repeat, but this time **delete the bound scene** instead of using the pill.
  **EXPECT:** the transport **pauses and holds on the last frame** (the show genuinely is over — that pause is
  correct here). But the state machine must **NOT hop** — no phantom scene recall, no wrong scene on stage.
  **IF IT FAILS:** *clicking "Global" cuts the picture to some other scene.* That means an unattended install can
  advance its state machine **from a mouse click** — a parked clock sits one frame inside the end, and re-entering
  it re-triggers the end-stop two frames later. Tell Claude: *"the pill-to-Global from a parked show fires
  onTimelineEnd."*

- [ ] **4.4 — scrubbing the GLOBAL ruler moves the bed.** *(T-D1 / T6 / row 2.)*
  **DO:** bound to Global, playing. Scrub the ruler to 2:00. Also try Home, End, the Audio Bed panel's scrub
  slider, and an OSC `/transport/seek` if you have a console.
  **EXPECT:** the bed **jumps with the picture** — the music hard-cuts to whatever is at 2:00 of the track. The
  Audio Bed `♪` reads 2:00 too. One number, two names.

- [ ] **4.5 [BLOCKER] — scrubbing INSIDE a scene does NOT move the bed.** *(T-D2 / T7 / row 3.)*
  **DO:** bind S1, playing, bed at ~1:40. Scrub S1's ruler around.
  **EXPECT:** the picture moves. **The bed does not move at all** and does not glitch. `♪ BED` keeps climbing
  from 1:40.
  ~~Then repeat with **S-noTL** bound~~ — that shape is gone (see 2.2). **Every** scene now owns a timeline, so
  the case this clause singled out *is* the main body of this test. Repeat it with **S2** and **S3** instead,
  and trigger the seek by **OSC or an FSM `seek` entry action** as well as by hand — the point was never the
  scene, it was that a seek arriving from a source that is not the operator's mouse must be gated the same way.

- [ ] **4.6 ⚠ — the Audio panel's scrub slider and SkipBack are DISABLED while a scene is bound.** *(T-D3 /
  Task 3 Step 3.)*
  **DO:** open the Audio Bed panel. Bind a scene. Try the scrub slider and the SkipBack button.
  **EXPECT:** both **disabled**, tooltip *"Scrub Global to move the bed — a seek inside a scene does not move the
  show clock."* The `♪` readout **keeps counting** (it shows the *show* clock). Also confirm: the slider's range
  now reaches your **last bed clip**, not the bound scene's 20 s Length.
  **WHY:** an enabled slider there would seek the **scene** while displaying the **show** — an operator nudging a
  control in the *Audio* panel would recall the picture to an arbitrary point mid-show.

- [ ] **4.7 [BLOCKER] — a global automation curve does not snap when you CAPTURE A SCENE.** *(T-D4 / DC6b.
  **Rewritten 2026-07-14: this test existed, and it would not have caught the bug.** It pointed at S-noTL —
  a shape you had to hand-edit a `.artlux` to create. The **reachable** door was Capture Scene, a button in the
  UI, in a project made today. The merge review found it; this test had been passing over it.)*
  **DO:** 1. Bind **Global**. 2. Draw a lane on `audio.master.gain` — a **slow ramp down** over ~60 s. 3. Play,
  and let the master get visibly and *audibly* partway down the ramp (~0:20, gain around 0.3). 4. **Capture
  Scene** (Scenes tab → 📷 Scene). 5. **GO** on the scene you just captured.
  **EXPECT:** the house level **does not move**. The ramp carries on descending, smoothly, on the show clock,
  exactly as if you had not recalled anything. The **Audio Bed's master fader follows it down**, greyed out,
  wearing a **`LANE`** badge.
  **IF IT FAILS — THIS IS THE MERGE BLOCKER, AND IT IS AUDIBLE.** The master **snaps back up** on the GO — from
  ~0.32 to ~0.97, in **one frame**: a **+9.6 dB jump**, in a venue, on a cue. It then does it on *every* GO, and
  the wrong value is **written to disk**. Root cause: Capture Scene `structuredClone`d the global automation
  lanes into the scene, where they were retagged to the *scene* clock (which resets on a recall) *and* shadowed
  the genuine base lane by `targetPath`. Tell Claude: *"the master snaps on GO after Capture Scene."*
  *(Fixed by merge-blocker tasks 5 + 6. **Passed live 2026-07-14** — this is the test the user ran first.)*

- [ ] **4.7b — and the operator can SEE which lane is driving the master.** *(Merge-blocker plan, task 7 + 13.)*
  **DO:** with the scene from 4.7 still bound, look at the **timeline panel** and the **Audio Bed**.
  **EXPECT:** the timeline draws the **global** lane even though a scene is bound — **dimmed, badged `GLOBAL`,
  read-only**, with its readout sampling the **show** clock. (Before, it vanished from the screen while it went
  on moving the master, and the operator had no way to see what was driving their house level.) Now add a lane
  on the **scene** driving the *same* `audio.master.gain`: the GLOBAL one must go **struck through** — the
  engine has filtered it out by `targetPath` and it is no longer applying. Two lanes, and it is unambiguous
  which one wins. The Audio Bed's master fader tracks whichever one is live.

- [ ] **4.8 — editing a SCENE's document does not move the bed.** *(T11 / row 11.)*
  **DO:** S1 bound and playing, bed at ~2:00. Edit S1's Length below its playhead; press **O** (Set Out); change
  its fps.
  **EXPECT:** S1's playhead may clamp and the transport may pause — expected. **The bed does not move.** `♪ BED`
  untouched. (Contrast 3.5: editing the *global* Length is the one edit that does hit the bed.)

- [ ] **4.9 — "New state…" is a recall, not an open.** *(T16 / row 16.)*
  **DO:** playing, bed at ~2:00. Pill → **New state…**.
  **EXPECT:** you drop into author mode on a fresh state; its timeline restarts. **The music keeps playing.**

- [ ] **4.10 — Open Project resets the show clock.** *(T15 / row 15.)*
  **DO:** show running, bed at 3:00. File → Open a different project.
  **EXPECT:** playhead **and** `♪` reset to the new project's global in-point. The old project's bed does not keep
  playing over the new one.

---

## SESSION 5 — Cheap regressions, highest value per minute (20 min)

- [ ] **5.1 [REGRESSION][BLOCKER] — New Project leaves nothing bound to a dead scene.** *(Defect **C5**; row 20.)*
  **DO:** File → **Open** any project that has scenes. Then File → **New Project**. Then: 1. press Play; 2. drag
  any clip; 3. change Length; 4. open the Audio Bed panel; 5. Save, and reopen the saved file.
  **EXPECT:** playhead and show clock **both at `globalStart`**. Edits **stick**. The pill reads **Global**. Bed
  lanes draw and the scrub works normally. The saved file has an **empty state machine and empty cue banks**.
  **IF IT FAILS:** the tells are: the pill still shows the old scene's name; every timeline edit silently reverts;
  the mixer permanently shows *"Scrub Global to move the bed"* with no scenes; the bed's lanes never draw. Any of
  those = still bound to a departed scene's pool. The saved file carrying the **old show's state machine** is the
  same defect.

- [ ] **5.2 [REGRESSION] — a mid-fade manual move on a surface sticks.** *(Defect **I3** — a **pre-existing core
  bug you have been living with since Wave A**. The most satisfying one on the list.)*
  **DO:** start a **10 s** scene crossfade. **Two seconds in**, pull that surface's `content.opacity` to 0 in the
  inspector.
  **EXPECT:** the surface goes to **0 immediately**. The fade lets go of that path. Nothing else in the crossfade
  stutters.
  **IF IT FAILS (the old behaviour):** the slider reads 0 and **the projector keeps showing the image for eight
  more seconds**, then snaps to 0 when the fade lands. Same class for `x/y/width/height/rotation/content.speed/
  content.intensity` and `globalBrightness` — spot-check one more.

- [ ] **5.3 [REGRESSION][BLOCKER] — returning a fader to its authored value works.** *(Defect **I1**; Final gate
  #9.)*
  **DO:** 1. Make a scene that recalls `audio.master.gain → 0.2` with a 5 s fade (authored master = 1.0). 2.
  Recall it. The room ducks to 0.2 and **stays** there — that is by design; a fade's value persists. 3. Open the
  Audio Bed panel: the master fader reads **1.00 over a quiet room**. 4. Grab it, wiggle, and release it back
  **exactly on 1.00**.
  **EXPECT:** the room **returns to unity on release**. Any landing value works, including the authored one.
  Repeat on a **clip** gain in the inspector and on an **FX param**.
  **IF IT FAILS:** the room stays at 0.2 and the one natural recovery gesture is the dead one. In a venue this is
  a house volume you cannot get back.
  **WATCH FOR A NEW BUG:** one `setMix` per completed gesture is expected. A plain **click** on the thumb (no
  move) must commit **nothing**.

---

## SESSION 6 — Audio lanes, authoring (50 min)

*(Plan Group E; Task 5; DC9, DC10.)* Open React DevTools' commit highlighter before you start.

- [ ] **6.1 [BLOCKER] — the lanes exist and a drop lands where you drop it.** *(T-E1 / Task 5 #1.)*
  **DO:** bound to **Global**: click `+ Bed` and `+ Audio` (both must be offered). Drag a `.wav` from the Media
  library onto **each** lane.
  **EXPECT:** each clip lands **at the drop position** (not at 0, not at the playhead), draws a **waveform**, and
  is at its **real length**.

- [ ] **6.2 [BLOCKER] — drag / snap / no re-render storm.** *(T-E2 / invariant 7.)*
  **DO:** drag an audio clip along the lane, past another clip's edge, past the playhead, past a marker. Then
  repeat the DevTools check while dragging the lane gutter's **fader** and while typing in its **name** field.
  **EXPECT:** smooth movement; **snaps** to clip edges, the playhead and markers. **No App commit until
  pointerup/blur.** Nothing pauses.
  **IF IT FAILS:** a per-pointermove commit reaches `engine.setData` → media warm + automation recompile + a
  `postMessage` to every projector — i.e. **it stutters the show while you author**.

- [ ] **6.3 — trim is a SOURCE trim, and blade works.** *(T-E3 / Task 5 #3, #5.)*
  **DO:** trim a clip's **left** edge inward. Then blade it mid-clip.
  **EXPECT:** on trim the **waveform slides under the clip** (you see a later part of the file) — it does **not**
  rescale or squash. Blade **splits** it in two.

- [ ] **6.4 — Delete removes the clip.** *(T-E4 / Task 5 #8.)*
  **EXPECT:** the clip is removed. Not: "the selection clears and the clip stays."

- [ ] **6.5 [REGRESSION] — an OLD bed (no `sourceDuration`) still trims correctly.** *(T-E5 / Task 5 #9.)*
  **DO:** open a project saved **before** this wave whose bed clips predate `sourceDuration`. Drag the **right**
  trim handle as far right as it will go.
  **EXPECT:** the waveform is correct and the handle **stops at the file's real end** — not at infinity.
  **IF IT FAILS:** you can drag a 30 s clip out to 5 minutes of source that does not exist, and **the driver
  holds the show on silence**.

- [ ] **6.6 [BLOCKER] ⚠ — an audio clip does NOT extend the timeline's Length; the badge is the only warning.**
  *(T-E6 / DC9 / Task 5 #7.)*
  **DO:** drop an audio clip so it **ends past** the timeline's Length.
  **EXPECT:** `Length` **does not change**. The ruler shows a **warn band** and a **"content past the end"**
  badge. Clicking the badge jumps `Length` to the content end and clears the badge.
  **WHY IT MATTERS:** under global Loop OFF, a bed clip past the global Length **simply will not be heard** — it
  is past the park. This badge is the only warning you get.

- [ ] **6.7 — the one-click fix does not destroy an out-point region.** *(T-E7.)*
  **DO:** set an **out-point**. Drop an audio clip ending past it. Click the badge's one-click fix.
  **EXPECT:** the region **survives** — the out-point moves out to the content end. It is not deleted.

- [ ] **6.8 — bed lanes vanish inside a scene.** *(T-E8 / Task 5 #6.)*
  **DO:** bound to Global with bed lanes visible → bind a scene.
  **EXPECT:** the **BED lanes disappear**; the `♪ BED` readout appears and keeps counting; the scene's own
  `+ Audio` lane is still there and still editable. (This is by design — see Session 1.)

- [ ] **6.9 ⚠ — `@ N s` is gone and nothing became unauthorable.** *(T-G6 / Task 8 #8.)*
  **DO:** look for the old numeric `@ N s` placement field in the Audio Bed panel. Then place a bed clip at an
  **exact** time using only the lane.
  **EXPECT:** the field is gone, and the lane can do everything it could (drop, drag, snap).
  **IF IT FAILS:** that field was **the only writer of `AudioClip.start` in the whole app**. If the lane cannot
  place a clip precisely, clip placement is now unauthorable — blocker.

---

## SESSION 7 — The driver: mixer, solo, mute, fades (45 min)

*(Plan Groups F + G; Task 6, Task 8; Final gates #1, #4.)*

**Before you start, know this:** `AudioTrack.solo`, `AudioClip.fadeIn` and `AudioClip.fadeOut` have been
*persisted and silently ignored* since Wave 3's first phase. They **start being honoured now**. A project that has
been carrying those fields will suddenly **sound different**. Open every existing show and listen.

- [ ] **7.1 [BLOCKER] — both containers sound.** *(T-F1.)* Put a **bed** clip and a **`Timeline.audio`** clip on
  the global timeline, **overlapping**. Play. **EXPECT:** both sound, mixed.

- [ ] **7.2 [BLOCKER] — solo is scoped to the bed.** *(T-F3 / T-G4 / Task 6 #4.)*
  **DO:** two bed tracks with audible clips + a scene with its own audio playing. **Solo** one bed track — first
  from the **lane gutter**, then from the **mixer**.
  **EXPECT:** the **other bed tracks go silent**. The **scene's audio is unaffected**. Both surfaces behave the
  same.

- [ ] **7.3 — mute round-trips.** *(T-F4.)* Mute, unmute. **EXPECT:** silent, then back — no click, and the clip
  **resumes in the right place**, not from where it was muted.

- [ ] **7.4 [BLOCKER] — fadeIn / fadeOut are AUDIBLE and match the drawing.** *(T-F5 / Task 6 #6.)*
  **DO:** drag a clip's **fadeIn** corner to 3 s and its **fadeOut** corner to 3 s. Play across it.
  **EXPECT:** you **hear** it fade up and down, and the audible ramp **matches the triangles drawn on the lane**.
  **IF IT FAILS:** the handles are a lie — they draw something that does not happen.

- [ ] **7.5 — a clip shorter than fadeIn + fadeOut degrades gracefully.** *(T-F6.)*
  **DO:** a 4 s clip with a 3 s fadeIn and a 3 s fadeOut.
  **EXPECT:** it **swells and dies without reaching full level**. No click, no silence, **no NaN in the console**.

- [ ] **7.6 — the clip inspector follows the timeline selection.** *(T-G1 / DC14.)*
  **DO:** open the mixer. Click an audio clip on a **bed** lane. Move that clip's **gain** in the inspector.
  **EXPECT:** the inspector shows **that clip** (gain, orbit, FX). The gain move is **audible**. The clip on the
  lane **does not move**.

- [ ] **7.7 — a timeline audio clip is read-only in the inspector.** *(T-G2.)*
  **EXPECT:** shown, marked **`THIS TIMELINE`**, read-only, pointing you back at the lane. (Known issue #5 — the
  panel is a plugin with no write path into a core `Timeline`; name/mute/solo/gain for those live in the lane
  gutter.)

- [ ] **7.8 — a video clip / a deselect gives an empty state.** *(T-G3.)*
  **EXPECT:** clicking a **video** clip → "nothing selected" (it is an *audio* inspector). Clicking empty space →
  the empty state. The selection callback fires **once** per click, not repeatedly.

- [ ] **7.9 [BLOCKER] — spatialisation survived the mixer rebuild.** *(T-G5 / Task 8 #6.)*
  **DO:** drag a source around the **orbit pad**.
  **EXPECT:** the L/R meters visibly shift and the **image moves** in the room / in headphones.

---

## SESSION 8 — Fades, cues, scenes carrying audio (60 min)

*(Plan Groups H + I; Task 9, Task 10; DC11, DC11b, DC13, DC15, DC16; Final gates #5, #9.)*
Group H needs the dev console (`transitions`, `audioProvider`). **This session contains the two worst failure
modes in the wave.**

- [ ] **8.1 — a fade lands and is audible, smoothly.** *(T-H1.)*
  Console: `transitions.start([{ path: 'audio.master.gain', from: 1, to: 0.2 }], { fadeSec: 3, transition: 'smooth' })`
  **EXPECT:** the master fades down over 3 s. **No flutter, no zipper, no 60 Hz chatter.**

- [ ] **8.2 [BLOCKER] — THE LANE ALWAYS WINS.** *(T-H2 / T-H3 / Task 9 #2–3.)*
  **DO:** 1. Draw an automation lane on `audio.master.gain` and **enable** it. 2. Run the 8.1 fade again. 3. Now
  **disable** the lane. 4. Re-enable it.
  **EXPECT:** with the lane enabled, the **lane's curve keeps driving the master** and the fade is **inaudible**
  (shadowed). Disabling the lane hands the master to **the FADE's value (0.2)** — **not** back to the authored
  1.0. Re-enabling gives it back to the curve.
  **IF IT FAILS:** if disabling the lane returns the master to 1.0, the fade was written into the same map as the
  lane override and the lane's release nuked it. Read order must be `lane ?? fade ?? authored`.

- [ ] **8.3 [BLOCKER] ⚠ — THE TAKEOVER: the house-volume fader must never die.** *(T-H4 / DC11b / Final gate #9.)*
  **DO:** with a fade in effect (master at 0.2, **no lane**), open the mixer and **move the master fader**.
  **EXPECT:** the master **moves**. Repeat for a **track** fader and a **clip** fader, after fading each.
  **IF IT FAILS:** the fade layer is shadowing the authored value with no way out, and **the house-volume fader is
  dead for the rest of the session** — and across a project open, because the map is module-level. **This is the
  single worst failure mode in an unattended venue.** Final gate #9 states it flatly: *after any audio recall,
  EVERY fader in the mixer still works.*

- [ ] **8.4 [BLOCKER] ⚠ — NO POP ON THE SECOND RECALL.** *(T-H5 / DC11b / Task 9 #5.)*
  **DO:** from master-faded-to-0.2, console:
  `transitions.start([{ path: 'audio.master.gain', from: audioProvider.getLive('audio.master.gain'), to: 0.5 }], { fadeSec: 4, transition: 'smooth' })`
  **EXPECT:** it **glides 0.2 → 0.5**.
  **IF IT FAILS:** if you hear it **SLAM TO FULL LEVEL** and then come down, the fade leg's `from` is the
  *authored* 1.0 instead of the live value — i.e. a full-scale pop on **every recall after the first**, in a
  venue, with nobody there. Blocker.

- [ ] **8.5 — a log-curve param fades like its lane.** *(T-H6 / DC15.)*
  **DO:** put a filter on the master. Fade `fx.<id>.cutoff` **200 → 8000 Hz** over 3 s. Then draw **the same
  move** on an automation lane and play it.
  **EXPECT:** **they sound the same.**
  **IF IT FAILS:** linear-in-Hz is past 4 kHz within ~700 ms and sounds nothing like the lane. That comparison is
  exactly the one you make in the room.

- [ ] **8.6 — Project open clears every fade.** *(T-H7.)*
  **DO:** leave the master faded to 0.2 (no lane). Open another project.
  **EXPECT:** the master is back at its **authored** value; every fader works.

- [ ] **8.7 [REGRESSION] — the cue picker offers audio, correctly labelled.** *(T-I1 / T-I2 / DC12.)*
  **DO:** open the cue picker. Capture `audio.master.gain` into a cue and read the label.
  **EXPECT:** groups **`Master`**, **`Bed ▸ <clip>`**, **`Track ▸ <name>`**, listing **only continuous leaves**
  (gain, position x/y/z, effect params). **No `filter.mode`, no effect type, no spatial on/off.** The entry reads
  **`♪ master · gain`** — not `fix · gain`.
  **IF IT FAILS:** previously the picker **could not add an audio param at all**.

- [ ] **8.8 [BLOCKER] — a SCENE carries audio, fades it, and the bed still does not restart.** *(T-I3 / T-I4 /
  DC13.)*
  **DO:** bind `audio.master.gain` to **S2** with a **4 s** fade. Play (bed at ~1:00). **GO on S2.**
  **EXPECT:** the music **fades**, in step with the look — **and the bed does not restart.**

- [ ] **8.9 — a zero-fade scene SNAPS.** *(T-I5.)*
  **DO:** set S2's fade to **0**. GO.
  **EXPECT:** the audio **snaps** to the value immediately.
  **IF IT FAILS:** if nothing happens at all, the direct-write path for a zero-length fade is missing.

- [ ] **8.10 [BLOCKER] — the FSM gets audio recall for free.** *(T-I7 / DC13.)*
  **DO:** point an FSM state at S2. Hop into it **via a trigger, not a click**.
  **EXPECT:** hopping in **fades the audio too**, with **zero** state-machine configuration. This is the
  unattended-installation path.

- [ ] **8.11 [REGRESSION] ⚠ — PER-CUE TIMING.** *(T-I8 / Task 10's ⚠.)*
  **DO:** build a column with **cue A** (`fadeSec 0.5`, a look) and **cue B** (`fadeSec 5`, `audio.master.gain`).
  Fire the column. Then set **A's transition to `none`** and fire again.
  **EXPECT:** **the music takes 5 s**, not 0.5 — **both times**. With A set to `none`, the music **still takes
  5 s**; it does not snap along with A.

- [ ] **8.12 [BLOCKER] — no pop on the second SCENE recall (the UI version of 8.4).** *(T-I9.)*
  **DO:** recall scene A (master → 0.2 over 3 s). Then recall scene B (master → 0.5 over 4 s).
  **EXPECT:** it **glides 0.2 → 0.5**. If it **slams to full level** first — blocker.

- [ ] **8.13 [REGRESSION][BLOCKER] — an unrelated cue must NOT hard-cut a running music fade.** *(Defect **I2** —
  pre-existing "one fade slot".)*
  **DO:** recall a scene with a **20 s** duck of `audio.master.gain` 1.0 → 0.3 under music. **Three seconds in**,
  fire an **unrelated** cue. Test **both arms**:
  - *empty batch:* a "swap the effect" cue (`content.effectId` / `content.paletteId` — no fadeable numeric legs);
  - *non-empty batch:* a look cue carrying `content.opacity` (**the more common one**).
  **EXPECT:** the duck **keeps running smoothly to 0.3 on its own 20 s ramp** while the look cue does its own
  thing. Also confirm a cue that **does** re-target `audio.master.gain` correctly **takes over** the leg rather
  than stacking on it.
  **IF IT FAILS:** the old behaviour was the 20 s duck **snapping from ~0.95 to 0.3 in one frame — the music
  falling off a cliff, mid-sentence, on the house PA**. In an unattended install this fires **on schedule, every
  night**.
  **Also check:** a **scene recall** mid-fade should still cleanly drop stale legs (its `cancel()` was
  deliberately left alone — it follows a full re-commit of the look).

- [ ] **8.14 — "Update Scene" does not clobber the audio binding.** *(T-I10.)*
  **DO:** bind audio to a scene. Tweak a light or a surface. Press **Update Scene**.
  **EXPECT:** the **audio binding survives**.

---

## SESSION 9 — The FSM rig: four defects, one setup (45 min)

*(Defects **C3**, **C4**, **I5**, **I6**. C3, C4 and I5 are drags that commit into the WRONG DOCUMENT when a
scene recall lands mid-gesture. **There is no undo on any of them.**)*

**Set up once:** build a scene **S** with **Capture Scene** (so its clips carry the *same ids* as the global
doc's). Give it an FSM/scheduler path that recalls S on a **predictable trigger** — easiest is an `atTime`
transition ~10 s out. Now: start a gesture on the **Global** timeline and **hold the pointer down across the
recall**, then release.

- [ ] **9.1 [BLOCKER] — hold each of the five drags across the recall.** *(Defect **C3**.)*
  **DO:** for **all five**: audio-clip drag, video-clip drag, clip **resize**, **region** drag, layer-**reorder**
  drag.
  **EXPECT:** the gesture is **discarded** at pointerup. **Neither document changes.** No projector flicker, no
  pause.
  **IF IT FAILS:** the draft is written into scene S — your global edit vanishes and **S's stinger silently moves
  15 s late**, persists on the next save, and lands on the wrong beat every night.

- [ ] **9.2 [BLOCKER] — ⚠ the ordinary drags must still work.** *(The review names the C3 guard as "the change
  most likely to break an authoring gesture that currently works.")*
  **DO:** every one of those five drags, with **no** recall happening. **Spend the most time in this session
  here.**
  **EXPECT:** each commits normally, exactly as it always did.

- [ ] **9.3 [BLOCKER] — an automation-keyframe drag across the recall.** *(Defect **C4** — NO UNDO.)*
  **DO:** drag a keyframe on the **global** timeline's `audio.master.gain` lane and hold across the recall.
  **EXPECT:** the drag is discarded. **S's lanes are untouched. The global lane is untouched.**
  **IF IT FAILS:** the old behaviour replaced **scene S's entire `automation` array wholesale** with the global
  doc's — S then carries a master-gain curve nobody wrote for it, driving its house volume, and any automation S
  had is **destroyed with no undo**.
  **Also test:** delete a lane while a drag on it is in flight (or drag on a scene without that lane) — nothing
  may be written.
  **Bonus (`3cccca9`):** delete an automation **target** (e.g. the surface a lane points at) while its lane is on
  screen. It must render a **dead lane, not a white screen**.

- [ ] **9.4 [BLOCKER] — the lane gutter's fader and name field discard their draft on a rebind.** *(Defect
  **I5**.)*
  **DO:** (a) drag a global TL track's gutter gain toward 0.2 and **hold** across the recall. (b) Type
  "Ambience" into a global track's name field, **do not blur**, let the FSM hop to S, then click anything (blur).
  *(The name draft lives until blur — that can be minutes.)*
  **EXPECT:** both drafts are **discarded** the moment the document changes. The field/fader snaps back to the
  newly bound track's real value.
  **IF IT FAILS:** the gain lands on **scene S's** music track — **the room goes quiet in that scene**, and only
  the document of a scene nobody is looking at says so.

- [ ] **9.5 [BLOCKER] — an audio drop cannot mint an orphan clip.** *(Defect **I6**.)*
  **DO:** two windows, both need the async probe still in flight:
  (a) drag a **large** wav (use **300–400 MB** to widen the window) onto a bed track and **immediately** click the
  gutter trash on that track;
  (b) drop onto a *timeline* audio lane and have the scene recall land **during** the probe.
  **EXPECT:** the clip is **silently dropped**. Nothing appears, nothing sounds, **no overrun badge**.
  **IF IT FAILS:** the old behaviour appended a clip with a dead `trackId` — **invisible on every lane, audible at
  unity gain, unmutable, and fixable only by hand-editing the project JSON.** A permanent mystery sound in the
  show. Its only symptom was a mystery "past the end" overrun badge.

- [ ] **9.6 [REGRESSION] — a lane reorder commits ONCE.** *(Defect **M5**; needs a projector window open.)*
  **DO:** open a projector output window. Drag a track header from position **6 to position 1** in one gesture.
  Watch the projector and the console.
  **EXPECT:** the order previews locally during the drag and commits **once on pointerup** — one `setData`, one
  fan-out.
  **IF IT FAILS:** the old behaviour fired **six** full document commits + projector `postMessage`s **during the
  gesture**, on the bound document of a running show.

- [ ] **9.7 [WATCH] — pointercancel.** *(Defect **M4**.)*
  **Needs a touchscreen.** On a touch kiosk, start a touch-drag on a timeline clip, let the container take it over
  as a pan, then tap anywhere. The gesture must cleanly abort; the clip snaps back.
  **DO NOT try "release the mouse button outside the Electron window" — it does NOT reproduce it.** Chromium
  captures the mouse at the OS level and still delivers `pointerup`. Without a touchscreen this is
  **reasoned-but-unproven**; accept it or find a touch device.

---

## SESSION 10 — Collect Assets, portability, forward-compat (45 min)

*(Plan Group K; Task 1; defect **C1**; Final gates #6, #7.)*

- [ ] **10.1 [BLOCKER] — C1: two same-size WAVs must not become one.** *(Defect **C1** — the #1 blocker. It needs
  nothing to go wrong first.)*
  **DO:** using `roomA/loop.wav` and `roomB/loop.wav` (different content, identical byte size — see Session 1),
  test **both paths**: (a) *Import* — import both into the library, drag row 2 onto a scene's audio lane; (b)
  *Collect Assets* — reference one from the bed and one from a scene, then run Collect.
  **EXPECT:** **two distinct files** in `assets/audio/` — `loop.wav` and `loop-1.wav` — each clip playing **its
  own content**. Then: drop the **same** file twice and confirm it still **de-duplicates to one copy**.
  **IF IT FAILS:** the old behaviour never copied the second file; both library rows pointed at the same path;
  **Scene B played Room A's loop forever**, and Collect reported `copied: 1, skipped: 0, missing: []` — a clean
  bill of health. For uncompressed PCM this collides **deterministically**, not by luck.

- [ ] **10.2 [BLOCKER] — Collect copies the scenes AND the bed.** *(T-K1.)*
  **DO:** with the fixture (assets `a`/`b`/`c`/`d` all outside the folder), Collect Assets → a fresh folder. Open
  the written `project.artlux` JSON directly.
  **EXPECT:** **all four** assets copied into `assets/`, and `scenes[].timeline.clips[].path`,
  `scenes[].surfaces[].content.url` **and** `audio.clips[].path` **all begin with `assets/`**.
  **IF IT FAILS:** `mapAssetPaths` never visited `data.scenes[]` or `data.audio` — Collect said "copied 12" and
  **the venue machine played nothing**.

- [ ] **10.3 [BLOCKER] — the portability test (the one that matters).** *(T-K2 / Final gate #6.)*
  **DO:** **move** the collected folder to a different directory. Open it. **GO on every scene. Play the bed.**
  **EXPECT:** **every scene plays. The bed plays.**

- [ ] **10.4 — `missing` is honest.** Delete `b.mp4` from disk, run Collect. **EXPECT:** `b.mp4` is **named** in
  the missing report.

- [ ] **10.5 — idempotence.** Run Collect **twice** into the same folder. **EXPECT:** the second run copies **0**,
  skips all, mangles no path.

- [ ] **10.6 ⚠⚠ — THE FORWARD-COMPAT BREAK. This is a DECISION, not a bug.** *(T-K6 / Task 1's ⚠.)*
  **DO:** save a project under **this** build. Open it with an **older** ArtLux build (keep a pre-Wave-B binary).
  **EXPECT (this is the accepted breakage):** the older build **will not fully load it** — its scenes and bed
  point at relative paths its `resolveAssets` never makes absolute, so **scenes are black and the bed is silent**
  there. **No schema version distinguishes the two.**
  **Then confirm the other direction** *(Final gate #7)*: an **old** project (absolute scene paths, no
  `Timeline.audio`, no `Scene.audio`) opens fine here, **plays to its end**, and saves without losing anything —
  and the first save under this build converts its paths to relative **in place**.
  **OPERATOR DECISION:** once you save a show under this build, that show's file is **one-way**. Confirm you
  accept that before merging. Nothing in the code will stop you.

---

## SESSION 11 — Junk JSON: the app must not white-screen (40 min)

*(Plan Group J; defects **C2**, **M2**, **M3**, **M1**. `normalizeTimeline` runs with **no try/catch and no
ErrorBoundary** — a throw here is a **white screen at the venue**.)*

**⚠ TURN THE MONITORS DOWN AND PULL THE AMP BEFORE 11.4.**

- [ ] **11.1 [BLOCKER][REGRESSION] — a junk `transitions` array must not white-screen on load.** *(Defect **C2**.)*
  **DO:** copy a project with a state machine. Hand-edit the `.artlux` so `"transitions": {"0": { …the same
  object… }}` (an array turned into an object). Open it. Repeat with `"regions"`.
  **EXPECT:** the project **opens**, the state lane draws, and the junk container is dropped to `[]` (you lose the
  transitions; the show runs).
  **THEN VERIFY THE HEALTHY PATH STILL WORKS:** a real state machine with `atTime` transitions must **still fire**.
  **IF IT FAILS:** the old behaviour was (a) **white screen on load, black projector, silent room**, no
  ErrorBoundary; or (b) on the FSM path the throw was swallowed — the machine entered state 1 and **never
  evaluated another transition all night** while `getStatus()` reported `playing: true`.

- [ ] **11.2 [BLOCKER][REGRESSION] — `"loop": "false"` must not turn looping ON.** *(Defect **M2**.)*
  **DO:** hand-edit a `.artlux` to `"loop": "false"` (the string). Open it.
  **EXPECT:** loop is **off**; the timeline **parks** at the end; `onTimelineEnd` **fires** and the FSM hops. Then
  confirm the Loop **button** still toggles correctly.
  **IF IT FAILS:** looping turned on by itself, so the clock wrapped instead of parking, `onTimelineEnd` never
  fired, and **an FSM whose only outgoing transition is `onTimelineEnd` looped scene 1 forever** — with
  `playing: true` and everything green.

- [ ] **11.3 [BLOCKER][REGRESSION] — a junk `CueBank`.** *(Defect **M3**.)*
  **DO:** hand-edit a `.artlux` so a bank has `"cues": {"0": …}`, or slip a `null` into `cueBanks`. Then (a) open
  the project **with the Scenes/cue dock tab open**, and (b) fire an OSC `/artlux/column` at it.
  **EXPECT:** the project opens with the junk coerced to `[]`; the column fires or is cleanly absent — **never a
  silent dead GO on a valid bank**.
  **IF IT FAILS:** (a) was a **white screen in render — the project never opened**; (b) was a **silently dead GO**
  (React 19 does not unmount for a throw in a callback) — the show sits on the previous look, everything green.

- [ ] **11.4 [BLOCKER][REGRESSION] ⚠ EAR / AMP HAZARD — a persisted `"gain": 20`.** *(Defect **M1**.)*
  **PULL THE AMP FIRST.**
  **DO:** hand-edit a `.artlux` to carry `"gain": 20` on a bed clip. Load and play across it.
  **EXPECT:** bounded to the declared range (0–1.5) **at the engine door**.
  **THEN — this is the important half — re-save and re-open:** the **file must still say `20`**. If the saved file
  now says `1.5`, **the fix is wrong** — a clamp that *persisted* would be a normalize that raised an authored
  value and wrote the raise back (a class of bug Wave A already shipped once).
  **IF IT FAILS:** the old behaviour loaded clean, drew normally, and played at **20×** into the mix the moment
  the show clock crossed that clip.

- [ ] **11.5 — junk `Timeline.audio` containers.** *(T-J2 / invariant 6 — **COERCE, DO NOT DROP**.)*
  **DO:** hand-edit a saved project so one timeline's `"audio"` is `5`, another's is `{"clips": null}`, and a
  third's is `{"clips": [null, {}, {"start":"x","duration":1e400}]}`. Reopen.
  **EXPECT:** **it loads, it does not crash.** The junk timelines show an **empty** audio container; the third
  keeps its `{}` and its coerced clip at `start: 0, duration: 0`.

- [ ] **11.6 — the bed's sanitiser.** *(T-J3.)*
  **DO:** hand-edit `audio.clips[0].start` to the **string** `"5"` and `audio.tracks[0].gain` to `"x"`. Reopen.
  **EXPECT:** `start` → `0`, `gain` → absent (⇒ 1). **Nothing renders `NaN`.**

- [ ] **11.7 — corrupt input on the asset path.** *(T-K5.)*
  **DO:** hand-edit the JSON so `scenes` is `{}`, one scene is `null`, one scene's `timeline` is the string `"x"`,
  and `audio.clips` is `5`. Reopen.
  **EXPECT:** **it loads (degraded) and does not crash.**

- [ ] **11.8 — round-trip is clean.** *(T-J1.)*
  **DO:** open an existing project with a bed. Save. **Diff the JSON.**
  **EXPECT:** `audio` (the bed) is **unchanged** (byte-identical for a normal bed); every timeline gains
  `"audio": {"tracks":[],"clips":[]}`.

- [ ] **11.9 — audio does not extend `Length`, in the data.** *(T-J4.)* Hand-write a timeline with `duration: 8`
  and an audio clip ending at **40**. Reopen. **EXPECT:** `duration` is **still 8**; `boundedDuration` still
  `true`. (Pairs with 6.6.)

- [ ] **11.10 — an AUDIO-ONLY timeline is first-class.** *(T-J5.)* Make a scene timeline with no video clips and
  no tracking takes, only an audio clip. Bind it, play. **EXPECT:** it is treated as a real timeline (not skipped
  as "empty") and **its audio plays**.

---

## SESSION 12 — The soak (30 min, mostly unattended)

**Nothing above substitutes for this.** The show clock's 20 reset-table rows were verified **by inspection
only**; the tests above prove maybe five of them at runtime.

- [ ] **12.1 [BLOCKER] — the 20-minute bed.**
  **DO:** load a **20-minute** bed. Global Length long enough to cover it, Loop OFF. Build an FSM that visibly
  **cycles** through S1/S2/S3 on `atTime` transitions every 20–30 s. Press Play. **Leave the room. Come back in
  20 minutes.** While it runs (or on a recording), scrub through and listen.
  **EXPECT:** the music has played **continuously for 20 minutes** — no restart, no seam, no click, no stutter, no
  micro re-trigger. The FSM is still cycling. The State lane is still moving.
  **THE DRIFT SIGNATURE — listen for this specifically:** the audio driver re-seeks any sounding clip whose source
  offset drifts more than **0.05 s** from where the clock says it should be. So a drifting clock does **not**
  sound like a slow slide — it sounds like a **periodic tick / stutter / re-trigger on a long sustained note**,
  forever. If a pad or a held vocal is repeatedly nicked, the clock is drifting. Report the *interval* between
  nicks.
  **THE PHANTOM-RECALL SIGNATURE:** any scene cut, any fade, any cue you did not cause. Cross-check the State
  lane's readout and `lastFiredTransitionId` — a transition fired with no trigger you can name is the phantom.

- [ ] **12.2 [WATCH] — the stale-batch leak.** *(Defect **I2**'s soak half.)* During the soak, with cues firing
  repeatedly, keep an eye on `transitions.isActive()` / the batch count in the console. It must **return to zero**
  between cues and not creep upward over hundreds of cues.

- [ ] **12.3 [WATCH] — the pool-`Map` leak.** *(Defect **C5**'s soak half.)* Do 30 open-project / new-project
  cycles and watch the heap. An empty pool `Map` lingers that `releasePool` can never drop — trivial in size,
  unbounded in count. Not observable in a smoke test.

---

## WHAT CANNOT BE TESTED BY HAND — and what we do instead

Be honest with yourself: a green run of Sessions 0–11 says **nothing** about these five.

| # | What | Why not | What we do instead |
|---|---|---|---|
| 1 | **The show clock's other 15 reset-table rows.** Rows 1–19 were walked **against the code**, by inspection. Sessions 2–4 exercise maybe five of them at runtime. | There is no way to enumerate 20 clock-reset paths by hand in an evening. | **Session 12's soak**, plus `node scratch/showclock-sim.mjs` (0.1), which asserts the table. There is no shortcut. |
| 2 | **"No *other* swallowed throw is silently pinning the FSM."** `timeline.ts:668` still wraps `fsm.tick` in a `try/catch` that swallows. You can prove a fixed FSM fires **one** transition; you cannot prove nothing else is quietly dead behind a green `getStatus()`. | The swallow is still there, by design. | The soak's **visibly cycling FSM** — if the machine stops moving, something threw. That is the only check. Consider a Wave 4 item to log the swallow. |
| 3 | **M4 — `pointercancel` on the five drags.** | Needs a **touchscreen**. Releasing the mouse outside the Electron window does **not** reproduce it (Chromium captures at the OS level). | **Reasoned-but-unproven.** Accept it, or borrow a touch device. Do not waste an hour on the mouse route. |
| 4 | **C5's pool-`Map` leak.** | Trivial per occurrence, unbounded over a long life of open/new-project cycles. Invisible in a smoke test. | Heap watch over 12.3, or accept as reasoned-but-unproven. |
| 5 | **I2's real shape — "every night, on cue, with nobody there."** | You can prove one duck survives one cue. You cannot prove the new multi-batch array never leaks a stale batch over a night of hundreds of cues. | 12.2's batch-count watch over the soak. |

---

# PART 2 — THE CLOSE-OUT CHECKLIST FOR WAVE 3

These are **the four gates** from `plans/SEQUENCING.md` § *"⛔ THE WAVE 3 MERGE GATE"*. Nothing else is on the
critical path.

| # | Gate | Owner | Status | Why it blocks the merge |
|---|------|-------|--------|--------------------------|
| **1** | **The build system builds the audio engine.** `build:audio` (strict) compiles the JUCE addon; `build:native` runs it optionally; `package` and CI are gated by `--check`; `extraResources` ships it as `audio-engine.node`. | Claude | **Landed at `a7ba256`** — *needs your Session 0.1 + 0.2 to confirm on your machine.* Then flip the row in SEQUENCING.md. | The addon had only ever been built by hand. CI never built it, electron-builder never shipped it, and the loader **graceful-degrades silently**. Tag `v0.22.0` on the old tree and you publish installers with a complete audio UI and **no sound in it**, and no error. Merging a tree that cannot build its own headline feature is the definition of a broken build system. |
| **2** | **It is documented.** `docs/DEVELOPMENT.md` and `CLAUDE.md` corrected (they said `build:native` "builds both Rust crates" — wrong twice: there are three, and the engine is not one of them). Must carry both traps: **`cargo` is not on PATH by default**, and **the dev app must be CLOSED for any native rebuild** (a running app locks `audio_engine.node`; the link fails with LNK1104 and **silently leaves the stale `.node` in place**, so a working fix looks broken). | Claude | **Landed at `a7ba256`** — *read `docs/DEVELOPMENT.md:37–50` and `CLAUDE.md:56–59` once and confirm they match what actually happened to you in Session 0.* | A fresh clone gets a silent app and no way to know why. |
| **3** | **The live smoke test passes.** | **You** | ⏳ **This document is that test.** | Wave B is code-complete, all four internal gates green, adversarially reviewed to *sound for an unattended installation* — but **no human has ever run it**. The one that matters most: a long bed + three scenes, GO between them, **the bed must not restart** (Session 2.1). |
| **4** | **The JUCE / libspatialaudio licensing call is made.** JUCE is free **under $20k/yr revenue**; above it, **$800 perpetual Indie** — otherwise it is **AGPL, which is viral**. libspatialaudio is **LGPL-2.1** (dynamic-link, or comply). Record the obligations in `README.md` / `NOTICE`. | **You** | ⏳ | It does **not** block the merge. It blocks the **first tag after audio is packaged** — which gate 1 has now made possible. **Decide it before it ambushes a release.** |

**Explicitly NOT merge blockers** (do not let these grow into one): Wave 4 (undo → error containment); P6
(multichannel/ASIO, speaker layouts, headless audio); the two loose bugs Wave 4's grounding found
(`IPC.WINDOW_COMMAND` is sender-blind → the docs window's close button closes the main editor window; the two
menus have diverged); the webgl-strict Phase 2 decision.

**One more thing that is not a gate but is a decision you must make with your eyes open** — Session 10.6: a
project saved under this build **will not fully load on an older build**, and nothing in the code will warn you.
One-way. Say yes on the record before merging.

### After the merge, in this order

1. **Wave 4 — renderer robustness** (`timeline-undo` → `renderer-error-containment`). **The highest-value item in
   the entire backlog for an unattended install: the watchdog cannot see a white screen.** A first-render throw
   means the heartbeat never fires, so the watchdog never arms, and the venue sits dead until someone drives
   there. (Sessions 11.1 and 11.3 above are exactly this hole, patched one JSON container at a time.)
2. **P6** — multichannel hardening (ASIO, speaker layouts) + headless audio wiring. Wave 3 ships **stereo +
   binaural**.
3. The two loose bugs above, and the **webgl-strict Phase 2** decision.
4. **MIDI control** — independent, parallel-safe at any point.
