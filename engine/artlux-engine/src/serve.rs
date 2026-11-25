//! E1a — THE ENGINE AS ARTLUX'S CHILD PROCESS: `artlux-engine --serve` (plans/native-engine.md §9c).
//!
//! Main (src/main/engineHost.ts) spawns it and talks newline-delimited JSON over stdio:
//!   engine → main   {"type":"hello","version":"…","adapter":"…","backend":"…","pid":N}   once, device open
//!   main → engine   {"ping":N}             every second
//!   engine → main   {"type":"pong","n":N}  the answer — an engine that stops answering is HUNG, and main
//!                                          kills and restarts it
//!   main → engine   {"quit":true}          a clean stop
//!   main → engine   {"type":"output"|"doc"|"tick", …}   E1f: the live document and its frames (runtime.rs)
//!   engine → main   {"type":"owns","rev":r,"owns":b,"why":"…"}   whether the engine drives the wire
//!   engine → main   {"type":"sent","n":N,"d":D,"pps":P,"fps":F,"u":U}  a frame went to the wire (the liveness main
//!                   mutes the app on); N frames drawn so far, D ticks dropped by coalescing so far, and the sender's
//!                   own counters (packets/s, frames/s incl. keep-alive, universes) — the app output engine's numbers
//!   main → engine   {"type":"bakeBegin"|"bakeFrame"|"bakeEnd"|"bakeCancel","req":N,…}   E6a: a bake drawn and encoded here
//!   engine → main   {"type":"bake","req":N,"ok":b,"value"|"error":…}   its answer, one per message
//!   engine → main   {"type":"projOwns","rev":r,"owns":b,"why":"...","open":n}   E1f-3: whether the engine's
//!                                          own windows now show the projector outputs (main covers the app's)
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
    // E1f-3: the GPU is opened ON THE WINDOWS THREAD (outputs.rs prepare — a device from another thread made
    // surfaces the presenter could not configure). No window system: opened here, without outputs.
    let (gpu, windows) = match crate::outputs::prepare(policy) {
        Ok(w) => (w.gpu.clone(), Some(w)),
        Err(Some(e)) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(2); }
        Err(None) => match Gpu::open(policy) {
            Ok(g) => (std::sync::Arc::new(g), None),
            Err(e) => { eprintln!("artlux-engine: {e}"); return ExitCode::from(2); }
        },
    };
    // E6h TEST HOOK: the RENDER thread stalls (forever) on the first tick after this file appears, while the stdin
    // thread goes on answering pings — the failure only main's "ticks in, no frames out" watch can see.
    let stall_file = std::env::var_os("ARTLUX_ENGINE_TEST_STALL_FILE").map(std::path::PathBuf::from);
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
    drop(out);
    if hang.is_some() { eprintln!("artlux-engine: TEST HOOK — will stop answering pings in 2 s"); }
    // E1f: TWO THREADS. This one reads stdin and answers pings AT ONCE — a slow frame must never look like a
    // hang to main's watchdog. The render thread does the frames; ticks are COALESCED there (only the
    // newest is drawn), so a frame that takes longer than the host's interval drops ticks instead of
    // queueing them.
    // (already an Arc: the windows thread opened it — see above)
    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    // E3m: sound — its own thread (a device open takes seconds; no frame may wait for it). audio.rs `serve`.
    let (atx, arx) = std::sync::mpsc::channel::<serde_json::Value>();
    let audio = std::thread::Builder::new().name("audio".into()).spawn(move || crate::audio::serve(arx)).expect("audio thread");
    let render = {
        let gpu = gpu.clone();
        std::thread::Builder::new().name("render".into()).spawn(move || {
          // A PANICKING RENDER THREAD ENDS THE PROCESS (E6a, found by test:engine-bake: a wgpu validation error panics).
          // The stdin thread would otherwise go on answering pings, so main saw a live engine that would never draw
          // again or answer anything it waits on (a bake frame: the app hung). Exiting makes it a crash, and main
          // restarts the engine — the watchdog rung every other failure already takes.
          let body = std::panic::AssertUnwindSafe(move || {
            let mut rt = crate::runtime::Runtime::new(gpu.clone());
            // E1f-3: the projector outputs' windows thread. Its report (which outputs actually opened) is
            // the answer main waits for: {"type":"projOwns",...} for the document that asked.
            let proj_rev = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let shared = std::sync::Arc::new(std::sync::Mutex::new(crate::outputs::Shared::default()));
            {
                let pr = proj_rev.clone();
                let report = Box::new(move |open: Vec<String>, refused: Vec<(String, String)>| {
                    // Nothing asked, nothing refused: closing every window is not news — the document's own
                    // answer (rt.projectors) already said why the app keeps the outputs.
                    if open.is_empty() && refused.is_empty() { return; }
                    let rev = pr.load(std::sync::atomic::Ordering::SeqCst);
                    let owns = refused.is_empty() && !open.is_empty();
                    let why = refused.iter().map(|(id, w)| format!("output '{id}': {w}")).collect::<Vec<_>>().join("; ");
                    let mut o = std::io::stdout().lock();
                    let _ = writeln!(o, r#"{{"type":"projOwns","rev":{rev},"owns":{owns},"why":{},"open":{}}}"#, json_str(&why), open.len()).and_then(|_| o.flush());
                });
                // E4a: the 3D view's state, shared by this thread (it publishes), the windows thread (the window,
                // the mouse) and its presenter. Closing the window from its title bar tells main.
                let view = std::sync::Arc::new(std::sync::Mutex::new(crate::view3d::Shared::default()));
                let view_open = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                // …and a click in it (E4b: `view3dPick`). One line of JSON each, as every message to main.
                let closed = Box::new(|line: String| {
                    let mut o = std::io::stdout().lock();
                    let _ = writeln!(o, "{line}").and_then(|_| o.flush());
                });
                if let Some(proxy) = windows.and_then(|w| w.attach(shared.clone(), report, view.clone(), view_open.clone(), closed)) { rt.set_outputs(proxy, shared); }
                rt.set_view(view, view_open);
            }
            let mut warned = false;
            // Ticks REPLACED by a newer one before they were drawn (the coalescing above). Reported with each
            // `sent` as a running total: main turns it into a rate, so a wire running below the host's frame
            // rate says whether the engine was too slow (drops) or was simply not asked (no drops).
            let mut dropped: u64 = 0;
            while let Ok(first) = rx.recv() {
                let mut tick: Option<serde_json::Value> = None;
                let handle = |rt: &mut crate::runtime::Runtime, m: serde_json::Value, tick: &mut Option<serde_json::Value>, dropped: &mut u64| match m["type"].as_str() {
                    Some("tick") => { if tick.is_some() { *dropped += 1; } *tick = Some(m) }
                    Some("doc") => {
                        let (rev, owns, why) = rt.doc(&m["doc"]);
                        let line = format!(r#"{{"type":"owns","rev":{rev},"owns":{owns},"why":{}}}"#, json_str(&why));
                        let mut o = std::io::stdout().lock();
                        let _ = writeln!(o, "{line}").and_then(|_| o.flush());
                        drop(o);
                        proj_rev.store(rev, std::sync::atomic::Ordering::SeqCst);
                        if let Err(w) = rt.projectors(&m["doc"]) {
                            let mut o = std::io::stdout().lock();
                            let _ = writeln!(o, r#"{{"type":"projOwns","rev":{rev},"owns":false,"why":{},"open":0}}"#, json_str(&w)).and_then(|_| o.flush());
                        }
                        *tick = None;   // a tick for the old document is not this document's frame
                    }
                    Some("output") => rt.output(&m),
                    Some("scene3d") => rt.scene3d(&m),
                    Some("raster") => rt.raster(&m),
                    Some("view3d") => rt.view3d(&m),
                    // E6a: a bake drawn and encoded here (runtime.rs) -- every message answered, in order, never
                    // coalesced: the app waits on each frame before it steps its clock to the next.
                    Some(op @ ("bakeBegin" | "bakeFrame" | "bakeEnd" | "bakeCancel")) => {
                        let r = match op { "bakeBegin" => rt.bake_begin(&m), "bakeFrame" => rt.bake_frame(&m), "bakeEnd" => rt.bake_end(), _ => rt.bake_cancel() };
                        let req = m["req"].as_u64().unwrap_or(0);
                        let line = match r {
                            Ok(v) => serde_json::json!({ "type": "bake", "req": req, "ok": true, "value": v }),
                            Err(e) => serde_json::json!({ "type": "bake", "req": req, "ok": false, "error": e }),
                        };
                        let mut o = std::io::stdout().lock();
                        let _ = writeln!(o, "{line}").and_then(|_| o.flush());
                    }
                    _ => {}
                };
                handle(&mut rt, first, &mut tick, &mut dropped);
                while let Ok(m) = rx.try_recv() { handle(&mut rt, m, &mut tick, &mut dropped); }
                // Item 2d step 5: a twin camera was resolved by picture during the last tick — answer the SAME
                // document again (main takes a later answer for the current revision), as if it had just come.
                if rt.redo {
                    rt.redo = false;
                    if let Some(d) = rt.last_doc.clone() { handle(&mut rt, serde_json::json!({ "type": "doc", "doc": d }), &mut tick, &mut dropped); }
                }
                if let Some(t) = tick {
                    if stall_file.as_ref().is_some_and(|p| p.exists()) {
                        if let Some(p) = &stall_file { let _ = std::fs::remove_file(p); }
                        eprintln!("artlux-engine: TEST — the render thread stalls");
                        loop { std::thread::sleep(Duration::from_secs(3600)); }
                    }
                    let before = rt.frames;
                    match rt.tick(&t) {
                        // "I PUT A FRAME ON THE WIRE" — from the RENDER thread, per frame. Main mutes the app
                        // only while these keep coming, so a render thread that STALLS or FAILS while the stdin
                        // reader still answers pings (which an exit or a ping can never reveal) hands the wire
                        // back within ~250 ms. (A killed engine is seen sooner, by its exit: 23 ms measured.)
                        Ok(()) if rt.frames != before => {
                            let mut o = std::io::stdout().lock();
                            let (pps, fps, uni) = rt.wire_stats();
                            let _ = writeln!(o, r#"{{"type":"sent","n":{},"d":{},"pps":{},"fps":{},"u":{}}}"#, rt.frames, dropped, pps, fps, uni).and_then(|_| o.flush());
                        }
                        Ok(()) => {}
                        Err(e) => { if !warned { eprintln!("artlux-engine: frame failed: {e}"); warned = true; } }
                    }
                }
            }
            rt.close();
          });
          if std::panic::catch_unwind(body).is_err() {
              eprintln!("artlux-engine: the render thread panicked — exiting, so main restarts the engine");
              std::process::exit(70);
          }
        }).expect("render thread")
    };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        // The quit MESSAGE, not the word: a document can carry "quit" anywhere (a surface called so).
        if line.starts_with("{\"quit\"") { break; }
        if line.starts_with("{\"type\":") {
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) if v["type"] == "audio" => { let _ = atx.send(v); }
                Ok(v) => { let _ = tx.send(v); }
                Err(e) => eprintln!("artlux-engine: bad message: {e}"),
            }
            continue;
        }
        if let Some(n) = field_u64(&line, "ping") {
            if hang.is_some_and(|t| std::time::Instant::now() >= t) {
                // A hang, as main sees one: alive, reading, never answering.
                loop { std::thread::sleep(Duration::from_secs(3600)); }
            }
            let mut o = std::io::stdout().lock();
            if writeln!(o, r#"{{"type":"pong","n":{n}}}"#).and_then(|_| o.flush()).is_err() { break; }
        }
    }
    drop(tx);
    drop(atx);
    let _ = audio.join();   // the device closed before the process goes
    let _ = render.join();
    drop(gpu);
    ExitCode::SUCCESS
}
