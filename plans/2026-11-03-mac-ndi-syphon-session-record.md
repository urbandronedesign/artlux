# 2026-11-03 — session record: NDI, Syphon and sound on the Mac (v0.35.1-beta.1 → beta.2)

> **Status:** Record (open: the Syphon retest). Written for two readers: the owner, and the next Claude
> session on this machine. It follows the [2026-11-02 suite release record](2026-11-02-suite-release-session-record.md)
> and executes, in part, [syphon-plugin.md](syphon-plugin.md) §9B. Nothing here has reached `main` yet.

## Where things stand

| | |
|---|---|
| **Branch** | **`feat/syphon` at `b2ea2ea`**, pushed, **not merged**. It contains `feat/ndi-macos` (`ccfa179`), so merging `feat/syphon` brings both. 20 commits ahead of `main`. |
| **Version on the branch** | **`0.35.1-beta.2`** in `package.json` + `package-lock.json`. ⚠ **Set it to `0.35.1` before the real release** (`npm version 0.35.1 --no-git-tag-version --workspaces=false`). |
| **Releases** | **v0.35.0 is still `/releases/latest`.** Two **pre-releases** published 3 Nov: **v0.35.1-beta.1** and **v0.35.1-beta.2**. The Launcher ignores pre-releases, nobody on 0.35.0 is offered them, and the real v0.35.1 will retire both to drafts by itself (the retention step in `build.yml`). |
| **Tester's link** | https://github.com/urbandronedesign/artlux/releases/download/v0.35.1-beta.2/ArtLux-0.35.1-beta.2-arm64.dmg |
| **Waiting on** | The owner's tester (MacBook Pro **M1 Pro, macOS 13.1**) re-running the **Syphon** test with TouchDesigner on beta.2. |

## Result on a real Mac

| | v0.35.0 (released) | beta.1 | beta.2 |
|---|---|---|---|
| **NDI** | ✗ "NDI runtime not present" — the Mac app never contained NDI | ✓ **receive works** (tester confirmed) | unchanged |
| **Sound** (a video's audio) | ✗ **silent on every Mac older than macOS 26** | ✓ **works on 13.1** (tester confirmed) | unchanged |
| **Syphon** | ✗ not in the app (the source list shows *Spout*) | ✗ TouchDesigner found and connected, **every frame refused** | fixed, **retest pending** |

## How it went

1. **NDI on macOS** (`feat/ndi-macos`, 2 Nov): NDI had never existed on a Mac — the only `ndi.node` was the
   Windows prebuilt. CI now installs the NDI SDK for Apple, builds the addon, ships `libndi.dylib` beside it
   (`scripts/stage-ndi-macos.cjs`) and declares the Local Network keys macOS 15 needs. Details in
   [docs/NDI.md](../docs/NDI.md) → Packaging.
2. **Syphon ported** (`feat/syphon`, 2 Nov): the August `syphon` branch (never run on a Mac) merged onto the
   suite. Show only, not the Calibrator. The colour-engine check was red on every Mac and was fixed on the way.
3. **"Nothing works" — the tester ran the wrong installer.** The test dmg and the v0.35.0 release dmg had the
   **same file name**, `ArtLux-0.35.0-arm64.dmg`. The giveaway was the source list: **Spout present, Syphon
   absent** is only possible in v0.35.0 (the branch hides Spout on a Mac and shows Syphon). Hence the
   `-beta.N` versions: a distinct file name, and *About* says which build it is.
4. **The audio engine required macOS 26** — found by reading every Mach-O's minimum macOS in the shipped
   dmg. CMake had no deployment target, so it stamped the CI runner's. Fixed in `61e6403`:
   `CMAKE_OSX_DEPLOYMENT_TARGET=12.0` in `scripts/build-audio.cjs` (Electron 42's own floor), and
   **`verify:macsign` now fails a build if any binary in the app needs a newer macOS than Electron itself**.
   One exemption: NDI's `libndi.dylib` (13.0, not ours to rebuild) — so **NDI on a Mac needs macOS 13**,
   now in NDI.md. This bug is also in the released v0.35.0 for Mac.
5. **Syphon refused TouchDesigner's frames** — beta.1's log: 3,463 lines of
   `refusing surface with unexpected pixel format 0x00000000 (want BGRA)` in 70 s. Every Syphon app ships its
   own framework; **older ones never tag the IOSurface's pixel format** (it reads 0, 4 bytes a pixel, BGRA all
   the same). Our loopback selftest could not see it: its server runs on the current framework, which does
   tag it. Fixed in `b2ea2ea`: accept the tag, *or* no tag with 4 bytes a pixel; anything else still refused;
   the refusal logs once per format, not per frame; four new selftest cases, green on the CI Mac.

## Open items — in order

1. **The Syphon retest** on beta.2 (§9B steps 3 and 5). The answer decides the next step:
   - **picture appears and moves** → step 2 below;
   - **still empty** → read the new log (`[syphon] refusing …` now says the bytes/pixel too) and the editor's
     Syphon status line, which reports *no-shared-texture* or an import refusal;
   - **one frame, frozen** → Chromium caching the first SharedImage: the per-frame Metal blit in
     [syphon-plugin.md](syphon-plugin.md) §4.6.
2. **When Syphon passes:**
   - set the version to `0.35.1`;
   - per §9B: remove the "never run on a Mac" banner in `docs/SYPHON.md` and replace the STATUS block at the
     top of `plans/syphon-plugin.md` with the result;
   - merge `feat/syphon` to `main`, and release **v0.35.1** only with the owner's OK.
3. **Not yet tested on a Mac** (§9B steps 4, 6, 7, 8): no leak over 10 minutes, a server resize, several
   surfaces on one server, a projector output in the packaged app. NDI **send** was not reported either.
4. **Intel Macs get nothing.** Every Mac build is `arm64` only; on an Intel Mac the app does not open. Not
   asked for yet — it would mean building every native crate for `x86_64` too.
5. The beta.1 log shows the editor reloading once at 14:27:53 with no `renderer.gone` — most likely a manual
   reload. Worth one question to the tester; nothing to fix unless it recurs.

## Traps (each cost time this session)

- **Same file name = wrong installer tested.** Any Mac test build gets a `-beta.N` version first.
- **macOS 15 removed right-click ▸ Open** for unnotarised apps. The instruction that works on every version
  is `xattr -cr /Applications/ArtLux.app` (removes the quarantine flag; the signature still verifies).
  Below 15, right-click ▸ Open still works.
- **A green CI does not mean the app works on an older Mac.** The runner builds on its own macOS; a binary
  without a deployment target loads there and nowhere older. `verify:macsign` now guards it.
- **The loopback selftest only knows our Syphon.** A real server ships its own framework; test against one
  (TouchDesigner, Resolume, MadMapper) before trusting the receiver.
- **The Syphon gate's push trigger is the old `syphon` branch**, not `feat/syphon`: run it by hand
  (`gh workflow run syphon.yml --ref feat/syphon`).

## Recipes

- **Read a tester's log from a SharePoint / OneDrive link:** append `&download=1` to the share URL and
  `curl -L` it. Worked for both files this session (`:t:` text and `:u:` file links).
- **What the tester sends back:** `~/Desktop/artlux-mac.txt` (stdout of the app started from Terminal —
  the native `NSLog` lines are only here) and the newest file in `~/Library/Application Support/ArtLux/logs/`
  (the JSON machine log: version, OS, CPU, GPU in `config.snapshot`, every boot module's state).
- **Check a Mac build's minimum macOS from Windows:** extract the dmg with 7-Zip (`7z x <dmg>`), then read
  `LC_BUILD_VERSION` from each Mach-O — the same parser now lives in `scripts/verify-mac-signature.cjs`.
- **Publish a Mac test build:** bump to `0.35.1-beta.N`, commit, push, `git tag v0.35.1-beta.N <sha>` and push
  the tag. A hyphenated tag is a pre-release: public, never Latest, retires nothing.
