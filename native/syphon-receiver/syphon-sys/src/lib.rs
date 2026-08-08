//! Rust bindings over the Objective-C Syphon shim (`src/shim.m`). No napi here — see Cargo.toml for
//! why the split exists.
//!
//! Everything is `macos`-gated with stubs elsewhere, on the same graceful-degradation principle as
//! every other native module in this repo: a missing feature is a feature that is absent, never a
//! crash and never a build failure on the wrong platform.
//!
//! ⚠ MAIN THREAD ONLY, and nothing here is `Sync`. See shim.h.

/// A discovered Syphon server. **Identity is the pair**, not the name: a server's `name` is
/// frequently empty and `app_name` is what an operator recognises. Both empty in a *request* means
/// "the active server" (Spout's convention, preserved).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerDesc {
    pub name: String,
    pub app_name: String,
}

impl ServerDesc {
    /// What the picker shows. `App — Name`, or just the app when the server is unnamed, which is the
    /// convention every other Syphon client uses.
    pub fn label(&self) -> String {
        match (self.app_name.is_empty(), self.name.is_empty()) {
            (false, false) => format!("{} — {}", self.app_name, self.name),
            (false, true) => self.app_name.clone(),
            (true, false) => self.name.clone(),
            (true, true) => "(unnamed)".to_string(),
        }
    }
}

/// One frame: an `IOSurfaceRef` as a `usize`, **+1 retained**. The holder must call
/// [`release_surface`]. See shim.h for why that reference survives the hand-off to Electron.
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    pub surface: usize,
    pub width: u32,
    pub height: u32,
    /// Always `'BGRA'`. Carried anyway so the value that was actually checked is the value that
    /// travels, rather than a constant re-asserted at the far end.
    pub pixel_format: u32,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Frame, ServerDesc};
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_double, c_int};

    // Every one of these is checked by clang against Syphon's own headers on the other side of the
    // FFI — which is the entire reason the shim is Objective-C. See shim.h.
    extern "C" {
        fn artlux_syphon_available() -> c_int;
        fn artlux_syphon_directory_start();
        fn artlux_syphon_server_count() -> c_int;
        fn artlux_syphon_server_name(idx: c_int, buf: *mut c_char, cap: c_int) -> c_int;
        fn artlux_syphon_server_app_name(idx: c_int, buf: *mut c_char, cap: c_int) -> c_int;
        fn artlux_syphon_connect(name: *const c_char, app: *const c_char) -> c_int;
        fn artlux_syphon_ensure_connected() -> c_int;
        fn artlux_syphon_disconnect();
        fn artlux_syphon_is_valid() -> c_int;
        fn artlux_syphon_has_new_frame() -> c_int;
        fn artlux_syphon_new_surface(w: *mut u32, h: *mut u32, fmt: *mut u32) -> usize;
        fn artlux_syphon_release_surface(surface: usize);
        // selftest only
        fn artlux_syphon_test_server_start(name: *const c_char) -> c_int;
        fn artlux_syphon_test_server_publish(w: u32, h: u32, bgra: u32) -> c_int;
        fn artlux_syphon_test_server_stop();
        fn artlux_syphon_test_connect_direct() -> c_int;
        fn artlux_syphon_runloop_spin(seconds: c_double);
        fn artlux_syphon_surface_retain_count(surface: usize) -> c_int;
        fn artlux_syphon_surface_pixel(surface: usize, x: u32, y: u32) -> u32;
    }

    // Syphon names are human-typed and short; 512 is far past anything real and the shim truncates
    // rather than overflowing.
    const NAME_CAP: usize = 512;

    fn read_str(f: unsafe extern "C" fn(c_int, *mut c_char, c_int) -> c_int, idx: i32) -> String {
        let mut buf = vec![0u8; NAME_CAP];
        let n = unsafe { f(idx, buf.as_mut_ptr() as *mut c_char, NAME_CAP as c_int) };
        if n < 0 {
            return String::new();
        }
        unsafe { CStr::from_ptr(buf.as_ptr() as *const c_char) }
            .to_string_lossy()
            .into_owned()
    }

    pub fn available() -> bool { unsafe { artlux_syphon_available() != 0 } }
    pub fn directory_start() { unsafe { artlux_syphon_directory_start() } }

    pub fn list_servers() -> Vec<ServerDesc> {
        let n = unsafe { artlux_syphon_server_count() };
        (0..n)
            .map(|i| ServerDesc {
                name: read_str(artlux_syphon_server_name, i),
                app_name: read_str(artlux_syphon_server_app_name, i),
            })
            .collect()
    }

    pub fn connect(name: &str, app_name: &str) -> bool {
        // A NUL inside a server name is not a case worth a Result: it cannot come from a real
        // Syphon server, and the honest response is "no such server".
        let (Ok(n), Ok(a)) = (CString::new(name), CString::new(app_name)) else { return false };
        unsafe { artlux_syphon_connect(n.as_ptr(), a.as_ptr()) != 0 }
    }

    pub fn ensure_connected() -> bool { unsafe { artlux_syphon_ensure_connected() != 0 } }
    pub fn disconnect() { unsafe { artlux_syphon_disconnect() } }
    pub fn is_valid() -> bool { unsafe { artlux_syphon_is_valid() != 0 } }
    pub fn has_new_frame() -> bool { unsafe { artlux_syphon_has_new_frame() != 0 } }

    pub fn new_surface() -> Option<Frame> {
        let (mut w, mut h, mut fmt) = (0u32, 0u32, 0u32);
        let s = unsafe { artlux_syphon_new_surface(&mut w, &mut h, &mut fmt) };
        if s == 0 || w == 0 || h == 0 {
            // A zero-sized surface is not a frame. Handing one to Electron produces an import error
            // that the manager would latch as terminal — see the `import-failed` path — so a server
            // mid-republish would permanently disable Syphon rather than costing one dropped frame.
            if s != 0 { unsafe { artlux_syphon_release_surface(s) } }
            return None;
        }
        Some(Frame { surface: s, width: w, height: h, pixel_format: fmt })
    }

    pub fn release_surface(surface: usize) { unsafe { artlux_syphon_release_surface(surface) } }

    pub mod test_support {
        use super::*;
        pub fn server_start(name: &str) -> bool {
            let Ok(n) = CString::new(name) else { return false };
            unsafe { artlux_syphon_test_server_start(n.as_ptr()) != 0 }
        }
        pub fn server_publish(w: u32, h: u32, bgra: u32) -> bool {
            unsafe { artlux_syphon_test_server_publish(w, h, bgra) != 0 }
        }
        pub fn server_stop() { unsafe { artlux_syphon_test_server_stop() } }
        pub fn connect_direct() -> bool { unsafe { artlux_syphon_test_connect_direct() != 0 } }
        pub fn runloop_spin(seconds: f64) { unsafe { artlux_syphon_runloop_spin(seconds) } }
        pub fn retain_count(surface: usize) -> i32 { unsafe { artlux_syphon_surface_retain_count(surface) } }
        pub fn pixel(surface: usize, x: u32, y: u32) -> u32 { unsafe { artlux_syphon_surface_pixel(surface, x, y) } }
    }
}

// ── Non-macOS stubs ─────────────────────────────────────────────────────────────────────────────
// Syphon is a macOS API. Off darwin this compiles to "there is nothing here", exactly as
// native/spout-receiver does off Windows, so the Windows dev box and the Linux CI runner both stay
// green while the feature is simply absent.
#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{Frame, ServerDesc};
    pub fn available() -> bool { false }
    pub fn directory_start() {}
    pub fn list_servers() -> Vec<ServerDesc> { Vec::new() }
    pub fn connect(_name: &str, _app_name: &str) -> bool { false }
    pub fn ensure_connected() -> bool { false }
    pub fn disconnect() {}
    pub fn is_valid() -> bool { false }
    pub fn has_new_frame() -> bool { false }
    pub fn new_surface() -> Option<Frame> { None }
    pub fn release_surface(_surface: usize) {}

    pub mod test_support {
        pub fn server_start(_name: &str) -> bool { false }
        pub fn server_publish(_w: u32, _h: u32, _bgra: u32) -> bool { false }
        pub fn server_stop() {}
        pub fn connect_direct() -> bool { false }
        pub fn runloop_spin(_seconds: f64) {}
        pub fn retain_count(_surface: usize) -> i32 { -1 }
        pub fn pixel(_surface: usize, _x: u32, _y: u32) -> u32 { 0 }
    }
}

pub use imp::{
    available, connect, directory_start, disconnect, ensure_connected, has_new_frame, is_valid,
    list_servers, new_surface, release_surface, test_support,
};
