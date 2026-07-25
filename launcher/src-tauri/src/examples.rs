//! The example gallery: the sets ArtLux ships, copied somewhere the operator can actually save.
//!
//! WHY COPY AT ALL. The examples live inside the install, under `%ProgramFiles%\ArtLux\resources\
//! examples`, which is owned by Administrators. Opening one in place and pressing Save fails with a
//! permission error, and the documented answer has been "use Save As" -- a workaround the operator
//! has to know in advance. Copying first makes the obvious thing work.
//!
//! WHAT IS *NOT* THE PROBLEM, checked rather than assumed: the shipped files do NOT carry the
//! read-only ATTRIBUTE (they are plain `Archive`), so copies of them are writable and there is
//! nothing to clear. The protection is ACL-based and does not survive the copy. This module
//! therefore verifies the copy is writable instead of performing a ritual against a trap that is not
//! there -- if a future packaging change does set read-only, the check catches it and says so.
//!
//! A SET IS A DIRECTORY, DERIVED. Any direct child of `examples/` holding at least one `*.artlux`.
//! Not a hand-written manifest: that would be a second list of the same three sets, and it would go
//! stale the moment someone adds a fourth. Same reason src/main/docs.ts derives its tree.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ExampleSet {
    /// Directory name — also the id and the default copy target.
    pub id: String,
    /// First H1 of the set's README, else the directory name.
    pub title: String,
    /// First real paragraph of the README, trimmed.
    pub blurb: String,
    /// The `.artlux` files, sorted, as absolute paths.
    pub projects: Vec<String>,
    /// Display names for those, in the same order.
    pub project_names: Vec<String>,
    /// Total bytes that a copy would move (excluding what the copy skips).
    pub size: u64,
    /// Whether the set ships a written tutorial.
    pub has_tutorial: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopyResult {
    /// Where the set landed.
    pub dir: String,
    /// The project the caller asked to open, rebased into the copy.
    pub project: String,
    /// True when a name collision forced a numbered variant.
    pub renamed: bool,
    pub message: String,
}

/// `<install>/resources/examples`
pub fn examples_dir(install_dir: &str) -> PathBuf {
    Path::new(install_dir).join("resources").join("examples")
}

/// First `# H1` of a markdown file.
fn first_heading(md: &str) -> Option<String> {
    md.lines()
        .find(|l| l.trim_start().starts_with("# "))
        .map(|l| l.trim_start().trim_start_matches("# ").trim().to_string())
}

/// First paragraph that is not a heading, a table, a quote or a badge line.
fn first_paragraph(md: &str) -> Option<String> {
    let mut buf = String::new();
    for line in md.lines() {
        let t = line.trim();
        if t.is_empty() {
            if !buf.is_empty() {
                break;
            }
            continue;
        }
        if t.starts_with('#') || t.starts_with('|') || t.starts_with('>') || t.starts_with("---") || t.starts_with('!') {
            if !buf.is_empty() {
                break;
            }
            continue;
        }
        if !buf.is_empty() {
            buf.push(' ');
        }
        buf.push_str(t);
        if buf.len() > 300 {
            break;
        }
    }
    if buf.is_empty() {
        None
    } else {
        Some(strip_markdown(&buf))
    }
}

/// Reduce inline markdown to the words. A card is not a README: `[state machine](../../docs/
/// STATE-MACHINE.md)` renders as a URL nobody can click and pushes the actual sentence off the end.
/// Keeps the link TEXT and drops the target.
fn strip_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '[' => {
                // Take the label, then swallow a following (...) target if there is one.
                // Filter the LABEL's characters too. Pushing it wholesale let markup inside the
                // label straight through, so `[`docs/AUDIO.md`](…)` still rendered with backticks --
                // the strip looked like it worked because the URL had gone.
                for c2 in chars.by_ref() {
                    if c2 == ']' {
                        break;
                    }
                    if !matches!(c2, '`' | '*' | '_') {
                        out.push(c2);
                    }
                }
                if chars.peek() == Some(&'(') {
                    chars.next();
                    let mut depth = 1;
                    for c2 in chars.by_ref() {
                        match c2 {
                            '(' => depth += 1,
                            ')' => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            '`' | '*' | '_' => {}
            _ => out.push(c),
        }
    }
    // Collapse the double spaces that dropping a link can leave behind.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Does the copy carry this entry? `tuto/` is reachable in-app already and is most of the bytes;
/// `*.cjs` are generators, not content. `README.md` stays -- it is the set's own explanation.
fn copied(rel: &Path) -> bool {
    let s = rel.to_string_lossy().to_ascii_lowercase();
    if s.starts_with("tuto") || s.contains("\\tuto\\") || s.contains("/tuto/") {
        return false;
    }
    !s.ends_with(".cjs")
}

fn dir_size(root: &Path, base: &Path) -> u64 {
    let mut total = 0;
    let Ok(rd) = fs::read_dir(root) else { return 0 };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(rel) = p.strip_prefix(base) else { continue };
        if !copied(rel) {
            continue;
        }
        if p.is_dir() {
            total += dir_size(&p, base);
        } else if let Ok(md) = p.metadata() {
            total += md.len();
        }
    }
    total
}

/// Every example set inside an install.
pub fn list(install_dir: &str) -> Vec<ExampleSet> {
    let root = examples_dir(install_dir);
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&root) else { return out };

    for e in rd.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let mut projects: Vec<PathBuf> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|d| d.path())
            .filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("artlux")).unwrap_or(false))
            .collect();
        if projects.is_empty() {
            continue; // a directory with no projects is not a set
        }
        projects.sort();

        let id = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let readme = fs::read_to_string(dir.join("README.md")).unwrap_or_default();
        out.push(ExampleSet {
            title: first_heading(&readme).unwrap_or_else(|| id.clone()),
            blurb: first_paragraph(&readme).unwrap_or_default(),
            project_names: projects
                .iter()
                .map(|p| p.file_stem().unwrap_or_default().to_string_lossy().into_owned())
                .collect(),
            projects: projects.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            size: dir_size(&dir, &dir),
            has_tutorial: dir.join("tuto").is_dir(),
            id,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// `Documents\ArtLux Projects`, unless configured otherwise.
pub fn default_workspace() -> PathBuf {
    use windows::Win32::UI::Shell::{FOLDERID_Documents, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    let docs = unsafe {
        SHGetKnownFolderPath(&FOLDERID_Documents, KF_FLAG_DEFAULT, None)
            .ok()
            .and_then(|p| {
                let s = p.to_string().ok();
                windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
                s
            })
    };
    match docs {
        Some(d) if !d.is_empty() => PathBuf::from(d).join("ArtLux Projects"),
        _ => PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())).join("ArtLux Projects"),
    }
}

/// A free directory name, numbered from what is TAKEN rather than from a count.
///
/// `audio`, then `audio 2`, `audio 3`... Counting existing copies breaks the moment the operator
/// deletes one: with `audio` and `audio 3` present, "length + 1" proposes `audio 3` again and the
/// copy silently merges into it. ArtLux has an invariant about exactly this.
fn free_name(parent: &Path, id: &str) -> (PathBuf, bool) {
    let first = parent.join(id);
    if !first.exists() {
        return (first, false);
    }
    for n in 2..1000 {
        let candidate = parent.join(format!("{id} {n}"));
        if !candidate.exists() {
            return (candidate, true);
        }
    }
    (parent.join(format!("{id} copy")), true)
}

fn copy_tree(src: &Path, dst: &Path, base: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let from = e.path();
        let Ok(rel) = from.strip_prefix(base) else { continue };
        if !copied(rel) {
            continue;
        }
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_tree(&from, &to, base)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy a whole set into the workspace and return the rebased path of `project`.
///
/// WHOLE SET, not one file: `audio/` shares one `assets/` folder, so a single project without it is
/// broken -- and with it you have copied the set anyway. The caller chooses which project OPENS.
///
/// Asset paths need no rewriting. The shipped examples store folder-relative paths
/// (`assets/audio/bed-count.wav`) and ArtLux resolves them against the project's own folder on load,
/// so a whole-folder copy stays correct.
pub fn copy_set(install_dir: &str, set_id: &str, project: &str, workspace: &Path) -> Result<CopyResult, String> {
    let src = examples_dir(install_dir).join(set_id);
    if !src.is_dir() {
        return Err(format!("that example set is not in this install: {}", src.display()));
    }
    fs::create_dir_all(workspace).map_err(|e| format!("could not create {}: {e}", workspace.display()))?;

    let (dst, renamed) = free_name(workspace, set_id);
    copy_tree(&src, &dst, &src).map_err(|e| format!("could not copy the example: {e}"))?;

    // Rebase the chosen project into the copy by its file name.
    let name = Path::new(project)
        .file_name()
        .ok_or("that project path has no file name")?;
    let opened = dst.join(name);
    if !opened.is_file() {
        return Err(format!("copied the set, but {} is not in it", name.to_string_lossy()));
    }

    // VERIFY, do not assume. The point of copying is that the result is writable; if it is not, the
    // operator finds out at Save time with a message that explains nothing. Cheap to check here.
    if let Err(e) = fs::OpenOptions::new().append(true).open(&opened) {
        return Err(format!(
            "copied to {}, but the copy is not writable ({e}). Choose a different workspace folder.",
            dst.display()
        ));
    }

    Ok(CopyResult {
        message: if renamed {
            format!("Copied to {} (a folder named '{set_id}' was already there).", dst.display())
        } else {
            format!("Copied to {}.", dst.display())
        },
        dir: dst.to_string_lossy().into_owned(),
        project: opened.to_string_lossy().into_owned(),
        renamed,
    })
}
