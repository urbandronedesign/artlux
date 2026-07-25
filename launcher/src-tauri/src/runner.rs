//! Running the verified installer, and telling the truth about what happened.
//!
//! `nsis.oneClick` is unset in ArtLux's electron-builder config, so it defaults to **true**, and
//! `perMachine: true` means the installer's manifest requests elevation. Therefore:
//!
//!   * `/S` is silent, NOT unattended -- Windows still shows a UAC prompt.
//!   * Declining that prompt fails the spawn with ERROR_CANCELLED (1223) and installs NOTHING.
//!
//! That second case is the failure docs/INSTALL.md exists to prevent: a declined UAC produces an
//! install with no VC++ redist and no firewall rules, and reporting it as a generic error is how it
//! goes unnoticed. It gets its own message here.
//!
//! And success is never claimed from an exit code alone -- we re-read the registry and confirm
//! ArtLux.exe is really where it should be.

use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::Command;

use crate::install;

/// Windows error code for "the user declined the elevation prompt".
const ERROR_CANCELLED: i32 = 1223;
/// Do not flash a console window from a GUI app.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

    // No CREATE_NO_WINDOW here: this spawn raises the UAC prompt, and suppressing windows around an
    // elevation request is exactly the shape of something a user should be suspicious of.
    let status = Command::new(path).arg("/S").status();

    match status {
        Err(e) => {
            let code = e.raw_os_error().unwrap_or(0);
            let message = if code == ERROR_CANCELLED {
                // The single most important message this launcher produces.
                "Installation did not happen: the Windows administrator prompt was declined. \
                 ArtLux needs it to install the Visual C++ and NDI runtimes and to add its firewall rules. \
                 Run this again and choose Yes.".to_string()
            } else {
                format!("The installer could not be started: {e}")
            };
            InstallOutcome { ok: false, message, scan: before }
        }
        Ok(st) => {
            let after = install::scan();
            // Verify the OUTCOME, not the exit code. An installer that returns 0 having done nothing
            // is indistinguishable from success unless we go and look.
            let installed = after.installs.iter().find(|i| !i.per_user).or_else(|| after.installs.first());
            match installed {
                Some(i) if st.success() => InstallOutcome {
                    ok: true,
                    message: format!("ArtLux {} installed to {}", if i.version.is_empty() { "(unknown version)" } else { &i.version }, i.dir),
                    scan: after,
                },
                Some(i) => InstallOutcome {
                    ok: false,
                    message: format!(
                        "The installer exited with code {} but an install is present at {}. Verify it before relying on this machine.",
                        st.code().unwrap_or(-1), i.dir
                    ),
                    scan: after,
                },
                None => InstallOutcome {
                    ok: false,
                    message: format!(
                        "The installer exited with code {} and no ArtLux install can be found afterwards — nothing was installed.",
                        st.code().unwrap_or(-1)
                    ),
                    scan: after,
                },
            }
        }
    }
}
