//! Finding the operator's ArtLux projects on disk.
//!
//! ROOTS, NOT DRIVES. Desktop / Documents / Videos by default, plus any folder the user adds. A
//! whole-drive sweep sounds thorough and is mostly a way to spend twenty seconds walking
//! `Windows\WinSxS`; an explicit "scan this folder" covers the rest.
//!
//! THE ONE DE-DUP RULE, ported from plugins/show-control/src/projectScanner.ts rather than invented
//! again: a directory containing `project.artlux` IS a portable project -- emit it once and do not
//! descend, because its `assets/` holds nothing worth listing and a nested `.artlux` there is a
//! working copy. Otherwise emit each loose `*.artlux` and recurse. Without it every example set
//! appears twice, once as a folder and once as its contents.
//!
//! DELIBERATE DIVERGENCE from that scanner: it also accepts `.json`, which is right for a single
//! directory the operator pointed at, and wrong here. This walks whole home directories, where
//! `.json` files are overwhelmingly not ArtLux projects, and a project list padded with `tsconfig`
//! and `package.json` is worse than a short one.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, UNIX_EPOCH};

pub const PROJECT_FILENAME: &str = "project.artlux";
const EXT: &str = "artlux";

/// How deep to walk from each root. Six is enough for `Documents/Shows/2026/VenueName/project/` and
/// stops well short of a node_modules-shaped tarpit. NOT the constants projectFolder.ts uses -- that
/// walks a single project's own assets, this walks a home directory.
const MAX_DEPTH: usize = 6;
/// Caps. Whichever hits first stops the walk, and the reason is REPORTED -- a silently truncated
/// library reads as "you have no projects", which is a lie the user cannot see.
const MAX_ENTRIES: usize = 4000;
const MAX_SECONDS: u64 = 20;

/// Directory names never worth descending into. Case-insensitive; anything dot-prefixed is skipped
/// too. `Windows\WinSxS` alone can hold hundreds of thousands of files and contains no projects.
const IGNORE: &[&str] = &[
    "node_modules", "$recycle.bin", "system volume information", "windows",
    "program files", "program files (x86)", "programdata", "appdata",
    "application data", "onedrivetemp", "release", "out", "dist", "build",
    "target", "venv", "__pycache__", "library", ".git", ".svn",
];

#[derive(Debug, Clone, Serialize)]
pub struct ProjectEntry {
    /// The loadable `.artlux` file -- exactly the string `ArtLux.exe --project=` expects.
    pub path: String,
    /// The project folder, when this is a portable folder project.
    pub root: Option<String>,
    pub name: String,
    /// "file" | "folder"
    pub kind: String,
    pub mtime_ms: u64,
    pub size: u64,
    /// From a 4 KiB head read, not a full parse. Absent when the head did not carry it.
    pub version: Option<String>,
    pub saved_at: Option<String>,
    /// "root" (found by the walk) | "recent" (from ArtLux's own recents, outside every root)
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub scanned: u64,
    pub found: u64,
    pub current: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanResult {
    pub entries: Vec<ProjectEntry>,
    pub roots: Vec<String>,
    /// None = the walk finished. Some("cap"|"budget"|"cancelled") = it did NOT, and the UI says so.
    pub stopped: Option<String>,
    pub scanned: u64,
}

/// The launcher's own config. Kept HERE and never in artlux-prefs.json: that file belongs to a
/// running ArtLux, is rewritten wholesale on every save, and a malformed write makes the app
/// silently reset every preference it holds.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    /// Absent = the three OS defaults. Empty = the user removed them all, which is a real and
    /// different state, so it must not be confused with absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_roots: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_dir: Option<String>,
}

pub fn config_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("ArtLuxLauncher").join("config.json")
}

pub fn load_config() -> Config {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(c: &Config) -> Result<(), String> {
    let p = config_path();
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| format!("could not create the config folder: {e}"))?;
    }
    let json = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    // Plain UTF-8, no BOM. A BOM is what makes a JSON file unreadable to the next program that
    // opens it -- ArtLux's own prefs loader falls back to defaults when it meets one.
    fs::write(&p, json).map_err(|e| format!("could not write the config: {e}"))
}

/// Desktop / Documents / Videos, resolved through the shell rather than by joining %USERPROFILE%.
/// Those folders are routinely REDIRECTED (OneDrive, roaming profiles, a relocated Documents), and a
/// hardcoded `%USERPROFILE%\Documents` then points at a directory that does not exist -- the scan
/// finds nothing and looks broken.
fn default_roots() -> Vec<String> {
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Videos, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
    };
    let mut out = Vec::new();
    for id in [FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Videos] {
        unsafe {
            if let Ok(pwstr) = SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None) {
                if let Ok(s) = pwstr.to_string() {
                    if !s.is_empty() && Path::new(&s).is_dir() {
                        out.push(s);
                    }
                }
                windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.0 as *const _));
            }
        }
    }
    out
}

/// The roots actually in effect: configured, or the OS defaults when never configured.
pub fn effective_roots(c: &Config) -> Vec<String> {
    match &c.library_roots {
        Some(v) => v.clone(),
        None => default_roots(),
    }
}

/// Bumped by `request_cancel`; the walk checks it at every directory boundary.
static SCAN_TOKEN: AtomicU64 = AtomicU64::new(0);

pub fn request_cancel() {
    SCAN_TOKEN.fetch_add(1, Ordering::SeqCst);
}

fn ignored(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with('.') || IGNORE.contains(&lower.as_str())
}

fn mtime_ms(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pull a top-level `"key": "value"` out of the first 4 KiB of a project file.
///
/// A HEAD READ, not a parse. Projects run to tens of KiB and may sit on a network share or a
/// OneDrive placeholder, where reading the whole file triggers a hydration DOWNLOAD -- per project,
/// during a scan the user is watching. Missing the value costs a blank column; the alternative costs
/// the scan.
fn head_scalar(head: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let at = head.find(&needle)? + needle.len();
    let rest = &head[at..];
    let colon = rest.find(':')?;
    let after = &rest[colon + 1..];
    let open = after.find('"')?;
    let tail = &after[open + 1..];
    let close = tail.find('"')?;
    Some(tail[..close].to_string())
}

fn read_head(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 4096];
    let n = f.read(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf[..n]).into_owned())
}

fn entry_for(path: &Path, root: Option<&Path>, source: &str) -> Option<ProjectEntry> {
    let md = fs::metadata(path).ok()?;
    let head = read_head(path).unwrap_or_default();
    // A folder project's NAME is the folder's -- the folder is what the operator named;
    // `project.artlux` is a filename nobody chose. No prettification: rendering `01-the-bed` as
    // "01 The Bed" while the title bar says `01-the-bed.artlux` is a lie.
    let name = match root {
        Some(r) => r.file_name()?.to_string_lossy().into_owned(),
        None => path.file_stem()?.to_string_lossy().into_owned(),
    };
    Some(ProjectEntry {
        path: path.to_string_lossy().into_owned(),
        root: root.map(|r| r.to_string_lossy().into_owned()),
        name,
        kind: if root.is_some() { "folder".into() } else { "file".into() },
        mtime_ms: mtime_ms(&md),
        size: md.len(),
        version: head_scalar(&head, "version"),
        saved_at: head_scalar(&head, "timestamp"),
        source: source.to_string(),
    })
}

/// Walk `roots` for projects, reporting progress and honouring cancellation.
pub fn scan<F: Fn(ScanProgress)>(roots: &[String], on_progress: F) -> ScanResult {
    let token = SCAN_TOKEN.load(Ordering::SeqCst);
    let started = Instant::now();
    let mut entries: Vec<ProjectEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut stopped: Option<String> = None;
    let mut scanned: u64 = 0;
    let mut last_emit = Instant::now();

    // (dir, depth). Explicit stack rather than recursion: cancellation and the caps are checked in
    // one place, and a pathological tree cannot blow the call stack.
    let mut stack: Vec<(PathBuf, usize)> = roots.iter().map(|r| (PathBuf::from(r), 0)).collect();

    'walk: while let Some((dir, depth)) = stack.pop() {
        if SCAN_TOKEN.load(Ordering::SeqCst) != token {
            stopped = Some("cancelled".into());
            break;
        }
        if entries.len() >= MAX_ENTRIES {
            stopped = Some("cap".into());
            break;
        }
        if started.elapsed().as_secs() >= MAX_SECONDS {
            stopped = Some("budget".into());
            break;
        }

        let Ok(rd) = fs::read_dir(&dir) else { continue };
        scanned += 1;
        if last_emit.elapsed().as_millis() > 250 {
            last_emit = Instant::now();
            on_progress(ScanProgress {
                scanned,
                found: entries.len() as u64,
                current: dir.to_string_lossy().into_owned(),
                done: false,
            });
        }

        // A portable project short-circuits its whole directory.
        let pf = dir.join(PROJECT_FILENAME);
        if pf.is_file() {
            if let Some(e) = entry_for(&pf, Some(&dir), "root") {
                if seen.insert(e.path.to_ascii_lowercase()) {
                    entries.push(e);
                }
            }
            continue; // do NOT descend: assets/ holds no projects, and a nested .artlux is a copy
        }

        let mut subdirs: Vec<PathBuf> = Vec::new();
        for de in rd.flatten() {
            let path = de.path();
            let Ok(ft) = de.file_type() else { continue };
            // Symlinks and junctions are skipped outright: loop protection, and it sidesteps
            // OneDrive placeholder trees that materialise on touch.
            if ft.is_symlink() {
                continue;
            }
            let name = de.file_name().to_string_lossy().into_owned();
            if ft.is_dir() {
                if depth + 1 <= MAX_DEPTH && !ignored(&name) {
                    subdirs.push(path);
                }
            } else if path.extension().map(|e| e.eq_ignore_ascii_case(EXT)).unwrap_or(false) {
                // A bare project.artlux loose here belongs to a folder handled above.
                if name.eq_ignore_ascii_case(PROJECT_FILENAME) {
                    continue;
                }
                if let Some(e) = entry_for(&path, None, "root") {
                    if seen.insert(e.path.to_ascii_lowercase()) {
                        entries.push(e);
                        if entries.len() >= MAX_ENTRIES {
                            stopped = Some("cap".into());
                            break 'walk;
                        }
                    }
                }
            }
        }
        for d in subdirs {
            stack.push((d, depth + 1));
        }
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    on_progress(ScanProgress {
        scanned,
        found: entries.len() as u64,
        current: String::new(),
        done: true,
    });
    ScanResult { entries, roots: roots.to_vec(), stopped, scanned }
}

/// ArtLux's own recent files, READ-ONLY.
///
/// Merged in so a project living outside every root -- a USB stick, another drive -- is still one
/// click away, and so "Recent" is never empty just because of where the file happens to live.
/// artlux-prefs.json is owned by a running ArtLux and rewritten wholesale on every save; the
/// launcher must never write it.
pub fn recents() -> Vec<ProjectEntry> {
    let Ok(appdata) = std::env::var("APPDATA") else { return Vec::new() };
    let p = PathBuf::from(appdata).join("artlux").join("artlux-prefs.json");
    let Ok(text) = fs::read_to_string(&p) else { return Vec::new() };
    let Ok(v): Result<serde_json::Value, _> = serde_json::from_str(&text) else { return Vec::new() };
    let Some(list) = v.get("recentFiles").and_then(|r| r.as_array()) else { return Vec::new() };

    let mut out = Vec::new();
    for item in list {
        let Some(s) = item.as_str() else { continue };
        let path = Path::new(s);
        // Prune as we go: dead entries accumulate in that list forever, and showing them would put
        // ArtLux's stale-recents bug on the launcher's front page.
        if !path.is_file() {
            continue;
        }
        let is_folder = path
            .file_name()
            .map(|n| n.eq_ignore_ascii_case(PROJECT_FILENAME))
            .unwrap_or(false);
        let root = if is_folder { path.parent() } else { None };
        if let Some(e) = entry_for(path, root, "recent") {
            out.push(e);
        }
    }
    out
}
