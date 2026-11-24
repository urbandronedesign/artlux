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
    lib: Library,
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
                        Ok(f) if unsafe { f() } == 1 => return Ok(Audio { lib, path: p }),
                        Ok(f) => why.push(format!("{}: ABI {} (this engine speaks 1)", p.display(), unsafe { f() })),
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

    pub fn close(&self) -> Result<(), String> {
        let f: Symbol<Void> = self.sym(b"artlux_audio_close\0")?;
        unsafe { f() };
        Ok(())
    }
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
