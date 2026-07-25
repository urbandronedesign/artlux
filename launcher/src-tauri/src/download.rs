//! Downloading the installer, and refusing to run one we cannot vouch for.
//!
//! This module exists to make one guarantee: **nothing reaches the installer step unverified.** The
//! launcher runs the downloaded file elevated, so an unchecked download is a supply-chain hole with
//! Administrator on the other side of it. The hash comes from `latest.yml` -- the same metadata the
//! app's own electron-updater trusts -- and a mismatch is a hard refusal, never a warning.
//!
//! ⚠ That hash is **base64**, not hex. See releases.rs.

use base64::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha512};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncWriteExt;

/// Progress. Byte counts, not just a percentage: a 238 MB download on a venue's uplink needs a
/// number that visibly moves.
#[derive(Clone, Serialize)]
pub struct Progress {
    pub received: u64,
    pub total: u64,
    pub done: bool,
}

/// Where a verified installer is kept. Also the rollback cache: keeping the previous verified
/// installer is what makes a bad release one click to undo.
pub fn cache_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("ArtLuxLauncher").join("cache")
}

/// Set by the `cancel_download` command; checked between chunks.
static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn request_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Base64 SHA-512 of a file already on disk, read in chunks.
///
/// STREAMED, not `fs::read`: the installer is ~238 MB and slurping it whole would spike RSS by that
/// much on a venue PC whose only job right now is to install something. 1 MiB buffer -- large enough
/// that syscall overhead disappears, small enough to be invisible.
///
/// (If this ever feels slow, check the build profile before optimising: SHA-512 in an unoptimised
/// debug build is tens of times slower than in release, which is entirely a measurement artefact.)
async fn hash_file(path: &PathBuf) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path).await.map_err(|e| format!("could not re-read the download: {e}"))?;
    let mut h = Sha512::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).await.map_err(|e| format!("could not re-read the download: {e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(h.finalize()))
}

/// Download `url` to the cache and verify it against `sha512_b64`.
///
/// Returns the absolute path of a file that is now known-good. On ANY verification failure the file
/// is deleted before returning: leaving an unverified installer in a cache directory invites a later
/// code path to find it and trust it.
/// `on_progress` is a plain callback rather than a Tauri AppHandle: the core has no business knowing
/// how progress reaches a human. main.rs passes a closure that emits a Tauri event; the self-test
/// binary passes one that prints. Without this the download could only be exercised by clicking a
/// button in a GUI, which is the same as not being exercised.
pub async fn fetch_verified<F: Fn(Progress)>(
    on_progress: F,
    url: String,
    file: String,
    sha512_b64: String,
    expected_size: u64,
) -> Result<String, String> {
    CANCEL.store(false, Ordering::SeqCst);
    let dir = cache_dir();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("could not create the cache folder: {e}"))?;
    let target = dir.join(&file);

    // Already have it AND it verifies? Skip the 238 MB. Re-hashing is cheap next to re-downloading,
    // and it is the only way to know a cached file was not truncated by an earlier crash.
    if target.is_file() {
        if let Ok(existing) = hash_file(&target).await {
            if existing == sha512_b64 {
                on_progress(Progress { received: expected_size, total: expected_size, done: true });
                return Ok(target.to_string_lossy().into_owned());
            }
        }
        let _ = tokio::fs::remove_file(&target).await; // stale or corrupt; never keep it
    }

    let http = reqwest::Client::builder()
        .user_agent(concat!("ArtLuxLauncher/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("could not create an HTTP client: {e}"))?;

    let resp = http.get(&url).send().await.map_err(|e| format!("could not start the download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(expected_size);

    // Written to a .part sibling and renamed only after verification, so an interrupted run can
    // never leave something that looks like a finished installer.
    let part = dir.join(format!("{file}.part"));
    let mut out = tokio::fs::File::create(&part).await.map_err(|e| format!("could not write to the cache: {e}"))?;
    let mut hasher = Sha512::new();
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();
    // Throttle the event: at ~8 MB/s this would otherwise emit thousands of times and the UI would
    // spend more effort rendering progress than the download does moving.
    let mut last_emit = 0u64;

    while let Some(chunk) = stream.next().await {
        if CANCEL.load(Ordering::SeqCst) {
            drop(out);
            let _ = tokio::fs::remove_file(&part).await;
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("the download was interrupted: {e}"))?;
        hasher.update(&chunk);
        out.write_all(&chunk).await.map_err(|e| format!("could not write to the cache: {e}"))?;
        received += chunk.len() as u64;
        if received - last_emit > 512 * 1024 {
            last_emit = received;
            on_progress(Progress { received, total, done: false });
        }
    }
    out.flush().await.map_err(|e| format!("could not finish writing: {e}"))?;
    drop(out);

    let actual = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());
    if actual != sha512_b64 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "the download does not match the checksum GitHub published for it, so it will not be run. \
             Expected {}…, got {}…. Try again; if it keeps happening, download the installer manually.",
            &sha512_b64.chars().take(12).collect::<String>(),
            &actual.chars().take(12).collect::<String>()
        ));
    }
    if expected_size > 0 && received != expected_size {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("the download is {received} bytes but should be {expected_size}"));
    }

    tokio::fs::rename(&part, &target).await.map_err(|e| format!("could not finalise the download: {e}"))?;
    on_progress(Progress { received, total, done: true });
    Ok(target.to_string_lossy().into_owned())
}
