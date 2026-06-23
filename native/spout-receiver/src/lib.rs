// Native Spout receiver for ArtLux (napi-rs). Loaded in the MAIN process (the
// sandboxed renderer can't require a .node). Wraps spout2-rs's DirectX-11
// receiver (manages its own D3D11 device, CPU pixel readback), downscales each
// frame (aspect-preserving) to a capped RGBA size, and hands it to JS to forward
// over IPC. The cap is runtime-settable (broadcast mode lifts it to 1080p);
// defaults to 512² for the editor (the mapper samples a 512² source). Spout is
// Windows-only; non-Windows builds compile to no-op stubs so CI stays green.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::Buffer;

#[napi(object)]
pub struct SpoutFrame {
    pub width: u32,
    pub height: u32,
    pub data: Buffer,
    // The sender's true resolution (data is downscaled to width×height), so the
    // renderer can size the stage to the real aspect ratio.
    pub src_width: u32,
    pub src_height: u32,
}

#[cfg(windows)]
mod imp {
    use super::SpoutFrame;
    use spout2::dx::Receiver;
    use std::sync::Mutex;

    // Aspect-preserving output cap. Runtime-settable; defaults to 512² for the editor.
    static CAP: Mutex<(u32, u32)> = Mutex::new((512, 512));

    pub fn set_cap(w: u32, h: u32) {
        if w > 0 && h > 0 {
            *CAP.lock().unwrap() = (w, h);
        }
    }

    struct State {
        rx: Receiver,
        buf: Vec<u8>, // sender-resolution RGBA/BGRA
        w: u32,
        h: u32,
    }
    // napi calls run on the single JS thread and the poll runs on the same
    // thread, so the raw spoutDX pointer never crosses threads.
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
        *STATE.lock().unwrap() = Some(State { rx, buf: vec![0u8; 256 * 256 * 4], w: 256, h: 256 });
        Ok(())
    }

    pub fn disconnect() {
        *STATE.lock().unwrap() = None;
    }

    pub fn receive_frame() -> Option<SpoutFrame> {
        let mut g = STATE.lock().unwrap();
        let st = g.as_mut()?;
        let connected = st.rx.receive_image(&mut st.buf, st.w, st.h, false, false).unwrap_or(false);
        if st.rx.is_updated() {
            // Sender appeared/resized: match its size, fill on the next poll.
            let (nw, nh) = st.rx.sender_size();
            if nw > 0 && nh > 0 {
                st.w = nw;
                st.h = nh;
                st.buf.resize(nw as usize * nh as usize * 4, 0);
            }
            return None;
        }
        if !connected || !st.rx.is_frame_new() {
            return None;
        }
        let bgra = st.rx.sender_format() == 87; // DXGI_FORMAT_B8G8R8A8_UNORM
        let (max_w, max_h) = *CAP.lock().unwrap();
        let (ow, oh) = fit(st.w, st.h, max_w, max_h);
        let out = downscale(&st.buf, st.w, st.h, ow, oh, bgra);
        Some(SpoutFrame { width: ow, height: oh, data: out.into(), src_width: st.w, src_height: st.h })
    }

    // Largest w×h that fits within (max_w, max_h) preserving aspect (never upscales).
    fn fit(sw: u32, sh: u32, max_w: u32, max_h: u32) -> (u32, u32) {
        if sw == 0 || sh == 0 {
            return (max_w.max(1), max_h.max(1));
        }
        if sw <= max_w && sh <= max_h {
            return (sw, sh);
        }
        let r = (max_w as f64 / sw as f64).min(max_h as f64 / sh as f64);
        (((sw as f64 * r) as u32).max(1), ((sh as f64 * r) as u32).max(1))
    }

    // Nearest-neighbour downscale of a (w x h, 4bpp) image to ow x oh RGBA.
    fn downscale(src: &[u8], w: u32, h: u32, ow: u32, oh: u32, bgra: bool) -> Vec<u8> {
        let mut out = vec![0u8; (ow * oh * 4) as usize];
        if w == 0 || h == 0 {
            return out;
        }
        for y in 0..oh {
            let sy = (y as u64 * h as u64 / oh as u64) as u32;
            for x in 0..ow {
                let sx = (x as u64 * w as u64 / ow as u64) as u32;
                let si = ((sy * w + sx) * 4) as usize;
                let di = ((y * ow + x) * 4) as usize;
                if si + 3 < src.len() {
                    if bgra {
                        out[di] = src[si + 2];
                        out[di + 1] = src[si + 1];
                        out[di + 2] = src[si];
                    } else {
                        out[di] = src[si];
                        out[di + 1] = src[si + 1];
                        out[di + 2] = src[si + 2];
                    }
                    out[di + 3] = 255;
                }
            }
        }
        out
    }
}

#[cfg(windows)]
#[napi]
pub fn set_cap(w: u32, h: u32) {
    imp::set_cap(w, h)
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
pub fn receive_frame() -> Option<SpoutFrame> {
    imp::receive_frame()
}

// ---- Non-Windows stubs (Spout is Windows-only) ----
#[cfg(not(windows))]
#[napi]
pub fn set_cap(_w: u32, _h: u32) {}
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
pub fn receive_frame() -> Option<SpoutFrame> {
    None
}
