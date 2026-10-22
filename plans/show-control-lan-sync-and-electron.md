# Show Control — every adapter gets a QR, states reach the tablet, and the Node CVE bump

> **Status (2026-10-22): items 1 and 2 BUILT, uncommitted; item 3 waiting on Electron.** Item 1 (a QR
> per adapter) and item 2 (the tablet recovers from a refused token, says when a command fails, and
> says "Not connected" in words) are verified with `test-show-control-ui.cjs` (3/3 runs, incl. 13 new
> checks), `npm run verify`, and the built app: the panel draws a labelled QR, and a stale token
> against the real server re-pairs from the QR link. Not yet seen: two adapters at once on screen
> (needs the owner's VPN on), and the owner's own phone on the new page.
>
> Three items from one owner request:
> 1. *"if we have two adapters, wifi and lan, connected to internet it will show the qr of the first
>    adapter but not the second — I would like to have both"*
> 2. *"the states don't update on the tablet or phone if I make changes on the main app"*
> 3. Ship the fix for the Node.js October 2026 security release (CVE-2026-111497 et al.).
>
> Item 1 is a confirmed cause, found by reading. **Item 2 is NOT explained by reading** — the whole
> path checks out on paper — so its plan opens with a reproduction, not a fix. Item 3 is a version bump
> with a packaged-build check.

---

## 1. One QR per network adapter

### What is wrong (confirmed in source)

- `server.ts:lanInfo()` returns `urls: string[]` — every non-internal IPv4 address, in whatever order
  `os.networkInterfaces()` yields, **with the adapter name thrown away**.
- `ShowControlPanel.tsx:337` builds the QR from **`lan.urls[0]` only**. The other URLs are printed as
  text underneath, but a phone on the *other* network has nothing to scan, and a URL typed on a
  touch keyboard is exactly what the QR exists to avoid.
- Which adapter is "first" is OS enumeration order, not "the one the tablet is on". With Wi-Fi + LAN
  the QR can point at the network the tablet cannot reach, and the operator has no way to tell why.
- Same list includes **virtual adapters** (Hyper-V `vEthernet`, VirtualBox host-only, VPN taps —
  a VPN already cost a day on NDI, see the NDI memory) and **`169.254.x.x` link-local** addresses that
  no tablet can reach. Any of these can win `urls[0]` today.

### The change

1. **`LanInfo` carries adapters, not strings.** `{ name, address, url, kind }` per entry, where
   `name` is the OS interface name ("Wi-Fi", "Ethernet 2") and `kind` is `physical | virtual |
   link-local`, decided by one small classifier (name patterns for vEthernet/VirtualBox/VMware/
   TAP/WireGuard/ZeroTier/Tailscale + the `169.254.0.0/16` range). `LanInfo` lives in `types.ts`,
   which both halves import — keep `urls` as a derived field for one release so nothing that still
   reads it breaks (`ShowControlSettings.tsx:45` does).
2. **Order: physical first, then virtual; link-local dropped** (or shown greyed under "not reachable",
   never as a QR). Stable within a kind by name, so the list does not reshuffle on the 3 s poll.
3. **A QR per reachable adapter**, each labelled with its adapter name and address — two side by side
   for the common Wi-Fi + LAN case; a picker (chips) above a single QR if there are more than two, so
   the dock tab does not become a wall of codes. Remember the last chosen adapter per machine
   (localStorage, a per-viewer convenience — fine there).
4. **Adapters that appear later are picked up for free**: the panel already re-polls `lan-info` every
   3 s, so plugging in a cable mid-show adds its QR without a restart. Keep that.
5. **Settings section** (`ShowControlSettings.tsx`) lists the same labelled entries instead of bare URLs.

Not changing: the server already binds `0.0.0.0`, so it is reachable on every adapter today — this is
purely what the operator is *shown*. No server, auth or tablet-PWA change.

### Obligations that come with it

- **Docs, same commit** (the documentation rule): `docs/SHOW-CONTROL.md` → the connect section says
  "one QR per network; scan the one for the network the tablet is on". Describe verbs, not panel
  coordinates. Run `npm run verify` (verify:docs checks UI assertions against source).
- **Redaction**: hand-made screenshots of this panel will now show *two or more* real addresses.
  Before committing any shot, blank every address and the PIN by eye (CLAUDE.md, rule 3).
- **Check both shell paths** (dock tree on, `dockingOff` fallback) — the panel is a dock tab.

### Verify

`npm run dev` on a machine with Wi-Fi + Ethernet both up: both QRs present and labelled; scan each
from a phone on that network and confirm it auto-pairs. Disable one adapter → its QR disappears within
3 s. With a VPN / Hyper-V switch present, it is listed after the physical ones and never first.

---

## 2. States not updating on the tablet — reproduce first

### What the code says should happen (all checked, all present in `main`)

| Hop | Where | What it does |
|---|---|---|
| Edit in the app | `App.tsx:3993` | effect on `[scenes, cueBanks, stateMachine, schedule]` wakes `host.show` subscribers |
| Renderer → main | `plugin.renderer.ts` `pushSnapshot` | builds the snapshot, sends if changed; **plus a 2 s heartbeat** (every 4th status tick) since `1837ca3`, 2026-08-06 |
| Current state | `App.tsx:4002` → `getStatus().currentStateId` | streamed in `status` at 2 Hz |
| Main → tablets | `server.ts` `pushSnapshot` / `emit` | caches + fans out over SSE |
| Tablet repaint | `clientHtml.ts:203-237` `renderIfDynamic` → `renderIfChanged` | States tab repaints when `snapshot.fsm` or `status.currentStateId` changes |

On paper this works, so the bug is in a condition the reading cannot see. **Suspects, most likely first:**

1. **The tablet is talking to a different process.** If a second ArtLux (broadcast/headless, a
   packaged build next to a dev build, a watchdog relaunch) already holds port 8788, the editor's
   server fails to bind — `server.ts:249` logs and sets `server = null`, and the panel's dot goes
   amber "server off". The tablet stays happily connected to the *other* process, which never sees
   the edits. Fits "changes on the main app don't arrive" exactly. **Check first.**
2. **The tablet's repaint guards swallow it.** `renderIfDynamic` returns early while `editor`, `ask`
   or `stopping` is set, and `renderIfChanged` while an INPUT/SELECT/TEXTAREA has focus. A dialog
   flag that is never cleared (e.g. `ask` left set by navigating away from a confirm) or a field that
   keeps focus would freeze the tab indefinitely while the header still says connected.
3. **A dead stream that looks alive.** Mobile Safari/Chrome can suspend an `EventSource` when the
   screen locks or the tab backgrounds without firing `onerror`; the page then shows the last
   snapshot and "connected". The server's 20 s `: ping` keeps the *server* side alive, not the client.
4. **"States" means something the snapshot does not carry.** `SnapState` is `{id, name, sceneId}`
   and transitions carry only `manual`. A change to a state's timeline, colour, end behaviour or a
   non-manual trigger is not in the payload, so it cannot arrive — working as built, but it reads as
   "doesn't update".

### Questions for the owner (they narrow it to one suspect)

- What exactly did not update: a **new/renamed/deleted state**, the **current-state highlight** when
  the app changes state, the **FSM on/off**, or something else about a state?
- Which tab was the tablet on, and does **pulling to reload** the page fix it immediately?
- Was the dot in the app's Show Control tab **green** at the time? Was any other ArtLux running?

### Owner's answer (2026-10-22): a state added, then deleted — it never disappears on the tablet

Read against the code: **delete and add take the identical path** — `StateGraphEditor.removeState`
and `addStateAt` both go through the same `patch()` → `onChange` → `a.setStateMachine`, which fans out
via `App.tsx:3993` exactly as the add does. Nothing on the app side treats a removal differently, and
the tablet's guard flags (`editor`, `ask`, `stopping`) are all cleared on their own buttons. So the
deletion is not lost in the editor; it is lost (or never repainted) after it leaves the renderer.

The one test that splits the remaining suspects in two:
- **Switch the tablet to another tab and back to States.** A tab switch calls `render()` directly,
  bypassing every repaint guard. If the state disappears → the snapshot ARRIVED and the live repaint
  is what fails (suspect 2). If it is still there → the tablet never received it: reload the page; if
  that fixes it, the stream was dead (suspect 3); if not, the tablet is on another process (suspect 1).

### ROOT CAUSE FOUND (2026-10-22, live, owner's Android phone + request log inside the running app)

**A stale pairing token locks the tablet out, silently and permanently.**

Measured, not inferred. A request logger was injected into the running main process (inspector via
`process._debugProcess`, no code change) and the owner reloaded the page on the phone:

```
GET /?pin=2861                  -> 200      page loads
GET /events?token=e3da0c…       -> 401      live stream refused: token unknown to this app
```

`e3da0c…` is in no `showctl-devices.json` on the machine, so it was issued by a pairing that was later
removed: "Kick all", a reset store, or another machine at the same IP:port. The phone's
localStorage is keyed by origin, so it outlives all of those. From there, `clientHtml.ts` has no path
out:

1. **A saved token skips pairing**, even when the URL carries `?pin=` (`clientHtml.ts:808`:
   `if(token) connect(); else …doPair(qp)`).
2. **`EventSource` does not retry a 401.** A non-200 answer closes it for good. `onerror` only greys the
   header dot (`connected=false`), and nothing reconnects or re-pairs.
3. **Every command is refused too and nobody says so.** `cmd()` handles 423 (locked) only, so a 401
   is dropped. The owner's "the state-machine button does nothing" was this.
4. **Reloading cannot help**, because the token is reloaded with the page. Only clearing the site's data
   recovered it (then: `POST /pair` → 200, `/events` → 200, all three states shown at once).

Also proven along the way: the app side is correct. Add, delete, and delete-of-the-CURRENT-state
while running all reached a connected tablet live (headless Chrome + the owner's phone, server
stream logged).

**Fix (tablet page only, `clientHtml.ts`):**
- On a **401 from `/events` or any API call**: drop the saved token. If the URL has `?pin=`,
  re-pair automatically. Otherwise show the PIN screen with *"This device is no longer paired — enter
  the PIN shown in the app"*. `EventSource` cannot read the status, so probe with
  `fetch('/events?token=…')` / a cheap authed GET (e.g. `/playlist`) in `onerror`.
- **A `?pin=` in the URL always wins over a saved token that fails**, so scanning the QR is always a
  way back in.
- **`cmd()` reports failure** (401 → re-pair flow; network error → *"Not delivered — no connection"*
  toast) instead of dropping it.
- **The red dot becomes words** when disconnected (*"Not connected — retrying…"*), plus a client
  watchdog: no event for ~5 s (status streams at 2 Hz) → close and reopen the stream; also reopen on
  `visibilitychange` → visible. This covers suspect 3, which is still untested on a locked phone.
- Extend `scripts/test-show-control-ui.cjs` (it already drives the page against a protocol stub)
  with: a stub that 401s a stale token → the page re-pairs from `?pin=` and paints; a 401 on
  `/command` → visible message.

**Suspect 3 tested and RULED OUT on Android Chrome (same session).** With the phone locked, the stream
closed at once (`/events` CLOSE after 85 s, at the lock). Edits made meanwhile were missed. The page
reconnected **by itself** 11 s later on unlock (`EventSource` retries a dropped network connection; it
only gives up on an HTTP error), and the server's on-connect replay + `onNeedSnapshot` painted the
current list. The owner confirmed it on the phone. The watchdog above is still cheap insurance for iOS
Safari (untested), but it is not the bug.

Housekeeping found in passing: the device store holds 26 entries, mostly test pairings (`e2e`,
`test`, `probe`, `blackout-test`, `claude-logger`, headless `Win32`). The harnesses pair into the
owner's REAL userData and never revoke. They should revoke their own token at the end.

### Then

1. Reproduce in `npm run dev` with a phone on the LAN (or a second browser tab on
   `http://localhost:8788`): add a state, rename it, change state from the app; watch the States tab.
2. Instrument, don't guess: count snapshot events received on the tablet (a temporary on-page
   counter) and log `pushSnapshot` sends in the renderer. The suspect is whichever hop the count stops at.
3. Fix that hop. Likely shapes, depending on the answer:
   - suspect 1 → a **bind failure must be loud**: an error in the Show Control tab naming the port
     and "another ArtLux is serving tablets", and the same in the tablet header via `hello`
     (e.g. `pid`/`mode`, so a tablet can show *which* instance it is on);
   - suspect 2 → clear the guard flags on every tab switch / dialog close, and add a stale-check;
   - suspect 3 → a client-side watchdog: if no event (status arrives at 2 Hz) for ~5 s, close and
     reopen the `EventSource`, and re-request on `visibilitychange` → visible;
   - suspect 4 → add the missing fields to `SnapState`/`SnapTransition` *and* to the States tab's
     `renderIfChanged` signature (the comment at `clientHtml.ts:221` says a field added to the
     markup must be added there too, or the tab stops repainting).
4. If the fix is a bug of the "compiled, booted, nothing threw" kind, **add a `verify:invariants`
   check** for it (CLAUDE.md working loop).
5. **Verify in the mode it ships in** — `--broadcast` as well as the editor (test-the-target-mode).

---

## 3. Node.js October 2026 security release → Electron bump

### Findings (2026-10-22)

- Node released fixes for 10 CVEs on 2026-10-21; fixed in **24.22.1** (our line). Worst:
  CVE-2026-111497, Brotli decoder out-of-bounds write → RCE when decompressing attacker data.
- **ArtLux.exe ships Electron 42.4.1 → Node 24.16.0** (measured), so the vulnerable code is in the
  exe. **No reachable path found**: main never Brotli-decompresses (only `inflate` in `mpcdi.ts`),
  makes no Node-side TLS client connections, no `dns.resolve`; renderer `fetch` is Chromium's.
  Practical risk low; the larger exposure is that 42.4.1 is four months behind Chromium fixes.
- **Launcher**: Tauri/Rust, no Node at runtime — not affected.
- **CI uses Node 20 (EOL)** in `build.yml` and `launcher.yml` — never patched again.

### No Electron ships the fix yet (checked 2026-10-22)

From Electron's own release feed (`releases.electronjs.org/releases.json`, the `node` field) and
each version's GitHub release notes:

| Electron | Bundled Node | Has the fix (≥ 24.22.1)? |
|---|---|---|
| 42.4.1 — **what ArtLux ships** | 24.16.0 | ❌ |
| 42.11.18 — newest 42.x (2026-10-21) | 24.19.0 | ❌ notes list only ANGLE/Chromium/PDFium/Skia/V8 backports |
| 43.8.3 / 44.9.3 / 45.0.0 (all 2026-10-21) | 24.22.0 | ❌ one patch short |
| dev PC `node -v` | 24.22.1 | ✅ |

**So the first draft of this item was wrong.** "42.4.1 → 42.11.18" does not deliver the fix, and its
gate would never have opened. Worse, 42.x looks like it has reached the end of its line. Electron
normally supports the three newest majors, and 45.0.0 landed on 2026-10-21. This is not confirmed
against Electron's support timeline. **Check it before relying on it.**

### The change (revised)

1. **CI now, independently:** `node-version: 20` → **`24`** in `build.yml` and `launcher.yml`.
   `setup-node` resolves `24` to the newest 24.x, which today is the patched 24.22.1, and nothing
   waits on Electron for that. This affects only the BUILD (npm, electron-builder, vite), never the shipped exe.
2. **The app: wait for the first Electron whose `releases.json` `node` is ≥ 24.22.1.** It will almost
   certainly be a 43/44/45 patch, so this is a **MAJOR move (42 → 43+)**, not the patch bump first
   planned. Read before choosing:
   - **Which major.** Prefer the oldest still-supported line that carries the fix, the smallest
     Chromium jump. 43 → Chromium 150, 44 → 152, 45 → 156; ArtLux is on 148 today.
   - **Read every intermediate major's breaking-changes notes.** 45.0.0 alone changes ASAR
     `fs.open` (descriptors are no longer real files: `EBADF` for native/raw-fd readers) and narrows
     `nodeIntegrationInWorker`. Grep the main process + plugins for `fs.open*` on ASAR paths before
     taking 45.
   - **The platform/GPU matrix** in the memory `artlux-venue-gpu-platforms` is written against
     Chromium 148. WebGPU behaviour on the venue GPUs must be re-checked on the new Chromium. WebGPU
     is REQUIRED on venue machines, so this is the riskiest part of the move. Do it on the RTX
     machine, not only the Intel dev PC (see the dev-PC-perf memory).
3. **Native modules:** all are N-API (`audio-engine` pins `NAPI_VERSION=8`; the Rust crates are
   napi-rs), so the ABI should hold across majors. Still rebuild them all (`npm run build:native` +
   `build:audio`, app closed) and confirm each one logs as loaded, not `[module] unavailable`.
   Update the stale comment in `native/audio-engine/CMakeLists.txt:8` ("Electron 42 (node 22)").
4. **Until then the exposure stays LOW.** No ArtLux code path reaches the vulnerable Node code (see
   Findings). Recheck that claim if anything adds a main-process `fetch`/`http` client or Brotli
   decompression before the move lands.

**Watching for the release:** the check is one line against the feed. List every Electron release
whose bundled Node is ≥ 24.22.1:
`curl -s https://releases.electronjs.org/releases.json | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{for(const r of JSON.parse(s)){const [a,b,c]=r.node.split('.').map(Number);if(a===24&&(b>22||(b===22&&c>=1)))console.log(r.version,r.node,r.date)}})"`

### Verify

- `npm run verify`, then `npm run package:dir`.
- In the **packaged** build: print `process.versions.node` (**must be ≥ 24.22.1**, which is the point of
  the change) and `process.versions.electron` / `process.versions.chrome`.
- **Launch the packaged `ArtLux.exe` with no CDP port** and confirm the editor window and splash
  appear (a dev run never proves window visibility — CLAUDE.md loop rules).
- Smoke: Art-Net out, audio plays, a projector output opens, auto-update check reaches GitHub.
- **WebGPU on the venue GPU** (RTX): surfaces sample, the 3D scene renders, projector outputs play.
- CI green on both workflows. Release tag only when the owner asks.

---

## Order

1. **CI → Node 24.** Tiny and independent, but **the owner chose to wait (2026-10-22)**. Leave CI on
   Node 20 until they ask. Possibly do it together with the Electron move.
2. **Tablet stale-token fix** (item 2): root cause proven live. This is what the owner actually hit.
3. **QR per adapter** (item 1): cause known, self-contained, docs in the same commit.
4. **Electron major move** (item 3): blocked until an Electron ships Node ≥ 24.22.1, then its own
   change with the RTX-machine check.
