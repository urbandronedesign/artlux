// Native Spout receiver for ArtLux (napi-rs). Loaded in the MAIN process (the
// sandboxed renderer can't require a .node). Wraps spout2-rs's DirectX-11
// receiver (manages its own D3D11 device, CPU pixel readback), downscales each
// frame to 512x512 RGBA, and hands it to JS to forward over IPC. Spout is
// Windows-only; non-Windows builds compile to no-op stubs so CI stays green.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::Buffer;

const OUT: u32 = 512; // the mapper samples a 512x512 source, so downscale here.

#[napi(object)]
pub struct SpoutFrame {
    pub width: u32,
    pub height: u32,
    pub data: Buffer,
}

#[cfg(windows)]
mod imp {
    use super::{SpoutFrame, OUT};
    use spout2::dx::Receiver;
    use std::sync::Mutex;

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
        let out = downscale(&st.buf, st.w, st.h, bgra);
        Some(SpoutFrame { width: OUT, height: OUT, data: out.into() })
    }

    // Nearest-neighbour downscale of a (w x h, 4bpp) image to OUT x OUT RGBA.
    fn downscale(src: &[u8], w: u32, h: u32, bgra: bool) -> Vec<u8> {
        let mut out = vec![0u8; (OUT * OUT * 4) as usize];
        if w == 0 || h == 0 {
            return out;
        }
        for y in 0..OUT {
            let sy = (y as u64 * h as u64 / OUT as u64) as u32;
            for x in 0..OUT {
                let sx = (x as u64 * w as u64 / OUT as u64) as u32;
                let si = ((sy * w + sx) * 4) as usize;
                let di = ((y * OUT + x) * 4) as usize;
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
