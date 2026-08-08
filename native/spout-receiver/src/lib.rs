// Native Spout receiver for ArtLux (napi-rs). Loaded in the MAIN process (the sandboxed renderer
// can't require a .node). Spout is Windows-only; non-Windows builds compile to no-op stubs so CI
// stays green.
//
// ⚠ THIS RECEIVER IS GPU-ONLY. It hands out a SHARED TEXTURE HANDLE, never pixels. There is no CPU
// readback path and none should be added back.
//
// There used to be one, and it was the only path: read the sender's texture back to system memory,
// resample it to a cap, and ship 8.3 MB per frame over IPC. It cost ~9 ms of main-thread stall per
// frame at 1080p, and every part of it was a way of losing quality — the cap was 512² outside
// `--broadcast` and the resample was a nearest-neighbour point sample, so a full-HD sender arrived
// as 512×288 of point-sampled pixels and looked visibly aliased with nothing in the app to explain
// it. Both were fixed (1080p cap, box filter) before the GPU path existed. Then the GPU path made
// the whole road unnecessary, and keeping a slow, lossy alternative alive as a silent fallback is
// worse than not having one: it turns "your GPU cannot do this" into "your output looks wrong for
// reasons nobody can see". A machine that cannot share textures is now told so.
//
// See share.rs for why the handle we publish is OUR texture and not the sender's.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::Buffer;

#[cfg(windows)]
mod share;

// A GPU texture handed straight to the renderer — no readback, no IPC copy of pixels.
#[napi(object)]
pub struct SpoutShare {
    // The NT share HANDLE as 8 little-endian bytes: pointer-sized, so a JS number would lose
    // precision, and Electron's SharedTextureHandle.ntHandle wants a Buffer regardless.
    pub handle: Buffer,
    pub width: u32,
    pub height: u32,
    // DXGI_FORMAT. 87 = B8G8R8A8_UNORM ('bgra' to Electron), 28 = R8G8B8A8_UNORM ('rgba').
    pub format: u32,
}

#[cfg(windows)]
mod imp {
    use super::SpoutShare;
    use crate::share;
    use napi::bindgen_prelude::Buffer;
    use spout2::dx::Receiver;
    use std::sync::Mutex;

    struct State {
        rx: Receiver,
        // Spout's own receive target. We never read it — our pixels come from the sender's shared
        // texture in share.rs — but Spout needs somewhere to receive into for its state to advance.
        // Owned by us per the ReceiveTexture(ID3D11Texture2D**) contract: Spout creates and resizes
        // it, we release it. Null until the first receive.
        tex_slot: *mut std::ffi::c_void,
    }
    // napi calls run on the single JS thread and the poll runs on the same thread, so the raw
    // spoutDX pointer never crosses threads.
    unsafe impl Send for State {}

    static STATE: Mutex<Option<State>> = Mutex::new(None);

    pub fn list_senders() -> Vec<String> {
        match Receiver::new(None) {
            Ok(rx) => rx.sender_list(),
            Err(_) => Vec::new(),
        }
    }

    pub fn connect(name: String) -> napi::Result<()> {
        let opt = if name.is_empty() { None } else { Some(name) };
        let rx = Receiver::new(opt.as_deref())
            .map_err(|e| napi::Error::from_reason(format!("spout connect: {e}")))?;
        *STATE.lock().unwrap() = Some(State { rx, tex_slot: std::ptr::null_mut() });
        Ok(())
    }

    pub fn disconnect() {
        // Release Spout's receive texture before dropping the receiver. Per the ReceiveTexture
        // contract that texture is OURS once Spout has created it, and dropping the Receiver does not
        // free it — so without this each connect/disconnect cycle strands a full-resolution texture
        // in VRAM for the life of the process.
        if let Some(st) = STATE.lock().unwrap().as_mut() {
            if !st.tex_slot.is_null() {
                unsafe { share::release_texture(st.tex_slot) };
                st.tex_slot = std::ptr::null_mut();
            }
        }
        *STATE.lock().unwrap() = None;
        share::reset();
    }

    /// The sender's current frame as a shared texture Electron can import, or None when there is
    /// nothing to hand over this poll — no sender yet, a republish in progress, or a share the GPU
    /// refused. None is not an error; the caller simply polls again.
    pub fn receive_shared() -> Option<SpoutShare> {
        let mut g = STATE.lock().unwrap();
        let st = g.as_mut()?;
        // A REAL receive, on the texture side so it costs no readback. Spout owns the copy into
        // `tex_slot`; the call is what keeps the receiver's state current, which is what makes
        // `is_updated()` below able to see a sender resize at all.
        //
        // ⚠ IT DOES NOT MAKE `is_frame_new()` RELIABLE, and nothing here can. That flag depends on
        // the SENDER publishing frame counts; against a sender that does not, it answers "yes"
        // forever. Measured at 92 Hz against a 60 fps sender: 278 frames delivered in 3 s, 179 of
        // them distinct — 36% were a re-send of a picture already sent. The defence is the poll rate
        // (see pollHz in spoutManager), because there is none available here.
        unsafe {
            st.rx.receive_into_texture(&mut st.tex_slot);
        }
        if st.rx.is_updated() {
            // Sender appeared or resized and republished: whatever handle we hold is stale. Take the
            // new one on the next poll, once the republish has settled.
            return None;
        }
        let raw = unsafe { st.rx.sender_handle() } as isize;
        let (w, h) = st.rx.sender_size();
        let s = share::reshare(raw, w, h, st.rx.sender_format())?;
        Some(SpoutShare {
            handle: Buffer::from((s.handle as u64).to_le_bytes().to_vec()),
            width: s.width,
            height: s.height,
            format: s.format,
        })
    }
}

#[cfg(windows)]
#[napi]
pub fn list_senders() -> Vec<String> {
    imp::list_senders()
}
#[cfg(windows)]
#[napi]
pub fn connect(name: String) -> napi::Result<()> {
    imp::connect(name)
}
#[cfg(windows)]
#[napi]
pub fn disconnect() {
    imp::disconnect()
}
#[cfg(windows)]
#[napi]
pub fn receive_shared() -> Option<SpoutShare> {
    imp::receive_shared()
}

// ---- Non-Windows stubs (Spout is Windows-only) ----
#[cfg(not(windows))]
#[napi]
pub fn list_senders() -> Vec<String> {
    Vec::new()
}
#[cfg(not(windows))]
#[napi]
pub fn connect(_name: String) -> napi::Result<()> {
    Ok(())
}
#[cfg(not(windows))]
#[napi]
pub fn disconnect() {}
#[cfg(not(windows))]
#[napi]
pub fn receive_shared() -> Option<SpoutShare> {
    None
}
