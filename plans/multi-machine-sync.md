# Multi-machine sync — a master/slave video wall

> **Status:** ⬜ **DESIGNED, NOT STARTED (2026-08-11).** Recorded at the owner's request after a
> code-reading survey; **no code exists and none is asked for yet.** · **Adds:** a net-new
> **machine-to-machine show-sync** subsystem (one master beats the clock, N nodes each drive their share of
> a wall, frame-locked), NOT a limitation-lift · **Placement:** **a thin core seam** in
> `src/renderer/services/timeline.ts` **+ a cross-process plugin** `plugins/sync` · **Risk:** 🟠 Med-high —
> the seam is in the most invariant-dense file in the tree · **Breaking changes:** **none** — no
> `ProjectData` field, no `shared/protocol.ts` change, no migration.
>
> ⚠ **Phase 0 is a measurement gate that can close this plan.** If the venue LAN cannot hold ~2 ms of
> offset jitter, software frame-lock is not achievable and the answer is NVIDIA Quadro Sync hardware, not
> more code. Do not start P1 before P0 has a number. Same shape as
> [native-core.md](native-core.md)'s hardware gate.

## Context — why this, and the decided route

A wall needing **more than four video outputs** exceeds what one machine can drive, and ArtLux has **no
concept of a second machine**. Grepped across `src/ shared/ plugins/ docs/ plans/`: there is no NTP, no
PTP, no LTC/MTC/SMPTE chase, no genlock, no timecode input, no cluster, no leader/follower — and no plan
for any of it. Two near-misses exist and neither is prior art:

- [webgl-strict-per-surface-sampling.md:137](webgl-strict-per-surface-sampling.md) defers Phase 2 "pending
  the multi-machine decision". **That means *more than one test machine* — heterogeneous target hardware,
  does the deployment always have WebGPU.** It is not about networked servers. Do not mistake it.
- [projector-blend-preview.md:56-71](projector-blend-preview.md) designs a **phase-locked effect clock**
  by broadcasting `effectEpoch = performance.timeOrigin` so every window derives identical effect time. It
  is explicitly scoped to "consistent across BrowserWindow contexts **on the same machine**", and it was
  **never implemented** (`grep effectEpoch` over `src/ shared/ plugins/` returns nothing — what shipped
  instead was `showTime`). The epoch trick in it is right and this plan generalizes it across machines.

The only genuinely networked features today are the **show-control** tablet server (many tablets, one
machine) and **NDI** (send a picture to another machine's *input* — no clock, no timestamp; `NdiFrame` is
`{width, height, data, srcWidth, srcHeight}` and carries no `timecode` field).

### Decided route (settled with the owner, 2026-08-11)

| Decision | Choice | Why not the alternative |
|---|---|---|
| Sync class | **Frame-locked, software** over Ethernet | Genlock needs matched pro cards, sync boards and coax. Software gets ±1 frame, which is invisible on a wall, *if* P0's number holds. |
| Topology | **Local media on every node**; clock + cues cross the wire (~10 KB/s) | Streaming pixels means 4× UHD regions ≈ 4 Gbit/s, 10 GbE minimum, plus latency and generation loss. |
| A node outputs | **Projector/display outputs** + **Art-Net/sACN LED** | Audio and USB-DMX are explicitly excluded — see §Explicitly out of scope. |
| Master loss | **Keep free-running**, re-lock silently | An election puts split-brain on a flaky switch; a hold visibly stops the show. |
| Project distribution | **Master pushes**, hash-diffed | A shared NAS makes the show depend on a file server; manual copy has no version guard. |
| Master role | **A setting** — `master`, `master+output`, `slave` | A heavy master can jitter its own beacon; whether that matters is a P0 measurement, not a build-time assumption. |

### Finding 1 — ArtLux already implements master/slave transport, between windows

This is the single most important thing to know before designing anything here.

- **Producer:** [App.tsx:3507-3517](src/renderer/App.tsx#L3507) subscribes to the timeline engine, gates at
  **15 ms** (deliberately finer than the 30 Hz producer period — the rule is written up at
  [docs/DEVELOPMENT.md:305](../docs/DEVELOPMENT.md)) and posts `{t:'transport', playing, playhead, showTime}`
  to every projector port.
- **Consumer:** [ProjectorApp.tsx:359-364](src/renderer/projector/ProjectorApp.tsx#L359) →
  `engine.setPlaying` / `engine.seek(playhead)` / `engine.setExternalShowTime(showTime)`.
- **Discipline:** [timeline.ts:1430-1437](src/renderer/services/timeline.ts#L1430) — hard **snap** if
  `|err| > 0.5 s`, otherwise **slew** `SLEW = 0.1` (10 % of residual per update,
  [timeline.ts:164](src/renderer/services/timeline.ts#L164)).

A network slave is that same consumer over a different wire. **But it must not be built as `external`/
mirror mode.** A mirror window self-renders only `{IMAGE, EFFECT, TRACKING, SHADER}`
([ProjectorApp.tsx:33](src/renderer/projector/ProjectorApp.tsx#L33)) and has
`{CAMERA, SPOUT, DMX_IN, NDI, VIDEO, LAYER, PROGRAM}` streamed to it as transferred `ImageBitmap`s
([App.tsx:3572](src/renderer/App.tsx#L3572)), because decoding the same media in every window exhausts the
GPU's concurrent hardware-decode sessions. **A network node has no such stream — it is a full app that
decodes its own media.** So:

> **A slave node is a normal `--broadcast` instance whose *main renderer's clock anchors* are set from the
> network. Its own projector windows keep following it over the existing MessagePort, unchanged.**

Consequence: **zero changes to `src/renderer/projector/`.** The in-tree precedent for this partial-mirror
shape is `hapLocal` ([timeline.ts:101](src/renderer/services/timeline.ts#L101)) — a window that is *told*
the transport but still decodes for itself.

### Finding 2 — replicate the *anchor*, not the time

Both clocks are **derived, never accumulated**: `t = (now - originMs) / 1000`
([timeline.ts:107-111](src/renderer/services/timeline.ts#L107),
[:134-135](src/renderer/services/timeline.ts#L134)). `originMs` moves only at the **seven** documented
re-anchor sites ([timeline.ts:119](src/renderer/services/timeline.ts#L119)) — `mainSeek`, the underrun
branch, the loop wrap, the end-stop park, the paused hold, `setPlaying(true)`, the mirror snap/slew — and
not once per frame.

So the master does not need to stream time at 30 Hz and have followers chase it. **It publishes its
origins**, which are near-static. A follower that knows the clock offset between the two machines computes
the identical `showTime` locally, per frame, with no interpolation and no residual error.

Network jitter stops mattering: a late beacon carries the same anchor as an early one. That is what makes
"frame-locked in software" a realistic claim rather than an aspiration, and it is strictly better than the
existing 15 ms sample-and-slew bridge — which is tuned for a zero-latency intra-process channel and
assumes the message is instantaneous ([timeline.ts:1538](src/renderer/services/timeline.ts#L1538)).

## Requirements this must satisfy

1. **N nodes present the same frame index, ±1 frame**, on ordinary gigabit Ethernet, no sync hardware.
2. Each node **decodes its own media** from a **local** copy of the project; only clock + cues cross the wire.
3. Each node drives **its own** projector outputs and **its own** Art-Net/sACN controllers — and **no two
   nodes drive the same universe**.
4. **Master loss is not a show-stopper**: nodes free-run and re-lock silently, with no visible seek.
5. A node is **self-healing** — it inherits the existing watchdog's relaunch-into-`--broadcast` recovery.
6. The master can **push the project + assets** to every node and **prove** they match (hash, app version).
7. **No project-file change.** The same `.artlux` opens on every node and on a single machine unchanged.
8. It **degrades gracefully**: sync off, or a node alone on the network, behaves exactly as today.

## Architecture at a glance

```
                       broadcast HELLO 1 Hz  (discovery, 255.255.255.255)
        ┌───────────────────────────────────────────────────────────────┐
        │                                                               │
   ┌────┴─────────────────┐   unicast BEACON 10 Hz   ┌──────────────────▼──┐
   │  MASTER              │ ───────────────────────► │  NODE  (--broadcast)│
   │  role: master+output │   {showOrigin, playhead  │                     │
   │                      │    Origin, playing, rate,│  main/  plugins/sync│
   │  timeline.ts owns    │    recallSeq, docHash}   │    dgram, offset     │
   │  the anchors         │                          │      │ clock model   │
   │                      │ ◄─── PING/PONG 1 Hz ───► │      ▼ (4 Hz, ipc)   │
   │                      │      (SNTP 4-stamp)      │  renderer/           │
   └──────────────────────┘                          │    setClockAnchors() │
                                                     │      │               │
   HTTP 8788 (show-control)                          │      ▼               │
   POST /node/asset  ──── project distribution ────► │  timeline.ts (core)  │
                                                     │      │               │
                                                     │      ▼ MessagePort   │
                                                     │  projector windows   │
                                                     │  (UNCHANGED)         │
                                                     └──────────────────────┘
```

Three transports, each chosen for a reason:

| Path | Transport | Why |
|---|---|---|
| Discovery | **UDP broadcast**, 1 Hz | Mirrors what [transport/discovery.ts](src/main/transport/discovery.ts) already does for ArtPoll, and sidesteps **IGMP snooping** — the reason multicast bites on cheap venue switches. |
| Clock + cues | **UDP unicast**, 10 Hz per node | Node counts are small (<16). Unicast is cheap and avoids multicast entirely. Loss-tolerant: the beacon is idempotent state, not a delta. |
| Project distribution | **HTTP** on the existing show-control server | Reliable, resumable, already authenticated, already running on every machine. |

### The wire format

```
HELLO  { nodeId, name, role, appVersion, projectHash, showKey, httpPort }
BEACON { seq, masterId, showKey,
         showOriginUnixMs, playheadOriginUnixMs,     // the ANCHORS, not the time
         playing, rate, poolKey,
         activeSceneId, recallSeq, recallAtShowTime, fadeSec,
         stateId, docHash, appVersion, txUnixMs }
PING   { t1 }              PONG { t1, t2, t3 }       // t4 stamped on receipt
```

`showKey` is a plain group discriminator (not crypto) so two rigs on one LAN cannot cross-drive each other.

### The clock maths

```
offset = ((t2 - t1) + (t3 - t4)) / 2
delay  = (t4 - t1) - (t3 - t2)
```

Keep an **8-sample window and take the offset from the lowest-`delay` sample** — the standard min-delay
filter, and the thing that makes this robust to switch queueing. **Slew the offset *estimate*, never the
clock**, so a wobbling estimate can never produce a visible jump.

Then, on every beacon:

```
localShowOriginMs = (beacon.showOriginUnixMs - offsetMs) - performance.timeOrigin
```

…written straight into `showOriginMs`. The clock derives from there and is correct with no residual.

**The time base must be monotonic.** Use `performance.timeOrigin + performance.now()` in *both* main and
renderer (Node exposes the same semantics via `perf_hooks`). It is Unix-epoch-referenced but derived from
the OS monotonic clock, so it is comparable across processes on one machine and immune to a wall-clock
step.

> ⚠ **`Date.now()` is forbidden on this path.** An NTP correction mid-show would step the wall clock and
> jump the picture on one machine and not the others. This gets an invariant check (§Verification).

### The core seam

A thin, explicit API on `src/renderer/services/timeline.ts` — the plugin never touches module state:

```ts
setClockRole(r: 'standalone' | 'master' | 'follower'): void
setClockAnchors(a: { showOriginUnixMs; playheadOriginUnixMs; playing; poolKey } | null): void
getClockAnchors(): { showOriginUnixMs: number; playheadOriginUnixMs: number }   // master publishes these
getClockError(): { showErrMs: number; lockedSince: number | null }              // the UI readout
```

`'follower'` skips `fsm.tick()`. **It joins the existing `!external` gate at
[timeline.ts:1020](src/renderer/services/timeline.ts#L1020) so there is ONE predicate, not two** — a second
parallel gate is how the two eventually disagree. Everything else keeps running (decoding, warming,
`sampleAutomation`, the program build), which is exactly why `external` is too coarse to reuse: it disables
all of that.

`playing` still travels through `dispatchTransportIntent`
([timeline.ts:1577](src/renderer/services/timeline.ts#L1577)) so **`App` remains the sole writer** — the
existing invariant, respected rather than worked around.

Renderer-side the plugin reaches this through a narrow `RendererHostServices.clock` service, so
`plugins/sync` imports no core module.

### What follows the clock for free, and what does not

| Content | Time source today | Under sync |
|---|---|---|
| HAP / MP4 **timeline clips** | `clipTime = t - clip.start + clip.inPoint`, frame-exact ([timeline.ts:347](src/renderer/services/timeline.ts#L347); [hapCodec.ts:30](plugins/hap/src/hapCodec.ts#L30), [mp4Decoder.ts:461](plugins/mp4/src/mp4Decoder.ts#L461)) | ✅ locked |
| EFFECT / SHADER surfaces | already ride `showTime` ([surfaceMedia.ts:213](src/renderer/services/surfaceMedia.ts#L213)) | ✅ locked |
| Automation, cues, FSM crossings | ride the playhead | ✅ locked |
| `<video>` **timeline clips** | free-run + a **250 ms** drift deadband ([timeline.ts:289-302](src/renderer/services/timeline.ts#L289)) | ⚠️ ±250 ms |
| **Surface** video / HAP / MP4 (not on a timeline) | **free-running per-window clock — no time coordinate at all** ([contentSource.ts:60](src/renderer/services/contentSource.ts#L60), [hapPlayer.ts:13-27](plugins/hap/src/hapPlayer.ts#L13), [mp4Codec.ts:17-20](plugins/mp4/src/mp4Codec.ts#L17)) | ❌ **drifts, unbounded** |

**The last row is half the feature, not a footnote.** A wall showing a video as *surface content* — an
extremely normal way to use ArtLux — has nothing to correct. Two nodes would drift apart forever. This is
why P3 sits early rather than at the end.

The `<video>` deadband **cannot simply be tightened**: an unconditional per-frame `currentTime` assignment
starves the element and produced black output, which is the entire reason the 250 ms exists and why the
paused threshold differs ([timeline.ts:302-314](src/renderer/services/timeline.ts#L302)). The honest answer
is to steer HAP/MP4 (frame-exact) and **tell the operator** a plain `<video>` layer is not frame-lockable.

### Roles, ownership, placement

Config rides `AppSettings.plugins['sync']`, read via `host.settings.get()` — the show-control pattern:

```
{ enabled, role: 'off' | 'master' | 'master+output' | 'slave',
  showKey, syncPort, nodeName,
  ownedOutputSurfaceIds: string[],   // [] = auto-match by displayLabel
  ownedControllerIds: string[] }     // [] = all
```

**No project-file change and no `shared/protocol.ts` change.** Node identity is *the machine, not the
show* — the same doctrine that removed `settings` from `ProjectData` in P6
([docs/ARCHITECTURE.md:257](../docs/ARCHITECTURE.md)).

**Ownership matters or nodes collide.** `ProjectorOutput` and `Controller` both live in `ProjectData`, so an
identical project on every node makes **every node open every output and blast every Art-Net node** —
doubled traffic and two machines fighting over per-port-address sequence numbers
([artnet.ts:16-17](src/main/transport/artnet.ts#L16)). Hence the two ownership lists, plus a **collision
detector** on the master's node panel keyed `${protocol}|${ip}|${universe}` — the same shape as the shipped
`autopatch-collision-detection` work. (Which default is safe is an open question, §10.)

Projector outputs partly self-select already: an output whose `displayId` does not resolve opens no window
(and, note, **logs nothing about it** — [docs/DEVELOPMENT.md:313](../docs/DEVELOPMENT.md)). But
`displayLabel` collides constantly in the real world ("Generic PnP Monitor" × 4), so an explicit allowlist
is required and auto-match is only the default.

**Placement: a thin core seam + `plugins/sync`** (cross-process, explicit `/main` + `/renderer` barrels like
`ndi` and `show-control`). Per the doctrine, persisted types stay core and only behavior moves — and here
*nothing* is persisted in the project at all.

Inherited constraints, because the **main-side SDK has no contribution seam**: `MainPluginContext` is
`{ipc, window()}` and nothing else ([packages/sdk/src/main.ts:24](packages/sdk/src/main.ts#L24)).
Show-control does not work around this, it **bypasses** it — it imports `node:http` and `electron` directly
and reaches into `../../../src/main/runProfile` with a relative path. `plugins/sync` does the same for
`node:dgram`, and inherits the same limits:

- `ctx.ipc.send` reaches **only the single active window** ([src/main/host/plugins.ts:24](src/main/host/plugins.ts#L24)).
- Main has **no read access to the show model or transport** — every authoritative value round-trips
  through the renderer half.
- Therefore the **renderer** owns config and pushes it down, exactly as show-control does.

## Design / approach — workstreams

### P0 — Network measurement gate  ⚠ *this can close the plan*

`scripts/sync-probe.cjs` — standalone Node, no app, run on two machines: the SNTP exchange at 1 Hz for
5 minutes, reporting offset / delay / jitter distributions and the min-delay filter's stability.

**Kill criteria:**
- **p95 offset jitter > 2 ms** → software frame-lock is not achievable on this network. The answer is
  Quadro Sync II, which is hardware, and this plan stops.
- **A loaded master (rendering 4 outputs) does not answer PONG promptly** → "dedicated master, no outputs"
  becomes the *recommendation* rather than one of three role options.

Do not skip this and do not start P1 without a number. Every performance figure this project has ever
argued from a dev laptop has had to be re-measured — [native-core.md](native-core.md)'s whole Phase 0
exists because its motivating numbers came from an Iris Xe over Parsec.

### P1 — The clock

- The four core functions above in `timeline.ts`; role joins the `fsm.tick` gate.
- A narrow `host.clock` service in `packages/sdk/src/renderer.ts`.
- `plugins/sync` skeleton: main half opens the `dgram` socket, runs discovery + beacon + SNTP, computes the
  filtered offset, and pushes a **clock model** — not per-frame timestamps — to the renderer at ~4 Hz over
  `ctx.ipc`. The renderer half applies anchors locally, per frame. **No per-frame IPC anywhere.**
- **No content or UI changes yet.** Ship a numeric error readout and nothing else.

**Dev harness:** `scripts/sync-master-sim.cjs` / `sync-follower-sim.cjs`, in the
[scripts/lidar-emitter.cjs](../scripts/lidar-emitter.cjs) tradition — a stub peer so one real app can lock
against a fake counterpart on the dev machine. Needed because the **single-instance lock**
([src/main/index.ts:57-59](src/main/index.ts#L57)) blocks two real instances on one machine, and that lock
exists for exactly the reason this feature must respect: "a watchdog respawn must never run two copies
fighting over the same Art-Net universes and displays."

### P2 — Roles, ownership, status

- A `SettingsSection` (role, `showKey`, port, node name) — the show-control panel is the template.
- A **node list** on the master: discovered nodes, app-version and project-hash match, measured offset,
  lock state, last seen.
- A **StatusBar chip**: `SYNC ▪ LOCKED 0.4ms` / `FREE-RUN 4s` / `NO MASTER` / `VERSION MISMATCH`.
- Output/controller ownership + the collision detector.
- **Free-run**: on beacon loss the follower keeps integrating its own clock and turns the chip amber. On
  the master's return it re-locks by **slewing the offset**, never by a hard re-anchor — a re-anchor is a
  visible jump.
- **Split-brain refusal**: a follower seeing two distinct `masterId`s on its `showKey` refuses to lock and
  says which two. Cheap, and it kills the classic failure of the design the owner chose *not* to build an
  election for.

### P3 — Content that has no clock

The other half of *"the videos must run in sync"*.

- Give surface-level **HAP and MP4** an externally-anchorable origin so their clocks derive from `showTime`
  instead of a private `clockOriginMs` ([hapPlayer.ts:13-27](plugins/hap/src/hapPlayer.ts#L13),
  [mp4Codec.ts:17-20](plugins/mp4/src/mp4Codec.ts#L17)). **This also fixes the same drift that exists
  today between a main window and its own projector windows** — see §10, it may be worth landing alone.
- Plain `<video>` surfaces ([contentSource.ts:60](src/renderer/services/contentSource.ts#L60)) get a
  bounded correction on the timeline-clip pattern, keeping the starvation guard and documenting the
  residual honestly rather than claiming a lock it does not have.
- A **preflight**: *"this project has N free-running surfaces; they will drift between nodes"* — with the
  remedy being "put it on a timeline lane, or use HAP/MP4".

### P4 — Show replication

- **The FSM ticks on the master only.** It is already `!external`-gated and fires at most one transition
  per frame; a node that also ticked would double-advance the show.
- **Scene recall as a scheduled event**: the beacon carries `{recallSeq, recallAtShowTime, fadeSec}`,
  repeated until its time passes. Idempotent by `seq`, loss-tolerant, **no TCP in the show path and no
  round-trip in the critical path** — followers execute when their locked clock crosses the time. This is
  the Watchout/Pixera model and it is why the beacon is state rather than events.
- Transport intents (play/pause/stop/seek/loop) replicate the same way.
- **A network-driven recall must not push undo.** Reuse the existing `SHOW_ENGINE` gate in
  `hooks/useHistory.ts` — an unattended six-hour show otherwise leaks an uncapped deep JSON copy of the
  project per automated GO, which is already a known open item in [README.md](README.md).

### P5 — Project distribution

- A `/node/*` route group on the show-control server
  ([plugins/show-control/src/server.ts:113-188](plugins/show-control/src/server.ts#L113)), bearer-authed
  through the **existing PIN pairing** — the master pairs with each node exactly as a tablet does. Gated by
  a separate per-node *"accept updates from master"* toggle, distinct from the existing `locked` flag.
- `GET /node/manifest` → `{projectHash, assets:[{rel, size, sha256}]}`; `POST /node/asset` (streamed write);
  `POST /node/project`; `POST /node/reload` → the existing `relaunchBroadcast()` path.
- Reuse `collectAssetsToFolder` ([projectFolder.ts:521](src/main/projectFolder.ts#L521)) to make the
  master's project self-contained first, and **keep its byte-exact dedup identity** — the comment at
  [projectFolder.ts:258-274](src/main/projectFolder.ts#L258) records that the old basename+size heuristic
  silently remapped one WAV onto another and reported success: "a silent, self-certifying wrong-asset-on-
  stage. Never weaken this back to a heuristic."
- Master-side **"Update nodes"** with per-node progress and a hash verify.

### P6 — Docs, guards, venue verification

`docs/SYNC.md` (hybrid, with `audience:` markers) + a user-guide chapter + `docs/manifest.json` + the
CLAUDE.md index row. **The documentation gate applies at this point** — usage docs ship in the same commits.

## ⚠️ Breaking changes (warn loudly)

**None.** This is the unusual case:

- **No `ProjectData` field**, so no `normalize*()` default and no forward/backward incompatibility. The same
  `.artlux` opens on a node, on the master, and on a standalone machine.
- **No `shared/protocol.ts` change** — config rides `AppSettings.plugins['sync']`, which is prefs, not the show.
- **No IPC contract change** — the plugin uses the generic `plugin:<ch>` bridge.
- **No SDK break** — `host.clock` is additive.

The one behavioural change to an existing surface is **P3**, which alters when a surface-level HAP/MP4 clock
re-anchors. That is a fix in its own right (it removes main-window↔projector drift) but it *is* a change to
shipped behaviour and must be verified on a single machine before the network is involved.

## Risk evaluation — 🟠 **Med-high**

- **`timeline.ts` is the most invariant-dense file in the tree.** The seven re-anchor sites, the two-clock
  identity, the `held` derivation that is deliberately *never latched*, the cold-start arm. Adding a third
  clock role touches the same reasoning. **The show-clock reset table
  ([docs/TIMELINE.md:363-386](../docs/TIMELINE.md)) — 20 rows, every transport event × both clocks — is
  the contract**, and this plan does not yet say per row whether the event replicates or is re-derived
  locally. That is the real design risk and it is §10, not an assumption.
- **The failure mode is silent and remote.** A node that locks to the wrong anchor shows a wrong-but-plausible
  picture. It needs a numeric readout from day one, not a boolean "synced" light — the house rule against a
  UI claiming something the engine is not doing.
- **`<video>` and free-running surfaces will not fully lock**, and the plan must say so in the operator docs
  rather than let the wall reveal it.
- **Mitigated by:** P0 as a real gate; P1 shipping *only* a readout; nothing persisted; and the fact that
  `role: 'off'` is byte-identical to today.

## Migration & back-compat

Nothing to migrate. `role: 'off'` (the default, and the value for any machine that never opens the settings
section) makes every code path identical to the current build. A project authored with sync in mind opens
normally on a single machine — the ownership lists live in prefs, so a lone machine simply owns everything.

## Verification (repo patterns — no unit runner)

- **P0:** `scripts/sync-probe.cjs` on two machines. A distribution, not an average.
- **P1:** the stub peers, then p50/p95/max `showErrMs` off the readout over an hour.
- **Invariant checks** to add to `scripts/verify-invariants.cjs` — each encodes a specific way this breaks:
  1. The sync path never calls `Date.now()` — a wall-clock step would jump the show.
  2. A follower never assigns `playhead`/`showTime` directly; it only sets anchors.
  3. Network transport goes through `dispatchTransportIntent` — `App` stays the sole writer of `playing`.
  4. `fsm.tick()` has exactly one role predicate, not a second parallel gate.
  5. A network-driven recall does not push undo.
- **Venue verification** — this needs two machines and cannot be faked:
  - A full-screen **sweeping-bar sync test pattern**. Misalignment shows at the seam *between machines* and
    is visible to the eye; a high-frame-rate phone capture of the seam is the acceptance artefact.
  - Then a real show: `electron . --broadcast --built-renderer --project=<abs path>` per node. **`--broadcast`,
    not `--headless`** — headless opens no projector windows, by design
    ([README.md](README.md) → scope boundary).
  - Art-Net captured with a `dgram` listener **per node** to prove neither is doubling universes. Two traps
    already recorded in [docs/DEVELOPMENT.md:250-256](../docs/DEVELOPMENT.md): the Art-Net ID is
    `'Art-Net\0'` (a trailing *space* matches nothing), and the listener must not bind 6454 — the app's own
    Art-Net input socket owns it.
  - Pull the master's cable: confirm free-run, then a **silent** re-lock with no visible seek.

## Effort & phasing — **L**

P0 is hours (and may end it). P1–P2 are the substance. P3 is small but touches three plugins. P4 is small
if P1 is right. P5 is self-contained. P6 is the documentation gate. **P0 → P1 → P3 → P2 → P4 → P5 → P6** is
the suggested order: P3 before P2 because a locked clock driving unlocked content is a demo that lies.

## Open questions / decisions

1. **Which rows of the show-clock reset table replicate, and which are re-derived locally?** All 20 need a
   decision. The suspicious ones are row 4 (a recall preserves `showTime`), rows 7/8 (which loop wrap moves
   which clock) and row 17 (mirrors compute no show clock at all — and a node is not a mirror).
2. **Does the Art-Net pacer need cross-machine phase alignment?** The Rust send thread
   ([native/output-engine/src/lib.rs:136-200](../native/output-engine/src/lib.rs)) paces on local wall-clock
   with no external clock hook and no PLL. At 30 Hz a half-frame offset is 16 ms — probably invisible on
   LEDs, possibly not on a fast chase spanning machines. **Measure it; do not add the hook on speculation.**
3. **`ownedControllerIds` default: permissive-with-a-warning, or restrictive-and-silent?** Permissive risks
   two nodes on one universe; restrictive risks a node that silently outputs nothing. Neither is obviously
   right and the house rule ("the UI must not claim something the engine is not doing") cuts both ways.
4. **Should P3 land on its own, regardless of whether sync is ever built?** Anchoring surface HAP/MP4 clocks
   to `showTime` fixes real single-machine drift between a main window and its projector windows, and it is
   the unbuilt half of [projector-blend-preview.md](projector-blend-preview.md)'s phase-lock idea. It may be
   worth doing even if P0 closes this plan.
5. **`AppSettings` does not travel with the project** — so display bindings, output device config and GPU
   settings are per-node and must be commissioned per machine. Should the master be able to push a *prefs
   subset* too, or is that a footgun?
6. **Does a node need its own `showKey` UI at all**, or should pairing over HTTP (P5) also hand it the key?
