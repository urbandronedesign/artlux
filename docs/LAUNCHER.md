# The ArtLux Launcher

**`ArtLuxLauncher.exe` is the thing you download.** It installs ArtLux and everything ArtLux needs,
checks that the machine can actually run a show, finds your projects, and opens them. It is a small
separate Windows application — about 1.3 MB — that lives beside the app rather than inside it.

Source: [`launcher/`](../launcher/) · Releases: tagged **`launcher-v*`** ([latest](https://github.com/urbandronedesign/artlux/releases))

---

## Why it exists

Two problems, one surface.

**Installing was a procedure, not a download.** [INSTALL.md](INSTALL.md) is pages long: find and
remove the old per-user install that Windows will not replace, delete orphan firewall rules, accept
the UAC prompt (declining it silently produces an install with no redistributables and no firewall
rules — the failure that document exists to prevent), copy `preflight.ps1` onto the venue PC, run it
under `-ExecutionPolicy Bypass`, then read a FAIL/WARN table and know which lines are expected and
which are blocking.

**Opening a project was worse than it needed to be.** ArtLux cold-boots into an empty untitled
document. There was no picker, only `File ▸ Open…` and a ten-entry recents submenu whose dead paths
were never pruned. And the eleven example projects ship read-only inside `Program Files`, so an
operator's first Save into one failed.

### Why a separate program and not a window inside ArtLux

Because it has to work **before ArtLux exists** and **when ArtLux is broken**. Only an external
program can check a machine, install prerequisites, and diagnose a *failed* install. A welcome screen
inside the app can only ever report on a machine where the app already launched — which was never the
problem.

An in-app project picker is still worth having, and the two are complementary. This document covers
the external launcher.

**It is a front-end to the existing NSIS installer, never a replacement.** NDI runtime, VC++ redist,
firewall rules and the post-install preflight all stay in
[`build/installer.nsh`](../build/installer.nsh), so there is one source of truth and ArtLux's own
`electron-updater` keeps working unchanged.

---

## Getting it, and the warning you will see

Download `ArtLuxLauncher_<version>_x64-setup.exe` from the
[releases page](https://github.com/urbandronedesign/artlux/releases) and run it. It installs
**per-user**, so it needs no administrator rights for itself — it asks for elevation only when
installing ArtLux, which is a moment that makes sense.

> **Windows SmartScreen will warn on first run.** ArtLux and its launcher are unsigned, by decision
> (see [Licence and signing](#licence-and-signing)). Click **More info → Run anyway**. If there is no
> "More info" link, Windows kept the file's mark-of-the-web — right-click → Properties → **Unblock**,
> or `Unblock-File -Path .\ArtLuxLauncher_<version>_x64-setup.exe`. Full detail:
> [INSTALL.md → Windows SmartScreen](INSTALL.md#windows-smartscreen--the-warning-you-will-see-first).

Requires Windows 10/11 x64 and the WebView2 runtime, which ships with Windows 11 and is fetched
automatically on older builds.

---

## The four tabs

### Install

![The Install tab, with a release resolved](images/launcher/01-install.png)

Shows every ArtLux on the machine and what is published, then does the whole install in one click.

- **Detection names its source.** "found via product key InstallLocation" is a registry fact; a path
  fallback is labelled as a guess, because those are different things and only one of them is
  trustworthy.
- **The double-install warning.** Releases before 2026-07-22 installed per-user; the installer is now
  per-machine, and Windows treats them as different products, so it will *never* replace one with the
  other. Two installs, two Start Menu entries, and which version you get depends on which shortcut
  you click. Nothing inside the app can see this state; the launcher names it.
- **The download is verified before it is run.** The checksum comes from `latest.yml`, the same
  metadata ArtLux's own updater trusts. A mismatch is refused outright and the file is deleted — with
  no code signature, this is the only integrity guarantee the project has.
- **It will not install over a running ArtLux**, and it will not claim success it did not observe:
  after the installer exits, the registry is re-read to confirm the install is really there.

Declining the administrator prompt gets its own message, because a declined UAC installs *nothing*
while looking like an ordinary failure.

### Projects

![The Projects tab listing projects found on disk](images/launcher/02-projects.png)

Everything on the machine that ArtLux can open, with one click to open it.

Searches Desktop, Documents and Videos by default — resolved through the shell, so a Documents folder
redirected to OneDrive is still found — six levels deep, skipping system folders, `node_modules` and
build output. A directory containing `project.artlux` is a **portable project**: it is listed once,
under the folder's name, and not descended into.

The scan is bounded (4000 projects, 20 seconds) and **says so when it stops early**, because a
silently truncated list reads as "you have no projects".

ArtLux's own recent files are merged in read-only, with dead paths pruned, so a project on a USB
stick outside every search folder is still one click away.

### Examples

![The Examples tab showing the three bundled sets](images/launcher/03-examples.png)

The example projects ArtLux ships — audio, state machine, LiDAR tracking — each with the tutorial
that goes with it.

Picking one **copies the whole set into your workspace first**, then opens it. The shipped copies
live under `Program Files`, where saving fails; copying makes the obvious thing work. The whole set
comes across because a set shares one `assets/` folder, and one project without it is broken. If a
folder of that name already exists, the copy is numbered rather than merged into it.

Default workspace: `Documents\ArtLux Projects`.

### Health

![The Health tab after running the machine check](images/launcher/04-health.png)

Runs ArtLux's own [`preflight.ps1`](../scripts/preflight.ps1) — GPU, the runtimes ArtLux needs, the
network profile, firewall rules, the ports it binds — and sorts the result by what you should do
about it:

| Grouping | Meaning |
|---|---|
| **Fix before relying on this machine** | e.g. only a fallback GPU adapter. WebGPU compute *is* the pixel-mapping pipeline. |
| **Expected — can be repaired** | Missing NDI runtime or VC++ redist on a clean machine. **Repair** installs them. |
| **Worth knowing** | Public network profile (blocks inbound OSC and the tablet remote), multiple NICs up, a port already bound, no audio device. |

Checks the launcher has nothing curated to say about render **verbatim**, with the script's own
remedy — the triage map shapes wording, never what you are shown.

**Repair** appears only when something it can actually install has failed *and* winget is present, so
it is never a button that does nothing. It runs elevated and visible, because winget's own progress
is the only honest signal — and afterwards the check is re-run and diffed rather than trusting an
exit code nobody read. Anything still failing is named.

The launcher bundles its own copy of the check script, which is what lets it examine a machine
**before** ArtLux is installed. Once ArtLux is there, the installed copy is used so the check matches
the app version.

---

## How it works

```
ArtLuxLauncher.exe            Tauri: a Rust core with a WebView2 UI
│
├─ src-tauri/src/
│   ├─ install.rs    find every ArtLux install (registry, then labelled fallbacks)
│   ├─ releases.rs   GitHub releases → tag → latest.yml → version, asset, sha512
│   ├─ download.rs   streamed download, progress, cancel, sha512 verify
│   ├─ runner.rs     elevate the installer, and spawn ArtLux --project=
│   ├─ projects.rs   library roots, the disk walk, ArtLux's recents
│   ├─ examples.rs   derive the sets, copy one to the workspace
│   ├─ preflight.rs  run the machine check, parse it honestly
│   ├─ lib.rs        ← all of the above, as a library
│   └─ main.rs       the Tauri shell: thin commands over the library
│
└─ src/              React + plain CSS over ArtLux's tokens
```

**The core is a library, and `main.rs` is only transport.** A bootstrapper's interesting behaviour is
registry detection, release resolution and checksum verification — none of which should be reachable
only by clicking a button in a WebView. [`src/bin/selftest.rs`](../launcher/src-tauri/src/bin/selftest.rs)
runs the same code against the real machine and the live release feed with no GUI.

**The web layer holds no privilege.** Every filesystem, registry, network and process operation is a
`#[tauri::command]` in Rust; the UI is granted no filesystem or shell capability at all. It cannot
name a path to execute — it can only hand back a path the Rust produced *and verified*. That matters
because this program runs a downloaded executable with Administrator rights.

**Styling copies ArtLux's tokens, it does not import them** — a separate product cannot reach into
the app's renderer. [`src/tokens.css`](../launcher/src/tokens.css) carries a provenance header; change
a value there and in `src/renderer/styles/tokens.css` together.

---

## The contracts it depends on

Everything below is something the launcher relies on **from outside its own tree**. Changing any of
it breaks a shipped product that this repository does not build. Treat each as an interface.

### 1. The CLI

```
ArtLux.exe --project=<absolute path to a .artlux file>
```

The **only** contract for "open this project": there is no file association and no protocol handler.
Parsed in [`src/main/index.ts`](../src/main/index.ts), consumed by an editor-mode boot effect in
[`src/renderer/App.tsx`](../src/renderer/App.tsx).

- `--project=` **outranks** the editor's own reopen of `prefs.lastProjectPath`. Both are mount
  effects that await, so without that rule they race and the document is whichever resolved last. The
  precedence lives in two places and only works as a pair.
- A **second** launch carrying `--project=` retargets the **running** instance via `second-instance`.
  The second process **exits 0 regardless** — the single-instance lock swallows it — so an exit code
  proves nothing. Probe for a running `ArtLux.exe` before spawning.

Guarded by the `--project= reaches the document in every run mode` check in
[`scripts/verify-invariants.cjs`](../scripts/verify-invariants.cjs).

### 2. Locating an install

electron-builder's NSIS writes **two** keys under a product GUID that is a UUIDv5 of the appId, and
therefore stable across versions:

```
HKLM\SOFTWARE\<GUID>                    InstallLocation = C:\Program Files\ArtLux   ← the real path
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>
    DisplayName / DisplayVersion / DisplayIcon / QuietUninstallString
    InstallLocation                     (EMPTY)   ← the obvious lookup returns nothing
```

> ⚠ **`InstallLocation` on the Uninstall key is empty on every install observed.** Resolution order:
> product key → `DisplayIcon` (strip the `,0`, take the directory) → `%ProgramFiles%\ArtLux` → legacy
> `%LOCALAPPDATA%\Programs\artlux`. Path guesses come last and are **labelled** as guesses: reaching
> them means no registry entry matched, which is a different fact from "installed here".

`Find-ArtLuxInstall` in [`scripts/preflight.ps1`](../scripts/preflight.ps1) had exactly this bug and
survived only on its path fallback.

### 3. The release feed

Public repo, so unauthenticated access works — 60 requests/hour/IP, and a rate-limit response is a
real state to name rather than spin on.

- `GET /repos/urbandronedesign/artlux/releases` → filtered by **tag shape**, newest first.
- `…/releases/download/<tag>/latest.yml` → `version`, `path`, `sha512`. The same metadata
  `electron-updater` consumes, so it is the only correct source for the hash.
- Windows asset name: `ArtLux-<version>-x64.exe` (arch is `x64`, not `x86_64`).

> ⚠ **`sha512` is base64, not hex.** Comparing a hex digest fails every download and reads as a
> network problem.

### 4. Running the installer

`nsis.oneClick` is unset (defaults **true**) and `perMachine: true`, so the installer's manifest
requests elevation. Therefore `/S` is **silent, not unattended** — Windows still shows UAC.

> ⚠ **`CreateProcess` never raises UAC.** `std::process::Command` handed an elevation-manifested
> executable fails with `ERROR_ELEVATION_REQUIRED (740)` and no prompt appears at all. Elevation is a
> *shell* behaviour: `ShellExecuteExW` with the `runas` verb, plus `SEE_MASK_NOCLOSEPROCESS` to get a
> handle to wait on. Declining the prompt returns `ERROR_CANCELLED (1223)` and installs **nothing**.

Never claim success from an exit code: re-read the registry.

### 5. Resources inside an install

```
<InstallDir>\ArtLux.exe
<InstallDir>\resources\scripts\preflight.ps1     ← also bundled by the launcher, for pre-install use
<InstallDir>\resources\scripts\lidar-emitter.cjs
<InstallDir>\resources\examples\<set>\*.artlux   ← the gallery source
<InstallDir>\resources\docs\*.md
```

`preflight.ps1` is fully self-contained (no sibling files; an absent repo just makes its `dev.*`
checks SKIP), which is what makes shipping a second copy viable.
`-Mode runtime -Json -OutFile <path>` emits
`{ generatedAt, host, mode, summary{pass,warn,fail,skip}, results[{group,id,name,status,detail,remedy}] }`.

> ⚠ Exit **1** means "some check FAILed", not "the run failed"; **2** means not-Windows. Releases up
> to 0.25.0 print a banner *before* the JSON even under `-Json`, so parse from the first `{`.
> PowerShell 5.1's `Out-File -Encoding utf8` writes a **BOM** — strip it, or the installer's own
> cached report never loads.

### 6. Prefs — read-only from outside

`%APPDATA%\artlux\artlux-prefs.json` carries `recentFiles` and `lastProjectPath`. **Never write it.**
It belongs to a running ArtLux and is rewritten wholesale on every save, and a malformed write (a BOM
will do it) makes the app silently reset every preference it holds — layout, shortcuts, UI scale,
templates.

---

## Building and testing

```bash
cd launcher
npm install          # its own tree — NOT a root workspace member, so root `npm ci` stays reproducible
npm start            # tauri dev (Vite on :5173 + the Tauri window)
npm run package      # → src-tauri/target/release/bundle/nsis/ArtLuxLauncher_<v>_x64-setup.exe

cd src-tauri
cargo run --bin selftest              # detection, release feed, checksum refusal, scan, examples, health
cargo run --bin selftest -- --download  # + the real 238 MB download, verified
cargo run --bin selftest -- --install   # + a real elevated install (prompts for admin)
cargo run --bin selftest -- --open      # + open a project, cold and with ArtLux already running
```

**Run the self-test after touching `install.rs` or `releases.rs`.** It fails if detection ever
resolves by *path guess*, which is how the registry gotcha would silently come back.

Four configuration choices that look like typos and are not:

- **`productName` is `ArtLuxLauncher`, space-free.** Tauri names the bundle
  `{productName}_{version}_{arch}-setup.exe` with no template to override it, and a space in a release
  artifact filename has already broken this project's publish pipeline once
  ([DEVELOPMENT.md → Release](DEVELOPMENT.md)). The window title reads "ArtLux Launcher" via
  `app.windows[].title`.
- **`installMode: currentUser`** — no UAC to install the launcher itself.
- **`css: { postcss: { plugins: [] } }` in `vite.config.ts`.** Vite searches *upward* for a PostCSS
  config and finds the **app's**, which needs `tailwindcss` from the root `node_modules`. That
  resolves on a machine where the app has been built and fails in CI, where only `launcher/` is
  installed. The launcher uses plain CSS and wants no PostCSS.
- **The root `tsconfig.json` excludes `launcher`** — it has no `include`, so it would otherwise
  typecheck Tauri's generated codegen assets and fail.

`tauri.conf.json` is schema-validated and rejects unknown keys, so it cannot carry comments — notes
about it live here.

The bundled `preflight.ps1` is **regenerated from the app's copy on every build**
([`scripts/sync-preflight.cjs`](../launcher/scripts/sync-preflight.cjs)), not committed, so it cannot
silently fork.

---

## Releasing

CI: [`.github/workflows/launcher.yml`](../.github/workflows/launcher.yml), triggered by a
**`launcher-v*`** tag. Separate from `build.yml` so an app release never rebuilds the launcher and
vice versa; the two tag patterns cannot match each other.

```bash
# bump `version` in BOTH launcher/package.json and launcher/src-tauri/Cargo.toml
#   (Tauri reads the former for the bundle, Cargo the latter for own_version())
git tag -a launcher-v0.1.1 -m "…" && git push origin launcher-v0.1.1
```

> ⚠ **Launcher releases are published as PRE-RELEASES, and that is load-bearing.** GitHub's
> `/releases/latest` returns whichever release went out most recently, whatever it is — and **ArtLux's
> own electron-updater keys off that endpoint**, then fetches `latest.yml` from the tag it names. A
> launcher release published normally would make every installed ArtLux look for app metadata on a
> launcher tag and fail its update check, in the field, silently. Pre-releases are excluded from
> `latest`, which is exactly the property needed.
>
> The launcher does not rely on that alone: it lists releases and filters by **tag shape**, never
> trusting the ordering. Both defences, because either one alone is a single point of failure for
> something that breaks remotely.

CI writes **`launcher-latest.yml`** beside the installer, in the same shape electron-builder uses for
the app. One metadata format in the codebase, and the launcher's self-update reuses the
verified-download path it already uses for ArtLux.

**Self-update is not Tauri's updater plugin**, deliberately. The plugin would work and would mean a
signing keypair with its private half in CI secrets and its public half baked into the binary — real
infrastructure to stand up and keep correct, for an outcome that is otherwise identical. The
`__TAURI_BUNDLE_TYPE variable not found` warning in the build output belongs to that plugin and is
inert while it is unused.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| SmartScreen blocks it, with no "More info" | Windows kept the mark-of-the-web. Properties → **Unblock**, or `Unblock-File`. |
| "the download does not match the checksum…" | The file is not what GitHub published. Retry; if it persists, download manually and compare against `latest.yml`. **It will not be run.** |
| "Installation did not happen: the … prompt was declined" | Exactly that — nothing was installed. Run again and choose Yes. |
| "ArtLux is running. Close it first" | An installer cannot replace files in use. |
| "Two installs are present" | The legacy per-user install alongside the per-machine one. Remove the per-user one; Windows will not do it for you. |
| Projects tab is empty | Nothing was found in the search folders. Check the "Where it looked" list. |
| The scan says it stopped early | It hit the 4000-project or 20-second limit. Narrow the search folders. |
| Examples tab says ArtLux is not installed | The examples ship inside the app; install it first. |
| "GitHub is rate-limiting this machine" | 60 requests/hour for anonymous access. Wait, or install manually. |
| Health tab absent | No check script could be found — a broken build. |

---

## Licence and signing

LICENSE §3 requires the authorship credit and the non-commercial notice to survive in a build. The
launcher is a build, and it is the first screen a venue sees, so it renders `CREDIT_LABEL`,
`AUTHORS_LINE` and `LICENSE_HEADLINE`. Those strings are copied from
[`shared/credits.ts`](../shared/credits.ts) into `launcher/src/brand.tsx` — change them together. The
wordmark comes from `build/wordmark.svg`, whose generator header marks it as the asset for external
use.

**Both products ship unsigned, by decision.** `build.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`,
there is no Authenticode step, and none is planned: a certificate is a recurring cost and an annual
renewal for a project that takes no money. Two consequences worth holding on to:

- **The sha512 comparison is the only integrity guarantee this project has.** `download.rs` refusing a
  mismatched file is not belt-and-braces — it is the entire mechanism, which is why that refusal
  deletes the file and hard-errors rather than warning.
- **The launcher is the safer install path**, and can be recommended as such: it verifies every
  download automatically, where a human downloading the `.exe` by hand has to remember to.

---

## Status

| Stage | What | State |
|---|---|---|
| 0 | ArtLux-side prerequisites (`--project=` in the editor, `second-instance` argv, preflight fixes) | **done** |
| 1 | Install: detect · resolve · verified download · elevated run | **done** |
| 2 | Projects: library roots, cancellable scan, recents merge, open via `--project=` | **done** |
| 3 | Examples: derived sets, whole-set copy to a writable workspace, then open | **done** |
| 4 | Health: run `preflight.ps1`, triage as data, repair via `-Fix` | **done** |
| 5 | CI on `launcher-v*`, self-update | **done** |

Not built, and worth considering later: adding or removing library folders from the UI (the roots are
configurable in `%APPDATA%\ArtLuxLauncher\config.json` but nothing edits them yet), a one-click
uninstall of the legacy per-user install, and thumbnails for projects — which would mean rendering a
project through the WebGPU pipeline, so it is a real feature rather than a detail.
