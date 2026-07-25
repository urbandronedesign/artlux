//! Finding an existing ArtLux install, and running the downloaded installer.
//!
//! THE REGISTRY GOTCHA, verified against a live 0.25.0 install: electron-builder's NSIS writes the
//! Uninstall entry with an **empty** `InstallLocation`, and puts the real path in
//!   HK__\SOFTWARE\<product-guid>\InstallLocation
//! where `<product-guid>` is the Uninstall subkey's own name (a UUIDv5 of the appId, so it is stable
//! across versions). Anything that reads `InstallLocation` off the Uninstall key -- which is the
//! obvious thing to do, and what ArtLux's own preflight.ps1 did until this work -- finds nothing and
//! silently falls back to guessing `%ProgramFiles%\ArtLux`. That guess returns the FIRST path that
//! exists, so on a machine carrying both a legacy per-user install and a current per-machine one it
//! names the wrong directory with no error.
//!
//! THE LEGACY STATE is the reason this module reports a list rather than one answer. Releases before
//! 2026-07-22 installed per-user to %LOCALAPPDATA%\Programs\artlux with an `UninstallString` ending
//! `/currentuser`; Windows treats per-user and per-machine as different products, so it will not
//! replace one with the other. The result is two installs and two Start Menu entries, and naming that
//! state is the single most useful thing this launcher does that nothing inside the app can.

use serde::Serialize;
use std::path::{Path, PathBuf};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

/// One ArtLux install found on this machine.
#[derive(Debug, Clone, Serialize)]
pub struct InstallInfo {
    /// Absolute install directory, e.g. `C:\Program Files\ArtLux`.
    pub dir: String,
    /// Absolute path to ArtLux.exe inside `dir`. Always verified to exist.
    pub exe: String,
    /// `DisplayVersion`, e.g. `0.25.0`. Empty when the key carried none.
    pub version: String,
    /// True when this install is per-user (HKCU / an UninstallString ending `/currentuser`).
    pub per_user: bool,
    /// `QuietUninstallString`, so the UI can offer to remove a legacy install without a prompt.
    pub quiet_uninstall: String,
    /// How this install was located -- surfaced in the UI so a fallback guess is never mistaken for
    /// a registry fact.
    pub found_by: String,
}

/// What the machine looks like: every install found, newest-first is not assumed -- the UI decides.
#[derive(Debug, Clone, Serialize)]
pub struct InstallScan {
    pub installs: Vec<InstallInfo>,
    /// True when a per-user AND a per-machine install both exist: the documented double-install
    /// state, which Windows will not resolve on its own.
    pub duplicate: bool,
}

const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

/// `DisplayIcon` is `<dir>\ArtLux.exe,0` -- drop the icon index and take the directory.
fn dir_from_display_icon(icon: &str) -> Option<PathBuf> {
    let exe = icon.split(',').next()?.trim().trim_matches('"');
    let p = Path::new(exe);
    if p.is_file() { p.parent().map(|d| d.to_path_buf()) } else { None }
}

/// A directory only counts as an install if ArtLux.exe is actually in it. A registry entry left by a
/// failed or half-removed install otherwise reads as a working one.
fn accept(dir: PathBuf, version: String, per_user: bool, quiet: String, found_by: &str) -> Option<InstallInfo> {
    let exe = dir.join("ArtLux.exe");
    if !exe.is_file() {
        return None;
    }
    Some(InstallInfo {
        dir: dir.to_string_lossy().into_owned(),
        exe: exe.to_string_lossy().into_owned(),
        version,
        per_user,
        quiet_uninstall: quiet,
        found_by: found_by.to_string(),
    })
}

/// Read one hive's Uninstall entries, resolving each ArtLux entry to a directory.
fn scan_hive(hive: winreg::HKEY, wow: bool) -> Vec<InstallInfo> {
    let mut out = Vec::new();
    let root = RegKey::predef(hive);
    let base = if wow { format!(r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall") } else { UNINSTALL.to_string() };
    let Ok(uninstall) = root.open_subkey_with_flags(&base, KEY_READ) else { return out };

    for name in uninstall.enum_keys().flatten() {
        let Ok(entry) = uninstall.open_subkey_with_flags(&name, KEY_READ) else { continue };
        let display: String = entry.get_value("DisplayName").unwrap_or_default();
        if !display.starts_with("ArtLux") {
            continue;
        }
        let version: String = entry.get_value("DisplayVersion").unwrap_or_default();
        let quiet: String = entry.get_value("QuietUninstallString").unwrap_or_default();
        let uninstall_str: String = entry.get_value("UninstallString").unwrap_or_default();
        // Per-user is what the UninstallString says, not which hive we are reading: a per-user
        // install writes `/currentuser` there, and that is the flag that decides whether Windows can
        // replace it with a per-machine one.
        let per_user = hive == HKEY_CURRENT_USER || uninstall_str.contains("/currentuser");

        // 1. InstallLocation on the Uninstall entry. Empty on every install seen so far, but honour
        //    it if a future installer ever populates it.
        let loc: String = entry.get_value("InstallLocation").unwrap_or_default();
        if !loc.is_empty() {
            if let Some(i) = accept(PathBuf::from(&loc), version.clone(), per_user, quiet.clone(), "uninstall key InstallLocation") {
                out.push(i);
                continue;
            }
        }
        // 2. The PRODUCT key named after this Uninstall subkey. This is where the path actually is.
        let product_base = if wow { format!(r"SOFTWARE\WOW6432Node\{name}") } else { format!(r"SOFTWARE\{name}") };
        if let Ok(product) = root.open_subkey_with_flags(&product_base, KEY_READ) {
            let ploc: String = product.get_value("InstallLocation").unwrap_or_default();
            if !ploc.is_empty() {
                if let Some(i) = accept(PathBuf::from(&ploc), version.clone(), per_user, quiet.clone(), "product key InstallLocation") {
                    out.push(i);
                    continue;
                }
            }
        }
        // 3. DisplayIcon, which carries the exe path.
        let icon: String = entry.get_value("DisplayIcon").unwrap_or_default();
        if let Some(dir) = dir_from_display_icon(&icon) {
            if let Some(i) = accept(dir, version.clone(), per_user, quiet.clone(), "DisplayIcon") {
                out.push(i);
            }
        }
    }
    out
}

/// Every ArtLux install this machine can see.
///
/// Path guesses come LAST and are labelled as guesses, because reaching them means no registry entry
/// matched -- which is a different fact from "installed here", and the UI must not present the two
/// the same way.
pub fn scan() -> InstallScan {
    let mut installs = scan_hive(HKEY_LOCAL_MACHINE, false);
    installs.extend(scan_hive(HKEY_CURRENT_USER, false));
    installs.extend(scan_hive(HKEY_LOCAL_MACHINE, true));

    if installs.is_empty() {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let pf = std::env::var("ProgramFiles").unwrap_or_default();
        for (guess, per_user) in [
            (format!(r"{local}\Programs\ArtLux"), true),
            (format!(r"{local}\Programs\artlux"), true),
            (format!(r"{pf}\ArtLux"), false),
        ] {
            if guess.starts_with('\\') {
                continue; // the env var was missing; do not probe a relative path
            }
            if let Some(i) = accept(PathBuf::from(&guess), String::new(), per_user, String::new(), "path guess (no registry entry)") {
                installs.push(i);
                break;
            }
        }
    }

    // Same directory reached from two hives is one install, not two.
    installs.dedup_by(|a, b| a.dir.eq_ignore_ascii_case(&b.dir));
    let duplicate = installs.iter().any(|i| i.per_user) && installs.iter().any(|i| !i.per_user);
    InstallScan { installs, duplicate }
}
