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
/// Launcher releases carry their own tag prefix so the two products never contend for "latest".
const LAUNCHER_TAG_PREFIX: &str = "launcher-v";

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

/// Does this tag name an ARTLUX APP release — `v0.25.0` — rather than something else in the same
/// repo?
///
/// ⚠ WHY THIS IS NOT `/releases/latest`. Two products publish into one repo now, and
/// `/releases/latest` returns whichever was published most recently, whatever it is. A launcher
/// release would therefore be handed back as "the latest ArtLux", and fetching `latest.yml` from its
/// tag 404s. Worse, ArtLux's OWN electron-updater keys off the same endpoint, so a launcher release
/// published as a normal release would break the shipped app's update check. Launcher releases are
/// published as PRE-RELEASES for that reason (GitHub excludes those from `latest`), and this filter
/// is the second line of defence: match the tag shape, never trust the ordering.
fn is_app_tag(tag: &str) -> bool {
    let rest = match tag.strip_prefix('v') {
        Some(r) => r,
        None => return false,
    };
    rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
}

/// Is this actually a base64 SHA-512? Always 88 characters, base64 alphabet, ending `==`.
///
/// Checked where the metadata is PARSED, not where the download is compared. An empty or truncated
/// value would otherwise sail through and surface as "the download does not match the checksum" —
/// which sends the user to re-download a file that was never the problem. And a value that is empty
/// on both sides would compare EQUAL, printing a cheerful match having proved nothing, which is
/// strictly worse than not checking at all because it ends the conversation.
fn is_base64_sha512(s: &str) -> bool {
    s.len() == 88
        && s.ends_with("==")
        && s[..86]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
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

/// The newest release whose tag satisfies `want`. Lists rather than asking for "latest" — see
/// `is_app_tag` for why that endpoint cannot be trusted in a repo shipping two products.
async fn newest_release(
    http: &reqwest::Client,
    want: impl Fn(&GhRelease) -> bool,
    what: &str,
) -> Result<GhRelease, String> {
    let api = format!("https://api.github.com/repos/{OWNER_REPO}/releases?per_page=30");
    let resp = check(
        http.get(&api).header("Accept", "application/vnd.github+json").send().await
            .map_err(|e| format!("could not reach GitHub: {e}"))?,
        "listing releases",
    )
    .await?;
    let all: Vec<GhRelease> = resp.json().await.map_err(|e| format!("could not read GitHub's answer: {e}"))?;
    // GitHub returns newest first.
    all.into_iter()
        .find(|r| !r.draft && want(r))
        .ok_or_else(|| format!("no published {what} was found in this repository"))
}

pub async fn resolve_latest() -> Result<ReleaseInfo, String> {
    let http = client()?;
    let rel = newest_release(&http, |r| !r.prerelease && is_app_tag(&r.tag_name), "ArtLux release").await?;

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
        .filter(|s| is_base64_sha512(s))
        .ok_or("latest.yml carries no usable sha512 — refusing to offer a download that cannot be verified")?;

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

/// The newest LAUNCHER release, if one is published.
///
/// Same metadata shape as the app's (`launcher-latest.yml` beside the installer, carrying a base64
/// sha512), so there is one format in this codebase and the verified-download path is shared rather
/// than reimplemented.
///
/// NOT Tauri's updater plugin, deliberately. That would work, and it would mean a signing keypair
/// whose private half lives in CI secrets and whose public half is baked into the binary — real
/// infrastructure to stand up and keep correct. The launcher already resolves a release, verifies a
/// base64 sha512 and runs an installer, all of it exercised; reusing that gets a verified update
/// with no new secret to manage. If silent background updates are wanted later, the plugin is the
/// upgrade path.
///
/// Launcher releases are PRE-RELEASES on purpose (see `is_app_tag`), so they are matched here
/// explicitly rather than by "latest".
pub async fn resolve_launcher_latest() -> Result<ReleaseInfo, String> {
    let http = client()?;
    let rel = newest_release(&http, |r| r.tag_name.starts_with(LAUNCHER_TAG_PREFIX), "launcher release").await?;

    let yml_url = format!(
        "https://github.com/{OWNER_REPO}/releases/download/{}/launcher-latest.yml",
        rel.tag_name
    );
    let yml = check(
        http.get(&yml_url).send().await.map_err(|e| format!("could not fetch launcher-latest.yml: {e}"))?,
        "fetching launcher-latest.yml",
    )
    .await?
    .text()
    .await
    .map_err(|e| format!("could not read launcher-latest.yml: {e}"))?;

    let version = yaml_top_level(&yml, "version").ok_or("launcher-latest.yml carries no version")?;
    let file = yaml_top_level(&yml, "path").ok_or("launcher-latest.yml carries no installer filename")?;
    let sha512_b64 = yaml_top_level(&yml, "sha512")
        .filter(|s| is_base64_sha512(s))
        .ok_or("launcher-latest.yml carries no usable sha512 — refusing to offer a download that cannot be verified")?;
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

/// Exposed so the self-test can assert the shape rule without duplicating it.
pub fn is_base64_sha512_for_test(s: &str) -> bool {
    is_base64_sha512(s)
}

/// Exposed so the self-test can assert the app/launcher tag split without duplicating the rule.
pub fn is_app_tag_for_test(tag: &str) -> bool {
    is_app_tag(tag)
}

/// The version this launcher was built as.
pub fn own_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
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
