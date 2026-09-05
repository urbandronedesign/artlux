# The audio device open blocks the main process for ~6 seconds

> **Status:** 🔎 **INVESTIGATED, NOT BUILT** (2026-09-05, on `main@be7c34b`). The two defects that
> *surrounded* this one are fixed and shipped in the v0.26.6 re-cut; this is what is left.
> **Placement:** `native/audio-engine` + `plugins/audio` (main half only) · **Risk:** 🔴 high — the JS
> surface is one line, the hazard is JUCE's threading contract and ASIO drivers we do not own.

Not a limitation-lift plan and it carries no §1–§10 template. It is the record of a measurement, the
options it leaves open, and the question that has to be answered before any of them is worth starting.

## The measurement

Cold open of a 2-scene / 4-mp4 / 8 MB project (`--headless --project=`, **built** app), CPU profile of
the **main process** over 18 s via the Node inspector:

```
=== MAIN CPU PROFILE — 18.0s wall, heaviest SELF time ===
 10967 ms  configure   main/index.js:4953        ← audioManager.configure → native.configure
  6422 ms  (idle)
    58 ms  internalModuleStat
```

`configure` is `native.configure()` — a **synchronous** `Napi::Function`
([engine.cpp:1127](../native/audio-engine/src/engine.cpp#L1127)) that runs `Engine::configure`
([engine.cpp:807](../native/audio-engine/src/engine.cpp#L807)) on the calling thread, which is main's JS
thread. **Nothing else in main came within 60 ms of it.**

Two calls of ~5.7 s each, since fixed to one (`75d66b5` — the first was against `DEFAULT_SETTINGS`). One
remains, and while it runs **main serves nothing**: no byte over `artlux-media://`, no prefs read, no
audio conform, no metrics scrape, no tablet request, no watchdog reply. Measured with an event-loop lag
probe in main, and corroborated from the renderer — an mp4 `open()` reported `fetch=5460ms` for a 1.6 MB
local file that takes **29–51 ms** once main is free.

| | before both fixes | after (`d96edf7` + `75d66b5`) |
|---|---|---|
| `configure` self time on main | 10,967 ms (two calls) | **5,921 ms (one call)** |
| main idle over 18 s | 6,422 ms | **11,460 ms** |
| project opens at (page time) | 6.1 s | **0.5 s** |
| show ready at (page time) | 21.1 s | **6.5 s** |

The remaining 6.5 s is essentially this one call.

## What is NOT known, and it decides everything

**Which sub-step costs the 5.7 s has never been measured.** `Engine::configure` does, in order:

1. `deviceManager.initialise(0, ch, nullptr, true)` — **first call only**, guarded by `initialised`
   ([engine.cpp:882](../native/audio-engine/src/engine.cpp#L882)). Enumerates *every* device type. On
   Windows that is ASIO (loading each installed driver DLL), WASAPI shared **and** exclusive, and
   DirectSound.
2. `setCurrentAudioDeviceType(type, true)` when the type differs — re-scans that type.
3. `setAudioDeviceSetup(setup, true)` — the actual open.

The second of the two original calls **skipped step 1** (already initialised) and still took 5.6 s, so
the cost is *not* only first-time enumeration. It is either the type re-scan, the open itself, or both.

⚠ **This machine has `Realtek ASIO` installed** (`HKLM\SOFTWARE\ASIO`), and this build ships
`JUCE_ASIO=1` (`native/audio-engine/CMakeLists.txt:124` — ASIO ships by default on Windows). ASIO
enumeration loading a driver DLL is a live hypothesis for a multi-second scan and is trivially testable.

**Start here: a handful of timing lines inside `Engine::configure`.** Zero risk, and it decides whether
the fix is a small scan restriction or a thread relocation. Do not start with the thread.

## Option A — restrict the scan (small, safe, maybe sufficient)

If the cost is enumeration, do not scan what this app cannot use. JUCE lets you add only the device types
you want before `initialise`, so ASIO/DirectSound need not be probed to open a WASAPI device.

Also fixes something **suspected but not measured**: `getDevices()` is the same synchronous enumeration
([engine.cpp:1165](../native/audio-engine/src/engine.cpp#L1165)) and `AudioSettings.tsx` calls it twice on
mount (lines 166, 171) — so opening **Preferences ▸ Audio** very likely freezes main the same way.

Cost: contained inside the addon. No JS change at all.

## Option B — move the call off main's thread (the one this is named for)

### It is not a breaking change to any contract

- `audio:configure` is `ipc.handle` ([plugin.main.ts:28](../plugins/audio/src/plugin.main.ts#L28)), so the
  renderer **already awaits a Promise** through `ipc.invoke`. Nothing renderer-side changes.
- The SDK does not expose `configure` — it lives entirely inside the audio plugin.
- Exactly **one** call site in main. No project-file, prefs or persisted-format change.
- Keep the promise resolving *when the device is actually open* and every caller — including
  `AudioSettings.tsx`'s apply, which reads back the opened device name — behaves identically.

### Two behaviours that must be designed, not discovered

- **Re-entrancy.** Today two configures cannot overlap because the call blocks. Off-thread they can (an
  operator changing device mid-open), so they need queueing.
- **The device is no longer open when the call site's next line runs.** Only matters inside the engine,
  but it is the thing to audit.

### The real hazard is JUCE, not JavaScript

`juce::MessageManager::getInstance()` is created **on the JS thread** at addon init
([engine.cpp:1424](../native/audio-engine/src/engine.cpp#L1424)) — so the Node main thread *is* JUCE's
message thread. `AudioDeviceManager::initialise` and `setAudioDeviceSetup` expect to run there, and the
Windows backends enumerate over COM. A `Napi::AsyncWorker` pool thread is a different COM apartment, and
**ASIO drivers are apartment- and thread-sensitive**. That version works on this laptop and fails on a
venue's interface, at the worst possible moment.

So the safe shape of Option B is **not** an AsyncWorker: it is a dedicated long-lived thread that owns
JUCE's `MessageManager` and the `AudioDeviceManager` for the process's life, with every device call
marshalled to it. Bigger, and the only one that respects the contract.

## What the gain actually is — and it is not the obvious one

| | now | Option B |
|---|---|---|
| project open, media served, UI + metrics + tablet + watchdog alive | 6.5 s | **~0.5 s** |
| show **ready to start**, audio guaranteed | 6.5 s | **~6.5 s — unchanged** |
| show ready, accepting silence at the top | 6.5 s | ~0.6 s |

**The middle row is the catch.** If the boot gate keeps the promise it exists to make — sound is ready
before the show starts — it simply waits on the device instead of on a blocked main process. Option B
**moves the wait, it does not remove it.** What it buys is that nothing else is held hostage: the editor,
the project, the pictures, the tablet server and the watchdog all come alive at ~0.5 s.

Only Option A can make the wait itself shorter.

One thing that helps either way: `loadClip` does **not** need the device open
([engine.cpp:1002](../native/audio-engine/src/engine.cpp#L1002)) — it builds a reader and an
`AudioTransportSource`; preparation happens when the device opens. So clips keep loading during the wait
and any silence is bounded by the device open alone.

## Method notes worth keeping

- **Four successive "the cost is X" answers were wrong** — the mp4 demux (it is 1–4 ms), then the fetch,
  then main-side plugin IPC (no handler exceeded 150 ms). Only a **CPU profile of the main process** named
  it, in one line. Reach for the profiler earlier: main is a Node inspector target over `--inspect`, and
  `ws` is already in `node_modules`.
- **A CDP poller measuring a busy renderer lies by omission.** 5.5 s of samples simply did not exist and
  the plateau read as "11.7 s of startup before the project loads", which was wrong by 5.9 s. The recorder
  has to live *in the page*, where it competes with the app's own poll on equal terms.
- **Two harness log filters silently hid the answer they were built to surface.** A log line you cannot
  see reads exactly like a log line that never fired.

## Open questions

1. Which sub-step costs the 5.7 s? (**Do this first.**)
2. Is 5.7 s particular to this Realtek device, or normal? Unmeasured on any other machine.
3. Does `getDevices()` freeze main when Preferences ▸ Audio mounts? Suspected, never measured.
4. If Option B lands, does the boot gate grow a "device open" probe (keeping the guarantee, keeping the
   6 s) or not (starting at 0.6 s with a silent opening)? That is a show-behaviour decision, not a
   technical one.
