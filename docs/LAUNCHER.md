# The Launcher

`ArtLuxLauncher.exe` is a small separate Windows app (Tauri: Rust core + a WebView2 UI) that is
**the thing you download**. It installs ArtLux and its prerequisites, verifies the machine, and — in
later stages — finds your projects and ships the example gallery.

It is a **front-end to the existing NSIS installer, never a replacement.** NDI runtime, VC++ redist,
firewall rules and the post-install preflight all stay in [`build/installer.nsh`](../build/installer.nsh),
so there is one source of truth and the app's own `electron-updater` keeps working unchanged.

Source: [`launcher/`](../launcher/) — a standalone Vite/React UI plus `launcher/src-tauri`.

## Why an external program and not a window inside ArtLux

Because it has to work **before ArtLux exists**, and **when ArtLux is broken**. A welcome screen
inside the app can only ever report on a machine where the app already launched — which was never
the problem. [docs/INSTALL.md](INSTALL.md) is the problem: hunt two uninstall keys, delete orphan
firewall rules, accept UAC, copy `preflight.ps1` onto the venue PC, run it under
`-ExecutionPolicy Bypass`, read a FAIL/WARN table.

The two halves are complementary, and a welcome window inside the editor is still worth having for
the project-picker half. This document covers only the external launcher.

## Contracts

Everything below is something the launcher depends on **from outside the repo**. Changing any of it
breaks a shipped product that this tree does not build. Treat each as an interface, not an
implementation detail.

### 1. The CLI

```
ArtLux.exe --project=<absolute path to a .artlux file>
```

The **only** contract for "open this project": there is no file association, no protocol handler and
no positional-path handling. Parsed in [`src/main/index.ts`](../src/main/index.ts); consumed in the
renderer by an editor-mode boot effect in [`src/renderer/App.tsx`](../src/renderer/App.tsx).

- `--project=` **outranks** the editor's own reopen of `prefs.lastProjectPath`. Both are mount
  effects that await, so without that rule they race and the document is whichever IPC resolved
  last. The precedence lives in two places (the flag's effect, and `!QUERY_PROJECT` on the restore)
  and only works as a pair.
- A **second** launch carrying `--project=` retargets the **running** instance via `second-instance`.
  Callers must know the second process **exits 0** regardless — the single-instance lock swallows it,
  so an exit code proves nothing. Probe for a running `ArtLux.exe` before spawning.
- Other flags: `--headless`, `--broadcast`. Both also accept `--project=`.

Guarded by the `--project= reaches the document in every run mode` check in
[`scripts/verify-invariants.cjs`](../scripts/verify-invariants.cjs).

### 2. Locating an install (the registry gotcha)

electron-builder's NSIS writes **two** keys under a product GUID that is a UUIDv5 of the appId and
therefore **stable across versions** — currently `a096496b-f009-5348-8324-d42f166c5607`:

```
HKLM\SOFTWARE\<GUID>                    InstallLocation = C:\Program Files\ArtLux   ← the real path
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>
    DisplayName          = ArtLux 0.25.0
    DisplayVersion       = 0.25.0
    DisplayIcon          = C:\Program Files\ArtLux\ArtLux.exe,0
    QuietUninstallString = "…\Uninstall ArtLux.exe" /allusers /S
    InstallLocation      = (EMPTY)   ← the obvious lookup returns nothing
```

**`InstallLocation` on the Uninstall key is empty on every install seen.** Resolution order:
product key → `DisplayIcon` (strip the `,0`, take the directory) → `%ProgramFiles%\ArtLux` →
legacy `%LOCALAPPDATA%\Programs\artlux`. Path guesses come last and must be **labelled** as guesses:
reaching them means no registry entry matched, which is a different fact from "installed here".

A per-user install (HKCU, or an `UninstallString` ending `/currentuser`) alongside a per-machine one
is the documented double-install state — Windows will not replace one with the other.

`Find-ArtLuxInstall` in [`scripts/preflight.ps1`](../scripts/preflight.ps1) had exactly this bug and
survived only on its path fallback; it now follows the order above.

### 3. The release feed

Public repo, so unauthenticated works (60 requests/hour/IP — a rate-limit response is a real state to
name, not to spin on).

- `GET https://api.github.com/repos/urbandronedesign/artlux/releases/latest` → the tag.
- `https://github.com/urbandronedesign/artlux/releases/download/<tag>/latest.yml` → `version`,
  `path` (the installer filename) and `sha512`. This is the same metadata `electron-updater`
  consumes, so it is the only correct source for the hash.
- Windows asset name: `ArtLux-<version>-x64.exe` (`${productName}-${version}-${arch}.${ext}`;
  arch is `x64`, not `x86_64`).

> ⚠ **`sha512` is base64, not hex.** Comparing a hex digest fails every download and reads as a
> network problem.

Fetch `latest.yml` from the resolved **tag**, not from `/latest/download`, so metadata and installer
cannot come from two different releases if one is published between the requests.

### 4. Running the installer

`nsis.oneClick` is unset → defaults **true**; `perMachine: true` → the installer's manifest requests
elevation. Therefore `/S` is **silent, not unattended** — Windows still shows UAC.

- Declining UAC fails the spawn with **ERROR_CANCELLED (1223)** and installs **nothing**. This is the
  failure INSTALL.md exists to prevent (no redists, no firewall rules), so it needs its own message,
  never a generic error.
- Never claim success from an exit code: re-read the registry and confirm `ArtLux.exe` is really
  there.
- Do not install over a running `ArtLux.exe`.

### 5. Resources inside an install

```
<InstallDir>\ArtLux.exe
<InstallDir>\resources\scripts\preflight.ps1     ← also bundled by the launcher, for pre-install use
<InstallDir>\resources\scripts\lidar-emitter.cjs
<InstallDir>\resources\examples\<set>\*.artlux   ← the gallery source
<InstallDir>\resources\docs\*.md
```

`preflight.ps1` is fully standalone (no sibling files; an absent repo just makes the `dev.*` checks
SKIP), which is why the launcher can ship its own copy and run it **before** anything is installed.
`-Mode runtime -Json -OutFile <path>` emits
`{ generatedAt, host, mode, summary{pass,warn,fail,skip}, results[{group,id,name,status,detail,remedy}] }`.

> ⚠ Exit code **1** means "some check FAILed", not "the run failed"; **2** means not-Windows.
> Pass `-InstallDir` once the install is known. `Out-File -Encoding utf8` on PowerShell 5.1 writes a
> **BOM** — strip it before parsing, or the installer's own report never loads.

### 6. Prefs (read-only from outside)

`%APPDATA%\artlux\artlux-prefs.json` — `recentFiles` (most-recent-first absolute paths) and
`lastProjectPath`. **Never write it.** It is owned by a running ArtLux and rewritten wholesale on
every save, and a malformed write (a BOM, for instance) makes `readJson` fail and the app silently
reset prefs to defaults — losing layout, shortcuts, UI scale and templates.

## Build

```bash
cd launcher
npm install          # its own tree — NOT a root workspace member, so root `npm ci` stays reproducible
npm start            # tauri dev (Vite on :5173 + the Tauri window)
npm run package      # tauri build → src-tauri/target/release/bundle/nsis/ArtLuxLauncher_<v>_x64-setup.exe
cargo run --bin selftest [--download]   # from src-tauri/ — exercises the core with no GUI
```

Two things in `tauri.conf.json` that look like typos and are not:

- **`productName` is `ArtLuxLauncher`, space-free.** Tauri names the bundle
  `{productName}_{version}_{arch}-setup.exe` and offers no template to override it, and a space in a
  release artifact's filename has already broken this project's publish pipeline once — it is why
  electron-builder's `artifactName` is set and the Windows portable target was dropped
  (DEVELOPMENT.md → Release). The window title and Start Menu entry read "ArtLux Launcher" via
  `app.windows[].title`.
- **`installMode: currentUser`.** The launcher installs per-user so it needs no UAC for *itself*; it
  elevates only when running ArtLux's installer, which is the moment a user understands the prompt.

`tauri.conf.json` is schema-validated and rejects unknown keys, so it cannot carry comments — notes
about it live here.

**The root `tsconfig.json` excludes `launcher`.** It has no `include`, so it typechecks everything
under the repo, and `launcher/src-tauri/target/` fills up with generated JS that is not valid
TypeScript — `npm run verify` at the root started failing on Tauri's codegen assets the moment this
folder existed. The launcher has its own `tsconfig.json`; check it with `npx tsc --noEmit` from
`launcher/`.

Run `cargo run --bin selftest` after touching `install.rs` or `releases.rs`. It fails if detection
ever resolves by **path guess**, which is how the registry gotcha above would silently come back.

## Licence

LICENSE §3 requires the authorship credit and the non-commercial notice to survive in a build. The
launcher is a build, and it is the first screen a venue sees, so it renders `CREDIT_LABEL`,
`AUTHORS_LINE` and `LICENSE_HEADLINE`. Those strings are copied from
[`shared/credits.ts`](../shared/credits.ts) into `launcher/src/brand.tsx` — change them together.
The wordmark comes from `build/wordmark.svg`, whose generator header marks it as the asset for
external use.

## Releasing — and the hazard of two products in one repo

CI lives in [`.github/workflows/launcher.yml`](../.github/workflows/launcher.yml), triggered by a
**`launcher-v*`** tag. Separate from `build.yml` so an app release never rebuilds the launcher and
vice versa; `v*` and `launcher-v*` cannot match each other.

> ⚠ **Launcher releases are published as PRE-RELEASES, and that is load-bearing.** GitHub's
> `/releases/latest` returns whichever release was published most recently, whatever it is — and
> **ArtLux's own electron-updater keys off that endpoint**, then fetches `latest.yml` from the tag it
> names. A launcher release published normally would make every installed ArtLux look for app
> metadata on a launcher tag and fail its update check, in the field, silently. Pre-releases are
> excluded from `latest`, which is exactly the property needed.
>
> The launcher does not rely on that alone: it lists releases and filters by **tag shape**
> (`is_app_tag`), never trusting the ordering. Both defences, because either one alone is a single
> point of failure for something that breaks remotely.

Release: bump `version` in **both** `launcher/package.json` and `launcher/src-tauri/Cargo.toml`
(Tauri reads the former for the bundle, Cargo the latter for `own_version()`), then
`git tag launcher-v0.1.1 && git push origin launcher-v0.1.1`.

CI writes **`launcher-latest.yml`** beside the installer, in the same shape electron-builder uses for
the app — `version`, `path`, base64 `sha512`, `size`. One metadata format in the codebase, and the
launcher's self-update reuses the verified-download path it already uses for ArtLux.

**Self-update is not Tauri's updater plugin**, deliberately. The plugin would work and would mean a
signing keypair whose private half lives in CI secrets and whose public half is baked into the
binary — real infrastructure to stand up and keep correct. The launcher already resolves a release,
verifies a base64 sha512 and runs an installer, all of it exercised, so reusing that gets a verified
update with no new secret to manage. The plugin is the upgrade path if silent background updates are
ever wanted; the `__TAURI_BUNDLE_TYPE variable not found` warning in the build output is that
plugin's, and is inert while it is unused.

## Status

| Stage | What | State |
|---|---|---|
| 0 | ArtLux-side prerequisites (`--project=` in the editor, `second-instance` argv, preflight fixes) | **done** |
| 1 | Install: detect · resolve · verified download · elevated run | **done** |
| 2 | Projects: library roots, cancellable scan, recents merge, open via `--project=` | **done** |
| 3 | Examples: derived sets, whole-set copy to a writable workspace, then open | **done** |
| 4 | Health: run `preflight.ps1`, triage as data, repair via `-Fix` | **done** |
| 5 | CI on `launcher-v*`, self-update | **done** |

**Code signing: decided — both products stay unsigned.** `build.yml` sets
`CSC_IDENTITY_AUTO_DISCOVERY: 'false'`, there is no Authenticode step, and none is planned: a
certificate is a recurring cost and an annual renewal for a project that takes no money. SmartScreen
therefore warns on first run of both the app and the launcher; the procedure is in
[INSTALL.md](INSTALL.md#windows-smartscreen--the-warning-you-will-see-first) and is permanent.

Two consequences worth holding on to, because they change what the code owes the user:

- **The sha512 comparison is the only integrity guarantee this project has.** With no signature,
  `download.rs` refusing a mismatched file is not belt-and-braces — it is the entire mechanism, and
  it is why that refusal is a hard error that deletes the file rather than a warning.
- **The launcher is the safer way to install**, and can be recommended as such: it verifies every
  download automatically, where a human downloading the `.exe` by hand has to remember to.
