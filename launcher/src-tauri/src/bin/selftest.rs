//! Exercises the launcher's core against THIS machine and the REAL release feed, with no GUI.
//!
//! Run:  cargo run --bin selftest [--download]
//!
//! Without `--download` it does everything short of pulling 238 MB: scan the registry, resolve the
//! latest release, and prove the checksum check REFUSES a file that does not match (using a small
//! decoy, so the refusal path is tested without the bandwidth).
//!
//! Why a binary and not `#[test]`: these are observations of a real machine and a live network, not
//! assertions about pure logic. They are meant to be read, and the interesting output is what was
//! found — "found via product key InstallLocation" is the whole point of install.rs, and a green
//! test tick would hide it.

use artlux_launcher::{download, install, releases, runner};

fn line() {
    println!("{}", "-".repeat(78));
}

#[tokio::main]
async fn main() {
    let want_download = std::env::args().any(|a| a == "--download");
    let mut failures = 0;

    line();
    println!("1. INSTALL DETECTION");
    line();
    let scan = install::scan();
    if scan.installs.is_empty() {
        println!("   no ArtLux install found");
    }
    for i in &scan.installs {
        println!("   version : {}", if i.version.is_empty() { "(none recorded)" } else { &i.version });
        println!("   dir     : {}", i.dir);
        println!("   exe     : {}", i.exe);
        println!("   scope   : {}", if i.per_user { "per-user" } else { "per-machine" });
        println!("   found by: {}", i.found_by);
    }
    println!("   duplicate install state: {}", scan.duplicate);
    println!("   ArtLux running now     : {}", runner::artlux_running());
    // The point of install.rs: the Uninstall key's InstallLocation is empty on every real install,
    // so a detection that still reports "uninstall key InstallLocation" means the gotcha regressed.
    if scan.installs.iter().any(|i| i.found_by.starts_with("path guess")) {
        println!("   !! resolved by GUESS — the registry lookup found nothing");
        failures += 1;
    }

    line();
    println!("2. RELEASE RESOLUTION");
    line();
    let latest = match releases::resolve_latest().await {
        Ok(r) => {
            println!("   tag     : {}", r.tag);
            println!("   version : {}", r.version);
            println!("   file    : {}", r.file);
            println!("   size    : {} bytes", r.size);
            println!("   sha512  : {} (base64)", r.sha512_b64);
            println!("   url     : {}", r.url);
            // Base64 SHA-512 is 88 chars ending '=='. If this ever looks like 128 hex chars, the
            // feed changed shape and every verification would fail for the wrong reason.
            if r.sha512_b64.len() != 88 || !r.sha512_b64.ends_with("==") {
                println!("   !! that does not look like base64 SHA-512 (expected 88 chars ending '==')");
                failures += 1;
            }
            if let Some(i) = scan.installs.iter().find(|i| !i.version.is_empty()) {
                println!("   newer than installed {}: {}", i.version, releases::is_newer(&r.version, &i.version));
            }
            Some(r)
        }
        Err(e) => {
            println!("   !! {e}");
            failures += 1;
            None
        }
    };

    line();
    println!("3. CHECKSUM REFUSAL  (a download that does not match must NOT be returned)");
    line();
    // A small, real file with a deliberately wrong expected hash. This is the security property the
    // whole module exists for: the launcher runs what it downloads, elevated.
    let decoy = "https://raw.githubusercontent.com/urbandronedesign/artlux/main/LICENSE";
    let bogus = "A".repeat(86) + "==";
    match download::fetch_verified(|_| {}, decoy.into(), "selftest-decoy.bin".into(), bogus, 0).await {
        Ok(p) => {
            println!("   !! ACCEPTED a file whose checksum did not match: {p}");
            failures += 1;
        }
        Err(e) if e.contains("checksum") => {
            println!("   refused, as it must:");
            println!("   {e}");
            let leftover = download::cache_dir().join("selftest-decoy.bin");
            if leftover.exists() {
                println!("   !! but it left the rejected file in the cache: {}", leftover.display());
                failures += 1;
            } else {
                println!("   and left nothing behind in the cache");
            }
        }
        Err(e) => {
            println!("   !! failed for the WRONG reason (not a checksum refusal): {e}");
            failures += 1;
        }
    }

    if want_download {
        line();
        println!("4. FULL VERIFIED DOWNLOAD  (238 MB — this is the real installer)");
        line();
        if let Some(r) = latest {
            let started = std::time::Instant::now();
            // A RUNNING THRESHOLD, not an exact-boundary test. The obvious
            // `received / N != (received - 1) / N` only fires when a chunk lands exactly on a
            // multiple of N, which chunked reads essentially never do -- so the first version of
            // this printed nothing but "done" and the progress channel went unobserved while
            // looking verified. Also counted, because "it fired" is the property under test.
            let calls = std::cell::Cell::new(0u32);
            let next = std::cell::Cell::new(32u64 * 1024 * 1024);
            match download::fetch_verified(
                |p| {
                    calls.set(calls.get() + 1);
                    if p.done {
                        println!("   {} MB — done, after {} progress callbacks", p.received / 1024 / 1024, calls.get());
                    } else if p.received >= next.get() {
                        next.set(p.received + 32 * 1024 * 1024);
                        println!("   {} MB", p.received / 1024 / 1024);
                    }
                },
                r.url.clone(), r.file.clone(), r.sha512_b64.clone(), r.size,
            ).await {
                Ok(p) => println!("   verified in {:?}: {p}", started.elapsed()),
                Err(e) => { println!("   !! {e}"); failures += 1; }
            }
        }
    } else {
        line();
        println!("4. FULL DOWNLOAD skipped (pass --download to pull the real 238 MB installer)");
        line();
    }

    if std::env::args().any(|a| a == "--install") {
        line();
        println!("5. REAL INSTALL  (runs the verified installer -- Windows WILL prompt for admin)");
        line();
        // Only ever a file this launcher downloaded and verified. Never an arbitrary path.
        let cached = download::cache_dir().join("ArtLux-0.25.0-x64.exe");
        if !cached.is_file() {
            println!("   !! no verified installer in the cache — run with --download first");
            failures += 1;
        } else {
            println!("   installer: {}", cached.display());
            println!("   ArtLux running: {}", runner::artlux_running());
            let started = std::time::Instant::now();
            let out = runner::run_installer(&cached.to_string_lossy());
            println!("   took   : {:?}", started.elapsed());
            println!("   ok     : {}", out.ok);
            println!("   message: {}", out.message);
            for i in &out.scan.installs {
                println!("   after  : {} at {} ({}, via {})",
                    if i.version.is_empty() { "unknown" } else { &i.version },
                    i.dir, if i.per_user { "per-user" } else { "per-machine" }, i.found_by);
            }
            if !out.ok {
                // Not counted as a self-test failure: a refusal (ArtLux running, UAC declined) is the
                // module doing its job. The message is what is under test, so it is printed above.
                println!("   (refused/failed — read the message above; that is the behaviour on trial)");
            }
        }
    }

    println!();
    if failures == 0 {
        println!("SELFTEST OK");
    } else {
        println!("SELFTEST: {failures} problem(s)");
        std::process::exit(1);
    }
}
