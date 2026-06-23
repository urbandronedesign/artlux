// Native NDI receive + send for ArtLux (napi-rs). Loaded in the MAIN process (the
// sandboxed renderer can't require a .node). Receive mirrors the Spout receiver: poll a
// frame, downscale to a capped RGBA buffer, hand it to JS for IPC. Send publishes a named
// NDI source per projector output, fed raw RGBA bytes from the renderer over IPC.
//
// The real implementation (feature `ndi`) links the NDI 6 SDK via the grafton-ndi crate.
// Without the feature it compiles to no-op stubs so SDK-less machines (this dev sandbox,
// CI without the SDK) still build — exactly like spout-receiver on non-Windows.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::Buffer;

#[napi(object)]
pub struct NdiFrame {
    pub width: u32,
    pub height: u32,
    pub data: Buffer, // RGBA, width×height (downscaled)
    // The source's true resolution (data is downscaled to width×height) so the renderer
    // can size the stage to the real aspect ratio.
    pub src_width: u32,
    pub src_height: u32,
}

// ---------------- Real implementation (NDI 6 SDK via grafton-ndi) ----------------
#[cfg(feature = "ndi")]
mod imp {
    use super::NdiFrame;
    use grafton_ndi::{
        Finder, FinderOptions, PixelFormat, Receiver, ReceiverBandwidth, ReceiverColorFormat,
        ReceiverOptions, Sender, SenderOptions, VideoFrame, NDI,
    };
    use napi::bindgen_prelude::Buffer;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;

    // Cap received frames so the napi Buffer + IPC stay light (NDI is often 1080p+).
    const MAX_W: u32 = 1280;
    const MAX_H: u32 = 720;

    // napi calls + the poll run on the single JS thread, so the NDI handles never cross
    // threads (same justification as spout-receiver's `unsafe impl Send`).
    struct Recv {
        _ndi: NDI,
        rx: Receiver,
    }
    unsafe impl Send for Recv {}
    static RECV: Mutex<Option<Recv>> = Mutex::new(None);

    struct Send1 {
        _ndi: NDI,
        tx: Sender,
    }
    unsafe impl Send for Send1 {}
    static SENDERS: Mutex<Option<HashMap<String, Send1>>> = Mutex::new(None);

    pub fn runtime_available() -> bool {
        NDI::new().is_ok()
    }

    pub fn cpu_supported() -> bool {
        NDI::is_supported_cpu()
    }

    pub fn list_sources() -> Vec<String> {
        let Ok(ndi) = NDI::new() else { return Vec::new() };
        let Ok(finder) = Finder::new(&ndi, &FinderOptions::builder().show_local_sources(true).build())
        else {
            return Vec::new();
        };
        match finder.find_sources(Duration::from_millis(1000)) {
            Ok(srcs) => srcs.iter().map(|s| s.name.clone()).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn recv_connect(name: String) -> napi::Result<()> {
        let ndi = NDI::new().map_err(reason("ndi init"))?;
        let finder = Finder::new(&ndi, &FinderOptions::builder().show_local_sources(true).build())
            .map_err(reason("ndi find"))?;
        let sources = finder
            .find_sources(Duration::from_millis(2000))
            .map_err(reason("ndi sources"))?;
        let source = if name.is_empty() {
            sources.into_iter().next()
        } else {
            sources.into_iter().find(|s| s.name == name)
        }
        .ok_or_else(|| napi::Error::from_reason("ndi source not found"))?;

        let opts = ReceiverOptions::builder(source)
            .color(ReceiverColorFormat::RGBX_RGBA)
            .bandwidth(ReceiverBandwidth::Highest)
            .build();
        let rx = Receiver::new(&ndi, &opts).map_err(reason("ndi recv"))?;
        *RECV.lock().unwrap() = Some(Recv { _ndi: ndi, rx });
        Ok(())
    }

    pub fn recv_disconnect() {
        *RECV.lock().unwrap() = None;
    }

    pub fn recv_frame() -> Option<NdiFrame> {
        let mut g = RECV.lock().unwrap();
        let st = g.as_mut()?;
        // Short timeout so the 60 Hz poll never blocks the main process.
        let video = st.rx.video().capture(Duration::from_millis(5)).ok()?;
        let sw = video.width() as u32;
        let sh = video.height() as u32;
        if sw == 0 || sh == 0 {
            return None;
        }
        let (ow, oh) = fit(sw, sh, MAX_W, MAX_H);
        let out = downscale_rgba(video.data(), sw, sh, ow, oh);
        Some(NdiFrame {
            width: ow,
            height: oh,
            data: out.into(),
            src_width: sw,
            src_height: sh,
        })
    }

    pub fn send_create(id: String, name: String) -> napi::Result<()> {
        let ndi = NDI::new().map_err(reason("ndi init"))?;
        let opts = SenderOptions::builder(name.as_str()).clock_video(true).build();
        let tx = Sender::new(&ndi, &opts).map_err(reason("ndi send"))?;
        SENDERS
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(id, Send1 { _ndi: ndi, tx });
        Ok(())
    }

    pub fn send_frame(id: String, width: u32, height: u32, data: Buffer) -> napi::Result<()> {
        let mut g = SENDERS.lock().unwrap();
        let Some(map) = g.as_mut() else { return Ok(()) };
        let Some(s) = map.get_mut(&id) else { return Ok(()) };
        // Renderer reads pixels as RGBA (gl.readPixels).
        let mut frame = VideoFrame::builder()
            .resolution(width as i32, height as i32)
            .pixel_format(PixelFormat::RGBA)
            .frame_rate(60, 1)
            .build()
            .map_err(reason("ndi frame"))?;
        let dst = frame.data_mut();
        let n = dst.len().min(data.len());
        dst[..n].copy_from_slice(&data[..n]);
        s.tx.send_video(&frame);
        Ok(())
    }

    pub fn send_destroy(id: String) {
        if let Some(map) = SENDERS.lock().unwrap().as_mut() {
            map.remove(&id);
        }
    }

    fn reason(ctx: &'static str) -> impl Fn(grafton_ndi::Error) -> napi::Error {
        move |e| napi::Error::from_reason(format!("{ctx}: {e}"))
    }

    // Largest w×h that fits within (max_w, max_h) preserving aspect (never upscales).
    fn fit(sw: u32, sh: u32, max_w: u32, max_h: u32) -> (u32, u32) {
        if sw <= max_w && sh <= max_h {
            return (sw, sh);
        }
        let rw = max_w as f64 / sw as f64;
        let rh = max_h as f64 / sh as f64;
        let r = rw.min(rh);
        (((sw as f64 * r) as u32).max(1), ((sh as f64 * r) as u32).max(1))
    }

    // Nearest-neighbour downscale of a tightly-packed RGBA image (stride = sw*4) to ow×oh.
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
}

// ---------------- Stubs (no NDI SDK at build) ----------------
#[cfg(not(feature = "ndi"))]
mod imp {
    use super::NdiFrame;
    use napi::bindgen_prelude::Buffer;

    pub fn runtime_available() -> bool {
        false
    }
    pub fn cpu_supported() -> bool {
        false
    }
    pub fn list_sources() -> Vec<String> {
        Vec::new()
    }
    pub fn recv_connect(_name: String) -> napi::Result<()> {
        Ok(())
    }
    pub fn recv_disconnect() {}
    pub fn recv_frame() -> Option<NdiFrame> {
        None
    }
    pub fn send_create(_id: String, _name: String) -> napi::Result<()> {
        Ok(())
    }
    pub fn send_frame(_id: String, _width: u32, _height: u32, _data: Buffer) -> napi::Result<()> {
        Ok(())
    }
    pub fn send_destroy(_id: String) {}
}

// ---------------- napi exports ----------------
#[napi]
pub fn runtime_available() -> bool {
    imp::runtime_available()
}
#[napi]
pub fn cpu_supported() -> bool {
    imp::cpu_supported()
}
#[napi]
pub fn list_sources() -> Vec<String> {
    imp::list_sources()
}
#[napi]
pub fn recv_connect(name: String) -> napi::Result<()> {
    imp::recv_connect(name)
}
#[napi]
pub fn recv_disconnect() {
    imp::recv_disconnect()
}
#[napi]
pub fn recv_frame() -> Option<NdiFrame> {
    imp::recv_frame()
}
#[napi]
pub fn send_create(id: String, name: String) -> napi::Result<()> {
    imp::send_create(id, name)
}
#[napi]
pub fn send_frame(id: String, width: u32, height: u32, data: Buffer) -> napi::Result<()> {
    imp::send_frame(id, width, height, data)
}
#[napi]
pub fn send_destroy(id: String) {
    imp::send_destroy(id)
}
