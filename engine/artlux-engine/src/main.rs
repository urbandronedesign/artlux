//! `artlux-engine` — E0 skeleton. Nothing renders a show yet; this proves the device, the software
//! rule and the two exact GPU jobs on every OS (plans/native-engine.md §6b).
//!
//!   artlux-engine --pack-batch <in> <out>  universe packing for the parity harness (E1b)
//!   artlux-engine --wire-replay <in.json>  pack, encode and SEND frames via the output core (E1c)
//!   artlux-engine --serve                     ArtLux main's child: hello / ping / pong / quit on stdio (E1a)
//!   artlux-engine --info                      every adapter the native API offers, best first
//!   artlux-engine --selftest                  the headless test on the best HARDWARE adapter
//!   artlux-engine --selftest --allow-software the same, falling back to WARP / lavapipe (CI)
//!   artlux-engine --selftest --software       on the software adapter even when hardware exists
//!   artlux-engine --write-goldens <dir>       write the CPU references as the goldens
//!   artlux-engine --windows [--fullscreen] [--seconds N]   a window on every display (E0b)
//!   artlux-engine --share <pid> [--seconds N]              shared textures for Electron main (E0c, Windows)
//!   artlux-engine --hap <file.mov> [--frame N]             a HAP frame as a BC texture vs the CPU decode (E0d)
//!   artlux-engine --spout-send <name> / --spout-receive <name>   a real Spout sender, and the engine receiving it (E0d)

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
    if let Some(i) = args.iter().position(|a| a == "--sample-batch") {
        // E1b-2 parity, GPU half: WebGPUMapper's atlas + layout in, the engine's sampled bytes out.
        use base64::Engine as _;
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct C { name: String, atlas_w: u32, atlas_h: u32, atlas: String, led: String, meta: String, seg_params: String, rects: String, brightness: f32, surfaces: u32 }
        let (Some(inp), Some(outp)) = (args.get(i + 1), args.get(i + 2)) else { eprintln!("usage: --sample-batch <in.json> <out.json>"); return ExitCode::from(2); };
        let cases: Vec<C> = match std::fs::read_to_string(inp).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
            Ok(c) => c, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); }
        };
        let gpu = match Gpu::open(AdapterPolicy { allow_software: has("--allow-software"), force_software: has("--software") }) { Ok(g) => g, Err(e) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(2); } };
        let b64 = base64::engine::general_purpose::STANDARD;
        let f32s = |s: &str| -> Vec<f32> { b64.decode(s).unwrap_or_default().chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect() };
        let mut outs = Vec::new();
        for c in &cases {
            let atlas = b64.decode(&c.atlas).unwrap_or_default();
            let (led, meta, seg, rects) = (f32s(&c.led), f32s(&c.meta), f32s(&c.seg_params), f32s(&c.rects));
            let input = artlux_engine::sample::SampleInput { atlas_w: c.atlas_w, atlas_h: c.atlas_h, atlas_rgba: &atlas, led: &led, meta: &meta, seg_params: &seg, rects: &rects, brightness: c.brightness, surfaces: c.surfaces };
            match artlux_engine::sample::sample(&gpu, &input) {
                Ok(v) => outs.push(serde_json::json!({ "name": c.name, "out": b64.encode(v) })),
                Err(e) => { eprintln!("{}: {e}", c.name); return ExitCode::from(1); }
            }
        }
        let doc = serde_json::json!({ "adapter": describe(&gpu.info), "cases": outs });
        return match std::fs::write(outp, doc.to_string()) { Ok(()) => ExitCode::SUCCESS, Err(e) => { eprintln!("{outp}: {e}"); ExitCode::from(2) } };
    }
    if let Some(i) = args.iter().position(|a| a == "--wire-replay") {
        // E1c: pack + encode + SEND a sequence of frames through the app's own output core (no Node), for
        // scripts/test-wire-parity.cjs, which sends the same frames through the addon and compares the wire.
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Replay { sync: bool, gap_ms: u64, frames: Vec<artlux_engine::pack::Case> }
        let Some(inp) = args.get(i + 1) else { eprintln!("usage: --wire-replay <in.json>"); return ExitCode::from(2); };
        let r: Replay = match std::fs::read_to_string(inp).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
            Ok(r) => r, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); }
        };
        let out = artlux_output_engine::core::OutputEngine::start(false);
        out.configure(44.0, false, r.sync);   // keep-alive OFF: only the frames pushed reach the wire
        for c in &r.frames {
            let lut = artlux_engine::pack::gamma_lut(c.gamma);
            let dests = artlux_engine::pack::pack(&c.raw, &c.fixtures, &c.controllers, &c.defaults, &lut);
            out.push_frame(&artlux_engine::wire::encode_frame(&dests, c.port));
            std::thread::sleep(std::time::Duration::from_millis(r.gap_ms));
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        out.close();
        return ExitCode::SUCCESS;
    }
    if let Some(i) = args.iter().position(|a| a == "--layout-batch") {
        // E1b-2 parity: the LED layout + atlas plan for scripts/test-sampling-parity.cjs.
        let (Some(inp), Some(outp)) = (args.get(i + 1), args.get(i + 2)) else { eprintln!("usage: --layout-batch <in.json> <out.json>"); return ExitCode::from(2); };
        let text = match std::fs::read_to_string(inp) { Ok(t) => t, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); } };
        let cases: Vec<artlux_engine::layout::Case> = match serde_json::from_str(&text) { Ok(b) => b, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); } };
        let out: Vec<_> = cases.iter().map(artlux_engine::layout::run_case).collect();
        return match std::fs::write(outp, serde_json::to_string(&out).expect("serialise")) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => { eprintln!("{outp}: {e}"); ExitCode::from(2) }
        };
    }
    if let Some(i) = args.iter().position(|a| a == "--pack-batch") {
        // E1b parity: scripts/test-pack-parity.cjs writes a batch of cases, this packs each.
        let (Some(inp), Some(outp)) = (args.get(i + 1), args.get(i + 2)) else {
            eprintln!("usage: --pack-batch <in.json> <out.json>");
            return ExitCode::from(2);
        };
        let text = match std::fs::read_to_string(inp) { Ok(t) => t, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); } };
        let batch: artlux_engine::pack::Batch = match serde_json::from_str(&text) { Ok(b) => b, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); } };
        let out = artlux_engine::pack::run_batch(&batch);
        return match std::fs::write(outp, serde_json::to_string(&out).expect("serialise")) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => { eprintln!("{outp}: {e}"); ExitCode::from(2) }
        };
    }
    if has("--serve") {
        // E1a: ArtLux main's child (src/main/engineHost.ts) — hello / ping / pong / quit on stdio.
        return artlux_engine::serve::run(AdapterPolicy { allow_software: has("--allow-software"), force_software: false });
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
    if let Some(path) = args.iter().position(|a| a == "--hap").and_then(|i| args.get(i + 1)) {
        // E0d: a real HAP file's frame as a BC texture, held to the CPU decode; and the fallback.
        let frame = args.iter().position(|a| a == "--frame").and_then(|i| args.get(i + 1)).and_then(|s| s.parse().ok()).unwrap_or(0);
        let gpu = match Gpu::open(AdapterPolicy { allow_software: has("--allow-software"), force_software: has("--software") }) {
            Ok(g) => g,
            Err(e) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(2); }
        };
        println!("adapter: {}", describe(&gpu.info));
        return match artlux_engine::hapimport::check_file(&gpu, path, frame) {
            Ok(r) => {
                println!("file: {path}
  codec {} ({:?}), {}x{}, frame {} of {}", r.codec, r.format, r.size.0, r.size.1, r.frame, r.frames);
                println!("  GPU path: {}", r.gpu_path);
                println!("  {} sample points: {} exact vs the CPU decode, largest channel difference {}", r.points, r.exact, r.max_diff);
                println!("  CPU-upload fallback identical to the CPU decode: {}", r.fallback_exact);
                if r.fallback_exact { ExitCode::SUCCESS } else { ExitCode::from(1) }
            }
            Err(e) => { eprintln!("artlux-engine: {e}"); ExitCode::from(1) }
        };
    }
    #[cfg(windows)]
    if let Some(name) = args.iter().position(|a| a == "--spout-send").and_then(|i| args.get(i + 1)) {
        let secs = args.iter().position(|a| a == "--seconds").and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<f64>().ok());
        return match artlux_engine::spout::send(name, secs.map(std::time::Duration::from_secs_f64)) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => { eprintln!("artlux-engine: {e}"); ExitCode::from(2) }
        };
    }
    #[cfg(windows)]
    if let Some(name) = args.iter().position(|a| a == "--spout-receive").and_then(|i| args.get(i + 1)) {
        let secs = args.iter().position(|a| a == "--seconds").and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<f64>().ok()).unwrap_or(3.0);
        let policy = AdapterPolicy { allow_software: has("--allow-software"), force_software: has("--software") };
        return match artlux_engine::spout::receive(name, std::time::Duration::from_secs_f64(secs), policy) {
            Ok(r) => {
                let moved = r.bar_positions.windows(2).filter(|w| w[0] >= 0 && w[1] >= 0 && w[0] != w[1]).count();
                let seen = r.bar_positions.iter().filter(|&&x| x >= 0).count();
                println!("zero-copy: {}", r.direct_open);
                println!("path used: {}", r.path);
                println!("frames read: {}; test-card quadrants exact in {}; bar found in {}, moved between reads {} times",
                    r.frames_read, r.quads_exact, seen, moved);
                let mut ok = r.frames_read > 10 && r.quads_exact == r.frames_read && seen as u32 == r.frames_read && moved > 5;
                if let Some((exact, bars)) = &r.direct {
                    let dseen = bars.iter().filter(|&&x| x >= 0).count();
                    let dmoved = bars.windows(2).filter(|w| w[0] >= 0 && w[1] >= 0 && w[0] != w[1]).count();
                    println!("ZERO-COPY read (the sender's own texture, sampled in D3D12): quadrants exact in {exact}/{}; bar found in {dseen}, moved {dmoved} times", bars.len());
                    ok &= *exact as usize == bars.len() && dseen == bars.len() && dmoved > 5;
                }
                println!("{}", if ok { "spout receive OK" } else { "spout receive FAILED" });
                if ok { ExitCode::SUCCESS } else { ExitCode::from(1) }
            }
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
