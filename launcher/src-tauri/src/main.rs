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

use artlux_launcher::{download, examples, install, preflight, projects, releases, runner};
use tauri::Manager;
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

/// This launcher's own version, and the newest one published — so it can update itself with the
/// same verified-download path it uses for ArtLux, rather than a second update mechanism.
#[tauri::command]
fn launcher_version() -> &'static str {
    releases::own_version()
}

#[tauri::command]
async fn launcher_latest() -> Result<releases::ReleaseInfo, String> {
    releases::resolve_launcher_latest().await
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

/// Remove an install by its registry uninstall command. Offered for the legacy per-user install
/// that a per-machine installer cannot replace.
#[tauri::command]
async fn uninstall_install(quiet_uninstall: String) -> runner::InstallOutcome {
    tauri::async_runtime::spawn_blocking(move || runner::uninstall(&quiet_uninstall))
        .await
        .unwrap_or_else(|e| runner::InstallOutcome {
            ok: false,
            message: format!("The uninstall could not be started: {e}"),
            scan: install::scan(),
        })
}

// ---------------------------------------------------------------------------------------------
// Library folders
// ---------------------------------------------------------------------------------------------

/// Ask the user for a folder.
///
/// The DIALOG LIVES IN RUST, not behind a JS capability. The web layer is granted no filesystem
/// access at all (see docs/LAUNCHER.md), and that stays true: this returns a path the *user* chose,
/// to be used as a search root or a workspace — never as something to execute.
#[tauri::command]
async fn pick_folder(app: AppHandle, title: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().set_title(&title).pick_folder(move |p| {
        let _ = tx.send(p.map(|p| p.to_string()));
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
}

/// Add a search folder. Writing `library_roots` for the first time BAKES the current defaults in
/// alongside it — deliberately: once the user curates the list they own it, and silently re-adding
/// an OS default they later removed would be the launcher arguing with them.
#[tauri::command]
fn add_library_root(path: String) -> Result<Vec<String>, String> {
    let mut cfg = projects::load_config();
    let mut roots = projects::effective_roots(&cfg);
    if !roots.iter().any(|r| r.eq_ignore_ascii_case(&path)) {
        roots.push(path);
    }
    cfg.library_roots = Some(roots.clone());
    projects::save_config(&cfg)?;
    Ok(roots)
}

/// Remove a search folder. An empty list is a real state — "look nowhere" — and must not be
/// mistaken for "never configured", which is why Config stores Option<Vec<_>> rather than Vec<_>.
#[tauri::command]
fn remove_library_root(path: String) -> Result<Vec<String>, String> {
    let mut cfg = projects::load_config();
    let roots: Vec<String> = projects::effective_roots(&cfg)
        .into_iter()
        .filter(|r| !r.eq_ignore_ascii_case(&path))
        .collect();
    cfg.library_roots = Some(roots.clone());
    projects::save_config(&cfg)?;
    Ok(roots)
}

/// Forget the curated list and go back to the OS folders. Clears the field rather than writing the
/// defaults into it, so a later change of Documents location is still followed.
#[tauri::command]
fn reset_library_roots() -> Result<Vec<String>, String> {
    let mut cfg = projects::load_config();
    cfg.library_roots = None;
    projects::save_config(&cfg)?;
    Ok(projects::effective_roots(&cfg))
}

/// Where example copies land.
#[tauri::command]
fn set_workspace(path: String) -> Result<String, String> {
    let mut cfg = projects::load_config();
    cfg.workspace_dir = Some(path.clone());
    projects::save_config(&cfg)?;
    Ok(path)
}

/// Open a project in the installed ArtLux.
#[tauri::command]
fn open_project(exe: String, project: String) -> runner::OpenOutcome {
    runner::open_project(&exe, &project)
}

// ---------------------------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------------------------

/// The example sets inside an install. Empty when ArtLux is not installed yet — the tab says so
/// rather than showing an unexplained blank.
#[tauri::command]
fn list_examples(install_dir: String) -> Vec<examples::ExampleSet> {
    examples::list(&install_dir)
}

/// Where copies land. Computed, never written into the config until the user changes it: a baked-in
/// default is wrong forever once Documents moves.
#[tauri::command]
fn get_workspace() -> String {
    let cfg = projects::load_config();
    cfg.workspace_dir
        .unwrap_or_else(|| examples::default_workspace().to_string_lossy().into_owned())
}

/// Copy a set into the workspace, then hand back the project to open.
///
/// Also ADDS the workspace to the library roots if no root already covers it. Without that the
/// projects the user just created never appear under Projects, which reads as "the launcher is
/// broken" rather than "the folder is not being watched".
#[tauri::command]
fn copy_example(install_dir: String, set_id: String, project: String) -> Result<examples::CopyResult, String> {
    let mut cfg = projects::load_config();
    let ws = cfg
        .workspace_dir
        .clone()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(examples::default_workspace);

    let res = examples::copy_set(&install_dir, &set_id, &project, &ws)?;

    let ws_str = ws.to_string_lossy().to_ascii_lowercase();
    let roots = projects::effective_roots(&cfg);
    let covered = roots.iter().any(|r| ws_str.starts_with(&r.to_ascii_lowercase()));
    if !covered {
        let mut next = roots;
        next.push(ws.to_string_lossy().into_owned());
        cfg.library_roots = Some(next);
        let _ = projects::save_config(&cfg);
    }
    Ok(res)
}

// ---------------------------------------------------------------------------------------------
// Health (the machine check)
// ---------------------------------------------------------------------------------------------

/// Which preflight.ps1 to run.
///
/// PREFER THE INSTALLED COPY so the check always matches the app version; fall back to the one this
/// launcher bundles, which is the whole reason a machine can be checked BEFORE anything is
/// installed. Returning the bundled path when nothing is installed is not a degraded mode -- it is
/// the primary use case.
fn preflight_script(app: &AppHandle, install_dir: &str) -> Option<std::path::PathBuf> {
    if !install_dir.is_empty() {
        let installed = std::path::Path::new(install_dir)
            .join("resources").join("scripts").join("preflight.ps1");
        if installed.is_file() {
            return Some(installed);
        }
    }
    app.path().resolve("resources/preflight.ps1", tauri::path::BaseDirectory::Resource).ok()
}

#[derive(serde::Serialize)]
struct HealthState {
    /// False on a machine where no script can be found at all — the tab hides rather than erroring.
    available: bool,
    winget: bool,
    script: String,
}

#[tauri::command]
fn health_state(app: AppHandle, install_dir: String) -> HealthState {
    let script = preflight_script(&app, &install_dir);
    HealthState {
        available: script.as_ref().map(|p| p.is_file()).unwrap_or(false),
        winget: preflight::winget_available(),
        script: script.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

/// The last report on disk — usually written by the installer itself, so the first launch after an
/// install already has something real to show without waiting 20 seconds.
#[tauri::command]
fn health_cached() -> Option<preflight::PreflightReport> {
    preflight::read_cached()
}

#[tauri::command]
async fn health_run(app: AppHandle, install_dir: String) -> Result<preflight::PreflightReport, String> {
    let script = preflight_script(&app, &install_dir).ok_or("the machine-check script could not be located")?;
    let dir = if install_dir.is_empty() { None } else { Some(install_dir) };
    // Blocking: it shells out to PowerShell for up to ~20s and must not sit on the async runtime.
    tauri::async_runtime::spawn_blocking(move || preflight::run(&script, dir.as_deref()))
        .await
        .map_err(|e| format!("the machine check could not be started: {e}"))?
}

/// Run the script's own -Fix, elevated and visible. Deliberately returns nothing about what it
/// installed: the caller re-runs the read-only check and diffs, because an exit code we did not
/// read is not evidence.
#[tauri::command]
async fn health_repair(app: AppHandle, install_dir: String) -> Result<(), String> {
    let script = preflight_script(&app, &install_dir).ok_or("the machine-check script could not be located")?;
    tauri::async_runtime::spawn_blocking(move || preflight::repair(&script))
        .await
        .map_err(|e| format!("the repair could not be started: {e}"))?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            list_examples,
            get_workspace,
            copy_example,
            health_state,
            health_cached,
            health_run,
            health_repair,
            launcher_version,
            launcher_latest,
            uninstall_install,
            pick_folder,
            add_library_root,
            remove_library_root,
            reset_library_roots,
            set_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the ArtLux Launcher");
}
