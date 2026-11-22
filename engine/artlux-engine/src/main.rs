//! `artlux-engine` — E0 skeleton. Nothing renders a show yet; this proves the device, the software
//! rule and the two exact GPU jobs on every OS (plans/native-engine.md §6b).
//!
//!   artlux-engine --info                      every adapter the native API offers, best first
//!   artlux-engine --selftest                  the headless test on the best HARDWARE adapter
//!   artlux-engine --selftest --allow-software the same, falling back to WARP / lavapipe (CI)
//!   artlux-engine --selftest --software       on the software adapter even when hardware exists
//!   artlux-engine --write-goldens <dir>       write the CPU references as the goldens
//!   artlux-engine --windows [--fullscreen] [--seconds N]   a window on every display (E0b)
//!   artlux-engine --share <pid> [--seconds N]              shared textures for Electron main (E0c, Windows)

use artlux_engine::*;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--info") {
        println!("backend: {:?}", native_backends());
        for info in list_adapters() {
            println!("  {}{}", describe(&info), if is_software(&info) { "  [software]" } else { "" });
        }
        return ExitCode::SUCCESS;
    }
    if let Some(i) = args.iter().position(|a| a == "--write-goldens") {
        let dir = std::path::PathBuf::from(args.get(i + 1).map(String::as_str).unwrap_or("tests/golden"));
        std::fs::create_dir_all(&dir).expect("golden dir");
        std::fs::write(dir.join("frame64.rgba"), frame_reference()).expect("write frame golden");
        std::fs::write(dir.join("leds96.rgb"), leds_reference()).expect("write leds golden");
        println!("goldens written to {}", dir.display());
        return ExitCode::SUCCESS;
    }
    #[cfg(windows)]
    if let Some(pid) = args.iter().position(|a| a == "--share").and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<u32>().ok()) {
        // E0c: shared textures for an Electron main process (its pid), protocol on stdin/stdout.
        let secs = args.iter().position(|a| a == "--seconds").and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<f64>().ok());
        let policy = AdapterPolicy { allow_software: has("--allow-software"), force_software: has("--software") };
        return match artlux_engine::share::run(pid, 640, 360, secs.map(std::time::Duration::from_secs_f64), policy) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => { eprintln!("artlux-engine: {e}"); ExitCode::from(2) }
        };
    }
    if has("--windows") {
        // E0b: a window on every display (--fullscreen: borderless on each), presenting the test card.
        let secs = args.iter().position(|a| a == "--seconds").and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<f64>().ok());
        let options = artlux_engine::windows::WindowOptions {
            fullscreen: has("--fullscreen"),
            run_for: secs.map(std::time::Duration::from_secs_f64),
            policy: AdapterPolicy { allow_software: has("--allow-software"), force_software: false },
        };
        return match artlux_engine::windows::run(options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => { eprintln!("artlux-engine: {e}"); ExitCode::from(2) }
        };
    }
    let policy = AdapterPolicy { allow_software: has("--allow-software") || has("--software"), force_software: has("--software") };
    let gpu = match Gpu::open(policy) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("artlux-engine: {e}");
            return ExitCode::from(2);
        }
    };
    if has("--selftest") {
        return match selftest(&gpu) {
            Ok(lines) => {
                for l in lines { println!("{l}"); }
                println!("selftest OK");
                ExitCode::SUCCESS
            }
            Err(lines) => {
                for l in lines { println!("{l}"); }
                println!("selftest FAILED");
                ExitCode::from(1)
            }
        };
    }
    println!("artlux-engine (E0 skeleton) on {}: nothing to run yet — try --selftest", describe(&gpu.info));
    ExitCode::SUCCESS
}
