# The audio device open blocks the main process for ~6 seconds

> **Status:** ☑ **PART BUILT 2026-09-06** (`c27c15b`) — the redundant device open is gone: 7.8 s → 0.7 s
> end to end. What remains is the driver's own ~5.2 s WASAPI-shared open, which only a device-type
> change avoids. Previously: 🔎 **MEASURED, NOT BUILT** (sub-steps measured 2026-09-06; the surrounding two defects
> fixed 2026-09-05 on `main@be7c34b`). The two defects that
> *surrounded* this one are fixed and shipped in the v0.26.6 re-cut; this is what is left.
> **Placement:** `native/audio-engine` + `plugins/audio` (main half only) · **Risk:** 🔴 high — the JS
> surface is one line, the hazard is JUCE's threading contract and ASIO drivers we do not own. ·
> **Tracked:** [#6](https://github.com/urbandronedesign/artlux/issues/6)

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

## MEASURED 2026-09-06 — it is the device open, and nothing else

The sub-steps were timed inside `Engine::configure` (temporary `fprintf`s, reverted). Everything below
is on this machine, built addon, Realtek onboard audio.

```
[cfg-steps] close=0ms initialise=5471ms setType=0ms(skipped) setSetup=390ms TOTAL=5861ms
            (type='Windows Audio' name='Haut-parleurs (Realtek(R) Audio)' ch=2)
```

**93% of it is `deviceManager.initialise()`** — but *not* for the reason this plan first guessed.
`initialise(0, ch, nullptr, true)` does not only build the device-type list: it **opens the default
device**. Three hypotheses were tested and all three are dead:

| hypothesis | test | result |
|---|---|---|
| ASIO driver enumeration | rebuilt with `ARTLUX_ASIO=0` | `initialise` still **5368–5559 ms**. ❌ |
| device-type scanning | timed `scanForDevices()` per type | **39 ms for all five** (WASAPI shared 6 · exclusive 6 · lowLatency 4 · DirectSound 12 · ASIO 11). ❌ |
| a one-time process warm-up | opened the same device repeatedly | **every** open costs it. ❌ |
| a redundant open (`initialise` *and* `setCurrentAudioDeviceType(.., true)` each open before ours) | prototype: scan only, set the type with `false`, one open | 5,939 ms → **5,570 ms**. The cost simply moved into the single remaining open. **Worth ~370 ms (6%).** ❌ |

**It is one `IAudioClient` open of this endpoint in WASAPI *shared* mode, and it costs ~5.5 s.**

## …and the same speakers open in a third of a second on another type

Every device type, opening the **same** Realtek endpoint, fresh process, two passes:

| device type | total | of which the open |
|---|---|---|
| **Windows Audio** (WASAPI shared) | **5,894 ms** | 5,406 ms |
| Windows Audio (Low Latency Mode) | 5,902 ms | 5,448 ms |
| Windows Audio (Exclusive Mode) | 1,238 ms | 988 ms |
| DirectSound — *Périphérique audio principal* | 837 ms | 349 ms |
| DirectSound — *Haut-parleurs (Realtek)* | **374 ms** | — |
| **ASIO — Realtek ASIO** | **412 ms** | 294 ms |

So the pathology is **WASAPI shared mode on this Realtek driver**, not JUCE, not ArtLux, and not the
scan. ASIO opens the same speakers **14× faster**.

⚠ **This is a settings answer before it is a code answer.** On this machine, switching
**Preferences ▸ Audio ▸ device type** from *Windows Audio* to *ASIO* (or DirectSound) should take ~5.5 s
off every cold start, with no code change at all. That has **not** been tried end-to-end in the app yet —
only the device open was timed — and ASIO is exclusive-access, so it changes who else can make sound on
the machine. Worth trying before anything is built.

## Option A — restrict the device scan — **DEAD**

The scan is 39 ms. Restricting it saves nothing. Struck out on its own evidence.

`getDevices()` was measured at the same time and is **74 ms cold / 25 ms warm** — so the suspected
*Preferences ▸ Audio* freeze is **not** real either. Both hypotheses in the first draft of this plan were
wrong.

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

**Nothing in our code can make the wait itself shorter** — Option A is dead and the redundant
open is worth 370 ms. Only choosing a different device type does that, and that is the
operator's setting, not a change to make for them.

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

## BUILT 2026-09-06 — the redundant open (`c27c15b`)

The measurement above was taken with *Windows Audio* selected, which is the one configuration where this
bug is invisible: `initialise` happens to open the very device we wanted, so removing it saves ~370 ms.
With **ASIO** selected — which is what the machine was actually set to — the app opened the WASAPI
default first at full price, discarded it, and then opened ASIO:

| | as shipped | fixed |
|---|---|---|
| ASIO selected | initialise 5471 + switch 1817 + open 54 = **7342 ms** | 62 + 288 + 53 = **403 ms** |
| Windows Audio selected | 5409 + 0 + 344 = **5753 ms** | 64 + 0 + 5171 = **5235 ms** |
| **cold open, 10-scene project, 3 runs** | **7806 ms** | **707 ms** |

`initialise(0, ch, nullptr, true)` is replaced by `getAvailableDeviceTypes()` — the scan, without the
open. The `true` was `selectDefaultDeviceOnFailure`, and two things had been relying on it silently;
both are now explicit and tested (a named device that will not open still leaves the default live; an
empty device name really opens the default instead of reporting success over nothing). Guarded by
invariant #156.

**So the earlier conclusion here — "nothing in our code can make the wait shorter" — was wrong**, and
wrong because it was measured in the single configuration that hides the defect. That is the fifth time
in this investigation that a confident answer did not survive a second configuration.

## Open questions

1. ~~Which sub-step costs the 5.7 s?~~ **Answered twice.** A WASAPI *shared-mode* open of the Realtek
   endpoint really does cost ~5.2 s — but the app was ALSO opening a device nobody asked for, worth up
   to 7 s on its own. That half is fixed (`c27c15b`); the driver's half is not ours.
2. ~~Does switching the device type fix the cold start end to end?~~ **Answered: on the shipped build it
   made things WORSE** (ASIO 7.3 s vs Windows Audio 5.8 s), because it added a device-type switch on top
   of the wasted default open. With `c27c15b` in, ASIO is now the fast path: **0.4 s** against 5.2 s.
   DirectSound is fast to open but meters silent on this machine, on the pre-change build too —
   pre-existing, uninvestigated, and a reason not to recommend it.
3. Is ~5.5 s particular to this Realtek driver? Almost certainly — a WASAPI shared open is normally tens
   of milliseconds — but it is unmeasured on any other machine, and the venue PC is the one that counts.
4. If Option B lands, does the boot gate grow a "device open" probe — keeping the guarantee and the 6 s —
   or not? A show-behaviour decision, not a technical one.

## What changed in this plan, and why that matters

The first draft named two hypotheses with confidence — ASIO enumeration and "restrict the scan" — and
**both were wrong**, along with a third (redundant opens) that is worth 6%. Every one of them was
plausible from the code and none survived a timer. That is the fourth time in this investigation that
reading the code produced a confident wrong answer; see the method notes above.
