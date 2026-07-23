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
3. **Control tab:** recall scenes, fire cue columns, transport play/pause/stop — live status streams
   back.
4. **States tab:** drive the project's **state machine** — enable/disable it, fire manual transitions
   from the current state, or **jump to any state** to test. Works in broadcast mode (the tablet is the
   only UI there).
5. **Schedule tab:** in-project wall-clock triggers (e.g. 09:00 recall "Opening", 18:00 stop) saved
   with the project.
6. **Projects tab:** point at a folder → scan for projects → build a **time-of-day playlist** → enable
   it and *Start in broadcast now*. The show then switches projects unattended, indefinitely.
7. **Metrics tab:** the same series ArtLux exposes to Prometheus/Grafana — output (fps/pps/universes/up),
   **renderer** (fps, frame p99, work p99, long/dropped frames), and system (CPU/RSS/heap/event-loop
   lag) — live with sparklines and green/amber/red health, no Grafana required.
8. **Operator panel (View ▸ Show Control):** a **QR code** to connect (scan → the tablet opens the
   remote and pairs automatically via a `?pin=` URL), the connect URL + PIN, a **Lock** that
   freezes/kicks remotes mid-show, and the paired-device list with per-device kick.

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
- **Commands reuse the existing buses.** `dispatch.ts` maps each `ShowCommand` onto the host `show`
  service, which the app wires to the exact `cueBus`/`timeline` singletons the OSC controller uses — so
  the remote drives the show through the identical path and App stays the single writer of `playing`.
  **No new coupling to the show model, no project-file migration for triggers.**

### The `host.show` seam (SDK)

`RendererHostServices.show` (`packages/sdk/src/renderer.ts`) is the one new host capability: read the
project show model (state machine + scenes + cue banks + schedule) and command it. Wired from App state
in `src/renderer/App.tsx` (mirrors the existing `host.settings` wiring). Renderer-only contract; no
persisted-type change beyond `ProjectData.schedule?`.

## Scheduling — two independent layers

| Layer | Where it runs | What it does | Persistence |
|---|---|---|---|
| **In-project schedule** | renderer tick (`plugin.renderer`) — this app disables renderer timer throttling, so it runs in broadcast too | fires a `ShowCommand` at HH:MM on selected weekdays *within* the loaded project | `ProjectData.schedule` (the `.artlux` file) |
| **Project playlist** | main (`scheduler.ts`) | switches the **whole loaded project** at a time of day via **relaunch-per-project** | machine-global userData sidecar `showctl-playlist.json` |

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

## Files

`plugins/show-control/src/`: `types.ts` · `server.ts` · `clientHtml.ts` (the PWA) · `auth.ts` ·
`scheduler.ts` · `playlist.ts` · `projectScanner.ts` · `metricsSampler.ts` · `plugin.main.ts` ·
`dispatch.ts` · `ShowControlSettings.tsx` · `ShowControlPanel.tsx` · `showControlHost.ts` ·
`plugin.renderer.ts` · `main.ts`/`renderer.ts` barrels.

## Metrics wiring

Three series stream as structured JSON over SSE (~1 Hz; only while a tablet is connected):
**engine** (renderer's public `onDmxStats`), **renderer frame-time** (`perfMonitor` via a new
`ctx.onRenderStats` context hook that mirrors `onPlayhead`), and **system** (main-process
`process`/`perf_hooks`). No Prometheus/Grafana required, no loopback `/metrics` exposure.

## QR onboarding

The operator panel renders a QR (dependency-free encoder, `qr.ts` — byte mode, RS core verified against
the published QR-spec vector) of a `http://<ip>:<port>/?pin=<pin>` URL. Scanning opens the PWA, which
reads `?pin=` and **pairs automatically** — one scan, no typing.

## Status / not yet

- On-hardware validation with a physical tablet + projector switch is pending (built + typechecked +
  `verify:plugins` clean; server/pairing/command/SSE/scan + a live 3-series metrics frame verified
  end-to-end against the dev app; QR RS core asserted against the spec vector).
