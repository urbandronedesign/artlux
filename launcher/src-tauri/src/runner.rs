//! Running the verified installer, and telling the truth about what happened.
//!
//! `nsis.oneClick` is unset in ArtLux's electron-builder config, so it defaults to **true**, and
//! `perMachine: true` means the installer's manifest requests elevation. Therefore:
//!
//!   * `/S` is silent, NOT unattended -- Windows still shows a UAC prompt.
//!   * Declining that prompt returns ERROR_CANCELLED (1223) and installs NOTHING.
//!
//! That second case is the failure docs/INSTALL.md exists to prevent: a declined UAC produces an
//! install with no VC++ redist and no firewall rules, and reporting it as a generic error is how it
//! goes unnoticed. It gets its own message here.
//!
//! ⚠ **ShellExecuteEx, not `std::process::Command`.** Command uses CreateProcessW, which does NOT
//! raise the UAC prompt: handed an executable whose manifest requires elevation it simply fails with
//! ERROR_ELEVATION_REQUIRED (740) and no prompt is ever shown. This module was written with Command
//! first and did exactly that -- it compiled, ran, returned an error in under a second, and could
//! never have installed anything. The elevation prompt is a *shell* behaviour, so it takes the shell
//! API with the `runas` verb.
//!
//! And success is never claimed from an exit code alone -- we re-read the registry and confirm
//! ArtLux.exe is really where it should be.

use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::process::Command;
use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED as WIN_ERROR_CANCELLED};
use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
use windows::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::install;

/// Do not flash a console window from a GUI app.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Windows: "this needs elevation" — see run_elevated for why CreateProcess returns it rather than
/// raising a prompt.
const ERROR_ELEVATION_REQUIRED: i32 = 740;

/// The first ArtLux release that parses `--calibrate`. Not a guess: the flag arrived with the commit
/// that made calibration a launch profile (src/main/runProfile.ts), and `git tag --contains` puts
/// that commit in v0.25.1 and no earlier tag. An older app IGNORES an unknown flag entirely — it
/// opens the project, in the ordinary editor, looking exactly like success — so this is checked
/// before the spawn rather than discovered at the venue.
const MIN_CALIBRATE_VERSION: &str = "0.25.1";

/// WHICH ARTLUX A PROJECT OPENS IN.
///
/// Calibration is a **launch profile** in ArtLux, not a preference and not a runtime toggle: the
/// calibration plugin is activated once per window at load, in the editor AND in every projector
/// window it spawns, so a mid-session switch would leave the two disagreeing (src/main/runProfile.ts
/// carries the full reasoning). The app's own File ▸ Open Calibration Workbench… therefore *saves
/// and restarts itself*. Choosing the mode out here means a machine that is going to be aligned
/// starts aligned — one launch instead of a launch and a restart.
///
/// Normal contributes NO flags, so an ordinary open stays byte-identical to what it was before this
/// existed. That is deliberate: the default path must not change shape because a second option
/// appeared beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    /// The editor as it ships. No calibration plugin, so an open projector output stays cheap.
    #[default]
    Normal,
    /// `--calibrate`: the alignment workbench — the wizards, the camera, OpenCV, and the live venue
    /// render you align a solve against.
    Calibrate,
}

impl LaunchMode {
    /// The argv this mode adds after `--project=`. Public so the self-test can assert the rule that
    /// Normal adds nothing, rather than restating it and drifting.
    pub fn flags(self) -> &'static [&'static str] {
        match self {
            LaunchMode::Normal => &[],
            LaunchMode::Calibrate => &["--calibrate"],
        }
    }

    /// What to call it in a sentence an operator reads.
    fn label(self) -> &'static str {
        match self {
            LaunchMode::Normal => "the editor",
            LaunchMode::Calibrate => "the calibration workbench",
        }
    }

    /// Is this install too old to understand the mode? Empty/unparseable versions answer **false**:
    /// an install found by path guess carries no version, and blocking the operator on a guess is
    /// worse than letting a flag be ignored. Same doctrine as `is_newer` and `artlux_running`.
    pub fn too_old(self, installed: &str) -> bool {
        match self {
            LaunchMode::Normal => false,
            LaunchMode::Calibrate => crate::releases::is_newer(MIN_CALIBRATE_VERSION, installed),
        }
    }
}

/// Outcome of asking the shell to run something elevated.
enum Elevated {
    /// The process ran to completion with this exit code.
    Exited(u32),
    /// The user declined the UAC prompt. Nothing was installed.
    Declined,
    /// The shell refused for some other reason.
    Failed(String),
}

/// Elevate something and wait, reporting only whether it ran — for callers that must not infer
/// success from an exit code. The machine-check repair uses this: winget prints its own progress and
/// raises its own prompts, so the honest thing is to let the user watch it and then re-measure.
pub fn run_elevated_visible(path: &str, args: &str) -> Result<(), String> {
    match run_elevated(path, args) {
        Elevated::Exited(_) => Ok(()),
        Elevated::Declined => Err("The administrator prompt was declined, so nothing was installed.".into()),
        Elevated::Failed(why) => Err(why),
    }
}

/// Run `path args` elevated, and WAIT for it.
///
/// SEE_MASK_NOCLOSEPROCESS is what makes waiting possible at all -- without it ShellExecuteEx does
/// not hand back a process handle and "did the install finish?" becomes unanswerable.
fn run_elevated(path: &str, args: &str) -> Elevated {
    let verb = HSTRING::from("runas");
    let file = HSTRING::from(path);
    let params = HSTRING::from(args);

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: windows::core::PCWSTR(verb.as_ptr()),
        lpFile: windows::core::PCWSTR(file.as_ptr()),
        lpParameters: windows::core::PCWSTR(params.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };

    unsafe {
        if ShellExecuteExW(&mut info).is_err() {
            let e = GetLastError();
            return if e == WIN_ERROR_CANCELLED {
                Elevated::Declined
            } else {
                Elevated::Failed(format!("the shell could not start the installer (Windows error {})", e.0))
            };
        }
        if info.hProcess.is_invalid() {
            // Started, but we cannot observe it -- so we must not claim anything about the result.
            return Elevated::Failed("the installer started but Windows returned no handle to wait on".into());
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code: u32 = 0;
        let got = GetExitCodeProcess(info.hProcess, &mut code).is_ok();
        let _ = CloseHandle(info.hProcess);
        if got {
            Elevated::Exited(code)
        } else {
            Elevated::Failed("the installer finished but its exit code could not be read".into())
        }
    }
}

#[derive(Debug, Serialize)]
pub struct InstallOutcome {
    pub ok: bool,
    pub message: String,
    /// The machine as it looks AFTER the attempt, so the UI never has to guess.
    pub scan: install::InstallScan,
}

/// True if any ArtLux process is running. The installer cannot replace files that are in use, and
/// "installing over a running app" fails in confusing, partial ways.
pub fn artlux_running() -> bool {
    // tasklist rather than a process-enumeration crate: one dependency fewer for one question, and
    // its output is stable enough for an exact-name filter.
    let out = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq ArtLux.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("ArtLux.exe"),
        Err(_) => false, // cannot tell -> do not block the user on a guess
    }
}

#[derive(Debug, Serialize)]
pub struct OpenOutcome {
    pub ok: bool,
    pub message: String,
    /// False when an ArtLux was already up and we retargeted it instead of starting one.
    pub started_new: bool,
    /// Did the project actually open in the mode that was asked for?
    ///
    /// SEPARATE FROM `ok` ON PURPOSE. "The project opened, but not in the mode you picked" is a real
    /// third outcome, and folding it into either of the other two loses it: as a failure it hides
    /// that the project is open, and as a success it hides that the workbench is not there. The UI
    /// shows it as a warning beside a result that otherwise worked.
    pub mode_applied: bool,
}

/// Open a project in ArtLux, in a chosen mode.
///
/// `ArtLux.exe --project=<abs> [--calibrate]` is the ONLY contract for this -- there is no file
/// association and no protocol handler (docs/LAUNCHER.md). `--project=` also did not work in editor
/// mode until the change that preceded this launcher: main parsed the flag, forwarded it, and the
/// renderer dropped it, so the editor opened empty with nothing in any log to say why.
///
/// A plain (unelevated) spawn, unlike the installer: ArtLux is not manifested for elevation, so
/// CreateProcess is correct here and a UAC prompt would be wrong.
///
/// TWO WAYS A MODE SILENTLY DOES NOT HAPPEN, both checked here rather than left to be discovered at
/// a venue. Neither produces an error, a log line, or a window state that distinguishes it from
/// having worked -- which is precisely why they are worth code:
///
///   1. **A RUNNING ARTLUX SWALLOWS IT.** The single-instance lock hands the incoming argv to the
///      live process's `second-instance` handler, which routes `--project=` and DISCARDS the rest;
///      this process then exits 0, so an exit code proves nothing either way. The project really
///      does open -- in whatever mode the running copy was launched in. That is not a failure and
///      not a success, so it is reported as itself (see `mode_applied`).
///   2. **AN ARTLUX OLDER THAN 0.25.1 IGNORES `--calibrate`.** Unknown flags are dropped in silence,
///      exactly as `--new-project=` is on 0.25.0. There is no artifact to watch for here the way
///      `new_project` watches for the project file, so this one is a version gate -- and it does not
///      have to guess which release carried the flag, because that is recorded (MIN_CALIBRATE_VERSION).
///
/// `installed_version` is the registry's DisplayVersion for this install, as scanned. Pass "" when
/// it is unknown and the gate stands down rather than blocking on a guess.
pub fn open_project(exe: &str, project: &str, mode: LaunchMode, installed_version: &str) -> OpenOutcome {
    if !std::path::Path::new(exe).is_file() {
        return OpenOutcome { ok: false, message: format!("ArtLux is not where it should be: {exe}"), started_new: false, mode_applied: false };
    }
    if !std::path::Path::new(project).is_file() {
        return OpenOutcome { ok: false, message: format!("That project file is gone: {project}"), started_new: false, mode_applied: false };
    }
    // (2). Refused, not attempted: spawning would open the project in the ordinary editor and look
    // like it worked, and the operator would go looking for a Calib rail entry that is not there.
    if mode.too_old(installed_version) {
        return OpenOutcome {
            ok: false,
            message: format!(
                "This ArtLux ({installed_version}) cannot be launched into {} — it needs {MIN_CALIBRATE_VERSION} or newer. \
                 Update it from the Install tab, or open the project normally and use File ▸ Open Calibration Workbench… inside ArtLux.",
                mode.label(),
            ),
            started_new: false,
            mode_applied: false,
        };
    }

    let was_running = artlux_running();
    let mut cmd = Command::new(exe);
    cmd.arg(format!("--project={project}"));
    cmd.args(mode.flags());
    match cmd.spawn() {
        // (1). Attempted, and then described honestly. Retargeting is still the right thing to do --
        // opening the project is what was asked for and it is what happens -- so this is `ok`, with
        // the part that did not happen named beside it rather than folded into the same word.
        Ok(_) => OpenOutcome {
            ok: true,
            message: if !was_running {
                match mode {
                    LaunchMode::Normal => "Opening in ArtLux…".into(),
                    LaunchMode::Calibrate => "Opening in ArtLux, with the calibration workbench…".into(),
                }
            } else if mode == LaunchMode::Normal {
                // Still worth saying: a copy launched into calibration stays there, so "normal"
                // was not honoured here either. Silence would make that look chosen.
                "ArtLux was already running — it switched to this project, keeping the mode it was launched in.".into()
            } else {
                "ArtLux was already running — it switched to this project, but a launch mode cannot be changed \
                 in a copy that is already up. Close ArtLux and open this again, or use File ▸ Open Calibration Workbench… inside it."
                    .into()
            },
            started_new: !was_running,
            mode_applied: !was_running,
        },
        Err(e) => OpenOutcome { ok: false, message: format!("Could not start ArtLux: {e}"), started_new: false, mode_applied: false },
    }
}

/// Start the launcher's OWN installer and return immediately, without waiting and without elevating.
///
/// Three differences from `run_installer`, each deliberate:
///
///   * NOT ELEVATED. The launcher installs per-user, so `runas` would raise a UAC prompt for
///     something that does not need one — and a prompt nobody expects is how an update gets
///     declined.
///   * NOT WAITED ON. Windows will not let an installer replace a running executable, so the caller
///     exits immediately after this returns. Waiting here would deadlock: we would be holding the
///     file the installer is trying to overwrite.
///   * NOT VERIFIED AFTERWARDS, because there is no "afterwards" — this process is gone. The
///     verification that matters already happened: the file came from download::fetch_verified and
///     its sha512 matched what GitHub published.
pub fn spawn_installer_detached(path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).is_file() {
        return Err(format!("the downloaded installer is missing: {path}"));
    }
    Command::new(path)
        .arg("/S")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start the launcher installer: {e}"))
}

/// Ask ArtLux to create a project in an already-made folder.
///
/// `--new-project=<folder>` is the second half of the split this launcher relies on: it chose WHERE,
/// ArtLux decides WHAT. The clean-document definition stays in the renderer, where it is already
/// shared with the File menu.
///
/// Unelevated, like open_project: ArtLux is not manifested for elevation. And the same
/// single-instance caveat applies -- a running copy swallows this and exits 0 -- so the caller is
/// told which of the two happened rather than being handed a meaningless exit code.
///
/// ALWAYS THE ORDINARY EDITOR, whatever launch mode is selected elsewhere in the launcher. A project
/// created a second ago has no surfaces, no outputs and no venue model, so there is nothing to align
/// a projector against; opening it in the calibration workbench would be a workbench with no work.
pub fn new_project(exe: &str, folder: &str, project_file: &str) -> OpenOutcome {
    if !std::path::Path::new(exe).is_file() {
        return OpenOutcome { ok: false, message: format!("ArtLux is not where it should be: {exe}"), started_new: false, mode_applied: false };
    }
    let was_running = artlux_running();
    if was_running {
        // second-instance only routes --project=, so a running ArtLux would swallow this and do
        // nothing at all. Say so instead of appearing to succeed.
        return OpenOutcome {
            ok: false,
            message: "ArtLux is already running. Close it first - a second launch cannot create a project in the copy that is open.".into(),
            started_new: false,
            mode_applied: false,
        };
    }
    if let Err(e) = Command::new(exe).arg(format!("--new-project={folder}")).spawn() {
        return OpenOutcome { ok: false, message: format!("Could not start ArtLux: {e}"), started_new: false, mode_applied: false };
    }

    // WAIT FOR THE FILE, do not assume it. `--new-project=` exists only in ArtLux builds newer than
    // this launcher's own release cadence allows us to assume -- 0.25.0, the current release, does
    // not have it, and an older app simply IGNORES an unknown flag: it opens on an untitled document
    // and nothing is ever written. Spawning and reporting success would leave the operator with an
    // empty folder and an app that looks fine, which is the failure mode this whole launcher exists
    // to stop shipping.
    //
    // A version gate would have to guess which release first carried the flag. Watching for the file
    // it is supposed to produce needs no guess and stays true whatever the numbering does.
    let target = std::path::Path::new(project_file);
    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if target.is_file() {
            return OpenOutcome { ok: true, message: "Created, and open in ArtLux.".into(), started_new: true, mode_applied: true };
        }
    }
    OpenOutcome {
        ok: false,
        started_new: true,
        mode_applied: false,
        // Concatenated literals, not a backslash continuation: the continuation kept the source
        // indentation and the operator got this sentence with a corridor of blanks through it.
        message: concat!(
            "ArtLux opened but did not create the project. This version is older than the launcher ",
            "and does not understand being asked to create one — update ArtLux from the Install tab, ",
            "or use File ▸ New Project inside it. The empty folder was left in place.",
        )
        .into(),
    }
}

/// Remove an install, given its `QuietUninstallString` from the registry.
///
/// Exists for ONE case: the legacy per-user install that a per-machine installer cannot replace.
/// Windows treats the two as different products, so it leaves both in place — two Start Menu
/// entries, and which version you get depends on which shortcut you click. Nothing inside ArtLux can
/// see that state, and nothing else offers to fix it.
///
/// The string is registry-authored, e.g. `"C:\…\Uninstall ArtLux.exe" /currentuser /S`, so it is
/// split rather than handed to a shell: passing it through cmd would make a quoted path with spaces
/// a parsing problem, and this one always has spaces.
pub fn uninstall(quiet_uninstall: &str) -> InstallOutcome {
    let before = install::scan();
    let s = quiet_uninstall.trim();
    if s.is_empty() {
        return InstallOutcome { ok: false, message: "Windows recorded no uninstall command for that install.".into(), scan: before };
    }

    let (exe, args) = if let Some(rest) = s.strip_prefix('"') {
        match rest.split_once('"') {
            Some((e, a)) => (e.to_string(), a.trim().to_string()),
            None => return InstallOutcome { ok: false, message: "That uninstall command is malformed.".into(), scan: before },
        }
    } else {
        match s.split_once(' ') {
            Some((e, a)) => (e.to_string(), a.trim().to_string()),
            None => (s.to_string(), String::new()),
        }
    };
    if !std::path::Path::new(&exe).is_file() {
        return InstallOutcome {
            ok: false,
            message: format!("The uninstaller is gone: {exe}. Remove the entry from Windows' Apps & features instead."),
            scan: before,
        };
    }

    // A per-user uninstall needs no elevation, so try plain first. If Windows says otherwise, go
    // through the shell rather than reporting a failure the user cannot act on.
    let argv: Vec<&str> = args.split_whitespace().collect();
    let plain = Command::new(&exe).args(&argv).status();
    let elevated_needed = matches!(&plain, Err(e) if e.raw_os_error() == Some(ERROR_ELEVATION_REQUIRED));
    let ran = if elevated_needed {
        match run_elevated(&exe, &args) {
            Elevated::Exited(_) => Ok(()),
            Elevated::Declined => return InstallOutcome {
                ok: false,
                message: "Nothing was removed: the administrator prompt was declined.".into(),
                scan: before,
            },
            Elevated::Failed(why) => Err(why),
        }
    } else {
        plain.map(|_| ()).map_err(|e| e.to_string())
    };
    if let Err(why) = ran {
        return InstallOutcome { ok: false, message: format!("The uninstaller could not be started: {why}"), scan: before };
    }

    // Verify by looking, not by trusting: NSIS uninstallers commonly hand off to a copy of
    // themselves in TEMP and return immediately, so the registry can lag the exit by a moment.
    let mut after = install::scan();
    for _ in 0..20 {
        if after.installs.len() < before.installs.len() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        after = install::scan();
    }
    if after.installs.len() < before.installs.len() {
        InstallOutcome { ok: true, message: "The old install was removed.".into(), scan: after }
    } else {
        InstallOutcome {
            ok: false,
            message: "The uninstaller ran but that install is still registered. It may need a moment, or removing from Windows' Apps & features.".into(),
            scan: after,
        }
    }
}

/// Run a VERIFIED installer. `path` must have come from download::fetch_verified.
pub fn run_installer(path: &str) -> InstallOutcome {
    let before = install::scan();

    if artlux_running() {
        return InstallOutcome {
            ok: false,
            message: "ArtLux is running. Close it first — an installer cannot replace files that are in use.".into(),
            scan: before,
        };
    }

    // The UAC prompt is deliberately visible. Suppressing windows around an elevation request is
    // exactly the shape of something a user should be suspicious of.
    match run_elevated(path, "/S") {
        Elevated::Declined => InstallOutcome {
            ok: false,
            // The single most important message this launcher produces.
            message: "Installation did not happen: the Windows administrator prompt was declined. \
                      ArtLux needs it to install the Visual C++ and NDI runtimes and to add its firewall rules. \
                      Run this again and choose Yes."
                .into(),
            scan: before,
        },
        Elevated::Failed(why) => InstallOutcome {
            ok: false,
            message: format!("The installer could not be started: {why}"),
            scan: before,
        },
        Elevated::Exited(code) => {
            let after = install::scan();
            // Verify the OUTCOME, not the exit code. An installer that returns 0 having done nothing
            // is indistinguishable from success unless we go and look.
            let installed = after.installs.iter().find(|i| !i.per_user).or_else(|| after.installs.first());
            match installed {
                Some(i) if code == 0 => InstallOutcome {
                    ok: true,
                    message: format!(
                        "ArtLux {} installed to {}",
                        if i.version.is_empty() { "(unknown version)" } else { &i.version },
                        i.dir
                    ),
                    scan: after,
                },
                Some(i) => InstallOutcome {
                    ok: false,
                    message: format!(
                        "The installer exited with code {code} but an install is present at {}. Verify it before relying on this machine.",
                        i.dir
                    ),
                    scan: after,
                },
                None => InstallOutcome {
                    ok: false,
                    message: format!(
                        "The installer exited with code {code} and no ArtLux install can be found afterwards — nothing was installed."
                    ),
                    scan: after,
                },
            }
        }
    }
}
