# A missing audio engine must announce itself

**Status:** design, approved
**Branch:** `wave-3-audio`
**Found by:** Wave 3 acceptance test **0.3** (`docs/superpowers/2026-07-12-wave-3-acceptance.md`)

---

## The defect

Rename `audio-engine.node` away and start ArtLux. It does exactly what it promises: no crash, the audio
UI renders, every engine call no-ops. It graceful-degrades perfectly.

And it says **nothing**.

The Audio Bed panel draws a complete, healthy-looking mixer over a silent room. The one warning that
exists — `Audio engine unavailable. Playback is disabled.` — is an inline line inside
**Settings ▸ Audio** (`plugins/audio/src/AudioSettings.tsx:80`). You reach it only by already
suspecting the answer. Nobody at 7pm in a venue does.

The acceptance script names this exact state: *"a **silent** dead engine with no notice is gate 1's other
half"*. Test 0.3 currently **fails** on it.

### Root cause

**The renderer cannot ask whether the engine loaded.**

`plugins/audio/src/audioManager.ts:77` exports `available = !!native`. It has **zero consumers** — it is
dead code. `plugins/audio/src/plugin.main.ts` exposes eleven audio IPC channels and no availability one.

So the only signal the UI has is an *inference*: `AudioSettings.tsx:68` computes
`available = !error && !!device`, leaning on the fact that `configure()` returns `''` instead of a device
name when `native` is null (`audioManager.ts:86`). A guess derived from a side effect. That fragility is
precisely why the state was never surfaced anywhere else — there was nothing solid to surface.

Three sibling addons already solved this. `calib:available`, `ndi:available` and `nvwarp:available` are
IPC probes the renderer calls at startup. Audio simply never got one.

---

## Design

One new signal; three consumers. Nothing here invents a pattern — each piece mirrors existing code.

### 1. Expose the truth (`plugins/audio/src/plugin.main.ts`)

```ts
ipc.handle('audio:available', () => engine.available);
```

`plugin.main.ts:8` is already `import * as engine from './audioManager'`, so this is one line. It is a
byte-for-byte mirror of `plugins/calibration/src/plugin.main.ts:15` and `plugins/ndi/src/plugin.main.ts:15`.

### 2. Probe at startup (`src/renderer/App.tsx`)

A mount-time effect beside the existing `nvwarpAvailable` probe (`App.tsx:2011`), which is the same shape
and already proven:

```ts
audioAvailable: true | false | null   //  null = still probing, or the probe failed
```

Consumed via the generic bridge, `window.artlux.pluginInvoke('audio:available')`
(`src/preload/index.ts:135`), exactly as `plugins/ndi/src/ndiReceiver.ts:32` does.

### 3. The modal (`src/renderer/components/AudioEngineMissing.tsx`, new)

Built on the **`About.tsx` pattern** (`src/renderer/components/About.tsx:19-46`), which is the house style
for modals: blocking scrim (`fixed inset-0 z-modal bg-black/60`), `role="dialog" aria-modal="true"`,
dismissible by the **X**, **Escape**, or **clicking the backdrop**. Rendered alongside the other modals at
`App.tsx:2614`.

Copy is venue-first — it leads with the consequence, and demotes the build instruction to a second line,
because on a venue machine that instruction is useless:

> ### No audio engine
>
> ArtLux started without its audio engine. The app works normally, but **there will be no sound** — the
> audio bed, scene audio and the mixer are all disabled.
>
> *Expected `audio-engine.node` in the app's resources. If you are running from source, build it with
> `npm run build:audio`.*

**No "don't show again."** A warning that can be permanently silenced is how a machine ends up mute with
nobody knowing. It is dismissible per launch and returns on the next one.

### 4. The badge (`plugins/audio/src/AudioBedPanel.tsx`)

Because the modal is dismissible, the modal alone is not enough — the instant you close it the app looks
healthy again. So: an amber **`no audio engine`** badge in the Audio Bed panel header, in the same slot and
styling as the existing `show ended` badge (`AudioBedPanel.tsx:731-736`).

The panel already has a badge for the *other* way the bed goes silent-but-healthy-looking. This is the more
severe case and had none.

### 5. Retire the inference (`plugins/audio/src/AudioSettings.tsx:68`)

Replace `available = !error && !!device` with the real signal, via a shared `audioClient.available()`. The
badge and the settings line then read the same truth instead of two different guesses.

This is a targeted fix to the code the bug lives in, not unrelated refactoring: the inference *is* the root
cause.

---

## Decisions taken (and why)

| Decision | Rationale |
|---|---|
| Audio-only, not a general "missing natives" modal | There is **no shared missing-native registry** — it would have to be built. And `hap`, `output-engine` and `spout-receiver` are legitimately unbuilt in dev, so a general modal would fire every launch and be trained away within a week. Silence is undiagnosable in a way a missing Spout receiver is not. |
| Modal, not a toast | A toast (`UpdateNotice.tsx`) is easy to miss. Being missable is the bug. |
| Dismissible, never permanently | See above. Per-launch only. |
| Modal **and** badge | The badge is what makes a dismissible modal safe. |
| Host component, not a plugin modal panel | Plugin modal panels (`mount: 'modal'`) have **no programmatic open API** — they are opened only by a menu action (`packages/sdk/src/renderer.ts:263-267`). Self-opening at startup would require new host machinery. |

## Edge cases

- **Probe fails or rejects → show nothing.** The modal fires only on an explicit `false`. A false alarm
  here would be worse than the defect.
- **Probe once.** A native addon cannot appear mid-session; no polling.
- **Main window only.** There are four renderer entry points (`index.tsx`, `projector.tsx`,
  `headless.tsx`, `docs.tsx`); `App.tsx` mounts only from `index.tsx`. The modal cannot reach a projector
  output or the headless runner. *(Verified, not assumed.)*
- **The dev app will not reproduce this.** `native/audio-engine/audio_engine.node` is present, so both dev
  candidate paths in `audioManager.ts:63-64` resolve. To test in dev, rename those too — not just the
  packaged `resources/audio-engine.node`.

## Verification

This is a UI state that exists only when a file is absent, so it is verified by hand — which is exactly
**re-running acceptance test 0.3**:

1. Rename the addon away → launch → **modal appears**; closes on X / Escape / backdrop; **badge remains**.
2. Rename it back → launch → **neither appears**, and Settings ▸ Audio reports the engine active.
3. Session 0's gates re-run green (`tsc`, `npm run build`, `npm run build:audio`, `npm run verify:plugins`,
   `showclock-sim`) — we are touching the branch under acceptance.

Test 0.3 then passes as written, on its own terms.
