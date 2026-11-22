//! Item 2b — NDI AT RUNTIME, received by the engine itself, the way the app's NDI plugin receives it
//! (native/ndi/src/lib.rs): the same crate (grafton-ndi 1.0.0), the same options (RGBX_RGBA, highest
//! bandwidth), the same capture call — and the SAME nearest-neighbour downscale and opaque alpha, copied
//! verbatim below (`fit` / `downscale_rgba`; native/ndi ships as a prebuilt addon, so it is not rebuilt to
//! share them — verify:invariants holds the two copies equal).
//!
//! Receiving runs on its OWN thread per source: connecting is a 2-second discovery, and capturing waits for
//! frames — neither may stall the render thread. The render thread takes the latest frame and scales it to
//! the size the app's own NDI canvas has (the host sends it), so a picture larger than the app's receive cap
//! lands at exactly the app's size, by the app's arithmetic.
//!
//! Built only with the `ndi` feature (it links the NDI 6 SDK); without it there is no `NdiIn`, and the
//! runtime refuses an NDI show so the app keeps it.

use grafton_ndi::{Finder, FinderOptions, Receiver, ReceiverBandwidth, ReceiverColorFormat, ReceiverOptions, NDI};
use std::sync::atomic::{AtomicBool, Ordering};

/// Is the NDI runtime here? It is DELAY-LOADED (build.rs): loaded now, BY FULL PATH, from the same places the
/// app's NDI plugin puts on its PATH (plugins/ndi ndiManager) — so the delay-load finds the module already in
/// the process. Without it, any NDI call would crash the engine; the runtime asks this first and refuses an
/// NDI show instead, so the app keeps it. Asked once.
pub fn runtime() -> Result<(), String> {
    static R: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        #[cfg(windows)]
        {
            use windows::core::HSTRING;
            use windows::Win32::System::LibraryLoader::LoadLibraryW;
            const DLL: &str = "Processing.NDI.Lib.x64.dll";
            let mut dirs: Vec<std::path::PathBuf> = Vec::new();
            for v in ["NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5"] {
                if let Some(d) = std::env::var_os(v) { dirs.push(d.into()); }
            }
            dirs.push(std::path::PathBuf::from("C:\\Program Files\\NDI\\NDI 6 Runtime\\v6"));
            if let Some(d) = std::env::var_os("NDI_SDK_DIR") { dirs.push(std::path::Path::new(&d).join("Bin").join("x64")); }
            for d in &dirs {
                let f = d.join(DLL);
                if f.exists() && unsafe { LoadLibraryW(&HSTRING::from(f.as_os_str())) }.is_ok() { return Ok(()); }
            }
            // Last: whatever the PATH holds.
            if unsafe { LoadLibraryW(&HSTRING::from(DLL)) }.is_ok() { return Ok(()); }
            Err("the NDI runtime is not installed on this machine".to_string())
        }
        #[cfg(not(windows))]
        { Ok(()) }
    }).clone()
}
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The latest frame of one source: (width, height, RGBA).
type Latest = Arc<Mutex<Option<(u32, u32, Vec<u8>, u64)>>>;

pub struct NdiIn { latest: Latest, stop: Arc<AtomicBool>, pub name: String }

impl Drop for NdiIn { fn drop(&mut self) { self.stop.store(true, Ordering::SeqCst); } }

impl NdiIn {
    /// Start receiving `name` ('' = the first source found, as the app does).
    pub fn new(name: &str) -> Self {
        let latest: Latest = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let (l, st, n) = (latest.clone(), stop.clone(), name.to_string());
        let _ = std::thread::Builder::new().name(format!("ndi:{name}")).spawn(move || {
            if runtime().is_err() { return; }   // never touch a delay-loaded DLL that is not there
            let mut seq = 0u64;
            while !st.load(Ordering::SeqCst) {
                // native/ndi recv_connect, as is.
                let Ok(ndi) = NDI::new() else { std::thread::sleep(Duration::from_secs(1)); continue };
                let Ok(finder) = Finder::new(&ndi, &FinderOptions::builder().show_local_sources(true).build()) else { std::thread::sleep(Duration::from_secs(1)); continue };
                let Ok(sources) = finder.find_sources(Duration::from_millis(2000)) else { continue };
                let source = if n.is_empty() { sources.into_iter().next() } else { sources.into_iter().find(|s| s.name == n) };
                let Some(source) = source else { continue };
                let opts = ReceiverOptions::builder(source).color(ReceiverColorFormat::RGBX_RGBA).bandwidth(ReceiverBandwidth::Highest).build();
                let Ok(rx) = Receiver::new(&ndi, &opts) else { std::thread::sleep(Duration::from_secs(1)); continue };
                while !st.load(Ordering::SeqCst) {
                    // native/ndi recv_frame's capture, as is; a miss just tries again.
                    let Ok(video) = rx.video().capture(Duration::from_millis(5)) else { continue };
                    let (sw, sh) = (video.width() as u32, video.height() as u32);
                    if sw == 0 || sh == 0 { continue; }
                    seq += 1;
                    *l.lock().unwrap() = Some((sw, sh, video.data().to_vec(), seq));
                }
            }
        });
        NdiIn { latest, stop, name: name.to_string() }
    }

    /// The latest frame scaled to `size` (the app's NDI canvas) — RGBA, opaque — and its sequence number,
    /// or None before the first frame.
    pub fn frame(&self, size: Option<(u32, u32)>) -> Option<(u32, u32, Vec<u8>, u64)> {
        let g = self.latest.lock().unwrap();
        let (sw, sh, data, seq) = g.as_ref()?;
        let (ow, oh) = size.unwrap_or_else(|| fit(*sw, *sh, 1280, 720));
        Some((ow, oh, downscale_rgba(data, *sw, *sh, ow, oh), *seq))
    }
}

// ── VERBATIM from native/ndi/src/lib.rs (verify:invariants compares them) ─────────────────────────────
fn fit(sw: u32, sh: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if sw <= max_w && sh <= max_h {
        return (sw, sh);
    }
    let rw = max_w as f64 / sw as f64;
    let rh = max_h as f64 / sh as f64;
    let r = rw.min(rh);
    (((sw as f64 * r) as u32).max(1), ((sh as f64 * r) as u32).max(1))
}

fn downscale_rgba(src: &[u8], sw: u32, sh: u32, ow: u32, oh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (ow * oh * 4) as usize];
    for y in 0..oh {
        let sy = (y as u64 * sh as u64 / oh as u64) as u32;
        for x in 0..ow {
            let sx = (x as u64 * sw as u64 / ow as u64) as u32;
            let si = ((sy * sw + sx) * 4) as usize;
            let di = ((y * ow + x) * 4) as usize;
            if si + 3 < src.len() {
                out[di..di + 4].copy_from_slice(&src[si..si + 4]);
                out[di + 3] = 255;
            }
        }
    }
    out
}
