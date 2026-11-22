//! `artlux-engine` — E0 skeleton. Nothing renders a show yet; this proves the device, the software
//! rule and the two exact GPU jobs on every OS (plans/native-engine.md §6b).
//!
//!   artlux-engine --pack-batch <in> <out>  universe packing for the parity harness (E1b)
//!   artlux-engine --wire-replay <in.json>  pack, encode and SEND frames via the output core (E1c)
//!   artlux-engine --frame-once <project> <out>  one whole frame from a project (E1d)
//!   artlux-engine --project-once <in> <out>   a picture through projector settings, offscreen (E1e-1)
//!   artlux-engine --project-windows <in> [--seconds N]   projector outputs as native windows (E1e-2)
//!   artlux-engine --serve                     ArtLux main's child: hello / ping / pong / quit on stdio (E1a)
//!   artlux-engine --info                      every adapter the native API offers, best first
//!   artlux-engine --selftest                  the headless test on the best HARDWARE adapter
//!   artlux-engine --selftest --allow-software the same, falling back to WARP / lavapipe (CI)
//!   artlux-engine --selftest --software       on the software adapter even when hardware exists
//!   artlux-engine --write-goldens <dir>       write the CPU references as the goldens
//!   artlux-engine --windows [--fullscreen] [--seconds N]   a window on every display (E0b)
//!   artlux-engine --share <pid> [--seconds N]              shared textures for Electron main (E0c, Windows)
//!   artlux-engine --hap <file.mov> [--frame N]             a HAP frame as a BC texture vs the CPU decode (E0d)
//!   artlux-engine --spout-send <name> [--image f] / --spout-receive <name>   a real Spout sender (test card or a picture), and the engine receiving it (E0d, E1d-3)

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
    if let Some(i) = args.iter().position(|a| a == "--decode") {
        // Diagnostic: a picture as the engine decodes it (premultiplied RGBA8, raw) — to compare decoders.
        let (Some(inp), Some(outp)) = (args.get(i + 1), args.get(i + 2)) else { eprintln!("usage: --decode <image> <out.raw>"); return ExitCode::from(2); };
        return match artlux_engine::compose::load_image(std::path::Path::new(inp)) {
            Ok(p) => { println!("{}x{}", p.w, p.h); std::fs::write(outp, &p.rgba).map(|_| ExitCode::SUCCESS).unwrap_or(ExitCode::from(2)) }
            Err(e) => { eprintln!("{e}"); ExitCode::from(1) }
        };
    }
    if let Some(i) = args.iter().position(|a| a == "--frame-once") {
        // E1d: one whole frame from a project — its IMAGE surfaces decoded, the engine's own atlas, the
        // LEDs sampled — for scripts/test-image-parity.cjs. Writes {"rgbw": base64, "adapter": …}.
        use base64::Engine as _;
        let (Some(inp), Some(outp)) = (args.get(i + 1), args.get(i + 2)) else { eprintln!("usage: --frame-once <project.artlux> <out.json> [--brightness b] [--video-frame N] [--effect-times a,b,…] [--seed N]"); return ExitCode::from(2); };
        let brightness = args.iter().position(|a| a == "--brightness").and_then(|k| args.get(k + 1)).and_then(|s| s.parse::<f32>().ok()).unwrap_or(1.0);
        let doc: serde_json::Value = match std::fs::read_to_string(inp).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
            Ok(v) => v, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); }
        };
        let fixtures: Vec<artlux_engine::layout::Fixture> = serde_json::from_value(doc["fixtures"].clone()).unwrap_or_default();
        let surfaces: Vec<artlux_engine::layout::Surface> = serde_json::from_value(doc["surfaces"].clone()).unwrap_or_default();
        let base = std::path::Path::new(inp).parent().unwrap_or(std::path::Path::new("."));
        // E1d-2: a VIDEO surface whose file is HAP draws frame `--video-frame N` (the app picks it from the
        // show clock). A `.hapframe.json` ({width, height, format, data: base64 blocks}, the app's HapFrame) is
        // a TEST input: synthetic blocks for the formats and sizes no file on hand has.
        let video_frame = args.iter().position(|a| a == "--video-frame").and_then(|k| args.get(k + 1)).and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
        let gpu = match Gpu::open(AdapterPolicy { allow_software: has("--allow-software"), force_software: has("--software") }) { Ok(g) => g, Err(e) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(2); } };
        let mut pictures = std::collections::HashMap::new();
        let mut opacity = std::collections::HashMap::new();
        // E1d-4: EFFECT surfaces are rendered at each time of `--effect-times a,b,…` IN ORDER (surfaces in
        // document order within a time — the order the app's frame engine asks), the last field drawn; Fire
        // steps on each, from the mulberry32 stream `--seed N` (default 1).
        let effect_times: Vec<f64> = args.iter().position(|a| a == "--effect-times").and_then(|k| args.get(k + 1))
            .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect()).unwrap_or_else(|| vec![0.0]);
        let mut rng = artlux_engine::effects::Rng::new(args.iter().position(|a| a == "--seed").and_then(|k| args.get(k + 1)).and_then(|s| s.parse().ok()).unwrap_or(1));
        {
            let fx: Vec<(String, artlux_engine::effects::Params)> = doc["surfaces"].as_array().into_iter().flatten()
                .filter(|s| s["content"]["type"].as_str() == Some("EFFECT"))
                .map(|s| (s["id"].as_str().unwrap_or_default().to_string(), artlux_engine::effects::Params::from_json(&s["content"]))).collect();
            let mut state: Vec<artlux_engine::effects::SurfaceEffect> = fx.iter().map(|_| Default::default()).collect();
            for &t in &effect_times { for (k, (_, p)) in fx.iter().enumerate() { state[k].render(*p, t, &mut rng); } }
            let last = *effect_times.last().unwrap_or(&0.0);
            for (k, (id, p)) in fx.iter().enumerate() {
                let rgba = state[k].render(*p, last, &mut rng).to_vec();   // cached: no extra step
                pictures.insert(id.clone(), artlux_engine::compose::Picture::canvas(artlux_engine::effects::FW as u32, artlux_engine::effects::FH as u32, rgba));
            }
        }
        for s in doc["surfaces"].as_array().into_iter().flatten() {
            let id = s["id"].as_str().unwrap_or_default().to_string();
            let c = &s["content"];
            if let Some(o) = c["opacity"].as_f64() { opacity.insert(id.clone(), o as f32); }
            let url = c["url"].as_str().unwrap_or_default();
            let p = std::path::Path::new(url.trim_start_matches("file:///"));
            let p = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
            let pic = match c["type"].as_str() {
                Some("IMAGE") => artlux_engine::compose::load_image(&p).map_err(|e| format!("image: {e}")),
                // Item 2c: a decoded MP4 frame's planes (`.nv12.json`, written by test:mp4-parity from the app's
                // own VideoFrame.copyTo) — the conversion and the stretch, without the decoder.
                Some("VIDEO") if url.ends_with(".nv12.json") => nv12_picture(&p),
                // Item 2c-2: an MP4 decoded by the engine itself (mf.rs) at `content.frameTs` (µs, the app's
                // VideoFrame.timestamp — what the host will send), converted and drawn.
                #[cfg(windows)]
                Some("VIDEO") if url.to_ascii_lowercase().ends_with(".mp4") => artlux_engine::mf::Mp4In::open(&p.to_string_lossy())
                    .and_then(|mut rx| rx.frame_at(c["frameTs"].as_i64().unwrap_or(0)).map(|f| artlux_engine::yuv::to_picture(&f.nv12())))
                    .map_err(|e| format!("mp4: {e}")),
                Some("VIDEO") if url.ends_with(".hapframe.json") => (|| {
                    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                    let fmt = artlux_engine::hapimport::format_from_str(j["format"].as_str().unwrap_or_default()).ok_or("unknown format")?;
                    let blocks = base64::engine::general_purpose::STANDARD.decode(j["data"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
                    artlux_engine::compose::hap_picture(&gpu, fmt, j["width"].as_u64().unwrap_or(0) as u32, j["height"].as_u64().unwrap_or(0) as u32, &blocks)
                })().map_err(|e| format!("hap frame {}: {e}", p.display())),
                #[cfg(windows)]
                Some("SPOUT") => artlux_engine::spout::grab(&gpu, c["spoutName"].as_str().unwrap_or_default())
                    .map(|(pic, how)| { eprintln!("artlux-engine: spout '{}': {how}", c["spoutName"].as_str().unwrap_or_default()); pic })
                    .map_err(|e| format!("spout: {e}")),
                Some("VIDEO") => artlux_engine::hapimport::read_frame(&p.to_string_lossy(), video_frame)
                    .and_then(|(w, h, fmt, blocks, _)| artlux_engine::compose::hap_picture(&gpu, fmt, w, h, &blocks))
                    .map_err(|e| format!("video {}: {e} (only HAP is drawn by the engine so far)", p.display())),
                _ => continue,
            };
            match pic { Ok(pic) => { pictures.insert(id, pic); } Err(e) => eprintln!("artlux-engine: {e}") }
        }
        let fd = artlux_engine::compose::FrameDoc { fixtures: &fixtures, surfaces: &surfaces, pictures: &pictures, opacity: &opacity, brightness };
        return match artlux_engine::compose::frame(&gpu, &fd) {
            Ok(rgbw) => {
                let out = serde_json::json!({ "adapter": describe(&gpu.info), "rgbw": base64::engine::general_purpose::STANDARD.encode(rgbw) });
                match std::fs::write(outp, out.to_string()) { Ok(()) => ExitCode::SUCCESS, Err(e) => { eprintln!("{outp}: {e}"); ExitCode::from(2) } }
            }
            Err(e) => { eprintln!("artlux-engine: {e}"); ExitCode::from(1) }
        };
    }
    #[cfg(windows)]
    if let Some(i) = args.iter().position(|a| a == "--mp4-frames") {
        // Item 2c-2: the engine's OWN decode of an MP4 (mf.rs), frames asked for by timestamp (µs) IN THE
        // ORDER GIVEN — so a backward one exercises the seek. Each lands as `<out>.f<k>.nv12.json` + planes,
        // the layout the app's VideoFrame.copyTo dump has, for scripts/test-mp4-parity.cjs to compare.
        let (Some(file), Some(list), Some(out)) = (args.get(i + 1), args.get(i + 2), args.get(i + 3)) else { eprintln!("usage: --mp4-frames <file.mp4> <ts,ts,…> <out-prefix>"); return ExitCode::from(2); };
        let mut rx = match artlux_engine::mf::Mp4In::open(file) { Ok(r) => r, Err(e) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(1); } };
        let c = rx.colour();
        let colour = serde_json::json!({ "matrix": c.matrix, "fullRange": c.full_range, "primaries": c.primaries, "transfer": c.transfer });
        for (k, ts) in list.split(',').filter_map(|t| t.trim().parse::<i64>().ok()).enumerate() {
            let f = match rx.frame_at(ts) { Ok(f) => f, Err(e) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(1); } };
            let (w, h) = (f.coded.0 as u64, f.coded.1 as u64);
            let planes = format!("{}.f{k}.planes.bin", std::path::Path::new(out).file_name().unwrap_or_default().to_string_lossy());
            let meta = serde_json::json!({ "coded": [w, h], "visible": f.visible, "timestamp": f.ts_us, "format": "NV12", "colorSpace": colour,
                "layout": [{ "offset": 0, "stride": w }, { "offset": w * h, "stride": w }], "planes": planes });
            let dir = std::path::Path::new(out).parent().unwrap_or(std::path::Path::new("."));
            if let Err(e) = std::fs::write(dir.join(&planes), &f.data).and_then(|_| std::fs::write(format!("{out}.f{k}.nv12.json"), meta.to_string())) {
                eprintln!("{out}: {e}"); return ExitCode::from(2);
            }
        }
        return ExitCode::SUCCESS;
    }
    if let Some(i) = args.iter().position(|a| a == "--nv12-convert") {
        // Item 2c: one `.nv12.json` frame → its VISIBLE rect as RGBA, 1:1 — for the conversion gate.
        let (Some(inp), Some(outp)) = (args.get(i + 1), args.get(i + 2)) else { eprintln!("usage: --nv12-convert <frame.nv12.json> <out.rgba>"); return ExitCode::from(2); };
        return match nv12_picture(std::path::Path::new(inp)) {
            Ok(pic) => {
                let [vx, vy, vw, vh] = pic.crop.unwrap_or([0, 0, pic.w, pic.h]);
                let mut out = Vec::with_capacity((vw * vh * 4) as usize);
                for y in vy..vy + vh { let o = ((y * pic.w + vx) * 4) as usize; out.extend_from_slice(&pic.rgba[o..o + (vw * 4) as usize]); }
                match std::fs::write(outp, out) { Ok(()) => ExitCode::SUCCESS, Err(e) => { eprintln!("{outp}: {e}"); ExitCode::from(2) } }
            }
            Err(e) => { eprintln!("artlux-engine: {e}"); ExitCode::from(1) }
        };
    }
    if let Some(i) = args.iter().position(|a| a == "--project-once") {
        // E1e-1: a picture through each case's projector settings, offscreen, for
        // scripts/test-projector-parity.cjs. In: {width, height, picture, cases: [{name, output, brightness, aa}]}.
        use base64::Engine as _;
        let (Some(inp), Some(outp)) = (args.get(i + 1), args.get(i + 2)) else { eprintln!("usage: --project-once <in.json> <out.json>"); return ExitCode::from(2); };
        let job: serde_json::Value = match std::fs::read_to_string(inp).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
            Ok(v) => v, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); }
        };
        let gpu = match Gpu::open(AdapterPolicy { allow_software: has("--allow-software"), force_software: has("--software") }) { Ok(g) => g, Err(e) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(2); } };
        let img = match image::open(job["picture"].as_str().unwrap_or_default()) { Ok(i) => i.to_rgba8(), Err(e) => { eprintln!("picture: {e}"); return ExitCode::from(2); } };
        let content = artlux_engine::projector::content_texture(&gpu, img.width(), img.height(), img.as_raw());
        let (w, h) = (job["width"].as_u64().unwrap_or(640) as u32, job["height"].as_u64().unwrap_or(360) as u32);
        let mut out = Vec::new();
        for c in job["cases"].as_array().into_iter().flatten() {
            let o = artlux_engine::projector::Opts::from_json(&c["output"], c["brightness"].as_f64().unwrap_or(1.0), c["aa"].as_u64().unwrap_or(4) as u32);
            // A BAKED case: {baked: {w, h, uv: file of f32 (u, v, spare) with NaN misses, alpha?: {w, h, file}}}.
            let r = if let Some(b) = c["baked"].as_object() {
                let bw = b["w"].as_u64().unwrap_or(0) as u32; let bh = b["h"].as_u64().unwrap_or(0) as u32;
                let raw = std::fs::read(b["uv"].as_str().unwrap_or_default()).unwrap_or_default();
                let uv: Vec<f32> = raw.chunks_exact(4).map(|q| f32::from_le_bytes([q[0], q[1], q[2], q[3]])).collect();
                let adata = b.get("alpha").and_then(|a| a["file"].as_str()).and_then(|f| std::fs::read(f).ok());
                let alpha = b.get("alpha").and_then(|a| Some((a["w"].as_u64()? as u32, a["h"].as_u64()? as u32)));
                let baked = artlux_engine::projector::baked_upload(&gpu, bw, bh, &uv, match (alpha, &adata) { (Some((aw, ah)), Some(d)) => Some((aw, ah, d.as_slice())), _ => None });
                artlux_engine::projector::render_baked(&gpu, &content, &baked, &o, w, h)
            } else { artlux_engine::projector::render(&gpu, &content, &o, w, h) };
            match r {
                Ok(px) => out.push(serde_json::json!({ "name": c["name"], "rgba": base64::engine::general_purpose::STANDARD.encode(px) })),
                Err(e) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(1); }
            }
        }
        let res = serde_json::json!({ "adapter": describe(&gpu.info), "cases": out });
        return match std::fs::write(outp, res.to_string()) { Ok(()) => ExitCode::SUCCESS, Err(e) => { eprintln!("{outp}: {e}"); ExitCode::from(2) } };
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
        let image = args.iter().position(|a| a == "--image").and_then(|i| args.get(i + 1));
        let sent = match image {
            Some(f) => artlux_engine::spout::send_image(name, f, secs.map(std::time::Duration::from_secs_f64)),
            None => artlux_engine::spout::send(name, secs.map(std::time::Duration::from_secs_f64)),
        };
        return match sent {
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
    if let Some(i) = args.iter().position(|a| a == "--project-windows") {
        // E1e-2: projector OUTPUTS as native windows. In: {picture, outputs: [{name, display: {index} |
        // {x, y, width, height}, window?: {x, y, width, height}, output, brightness, aa}]}.
        let Some(inp) = args.get(i + 1) else { eprintln!("usage: --project-windows <in.json> [--seconds N]"); return ExitCode::from(2); };
        let job: serde_json::Value = match std::fs::read_to_string(inp).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())) {
            Ok(v) => v, Err(e) => { eprintln!("{inp}: {e}"); return ExitCode::from(2); }
        };
        let img = match image::open(job["picture"].as_str().unwrap_or_default()) { Ok(i) => i.to_rgba8(), Err(e) => { eprintln!("picture: {e}"); return ExitCode::from(2); } };
        let picture = std::sync::Arc::new((img.width(), img.height(), img.into_raw()));
        let rect = |v: &serde_json::Value| -> Option<(i32, i32, u32, u32)> {
            Some((v["x"].as_i64()? as i32, v["y"].as_i64()? as i32, v["width"].as_u64()? as u32, v["height"].as_u64()? as u32))
        };
        let outputs = job["outputs"].as_array().into_iter().flatten().map(|o| artlux_engine::windows::ProjectorOut {
            name: o["name"].as_str().unwrap_or("output").to_string(),
            display: artlux_engine::windows::DisplayMatch { bounds: rect(&o["display"]), index: o["display"]["index"].as_u64().map(|x| x as usize) },
            window: rect(&o["window"]),
            opts: artlux_engine::projector::Opts::from_json(&o["output"], o["brightness"].as_f64().unwrap_or(1.0), o["aa"].as_u64().unwrap_or(4) as u32),
            picture: picture.clone(),
        }).collect();
        let secs = args.iter().position(|a| a == "--seconds").and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<f64>().ok());
        let options = artlux_engine::windows::WindowOptions {
            fullscreen: true, run_for: secs.map(std::time::Duration::from_secs_f64),
            policy: AdapterPolicy { allow_software: has("--allow-software"), force_software: false },
            projection: Some(artlux_engine::windows::Projection { outputs }),
        };
        return match artlux_engine::windows::run(options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => { eprintln!("artlux-engine: {e}"); ExitCode::from(1) }
        };
    }
    if has("--windows") {
        // E0b: a window on every display (--fullscreen: borderless on each), presenting the test card.
        let secs = args.iter().position(|a| a == "--seconds").and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<f64>().ok());
        let options = artlux_engine::windows::WindowOptions {
            fullscreen: has("--fullscreen"),
            run_for: secs.map(std::time::Duration::from_secs_f64),
            policy: AdapterPolicy { allow_software: has("--allow-software"), force_software: false },
            projection: None,
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

/// A `.nv12.json` test frame: {coded: [w, h], visible: [x, y, w, h], layout: [{offset, stride} ×2],
/// colorSpace: {matrix, fullRange, primaries, transfer}, planes: "<file>"} — VideoFrame.copyTo's own layout.
fn nv12_picture(p: &std::path::Path) -> Result<artlux_engine::compose::Picture, String> {
    let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?).map_err(|e| e.to_string())?;
    let cs = &j["colorSpace"];
    artlux_engine::yuv::accepts(cs["matrix"].as_str(), cs["fullRange"].as_bool(), cs["primaries"].as_str(), cs["transfer"].as_str())?;
    let planes = std::fs::read(p.parent().unwrap_or(std::path::Path::new(".")).join(j["planes"].as_str().unwrap_or_default())).map_err(|e| format!("planes: {e}"))?;
    let n = |v: &serde_json::Value| v.as_u64().unwrap_or(0);
    let (yo, ys, uo, us) = (n(&j["layout"][0]["offset"]) as usize, n(&j["layout"][0]["stride"]) as usize, n(&j["layout"][1]["offset"]) as usize, n(&j["layout"][1]["stride"]) as usize);
    let vis = [n(&j["visible"][0]) as u32, n(&j["visible"][1]) as u32, n(&j["visible"][2]) as u32, n(&j["visible"][3]) as u32];
    let f = artlux_engine::yuv::Nv12 { coded: (n(&j["coded"][0]) as u32, n(&j["coded"][1]) as u32), visible: vis, y: &planes[yo..], y_stride: ys, uv: &planes[uo..], uv_stride: us };
    Ok(artlux_engine::yuv::to_picture(&f))
}
