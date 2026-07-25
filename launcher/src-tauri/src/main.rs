// ArtLux Launcher — the thing you download.
//
// It installs ArtLux and its prerequisites, verifies the machine, and (later stages) finds your
// projects and ships the example gallery. It is a FRONT-END to the existing NSIS installer, never a
// replacement: NDI runtime, VC++ redist, firewall rules and the post-install preflight all stay in
// build/installer.nsh, so there is one source of truth and the app's own electron-updater keeps
// working unchanged.
//
// Windows only. The installation pain this exists to remove — NDI, VC++, firewall rules, the
// per-user→per-machine migration, preflight.ps1 — is entirely Windows; the mac dmg and the Linux
// AppImage have none of it.
//
// This file is the TAURI SHELL ONLY. Every behaviour lives in the library (see lib.rs) so it can be
// exercised without a GUI; the commands below are a thin transport layer over it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use artlux_launcher::{download, install, projects, releases, runner};
use tauri::{AppHandle, Emitter};

/// Every ArtLux install on this machine, plus whether the legacy double-install state is present.
#[tauri::command]
fn scan_installs() -> install::InstallScan {
    install::scan()
}

/// Is ArtLux running right now? The UI asks before offering to install over it.
#[tauri::command]
fn artlux_running() -> bool {
    runner::artlux_running()
}

/// What the latest published release is, with the checksum needed to verify its installer.
#[tauri::command]
async fn resolve_latest() -> Result<releases::ReleaseInfo, String> {
    releases::resolve_latest().await
}

/// Semver comparison in Rust, so the UI cannot accidentally string-compare ("0.9.0" > "0.25.0").
#[tauri::command]
fn is_newer(latest: String, installed: String) -> bool {
    releases::is_newer(&latest, &installed)
}

/// Download and verify. Returns a path only for a file whose sha512 matched.
#[tauri::command]
async fn download_installer(
    app: AppHandle,
    url: String,
    file: String,
    sha512_b64: String,
    size: u64,
) -> Result<String, String> {
    download::fetch_verified(
        move |p| { let _ = app.emit("download://progress", p); },
        url,
        file,
        sha512_b64,
        size,
    )
    .await
}

#[tauri::command]
fn cancel_download() {
    download::request_cancel();
}

/// Run a verified installer. Takes only a path produced by download_installer.
#[tauri::command]
fn run_installer(path: String) -> runner::InstallOutcome {
    runner::run_installer(&path)
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

#[tauri::command]
fn get_config() -> projects::Config {
    projects::load_config()
}

#[tauri::command]
fn set_config(config: projects::Config) -> Result<(), String> {
    projects::save_config(&config)
}

/// The roots actually in effect — configured, or the OS defaults when never configured. Separate
/// from get_config so the UI can SHOW the defaults without writing them into the config file: a
/// baked-in default is wrong forever once the user's Documents folder moves.
#[tauri::command]
fn get_effective_roots() -> Vec<String> {
    projects::effective_roots(&projects::load_config())
}

/// Walk the library roots. Runs on a blocking thread — it is filesystem-bound and would otherwise
/// stall the async runtime that the download shares.
#[tauri::command]
async fn scan_projects(app: AppHandle) -> Result<projects::ScanResult, String> {
    let roots = projects::effective_roots(&projects::load_config());
    tauri::async_runtime::spawn_blocking(move || {
        projects::scan(&roots, move |p| {
            let _ = app.emit("projects://progress", p);
        })
    })
    .await
    .map_err(|e| format!("the scan could not be started: {e}"))
}

#[tauri::command]
fn cancel_scan() {
    projects::request_cancel();
}

/// ArtLux's own recent files, read-only, dead paths pruned.
#[tauri::command]
fn recent_projects() -> Vec<projects::ProjectEntry> {
    projects::recents()
}

/// Open a project in the installed ArtLux.
#[tauri::command]
fn open_project(exe: String, project: String) -> runner::OpenOutcome {
    runner::open_project(&exe, &project)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_installs,
            artlux_running,
            resolve_latest,
            is_newer,
            download_installer,
            cancel_download,
            run_installer,
            get_config,
            set_config,
            get_effective_roots,
            scan_projects,
            cancel_scan,
            recent_projects,
            open_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the ArtLux Launcher");
}
