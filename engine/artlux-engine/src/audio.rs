//! E3 — JUCE IN THE ENGINE PROCESS (plans/native-engine.md §4: "the engine clock and the audio clock become one
//! clock"). The app's audio engine (native/audio-engine: JUCE 8 + libspatialaudio) is built a second time as a C
//! library, `artlux_audio` (src/capi.cpp — the SAME core.h the N-API addon compiles), and loaded here at run time.
//! Without the library the engine runs as before, silent; nothing links against it.
//!
//! The clock this exists for: `clock()` — the samples the library has handed the output device, and the rate they
//! play at. That count advances on the SOUND CARD's crystal, not the wall's, which is the whole "two clocks"
//! problem (docs/AUDIO.md): the app re-seeks a sounding clip whenever its estimate of the card's position and the
//! show clock part by 50 ms. `--audio-selftest` measures exactly that drift on this machine.
use libloading::{Library, Symbol};
use std::ffi::{c_char, c_int, CString};
use std::path::{Path, PathBuf};

type Answer = unsafe extern "C" fn(*mut c_char, c_int) -> c_int;
type Configure = unsafe extern "C" fn(*const c_char, *mut c_char, c_int) -> c_int;
type LoadClip = unsafe extern "C" fn(*const c_char, *const c_char, *mut c_char, c_int) -> c_int;
type PlayClip = unsafe extern "C" fn(*const c_char, f64, f64);
type OneId = unsafe extern "C" fn(*const c_char);
type Gain = unsafe extern "C" fn(f64);
type Void = unsafe extern "C" fn();
type Clock = unsafe extern "C" fn(*mut f64) -> i64;

/// The loaded library. Every call is the C API's (capi.cpp): an answering call blocks until the library's control
/// thread has run it; the rest are queued in order and return at once; `clock` is two atomics.
pub struct Audio {
    lib: std::sync::Arc<Library>,
    pub path: PathBuf,
}

/// Where the library is looked for: `ARTLUX_AUDIO_LIB`, next to this executable (a packaged build:
/// resources/engine/), then the repo's build output (native/audio-engine/, for a dev run from the repo).
pub fn candidates() -> Vec<PathBuf> {
    let name = if cfg!(windows) { "artlux_audio.dll" } else if cfg!(target_os = "macos") { "libartlux_audio.dylib" } else { "libartlux_audio.so" };
    let mut v = Vec::new();
    if let Ok(p) = std::env::var("ARTLUX_AUDIO_LIB") { v.push(PathBuf::from(p)); }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        v.push(dir.join(name));
        // engine/target/release/ → the repo root's native/audio-engine/
        v.push(dir.join("..").join("..").join("..").join("native").join("audio-engine").join(name));
    }
    v
}

fn answer(buf: &[u8]) -> String {
    let n = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

impl Audio {
    /// The first candidate that loads and speaks this ABI.
    pub fn load() -> Result<Audio, String> {
        let mut why = Vec::new();
        for p in candidates() {
            if !p.exists() { continue; }
            match unsafe { Library::new(&p) } {
                Ok(lib) => {
                    let abi: Result<Symbol<unsafe extern "C" fn() -> c_int>, _> = unsafe { lib.get(b"artlux_audio_abi\0") };
                    match abi {
                        Ok(f) if unsafe { f() } == 2 => return Ok(Audio { lib: std::sync::Arc::new(lib), path: p }),
                        Ok(f) => why.push(format!("{}: ABI {} (this engine speaks 2)", p.display(), unsafe { f() })),
                        Err(e) => why.push(format!("{}: {e}", p.display())),
                    }
                }
                Err(e) => why.push(format!("{}: {e}", p.display())),
            }
        }
        Err(if why.is_empty() { "no artlux_audio library found (build it with npm run build:audio)".into() } else { why.join("; ") })
    }

    fn sym<T>(&self, name: &[u8]) -> Result<Symbol<'_, T>, String> {
        unsafe { self.lib.get(name) }.map_err(|e| format!("{}: {e}", String::from_utf8_lossy(&name[..name.len() - 1])))
    }

    pub fn version(&self) -> Result<String, String> {
        let f: Symbol<Answer> = self.sym(b"artlux_audio_version\0")?;
        let mut buf = vec![0u8; 256];
        unsafe { f(buf.as_mut_ptr() as *mut c_char, buf.len() as c_int) };
        Ok(answer(&buf))
    }

    /// Open the output device — the addon's configure() as JSON in, the setup actually opened as JSON out.
    pub fn configure(&self, cfg: &serde_json::Value) -> Result<serde_json::Value, String> {
        let f: Symbol<Configure> = self.sym(b"artlux_audio_configure\0")?;
        let c = CString::new(cfg.to_string()).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 4096];
        let r = unsafe { f(c.as_ptr(), buf.as_mut_ptr() as *mut c_char, buf.len() as c_int) };
        let s = answer(&buf);
        if r != 0 { return Err(s); }
        serde_json::from_str(&s).map_err(|e| format!("{e}: {s}"))
    }

    pub fn load_clip(&self, id: &str, path: &str) -> Result<serde_json::Value, String> {
        let f: Symbol<LoadClip> = self.sym(b"artlux_audio_load_clip\0")?;
        let (i, p) = (CString::new(id).map_err(|e| e.to_string())?, CString::new(path).map_err(|e| e.to_string())?);
        let mut buf = vec![0u8; 4096];
        let r = unsafe { f(i.as_ptr(), p.as_ptr(), buf.as_mut_ptr() as *mut c_char, buf.len() as c_int) };
        let s = answer(&buf);
        if r != 0 { return Err(s); }
        serde_json::from_str(&s).map_err(|e| format!("{e}: {s}"))
    }

    pub fn play_clip(&self, id: &str, seek: f64, gain: f64) -> Result<(), String> {
        let f: Symbol<PlayClip> = self.sym(b"artlux_audio_play_clip\0")?;
        let i = CString::new(id).map_err(|e| e.to_string())?;
        unsafe { f(i.as_ptr(), seek, gain) };
        Ok(())
    }

    pub fn stop_clip(&self, id: &str) -> Result<(), String> {
        let f: Symbol<OneId> = self.sym(b"artlux_audio_stop_clip\0")?;
        let i = CString::new(id).map_err(|e| e.to_string())?;
        unsafe { f(i.as_ptr()) };
        Ok(())
    }

    pub fn set_master_gain(&self, g: f64) -> Result<(), String> {
        let f: Symbol<Gain> = self.sym(b"artlux_audio_set_master_gain\0")?;
        unsafe { f(g) };
        Ok(())
    }

    pub fn meters(&self) -> Result<serde_json::Value, String> {
        let f: Symbol<Answer> = self.sym(b"artlux_audio_meters\0")?;
        let mut buf = vec![0u8; 1024];
        unsafe { f(buf.as_mut_ptr() as *mut c_char, buf.len() as c_int) };
        let s = answer(&buf);
        serde_json::from_str(&s).map_err(|e| format!("{e}: {s}"))
    }

    /// THE AUDIO CLOCK: (samples handed to the device, the rate they play at — 0 with no device open).
    pub fn clock(&self) -> Result<(i64, f64), String> {
        let f: Symbol<Clock> = self.sym(b"artlux_audio_clock\0")?;
        let mut rate = 0.0;
        let n = unsafe { f(&mut rate) };
        Ok((n, rate))
    }

    /// THE RELAY'S ONE DOOR (ABI 2): `{op, args}` — any live method of the addon, by its own name — answered as JSON.
    pub fn call(&self, msg: &serde_json::Value) -> Result<serde_json::Value, String> {
        let f: Symbol<Configure> = self.sym(b"artlux_audio_call\0")?;
        let c = CString::new(msg.to_string()).map_err(|e| e.to_string())?;
        // An offline pull answers a block of float32s as base64 (a 8192-frame 8-channel block is ~350 kB).
        let mut buf = vec![0u8; if msg["op"] == "offlinePull" { 8 << 20 } else { 64 * 1024 }];
        let r = unsafe { f(c.as_ptr(), buf.as_mut_ptr() as *mut c_char, buf.len() as c_int) };
        let s = answer(&buf);
        if r != 0 { return Err(s); }
        serde_json::from_str(&s).map_err(|e| format!("{e}: {s}"))
    }

    pub fn close(&self) -> Result<(), String> {
        let f: Symbol<Void> = self.sym(b"artlux_audio_close\0")?;
        unsafe { f() };
        Ok(())
    }
}

// ── E3o: THE AUDIO CLOCK, READABLE FROM ANY THREAD ─────────────────────────────────────────────────────────────
// The audio thread owns the library; the RENDER thread needs the clock every tick (transport.rs follows its rate).
// `artlux_audio_clock` is two atomics in the library — no control-thread trip — so the render thread calls it
// directly, through this source: the library kept alive by an Arc, the function pointer copied out of it. Published
// by the audio thread when a device opens, withdrawn when it closes.
type Stamp = unsafe extern "C" fn(*mut i64, *mut f64) -> f64;
struct ClockSource { _lib: std::sync::Arc<Library>, f: Clock, stamp: Option<Stamp> }
static CLOCK: std::sync::Mutex<Option<ClockSource>> = std::sync::Mutex::new(None);

impl Audio {
    /// Publish this library's audio clock to every thread (`audio_clock`).
    pub fn publish_clock(&self) {
        if let Ok(f) = self.sym::<Clock>(b"artlux_audio_clock\0") {
            let f = *f;
            let stamp = self.sym::<Stamp>(b"artlux_audio_clock_stamp\0").ok().map(|s| *s);
            if let Ok(mut c) = CLOCK.lock() { *c = Some(ClockSource { _lib: self.lib.clone(), f, stamp }); }
        }
    }
}
/// Withdraw the published clock (the device closed).
pub fn withdraw_clock() { if let Ok(mut c) = CLOCK.lock() { *c = None; } }

/// The audio clock, from any thread: (samples handed to the device, their rate) — None with no device open.
pub fn audio_clock() -> Option<(i64, f64)> {
    let c = CLOCK.lock().ok()?;
    let src = c.as_ref()?;
    let mut rate = 0.0;
    let n = unsafe { (src.f)(&mut rate) };
    (rate > 0.0).then_some((n, rate))
}

/// E3o — the CLOCK STAMP, from any thread: (the sample index the last device callback started at, the wall time it
/// ran in epoch seconds, the rate). None with no device, before the first callback, or from a library without it.
pub fn audio_stamp() -> Option<(i64, f64, f64)> {
    let c = CLOCK.lock().ok()?;
    let f = c.as_ref()?.stamp?;
    let (mut n, mut w) = (0i64, 0.0f64);
    let rate = unsafe { f(&mut n, &mut w) };
    (rate > 0.0 && w > 0.0).then_some((n, w, rate))
}

/// Least-squares slope of y over x and its STANDARD ERROR (how far the true slope can be from it) — the engine applies
/// a measured rate only once that is small (transport.rs AudioRate).
pub fn slope_se(pts: &[(f64, f64)]) -> (f64, f64) {
    let n = pts.len() as f64;
    if n < 3.0 { return (f64::NAN, f64::INFINITY); }
    let (mx, my) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n);
    let (mut sxy, mut sxx) = (0.0, 0.0);
    for (x, y) in pts { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); }
    if sxx <= 0.0 { return (f64::NAN, f64::INFINITY); }
    let b = sxy / sxx;
    let ss: f64 = pts.iter().map(|(x, y)| { let r = (y - my) - b * (x - mx); r * r }).sum();
    (b, (ss / (n - 2.0) / sxx).sqrt())
}

/// Least-squares slope of y over x — the audio clock's rate against the wall, from many readings (one reading is
/// quantised to the device's buffer, ~10 ms; a fit over seconds of them is not).
pub fn slope(pts: &[(f64, f64)]) -> f64 {
    let n = pts.len() as f64;
    let (mx, my) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n);
    let (mut sxy, mut sxx) = (0.0, 0.0);
    for (x, y) in pts { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); }
    if sxx > 0.0 { sxy / sxx } else { f64::NAN }
}

/// `--audio-selftest [--seconds N] [--clip file.wav] [--gain g]`: JUCE running inside the engine process —
/// the library loaded, the default output opened, a clip playing (quietly: master gain 0.05 by default), the
/// output metered, and THE AUDIO CLOCK measured against the wall for N seconds (default 10): its rate, and how
/// far it drifts from the wall in parts per million — the drift the app's 50 ms re-seek corrects today.
pub fn selftest(args: &[String]) -> Result<serde_json::Value, String> {
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let seconds: f64 = arg("--seconds").and_then(|s| s.parse().ok()).unwrap_or(10.0);
    let gain: f64 = arg("--gain").and_then(|s| s.parse().ok()).unwrap_or(0.05);
    let a = Audio::load()?;
    let version = a.version()?;
    let opened = a.configure(&serde_json::json!({ "channels": 2, "mode": "binaural", "layout": "stereo" }))?;
    a.set_master_gain(gain)?;
    let clip = arg("--clip").or_else(|| candidates().first().and_then(|_| {
        let p = a.path.parent()?.join("tone-100.wav");
        p.exists().then(|| p.display().to_string())
    }));
    let mut loaded = serde_json::Value::Null;
    if let Some(c) = &clip {
        loaded = a.load_clip("selftest", c)?;
        a.play_clip("selftest", 0.0, 1.0)?;
    }
    // Readings every 5 ms: (wall seconds, audio seconds).
    let t0 = std::time::Instant::now();
    let (n0, rate) = a.clock()?;
    if rate <= 0.0 { return Err("the device opened with no sample rate".into()); }
    let mut pts = Vec::new();
    let mut peak = 0.0f64;
    let mut last_meter = std::time::Instant::now();
    while t0.elapsed().as_secs_f64() < seconds {
        let (n, _) = a.clock()?;
        pts.push((t0.elapsed().as_secs_f64(), (n - n0) as f64 / rate));
        if last_meter.elapsed().as_millis() >= 100 {
            last_meter = std::time::Instant::now();
            if let Ok(m) = a.meters() { peak = peak.max(m["peak"].as_f64().unwrap_or(0.0)); }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let (n1, _) = a.clock()?;
    if clip.is_some() { a.stop_clip("selftest")?; }
    a.close()?;
    let s = slope(&pts);
    Ok(serde_json::json!({
        "library": a.path.display().to_string(), "juce": version, "device": opened, "clip": loaded,
        "seconds": seconds, "samples": n1 - n0, "rate": rate, "readings": pts.len(),
        "audioPerWall": s, "driftPpm": (s - 1.0) * 1e6, "peak": peak,
    }))
}

/// E3m — THE AUDIO THREAD OF THE ENGINE (`--serve`). Main relays plugins/audio's calls here when sound plays from
/// the engine (`{"type":"audio","op":…,"args":[…],"req"?:n}`); they run IN ORDER on this thread — never the render
/// thread: opening a device takes seconds (5.5 s measured on WASAPI), a frame must not wait for it. A call with a
/// `req` is answered on stdout, `{"type":"audio","req":n,"ok":…,"value"|"error":…}`; the library is loaded on the
/// first call, and without one every request is answered with why.
pub fn serve(rx: std::sync::mpsc::Receiver<serde_json::Value>) {
    use std::io::Write;
    let mut lib: Option<Result<Audio, String>> = None;
    // While a device is open: every 2 s, the audio clock and the output's level, in the log (the proof that the
    // sound comes out of THIS process — scripts/test-engine-audio-show.cjs reads it).
    let mut open = false;
    let mut last_report = std::time::Instant::now();
    // E3p: the clips held to the engine's clock, and how well (reported with the clock).
    let mut locks: std::collections::HashMap<String, Lock> = Default::default();
    let mut stats = HoldStats::default();
    let mut last_hold = std::time::Instant::now();
    // E3q: each clip's latest gain (the driver's setClipGain — what the engine starts it at), and an offline render.
    let mut gains: std::collections::HashMap<String, f64> = Default::default();
    let mut offline = false;
    // The mutation the test needs (test-engine-audio-show.cjs): the engine wants every clip this far further on.
    let skew = std::env::var("ARTLUX_AUDIO_LOCK_SKEW_MS").ok().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0) / 1000.0;
    loop {
        let wait = if open && !locks.is_empty() { 20 } else { 500 };
        let m = match rx.recv_timeout(std::time::Duration::from_millis(wait)) {
            Ok(m) => m,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => serde_json::Value::Null,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if open && last_report.elapsed().as_secs_f64() >= 2.0 {
            last_report = std::time::Instant::now();
            if let Some(Ok(a)) = &lib {
                // artlux_audio_meters, NOT getMeters: that one reads-and-clears the clip latch the app's own poll reports.
                if let (Ok((n, rate)), Ok(mt)) = (a.clock(), a.meters()) {
                    eprintln!("artlux-engine: audio: clock {:.3} s ({n} samples at {rate} Hz), output peak {:.4}", if rate > 0.0 { n as f64 / rate } else { 0.0 }, mt["peak"].as_f64().unwrap_or(0.0));
                }
                if stats.checks > 0 {
                    eprintln!("artlux-engine: audio: holding {} clip(s) to the engine's clock — within {:.2} ms over {} checks since the last report, {} re-seek(s) in all", locks.len(), stats.worst * 1000.0, stats.checks, stats.seeks);
                    stats.checks = 0; stats.worst = 0.0;
                }
                if stats.starts + stats.stops > 0 {
                    eprintln!("artlux-engine: audio: the engine decided {} start(s) and {} stop(s) in all; the driver sent {} play(s)", stats.starts, stats.stops, stats.driver_plays);
                }
            }
        }
        // E3q: every 20 ms — the engine STARTS clips, so this is also how late a clip can begin after its clock
        // enters the window (it begins at the right place in its source either way). Not during an offline render:
        // the bake's frames own time then, and the driver plays them.
        if open && !offline && !locks.is_empty() && last_hold.elapsed().as_millis() >= 20 {
            last_hold = std::time::Instant::now();
            if let Some(Ok(a)) = &lib { hold(a, &mut locks, &gains, &mut stats, skew); }
        }
        if m.is_null() { continue; }
        let op = m["op"].as_str().unwrap_or("").to_string();
        let id = m["args"][0].as_str().unwrap_or("").to_string();
        if op == "lockClip" {
            // [id, lock | null] — the engine's own; nothing reaches the library.
            match Lock::from_json(&m["args"][1]) {
                Some(mut l) => {
                    if let Some(old) = locks.get(&id) {
                        l.landed = old.landed; l.seeks = old.seeks;
                        // A cue stands only while the window it was cued for does.
                        if old.a == l.a && old.base == l.base && l.audible { l.cued = old.cued; }
                        else if old.cued.is_some() { if let Some(Ok(a)) = &lib { let _ = a.call(&serde_json::json!({ "op": "cueClipAt", "args": [id, 0.0, -1, 1.0] })); } }
                    }
                    locks.insert(id, l);
                }
                None => {
                    // A clip the ENGINE was deciding leaves the show: the engine stops it (nobody else will).
                    if locks.remove(&id).is_some_and(|l| l.decide) {
                        if let Some(Ok(a)) = &lib { let _ = a.call(&serde_json::json!({ "op": "stopClip", "args": [id] })); }
                    }
                }
            }
            if let Some(req) = m["req"].as_u64() {
                let mut o = std::io::stdout().lock();
                let _ = writeln!(o, "{}", serde_json::json!({ "type": "audio", "req": req, "ok": true, "value": null })).and_then(|_| o.flush());
            }
            continue;
        }
        match op.as_str() {
            "playClip" => {
                stats.driver_plays += 1;
                if let Some(g) = m["args"][2].as_f64() { gains.insert(id.clone(), g); }
                if let Some(l) = locks.get_mut(&id) { l.landed = false; }
            }
            "setClipGain" => if let Some(g) = m["args"][1].as_f64() { gains.insert(id.clone(), g); },
            "stopClip" => { locks.remove(&id); }
            "unloadClip" => { locks.remove(&id); gains.remove(&id); }
            // NOT `configure`: a device re-opened mid-show keeps what the clips are locked to (the driver does not
            // re-send a lock it already sent — clearing here would leave the engine-decided show silent).
            "stopAll" | "close" => locks.clear(),
            "offlineBegin" => offline = true,
            "offlineEnd" => offline = false,
            _ => {}
        }
        let a = lib.get_or_insert_with(|| {
            let r = Audio::load();
            match &r {
                Ok(a) => eprintln!("artlux-engine: audio: {} loaded ({})", a.path.display(), a.version().unwrap_or_default()),
                Err(e) => eprintln!("artlux-engine: audio: no library — {e}"),
            }
            r
        });
        let res = match a {
            Ok(a) => a.call(&serde_json::json!({ "op": m["op"], "args": m["args"] })),
            Err(e) => Err(format!("the engine has no audio library: {e}")),
        };
        if m["op"] == "configure" {
            match &res {
                Ok(v) => { open = true; if let Some(Ok(a)) = &lib { a.publish_clock(); } eprintln!("artlux-engine: audio: device opened in the engine — {} ({}), {} Hz, {} samples, {} ch", v["deviceName"].as_str().unwrap_or("?"), v["deviceType"].as_str().unwrap_or("?"), v["sampleRate"], v["bufferSize"], v["channels"]); }
                Err(e) => eprintln!("artlux-engine: audio: configure failed — {e}"),
            }
        }
        if m["op"] == "close" { open = false; withdraw_clock(); }
        if let Some(req) = m["req"].as_u64() {
            let line = match res {
                Ok(v) => serde_json::json!({ "type": "audio", "req": req, "ok": true, "value": v }),
                Err(e) => serde_json::json!({ "type": "audio", "req": req, "ok": false, "error": e }),
            };
            let mut o = std::io::stdout().lock();
            let _ = writeln!(o, "{line}").and_then(|_| o.flush());
        } else if let Err(e) = res {
            eprintln!("artlux-engine: audio: {} failed: {e}", m["op"]);
        }
    }
    // Main went away: close the device on a live process (the one place ~AudioDeviceManager is safe).
    withdraw_clock();
    if let Some(Ok(a)) = &lib { let _ = a.close(); }
}

// ── E3p: THE SOUND HELD TO THE ENGINE'S CLOCK ──────────────────────────────────────────────────────────────────
// The app's driver decides WHICH clips sound and starts them where its own clock says — but its drift lock compares
// two wall-clock estimates of its own and never reads where a clip really is, so a play lands as late as the trip
// through four processes and threads made it, and stays there. The driver now also says what each sounding clip is
// LOCKED to (`lockClip`: the show clock or the scene clock, and the clip's place on it); the audio thread reads every
// locked clip's real position (at a mix sample, with that sample's wall time — `clipPositions`), asks the engine's
// own clock where it should be at that instant, and re-seeks it when the two part by more than HOLD — landing at a
// mix sample (`seekClipAt`), so the trip back costs nothing either.

/// Ops the ENGINE answers itself (never forwarded to the library).
pub const ENGINE_OPS: &[&str] = &["lockClip"];
/// A clip further than this from the engine's clock is re-seeked. The readings are exact to ~0.1 ms (a position and
/// its mix sample under one lock), and a play lands 5–10 ms late (the trip through four processes and threads) — so
/// a hold at 10 ms left most landings where they fell. One seek, inside the read-ahead, just after the clip starts.
pub const HOLD: f64 = 0.002;

/// What a sounding clip is held to: its clock (the show's — a bed — or the scene's), the offset from that clock to
/// the source (`start − inPoint`), and its window on the clock.
/// E3q: `audible` (mute / solo / loaded — the driver's rules) and `decide` (the ENGINE starts and stops it; without,
/// the driver plays it and the engine only holds it — E3p).
struct Lock { show: bool, base: f64, a: f64, b: f64, landed: bool, seeks: u64, audible: bool, decide: bool, /** a start cued at this mix sample */ cued: Option<i64> }
impl Lock {
    fn from_json(v: &serde_json::Value) -> Option<Lock> {
        let n = |k: &str| v[k].as_f64();
        let (start, inp, dur) = (n("start")?, n("inPoint")?, n("duration")?);
        Some(Lock { show: v["clock"] == "show", base: start - inp, a: start, b: start + dur, landed: false, seeks: 0,
            audible: v["audible"].as_bool().unwrap_or(true), decide: v["decide"].as_bool().unwrap_or(false), cued: None })
    }
}
#[derive(Default)]
struct HoldStats { checks: u64, worst: f64, seeks: u64, logged: u64, starts: u64, stops: u64, driver_plays: u64 }

/// One pass: every locked clip against the engine's clock. A clip the engine DECIDES (E3q) is started when its clock
/// is inside its window and it may sound, and stopped when not (its window left, the clock paused or PARKED — a
/// frozen clock is never played against); every sounding one is re-seeked where it parted (E3p).
fn hold(a: &Audio, locks: &mut std::collections::HashMap<String, Lock>, gains: &std::collections::HashMap<String, f64>, st: &mut HoldStats, skew: f64) {
    let ids: Vec<&String> = locks.keys().collect();
    let Ok(v) = a.call(&serde_json::json!({ "op": "clipPositions", "args": [ids] })) else { return };
    for (id, l) in locks.iter_mut() {
        let c = &v[id.as_str()];
        let sounding = c["playing"].as_bool() == Some(true);
        if !sounding && !l.decide { continue; }
        let (Some(pos), Some(len), Some(at), Some(wall)) = (c["pos"].as_f64(), c["len"].as_f64(), c["at"].as_i64(), c["wall"].as_f64()) else { continue };
        if wall <= 0.0 { continue; }
        // No clock (no anchor yet, a bake): nothing is decided — a stop here would cut the sound on every hiccup.
        let Some((p, s, playing)) = crate::transport::clocks_at_wall(wall) else { continue };
        let clock = if l.show { s } else { p };
        let want = clock - l.base + skew;
        let fits = clock >= l.a && clock < l.b && want >= 0.0 && want < len - 0.05;
        if l.decide {
            // PARKED: the clock not moving while "playing" (the show ended with its loop off; a held state's end).
            let moving = playing && crate::transport::clocks_at_wall(wall + 0.05).is_some_and(|(p2, s2, _)| (if l.show { s2 } else { p2 }) != clock);
            let should = l.audible && moving && fits;
            if sounding { l.cued = None; }
            // CUE the window's start: when the engine's clock ENTERS the window within the next 100 ms (approaching
            // it, or through a loop's wrap), the clip is primed now and started by the mix loop at the sample the clock
            // gets there — so it begins on time, not at the next check. The entry instant is found by bisection on
            // the clock itself, which knows the wraps and parks.
            let rate = c["rate"].as_f64().unwrap_or(0.0);
            let inside = |dt: f64| crate::transport::clocks_at_wall(wall + dt).map(|(p2, s2, _)| if l.show { s2 } else { p2 }).filter(|c2| *c2 >= l.a && *c2 < l.b && *c2 - l.base >= 0.0 && *c2 - l.base < len - 0.05);
            if !sounding && l.audible && moving && rate > 0.0 && !fits && inside(0.1).is_some() {
                if l.cued.is_none() {
                    let (mut lo, mut hi) = (0.0f64, 0.1f64);
                    for _ in 0..14 { let mid = 0.5 * (lo + hi); if inside(mid).is_some() { hi = mid; } else { lo = mid; } }
                    let pos = inside(hi).unwrap_or(l.a) - l.base;
                    if pos >= 0.0 && pos < len - 0.05 {
                        let s_at = at + (hi * rate).round() as i64;
                        let g = gains.get(id.as_str()).copied().unwrap_or(1.0);
                        let _ = a.call(&serde_json::json!({ "op": "cueClipAt", "args": [id, pos, s_at, g] }));
                        l.cued = Some(s_at); st.starts += 1; l.landed = false;
                        if st.logged < 60 { st.logged += 1; eprintln!("artlux-engine: audio: the engine cued clip {id} at {pos:.3} s of its source — its window opens in {:.1} ms", hi * 1000.0); }
                    }
                }
                continue;
            }
            if let Some(s_at) = l.cued {
                // Reached only when the window is not about to open: a cue stands while the clock is INSIDE the window
                // it was cued for (due, or a few ms late, the mix loop starts it); paused, parked, sought away or muted,
                // it is withdrawn.
                if !(l.audible && moving && fits) {
                    let _ = a.call(&serde_json::json!({ "op": "cueClipAt", "args": [id, 0.0, -1, 1.0] }));
                    l.cued = None;
                } else if !sounding && at < s_at + (0.05 * rate) as i64 { continue; }
                else { l.cued = None; }
            }
            if should && !sounding {
                let g = gains.get(id.as_str()).copied().unwrap_or(1.0);
                let _ = a.call(&serde_json::json!({ "op": "playClipAt", "args": [id, want - skew, at, g] }));
                st.starts += 1; l.landed = false;
                if st.logged < 60 { st.logged += 1; eprintln!("artlux-engine: audio: the engine started clip {id} at {want:.3} s of its source — {:.1} ms into its window", (clock - l.a) * 1000.0); }
                continue;
            }
            if !should {
                if sounding {
                    let _ = a.call(&serde_json::json!({ "op": "stopClip", "args": [id] }));
                    st.stops += 1;
                    if st.logged < 60 { st.logged += 1; eprintln!("artlux-engine: audio: the engine stopped clip {id} — {}", if !l.audible { "it may not sound" } else if !playing { "paused" } else if !moving { "the clock is parked" } else if clock >= l.a && clock < l.b { "its source ran out" } else { "its clock left the window" }); }
                }
                continue;
            }
        }
        // Held (E3p): off its window (a wrap the driver has not answered yet) or past its source — the driver's.
        if !sounding || !playing || !fits { continue; }
        let err = pos - want; // + : the sound is AHEAD of the engine's clock
        if !l.landed {
            l.landed = true;
            if st.logged < 40 { st.logged += 1; eprintln!("artlux-engine: audio: clip {id} landed {:+.1} ms from the engine's clock", err * 1000.0); }
        } else {
            st.checks += 1;
            if err.abs() > st.worst { st.worst = err.abs(); }
        }
        if err.abs() > HOLD {
            let _ = a.call(&serde_json::json!({ "op": "seekClipAt", "args": [id, want, at] }));
            l.seeks += 1; st.seeks += 1;
            if st.logged < 40 { st.logged += 1; eprintln!("artlux-engine: audio: clip {id} re-seeked to the engine's clock — it was {:+.1} ms off", err * 1000.0); }
            l.landed = false; // the next reading is where the seek landed
        }
    }
}

/// Standard base64 (what juce::Base64::toBase64 writes), decoded — the offline render's samples travel in it.
pub fn b64_decode(s: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u32> { match c { b'A'..=b'Z' => Some((c - b'A') as u32), b'a'..=b'z' => Some((c - b'a') as u32 + 26), b'0'..=b'9' => Some((c - b'0') as u32 + 52), b'+' => Some(62), b'/' => Some(63), _ => None } };
    let (mut out, mut acc, mut bits) = (Vec::with_capacity(s.len() * 3 / 4), 0u32, 0u32);
    for &c in s.as_bytes() {
        let Some(v) = val(c) else { continue };   // '=' padding and anything else ends nothing: skipped
        acc = (acc << 6) | v; bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); acc &= (1 << bits) - 1; }
    }
    out
}

/// `--audio-offline [--clip f.wav]`: the OFFLINE render (a bake's sound) through the SAME door the relay uses
/// (`call`: offlineBegin / loadClip / playClip / offlinePull / offlineEnd) — no device. One second of the clip, twice:
/// the render must be non-silent and the two byte-identical (native/audio-engine/test-offline.js proves the same of
/// the addon; this proves it of the engine's library and of the base64 the samples travel in).
pub fn offline_check(args: &[String]) -> Result<serde_json::Value, String> {
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let clip = arg("--clip").ok_or("--clip <file.wav> is required")?;
    let a = Audio::load()?;
    let render = || -> Result<Vec<f32>, String> {
        let b = a.call(&serde_json::json!({ "op": "offlineBegin", "args": [{ "sampleRate": 48000, "blockSize": 512, "channels": 2 }] }))?;
        if b["ok"] != true { return Err(format!("offlineBegin: {b}")); }
        a.call(&serde_json::json!({ "op": "loadClip", "args": ["offline", clip] }))?;
        a.call(&serde_json::json!({ "op": "playClip", "args": ["offline", 0.0, 1.0] }))?;
        let mut all = Vec::new();
        while all.len() < 48000 * 2 {
            let v = a.call(&serde_json::json!({ "op": "offlinePull", "args": [512] }))?;
            let bytes = b64_decode(v.as_str().unwrap_or(""));
            if bytes.is_empty() { break; }
            all.extend(bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])));
        }
        a.call(&serde_json::json!({ "op": "stopClip", "args": ["offline"] }))?;
        a.call(&serde_json::json!({ "op": "unloadClip", "args": ["offline"] }))?;
        a.call(&serde_json::json!({ "op": "offlineEnd", "args": [] }))?;
        Ok(all)
    };
    let (r1, r2) = (render()?, render()?);
    // E3q: a bake takes the plays back from the engine with a stopAll while the bed is PLAYING — offline, that must be
    // the stop FLAG, not JUCE's stop() (which spins up to a second per playing clip with no callback to answer it).
    // Timed with the pull queued behind it (the stop itself is fire-and-forget), and the block after it silent.
    a.call(&serde_json::json!({ "op": "offlineBegin", "args": [{ "sampleRate": 48000, "blockSize": 512, "channels": 2 }] }))?;
    a.call(&serde_json::json!({ "op": "loadClip", "args": ["offline", clip] }))?;
    a.call(&serde_json::json!({ "op": "playClip", "args": ["offline", 0.0, 1.0] }))?;
    for _ in 0..4 { a.call(&serde_json::json!({ "op": "offlinePull", "args": [512] }))?; }
    let t0 = std::time::Instant::now();
    a.call(&serde_json::json!({ "op": "stopAll", "args": [] }))?;
    let after = b64_decode(a.call(&serde_json::json!({ "op": "offlinePull", "args": [512] }))?.as_str().unwrap_or(""));
    let stop_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let after_loud = after.chunks_exact(4).filter(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs() > 1e-4).count();
    a.call(&serde_json::json!({ "op": "unloadClip", "args": ["offline"] }))?;
    a.call(&serde_json::json!({ "op": "offlineEnd", "args": [] }))?;
    a.close()?;
    let loud = r1.iter().filter(|x| x.abs() > 1e-4).count();
    let differing = r1.iter().zip(&r2).filter(|(x, y)| x.to_bits() != y.to_bits()).count() + r1.len().abs_diff(r2.len());
    Ok(serde_json::json!({ "samples": r1.len(), "nonSilent": loud, "peak": r1.iter().fold(0f32, |m, x| m.max(x.abs())), "differing": differing, "stopAllMs": stop_ms, "loudAfterStop": after_loud }))
}
