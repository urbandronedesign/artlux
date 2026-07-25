//! The machine check: running ArtLux's own `preflight.ps1` and reading it honestly.
//!
//! The script is the app's, not a reimplementation -- one source of truth for what a working ArtLux
//! machine looks like. The launcher bundles a copy so it can run BEFORE anything is installed, and
//! prefers the installed copy once there is one, so the check always matches the app version.
//!
//! FOUR WAYS THIS GOES WRONG SILENTLY, all handled here:
//!
//!   1. EXIT CODE 1 MEANS "some check FAILed", not "the run failed". Treating a non-zero exit as an
//!      error turns the most useful possible report -- the one listing what is broken -- into
//!      "could not run the check". Exit 2 is the real failure (not Windows).
//!   2. PowerShell 5.1 writes a BOM. `Out-File -Encoding utf8` prefixes ﻿ and every JSON parser
//!      rejects it. The installer writes the cached report with that function, so this is the path
//!      that makes the FIRST launch after an install useful -- and it fails where nobody looks.
//!   3. ConvertTo-Json collapses a single-element array to a scalar, so a machine with exactly one
//!      result would deserialise as "not an array" and report nothing.
//!   4. A visible console window. `powershell.exe` from a GUI app flashes a black box; from an
//!      installer-shaped app that reads as malware.

use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightItem {
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// PASS | WARN | FAIL | SKIP
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub remedy: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Summary {
    #[serde(default)]
    pub pass: u32,
    #[serde(default)]
    pub warn: u32,
    #[serde(default)]
    pub fail: u32,
    #[serde(default)]
    pub skip: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightReport {
    /// DESERIALIZE-only rename. A plain `rename` applies in both directions, so the field arrived
    /// correctly from PowerShell's `generatedAt` and then went out to the UI as `generatedAt` too --
    /// while the TypeScript read `generated_at` and quietly got undefined, so the report rendered
    /// with no date and no error. Renaming one direction keeps the wire name on each side right.
    #[serde(rename(deserialize = "generatedAt"), default)]
    pub generated_at: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub summary: Summary,
    #[serde(default)]
    pub results: Vec<PreflightItem>,
    /// Where this came from — "run" or the cache file. Shown, so a stale report is never mistaken
    /// for a fresh one.
    #[serde(default)]
    pub from: String,
}

/// `%APPDATA%\artlux\preflight.json` — the same file the NSIS installer writes on every install.
/// Sharing it means the very first launch after an install already has a real report.
pub fn cache_file() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("artlux").join("preflight.json")
}

/// Strip a UTF-8 BOM. See hazard 2 above.
fn debom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

/// Parse a report, tolerating every shape a shipped preflight.ps1 can emit.
///
/// ⚠ THE INSTALLED SCRIPT IS OFTEN OLDER THAN THIS LAUNCHER, and that is the normal case, not an
/// edge one: the launcher ships on its own cadence and prefers the copy inside whatever ArtLux is
/// installed. Versions up to 0.25.0 print a three-line banner with Write-Host BEFORE the JSON even
/// under `-Json` -- invisible in-process, but squarely in stdout for a child process, which is the
/// only way anything outside the repo runs it. Parsing strictly meant a live run silently fell back
/// to reading the cache file, so the data was fresh and the LABEL said "cache".
///
/// So: skip anything before the first `{`. A launcher that only worked against a script newer than
/// every published release would be useless on exactly the machines it exists for.
fn parse(text: &str, from: &str) -> Result<PreflightReport, String> {
    let cleaned = debom(text.trim());
    let json = match cleaned.find('{') {
        Some(0) => cleaned,
        Some(i) => &cleaned[i..],
        None => return Err("the check produced no JSON at all".into()),
    };
    let mut v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("the check produced something that is not JSON: {e}"))?;

    // Hazard 3: a single result comes back as an object, not a one-element array.
    if let Some(obj) = v.as_object_mut() {
        match obj.get("results") {
            Some(r) if !r.is_array() => {
                let single = r.clone();
                obj.insert("results".into(), serde_json::Value::Array(vec![single]));
            }
            None => {
                obj.insert("results".into(), serde_json::Value::Array(vec![]));
            }
            _ => {}
        }
    }
    let mut report: PreflightReport =
        serde_json::from_value(v).map_err(|e| format!("the check's report was not the expected shape: {e}"))?;
    report.from = from.to_string();
    Ok(report)
}

/// The last report on disk, if any. Instant, and usually written by the installer itself.
pub fn read_cached() -> Option<PreflightReport> {
    let p = cache_file();
    let text = std::fs::read_to_string(&p).ok()?;
    parse(&text, "cache").ok()
}

/// Is winget on PATH? `-Fix` uses it and does nothing without it, so the button must not be offered.
pub fn winget_available() -> bool {
    Command::new("where")
        .arg("winget")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run the read-only machine check.
///
/// `-Mode runtime`, never `all`: the Dev group (rustc, cmake, node_modules) is meaningless on a
/// venue PC and would render as a wall of FAILs about a repo that is not there.
pub fn run(script: &Path, install_dir: Option<&str>) -> Result<PreflightReport, String> {
    if !script.is_file() {
        return Err(format!("the machine-check script is missing: {}", script.display()));
    }
    let out_file = cache_file();
    let mut args: Vec<String> = vec![
        "-NoProfile".into(),
        // Without this a PowerShell profile that prompts would hang the child forever, with no UI
        // and nothing to cancel.
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        script.to_string_lossy().into_owned(),
        "-Mode".into(),
        "runtime".into(),
        "-Json".into(),
        "-OutFile".into(),
        out_file.to_string_lossy().into_owned(),
    ];
    // Hand the script the install we already resolved from the registry, so its own lookup -- which
    // reads InstallLocation off the Uninstall key, where it is empty -- cannot pick the wrong one.
    if let Some(d) = install_dir {
        if !d.is_empty() {
            args.push("-InstallDir".into());
            args.push(d.to_string());
        }
    }

    let out = Command::new("powershell.exe")
        .args(&args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("could not start the machine check: {e}"))?;

    // Hazard 1: exit 1 is a RESULT. Parse first, and only call it a failure if there is no report.
    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Ok(r) = parse(&stdout, "run") {
        return Ok(r);
    }
    // stdout unusable — the script still wrote -OutFile, so try that before giving up. Labelled
    // "run", not "cache": we just ran it, so the file IS this run's output, and calling it a cached
    // report would tell the operator their fresh check was stale.
    if let Some(mut r) = read_cached() {
        r.from = "run".into();
        return Ok(r);
    }
    let code = out.status.code().unwrap_or(-1);
    if code == 2 {
        return Err("the machine check only runs on Windows".into());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(format!(
        "the machine check did not produce a report (exit {code}). {}",
        stderr.lines().next().unwrap_or("").trim()
    ))
}

/// Run the script's own `-Fix`, elevated and VISIBLE.
///
/// Visible on purpose: winget raises its own prompts and prints its own progress, and that progress
/// is the only honest signal available. We do not capture its output and we do not claim anything
/// from its exit code -- the caller re-runs the read-only check and diffs. See runner.rs for why
/// elevation goes through the shell rather than CreateProcess.
pub fn repair(script: &Path) -> Result<(), String> {
    if !script.is_file() {
        return Err(format!("the machine-check script is missing: {}", script.display()));
    }
    let args = format!(
        "-NoProfile -ExecutionPolicy Bypass -File \"{}\" -Mode runtime -Fix",
        script.display()
    );
    crate::runner::run_elevated_visible("powershell.exe", &args)
}
