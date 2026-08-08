// Native Spout receiver for ArtLux (napi-rs). Loaded in the MAIN process (the
// sandboxed renderer can't require a .node). Wraps spout2-rs's DirectX-11
// receiver (manages its own D3D11 device, CPU pixel readback), fits each frame
// (aspect-preserving) to a capped RGBA size, and hands it to JS to forward over
// IPC. The cap is runtime-settable and defaults to 1080p in EVERY mode. Spout is
// Windows-only; non-Windows builds compile to no-op stubs so CI stays green.
//
// ⚠ THE CAP AND THE FILTER ARE ONE DECISION — changing either alone reintroduces
// the bug they were built to fix. The cap used to be 512² outside `--broadcast`,
// and the resample was nearest-neighbour: a 1080p sender arrived as 512×288 (7%
// of its pixels, point-sampled), so an operator sending full HD saw a visibly
// aliased output and no setting explained why. With the cap at 1080p the ordinary
// sender now needs NO resample at all, which is why `swizzle` exists as a separate
// path — see the comments on each function.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::Buffer;

#[cfg(windows)]
mod share;

// A GPU texture handed straight to the renderer — no readback, no IPC copy of pixels. See share.rs
// for why this is OUR texture rather than the sender's.
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
    use super::{SpoutFrame, SpoutShare};
    use crate::share;
    use napi::bindgen_prelude::Buffer;
    use spout2::dx::Receiver;
    use std::sync::Mutex;

    // Aspect-preserving output cap. Runtime-settable; defaults to 1080p — the house format, and the
    // resolution an operator sending full HD expects to get back. It is deliberately the SAME in the
    // editor and in broadcast: a projector window can be opened from the editor, so a preview-grade
    // cap there was never "just the preview" — it fed live output.
    static CAP: Mutex<(u32, u32)> = Mutex::new((1920, 1080));

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
        // Spout's own receive target, used ONLY by the GPU path — see receive_shared for why it has
        // to exist. Owned by us per Spout's ReceiveTexture(ID3D11Texture2D**) contract: Spout creates
        // and resizes it, we release it. Null until the first GPU receive.
        tex_slot: *mut std::ffi::c_void,
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
        *STATE.lock().unwrap() = Some(State {
            rx,
            buf: vec![0u8; 256 * 256 * 4],
            w: 256,
            h: 256,
            tex_slot: std::ptr::null_mut(),
        });
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

    // The GPU path: copy the sender's texture into our own NT-shared one and describe it, for
    // Electron's sharedTexture import. Returns None whenever anything is not ready or not possible —
    // no sender, no frame yet, a cross-adapter open, a driver that refuses — and the caller then uses
    // receive_frame() as before. The two paths are alternatives per frame, never both.
    //
    // ⚠ Call this INSTEAD of receive_frame(), not after it: both consume the same "is this frame new"
    // edge from the receiver, so calling both makes each see only half the frames.
    pub fn receive_shared() -> Option<SpoutShare> {
        let mut g = STATE.lock().unwrap();
        let st = g.as_mut()?;
        // A REAL receive, on the texture side so it costs no readback. Spout owns the copy into
        // `tex_slot`; we never read that texture — our pixels come from the sender's own shared
        // texture in share.rs — but the call is what keeps the receiver's state current, which is
        // what makes `is_updated()` below able to see a sender resize at all.
        //
        // This replaced `receive_image(&mut [], 0, 0, …)`, a zero-size read used as a cheap way to
        // tick the receiver. Spout rejects the zero size before touching any state, so that version
        // advanced nothing and a resize could go unnoticed on this path.
        //
        // ⚠ IT DOES NOT MAKE `is_frame_new()` RELIABLE, and nothing here can. That flag depends on
        // the SENDER publishing frame counts; against a sender that does not, it answers "yes"
        // forever. Measured at 92 Hz against a 60 fps sender: 278 frames delivered in 3 s, 179 of
        // them distinct — 36% were a re-send of a picture already sent. The defence is the poll rate,
        // not this check (see pollHz in spoutManager), because there is none available here.
        unsafe {
            st.rx.receive_into_texture(&mut st.tex_slot);
        }
        if st.rx.is_updated() {
            let (nw, nh) = st.rx.sender_size();
            if nw > 0 && nh > 0 {
                st.w = nw;
                st.h = nh;
            }
            return None; // republish: the handle we hold is stale, take it next poll
        }
        if !st.rx.is_frame_new() {
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
        // `fit` never upscales, so equal dimensions mean the sender already fits the cap — the
        // ordinary case now that the cap is 1080p. Take the copy-only path; see `swizzle`.
        let out = if ow == st.w && oh == st.h {
            swizzle(&st.buf, st.w, st.h, bgra)
        } else {
            downscale(&st.buf, st.w, st.h, ow, oh, bgra)
        };
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

    // 1:1 copy to RGBA — no resample, only the channel order to fix (and alpha forced opaque, which
    // the resampling path does too: a Spout sender's alpha is frequently uninitialised garbage).
    //
    // Kept separate from `downscale` rather than falling out of it as a 1×1 box, because with a 1080p
    // cap this is the ORDINARY case for an ordinary sender. Running the box filter at 1:1 would spend
    // ~2M iterations of span arithmetic per frame to average exactly one pixel with itself — on the
    // main process's thread, at the sender's frame rate.
    fn swizzle(src: &[u8], w: u32, h: u32, bgra: bool) -> Vec<u8> {
        let n = (w as usize) * (h as usize) * 4;
        let mut out = vec![0u8; n];
        // Clamp to what the source actually holds, and to a whole number of pixels: a short or
        // ragged buffer must leave the tail black, never panic on an index.
        let n = n.min(src.len()) & !3;
        if bgra {
            for i in (0..n).step_by(4) {
                out[i] = src[i + 2];
                out[i + 1] = src[i + 1];
                out[i + 2] = src[i];
                out[i + 3] = 255;
            }
        } else {
            out[..n].copy_from_slice(&src[..n]);
            for i in (3..n).step_by(4) {
                out[i] = 255;
            }
        }
        out
    }

    // Box-filter downscale of a (w × h, 4bpp) image to ow × oh RGBA — every source pixel covering a
    // destination pixel contributes to its average.
    //
    // This replaced a nearest-neighbour point sample, which kept ONE source pixel per destination and
    // discarded the rest. That aliased three ways at once: jagged edges, moiré on fine detail, and —
    // because which survivor won shifted frame to frame — crawling shimmer on anything that moved.
    // The operator-visible symptom was "my Spout output looks low quality" while the sender was
    // provably full HD, with no setting in the app that explained it.
    //
    // Still reachable with the 1080p cap: a 4K sender, or any sender wider than the cap's aspect.
    fn downscale(src: &[u8], w: u32, h: u32, ow: u32, oh: u32, bgra: bool) -> Vec<u8> {
        let mut out = vec![0u8; (ow as usize) * (oh as usize) * 4];
        if w == 0 || h == 0 || ow == 0 || oh == 0 {
            return out;
        }
        // The source offsets of R and B are the only difference between the two formats — hoisted out
        // of the loop so the filter itself is written once rather than duplicated per channel order.
        let (ri, bi) = if bgra { (2usize, 0usize) } else { (0usize, 2usize) };
        for y in 0..oh {
            // Half-open source span [y0, y1) for this destination row. Consecutive spans tile the
            // source exactly — no gap, no overlap — so every source pixel is counted once and the
            // frame's average brightness is preserved. `.max(y0 + 1)` keeps a span non-empty below
            // 2× reduction, where integer division would otherwise collapse it and divide by zero.
            let y0 = (y as u64 * h as u64 / oh as u64) as u32;
            let y1 = (((y as u64 + 1) * h as u64 / oh as u64) as u32).max(y0 + 1).min(h);
            for x in 0..ow {
                let x0 = (x as u64 * w as u64 / ow as u64) as u32;
                let x1 = (((x as u64 + 1) * w as u64 / ow as u64) as u32).max(x0 + 1).min(w);
                let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
                for sy in y0..y1 {
                    let row = (sy as usize) * (w as usize) * 4;
                    for sx in x0..x1 {
                        let si = row + (sx as usize) * 4;
                        if si + 3 >= src.len() {
                            continue;
                        }
                        r += src[si + ri] as u32;
                        g += src[si + 1] as u32;
                        b += src[si + bi] as u32;
                        n += 1;
                    }
                }
                let di = ((y as usize) * (ow as usize) + x as usize) * 4;
                if n > 0 {
                    // u8 sums over a box can't overflow u32 until ~16M source pixels per destination
                    // pixel, which no real reduction reaches.
                    out[di] = (r / n) as u8;
                    out[di + 1] = (g / n) as u8;
                    out[di + 2] = (b / n) as u8;
                }
                out[di + 3] = 255;
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
#[cfg(windows)]
#[napi]
pub fn receive_shared() -> Option<SpoutShare> {
    imp::receive_shared()
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
#[cfg(not(windows))]
#[napi]
pub fn receive_shared() -> Option<SpoutShare> {
    None
}
