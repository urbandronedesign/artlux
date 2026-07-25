//! Resolving what the latest published ArtLux is.
//!
//! TWO SOURCES, ONE TRUTH. The GitHub releases API says which tag is latest and where its assets
//! live; `latest.yml` -- the file electron-updater itself consumes -- carries the version, the asset
//! filename and its **sha512**. Taking the hash from anywhere else would create a second source of
//! truth that can disagree with the app's own updater, so the asset URL is built from the filename
//! `latest.yml` names, not from whatever the API listed first.
//!
//! ⚠ `latest.yml`'s sha512 is **base64**, not hex (`y2JIiu71ozboGUBvb01TI5Rm...Vg==`). Comparing a
//! hex digest against it fails every download, which reads as "the network is broken" rather than
//! "the check is wrong".
//!
//! The repo is public, so no token is needed. Unauthenticated GitHub allows 60 requests/hour/IP:
//! that is plenty for a launcher, but it means a rate-limit response is a REAL state the UI has to
//! name rather than spin on.

use serde::{Deserialize, Serialize};

const OWNER_REPO: &str = "urbandronedesign/artlux";
/// Windows only, and electron-builder's `artifactName` renders the arch as `x64` (not `x86_64`).
const WIN_ARCH: &str = "x64";

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseInfo {
    /// Semver from latest.yml, e.g. `0.25.0`.
    pub version: String,
    /// Release tag, e.g. `v0.25.0`.
    pub tag: String,
    /// Installer filename, e.g. `ArtLux-0.25.0-x64.exe`.
    pub file: String,
    /// Direct download URL for that file.
    pub url: String,
    /// BASE64-encoded SHA-512 as published. Compare base64 to base64.
    pub sha512_b64: String,
    /// Expected byte size, so a truncated download is caught before hashing 238 MB.
    pub size: u64,
    /// Release notes URL, for the "what changed" link.
    pub notes_url: String,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// Minimal reader for the handful of top-level scalars electron-builder writes.
///
/// Deliberately not a YAML dependency: this file is machine-generated with a fixed shape, and the
/// three values wanted (`version`, `path`, `sha512`) are top-level `key: value` lines. Indented
/// lines are skipped so the nested `files:` list -- which repeats `sha512` -- can never be mistaken
/// for the top-level one.
fn yaml_top_level(src: &str, key: &str) -> Option<String> {
    for line in src.lines() {
        if line.starts_with(char::is_whitespace) || line.starts_with('-') {
            continue; // nested; the top-level scalars are what we want
        }
        let (k, v) = line.split_once(':')?;
        if k.trim() == key {
            return Some(v.trim().trim_matches('\'').trim_matches('"').to_string());
        }
    }
    None
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // GitHub rejects requests with no User-Agent with a 403 that looks like rate limiting.
        .user_agent(concat!("ArtLuxLauncher/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("could not create an HTTP client: {e}"))
}

/// Turn a non-success response into a message that says what actually happened.
async fn check(resp: reqwest::Response, what: &str) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    // 403 with the rate-limit header is the one failure a user can simply wait out, so say so
    // instead of reporting a generic HTTP error.
    let remaining = resp.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()).unwrap_or("");
    if status.as_u16() == 403 && remaining == "0" {
        return Err("GitHub is rate-limiting this machine (60 requests/hour for anonymous access). Wait an hour, or download the installer manually from the releases page.".into());
    }
    Err(format!("{what} failed: HTTP {status}"))
}

pub async fn resolve_latest() -> Result<ReleaseInfo, String> {
    let http = client()?;

    let api = format!("https://api.github.com/repos/{OWNER_REPO}/releases/latest");
    let resp = check(
        http.get(&api).header("Accept", "application/vnd.github+json").send().await
            .map_err(|e| format!("could not reach GitHub: {e}"))?,
        "looking up the latest release",
    ).await?;
    let rel: GhRelease = resp.json().await.map_err(|e| format!("could not read GitHub's answer: {e}"))?;
    if rel.draft || rel.prerelease {
        return Err(format!("the latest release ({}) is a draft or pre-release", rel.tag_name));
    }

    // latest.yml is fetched from the TAG, not from /latest/download: resolving the tag once and
    // pinning it means the metadata and the installer cannot come from two different releases if a
    // new one is published between the two requests.
    let yml_url = format!("https://github.com/{OWNER_REPO}/releases/download/{}/latest.yml", rel.tag_name);
    let yml = check(
        http.get(&yml_url).send().await.map_err(|e| format!("could not fetch latest.yml: {e}"))?,
        "fetching latest.yml",
    ).await?
        .text().await.map_err(|e| format!("could not read latest.yml: {e}"))?;

    let version = yaml_top_level(&yml, "version")
        .ok_or("latest.yml carries no version")?;
    let file = yaml_top_level(&yml, "path")
        .ok_or("latest.yml carries no installer filename")?;
    let sha512_b64 = yaml_top_level(&yml, "sha512")
        .ok_or("latest.yml carries no sha512 — refusing to offer an unverifiable download")?;

    // The launcher is Windows-only, so a latest.yml naming anything else means we are reading the
    // wrong metadata file (latest-mac.yml / latest-linux.yml) and must not proceed.
    if !file.to_ascii_lowercase().ends_with(".exe") || !file.contains(WIN_ARCH) {
        return Err(format!("latest.yml names '{file}', which is not the Windows {WIN_ARCH} installer"));
    }

    // `size` lives under the nested `files:` entry, so it is read leniently and only used as an
    // early truncation check -- the sha512 is what actually decides.
    let size = yml
        .lines()
        .find_map(|l| l.trim().strip_prefix("size:").and_then(|v| v.trim().parse::<u64>().ok()))
        .unwrap_or(0);

    Ok(ReleaseInfo {
        version,
        tag: rel.tag_name.clone(),
        url: format!("https://github.com/{OWNER_REPO}/releases/download/{}/{file}", rel.tag_name),
        file,
        sha512_b64,
        size,
        notes_url: rel.html_url,
    })
}

/// Is `latest` newer than `installed`? Semver, never string compare: "0.9.0" > "0.25.0" as strings.
pub fn is_newer(latest: &str, installed: &str) -> bool {
    match (semver::Version::parse(latest.trim_start_matches('v')), semver::Version::parse(installed.trim_start_matches('v'))) {
        (Ok(l), Ok(i)) => l > i,
        // An unparseable installed version (an install found by path guess, which carries none)
        // means we cannot claim an update is needed. Say nothing rather than something wrong.
        _ => false,
    }
}
