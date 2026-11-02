// Native Syphon receiver for ArtLux (napi-rs). Loaded in the MAIN process (the sandboxed renderer
// can't require a .node). Syphon is macOS-only; every other platform gets the stubs in syphon-sys,
// so this builds green on the Windows dev box and the Linux CI runner alike.
//
// ⚠ THIS RECEIVER IS GPU-ONLY, exactly like native/spout-receiver. It hands out an IOSurface, never
// pixels. There is no CPU readback path and none should be added back — read the header of
// native/spout-receiver/src/lib.rs for the full account of why that road was removed on Windows;
// every word of it applies here, and here there was never a reason to build one in the first place.
//
// WHAT IS *NOT* HERE, AND THAT IS THE POINT. Spout needs share.rs — a whole D3D11 re-share through
// our own device — because Spout's handle is a legacy DX9 token Electron cannot duplicate. Syphon's
// transport primitive IS an IOSurface, which is precisely what Electron's sharedTexture API wants on
// darwin. So there is no copy, no second device, and no format table (Syphon publishes BGRA and
// nothing else). If this file ever grows one of those, something has gone wrong: go and re-read
// plans/syphon-plugin.md §1.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::Buffer;

/// A discovered server. **The pair is the identity** — a Syphon server's name is frequently empty
/// and the app name is what an operator recognises. See plans/syphon-plugin.md §4.2.
#[napi(object)]
pub struct SyphonServerDesc {
    pub name: String,
    pub app_name: String,
    /// `App — Name`, or the app alone when unnamed. Computed here so the picker and the logs agree
    /// on one spelling rather than each inventing their own.
    pub label: String,
}

/// A GPU frame handed straight to the renderer — no readback, no IPC copy of pixels.
#[napi(object)]
pub struct SyphonShare {
    /// The `IOSurfaceRef` as 8 little-endian bytes. Pointer-sized, so a JS number would lose
    /// precision, and Electron's `SharedTextureHandle.ioSurface` wants a Buffer regardless.
    ///
    /// ⚠ +1 RETAINED, AND THE CALLER MUST GIVE IT BACK via `releaseSurface`. Electron RETAINS the
    /// surface on import rather than taking ownership of it (verified in Chromium's
    /// `electron_api_shared_texture.cc`: `ScopedCFTypeRef(io_surface, scoped_policy::RETAIN)`), so
    /// our reference survives the hand-off and dropping it is our job. This is the one place the
    /// macOS path is fiddlier than Windows, where Electron duplicates the NT handle instead.
    pub surface: Buffer,
    pub width: u32,
    pub height: u32,
}

fn ptr_to_buffer(p: usize) -> Buffer {
    Buffer::from((p as u64).to_le_bytes().to_vec())
}

fn buffer_to_ptr(b: &Buffer) -> usize {
    let bytes = b.as_ref();
    if bytes.len() < 8 {
        return 0;
    }
    let mut le = [0u8; 8];
    le.copy_from_slice(&bytes[..8]);
    u64::from_le_bytes(le) as usize
}

/// Did the Syphon framework load? Reported on the startup splash — a missing one is otherwise silent.
#[napi]
pub fn available() -> bool {
    artlux_syphon_sys::available()
}

/// Warm the server directory. Call at plugin activation, NOT lazily: the directory learns about
/// servers from announcements, so one created the moment the operator opens the picker has heard
/// nothing yet and shows an empty list.
#[napi]
pub fn start_directory() {
    artlux_syphon_sys::directory_start();
}

#[napi]
pub fn list_servers() -> Vec<SyphonServerDesc> {
    artlux_syphon_sys::list_servers()
        .into_iter()
        .map(|s| SyphonServerDesc { label: s.label(), name: s.name, app_name: s.app_name })
        .collect()
}

/// Connect to `(name, appName)`. Either may be empty for "don't care", so `("", "")` is Spout's
/// "active sender": whatever server is currently on the system.
#[napi]
pub fn connect(name: String, app_name: String) -> napi::Result<()> {
    if artlux_syphon_sys::connect(&name, &app_name) {
        return Ok(());
    }
    // Not an error worth throwing on: the wanted server simply is not running yet. The poll calls
    // `receive_shared`, which re-resolves every tick, so a server that appears later is picked up
    // without the renderer doing anything. Reported so the log says which one we are waiting for.
    println!("[syphon] no server matching (name={name:?}, app={app_name:?}) yet — will keep looking");
    Ok(())
}

#[napi]
pub fn disconnect() {
    artlux_syphon_sys::disconnect();
}

/// The server's current frame as an IOSurface Electron can import, or `None` when there is nothing
/// to hand over this poll. `None` is not an error; the caller simply polls again.
///
/// Two gates, in order:
///   1. `ensure_connected` — a client whose server quit NEVER recovers (`isValid` latches NO), so
///      re-resolving here is what makes "Active server" survive a sender restart. Cheap when valid.
///   2. `has_new_frame` — backed by the server's published frame ID, so unlike Spout's
///      `is_frame_new()` this is TRUTHFUL. It is why the poll can simply be gated instead of
///      rate-limited: a poll above the server's rate costs one lock and one integer compare here,
///      rather than re-delivering a picture already sent at the full price of a copy and an import.
#[napi]
pub fn receive_shared() -> Option<SyphonShare> {
    if !artlux_syphon_sys::ensure_connected() {
        return None;
    }
    if !artlux_syphon_sys::has_new_frame() {
        return None;
    }
    let f = artlux_syphon_sys::new_surface()?;
    Some(SyphonShare { surface: ptr_to_buffer(f.surface), width: f.width, height: f.height })
}

/// Give back the reference `receiveShared` handed out. **Call this for every frame**, after the
/// import — see `SyphonShare::surface`. A missed release leaks a full-resolution surface per frame,
/// the exact twin of a missed `VideoFrame.close()` in the renderer.
#[napi]
pub fn release_surface(surface: Buffer) {
    let p = buffer_to_ptr(&surface);
    if p != 0 {
        artlux_syphon_sys::release_surface(p);
    }
}
