//! DirectShow capture-mode enumeration (Windows only).
//!
//! WHY THIS EXISTS: OpenCV's videoio exposes no way to ask a device what it can actually do. Its
//! `cap.set(CAP_PROP_FRAME_WIDTH/HEIGHT/FPS)` is a *hint* — the driver silently picks the nearest mode
//! it supports and never reports that it refused. So the wizard's resolution picker was a hardcoded
//! list (640×480 / 800×600 / 1280×720 / 1920×1080), and choosing 1920×1080 on a PS3 Eye — whose only
//! real modes are 640×480 and 320×240 — appeared to work while the camera kept sending 640×480.
//!
//! There is no OpenCV call for this, so we go to DirectShow directly: enumerate the video-input
//! category, bind the device at `index`, find its capture output pin, and read `IAMStreamConfig`'s
//! stream caps. That is the same enumeration order OpenCV's CAP_DSHOW backend walks, so the index the
//! operator types addresses the same device in both.
//!
//! COM note: Electron has already initialised COM on this thread. `CoInitializeEx` is called anyway
//! (it is the documented way to bump the per-thread ref count) and its HRESULT deliberately IGNORED —
//! `RPC_E_CHANGED_MODE` just means the host chose the other apartment, which does not stop us reading
//! device caps. We never call `CoUninitialize`: that would tear COM down under the host.

use std::ffi::c_void;
use windows::core::{Interface, GUID};
use windows::Win32::Media::DirectShow::{
    IAMStreamConfig, IBaseFilter, ICreateDevEnum, IEnumPins, IPin, PINDIR_OUTPUT,
};
use windows::Win32::Media::MediaFoundation::{AM_MEDIA_TYPE, VIDEOINFOHEADER};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, IEnumMoniker, IMoniker, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};

// Spelled out rather than imported: these three moved namespaces between windows-rs releases, and the
// GUIDs themselves have been fixed since DirectShow shipped.
const CLSID_SYSTEM_DEVICE_ENUM: GUID = GUID::from_u128(0x62BE5D10_60EB_11d0_BD3B_00A0C911CE86);
const CLSID_VIDEO_INPUT_CATEGORY: GUID = GUID::from_u128(0x860BB310_5D01_11d0_BD3B_00A0C911CE86);
const FORMAT_VIDEO_INFO: GUID = GUID::from_u128(0x05589f80_c356_11ce_bf01_00aa0055595a);

/// One capture mode the device really advertises.
pub struct Mode {
    pub width: u32,
    pub height: u32,
    /// The mode's default frame rate (from AvgTimePerFrame).
    pub fps: f64,
    /// Frame-rate range for this resolution — many drivers advertise a span, not one value.
    pub min_fps: f64,
    pub max_fps: f64,
    /// FOURCC as text ("MJPG", "YUY2", "RGB "), for the `cap.set(CAP_PROP_FOURCC)` hint.
    pub fourcc: String,
}

/// Enumerate the modes of the video-capture device at `index` (same ordering as OpenCV's CAP_DSHOW).
pub fn list_modes(index: u32) -> Result<Vec<Mode>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); // see COM note above
        let dev_enum: ICreateDevEnum =
            CoCreateInstance(&CLSID_SYSTEM_DEVICE_ENUM, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance(SystemDeviceEnum): {e}"))?;

        let mut monikers: Option<IEnumMoniker> = None;
        // S_FALSE (with a null out-param) means the category exists but is empty — not an error.
        dev_enum
            .CreateClassEnumerator(&CLSID_VIDEO_INPUT_CATEGORY, &mut monikers, 0)
            .map_err(|e| format!("CreateClassEnumerator: {e}"))?;
        let monikers = monikers.ok_or_else(|| "no video capture devices".to_string())?;

        let mut i = 0u32;
        loop {
            let mut one: [Option<IMoniker>; 1] = [None];
            let mut fetched = 0u32;
            let hr = monikers.Next(&mut one, Some(&mut fetched));
            if hr.is_err() || fetched == 0 {
                return Err(format!("no capture device at index {index}"));
            }
            let moniker = match one[0].take() {
                Some(m) => m,
                None => return Err(format!("null moniker at index {i}")),
            };
            if i == index {
                return modes_of(&moniker);
            }
            i += 1;
        }
    }
}

/// Bind a device moniker to its filter and read the caps off its first capture output pin.
unsafe fn modes_of(moniker: &IMoniker) -> Result<Vec<Mode>, String> {
    // windows-rs exposes BindToObject generically — the interface comes from the binding's type, so
    // it must be annotated (an inferred `!` here is a hard error, not a warning).
    let filter: IBaseFilter = moniker
        .BindToObject(None, None)
        .map_err(|e| format!("BindToObject: {e}"))?;

    let pins: IEnumPins = filter.EnumPins().map_err(|e| format!("EnumPins: {e}"))?;
    loop {
        let mut one: [Option<IPin>; 1] = [None];
        let mut fetched = 0u32;
        let hr = pins.Next(&mut one, Some(&mut fetched));
        if hr.is_err() || fetched == 0 {
            break;
        }
        let pin = match one[0].take() {
            Some(p) => p,
            None => continue,
        };
        // Only an OUTPUT pin carries capture formats; a device may also expose input/upstream pins.
        match pin.QueryDirection() {
            Ok(dir) if dir == PINDIR_OUTPUT => {}
            _ => continue,
        }
        // Not every output pin exposes IAMStreamConfig (a still-image pin often does not) — keep looking.
        if let Ok(cfg) = pin.cast::<IAMStreamConfig>() {
            let modes = caps_of(&cfg)?;
            if !modes.is_empty() {
                return Ok(modes);
            }
        }
    }
    Err("device exposes no output pin with capture formats".into())
}

unsafe fn caps_of(cfg: &IAMStreamConfig) -> Result<Vec<Mode>, String> {
    let mut count = 0i32;
    let mut caps_size = 0i32;
    cfg.GetNumberOfCapabilities(&mut count, &mut caps_size)
        .map_err(|e| format!("GetNumberOfCapabilities: {e}"))?;
    if count <= 0 || caps_size <= 0 {
        return Ok(Vec::new());
    }
    // GetStreamCaps writes caps_size bytes into this buffer (VIDEO_STREAM_CONFIG_CAPS); allocate what
    // the driver asked for rather than assuming our struct matches its build.
    let mut caps = vec![0u8; caps_size as usize];
    let mut out: Vec<Mode> = Vec::new();

    for i in 0..count {
        let mut pmt: *mut AM_MEDIA_TYPE = std::ptr::null_mut();
        if cfg.GetStreamCaps(i, &mut pmt, caps.as_mut_ptr()).is_err() || pmt.is_null() {
            continue;
        }
        let mt = &*pmt;
        if mt.formattype == FORMAT_VIDEO_INFO
            && !mt.pbFormat.is_null()
            && mt.cbFormat as usize >= std::mem::size_of::<VIDEOINFOHEADER>()
        {
            let vih = &*(mt.pbFormat as *const VIDEOINFOHEADER);
            let bi = &vih.bmiHeader;
            // biHeight is negative for a top-down DIB — the magnitude is the real height.
            let (w, h) = (bi.biWidth.unsigned_abs(), bi.biHeight.unsigned_abs());
            let fps = interval_to_fps(vih.AvgTimePerFrame);
            // VIDEO_STREAM_CONFIG_CAPS: Min/MaxFrameInterval sit at a fixed offset; a SHORTER interval
            // is a HIGHER frame rate, so the names inverse-map (MinFrameInterval → max fps).
            let (min_fps, max_fps) = frame_interval_range(&caps).map_or((fps, fps), |(lo, hi)| {
                (interval_to_fps(hi), interval_to_fps(lo))
            });
            if w > 0 && h > 0 {
                out.push(Mode {
                    width: w,
                    height: h,
                    fps,
                    min_fps,
                    max_fps,
                    fourcc: fourcc_of(bi.biCompression),
                });
            }
        }
        free_media_type(pmt);
    }
    Ok(out)
}

/// Pull MinFrameInterval / MaxFrameInterval out of a VIDEO_STREAM_CONFIG_CAPS byte blob.
///
/// Read by OFFSET instead of casting to the struct: the layout is stable and documented, but the
/// driver reports its own `caps_size`, and casting a shorter buffer to our struct would read past it.
fn frame_interval_range(caps: &[u8]) -> Option<(i64, i64)> {
    // guid(16) + VideoStandard(4) + InputSize(8) + MinCroppingSize(8) + MaxCroppingSize(8)
    // + CropGranularityX/Y(8) + CropAlignX/Y(8) + MinOutputSize(8) + MaxOutputSize(8)
    // + OutputGranularityX/Y(8) + StretchTapsX/Y(8) + ShrinkTapsX/Y(8) = 100 bytes of fields —
    // but the next member is a LONGLONG, so the compiler pads to the next 8-byte boundary. Reading at
    // 100 lands on the padding and yields 0, which is how this first shipped a "0–0 fps" range.
    const MIN_INTERVAL_OFFSET: usize = 104;
    let end = MIN_INTERVAL_OFFSET + 16;
    if caps.len() < end {
        return None;
    }
    let lo = i64::from_ne_bytes(caps[MIN_INTERVAL_OFFSET..MIN_INTERVAL_OFFSET + 8].try_into().ok()?);
    let hi = i64::from_ne_bytes(caps[MIN_INTERVAL_OFFSET + 8..end].try_into().ok()?);
    if lo <= 0 || hi <= 0 {
        return None;
    }
    Some((lo, hi))
}

/// 100-ns frame interval → frames per second.
fn interval_to_fps(interval: i64) -> f64 {
    if interval > 0 {
        10_000_000.0 / interval as f64
    } else {
        0.0
    }
}

/// biCompression → a FOURCC string. 0 is BI_RGB (uncompressed), 3 is BI_BITFIELDS; anything else is
/// four packed ASCII bytes ("MJPG", "YUY2", …).
fn fourcc_of(compression: u32) -> String {
    match compression {
        0 => "RGB ".to_string(),
        3 => "BITF".to_string(),
        c => {
            let b = c.to_le_bytes();
            if b.iter().all(|&x| (0x20..=0x7e).contains(&x)) {
                String::from_utf8_lossy(&b).to_string()
            } else {
                String::new()
            }
        }
    }
}

/// Free an AM_MEDIA_TYPE the way DeleteMediaType does: format block, then any attached IUnknown,
/// then the struct itself. Leaking these across a full enumeration is a real leak, not a rounding error.
unsafe fn free_media_type(pmt: *mut AM_MEDIA_TYPE) {
    if pmt.is_null() {
        return;
    }
    let mt = &mut *pmt;
    if !mt.pbFormat.is_null() && mt.cbFormat > 0 {
        CoTaskMemFree(Some(mt.pbFormat as *const c_void));
        mt.pbFormat = std::ptr::null_mut();
        mt.cbFormat = 0;
    }
    // pUnk is an Option<IUnknown> in windows-rs; dropping it releases the reference.
    mt.pUnk = std::mem::zeroed();
    CoTaskMemFree(Some(pmt as *const c_void));
}
