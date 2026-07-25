//! The launcher's core, as a library.
//!
//! Split out from main.rs so it can be exercised WITHOUT the GUI. A bootstrapper's interesting
//! behaviour is registry detection, release resolution and checksum verification — none of which
//! should only be reachable by clicking a button in a WebView. `src/bin/selftest.rs` runs the same
//! code against the real machine and the real release feed.

pub mod download;
pub mod install;
pub mod releases;
pub mod runner;
