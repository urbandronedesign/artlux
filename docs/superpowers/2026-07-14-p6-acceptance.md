# P6 — Acceptance: multichannel audio hardening

Branch `p6-audio-multichannel` @ `4f76edc`. Tasks 1–8 landed and are `tsc`/`build`/`verify:plugins` clean; the
checkpoints below are the **manual, human-run** gates batched out of Tasks 2, 4, 6 and 8. None of them has
been run yet — every box is unchecked. This document is the checklist to run them, not a record that they
passed.

---

> ### ⚠ A SYNTHETIC PASS IS NOT A VENUE PASS.
> There is no multichannel hardware on this project (established at Wave-3 acceptance test 2.10). Every
> multichannel checkpoint below is to be run against a VIRTUAL 8-channel device or a built-in card switched
> to 7.1 Surround. Passing them will prove that the device opens with 8 discrete channels, that the
> ambisonic decode lands energy on the speaker index it claims, and that the patch routes it where it says.
>
> It will NOT prove: ASIO, real driver behaviour, real converter latency, or that eight physical speakers
> are wired the way the layout thinks they are. Those close on hardware, or they do not close — and until a
> venue pass runs, they stay open.

---

## Getting a synthetic 8-channel device (do this once, before Checkpoint 2)

Two ways, either is fine — the checklist below doesn't care which:

- **A virtual 8-channel driver** — e.g. a multi-channel ASIO/WDM loopback driver (VB-Audio's Voicemeeter/
  Hi-Fi Cable family, or any similar free virtual audio device that exposes 8 channels). Install it, and it
  shows up in the device list like any other card.
- **A built-in card switched to 7.1 Surround** — Windows ▸ Sound ▸ *your output device* ▸ Properties ▸
  Advanced ▸ format dropdown ▸ **"7.1 Surround, 16 bit, 48000 Hz"** (or similar). This makes WASAPI **Exclusive
  Mode** open the card with 8 discrete channels even if only two are physically wired to a speaker — the
  meters and the patch are what prove which channel is which; you don't need eight cabinets to prove the
  engine is putting the right energy on the right channel index.

Either way, this device is not a stand-in for a real 8-speaker rig — see the warning above. It only proves
the software plumbing.

---

## Checkpoint 1 — Machine ≠ show (Task 2)

*Confirms `AppSettings` no longer travels inside a `.artlux`, and that `reserveLockedRanges` migrated
without it.*

- [ ] **1.1 — a project does not repatch the machine.**
  **DO:** on this machine, set Preferences ▸ Audio to **binaural / 2 ch** and save a project (`A.artlux`).
  Now switch this machine's Preferences to **octagon / 8 ch** (a different device entry is fine too — the
  point is the *machine* config, not the file). Open `A.artlux`.
  **EXPECT:** Preferences ▸ Audio still says **octagon / 8 ch** — unchanged by the open. The project did not
  reconfigure the machine.
  **IF IT FAILS:** if opening `A.artlux` flips Preferences back to binaural/2 ch, the fix in `2b5684c` has
  regressed — `App.tsx`'s load path is reading `data.settings` again.

- [ ] **1.2 — the file itself carries no `settings` key.**
  **DO:** open `A.artlux` in a text editor (or the equivalent `project.artlux` inside a project folder).
  **EXPECT:** no top-level **`"settings"`** key anywhere in the JSON. `reserveLockedRanges` appears at the
  **top level of the document** (`ProjectData.reserveLockedRanges`), not nested under a `settings` object.
  **IF IT FAILS:** a `"settings"` key in a freshly-saved file means `buildProjectData()` is writing it again
  — that is the exact regression this task exists to prevent.

- [ ] **1.3 — a legacy project (pre-P6, still carrying `settings`) loads sanely.**
  **DO:** open a `.artlux` saved **before** this branch (one that still has the old `settings.reserveLockedRanges`
  shape).
  **EXPECT:** it loads without error or dialog. Its DMX patch policy (locked-range reservation) comes back
  exactly as authored — migrated silently from the legacy `settings.reserveLockedRanges` into the new
  top-level field. The machine's own audio/network config is **not** touched by the legacy file's `settings`
  block.
  **IF IT FAILS:** a patch-policy flip on load, or a crash, means `readPatchPolicy()`'s fallback to
  `data?.settings?.reserveLockedRanges` (see `src/renderer/types.ts`) isn't reading the old shape correctly.

---

## Checkpoint 2 — Device picker (Task 4)

*Confirms the driver-type grouping, that the panel reports what was opened rather than what was asked for,
and that switching devices live doesn't restart anything.*

- [ ] **2.1 — the dropdown is grouped by driver type, and the same device appears twice.**
  **DO:** open Preferences ▸ Audio ▸ Output device. Look for your synthetic 8-channel device (above).
  **EXPECT:** the list is grouped into `<optgroup>`s by driver type (e.g. **Windows Audio** / **Windows Audio
  (Exclusive Mode)** / any ASIO group present). The **same physical device** appears under more than one
  group.
  **IF IT FAILS:** a flat, ungrouped list, or the device appearing only once, means `deviceGroups` in
  `AudioSettings.tsx` isn't receiving distinct `type` values from `getDevices()`.

- [ ] **2.2 [THE HEADLINE] — picking it under Exclusive Mode with 8 ch actually opens 8 ch.**
  **DO:** pick the synthetic device **under the Exclusive Mode group**. Set **Output channels** to **8**,
  sample rate **48000**, buffer **256**.
  **EXPECT:** the **"Open:"** line under the picker reads **`8 ch · 48.0 kHz · 256 samples`** — not 2. If it
  reads fewer than 8, the device genuinely could not give you 8 discrete channels (try the other synthetic
  option above).
  **IF IT FAILS:** an "Open:" line stuck at 2 ch while set to Exclusive Mode with a device that supports 8
  means either the wrong driver-type group was picked, or `configure()` is silently falling back.

- [ ] **2.3 — switching device while a bed plays does not restart it.**
  **DO:** load a bed track, press Play. While it's audibly playing (or, with no real output, watching the
  meters move), switch the **Output device** to a different entry (e.g. from Exclusive Mode back to the
  plain Windows Audio group, or to `System default`).
  **EXPECT:** the bed's position does **not** jump back to 0 — sound (or the meter) picks up from wherever
  the transport already was, on the new device. No restart, no re-trigger.
  **IF IT FAILS:** if playback restarts from 0 on a device switch, `apply()`/`configure()` is tearing down
  and re-triggering clips instead of just re-opening the device under the running transport.

---

## Checkpoint 3 — Speaker check (Task 6) — THE ACCEPTANCE GATE

*This is the one that actually proves the ambisonic decode and the patch land on the right channel index.
If only one checkpoint in this document gets run, it is this one.*

- [ ] **3.1 — identify: hold Speaker 1, and ONLY meter 1 lights.**
  **DO:** Spatial output ▸ **Speaker layout** ▸ **Octagon (8, ring)**, on the 8-channel synthetic device from
  Checkpoint 2. Open the Meters block below Speaker check. **Hold** the **Speaker 1** button.
  **EXPECT:** meter **1** rises and **no other meter moves**. Release the button.
  **EXPECT:** **silence** — meter 1 (and every other meter) falls back to zero. No held tone survives a
  release.

- [ ] **3.2 — repatch Speaker 1 to Channel 5, and the meter follows the patch.**
  **DO:** on Speaker 1's row, change its channel dropdown from **Channel 1** to **Channel 5**. Hold **Speaker
  1** again.
  **EXPECT:** this time meter **5** lights, not meter 1. The patch — not the speaker's position in the layout
  — decides which device channel the tone (and, per Task 5, the decoded signal) comes out of.

- [ ] **3.3 — orbit a spatial clip and watch the energy walk the meters.**
  **DO:** with the patch reset to 1:1 (the **Reset to 1:1** button), load a spatial audio clip on the bed,
  tick **Spatial**, and drag its position around the top-down positioner in a full circle while the clip
  plays.
  **EXPECT:** the meters light up **in ring order** as the source orbits — energy moves from speaker to
  speaker following the position, not all speakers at once and not in a random order.
  **IF IT FAILS:** meters that don't move with position, or that all light together, mean the ambisonic
  decode isn't landing energy on the speaker index the layout claims — this is the thing the whole synthetic
  pass exists to prove, and it did not close.

- [ ] **3.4 — the stranded-tone check: a held tone must not survive an unmount mid-hold.**
  **DO:** **hold** **Octagon Speaker 1** (pointer down, don't release the mouse). While still holding, press
  **Tab** to move focus to **Binaural**, then click **Binaural** — or press **Space** — to switch spatial
  output mode **without ever releasing the mouse button** over the vanishing Speaker 1 button.
  **EXPECT:** the tone **stops** the instant the mode switches, even though no `pointerup` ever fired on the
  button (it unmounted out from under the pointer). This is the `e143338` fix (`useEffect` on
  `[mode, need, opened?.channels, cfg.deviceType, cfg.deviceName]` killing any held tone).
  **IF IT FAILS:** pink noise still audible (or the meter still lit) after the mode switch, with no button on
  screen to stop it, is a stranded tone in a live room — this is the specific defect Task 5b fixed; a
  regression here is a blocker.

---

## Checkpoint 4 — Headless (Task 8)

*Confirms headless boots the real audio path and opens the machine's actual configured layout — NOT that it
is audible. That is the one hardware check nobody has run yet.*

- [ ] **4.1 — headless opens the machine's configured layout, not a default.**
  **DO:** with Preferences ▸ Audio set to something distinctive (e.g. the octagon/8 ch synthetic device from
  above), run:
  ```
  npx electron . --headless --project=<a project with a bed track>.artlux
  ```
  **EXPECT:** the process starts with no window. Preferences' machine config (the device, channel count,
  layout) is what headless opens — check via the meters exposed over the same IPC surface the editor's
  Preferences panel reads, or a log line if one is added, or Task 8's own reasoning (the plugin host
  activates as `'main'` and the audio plugin opens the device on activation, identical to the editor).
  **EXPECT (the part nobody has confirmed):** the meters move / sound is audible on the configured layout.
  **IF IT FAILS, OR IF YOU CANNOT TELL:** this is expected to be incomplete. Say so — do not write "PASSED"
  here on the strength of the code path alone. See the note below.

  > ⚠ **This checkpoint has never been run.** Task 8's own report says so explicitly: Electron cannot launch
  > in the dev-agent environment (no display), so the wiring was verified **statically** — the dead
  > `HeadlessRunner` fork's removal was proven safe by a clean `tsc`/`build`/`verify:plugins` and the absence
  > of any surviving reference to the deleted files, and the live `HEADLESS` branch in `src/main/index.ts` was
  > read to confirm it boots the full `App` with `?headless=1` (the same entry `--broadcast` uses, which is
  > known to make sound). **None of that is an audible test.** The plan doc's "Verified in P6" claim was
  > corrected to "wired, not verified" in `4f76edc` for exactly this reason — carry the same honesty into this
  > checkpoint. Whoever runs this session for the first time should update this row with what they actually
  > heard, not with a checkmark on the strength of the reasoning above.

---

## What this document does and does not close

**Closes (once run):** that the device-selection UI can put a virtual/switched-format 8-channel interface
into WASAPI Exclusive Mode and report its real channel count; that the ambisonic decoder and the speaker
patch correctly address each of those 8 channels by index; that a device switch and a mode switch don't
strand a tone or restart a running bed; that a project file no longer overwrites the machine's audio/network
configuration; that headless boots the code path that is supposed to make sound.

**Does not close, and cannot close without hardware:** ASIO (off by default, unbuilt, untested — see
[DEVELOPMENT.md → ASIO (optional)](../DEVELOPMENT.md#asio-optional)); real audio-interface driver behaviour
(buffer underruns, clock drift, exclusive-mode contention with other apps); real D/A converter latency; and
— the one no synthetic device can ever answer — **whether eight physical speakers are wired into the room
the way the layout thinks they are.** A synthetic pass proves the software. A venue pass proves the room.
They are not the same claim, and this document only makes the first one.
