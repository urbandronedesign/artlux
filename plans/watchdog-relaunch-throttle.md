# Enforce (and surface) the watchdog `minRelaunchGapSec` throttle

> **Status:** Draft · **Lifts:** Tutorial Set #10 (Ship It) — the dead `minRelaunchGapSec` setting that Preferences/docs advertise but the recovery path never honors · **Placement:** Core · **Risk:** Low · **Breaking changes:** UI-only (additive) + a documented behavior change to recovery timing; no schema/IPC/SDK break

## 1. The limitation today

`minRelaunchGapSec` is a **declared, defaulted, documented setting that no code path reads.** It is pure dead weight that misleads an operator tuning a flaky venue.

Verified against current code:

- **Declared** — `shared/protocol.ts:599` in `interface UnattendedPrefs` (`minRelaunchGapSec: number; // never relaunch more often than this (debounce)`).
- **Defaulted** — `src/main/watchdog.ts:31` (`WATCHDOG_DEFAULTS.minRelaunchGapSec: 30`) and again in the renderer's `WATCHDOG_UI_DEFAULTS` at `src/renderer/components/Preferences.tsx:18`.
- **Documented** — `docs/WATCHDOG.md:78` (`| minRelaunchGapSec | 30 | debounce between relaunch decisions |`).
- **The event schema already anticipates it** — `shared/protocol.ts:612` documents `action: string` as `relaunch | skipped-debounce | tripped | none`. The `skipped-debounce` action string is **never emitted anywhere** (grep across the repo returns only this comment). The feature was scaffolded and abandoned.
- **NEVER enforced** — `maybeRelaunch()` at `src/main/watchdog.ts:157-185` guards only on: the in-process `relaunching` flag (`:158`), the tripped breaker flag (`:160`), and the rolling hourly cap `maxRelaunchesPerHour` (`:161-166`). `minRelaunchGapSec` (i.e. `cfg.minRelaunchGapSec`) appears **nowhere** in the function body — grep confirms `cfg.minRelaunchGapSec` has zero read sites.

**Correction to the seed brief:** the setting is *persisted and defaulted* but is **NOT actually shown as an editable control** in Preferences. `Preferences.tsx` renders `NumberField`s for `outputDownSec` (`:63`), `renderStallSec` (`:65`), and `maxRelaunchesPerHour` (`:67`) — there is **no `NumberField` for `minRelaunchGapSec`**. It exists only inside the defaults object at `:18`, so it silently round-trips through `getPrefs`/`setPrefs` but the operator can neither see nor change it. So it is doubly dead: unread by the engine *and* unreachable in the UI.

Where it forces a caveat: the Set #10 "Ship It" chapter documents the watchdog knobs (`docs/WATCHDOG.md`) and lists a debounce that does nothing — an operator at a flaky-switch venue who lowers/raises it to pace relaunches gets zero effect, and the audit log never shows a `skipped-debounce` line to explain why.

## 2. What "lifted" looks like

`minRelaunchGapSec` becomes a **real pacing floor between successive relaunches**, visible and tunable in Preferences, and observable in the audit log.

Target behavior:
- The **first** relaunch after a stable run is **never delayed** (fast recovery of a genuine one-off fault is preserved — see §7).
- A **second (or later) relaunch that would fire within `minRelaunchGapSec` of the previous one is paced**: the watchdog waits out the remaining gap, then relaunches — it does **not** silently drop the recovery.
- Each paced decision writes a `skipped-debounce` audit event (finally emitting the action the schema already documents), so the Preferences event tail and tablet Metrics tab explain the delay.
- The setting gets a `NumberField` in Preferences so it is actually reachable.

**User-observable acceptance test** (drive the real app per `docs/DEVELOPMENT.md` — no unit runner):
1. Launch `--broadcast --project=<test>` with the watchdog enabled and `minRelaunchGapSec=30`, `maxRelaunchesPerHour=6`.
2. Force a renderer crash (`webContents.forcefullyCrashRenderer()`). → App relaunches **immediately** (first fault, no prior relaunch in the window). Audit log: `render-process-gone → relaunch`.
3. Immediately after the fresh process is up (well under 30 s), force a second crash. → App does **not** relaunch instantly; a `skipped-debounce` event is logged, and the relaunch fires once the 30 s gap elapses. Total relaunches respect both the gap *and* the hourly cap.
4. With `minRelaunchGapSec` lowered to `2`, repeat step 3 → the second relaunch follows almost immediately, proving the knob is live.

## 3. Placement: core or plugin (REQUIRED)

**Core.** Unambiguous:

- The watchdog is a **main-process, Tier-1 safety mechanism** living entirely in `src/main/watchdog.ts`, wired in `src/main/index.ts:224` and fed by the 1 Hz stat plumbing in `src/main/ipc.ts`. It has **no renderer/GPU/frame-loop surface** and cannot be a renderer plugin (plugins are in-process *renderer* contributions; this runs in `main` and must survive with zero renderer involvement — the doctrine explicitly calls the watchdog "core, so disabling the remote loses only the display, never the log", `docs/WATCHDOG.md:89-90`).
- **No new persisted field is introduced** — `minRelaunchGapSec` is *already* a core field in `UnattendedPrefs` (`protocol.ts:599`). Per the doctrine ("persisted types stay in shared/protocol.ts; only BEHAVIOR moves"), the type stays exactly where it is. We are only lighting up behavior that reads an existing core field. **Zero project-file migration.**
- **Barrel/singleton hazard: N/A.** No plugin is added, no new service singleton is created. `watchdog.ts` is already a module-singleton imported by `index.ts` and `ipc.ts` via relative paths only (`import * as watchdog from './watchdog'`) — we add no package-alias import, so the duplicate-singleton trap cannot be triggered.

The optional `NumberField` addition is a core `Preferences.tsx` edit (the component is core UI, not a plugin contribution).

## 4. Design / approach

Everything is in **main** plus one **renderer** UI line. No `preload`, `shared` (type already exists), `gpu`, or `plugin` changes.

### main — `src/main/watchdog.ts`

1. **Add a module-level defer timer** alongside the existing state (near `:44-50`):
   ```ts
   let deferTimer: ReturnType<typeof setTimeout> | null = null; // pending paced relaunch
   ```
2. **Enforce the gap inside `maybeRelaunch()`** (`:157`), *after* the tripped + hourly-cap checks and *before* setting `relaunching = true` (so a paced decision does not consume the in-process flag). Insert between the current `:166` and `:167`:
   ```ts
   // Pace back-to-back relaunches. The FIRST relaunch after a stable run has no recent
   // timestamp → gap check passes → instant recovery. Only 2nd+ relaunches within the gap
   // are paced. We DEFER (not drop) so a one-shot crash trigger still recovers.
   const gapMs = Math.max(0, (cfg.minRelaunchGapSec ?? 0) * 1000);
   if (gapMs > 0 && recent.length > 0) {
     const last = Math.max(...recent);          // recent = pruneRelaunchTimes() from :161
     const wait = last + gapMs - Date.now();
     if (wait > 0) {
       if (deferTimer) return; // already pacing — do NOT re-log (healthTick re-fires every 1s; logging here would spam ~30 lines/window — see §7)
       logEvent(trigger, detail, 'skipped-debounce', `pacing ${Math.round(wait/1000)}s (gap ${cfg.minRelaunchGapSec}s)`);
       deferTimer = setTimeout(() => { deferTimer = null; maybeRelaunch(trigger, `${detail} (deferred)`); }, wait + 50);
       return;
     }
   }
   ```
   - `recent` is the already-computed `pruneRelaunchTimes()` result from `:161`; the newest entry is the last actual relaunch. Because relaunch timestamps are **persisted** (`saveRelaunchTimes` → `stateFile`, `:216-218`) and survive `app.exit(0)`, the gap is correctly enforced **across processes** (the crash-loop case), not just within one process.
   - **Defer, not drop.** One-shot triggers (`render-process-gone` `:96`, `gpu-gone` `:81`) fire once; dropping them would leave the show dark until the *next* unrelated fault. Persistent triggers (`render-stall`/`output-down`) self-repeat every `healthTick` (`:135`) and would eventually pass the gap on their own, but the deferred timer makes recovery deterministic for **all** trigger types.
   - The `if (deferTimer) return` guard ensures the every-second `healthTick` re-triggering `render-stall` (`:141-144`) stacks only **one** pending relaunch, not a timer per tick.
   - When the timer fires it re-enters `maybeRelaunch`, which re-checks `relaunching`, `tripped`, and the hourly cap — so a breaker that trips during the wait, or a manual quit, is still honored.
3. **Clear the timer in `stop()`** (`:114-116`) so a clean shutdown never fires a stray relaunch:
   ```ts
   if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }
   ```

### renderer — `src/renderer/components/Preferences.tsx`

Add one `NumberField` in `WatchdogSection` (between `:66` render-stall and `:67` max-relaunches), matching the existing pattern so the now-live setting is reachable:
```tsx
<NumberField label="Min relaunch gap (s)" value={cfg.minRelaunchGapSec} step={1} min={0} max={600}
             onChange={(v) => update({ minRelaunchGapSec: Math.max(0, Math.round(v)) })} />
```
`min=0` lets an operator opt out (0 disables pacing → old behavior exactly). No other renderer change; `update()` already persists the whole `unattended` object via `setPrefs` (`:41-45`).

### docs — `docs/WATCHDOG.md`

Update line 78's meaning from "debounce between relaunch decisions" (aspirational) to describe the real defer-pacing semantics and the "first relaunch is never delayed" guarantee. Add a `Verifying` bullet for the paced-second-crash test.

### Data flow (unchanged plumbing)
`Preferences → setPrefs(unattended)` → `artlux-prefs.json` → on next launch `index.ts:224 watchdog.start({cfg: prefs.unattended})` → `cfg = {...WATCHDOG_DEFAULTS, ...opts.cfg}` (`:63`) → `maybeRelaunch` reads `cfg.minRelaunchGapSec`. No new IPC channel, no preload edit.

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**No schema/IPC/SDK break. There IS a real, LOUD behavior change.** Enumerated:

- **Persisted `.artlux` project schema:** ❌ **Not touched.** Watchdog config lives on `Prefs.unattended` (`artlux-prefs.json`), never in the project file. Projects are unaffected, full stop.
- **Persisted prefs (`artlux-prefs.json`):** ✅ **Additive-compatible.** `minRelaunchGapSec` is already a field (`protocol.ts:599`) written today by `WATCHDOG_UI_DEFAULTS` (`Preferences.tsx:18`). Old prefs files that predate the field load fine — `watchdog.start` spreads `WATCHDOG_DEFAULTS` first (`:63`), and the renderer spreads `WATCHDOG_UI_DEFAULTS` (`:35`), so a missing key defaults to `30`. No version bump, no normalize helper needed.
- **`shared/protocol.ts` IPC contract:** ✅ **Unchanged.** `UnattendedPrefs` and `WatchdogEvent` keep their exact shape. The new `'skipped-debounce'` audit value flows through `action: string` (`:612`) — which **already lists it as a legal value** — so no type widens. **⚠️ Correction to the draft's consumer list (verified by grep):** `action` is read in THREE places, not one — (a) core `Preferences.tsx:96` (free-text render); (b) the **show-control plugin**, which subscribes via `onWatchdogEvent` (`plugins/show-control/src/plugin.renderer.ts:103`), trims each event to `WatchdogEventLite` (`plugins/show-control/src/types.ts:100`, `action: string` — open, so it type-checks) and re-forwards it over its own `showctl:watchdog` IPC (`:101`) to the tablet web client; (c) the tablet client's audit view (`plugins/show-control/src/clientHtml.ts:328`) which does a **runtime value comparison** on `action` — `ev.action==='relaunch' ? warn : ev.action==='tripped' ? bad : fg` — then free-text renders it (`:330`). None is an exhaustive `switch`/TS union, and the one value-comparison has a **graceful default**: `'skipped-debounce'` falls to the neutral `var(--fg)` color and still shows as free text. So the new value is **non-breaking** for the plugin — but the draft's earlier "read only by `Preferences.tsx:96`" was wrong; the "tablet Metrics tab" it hand-waved as "forwarded verbatim" is exactly this plugin path.
- **`@artlux/sdk` surface:** ✅ **Unchanged.** Grep of `packages/` returns **zero** references to the watchdog, `UnattendedPrefs`, or `minRelaunchGapSec` — the watchdog is not part of the SDK proper. (The **show-control plugin** under `plugins/` does consume `WatchdogEvent.action`; that plugin contract is enumerated in the IPC bullet above and is non-breaking.)
- **UI contract:** ⚠️ **Additive only.** One new `NumberField` appears in Preferences → Unattended. No keybinding, no removed control.
- **⚠️ BEHAVIOR CHANGE (the real warning):** operators whose prefs carry the default `30` today get **paced relaunches starting immediately after upgrade** — a change from "instant back-to-back relaunches, capped at 6/h" to "instant first relaunch, then ≥30 s between subsequent ones." A venue that *relied* on sub-30 s back-to-back recovery (unlikely, but possible) will now see the 2nd+ relaunch delayed by up to `minRelaunchGapSec`. **Who breaks:** an installer who tuned around the *broken* behavior. **Mitigation:** (a) the first fault always recovers instantly — only storms are paced; (b) `min=0` in the new field fully disables pacing (exact legacy behavior); (c) the `skipped-debounce` audit line makes the delay explicit rather than mysterious; (d) call it out in `CHANGELOG.md` and `WATCHDOG.md`.

## 6. Migration & back-compat

- **No version bump.** No `.artlux` schema change → the `normalize*()` mechanism in `renderer/types.ts` is not involved at all.
- **Prefs back-compat** is handled by the existing default-spread pattern in two places (`WATCHDOG_DEFAULTS` main-side `:63`, `WATCHDOG_UI_DEFAULTS` renderer-side `:35`) — a prefs file written by an older build without `minRelaunchGapSec` loads as `30`; a prefs file written by this build is read fine by an older build (the older build simply ignores the value it never reads). **Forward and backward compatible.**
- Downgrade safety: rolling back to a pre-fix build leaves the (now-populated) `minRelaunchGapSec` in prefs harmlessly dead again. No corruption.

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius — actual grepped consumers of everything touched:**
- `cfg.minRelaunchGapSec` read sites: **currently zero**; after this change, exactly one (`maybeRelaunch`). Nothing else reads it.
- `UnattendedPrefs`: imported by `watchdog.ts:24`, `index.ts` (via `prefs.unattended`), and `Preferences.tsx:4`. Shape unchanged → these are unaffected.
- `WatchdogEvent.action`: written only by `logEvent` (`watchdog.ts:189`); emitted over `IPC.WATCHDOG_EVENT` (`index.ts:229`) to preload `onWatchdogEvent`, then read by **two** renderer subscribers — core `Preferences.tsx:96` (free-text) and the **show-control plugin** (`plugin.renderer.ts:103`), which re-forwards to the tablet client where `clientHtml.ts:328` value-compares `action` for a status color. Adding `'skipped-debounce'` is safe for all three (the plugin's color ternary has a neutral default; every render site treats `action` as free text). The draft's "read only by Preferences.tsx" undercounted this.
- `maybeRelaunch` callers: `child-process-gone` (`:81`), `render-process-gone` (`:99`), `unresponsive` (`:106`), `render-stall` (`:142`), `output-down` (`:148`). All are internal to `watchdog.ts`; the new defer path re-enters the same function, so their contract is preserved.
- `saveRelaunchTimes`/`pruneRelaunchTimes`/`stateFile`: read/written only within `watchdog.ts`. The gap logic reuses `pruneRelaunchTimes()` output; no new persistence format.

**Regression surface:**
- **WebGPU vs WebGL:** none — the render path is untouched, no WGSL/GLSL, no parity axis.
- **Per-frame perf:** none — `maybeRelaunch` runs only on a fault, never per frame. The added `Math.max(...recent)` is over ≤ `maxRelaunchesPerHour` (default 6) entries.
- **Singleton duplication:** none — no plugin, no alias import.
- **Projector MessagePort bridge / headless entry:** untouched. The watchdog arms only in `--broadcast` or `always` (`:64`); headless behavior is unchanged.

**Top things most likely to break in practice:**
1. **A crash-on-launch loop interacting with the gap + breaker.** If the fresh process dies *during startup*, `deferTimer` is created, then `app.exit(0)`/relaunch never happens because the process crashes first — but that is fine: the *new* process re-reads persisted relaunch times and re-evaluates the gap and the hourly cap from scratch. The breaker (`maxRelaunchesPerHour`, `:162`) still terminates the storm. The only real risk is a **longer time-to-trip** (relaunches now spread out), which is *intended* — but an operator watching a dark show for 2 minutes instead of 20 seconds should be told (docs).
2. **Stale defer timer firing after a legit manual quit.** Mitigated by clearing `deferTimer` in `stop()` (called from `before-quit`, `index.ts:243`).
3. **Gap set absurdly high** (e.g. 600 s) delaying recovery of a genuine second fault. Mitigated: it is operator-chosen, the first fault always recovers instantly, and the audit log shows the pacing.
4. **⚠️ Audit-log spam during a persistent-trigger defer (design defect in §4 as drafted).** For self-repeating triggers (`render-stall`/`output-down`), `healthTick` (`:135`) keeps firing every second throughout the defer window — the plan deliberately does NOT set `relaunching` while pacing — so the `if (deferTimer) { logEvent(…'already paced'…); return; }` guard writes a `skipped-debounce` line **once per second**, up to ~`minRelaunchGapSec` lines (≈30) per pacing window, into both the in-memory ring (`RING_CAP` 500) and the JSONL log. The guard prevents timer *stacking* but not log *flooding*, and that flood also spams the plugin's tablet audit view. **Fix:** log the `already paced` line only once — gate it behind a module-level `pacedLogged` flag set on the first skip and cleared when the deferred timer fires — or drop that branch entirely and log only the initial pacing decision.

**Overall risk: LOW.** Tiny, main-only, fault-path-only change to a module with a single narrow consumer, guarded by an existing breaker, with an explicit opt-out (`0`) and no schema/IPC/SDK surface.

## 8. Test / verification plan

Repo patterns (no unit runner):
1. **`npx tsc -p tsconfig.json --noEmit`** — the one new field read + one `NumberField` must type-check; `UnattendedPrefs`/`WatchdogEvent` shapes unchanged.
2. **`npm run dev`, exercise Preferences** — confirm the new "Min relaunch gap (s)" field appears, edits persist to `artlux-prefs.json`, and round-trips on reopen.
3. **`--broadcast --project=<fixture>` + forced faults** (per `docs/WATCHDOG.md:92-99`):
   - Single crash → **instant** relaunch, audit `relaunch` (proves fast recovery NOT delayed).
   - Two crashes < gap apart → second logs `skipped-debounce` then relaunches after the gap (proves enforcement + defer, not drop).
   - Set gap `0` → back-to-back relaunches instant (proves opt-out / legacy parity).
   - Sustained crash storm → verify total relaunches still trip the breaker at `maxRelaunchesPerHour` and write the tripped flag (proves gap + cap compose).
4. **Old-prefs load** — delete `minRelaunchGapSec` from `artlux-prefs.json`, relaunch → defaults to 30, no error (proves back-compat).
5. **`--headless --project=<file>` + dgram ArtDmx listener** — confirm the watchdog change did not perturb output plumbing (regression guard; headless does not arm the watchdog, so output must be identical).

**Proves it works:** tests 3a/3b/3c. **Proves nothing regressed:** tests 1, 4, 5.

## 9. Effort & phasing

**Size: S.** ~15 lines in `watchdog.ts`, 1 line in `Preferences.tsx`, a doc + changelog touch. No new files, IPC, or types.

Safe rollout:
1. Ship the enforcement + `NumberField` together (the field is the built-in opt-out — `0` = off).
2. Default stays `30` (already the case), so the first release turns pacing on by default; the CHANGELOG note + audit `skipped-debounce` lines make the new behavior legible.
3. Optional conservative variant: default `minRelaunchGapSec` to `0` for one release so pacing is opt-in, then flip the default to `30` after field validation. Recommend **against** — `30` is the documented default and the whole point is to make it live; shipping it live-by-default is the honest fix.

## 10. Open questions / decision points

1. **Defer vs drop** — this plan recommends **defer** (guarantees one-shot-crash recovery). If a human decides "a paced skip should just drop and wait for the next natural trigger," that is simpler (no timer, no `stop()` cleanup) but leaves a real hole for `render-process-gone`/`gpu-gone`. **Decision required.**
2. **Enforce vs remove** — recommendation is **enforce**, because the gap is *not* redundant with `maxRelaunchesPerHour`: the cap is a total hourly budget, the gap is per-relaunch pacing that gives transient faults (a flaky switch, a display renegotiating) room to self-heal between attempts instead of burning the whole budget in ~20 s. Removing it would delete a documented knob and is itself a (minor) breaking removal. If the team wants minimum surface, the alternative is to **delete the field + doc row + defaults + the `skipped-debounce` schema comment** — smaller code, but abandons a legitimately useful pacing control. **Decision required.**
3. **Should the gap also gate the very first relaunch of a session?** This plan deliberately exempts it (fast recovery). If an operator wants a hard floor even on the first fault, that is a one-line change (`recent.length > 0` → always), at the cost of delaying every recovery. **Recommend keeping first-relaunch instant.**
4. **Interaction with the Tier-2 Scheduled Task** (`scripts/watchdog-check.ps1`): it relaunches only when the *process is gone* and the tripped flag is absent — it does not read `minRelaunchGapSec` and arguably should not (its job is whole-process death, a different regime). Confirm we are content leaving Tier-2 un-paced. **Recommend yes** (Tier-2 fires at most on its schedule interval, which is its own natural floor).
