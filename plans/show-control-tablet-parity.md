# Show Control — Tablet Parity (multi-bank, per-cue fire, kick-invalidates-SSE)

> **Status:** Draft · **Lifts:** Tutorial Set #7 (Operator Remote) — the tablet PWA only renders cue `bank[0]`, has no per-cue fire buttons (columns only), and a kicked device keeps receiving its already-open SSE stream until it reconnects. · **Placement:** Plugin (zero core/protocol change) · **Risk:** Low–Medium · **Breaking changes:** None to compile/schema/IPC/SDK — but one **Behavior** change: Kick now hard-cuts a device's SSE stream (was a soft revoke that kept watching).

## 1. The limitation today

Three distinct gaps, all inside the `show-control` first-party plugin. The show engine and wire protocol are **already** complete for all three — the missing pieces are tablet UI and one server-side enforcement hole.

**(a) Only the first cue bank is shown.**
`plugins/show-control/src/clientHtml.ts:186` — `renderControl()` does `var bank=s.banks&&s.banks[0];` and renders a single bank. Yet `plugin.renderer.ts:30-34` (`buildSnapshot`) already maps **every** bank into `snapshot.banks[]` with full `cues[]`/`sceneCells[]`. The data is on the wire; the client throws all but `banks[0]` away. A project with 2+ banks is un-drivable from the tablet.

**(b) No per-cue fire buttons — columns only.**
`clientHtml.ts:189-191` renders one `"Column N"` tile per non-empty column (`data-act="col"` → `cmd({kind:'fireColumn',…})` at `clientHtml.ts:370`). There is **no** button that fires an individual cue. The `fireCue` command already exists end-to-end: wire type `types.ts:9` (`{ kind:'fireCue'; ref }`), dispatcher `dispatch.ts:12` (`case 'fireCue': show.fireCue(c.ref)`), SDK seam `packages/sdk/src/renderer.ts:289` (`fireCue(ref)`), and the underlying `cueBus.requestFireCue` (`src/renderer/services/cueBus.ts:27`). Only the tablet has no widget to emit it.

**(c) Kick revokes the token but does NOT close the open SSE stream (real security gap).**
`server.ts:75-76` `openStream()` calls `auth.verifyToken(token)` **only at connect time**. The `Client` record (`server.ts:27`, `{ res, id }`) does **not** retain the token, and `emit()` (`server.ts:69-72`) blindly writes to every socket in `clients`. On kick, `plugin.main.ts:56` calls `auth.revoke(token)` + `server.pushDevices()` — the device's token is gone (new POSTs 401 at `server.ts:134`), but its **existing** EventSource keeps receiving `snapshot`/`status`/`metrics`/`playlist` frames indefinitely, until the tablet happens to reconnect. The operator's mental model ("Kick = that device is off") is violated: a kicked tablet is read-blind (can't command) but still **watches the show live**. Today the only true instant freeze is **Lock** (`server.ts:137` `/command` → 423; `server.ts:211` `setLocked` broadcasts `{t:'locked'}`), and Lock freezes *all* devices, not one.

**Tuto impact:** Set #7 must currently caveat that (i) only bank 1 is reachable, (ii) you fire whole columns not single cues, and (iii) "Kick" is not a hard cut of a device's live view — steer operators to Lock for a real freeze. All three are missing-implementation, not physics.

## 2. What "lifted" looks like

- **Control tab** lists **all** banks (heading per bank), each showing its cue grid. Every populated cell is a **per-cue fire button** (`kind:'fireCue'`), with the existing **Column** fire buttons retained as a convenience row per bank. Active-cue/active-scene highlight preserved.
- **Kick** (single-device or Kick-all) **immediately closes** that device's SSE stream server-side; the tablet's live data stops within the SSE flush, not "eventually". A kicked tablet drops to disconnected state and cannot silently keep watching.

**Acceptance test (dev app + a browser standing in for the tablet):**
1. Load a project with **two** cue banks, each with ≥2 named cues. Enable Show Control (Preferences ▸ Show Control), open `http://localhost:8788/?pin=<pin>`, pair.
2. Control tab shows **both** bank headings; tap an individual cue tile → that exact cue fires in the app (verify in the app's cue UI / timeline), distinct from firing its whole column.
3. Open the operator panel (View ▸ Show Control), **Kick** the device. The browser's live counters freeze immediately (SSE closed); re-tapping a cue returns 401. Contrast with Lock (still connected, but 423).

## 3. Placement: core or plugin (REQUIRED)

**Plugin. Entirely.** Justification against the doctrine:

- **No persisted field, no enum, no cross-app type.** Nothing here touches `.artlux` schema, `shared/protocol.ts` (the core Electron IPC contract), or `renderer/types.ts`. The "protocol" being extended is the plugin's **own** JSON-over-HTTP/SSE wire (`plugins/show-control/src/types.ts`) — and for features (a)+(b) even that is unchanged: `fireCue` and multi-bank data already exist on it. The core rule "persisted/cross-app types stay core" simply doesn't trigger.
- **Features (a) + (b) are one file:** `clientHtml.ts` (the embedded PWA). No SDK, no core, no `@artlux/sdk` surface change. The `host.show.fireCue` seam already exists (`sdk/src/renderer.ts:289`).
- **Feature (c)** is contained to `server.ts` (retain token on `Client`, add a close-revoked pass) + a one-line call from `plugin.main.ts:56`. It **enforces** the existing auth model continuously rather than **changing** it — `auth.verifyToken` is untouched.
- **Barrel/singleton hazard:** no new singleton and no new cross-package import. `server.ts` is already a module-singleton imported only through the plugin's `main.ts` barrel; we add a function to it, not a new module. `clientHtml.ts` is a string constant. The hazard (mixing `@artlux/*` alias + relative imports duplicating a singleton) is not engaged — all edits are intra-plugin relative imports that already exist.

Confirmed: **no core/protocol change is needed.**

## 4. Design / approach

All edits are in `plugins/show-control/src/`. Grouped by process:

### Renderer/plugin UI — `clientHtml.ts` (features a + b)
Rewrite `renderControl()` (currently `clientHtml.ts:171-195`) to loop over **all** banks:

- Keep the transport card and the Scenes grid (unchanged, `:175-185`).
- For each `bank` in `s.banks` (was `s.banks[0]` at `:186`):
  - `<h3>` with the bank name.
  - A **cue grid**: iterate `bank.cues`, emit one tile per cue: `data-act="cue" data-ref="<cue.id>"`, label `cue.name`, accent from `cue.color`, and `active` outline when `status.activeCueId===cue.id` **if** such a field exists (see Open Questions — today `ShowStatus` has `activeSceneId` but not `activeCueId`; if absent, render cues without an active state rather than inventing a protocol field).
  - Below it, the existing **Column** convenience row (the `:189-191` logic), scoped to this bank.
- Add the click branch in the delegated handler (near `clientHtml.ts:370`):
  `else if(a==='cue') cmd({kind:'fireCue',ref:t.getAttribute('data-ref')});`
- Preserve the "no template literals" rule (the whole file is a backtick string — use string concatenation, matching the surrounding style at `:182-191`).

No `types.ts`, `dispatch.ts`, `plugin.renderer.ts`, or SDK edit for (a)+(b): the snapshot already carries every bank and every cue, and `fireCue` is already dispatched.

### Main-process server — `server.ts` + `plugin.main.ts` (feature c)
1. `server.ts:27` — extend `Client`: `interface Client { res: ServerResponse; id: number; token: string }`.
2. `server.ts:85` — store it: `const client: Client = { res, id: ++clientSeq, token: token || '' };` (`token` is already the verified value in scope at `openStream`).
3. New export in `server.ts`:
   ```ts
   // Close any SSE stream whose token is no longer a paired device (called after auth.revoke).
   export function disconnectRevoked(): void {
     for (const c of clients) {
       if (!auth.verifyToken(c.token)) {
         try { c.res.end(); } catch { /* */ }
         clients.delete(c);            // req 'close' also fires; delete is idempotent
       }
     }
   }
   ```
   (`auth` is already imported at `server.ts:11`; the `req.on('close')` handler at `server.ts:97` already `clients.delete`s + clears the heartbeat, so ending the response is clean.)
4. `plugin.main.ts:56` — after revoke, drop the streams:
   ```ts
   ipc.on('showctl:revoke', (tok) => {
     auth.revoke(typeof tok === 'string' ? tok : undefined);
     server.disconnectRevoked();
     server.pushDevices();
   });
   ```

**Data flow (feature c):** operator taps Kick → renderer `showctl:revoke` (unchanged, `ShowControlPanel.tsx:27`) → main `auth.revoke` removes token from the userData store → `server.disconnectRevoked()` ends every socket whose token no longer verifies → tablet's EventSource fires `onerror` (dot goes off, `clientHtml.ts:119`). On EventSource auto-retry (`retry: 3000`), `openStream` re-checks and returns 401 (`server.ts:76`) — the device stays out until it re-pairs with the PIN.

**No GPU / render-path / WebGPU-vs-WebGL surface is touched** — this is an HTTP/SSE and static-HTML change only. No parity concern.

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**None that break compilation, a schema, or a wire/IPC/SDK contract** — but there is **one operator-observable Behavior change** (feature c), called out at the end of this section. Proof, surface by surface:

- **Persisted `.artlux` schema:** untouched. No new `ProjectData` field. `ScheduleEntry`/`Playlist` unchanged.
- **Core IPC contract (`shared/protocol.ts`):** not imported or modified by any edit here.
- **Plugin bridge channels (`showctl:*`):** unchanged. `showctl:revoke` keeps its exact signature; we only add a second call *after* it in the same handler.
- **Plugin wire protocol (`plugins/show-control/src/types.ts`):** `ShowCommand`, `ShowSnapshot`, `SnapBank`, `SnapCue`, `ServerEvent` all unchanged. `fireCue` and multi-bank data already existed — the client starts *using* fields it was already receiving. An **old** tablet talking to a **new** server: still works (it just renders `banks[0]`, never sends `fireCue`). A **new** tablet against an **old** server: N/A — the PWA is embedded and served by the same server build (`clientHtml.ts` ships inside the bundle; no client/server skew by construction, per `SHOW-CONTROL.md:47`).
- **`@artlux/sdk` surface:** unchanged (`fireCue`/`getCueBanks` already exported at `renderer.ts:275,289`).
- **`server.ts` public API:** `Client` is a **file-private** interface (grep-confirmed: no export, no external consumer) — adding a required `token` field breaks nothing outside the file. `disconnectRevoked` is purely additive.
- **UI/keybindings/saved prefs:** none. `AppSettings.plugins['show-control']` (`{enabled,port}`) unchanged.

The one **behavioral** change to flag (not a compile/schema break): **Kick now hard-cuts a device's live stream.** Any operator habit that relied on Kick being a soft "revoke commands but keep watching" changes — but that behavior was the bug, and the fix is what the docs (`SHOW-CONTROL.md:86-88`) and the operator panel label ("Kick") already imply.

## 6. Migration & back-compat

- **No version bump.** No `.artlux` field added, so no `normalize*()` helper is needed; old and new project files load identically across app versions.
- **Device store (`showctl-devices.json`):** schema unchanged; `Client.token` lives only in memory.
- **Forward/backward:** project files are fully interchangeable between app versions with and without this change. The only cross-version pairing (old embedded PWA vs new server) is impossible in practice because the PWA is served by the server that ships it.

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius (grepped, not guessed):**
- `fireCue` consumers: `types.ts:9`, `dispatch.ts:12`, `sdk/renderer.ts:289`, `cueBus.ts:27` (+ `oscController.ts`, `timeline.ts`, `stateMachine.ts`, `App.tsx` for the *scene/cue* engine, unrelated to the tablet). We add a **new caller** (the tablet cue button) on an existing, exercised path — the OSC controller already fires cues into the same `cueBus.requestFireCue` sink (`oscController.ts:35`, called directly rather than via `host.show`; both converge on the identical cueBus edge), so the engine side is battle-tested.
- `Client` interface: file-private to `server.ts`; zero external consumers.
- `emit()` / `clients` set: only `server.ts` internal callers (`pushSnapshot/Status/Metrics/PlaylistStatus/Devices`, `setLocked`). `disconnectRevoked` mutates `clients` the same way the existing `close()` (`server.ts:196-201`) and the `req.on('close')` handler (`:97`) already do — no new concurrency pattern.
- `showctl:revoke`: single producer (`ShowControlPanel.tsx:27`), single consumer (`plugin.main.ts:56`). Both in scope; change is one added line.

**Regression surface:**
- **SSE lifecycle:** ending a response mid-stream while the 20 s heartbeat (`server.ts:96`) is pending — mitigated because `req.on('close')` clears the interval. Deleting from `clients` during `disconnectRevoked`'s own `for…of` is safe (Set deletion during iteration skips only the removed entry), and the later `close` event's second `delete` is idempotent.
- **EventSource retry storm:** a kicked tablet auto-retries every 3 s and gets 401 each time — negligible load (one device, one small request), and correct behavior.
- **No per-frame / no GPU / no projector MessagePort / no headless-entry impact** — none of those code paths are touched.
- **Multi-bank render cost:** the tablet now draws N banks × cues instead of one bank's columns; trivial DOM for realistic cue counts, and it re-renders only on `snapshot`/`status`/`locked` (`clientHtml.ts:147`).

**Overall: Low–Medium.** Low for (a)+(b) — single-file, additive, on a proven engine path. The **Medium** lean is entirely feature (c): it touches the auth/streaming boundary, and a botched `disconnectRevoked` could either (i) fail to actually close the socket (gap persists) or (ii) wrongly close a *still-valid* device. Both are caught by the acceptance test in §8.

**Top 3 things most likely to break in practice:**
1. `Client.token` not populated on **legacy** or edge connects (e.g., a future codepath that constructs a `Client` without a token) → `disconnectRevoked` closes it spuriously. Mitigation: `token` is required in the interface, so TS forces every construction site to set it (only one exists).
2. Firing an individual **cue by id** when a project uses duplicate cue *names* — `fireCue(ref)` resolves id-or-name in `cueBus`; passing `cue.id` (not name) avoids ambiguity. Ensure the tile uses `data-ref="<cue.id>"`.
3. A very large bank grid on a small tablet — layout only; the existing `.grid` auto-fill (`clientHtml.ts:33`) handles it, but verify scroll on a real device.

## 8. Test / verification plan

Repo patterns (per `docs/DEVELOPMENT.md` / CLAUDE.md):

1. **`npx tsc -p tsconfig.json --noEmit`** — must stay clean (the `Client.token` and new export are the only type-surface changes).
2. **`verify:plugins`** — confirm the marker/single-identity checks still pass (the `showctl:*` marker strings are unchanged).
3. **`npm run dev` + exercise** the §2 acceptance test with a browser as the tablet:
   - Two-bank project → both banks render; per-cue tap fires the exact cue (confirm in the app's cue/timeline UI, distinct from a column fire).
   - Kick (single + Kick-all) → the browser's SSE counters freeze **immediately**; a subsequent `/command` returns 401; Network tab shows the `/events` connection closed by the server, then re-open attempts returning 401.
   - Regression: **Lock** still freezes with 423 while keeping the stream open (proves Kick and Lock stayed distinct).
4. **Headless/broadcast sanity:** launch `--headless --project=<two-bank fixture>` with the server enabled; pair a browser; confirm multi-bank + per-cue + kick all still hold in broadcast mode (no editor UI present).
5. **Fixture:** promote the two-bank project used above into `examples/` as the Set #7 acceptance fixture so the caveat can be removed from the tuto.

## 9. Effort & phasing

**Size: S (a+b), S–M (c). Overall S–M.**
- (a) multi-bank + (b) per-cue: ~1 focused pass on `clientHtml.ts` + one click-handler line. No new tests infra.
- (c) kick-invalidates-SSE: ~3 lines in `server.ts` + 1 in `plugin.main.ts`, plus the manual SSE verification.

**Safe rollout order:**
1. Land (c) first — it's the security fix and is smallest/most isolated; verify Kick vs Lock behavior.
2. Land (b) per-cue buttons (additive; columns still there as fallback).
3. Land (a) multi-bank last (largest visual change), behind nothing — but keep a `banks[0]`-only fallback trivially reachable if a device reports layout issues. No feature flag needed given the low blast radius; if desired, the whole PWA change is gated by the existing `enabled` server toggle already.

## 10. Open questions / decision points

1. **Active-cue highlight:** `ShowStatus` (`types.ts:40-49`) has `activeSceneId` but **no `activeCueId`**. Do we (a) render per-cue tiles without an active state (zero protocol change — recommended), or (b) add `activeCueId` to `ShowStatus` + `buildSnapshot`/status push (a plugin-wire addition, still no core change, but more surface)? Recommend (a) for this pass.
2. **Kicked-tablet UX:** after the stream closes, the PWA still holds a stale token in `localStorage` and shows the last snapshot with a red dot. Should a 401 on `/events` (or `/command`) **clear the token and bounce to the pair view**? Cleaner, but adds client logic (handle `es.onerror` + probe status). Optional follow-up, not required to lift the limitation.
3. **Defense-in-depth:** should the 20 s heartbeat (`server.ts:96`) also re-verify the token each beat, as a backstop if a future revoke path forgets to call `disconnectRevoked`? Cheap insurance; decide whether it's worth the extra `auth.verifyToken` call per client per 20 s.
4. **Bank ordering / empty banks:** render every bank including empty ones (with a "no cues" note) or skip empties? Recommend skip-empty to match the existing column filter (`clientHtml.ts:189`).
