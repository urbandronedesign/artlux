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

use artlux_launcher::{download, install, projects, releases, runner};

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

    line();
    println!("6. PROJECT SCAN");
    line();
    // A FIXTURE FIRST, because the de-dup rule is the one thing that cannot be checked by eye on a
    // real disk: a portable folder and a loose file look the same in a list until you count them.
    // Tree built here:
    //   fixture/loose.artlux                  -> 1 entry (file)
    //   fixture/myshow/project.artlux         -> 1 entry (folder, named "myshow")
    //   fixture/myshow/assets/nested.artlux   -> 0 entries: inside a portable folder, not descended
    //   fixture/deep/a/b/c/buried.artlux      -> 1 entry (depth is within budget)
    {
        let fx = std::env::temp_dir().join("artlux-scan-fixture");
        let _ = std::fs::remove_dir_all(&fx);
        let mk = |p: &std::path::Path, body: &str| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        };
        mk(&fx.join("loose.artlux"), r#"{"version":"1.2","timestamp":"2026-07-25T00:00:00Z"}"#);
        mk(&fx.join("myshow").join("project.artlux"), r#"{"version":"1.1","timestamp":"2026-07-24T00:00:00Z"}"#);
        mk(&fx.join("myshow").join("assets").join("nested.artlux"), "{}");
        mk(&fx.join("deep").join("a").join("b").join("c").join("buried.artlux"), r#"{"version":"1.2"}"#);

        let res = projects::scan(&[fx.to_string_lossy().into_owned()], |_| {});
        for e in &res.entries {
            println!("   {:<10} {:<12} {}", e.kind, e.name, e.path);
        }
        let names: Vec<&str> = res.entries.iter().map(|e| e.name.as_str()).collect();
        if res.entries.len() != 3 {
            println!("   !! expected 3 entries, got {} — the folder/loose de-dup rule is wrong", res.entries.len());
            failures += 1;
        }
        if !names.contains(&"myshow") {
            println!("   !! the portable folder was not listed under its FOLDER name");
            failures += 1;
        }
        if names.contains(&"nested") {
            println!("   !! descended into a portable project's assets/ — that copy must not be listed");
            failures += 1;
        }
        if !names.contains(&"buried") {
            println!("   !! a project 4 levels down was missed");
            failures += 1;
        }
        // version comes from the 4 KiB head read, never a full parse
        if res.entries.iter().find(|e| e.name == "loose").and_then(|e| e.version.clone()).as_deref() != Some("1.2") {
            println!("   !! the head read did not recover the project version");
            failures += 1;
        }
        let _ = std::fs::remove_dir_all(&fx);
    }

    // Then the real machine, which is about volume and time rather than correctness.
    let cfg = projects::load_config();
    let roots = projects::effective_roots(&cfg);
    println!("   roots ({}):", roots.len());
    for r in &roots {
        println!("     {r}");
    }
    let t = std::time::Instant::now();
    let res = projects::scan(&roots, |_| {});
    println!(
        "   walked {} dirs, found {} project(s) in {:?}{}",
        res.scanned, res.entries.len(), t.elapsed(),
        match &res.stopped { Some(s) => format!(" — STOPPED EARLY: {s}"), None => " — complete".into() }
    );
    for e in res.entries.iter().take(8) {
        println!("     {:<8} {:<28} {}", e.kind, e.name, e.path);
    }
    let rec = projects::recents();
    println!("   ArtLux recents still on disk: {}", rec.len());

    if std::env::args().any(|a| a == "--open") {
        line();
        println!("7. OPEN A PROJECT IN ARTLUX");
        line();
        match (scan.installs.first(), projects::scan(&projects::effective_roots(&projects::load_config()), |_| {}).entries.first()) {
            (Some(inst), Some(proj)) => {
                println!("   exe    : {}", inst.exe);
                println!("   project: {}", proj.path);
                // Cold: nothing running, so this must START ArtLux.
                let a = runner::open_project(&inst.exe, &proj.path);
                println!("   cold  -> ok={} started_new={} : {}", a.ok, a.started_new, a.message);
                if !a.ok || !a.started_new {
                    println!("   !! expected a fresh start when ArtLux was not running");
                    failures += 1;
                }
                // Wait for it to actually be up, then open again: the single-instance lock should
                // swallow the second process, so this must report a RETARGET, not a new start.
                let mut up = false;
                for _ in 0..60 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if runner::artlux_running() { up = true; break; }
                }
                println!("   artlux up: {up}");
                if up {
                    let b = runner::open_project(&inst.exe, &proj.path);
                    println!("   warm  -> ok={} started_new={} : {}", b.ok, b.started_new, b.message);
                    if b.started_new {
                        println!("   !! claimed a fresh start while ArtLux was already running");
                        failures += 1;
                    }
                }
                let _ = std::process::Command::new("taskkill").args(["/IM", "ArtLux.exe", "/F"]).output();
                println!("   (ArtLux closed)");
            }
            _ => println!("   skipped: need both an install and at least one project"),
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
