# Installing ArtLux on a real machine

Step-by-step for the two cases that actually happen: the **build machine** (which usually already has an
older ArtLux on it) and a **venue / show PC** getting its first install. Plus how to prove the install is
good, because that is the part that historically went wrong.

> **Why this document exists.** Every native module in ArtLux degrades gracefully: a missing runtime logs
> one line to the main-process console, disables its feature, and never crashes. A packaged app has no
> visible console, so a half-provisioned machine looks *identical* to a working one until someone reaches
> for NDI or calibration mid-show. Installing on a second machine produced exactly that — an app with no
> NDI and no projector calibration, silently. The installer now provisions the machine itself, and
> `scripts/preflight.ps1` makes the result inspectable.
>
> Background on the packaging side: [DEVELOPMENT.md → Fresh-machine setup](DEVELOPMENT.md#fresh-machine-setup--the-preflight-and-what-the-installer-provisions).

---

## Where to download

Every link here is permanent and always resolves to the newest build, so a bookmark or a note pinned
in a venue does not go stale:

| | Download |
|---|---|
| **Launcher** (recommended for a venue PC) | [`ArtLuxLauncher-Setup-x64.exe`](https://github.com/urbandronedesign/artlux/releases/download/launcher-latest/ArtLuxLauncher-Setup-x64.exe) |
| ArtLux — Windows | [`ArtLux-Setup-x64.exe`](https://github.com/urbandronedesign/artlux/releases/latest/download/ArtLux-Setup-x64.exe) |
| ArtLux — macOS (Apple Silicon) | [`ArtLux-arm64.dmg`](https://github.com/urbandronedesign/artlux/releases/latest/download/ArtLux-arm64.dmg) |
| ArtLux — Linux | [`ArtLux-x86_64.AppImage`](https://github.com/urbandronedesign/artlux/releases/latest/download/ArtLux-x86_64.AppImage) |

These are fixed-name copies published beside the versioned assets, not replacements for them. The
versioned files — `ArtLux-<version>-x64.exe` and the rest — are what you go to
[the releases page](https://github.com/urbandronedesign/artlux/releases) for: a specific build, or
putting a machine back on the version it was running last week.

**The three most recent versions stay installable there**; older ones are retired to drafts by CI so
the list stays short. Retired is not deleted — the assets and the notes are intact, the git tag never
moves, and any of them can be restored on request. If you need a version older than the three on the
page, ask rather than assuming it is gone.

> **A file downloaded from those links names no version**, so nothing can read the release off its
> filename. `scripts/verify-download.ps1` handles that by resolving the newest release itself
> (below) — but it means the check has one extra failure mode worth knowing: if a release is
> published *while* you are downloading, you will be comparing one build against the next one's
> checksum. The script says so when it happens instead of reporting a bare mismatch.

---

## What the installer does for you

Run elevated (`nsis.perMachine: true`), from `build/installer.nsh`, on **first install and on every
electron-updater update**:

| # | Step | Skipped when |
|---|---|---|
| 1 | Installs the **NDI Runtime** silently | `NDI_RUNTIME_DIR_V6` or `HKLM\SOFTWARE\NDI\NDI Runtime` already set |
| 2 | Installs the **VC++ 2015-2022 x64 runtime** silently | `HKLM\...\VC\Runtimes\x64\Installed = 1` |
| 3 | Adds **Windows Firewall rules** — `ArtLux.exe` in/out, plus Art-Net 6454/UDP, sACN 5568/UDP, OSC 10000/UDP, show-control 8788/TCP | never — refreshed each time |
| 4 | Runs the preflight, writes `%APPDATA%\artlux\preflight.json` | script not bundled |

Uninstall removes the firewall rules and the watchdog Scheduled Task. It does **not** remove the NDI
Runtime or the VC++ redistributable — those are shared components other applications may rely on.

**Not automatable** (the preflight reports them instead): GPU driver updates, the ASIO SDK, the PS3 Eye
camera driver, physical NIC/VLAN/multicast configuration.

---

## Windows SmartScreen — the warning you will see first

**ArtLux is not code-signed.** `.github/workflows/build.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`
and there is no Authenticode step, so every `.exe` we publish is unsigned. Windows therefore shows
**"Windows protected your PC — Microsoft Defender SmartScreen prevented an unrecognised app from
starting"** on a downloaded installer, with only a **Don't run** button visible.

This is expected, and it is the point at which people quietly give up or — worse — assume the download
is corrupt and go looking for another copy. Tell whoever installs it what to expect **before** they see
it.

**To proceed:** click **More info**, then **Run anyway**.

If there is no "More info" link, Windows has kept the file's mark-of-the-web and is refusing outright.
Unblock it first, then run it again:

```powershell
# The Properties dialog has the same switch: right-click the .exe -> Properties -> tick "Unblock".
Unblock-File -Path .\ArtLux-<version>-x64.exe
```

**Verify what you are about to run.** Since the signature cannot vouch for it, the checksum has to.
Every release publishes `latest.yml` next to the installer, carrying a **base64** SHA-512 (not hex —
comparing the wrong encoding makes a good file look corrupt):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-download.ps1 -File .\ArtLux-<version>-x64.exe
```

It works out which release the file belongs to from its name — or, for the fixed-name copies above
which carry no version, by asking GitHub which release is newest — fetches the checksum GitHub
published, and compares. **Read the exit code, not just the text** -- it distinguishes the three outcomes, and
only one of them is a pass:

| Exit | Meaning |
|---|---|
| `0` | the file is the one we published |
| `1` | **MISMATCH -- do not run it** |
| `2` | it could **not** verify (no network, bad tag, malformed metadata). **This is not a pass.** |

That last row is the point of the script. The dangerous outcome is not a mismatch, it is a check
that quietly compares nothing against nothing and prints something reassuring -- so an expected
value that is missing, empty, truncated, or hex instead of base64 is refused outright rather than
compared. The Launcher applies the same rule when it parses release metadata.

> The snippet that used to be here was worse than nothing: it did not even parse (a pipeline inside a
> method-call argument list is a PowerShell syntax error), and it left the comparison of two 88-character
> strings to the reader's eye.

The **Launcher** ([LAUNCHER.md](LAUNCHER.md)) does this comparison for you and refuses to run an
installer that does not match, which is the main reason to prefer it for venue installs. The launcher
itself is unsigned too, so it gets the same SmartScreen prompt once — after that it is a normal
installed app.

> **This is settled, not pending.** ArtLux and its launcher ship unsigned by decision — an
> Authenticode certificate is a recurring cost and an annual renewal for a non-commercial,
> educational project that takes no money (see [LICENSE](../LICENSE)). So the section above is not a
> temporary workaround: it is the procedure, and it applies to every release.
>
> What follows from that: **the checksum is the only integrity guarantee this project offers.** With
> no signature to vouch for a download, verifying it is not optional diligence — it is the whole
> mechanism. Prefer the launcher for venue installs, because it does that comparison on every
> download and refuses a mismatch outright.

---

## Antivirus — when Defender calls the installer a trojan

SmartScreen is the warning you get *before* running the file. This is the other one: Microsoft
Defender quarantining the file **after** it is on disk, under a name like
**`Trojan:Win32/Bearfoos.A!ml`** — often two at once (`.A!ml` and `.B!ml`), which is one scan pass
with two models firing, not two separate findings.

**Read the `!ml` suffix.** It means the verdict came from a machine-learning classifier, not a
signature match: Defender is saying *this binary's shape and behaviour resemble malware*, not *this
is a known sample*. `Bearfoos` is Microsoft's generic bucket for unclassified Win32 trojan-like
behaviour, and is one of the most-reported false-positive families for unsigned software.

**Why the Launcher in particular attracts it.** Its legitimate job is, step for step, the pattern the
classifiers are trained on — it downloads an `.exe`, runs it silently (`/S`), elevates through
`ShellExecuteEx`/`runas`, and calls `powershell.exe -ExecutionPolicy Bypass -File` for the preflight.
Add: unsigned, small, freshly compiled, and carrying a **brand-new hash on every release**, so it
never accumulates the reputation an ML model scores on. The classifier cannot see intent. Expect this
to recur on future releases rather than being fixed once.

### Settle it before you act on it

A detection is not proof either way. Three steps, in order — none of them require trusting us:

**1. Find out which file it actually flagged.** The notification shows a name, not a path:

```powershell
Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending |
  Select-Object -First 5 InitialDetectionTime, ThreatID, Resources
```

`Resources` carries the full path. This alone answers most cases — a binary you just compiled
yourself is a different situation from a downloaded release asset.

**2. Prove the file is the one we published.** With no signature, this is the only thing that can
answer it (the same reasoning as the section above):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-download.ps1 -File .\ArtLux-<version>-x64.exe
```

Exit `0` means the bytes are what CI built. Anything else — **including exit `2`, "could not
verify"** — is not a pass, and at that point the detection deserves to be taken at face value.

**3. Get a second opinion.** Upload the file to [VirusTotal](https://www.virustotal.com). Defender
alone, or Defender plus one or two other generic ML verdicts, is the signature of a false positive.
A dozen engines naming concrete malware families is not — stop, and do not run it.

### Then fix it properly

**Report it to Microsoft**, at
[the Defender file-submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission) — submit
as a software developer, "incorrectly detected". It is free, usually corrected within a few days, and
it fixes the detection for **every machine**, which no local change can. Treat it as part of the
release ritual, not a one-off.

**As a stopgap on a machine that has a show to run**, exclude the specific path — never the whole
folder, and never by turning Defender off:

```powershell
Add-MpPreference -ExclusionPath "C:\Program Files\ArtLux\ArtLux.exe"
```

> **Do this deliberately, and only after step 2 passed.** A path exclusion on a show PC is a standing
> hole; it is justified by having verified the file, not by the inconvenience.

**What is *not* the fix:** code signing. ArtLux ships unsigned by decision (above), and reputation —
not a certificate alone — is what these models score on, so a fresh certificate would not clear a
first-release detection anyway.

### The failure mode to plan for

The dangerous case is not the warning you read. It is Defender quarantining the ArtLux installer
**mid-install**, or removing `ArtLux.exe` from a machine that was already working — a show PC that
booted fine last week and now has no application. Every native module in ArtLux degrades silently
(that is why this document exists), and so does this: a quarantined file leaves an install that looks
present in the Start Menu and does nothing when clicked. If a venue PC stops launching, check
Defender's protection history **before** re-installing.

---

## Machine 1 — the build machine (already has ArtLux installed)

The common case, and the one with a trap: releases before 2026-07-22 installed **per-user** into
`%LOCALAPPDATA%\Programs\artlux`; the installer is now **per-machine** into `%ProgramFiles%\ArtLux`.
Windows treats those as two different products, so **the new installer will not replace the old one** —
you get two installs and two Start Menu entries. Uninstall first.

### 0. Build the installer

```powershell
npm run package          # fetch assets -> build audio -> bundle -> verify resources -> electron-builder
```

Needs **CMake on PATH** (the JUCE audio engine is rebuilt strictly). If `cmake` is not on your normal
PATH, run this from a **Developer Command Prompt for VS 2022**. Output: `release\ArtLux-<version>-x64.exe`.

`package` refuses to produce an installer that is missing a declared resource — if it stops at
`verify:resources`, read the remedy it prints; it is usually `npm run fetch:redist` or `fetch:opencv`.

### 1. Back up your settings

Uninstall leaves `%APPDATA%\artlux` alone (`deleteAppDataOnUninstall` is unset → defaults to false), so
prefs, LiDAR takes and caches survive. Back up anyway — it costs nothing:

```powershell
Copy-Item "$env:APPDATA\artlux\artlux-prefs.json" "$env:USERPROFILE\Desktop\artlux-prefs.backup.json"
```

Your `.artlux` **projects** are wherever you saved them and are never touched by an install/uninstall.

### 2. Close ArtLux completely

A running Electron holds files and the uninstaller will half-finish.

```powershell
Get-Process ArtLux, electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

### 3. Find and remove the old install

```powershell
# Where is it, and which scope?
$keys = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
foreach ($k in $keys) {
  Get-ItemProperty $k -EA SilentlyContinue | Where-Object DisplayName -like '*ArtLux*' |
    Select-Object DisplayName, DisplayVersion, UninstallString
}
```

An `UninstallString` ending in **`/currentuser`** is the old per-user install:

```powershell
& "$env:LOCALAPPDATA\Programs\artlux\Uninstall ArtLux.exe" /currentuser
# then confirm both casings are gone (NSIS has used both):
Test-Path "$env:LOCALAPPDATA\Programs\artlux", "$env:LOCALAPPDATA\Programs\ArtLux"
```

### 4. Clear stale firewall rules

Pre-2026-07-22 installs never created rules; instead Windows' own first-run prompt made rules named
after the **old exe path**, which is about to stop existing. The new installer creates properly-named
`ArtLux*` rules, so drop the orphans (needs elevation):

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',
  'Get-NetFirewallRule | Where-Object DisplayName -like "artlux.exe" | Remove-NetFirewallRule'
```

### 5. Install

Run `release\ArtLux-<version>-x64.exe` and **accept the UAC prompt**. Declining it produces an install
with no redistributables and no firewall rules — the failure this whole document exists to prevent.

### 6. Verify — see [Verifying an install](#verifying-an-install) below.

---

## Machine 2 — a venue / show PC, first install

No prior ArtLux. The point here is to know what the machine is missing **before** you commit to it, which
matters when you are on site with limited time.

### 1. Copy two files to the machine

```
ArtLux-<version>-x64.exe      the installer
scripts\preflight.ps1         standalone, no dependencies -- the installer bundles a copy too,
                              but you want it BEFORE anything is installed
```

### 2. Preflight before installing

```powershell
powershell -ExecutionPolicy Bypass -File preflight.ps1 -Mode runtime
```

Read the result like this:

| Report | Meaning |
|---|---|
| `[FAIL] NDI Runtime`, `[FAIL] VC++ 2015-2022 x64 runtime` | **Expected on a clean machine.** The installer fixes both in step 3. |
| `[SKIP] ArtLux installation` | Expected — nothing installed yet. |
| `[FAIL] GPU` (only a fallback adapter) | **Fix before installing.** WebGPU compute is the entire pixel-mapping pipeline; install the vendor driver. |
| `[WARN] Network profile: Public` | Firewall will block inbound OSC and the tablet remote. Set the show network to **Private**. |
| `[WARN] Network adapters` (more than one up) | sACN multicast bind is ambiguous. Pin the output interface in ArtLux or disable the unused NIC. |
| `[WARN] Audio output device` (none) | The audio UI will render and play nothing, with no error. |
| `[WARN] port ... already bound` | Something else holds it; ArtLux will fail to bind and that feature goes quiet. |

Everything except the GPU line is safe to proceed through — but write down the warnings, they explain
things you would otherwise debug at 2am.

### 3. Install

Run the `.exe`, **accept UAC**. On a clean machine this is where the NDI Runtime and the VC++ runtime
actually get installed, so it takes noticeably longer than a plain app install.

### 4. Verify — below. Do this **before** you leave the venue.

---

## Verifying an install

A packaged ArtLux has no console, so do not try to read `[ndi] runtime available: true` — check the
preflight instead. Both of these should report **0 failures**:

```powershell
# the report the installer just wrote
Get-Content "$env:APPDATA\artlux\preflight.json" -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty summary

# or re-run it live against the install (the installer ships a copy)
powershell -ExecutionPolicy Bypass -File "$env:ProgramFiles\ArtLux\resources\scripts\preflight.ps1" -Mode runtime
```

What a good install looks like:

- **`resources/` audit** — all 8 present: `output-engine.node`, `audio-engine.node`, `spout-receiver.node`,
  `hap.node`, `ndi.node`, `calib.node`, **`opencv_world4110.dll`**, `nvwarp.node`.
- **import scan** — every `.node` reports *"all imports resolvable"*. This is the check that catches
  present-but-unloadable, e.g. `calib.node` with no OpenCV DLL beside it.
- **firewall** — `Get-NetFirewallRule -DisplayName 'ArtLux*'` returns 6 enabled rules.

Then launch the app and confirm in the UI: an **NDI** source type appears in a surface's content picker,
and the **projector calibration** wizard opens without an "addon unavailable" message.

### If this machine plays a baked calibration

A venue PC that projects onto objects usually runs a calibration **file** rather than aligning on
site. Two things have to be true, and neither is checked by the preflight:

1. **The `.mpcdi` is on this machine**, at a path that survives a reboot — a mapped network drive is
   the classic thing that is not mounted yet when the show starts.
2. **It has been imported once, on this machine.** Projection Outputs ▸ **Calibration File** ▸
   *Import*. The path is remembered per machine (never in the project — a calibration describes the
   room), and re-read at every start.

Step 2 is not optional and cannot be done later from the show mode: `--broadcast` renders the show
and its outputs and **no editor chrome**, so there is no panel to import from and nobody to click it.
Import once in the editor, then launch broadcast — the output should come up warped with no further
action. If the file has moved, the log says so once and every output falls back to its own warp: the
show still starts, it just looks wrong.

---

## Troubleshooting

| Symptom | Check | Usual cause |
|---|---|---|
| NDI sources missing right after install | Preflight `NDI Runtime` = PASS but the app disagrees | The NDI installer set `NDI_RUNTIME_DIR_V6` **after** the app inherited its environment. **Restart ArtLux**; log off/on if that is not enough. |
| NDI missing, preflight says `[FAIL] NDI Runtime` | `resources\NDI-Runtime.exe` present? | The installer was built without it — `npm run fetch:redist`, rebuild. Or UAC was declined. |
| Calibration wizard says the addon is unavailable | Preflight `calib.node imports` | `opencv_world4110.dll` missing from `resources/` — installer built without `npm run fetch:opencv`. |
| Everything native is dead at once | Preflight `VC++ 2015-2022 x64 runtime` | Redistributable not installed; UAC declined, or the installer was built without it. |
| Audio UI works, nothing plays | Preflight `audio-engine.node` + `Audio output device` | Missing addon, or no enabled output endpoint. See [DEVELOPMENT.md → no sound?](DEVELOPMENT.md#the-audio-ui-is-all-there-and-nothing-plays--no-sound). |
| Tablet remote unreachable | Network profile + port 8788 | Profile is Public, or the rule was never added (UAC declined). |
| Camera pose tracking does nothing | On the **build** machine: `preflight.ps1 -Mode dev` → `MediaPipe offline assets` | Built without `npm run assets:mediapipe`; the assets are bundled into `app.asar` at build time, so this can only be fixed by rebuilding. |
| Two ArtLux entries in Apps & Features | Uninstall strings | The per-user → per-machine migration was skipped. Uninstall the `/currentuser` one. |
| **Taskbar / Explorer still show the OLD app icon after an upgrade** | Open the app — is the icon correct in the About dialog and the title bar? | **Nothing is wrong with the install.** Windows caches shell icons per executable path and does not re-read the `.exe` just because it changed. See below. |

Quick repair on a machine that is already installed, without rebuilding anything. `-Fix` is deliberately
narrow: it installs **only** the NDI Runtime and the VC++ redistributable, via winget, and only when the
preflight reported them as FAIL. It never touches firewall rules, drivers or the install itself.

```powershell
powershell -ExecutionPolicy Bypass -File preflight.ps1 -Mode runtime -Fix
```

If a resource is missing from `resources/` (`opencv_world4110.dll`, an addon), `-Fix` cannot help —
that is a broken **installer**, and the fix is to rebuild it on the build machine and reinstall.

### The app icon lags behind an upgrade (Windows icon cache)

**Symptom.** You ship a build with a changed app icon, upgrade a machine, and the taskbar, Explorer,
the Start menu and any pinned shortcut keep showing the *previous* icon — sometimes for days.

**This is not a packaging fault, and it is not worth debugging as one.** Windows caches shell icons in
a per-user database keyed by executable path + index, and it does not re-read the `.exe` merely because
the file changed underneath it. ArtLux installs to the same path every time (`%ProgramFiles%\ArtLux\
ArtLux.exe`), which is exactly the case the cache gets wrong. A *first* install on a clean machine has
no stale entry and shows the new icon immediately — so this only ever bites an **upgrade**.

**Confirm it is the cache, not the build,** before touching anything: open the app and look at the
title bar and **Help ▸ About ARTLux**. Those draw the mark from the renderer, never from the shell
cache. If they are correct, the installed build is correct and only Explorer is lying.

Clearing it (each step is cheap; stop as soon as the icon is right):

```powershell
# 1. Nudge the shell — enough on most machines.
ie4uinit.exe -show

# 2. Delete the cache and restart Explorer. Closes every Explorer window; harmless mid-show,
#    but it does NOT touch ArtLux — the show keeps running.
taskkill /f /im explorer.exe
Remove-Item "$env:LOCALAPPDATA\IconCache.db" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache*.db" -Force -ErrorAction SilentlyContinue
Start-Process explorer.exe

# 3. Log off / on, or reboot. Always works.
```

**Pinned taskbar shortcuts are a separate, stickier cache.** A pin stores its own icon reference, so a
pinned ArtLux can keep the old mark even after the cache is cleared. Unpin and re-pin it.

> **On a venue PC, none of this is urgent** — the icon is cosmetic and the show is unaffected. If you
> are on site and short of time, leave it; the next reboot fixes it.

---

## Uninstalling

```powershell
& "$env:ProgramFiles\ArtLux\Uninstall ArtLux.exe"     # accept UAC
```

Removes the app, its firewall rules and the watchdog Scheduled Task. Leaves `%APPDATA%\artlux`
(prefs, LiDAR takes), the NDI Runtime and the VC++ redistributable in place. To go fully clean:

```powershell
Remove-Item "$env:APPDATA\artlux" -Recurse -Force      # deletes prefs AND recorded tracking takes
```
