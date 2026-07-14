# MIDI Controller Support — input mapping with MIDI-learn + remappable bindings

> **Status:** Draft · **Adds:** a net-new **MIDI control-input** subsystem (a controller drives scenes/cues/states/transport + continuous params), NOT a limitation-lift · **Placement:** **Plugin** (`plugins/midi`, renderer-only — the show-control template minus the server) **+ 2 minor core touches** (a main-process permission grant; an additive `ProjectData.midiBindings?`) · **Risk:** Medium · **Breaking changes:** Project-file (additive, normalize-defaulted) + a main-process **permission** change (grants Web MIDI; needs an app restart). No IPC/SDK/compile break.

## Context — why this, and the decided route

ArtLux has **zero MIDI today** — grepped: `navigator.requestMIDIAccess`/`MIDIAccess`/`WebMidi` return **no matches**; the only `midi` hits are two forward-looking comments ("future external triggers like OSC/MIDI", [timeline.ts:448](src/renderer/services/timeline.ts#L448)). External control is currently **OSC-only**. Yet a hardware controller (APC/Launchpad, a fader box, a keyboard) is the most-requested live front-end for an installation/show tool: press a pad → fire a look, ride a fader → dim a surface, hit a key → jump a state.

**The architecture already anticipates this.** Every external trigger source in the app is a thin, React-free adapter that funnels into the same singletons: [oscController.ts](src/renderer/services/oscController.ts) parses OSC and calls `cueBus.requestRecall` / `cueBus.requestFireCue` / `timeline.triggerSmTransition` / `timeline.dispatchTransportIntent`; the tablet remote does the same via `host.show.*` ([plugins/show-control/src/dispatch.ts:8](plugins/show-control/src/dispatch.ts#L8)). **MIDI is a third adapter onto the identical buses** — no new recall/fade/state machinery is invented; the work is (1) reading MIDI, (2) a **learnable, remappable binding table**, and (3) a small dispatch that maps a matched MIDI event → an existing action.

**Decided route:**
- **Substrate:** the **Web MIDI API** (`navigator.requestMIDIAccess`) in the renderer — Chromium in Electron `^42.4.1` ([package.json:50](package.json#L50)) supports it; **no native module**, no new build path, sandbox-safe. The one gate is a main-process permission grant (below).
- **Placement:** a **renderer-only first-party plugin** `plugins/midi`, mirroring show-control's non-server half (register a `SettingsSection` + a `modal` panel; consume `host.show`). Two unavoidable **core** touches, both tiny: the Web-MIDI **permission** and (if bindings travel with the show) an **additive persisted field**.
- **Scope v1:** input → **discrete actions** (scene/cue/column/state/transport) and **continuous CC → fadeable params**; **MIDI-learn** to bind and a **remap table** to edit. Explicitly **out of scope v1:** MIDI *output*/feedback (LED rings, motor faders), MIDI clock sync, and per-scene binding scopes (see §Open questions).

## Requirements this must satisfy
1. Read input from any connected MIDI device (hot-plug aware).
2. **MIDI-learn:** arm a target, wiggle a control, capture the message (note / CC / program-change / pitch-bend + channel) as a binding.
3. **Remappable bindings:** a table to view / retarget / delete bindings, with per-binding options.
4. **Discrete** input (note/pad/program) → **scene recall · cue fire · column fire · state transition · state enter · transport** (reuse the existing buses).
5. **Continuous** input (CC / fader / knob / pitch-bend) → a **fadeable parameter** with range + response-curve mapping.
6. All of it **persists** (bindings travel with the show; device/global prefs stay per-machine) and **degrades gracefully** when MIDI is absent or denied.

## Architecture at a glance

```
 MIDI device ─USB/DIN─▶ Web MIDI (plugins/midi, renderer)              existing buses (unchanged)
                        navigator.requestMIDIAccess()                  ┌───────────────────────────────
                        input.onmidimessage  ─┐                        │ host.show.recallScene → cueBus.requestRecall
                                              │  match vs bindings     │ host.show.fireCue/fireColumn → cueBus
                        ┌── discrete (note/prog/pad) ──▶ dispatch() ───┤ host.show.triggerTransition/enterState → timeline
                        │                                              │ host.show.transport → timeline.dispatchTransportIntent
                        └── continuous (CC/pitchbend) ─▶ getByPath +   │   (the identical calls OSC + the tablet use)
                                                        transitions.start on a StateView param
                        learn: arm a target → capture the next message as its matcher
 Settings (device · sysex · panic) → AppSettings.plugins['midi'] (per-machine)
 Bindings → ProjectData.midiBindings?  (per-project, travels with the show)
 Main: grantMediaPermissions() grants 'midi'/'midiSysex'  (src/main/index.ts:169)
```

Control is renderer-local: the Web MIDI callback runs in the same process as `cueBus`/`timeline`/`host.show`, so a matched event is a direct function call — no IPC on the hot path (the generic `plugin:<ch>` bridge is only needed if a native backend is ever chosen, §Open questions).

## Design / approach — workstreams

### WS1 · Web MIDI access + the permission grant (core touch #1)
- **The one real blocker:** [src/main/index.ts:168-174](src/main/index.ts#L168) `grantMediaPermissions()` whitelists a `MEDIA` set for both `setPermissionRequestHandler` and `setPermissionCheckHandler`; `'midi'`/`'midiSysex'` are **absent**, so `requestMIDIAccess()` (and especially `{ sysex:true }`) is **denied**. Add `'midi'` (always) and `'midiSysex'` (gated behind the settings toggle, default off) to the granted set. Main-process change → **needs an app restart** to take effect.
- Renderer plugin `activate()` calls `navigator.requestMIDIAccess({ sysex })`, enumerates `access.inputs`, subscribes `input.onmidimessage`, and tracks hot-plug via `access.onstatechange`. `webPreferences` (contextIsolation/sandbox, [index.ts:93-99](src/main/index.ts#L93)) don't obstruct Web MIDI (it lives in the renderer); **no CSP exists** to block it (grepped: none).

### WS2 · Binding model + persisted types (core, by doctrine)
- **`MidiBinding`** = `{ id; input: MidiMatcher; action: MidiAction; enabled }` where `MidiMatcher = { kind:'note'|'cc'|'program'|'pitchbend'; channel?:0-15|'any'; number?:0-127 }` and `MidiAction` is a tagged union: discrete `{ kind:'scene'|'cue'|'column'|'transition'|'state'|'transport'; ref/bank+col/intent; noteMode?:'trigger'|'toggle'|'momentary' }` or continuous `{ kind:'param'; targetPath:string; min:number; max:number; curve:'linear'|'log'|'exp'; pickup?:boolean }`.
- **Persist per-project** so bindings travel with the show: add an **additive optional** `midiBindings?: unknown[]` to `ProjectData` ([shared/protocol.ts:537](shared/protocol.ts#L537)) — the exact precedent is `schedule?: unknown[]  // ScheduleEntry[] (@artlux/plugin-show-control)` ([protocol.ts:551](shared/protocol.ts#L551)). Behavior/shape stay in the plugin; only the persisted array is core (CLAUDE.md "core stays core", [CLAUDE.md:171-173](../CLAUDE.md#L171)). Add a `normalizeMidiBindings()` default at the read site (the `normalizeTimeline`/`normalizeStateMachine` pattern, [types.ts:351,370](src/renderer/types.ts#L351)) so **old projects load unchanged, no version bump**.
- **Per-machine** device selection, sysex toggle, and any global (project-independent) maps live in `AppSettings.plugins['midi']` — the private per-plugin namespace ([types.ts:417](src/renderer/types.ts#L417)), read the show-control way (`s.plugins?.['midi']` + `DEFAULTS`).

### WS3 · The dispatch layer (plugin — mirror `show-control/dispatch.ts`)
- A `dispatch(host, binding, midiMsg)` that, on a **discrete** match, calls the same seams the tablet uses ([dispatch.ts:11-17](plugins/show-control/src/dispatch.ts#L11)): `host.show.recallScene(ref)` → `cueBus.requestRecall` ([App.tsx:1200](src/renderer/App.tsx#L1200)), `fireCue`/`fireColumn` → `cueBus` ([cueBus.ts:27,31](src/renderer/services/cueBus.ts#L27)), `triggerTransition(id)`/`enterState(id)` → `timeline` ([timeline.ts:446,449](src/renderer/services/timeline.ts#L446)), `transport(intent)` → `timeline.dispatchTransportIntent` ([App.tsx:1203](src/renderer/App.tsx#L1203)). `noteMode` handles pad **toggle**/**momentary** (note-on/off, velocity-0-as-note-off).
- On a **continuous** match: read the live value with `getByPath(view, targetPath)` ([paramPath.ts:45](src/renderer/services/paramPath.ts#L45)), map the 0-127 (or 14-bit) input through `min/max/curve`, and drive it — either commit React state + `transitions.start([{ path, from, to }])` for a glide, or snap via `setByPath` ([paramPath.ts:67](src/renderer/services/paramPath.ts#L67)). Target enumeration reuses `globalParams()`/`surfaceParams()`/`fixtureParams()` ([paramPath.ts:101,105,126](src/renderer/services/paramPath.ts#L101)). **Coalesce per animation frame** (a fader spams ~1 kHz) and **default CC targets to non-geometry fadeables** — geometry leaves (`x,y,width,height,rotation`) force a GPU-mapper rebuild (`GEOMETRY_LEAVES`, [paramPath.ts:27](src/renderer/services/paramPath.ts#L27)).

### WS4 · MIDI-learn (plugin UI — greenfield, no precedent)
- **No learn/binding UI exists** anywhere (grepped `learn`/`arm`/`listening`/`assign` → only GL-buffer + OSC-"listening" hits). Build an **arm** flow: click a binding row's **input** cell → enter "listening" (a pulsing indicator), capture the **next** incoming message as the matcher, debounce and prefer the loudest CC / a stable note. The target column reuses the param-picker UX already in `CueBankPanel`'s `CaptureGroup` ([CueBankPanel.tsx:284](src/renderer/components/CueBankPanel.tsx#L284)) — the same `*Params()` lists, presented as a target picker instead of a value-capture.

### WS5 · Mapping-table panel (plugin `modal` panel)
- Register `ctx.panels.register({ id:'midi', mount:'modal', menuAction:'midi', title:'MIDI Mapping', Component })` (the show-control pattern, [plugin.renderer.ts:55](plugins/show-control/src/plugin.renderer.ts#L55)); it mounts at [App.tsx:1952](src/renderer/App.tsx#L1952) and is toggled by a menu action matched at [App.tsx:1081](src/renderer/App.tsx#L1081). Rows = **input (learned) · action (scene/cue/state/transport/param picker) · options (toggle/momentary; CC min/max/curve/pickup) · delete**, plus a live **activity dot** per row when its input fires. **Menu mirroring hazard:** the `'midi'` menu item must be added to **both** [src/main/menu.ts](src/main/menu.ts) **and** [src/renderer/components/MenuBar.tsx](src/renderer/components/MenuBar.tsx) or the app ships divergent menus.

### WS6 · Device + global settings (`SettingsSection`)
- Register `ctx.settings.register({ id:'midi', title:'MIDI', Component })` ([plugin.renderer.ts:54](plugins/show-control/src/plugin.renderer.ts#L54)); it renders in Preferences ([Preferences.tsx:277](src/renderer/components/Preferences.tsx#L277)). Controls: enable MIDI, input-port list (with hot-plug status), **sysex** toggle (default **off**), and a **MIDI panic** (all-notes-off / reset). Persist to `AppSettings.plugins['midi']` (per-machine — hardware differs by venue).

### WS7 · Plugin wiring (renderer-only, static registration)
- Add `plugins/midi` to the renderer `FIRST_PARTY` array ([src/renderer/host/plugins.ts:26](src/renderer/host/plugins.ts#L26)); **no main half** is needed (Web MIDI is renderer-side) unless a native backend is later chosen. **Barrel-only imports + `"sideEffects": false`** (the singleton bug, [CLAUDE.md:165-170](../CLAUDE.md#L165)); guard with `npm run verify:plugins`. Consumes `host.show` (already injected via `activateRendererPlugins('main', pluginHost)`, [App.tsx:1224](src/renderer/App.tsx#L1224)); the NOOP host keeps projector windows inert ([host/plugins.ts:33-45](src/renderer/host/plugins.ts#L33)).

## ⚠️ Breaking changes (warn loudly)
- **Main-process permission (the real one):** `grantMediaPermissions` gains `'midi'`/`'midiSysex'`, granting the renderer Web MIDI. **Behavioral, needs an app restart**, and widens device access — mitigated by keeping **sysex default-off** behind a settings toggle. Nothing else in the permission set changes.
- **Persisted `.artlux`:** additive optional `ProjectData.midiBindings?` with a `normalize*()` default ⇒ **old projects load unchanged, `ProjectData.version` stays put** (the `schedule?` precedent). Per-machine settings are self-defaulting under `AppSettings.plugins['midi']`.
- **Two hand-mirrored menus** must both gain the `'midi'` item ([menu.ts](src/main/menu.ts) + [MenuBar.tsx](src/renderer/components/MenuBar.tsx)).
- **No** IPC / SDK / compile-contract break: renderer-only plugin over the generic bridge; **no new preload method**; no new `host.*` service (it consumes the existing `host.show`).

## Risk evaluation — **Medium**
Blast radius is small and mostly additive, but four things earn the Medium rating:
1. **Web MIDI is greenfield here** — no prior usage, and it only works once the permission grant lands (a main-process change, restart-gated). Low technical risk (Chromium-native), but the permission is a hard prerequisite that's easy to miss.
2. **MIDI-learn has no precedent** — the arm/capture/edit UX is the largest single build, and MIDI hardware is messy (running status, note-on-vel-0-as-off, 14-bit CC, per-vendor CC conventions, channel modes). Parsing robustness is where bugs hide.
3. **Continuous-CC → param perf** — a fader emits ~1 kHz; without per-frame coalescing (and steering CC away from geometry leaves) it can thrash React state and the GPU-mapper rebuild ([paramPath.ts:27](src/renderer/services/paramPath.ts#L27)).
4. **Singleton/barrel hazard** for the new plugin. WebGPU/WebGL parity: N/A. No native module, no CSP work, no new IPC contract.

## Migration & back-compat
Additive optional `midiBindings` + a `normalizeMidiBindings()` default; `ProjectData.version` unchanged; projects without MIDI load silently. Plugin disabled / no device / permission denied / Web MIDI unsupported ⇒ **graceful degrade** — a `[midi] unavailable` log and the feature simply off, identical to the other optional subsystems. Per-machine settings self-default.

## Verification (repo patterns — no unit runner)
- `npx tsc -p tsconfig.json --noEmit` + `npm run build` + `npm run verify:plugins` (single-identity marker) clean.
- **Access spike (P0 gate):** with the permission grant in, `requestMIDIAccess()` resolves and inputs enumerate + log messages in the dev app. Prove it before building UI.
- **Discrete:** learn a **pad → scene recall**, a **key → state transition**, a **pad → transport play** — fire them from the controller, watch the look/state/transport change (the same buses OSC drives).
- **Continuous:** learn a **CC → a surface's opacity/intensity**; ride the fader and see it glide (via `transitions`), respecting min/max/curve; confirm no geometry-rebuild thrash.
- **Learn/remap:** arm a row, wiggle a control, confirm capture; retarget and delete; per-row activity dot lights on input.
- **Hot-plug:** unplug/replug a device mid-session (`onstatechange`); **sysex** default-off; **MIDI panic** silences.
- **Graceful degrade:** deny the permission / run with no device → `[midi] unavailable`, no crash. **Persist:** bindings survive save+reload (normalize); a pre-MIDI `.artlux` loads unchanged.
- **Virtual ports** for CI-less manual testing: loopMIDI (Windows) / IAC (macOS) + a sender.

## Effort & phasing — **M**
- **P0 — Access spike:** permission grant ([index.ts:169](src/main/index.ts#L169)) + `requestMIDIAccess` + enumerate/log. Gates the rest.
- **P1 — Discrete core:** binding model + persisted types (WS2) + `dispatch()` to `host.show` discrete actions + a minimal read-only mapping table.
- **P2 — Learn:** the arm/capture/remap UX (WS4) + the table editor (WS5).
- **P3 — Continuous:** CC → param via `paramPath` + `transitions`, with range/curve/pickup and per-frame coalescing (WS3).
- **P4 — Settings & robustness:** device/sysex/panic settings (WS6), hot-plug, note modes, 14-bit CC, MIDI-message hardening.
- Ship P0–P1 behind the graceful-degrade path so the tree stays releasable throughout.

## Open questions / decisions
1. **Web MIDI vs a native backend (node-midi/JZZ in `main`)?** Recommend **Web MIDI** for v1 (zero native, renderer-only, sandbox-safe). Native only if headless/background MIDI proves unreliable — see Q7.
2. **Sysex** default-off (safety) — confirm. Some controllers need it for deep features and it's required for MIDI **feedback** (Q5).
3. **Binding scope:** per-project (travels with the show) vs per-machine (per controller) vs **both**? Recommend **both** — per-project show bindings (`ProjectData.midiBindings`) plus a per-machine device/global layer (`AppSettings.plugins['midi']`).
4. **Scene/state-scoped maps** (a different binding set per state) — powerful but v1 keeps bindings **global**; defer scoped maps.
5. **MIDI output / feedback** (LED rings, motor faders reflecting scene/param state) — **out of scope v1**; needs output ports + a state→MIDI reflector. Defer.
6. **MIDI clock** in/out (sync transport to an external clock) — a separate feature; defer.
7. **Headless / `--broadcast`:** does Web MIDI work when the app runs as an unattended show (a renderer exists, but is it a permitted context)? **Verify** — if not, that's the concrete case for the native backend (Q1) and the pairing with `headless-plugin-host`.
8. **Continuous-CC → geometry params:** allow, but warn in the UI (each move rebuilds the GPU mapper); default CC targets to non-geometry fadeables.

---

*Grounded in an adversarial code-reading of the OSC/cue/state/param control path. Pairs naturally with [show-control-tablet-parity](archive/show-control-tablet-parity.md) (both are external-control front-ends onto the same buses); the continuous-CC path also unlocks riding [audio-engine](audio-engine.md) params once its `audio.*` `paramPath` namespace lands — a synergy, not a dependency.*
