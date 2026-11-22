//! E1a — THE ENGINE AS ARTLUX'S CHILD PROCESS: `artlux-engine --serve` (plans/native-engine.md §9c).
//!
//! Main (src/main/engineHost.ts) spawns it and talks newline-delimited JSON over stdio:
//!   engine → main   {"type":"hello","version":"…","adapter":"…","backend":"…","pid":N}   once, device open
//!   main → engine   {"ping":N}             every second
//!   engine → main   {"type":"pong","n":N}  the answer — an engine that stops answering is HUNG, and main
//!                                          kills and restarts it
//!   main → engine   {"quit":true}          a clean stop
//! stdin closing (main gone, crashed or quit) also ends it: the engine never outlives the app.
//!
//! Exit codes main acts on: 0 clean, 2 REFUSED (no usable hardware adapter — restarting would refuse
//! again, so main logs it and does not loop), anything else a crash → restart.
//!
//! TEST HOOK (the harness only): when `ARTLUX_ENGINE_TEST_HANG_FILE` names a file that EXISTS, the engine
//! deletes it and stops answering pings two seconds after its hello. One-shot by construction — the file
//! is gone for the restarted engine — so a packaged-app probe can prove hang detection without CDP.

use crate::{describe, native_backends, AdapterPolicy, Gpu};
use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::time::Duration;

fn field_u64(line: &str, key: &str) -> Option<u64> {
    let rest = line.split(&format!("\"{key}\":")).nth(1)?;
    let digits: String = rest.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn json_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn run(policy: AdapterPolicy) -> ExitCode {
    let gpu = match Gpu::open(policy) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("artlux-engine: {e}");
            return ExitCode::from(2);
        }
    };
    let hang = std::env::var_os("ARTLUX_ENGINE_TEST_HANG_FILE")
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .map(|p| { let _ = std::fs::remove_file(&p); std::time::Instant::now() + Duration::from_secs(2) });
    let mut out = std::io::stdout().lock();
    let hello = format!(
        r#"{{"type":"hello","version":{},"adapter":{},"backend":{},"pid":{}}}"#,
        json_str(env!("CARGO_PKG_VERSION")),
        json_str(&describe(&gpu.info)),
        json_str(&format!("{:?}", native_backends())),
        std::process::id()
    );
    if writeln!(out, "{hello}").and_then(|_| out.flush()).is_err() { return ExitCode::SUCCESS; }
    if hang.is_some() { eprintln!("artlux-engine: TEST HOOK — will stop answering pings in 2 s"); }
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.contains("\"quit\"") { break; }
        if let Some(n) = field_u64(&line, "ping") {
            if hang.is_some_and(|t| std::time::Instant::now() >= t) {
                // A hang, as main sees one: alive, reading, never answering.
                loop { std::thread::sleep(Duration::from_secs(3600)); }
            }
            if writeln!(out, r#"{{"type":"pong","n":{n}}}"#).and_then(|_| out.flush()).is_err() { break; }
        }
    }
    drop(gpu);
    ExitCode::SUCCESS
}
