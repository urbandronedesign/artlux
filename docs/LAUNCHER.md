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

## Status

| Stage | What | State |
|---|---|---|
| 0 | ArtLux-side prerequisites (`--project=` in the editor, `second-instance` argv, preflight fixes) | **done** |
| 1 | Install: detect · resolve · verified download · run | **in progress** |
| 2 | Projects: library roots, disk scan, open via `--project=` | planned |
| 3 | Examples: copy a set to a writable workspace, then open | planned |
| 4 | Health: run `preflight.ps1`, triage as UI, repair via `-Fix` | planned |

Not yet decided: **code signing.** `.github/workflows/build.yml` sets
`CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and there is no Authenticode step, so ArtLux ships unsigned
today. The launcher becomes the first thing a venue runs, so this needs a deliberate answer — sign
it, or document the SmartScreen path in INSTALL.md.
