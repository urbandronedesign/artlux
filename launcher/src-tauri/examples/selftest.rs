//! Exercises the launcher's core against THIS machine and the REAL release feed, with no GUI.
//!
//! Run:  cargo run --example selftest [--download]
//!
//! An EXAMPLE, not a [[bin]]. As a second binary in the crate it became a bundle candidate, and
//! tauri build shipped THIS as the launcher -- an installer whose Start Menu shortcut ran a console
//! self-test and never opened a window. Examples are never bundled, so the ambiguity cannot return.
//!
//! Without `--download` it does everything short of pulling 238 MB: scan the registry, resolve the
//! latest release, and prove the checksum check REFUSES a file that does not match (using a small
//! decoy, so the refusal path is tested without the bandwidth).
//!
//! Why a binary and not `#[test]`: these are observations of a real machine and a live network, not
//! assertions about pure logic. They are meant to be read, and the interesting output is what was
//! found — "found via product key InstallLocation" is the whole point of install.rs, and a green
//! test tick would hide it.

use artlux_launcher::{download, examples, install, preflight, projects, releases, runner};

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
    println!("2b. RELEASE FILTERING  (two products, one repo)");
    line();
    // The app resolver must never be handed a launcher release. Publishing launcher-v* as a
    // pre-release keeps it out of /releases/latest -- which ArtLux's own electron-updater reads --
    // and this filter is the second line of defence.
    println!("   app tag shape accepted:  v0.25.0={} v1.0.0-rc1={}",
        releases::is_app_tag_for_test("v0.25.0"), releases::is_app_tag_for_test("v1.0.0-rc1"));
    println!("   app tag shape rejected:  launcher-v0.1.0={} nightly={}",
        releases::is_app_tag_for_test("launcher-v0.1.0"), releases::is_app_tag_for_test("nightly"));
    if releases::is_app_tag_for_test("launcher-v0.1.0") || !releases::is_app_tag_for_test("v0.25.0") {
        println!("   !! the app/launcher tag filter is wrong — a launcher release could be served as ArtLux");
        failures += 1;
    }
    // The metadata shape guard. An unverifiable checksum must be refused where it is PARSED --
    // an empty value compared against an empty value is a match that proves nothing.
    let shapes = [
        ("real 88-char base64", "y2JIiu71ozboGUBvb01TI5RmTnxCfvlOvF4seANkWTPkPaj88F/5wg2lV10IU8nTtuIPBldUZ91KAoysbXXvVg==", true),
        ("empty", "", false),
        ("whitespace", "   ", false),
        ("hex, not base64", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", false),
        ("truncated", "y2JIiu71ozboGUBv==", false),
        ("no padding", "y2JIiu71ozboGUBvb01TI5RmTnxCfvlOvF4seANkWTPkPaj88F/5wg2lV10IU8nTtuIPBldUZ91KAoysbXXvVgAA", false),
        ("illegal char", "y2JIiu71ozboGUBvb01TI5RmTnxCfvlOvF4seANkWTPkPaj88F/5wg2lV10IU8nTtuIPBldUZ91KAoysbXX!Vg==", false),
    ];
    for (label, value, want) in shapes {
        let got = releases::is_base64_sha512_for_test(value);
        println!("   sha512 shape  {:<20} accepted={}", label, got);
        if got != want {
            println!("   !! '{label}' should be {}", if want { "accepted" } else { "REFUSED" });
            failures += 1;
        }
    }
    println!("   this launcher: {}", releases::own_version());
    match releases::resolve_launcher_latest().await {
        Ok(r) => println!("   published launcher: {} ({})", r.version, r.tag),
        // Expected until the first launcher release exists; not a failure.
        Err(e) => println!("   published launcher: none yet ({e})"),
    }

    // HOW DEEP each product sits in the shared feed. Both resolvers walk the list rather than
    // trusting /releases/latest, so the depth of the newest launcher-v* is a real operating number:
    // it only ever grows (the app releases ~10x more often), and when it crossed a page boundary
    // self-update failed everywhere at once with nothing local to see. Printed so it can be watched,
    // not asserted — the number is allowed to grow, it just must stay inside what the walk covers.
    const OLD_PAGE_WINDOW: usize = 30; // what a single un-paginated request used to cover
    match releases::list_tags().await {
        Ok(tags) => {
            let app = tags.iter().position(|t| releases::is_app_tag_for_test(t));
            let launcher = tags.iter().position(|t| t.starts_with("launcher-v"));
            println!("   feed depth: {} releases listed", tags.len());
            println!("   newest app release      at position {}", app.map_or("(none)".to_string(), |i| (i + 1).to_string()));
            println!("   newest launcher release at position {}", launcher.map_or("(none)".to_string(), |i| (i + 1).to_string()));
            if launcher.is_some_and(|i| i >= OLD_PAGE_WINDOW) {
                println!("   .. beyond the first {OLD_PAGE_WINDOW}: this needed pagination to resolve at all");
            }
        }
        Err(e) => println!("   feed depth: unavailable ({e})"),
    }

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

    // The launch-mode rules, asserted without hardware: both are things that fail SILENTLY in the
    // field (an unknown flag is dropped, a normal open that grew a flag is invisible), so neither is
    // safe to leave to the --open path that only runs when someone remembers to pass it.
    line();
    println!("6b. LAUNCH MODES");
    line();
    if !runner::LaunchMode::Normal.flags().is_empty() {
        println!("   !! Normal contributes argv — an ordinary open must stay byte-identical");
        failures += 1;
    }
    if runner::LaunchMode::Calibrate.flags() != ["--calibrate"] {
        println!("   !! Calibrate does not pass --calibrate: {:?}", runner::LaunchMode::Calibrate.flags());
        failures += 1;
    }
    // The version gate. 0.25.1 is the first ArtLux that parses --calibrate; older ones ignore it and
    // open the ordinary editor looking exactly like success.
    for (v, want) in [("0.24.9", true), ("0.25.0", true), ("0.25.1", false), ("0.26.0", false), ("", false)] {
        let got = runner::LaunchMode::Calibrate.too_old(v);
        let shown = if v.is_empty() { "(unknown)" } else { v };
        println!("   calibrate on {shown:<9} -> {}", if got { "refused" } else { "allowed" });
        if got != want {
            println!("   !! expected {}", if want { "refused" } else { "allowed" });
            failures += 1;
        }
    }
    if runner::LaunchMode::Normal.too_old("0.1.0") {
        println!("   !! the ordinary editor must never be version-gated");
        failures += 1;
    }

    if std::env::args().any(|a| a == "--open") {
        line();
        println!("7. OPEN A PROJECT IN ARTLUX");
        line();
        match (scan.installs.first(), projects::scan(&projects::effective_roots(&projects::load_config()), |_| {}).entries.first()) {
            (Some(inst), Some(proj)) => {
                println!("   exe    : {}", inst.exe);
                println!("   project: {}", proj.path);
                // Cold: nothing running, so this must START ArtLux.
                let a = runner::open_project(&inst.exe, &proj.path, runner::LaunchMode::Normal, &inst.version);
                println!("   cold  -> ok={} started_new={} mode_applied={} : {}", a.ok, a.started_new, a.mode_applied, a.message);
                if !a.ok || !a.started_new {
                    println!("   !! expected a fresh start when ArtLux was not running");
                    failures += 1;
                }
                if !a.mode_applied {
                    println!("   !! a cold start chooses the mode — it must never report otherwise");
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
                    // ...and asking for a MODE while it is up must not claim to have applied one:
                    // second-instance routes --project= and discards the rest of the argv.
                    let b = runner::open_project(&inst.exe, &proj.path, runner::LaunchMode::Calibrate, &inst.version);
                    println!("   warm  -> ok={} started_new={} mode_applied={} : {}", b.ok, b.started_new, b.mode_applied, b.message);
                    if b.started_new {
                        println!("   !! claimed a fresh start while ArtLux was already running");
                        failures += 1;
                    }
                    if b.mode_applied {
                        println!("   !! claimed a launch mode was applied to an ArtLux that was already up");
                        failures += 1;
                    }
                }
                let _ = std::process::Command::new("taskkill").args(["/IM", "ArtLux.exe", "/F"]).output();
                println!("   (ArtLux closed)");
            }
            _ => println!("   skipped: need both an install and at least one project"),
        }
    }

    line();
    println!("8. EXAMPLE GALLERY");
    line();
    if let Some(inst) = scan.installs.first() {
        let sets = examples::list(&inst.dir);
        if sets.is_empty() {
            println!("   !! no example sets found in {}", examples::examples_dir(&inst.dir).display());
            failures += 1;
        }
        for s in &sets {
            println!("   {:<16} {:>7} KB  {} project(s){}  \"{}\"",
                s.id, s.size / 1024, s.projects.len(),
                if s.has_tutorial { ", tutorial" } else { "" },
                s.title);
            if !s.blurb.is_empty() {
                let b: String = s.blurb.chars().take(96).collect();
                println!("       {b}…");
            }
        }
        // Copy into a throwaway workspace so the operator's real one is untouched.
        if let Some(set) = sets.iter().find(|s| s.id == "state-machine") {
            let ws = std::env::temp_dir().join("artlux-ws-selftest");
            let _ = std::fs::remove_dir_all(&ws);
            match examples::copy_set(&inst.dir, &set.id, &set.projects[0], &ws) {
                Ok(r) => {
                    println!("   copy 1: {}", r.message);
                    // tuto/ must NOT come across, README.md must.
                    let tuto = std::path::Path::new(&r.dir).join("tuto");
                    let readme = std::path::Path::new(&r.dir).join("README.md");
                    if tuto.exists() { println!("   !! tuto/ was copied — it is docs, already reachable in-app"); failures += 1; }
                    if !readme.is_file() { println!("   !! README.md was not copied — the set's own explanation"); failures += 1; }
                    if !std::path::Path::new(&r.project).is_file() { println!("   !! the project to open is not in the copy"); failures += 1; }
                    // The whole point: the copy must be writable.
                    match std::fs::OpenOptions::new().append(true).open(&r.project) {
                        Ok(_) => println!("   copy is writable — Save will work"),
                        Err(e) => { println!("   !! the copy is NOT writable: {e}"); failures += 1; }
                    }
                    // Collision: a second copy must NOT merge into the first.
                    match examples::copy_set(&inst.dir, &set.id, &set.projects[0], &ws) {
                        Ok(r2) => {
                            println!("   copy 2: {}", r2.message);
                            if !r2.renamed || r2.dir.eq_ignore_ascii_case(&r.dir) {
                                println!("   !! the second copy landed on top of the first");
                                failures += 1;
                            }
                        }
                        Err(e) => { println!("   !! second copy failed: {e}"); failures += 1; }
                    }
                }
                Err(e) => { println!("   !! copy failed: {e}"); failures += 1; }
            }
            let _ = std::fs::remove_dir_all(&ws);
        }
    } else {
        println!("   skipped: ArtLux is not installed");
    }

    line();
    println!("9. MACHINE CHECK");
    line();
    {
        // The bundled copy is what makes a PRE-install check possible; in a dev tree it is the one
        // sync-preflight.cjs wrote. Prefer the installed copy exactly as main.rs does.
        let bundled = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("preflight.ps1");
        let installed = scan.installs.first().map(|i| std::path::Path::new(&i.dir).join("resources").join("scripts").join("preflight.ps1"));
        let script = installed.filter(|p| p.is_file()).unwrap_or(bundled);
        println!("   script: {}", script.display());
        println!("   winget: {}", preflight::winget_available());

        match preflight::read_cached() {
            Some(c) => println!("   cached: {} pass / {} warn / {} fail  (from {})", c.summary.pass, c.summary.warn, c.summary.fail, c.from),
            None => println!("   cached: none yet"),
        }

        let t = std::time::Instant::now();
        match preflight::run(&script, scan.installs.first().map(|i| i.dir.as_str())) {
            Ok(r) => {
                println!("   ran in {:?}: {} pass / {} warn / {} fail / {} skip (from {})",
                    t.elapsed(), r.summary.pass, r.summary.warn, r.summary.fail, r.summary.skip, r.from);
                if r.results.is_empty() {
                    println!("   !! the report carried no results at all");
                    failures += 1;
                }
                // The wire name the UI actually reads. A serde `rename` applies BOTH ways, so
                // this field once arrived correctly and went back out under the PowerShell name,
                // leaving the date blank in the UI with nothing logged.
                let wire = serde_json::to_value(&r).unwrap_or_default();
                if wire.get("generated_at").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                    println!("   !! serialised report has no `generated_at` — the UI would show no date");
                    failures += 1;
                }
                if r.from != "run" {
                    println!("   !! a live run reported itself as coming from the cache");
                    failures += 1;
                }
                // The whole reason this parses at all: exit code 1 means "some check FAILed", and a
                // BOM would have made it unreadable.
                for it in r.results.iter().filter(|i| i.status != "PASS" && i.status != "SKIP") {
                    println!("     {:<5} {:<22} {}", it.status, it.id, it.detail);
                }
                // The install the script found must be the one we told it about, not a guess.
                if let (Some(inst), Some(found)) = (scan.installs.first(), r.results.iter().find(|i| i.id == "install.found")) {
                    if found.status == "PASS" && !found.detail.eq_ignore_ascii_case(&inst.dir) {
                        println!("   !! -InstallDir was ignored: script found {} but we passed {}", found.detail, inst.dir);
                        failures += 1;
                    }
                }
            }
            Err(e) => { println!("   !! {e}"); failures += 1; }
        }
    }

    line();
    println!("10. LIBRARY FOLDERS + UNINSTALL GUARDS");
    line();
    {
        // Round-trip the config the way the UI does, then put it back exactly as found. This runs
        // against the operator's real config file, so restoring it is not optional.
        let original = projects::load_config();
        let defaults = projects::effective_roots(&projects::Config::default());
        println!("   OS defaults ({}): {}", defaults.len(), defaults.join(" | "));

        let probe = std::env::temp_dir().join("artlux-root-probe");
        let _ = std::fs::create_dir_all(&probe);
        let probe_s = probe.to_string_lossy().into_owned();

        let mut cfg = projects::Config { library_roots: Some(defaults.clone()), ..Default::default() };
        cfg.library_roots.as_mut().unwrap().push(probe_s.clone());
        projects::save_config(&cfg).ok();
        let after_add = projects::effective_roots(&projects::load_config());
        println!("   after add   : {} folders", after_add.len());
        if !after_add.iter().any(|r| r.eq_ignore_ascii_case(&probe_s)) {
            println!("   !! the added folder did not survive a save/load round trip");
            failures += 1;
        }

        // Removing everything must persist as an EMPTY list, not read back as "never configured".
        // That distinction is the whole reason Config stores Option<Vec<_>>.
        projects::save_config(&projects::Config { library_roots: Some(vec![]), ..Default::default() }).ok();
        let emptied = projects::effective_roots(&projects::load_config());
        println!("   after removing all: {} folders (must be 0, NOT the defaults)", emptied.len());
        if !emptied.is_empty() {
            println!("   !! an empty list read back as 'never configured' — Reset and Remove-all are indistinguishable");
            failures += 1;
        }

        // Reset clears the field rather than writing the defaults into it, so a later change of
        // Documents location is still followed.
        projects::save_config(&projects::Config { library_roots: None, ..Default::default() }).ok();
        let reset = projects::load_config();
        println!("   after reset : field cleared={} -> {} folders", reset.library_roots.is_none(), projects::effective_roots(&reset).len());
        if reset.library_roots.is_some() {
            println!("   !! reset wrote the defaults in instead of clearing the field");
            failures += 1;
        }

        // The launch mode is remembered, and an absent field still means the ordinary editor — so a
        // config written before the field existed cannot read back as "calibration".
        if reset.launch_mode.unwrap_or_default() != runner::LaunchMode::Normal {
            println!("   !! a config with no launch_mode did not read back as Normal");
            failures += 1;
        }
        projects::save_config(&projects::Config { launch_mode: Some(runner::LaunchMode::Calibrate), ..Default::default() }).ok();
        let kept = projects::load_config().launch_mode.unwrap_or_default();
        println!("   launch mode : round-trips as {kept:?}");
        if kept != runner::LaunchMode::Calibrate {
            println!("   !! the launch mode did not survive a save/load round trip");
            failures += 1;
        }

        projects::save_config(&original).ok();
        let _ = std::fs::remove_dir_all(&probe);
        println!("   config restored");

        // Uninstall guard paths. The happy path is NOT exercised: it would remove a real install,
        // and this machine has no legacy per-user one to practise on.
        let bad = runner::uninstall("");
        println!("   empty command   -> ok={} : {}", bad.ok, bad.message);
        if bad.ok { println!("   !! an empty uninstall command reported success"); failures += 1; }
        let missing = runner::uninstall("\"C:\\nope\\Uninstall ArtLux.exe\" /currentuser /S");
        println!("   missing exe     -> ok={} : {}", missing.ok, missing.message);
        if missing.ok { println!("   !! a missing uninstaller reported success"); failures += 1; }
    }

    line();
    println!("11. NEW PROJECT (the launcher makes the FOLDER; ArtLux writes the document)");
    line();
    {
        let ws = std::env::temp_dir().join("artlux-newproj-selftest");
        let _ = std::fs::remove_dir_all(&ws);

        // Names that must be REFUSED rather than silently corrected. A user who typed `Show: A` and
        // got `Show A` has been quietly overruled and will look for the name they typed.
        let bad = [
            ("empty", ""),
            ("whitespace", "   "),
            ("illegal colon", "Show: A"),
            ("path separator", "Show/A"),
            ("backslash", r"Show\A"),
            ("wildcard", "Show*"),
            ("trailing dot", "Show."),
            ("reserved device", "NUL"),
            ("reserved, cased", "CoN"),
        ];
        for (label, name) in bad {
            match projects::create_project_folder(&ws, name) {
                Ok(p) => {
                    println!("   !! '{label}' was ACCEPTED and made {}", p.dir);
                    failures += 1;
                }
                Err(e) => println!("   refused {:<18} {}", label, e),
            }
        }

        // Trailing whitespace is TRIMMED, not refused -- invisible, always accidental, and trimmed by
        // every name field there is. Asserted explicitly so the difference from the refusals above
        // stays a decision rather than an accident.
        match projects::create_project_folder(&ws, "  Trimmed  ") {
            Ok(t) => {
                let leaf = std::path::Path::new(&t.dir).file_name().unwrap_or_default().to_string_lossy().into_owned();
                println!("   trimmed  : '  Trimmed  ' -> '{leaf}'");
                if leaf != "Trimmed" { println!("   !! whitespace was not trimmed"); failures += 1; }
            }
            Err(e) => { println!("   !! a name with surrounding spaces was refused: {e}"); failures += 1; }
        }

        // The happy path, then the collision rule.
        match projects::create_project_folder(&ws, "My Show") {
            Ok(a) => {
                println!("   created  : {}", a.dir);
                if !std::path::Path::new(&a.dir).is_dir() { println!("   !! the folder was not created"); failures += 1; }
                // The launcher must NOT have written a project file — that is ArtLux's job.
                if std::path::Path::new(&a.project_file).exists() {
                    println!("   !! the launcher wrote a project file; only ArtLux may define one");
                    failures += 1;
                }
                match projects::create_project_folder(&ws, "My Show") {
                    Ok(b) => {
                        println!("   again    : {}", b.message);
                        if !b.renamed || b.dir.eq_ignore_ascii_case(&a.dir) {
                            println!("   !! the second project landed on top of the first");
                            failures += 1;
                        }
                    }
                    Err(e) => { println!("   !! second create failed: {e}"); failures += 1; }
                }
            }
            Err(e) => { println!("   !! 'My Show' was refused: {e}"); failures += 1; }
        }
        let _ = std::fs::remove_dir_all(&ws);
    }

    if std::env::args().any(|a| a == "--create") {
        line();
        println!("12. CREATE A PROJECT FOR REAL (launcher makes the folder, ArtLux writes it)");
        line();
        // The whole chain minus the button's onClick: WebView2 does not receive synthetic keystrokes,
        // so the React handler is the one link automation cannot drive here.
        match scan.installs.first() {
            Some(inst) => {
                let ws = std::env::temp_dir().join("artlux-create-e2e");
                let _ = std::fs::remove_dir_all(&ws);
                match projects::create_project_folder(&ws, "Venue Test") {
                    Ok(made) => {
                        println!("   folder : {}", made.dir);
                        println!("   file   : {} (does not exist yet: {})", made.project_file, !std::path::Path::new(&made.project_file).exists());
                        let out = runner::new_project(&inst.exe, &made.dir, &made.project_file);
                        println!("   spawn  : ok={} {}", out.ok, out.message);
                        let appeared = std::path::Path::new(&made.project_file).is_file();
                        // ON AN OLD ARTLUX THE REFUSAL IS THE CORRECT OUTCOME, not a failure: 0.25.0
                        // has no --new-project= and ignores the flag entirely. What must never happen
                        // is ok=true with no file -- a success nobody observed.
                        if out.ok && !appeared {
                            println!("   !! reported success while writing nothing");
                            failures += 1;
                        } else if !out.ok && !appeared {
                            println!("   correctly refused: the installed ArtLux predates the flag");
                        }
                        if appeared {
                            let text = std::fs::read_to_string(&made.project_file).unwrap_or_default();
                            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                            let count = |k: &str| v.get(k).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
                            println!("   written: version={} surfaces={} fixtures={} cueBanks={}",
                                v.get("version").and_then(|x| x.as_str()).unwrap_or("?"),
                                count("surfaces"), count("fixtures"), count("cueBanks"));
                            let leaked: Vec<&str> = ["scenes","assets","projectorOutputs","schedule","controllers"]
                                .into_iter().filter(|k| count(k) != 0).collect();
                            println!("   leaked : {}", if leaked.is_empty() { "nothing".to_string() } else { leaked.join(", ") });
                            if !leaked.is_empty() { failures += 1; }
                            // assets/ tree, laid out by main via prepareNewProjectFolder.
                            let assets = std::path::Path::new(&made.dir).join("assets");
                            println!("   assets : {}", if assets.is_dir() { "laid out" } else { "MISSING" });
                            if !assets.is_dir() { failures += 1; }
                        }
                        let _ = std::process::Command::new("taskkill").args(["/IM", "ArtLux.exe", "/F"]).output();
                    }
                    Err(e) => { println!("   !! {e}"); failures += 1; }
                }
                let _ = std::fs::remove_dir_all(&ws);
            }
            None => println!("   skipped: ArtLux is not installed"),
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
