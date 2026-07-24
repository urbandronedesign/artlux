# A Missing Audio Engine Must Announce Itself — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When ArtLux starts without its native audio engine, say so — with a dismissible startup modal and a persistent badge — instead of drawing a healthy mixer over a silent room.

**Architecture:** Add one truthful signal (`audio:available` over the plugin IPC bridge) and give it three consumers: a startup modal in the host, a badge in the Audio Bed panel, and the Settings line that currently *guesses* at availability. Every piece mirrors code that already exists — `calib:available` / `ndi:available` for the IPC probe, `About.tsx` for the modal, the `show ended` badge for the badge.

**Tech Stack:** Electron 42, React 19, TypeScript, Tailwind, the ArtLux plugin SDK (`packages/sdk`).

**Spec:** `docs/superpowers/specs/2026-07-13-audio-engine-missing-notice-design.md`

## Global Constraints

- **Branch:** `wave-3-audio`. This branch is under acceptance test; Session 0's gates must be re-run at the end (Task 4).
- **No "don't show again."** The modal is dismissible per launch only. Never persist a dismissal. A permanently silenced warning is how a machine ends up mute with nobody knowing.
- **No false alarms.** The modal fires **only** on an explicit `false` from the probe. A probe that rejects, times out, or never resolves must show nothing.
- **Probe once, on mount.** A native addon cannot appear mid-session. No polling.
- **Main window only.** `App.tsx` mounts only from `src/renderer/index.tsx`. Do not add this to `projector.tsx`, `headless.tsx` or `docs.tsx`.
- **Copy is venue-first.** Lead with the consequence ("there will be no sound"), demote the build command to a secondary line. On a venue machine `npm run build:audio` is useless advice.
- **There is no unit-test framework in this repo.** `package.json` has no `test` script. Verification is `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `npm run verify:plugins`, and the manual acceptance script. Do not add a test framework — that is a separate decision, not part of this fix.
- **The dev app cannot reproduce the bug by default.** `native/audio-engine/audio_engine.node` is present, so both dev candidate paths in `audioManager.ts:63-64` resolve. To see the modal in dev you must rename those files too, not just the packaged `resources/audio-engine.node`.

---

### Task 1: Expose the truth — `audio:available`

The renderer currently cannot ask whether the engine loaded. `audioManager.ts:77` exports `available = !!native` and **nothing consumes it**. This task makes it askable. It is the foundation for all three consumers.

**Files:**
- Modify: `plugins/audio/src/plugin.main.ts` (add one handler beside the existing `audio:*` reply channels, ~line 22)
- Modify: `plugins/audio/src/audioClient.ts` (add one client method, ~line 20)

**Interfaces:**
- Consumes: `engine.available` — already exported at `plugins/audio/src/audioManager.ts:77` as `export const available = !!native`. `plugin.main.ts:8` is already a value import (`import * as engine from './audioManager'`), so no new import is needed.
- Produces:
  - IPC channel **`audio:available`** → `boolean`. Reachable from any renderer as `window.artlux.pluginInvoke('audio:available')` (the generic bridge namespaces it to `plugin:audio:available` — `src/preload/index.ts:135`).
  - **`audioClient.available(): Promise<boolean>`** — used by Tasks 3a and 3b.

- [ ] **Step 1: Add the main-process handler**

In `plugins/audio/src/plugin.main.ts`, immediately after the `audio:getMeters` handler (currently line 23), add:

```ts
    // Is the native engine actually loaded? `available` was exported and unconsumed — the renderer had to
    // INFER unavailability from configure() returning an empty device name. Mirrors calib:available and
    // ndi:available. A missing engine is silent by construction; this is the only way to see it.
    ipc.handle('audio:available', () => engine.available);
```

- [ ] **Step 2: Add the renderer client method**

In `plugins/audio/src/audioClient.ts`, inside the `audioClient` object, immediately after `getMeters` (currently ends line 20), add:

```ts
  // Resolves false when the native addon is absent (or the bridge is dead — which also means no sound).
  // Consumers must not raise an alarm on a REJECTION: see the no-false-alarms rule in the plan.
  available: (): Promise<boolean> =>
    (ipc?.invoke('audio:available') as Promise<boolean>) ?? Promise.resolve(false),
```

- [ ] **Step 3: Typecheck and verify the channel ships**

```bash
npx tsc -p tsconfig.json --noEmit
npm run build
npm run verify:plugins
```
Expected: all three exit 0.

- [ ] **Step 4: Prove the channel actually exists in the built bundle**

```bash
git grep -n "audio:available" -- plugins/audio/
```
Expected: exactly two hits — the handler in `plugin.main.ts` and the client in `audioClient.ts`.

- [ ] **Step 5: Commit**

```bash
git add plugins/audio/src/plugin.main.ts plugins/audio/src/audioClient.ts
git commit -m "feat(audio): the renderer can ASK whether the engine loaded

audioManager exported `available` and nothing consumed it. The UI inferred a dead
engine from configure() returning an empty device string — a guess derived from a
side effect. Mirrors calib:available / ndi:available."
```

---

### Task 2: The startup modal

**Files:**
- Create: `src/renderer/components/AudioEngineMissing.tsx`
- Modify: `src/renderer/App.tsx` (import; two state hooks near line 179; one probe effect near line 2011; one render near line 2615)

**Interfaces:**
- Consumes: the `audio:available` IPC channel from Task 1, via `window.artlux.pluginInvoke('audio:available')`. (The host must **not** import `audioClient` — that is plugin-internal.)
- Produces: `<AudioEngineMissing open={boolean} onClose={() => void} />`.

- [ ] **Step 1: Create the modal component**

Create `src/renderer/components/AudioEngineMissing.tsx`. This mirrors `About.tsx:19-48` — the house modal pattern: blocking scrim, `role="dialog"`, draggable header, dismissible by X / Escape / backdrop.

```tsx
import React, { useEffect } from 'react';
import { X, VolumeX } from 'lucide-react';
import { useDraggableModal } from '../hooks/useDraggableModal';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Shown at startup when the native audio engine did not load. The app graceful-degrades PERFECTLY —
// no crash, the audio UI renders, every engine call no-ops — which is exactly the problem: it draws a
// healthy mixer over a silent room. Wave 3 acceptance test 0.3.
//
// Dismissible, and deliberately NOT permanently silenceable: a warning you can switch off forever is how
// a venue machine ends up mute with nobody knowing. Closing it leaves the `no audio engine` badge in the
// Audio Bed panel, so the app never LOOKS healthy while it is mute.
export const AudioEngineMissing: React.FC<Props> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { positionerStyle, handleProps } = useDraggableModal('audio-engine-missing');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div style={positionerStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="No audio engine"
        className="w-[420px] bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...handleProps} className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 cursor-move select-none">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warn uppercase tracking-wider">
            <VolumeX size={14} /> No audio engine
          </span>
          <button onClick={onClose} aria-label="Close" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>

        <div className="p-5">
          <p className="text-xs text-fg-1 leading-relaxed">
            ArtLux started without its audio engine. The app works normally, but{' '}
            <strong className="text-warn">there will be no sound</strong> — the audio bed, scene audio and
            the mixer are all disabled.
          </p>
          <p className="mt-3 text-micro text-fg-3 leading-relaxed">
            Expected <span className="num">audio-engine.node</span> in the app’s resources. If you are
            running from source, build it with <span className="num">npm run build:audio</span>.
          </p>
        </div>
      </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Import it in App.tsx**

In `src/renderer/App.tsx`, beside the existing `About` import, add:

```tsx
import { AudioEngineMissing } from './components/AudioEngineMissing';
```

- [ ] **Step 3: Add the state**

In `src/renderer/App.tsx`, next to `const [aboutOpen, setAboutOpen] = useState(false);` (~line 179), add:

```tsx
  // null = not probed yet (or the probe failed). ONLY an explicit false raises the alarm — a false alarm
  // here would be worse than the defect it reports.
  const [audioAvailable, setAudioAvailable] = useState<boolean | null>(null);
  const [audioWarnDismissed, setAudioWarnDismissed] = useState(false);
```

- [ ] **Step 4: Probe on mount**

In `src/renderer/App.tsx`, immediately after the NVAPI probe (currently line 2011), add:

```tsx
  // The native audio engine graceful-degrades into perfect silence, so nothing else in the app announces
  // its absence. Probe once — an addon cannot appear mid-session. On rejection we stay `null` and say
  // NOTHING (no false alarms). Wave 3 acceptance test 0.3.
  useEffect(() => {
    window.artlux?.pluginInvoke?.('audio:available')
      .then((v) => setAudioAvailable(!!v))
      .catch(() => {});
  }, []);
```

- [ ] **Step 5: Render it**

In `src/renderer/App.tsx`, immediately after the `<About …/>` line (currently line 2615), add:

```tsx
      <AudioEngineMissing
          open={audioAvailable === false && !audioWarnDismissed}
          onClose={() => setAudioWarnDismissed(true)}
      />
```

- [ ] **Step 6: Typecheck and build**

```bash
npx tsc -p tsconfig.json --noEmit
npm run build
```
Expected: both exit 0.

- [ ] **Step 7: See it fire (this is the real test)**

The dev app has the addon on disk, so you must hide it:

```bash
mv native/audio-engine/audio_engine.node native/audio-engine/audio_engine.node.bak
mv native/audio-engine/build/Release/audio_engine.node native/audio-engine/build/Release/audio_engine.node.bak
npm run dev
```
Expected: the modal appears at startup. It closes on the **X**, on **Escape**, and on **clicking the backdrop**. The app is fully usable afterwards.

Then restore — **do not skip this**:
```bash
mv native/audio-engine/audio_engine.node.bak native/audio-engine/audio_engine.node
mv native/audio-engine/build/Release/audio_engine.node.bak native/audio-engine/build/Release/audio_engine.node
```
Relaunch `npm run dev`: the modal must **not** appear.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/AudioEngineMissing.tsx src/renderer/App.tsx
git commit -m "feat(audio): say it out loud when there is no audio engine

The degrade was perfect and silent: no crash, audio UI renders, every call a no-op —
a healthy-looking mixer over a silent room. A startup modal now says so. Dismissible
per launch, never permanently: a warning you can switch off forever is how a machine
ends up mute with nobody knowing."
```

---

### Task 3: The badge, and retiring the inference

The modal is dismissible, so the instant you close it the app looks healthy again. The badge is what makes a dismissible modal safe. In the same pass we delete the guess that caused all this.

**Files:**
- Modify: `plugins/audio/src/AudioBedPanel.tsx` (a state hook near line 345; a badge beside the `show ended` badge at line 804-809)
- Modify: `plugins/audio/src/AudioSettings.tsx` (a state hook near line 33; the `available` expression at line 68)

**Interfaces:**
- Consumes: `audioClient.available(): Promise<boolean>` from Task 1.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Probe availability in the Audio Bed panel**

`AudioBedPanel.tsx` already imports `audioClient` (it drives the engine). Near the other panel state (after `const tlRef = useRef<TlAudio>(tlAudio);`, ~line 350), add:

```tsx
  // Defaults TRUE so a badge never flashes during the probe. Only an explicit false lights it.
  const [engineUp, setEngineUp] = useState(true);
  useEffect(() => { audioClient.available().then(setEngineUp).catch(() => {}); }, []);
```

- [ ] **Step 2: Add the badge**

In `AudioBedPanel.tsx`, immediately after the `show ended` badge block (currently closes at line 809, inside the same transport `<div>`), add:

```tsx
            {/* The OTHER way this panel goes silent-but-healthy-looking, and the worse one: there is no
                engine at all. `show ended` has a badge; a dead engine had nothing, and the mixer drew a
                full, working-looking UI over a silent room. Wave 3 acceptance test 0.3. */}
            {!engineUp && (
              <span className="shrink-0 px-1.5 h-5 inline-flex items-center rounded bg-warn/15 text-warn text-micro whitespace-nowrap"
                title="ArtLux started without its audio engine — there is no sound. Authoring and saving still work normally. Expected audio-engine.node in the app's resources; from source, run npm run build:audio.">
                no audio engine
              </span>
            )}
```

- [ ] **Step 3: Retire the inference in Settings**

In `plugins/audio/src/AudioSettings.tsx`, after `const [error, setError] = useState<string | null>(null);` (line 33), add:

```tsx
  // The REAL signal. This used to be inferred from configure() returning an empty device name — a guess
  // derived from a side effect, and the reason a dead engine was never surfaced anywhere else.
  const [engineUp, setEngineUp] = useState(true);
  useEffect(() => { audioClient.available().then(setEngineUp).catch(() => {}); }, []);
```

Then replace line 68 exactly:

```tsx
  const available = !error && !!device;
```

with:

```tsx
  const available = engineUp && !error;
```

- [ ] **Step 4: Typecheck, build, verify plugins**

```bash
npx tsc -p tsconfig.json --noEmit
npm run build
npm run verify:plugins
```
Expected: all three exit 0.

- [ ] **Step 5: See the badge (rename the addon away again)**

```bash
mv native/audio-engine/audio_engine.node native/audio-engine/audio_engine.node.bak
mv native/audio-engine/build/Release/audio_engine.node native/audio-engine/build/Release/audio_engine.node.bak
npm run dev
```
Expected: the modal appears. **Close it.** Open **View ▸ Audio Bed…** — the amber **`no audio engine`** badge is in the header, beside where `show ended` would go. Open **Settings ▸ Audio** — it still reads `Audio engine unavailable. Playback is disabled.`

Restore:
```bash
mv native/audio-engine/audio_engine.node.bak native/audio-engine/audio_engine.node
mv native/audio-engine/build/Release/audio_engine.node.bak native/audio-engine/build/Release/audio_engine.node
```
Relaunch: **no modal, no badge**, and Settings ▸ Audio reports the engine active with its device name.

- [ ] **Step 6: Commit**

```bash
git add plugins/audio/src/AudioBedPanel.tsx plugins/audio/src/AudioSettings.tsx
git commit -m "feat(audio): the mixer must not look healthy while the room is silent

A dismissible modal alone is not enough — close it and the panel looks fine again.
An amber `no audio engine` badge now sits where `show ended` sits: the panel already
had a badge for the OTHER way the bed goes silent-but-healthy-looking.

Settings now reads the real signal instead of inferring a dead engine from an empty
device string. That inference WAS the root cause."
```

---

### Task 4: Re-run the acceptance gates

We have touched a branch that is mid-acceptance. Session 0 must be green again, and test 0.3 — the test that found this — must now pass on its own terms.

**Files:** none modified. This task is verification only.

- [ ] **Step 1: Re-run Session 0.1 with the app CLOSED**

A running app locks `audio_engine.node`; the link fails with `LNK1104` and **silently leaves the stale addon in place**, so a working fix looks broken. Close ArtLux first.

```bash
npx tsc -p tsconfig.json --noEmit
npm run build
npm run build:audio
npm run verify:plugins
node scratch/showclock-sim.mjs
```
Expected: every command exits 0; `showclock-sim` prints **99/99 assertions PASS**.

- [ ] **Step 2: Re-run the 0.4 source gates**

```bash
git grep -n "text-\[[0-9]" -- src/renderer/components/timeline/ plugins/audio/
git grep -n "transport: 'preserve'" -- src/ plugins/
git grep -n "getStatus().playhead" -- plugins/audio/
git grep -n "'audio'" -- src/renderer/services/automationTargets.core.ts
```
Expected: every one prints **nothing**.

*(Note: the acceptance script's gates for `transport: 'preserve'` and `only ever one running transport` are written without path scoping and therefore match the script's own text in `docs/`. They are scoped to `src/ plugins/` here. Its `prevPlayhead` gate is stale — that variable is now load-bearing, carrying the BOUND timeline's own seek test, which is what keeps a scene's audio riding the playhead while the bed rides the show clock. See `plugins/audio/src/plugin.renderer.ts:675-687`.)*

- [ ] **Step 3: Re-run acceptance test 0.3 against the PACKAGED app**

```bash
npm run package
```
Then in `release/win-unpacked/resources/`, rename `audio-engine.node` → `audio-engine.node.bak`, and run `release/win-unpacked/ArtLux.exe`.

Expected — all four, which is 0.3 as written:
1. the app **starts**, no crash
2. the audio UI **renders**
3. a **visible notice** — the modal, at startup, unmissable
4. after closing it, the **`no audio engine`** badge persists in the Audio Bed panel

Rename `audio-engine.node.bak` back, relaunch, and confirm **sound works and neither warning appears**.

- [ ] **Step 4: Tick 0.3 in the acceptance script**

In `docs/superpowers/2026-07-12-wave-3-acceptance.md`, mark check **0.3** as passing and note that the notice is now a startup modal plus a persistent badge, not a line buried in Settings.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/2026-07-12-wave-3-acceptance.md
git commit -m "docs: acceptance 0.3 passes — the dead engine now announces itself"
```
