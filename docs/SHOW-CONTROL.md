# Show Control (tablet remote + scheduler + project playlist)

A first-party plugin (`@artlux/plugin-show-control`, `plugins/show-control/`) that turns any
phone/tablet browser into an operator surface for ArtLux, adds a wall-clock scheduler, and runs an
**unattended multi-project broadcast playlist** — the classic museum/retail/facade install workflow.

It's a **cross-process plugin** (NDI-style `/main` + `/renderer` barrels): the main half owns an
embedded HTTP server; the renderer half drives the show engine and contributes the app-side UI.

## The desktop Show context (2026-07-23)

Everything the tablet PWA offers is now also in the app's **Show** workspace context — the remote was
the *only* way to reach half of it, so an operator at the machine could arm an unattended venue from a
phone but not from the app in front of them.

| Tablet tab | Desktop |
|---|---|
| Control · States | **Show Deck** — the context's viewport: transport, scene pads, live state + its manual transitions |
| Schedule | **Schedule** dock tab — in-project wall-clock actions (`ProjectData.schedule`) |
| Projects | **Playlist** dock tab — the machine-global unattended broadcast playlist |
| Metrics | **Metrics** dock tab — engine / render / system series + the watchdog self-heal audit |
| (pairing) | **Show Control** dock tab — connect URL, QR, PIN, paired devices |

**One model, two surfaces.** The deck and the schedule go through `host.show` — the same service the
tablet's commands land on — so the two agree by construction. The playlist and the metrics assembler
live in **main**, and were previously reachable only over the HTTP/SSE stream; three handles were added
(`showctl:playlist-get` / `playlist-set` / `scan`, plus `showctl:metrics-get`) so the desktop pulls the
identical payload. Saving the playlist from the desktop runs the same follow-up the tablet's save does,
so a connected tablet stays in sync.

Metrics are pulled only while the panel is **mounted**, mirroring the server's "assemble only while a
client is watching" rule — the sampler stays free when nobody is looking.

## For the operator (how to use it)

1. **Enable it:** Preferences ▸ **Show Control** → tick *Enable the tablet remote*. Note the LAN URL(s)
   and the 4-digit **PIN**. (Also reachable from **View ▸ Show Control…** — the operator panel.)
2. **On the tablet:** open the URL in a browser, enter the PIN once (the device is remembered).
3. **Control tab:** recall scenes, fire cues, transport play/pause/stop — live status streams back.
   (There is no per-column fire row: it was removed at the owner's request, 2026-09-12. The
   `fireColumn` **command** still exists and is still reachable over OSC and from a scheduled entry —
   only the tablet buttons are gone.)
4. **States tab:** drive the project's **state machine** — enable/disable it, fire manual transitions
   from the current state, or **jump to any state** to test. Works in broadcast mode (the tablet is the
   only UI there).
5. **Schedule tab:** in-project wall-clock triggers (e.g. 09:00 recall "Opening", 18:00 stop) saved
   with the project. **Add an action** opens the editor; tapping an existing row reopens it.
6. **Projects tab:** the projects on the show machine are **already listed** — the app scans the folder
   you last used and keeps the list, so there is nothing to type on arrival. Tap **Schedule** on one to
   put it in the **time-of-day playlist**, turn *Unattended switching* on, then *Start in broadcast now*.
   The show switches projects unattended, indefinitely. To point at a different tree, type the folder
   and tap **Scan**.

### Scheduling something, and changing it later

Both layers — a project in the playlist and an action inside a project — schedule the same way, in the
same form, on the app and on the tablet:

| | |
|---|---|
| **What** | the project to load, or the action to run (play / pause / stop / recall a scene / fire a cue) |
| **Repeat** | **Daily** · **Weekly** (pick the days) · **Once** (pick a calendar date) |
| **Time** | local wall clock, 24h |
| **Label** | optional; what the row is called |
| **Enabled** | saved but inactive when off |

**Every scheduled thing is editable.** Tap the row (or ✎ in the app) and change any field, including
which project it points at — the entry keeps its identity, so changing 18:00 to 18:30 is one edit, not
a delete and a rebuild. Deleting lives inside the editor, so a stray tap on a list cannot remove a
scheduled show.

A **Once** entry that has already run is dimmed and marked *already ran*; it stays in the list until
you delete it, and it never fires again. The header line says what is loaded **now** and what is due
**next**, with the day spelled out (*today 18:00*, *Mon 09:00*, *2026-09-19 20:00*) — a bare time is
unreadable on a list that mixes daily, weekly and one-off entries.

> **Finding projects is recursive.** Point at the top of your shows folder and every project **in it
> and in its subfolders** is found — both loose `.artlux` files and portable project folders. Each row
> shows the subfolder it came from, so four shows all called *Main* are still tellable apart, and a
> filter box appears past eight results. Portable projects are listed as one entry and not walked into;
> `node_modules`, `assets` and hidden folders are skipped, and symlinked directories are not followed.
> The walk stops at six levels deep or 500 projects and **says so** when it does.

> **Loading a project from the list restarts the app** in broadcast mode on that project, stopping
> whatever is running. It asks first, both on the tablet and in the app.
7. **Metrics tab:** the same series ArtLux exposes to Prometheus/Grafana — output (fps/pps/universes/up),
   **renderer** (fps, frame p99, work p99, long/dropped frames), and system (CPU/RSS/heap/event-loop
   lag) — live with sparklines and green/amber/red health, no Grafana required.
   > **Render FPS is not judged against 60.** It shows whatever *Preferences ▸ Engine ▸ Engine rate* is
   > set to (30 by default), so a healthy show routinely reads 30 — that is not a fault and is not
   > coloured as one. What *is* coloured: **Frame p99** past two of the show's own frame periods, and
   > **Long frames**, which counts frames well past the median. Both are relative to the rate you chose,
   > so they mean the same thing at 25, 30 or 60. **Output FPS is separate** — it is the Art-Net wire
   > rate (*Preferences ▸ Engine ▸ FPS*) and keeps running at full rate however slow the engine is.
8. **Operator panel (View ▸ Show Control):** a **QR code** to connect (scan → the tablet opens the
   remote and pairs automatically via a `?pin=` URL), the connect URL + PIN, a **Lock** that
   freezes/kicks remotes mid-show, and the paired-device list with per-device kick.

### Stopping the show from the room it is playing in

At the foot of the **Control tab**, under **This machine**:

| | |
|---|---|
| **Restart the app** | The show stops and comes back in a **fresh process**, same mode, same project. Outputs go dark for a few seconds. This is the remote recovery for a show that has wedged — the tablet reconnects by itself and drops you back on the remote when the new process is serving. |
| **Shut down** | The show stops and ArtLux **closes**. |

Both ask first, and both are covered by the operator **Lock** — a locked remote cannot stop the show.

> **A remote shutdown stays down.** An unattended install has a Windows Scheduled Task that starts
> ArtLux again within a minute whenever the process is gone — that is what keeps a venue alive
> through a crash. A shutdown you asked for is not a crash, so it leaves a marker that tells the
> supervisor to stand down, **including after a reboot**. Nothing on the tablet can undo that:
> **someone has to start ArtLux on the machine.** Starting it is also what lifts the marker, so the
> automatic crash recovery is armed again from that moment. A crash never writes the marker, so
> self-healing is untouched.

> **The rig holds its last frame.** Closing the app stops the Art-Net/sACN stream; fixtures that do
> not time out to black keep whatever they were last sent. Send a blackout scene or cue *before*
> shutting down if the venue needs to go dark.

At the machine itself, broadcast mode also has a **tray icon ▸ Quit Broadcast** and
**Ctrl/Cmd+Shift+Q** — both are deliberate quits and behave identically. What the remote adds is
doing it without walking to the machine.

<!-- audience:contributor -->

## Architecture

```
tablet browser ──HTTP(PWA)──▶  ┐  plugin.main (main process)
               ──POST(cmd)───▶ │   • embedded HTTP + SSE server (server.ts, port 8788)
               ◀─SSE(stream)── │   • PIN pairing + per-device tokens (auth.ts, userData sidecar)
                               │   • project-playlist scheduler → app.relaunch (scheduler.ts + playlist.ts)
                               │   • system metrics sampler (metricsSampler.ts)
                               ▼        │ generic plugin: bridge (showctl:*)
                 plugin.renderer (main window) ── dispatch.ts ──▶ host.show → cueBus / timeline
                               ▲                                   (the SAME buses OSC uses)
                               └─ snapshot / status / engine-metrics ┘  + in-project schedule tick
```

- **Transport = HTTP + Server-Sent Events** (not WebSocket): zero extra dependency (pure `node:http`),
  native `EventSource` auto-reconnect (a tablet self-heals across a broadcast relaunch), same-origin.
- **The PWA is embedded** as a single self-contained document (`clientHtml.ts`) served verbatim — no
  second build pipeline, no packaging path, no client/server version skew.
- **The show snapshot is the one payload that is not periodic**, so it is the one that can be wrong
  forever. Status (2 Hz) and metrics (1 Hz) stream continuously and repair themselves; the scene / cue /
  FSM list is sent at plugin activation — when the project is still empty — and then only when
  `host.show` fans out a change, which an unattended venue never does. A single missed or mis-timed push
  therefore left a tablet reading *"No scenes in this project"* for the life of the show, and nothing on
  the desktop could reveal it: the Show Deck re-reads `host.show` when it **mounts**, so the operator's
  own screen was right while the phone was wrong. Two backstops, both in `plugin.renderer.ts`: a device
  opening its SSE stream makes the server ask the renderer for a **fresh** snapshot (`onNeedSnapshot` →
  `showctl:request-snapshot`), and the 2 Hz status timer re-offers one every 4th tick. Both send only
  when the payload actually changed, so a connected tablet is not repainted for nothing.
- **Commands reuse the existing buses.** `dispatch.ts` maps each `ShowCommand` onto the host `show`
  service, which the app wires to the exact `cueBus`/`timeline` singletons the OSC controller uses — so
  the remote drives the show through the identical path and App stays the single writer of `playing`.
  **No new coupling to the show model, no project-file migration for triggers.**

### The `host.show` seam (SDK)

`RendererHostServices.show` (`packages/sdk/src/renderer.ts`) is the one new host capability: read the
project show model (state machine + scenes + cue banks + schedule) and command it. Wired from App state
in `src/renderer/App.tsx` (mirrors the existing `host.settings` wiring). Renderer-only contract; no
persisted-type change beyond `ProjectData.schedule?`.

<!-- audience:operator -->

## Scheduling — two independent layers

| Layer | Where it runs | What it does | Persistence |
|---|---|---|---|
| **In-project schedule** | renderer tick (`plugin.renderer`) — this app disables renderer timer throttling, so it runs in broadcast too | fires a `ShowCommand` at a wall-clock time *within* the loaded project | `ProjectData.schedule` (the `.artlux` file) |
| **Project playlist** | main (`scheduler.ts`) | switches the **whole loaded project** at a wall-clock time via **relaunch-per-project** | machine-global userData sidecar `showctl-playlist.json` |

Both read their **scheme** — daily, weekly, or once on a date — through the one module,
`recurrence.ts`, so "every Monday" and "once on the 20th" cannot come to mean two different things in
two places. Times are always **local**, which is also why a one-off date is parsed as local midnight:
a bare `YYYY-MM-DD` handed to `new Date()` is parsed as *UTC*, which is the previous local day
everywhere west of Greenwich — a show armed for Saturday would have fired on Friday evening.

<!-- audience:contributor -->

Entries carry `repeat` (`'daily' | 'weekly' | 'once'`) and, for a one-off, `date` (`YYYY-MM-DD`).
**Both are optional and there is no migration:** an entry written before they existed has neither, and
`repeatOf()` derives the scheme from the `days` array exactly as the old code read it (empty → daily,
non-empty → weekly). The playlist resolver works in **absolute time** for the same reason a date
exists at all — it used to work in minute-of-week, a coordinate in which a calendar date cannot be
expressed. It enumerates each entry's fires in a ±8-day window and takes the closest on each side,
which reproduces the old wrap (a look-back of one full week) exactly.

<!-- audience:operator -->

**Why relaunch-per-project (not live hot-swap):** `applyProjectData` is re-entrant, but the current
architecture has no teardown for the media-cache blob URLs / old timeline decode pools / undo history,
so a live whole-project swap leaks over days of unattended running. Relaunching gives a **fresh process
every switch** — no accumulated leaks — for a brief (~1–2 s) projector gap. The scheduler is **stateless
across relaunch**: it re-reads the userData playlist and re-arms on every start, so a crash / reboot
with auto-start resumes on the correct due project. A guard only switches when the due project differs
from the loaded `--project=`, so re-arming never loops. (Seamless in-process swap is a clean future
upgrade: add a media-cache/pool/undo teardown, then swap live.)

## Persistence

- **In-project schedule** → `ProjectData.schedule` (portable with the project).
- **Server config** (`{ enabled, port }`) → `AppSettings.plugins['show-control']`.
- **Device tokens** → `showctl-devices.json`; **project playlist** → `showctl-playlist.json` (both
  userData, machine-global).

## Security

PIN pairing → per-device bearer token; unpaired sockets/POSTs are rejected (401). The operator **Lock**
freezes all remotes (423) and can kick devices. The server binds `0.0.0.0` (LAN); it is only reachable
while enabled.

<!-- audience:contributor -->

## Files

The remote's two power routes are `POST /shutdown` and `POST /restart` (both Lock-gated). Each
answers **200 before acting** — `send()` has only written to the socket, so quitting synchronously
would tear the server down before the reply reached the tablet and the remote would report a network
error for an action that in fact succeeded. The quit goes through the app's normal path so main's
`will-quit` teardown runs and marks the exit deliberate; the restart uses `relaunchSameMode()`, which
re-emits this process's own `--broadcast` / `--project=` on top of `relaunchArgs()` (restarting the
*editor* into broadcast would silently turn a workstation into a show machine).

`plugins/show-control/src/`: `types.ts` · `recurrence.ts` (the scheme, shared by both layers and by
all three surfaces) · `server.ts` · `clientHtml.ts` (the PWA) · `auth.ts` · `scheduler.ts` ·
`playlist.ts` · `projectScanner.ts` · `metricsSampler.ts` · `plugin.main.ts` · `dispatch.ts` ·
`ShowControlSettings.tsx` · `ShowControlPanel.tsx` · `ScheduleFields.tsx` · `showControlHost.ts` ·
`plugin.renderer.ts` · `main.ts`/`renderer.ts` barrels.

### The tablet page is a string, so nothing typechecks it

`clientHtml.ts` is one template literal: a stray backtick inside a comment ends it, and an escape that
looks right in the source can still collapse wrong (`\/` became `//`, which commented out the rest of
the line and killed the entire page — TypeScript was perfectly happy). Extract the `<script>` and parse
it before believing anything about that file. The two things that repaint it are also invisible to a
typechecker: the scheduler pushes a `playlist` event **every 5 seconds** whether or not anything
changed, and `renderIfDynamic` answered it with a full `render()` — which rebuilt the Projects tab, and
every form field on it, under the operator's finger. The interlocks now are: an open editor or confirm
sheet is never repainted, a tab repaints only when its **own** data changed, and nothing repaints while
an input has focus.

The desktop **Show context** panels (Show Deck viewport + Schedule / Playlist / Metrics dock tabs):
`ShowControlDeck.tsx` · `SchedulePanel.tsx` · `PlaylistPanel.tsx` · `ShowMetricsPanel.tsx`.

## Metrics wiring

Three series stream as structured JSON over SSE (~1 Hz; only while a tablet is connected):
**engine** (renderer's public `onDmxStats`), **renderer frame-time** (`perfMonitor` via a new
`ctx.onRenderStats` context hook that mirrors `onPlayhead`), and **system** (main-process
`process`/`perf_hooks`). No Prometheus/Grafana required, no loopback `/metrics` exposure.

<!-- audience:operator -->

## QR onboarding

The operator panel renders a QR (dependency-free encoder, `qr.ts` — byte mode, RS core verified against
the published QR-spec vector) of a `http://<ip>:<port>/?pin=<pin>` URL. Scanning opens the PWA, which
reads `?pin=` and **pairs automatically** — one scan, no typing.

<!-- audience:contributor -->

## Status / not yet

- On-hardware validation with a physical tablet + projector switch is pending (built + typechecked +
  `verify:plugins` clean; server/pairing/command/SSE/scan + a live 3-series metrics frame verified
  end-to-end against the dev app; QR RS core asserted against the spec vector).
