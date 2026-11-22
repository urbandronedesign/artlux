//! Item 2d, step 1 — CAMERAS READ BY THE ENGINE (Media Foundation), the owner's choice (2026-11-22): the
//! engine opens every camera ONCE and hands the frames back to the app (step 2), because most webcams take
//! one process at a time and the app's three users of a camera (camera surfaces, MediaPipe, calibration) and
//! the engine cannot all open it.
//!
//! - DEVICES are named by their SYMBOLIC LINK (stable per USB port), not their friendly name — two cameras
//!   of the same model have the same name, and a show must reopen "the left one", not "the first found".
//! - A camera is read in one of its NATIVE formats (NV12, YUY2 or MJPEG — no video processor in between),
//!   on its own thread: ReadSample blocks until the next frame, and the render thread takes the latest.
//! - Listing opens each device briefly for its formats; a device another process holds lists without them
//!   (`busy`), and is not opened.
//!
//! Not yet: the conversion on the GPU (the matrix a camera's frames need — BT.601 for most webcams, which
//! yuv.rs does not draw), handing frames to the app, the runtime. DirectShow-only devices (the PS3 Eye's
//! driver) are invisible to Media Foundation and stay the app's.

#![allow(non_upper_case_globals)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use windows::core::{GUID, HSTRING, PWSTR};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};

#[derive(Clone, Debug)]
pub struct Format { pub subtype: &'static str, pub w: u32, pub h: u32, pub fps: (u32, u32) }

#[derive(Clone, Debug)]
pub struct Camera { pub name: String, pub link: String, pub formats: Vec<Format>, pub busy: Option<String> }

fn subtype_name(g: GUID) -> Option<&'static str> {
    if g == MFVideoFormat_NV12 { Some("NV12") } else if g == MFVideoFormat_YUY2 { Some("YUY2") } else if g == MFVideoFormat_MJPG { Some("MJPG") } else { None }
}
fn subtype_guid(n: &str) -> GUID { match n { "NV12" => MFVideoFormat_NV12, "YUY2" => MFVideoFormat_YUY2, _ => MFVideoFormat_MJPG } }

unsafe fn string(a: &IMFActivate, key: &GUID) -> String {
    let (mut p, mut n) = (PWSTR::null(), 0u32);
    if a.GetAllocatedString(key, &mut p, &mut n).is_err() || p.is_null() { return String::new(); }
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as *const _));
    s
}

fn startup() -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| format!("Media Foundation: {e}"))
    }
}

/// The native video formats a reader offers (the ones the engine can read: NV12, YUY2, MJPEG).
unsafe fn native_formats(reader: &IMFSourceReader) -> Vec<Format> {
    let mut out = Vec::new();
    for k in 0.. {
        let Ok(t) = reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, k) else { break };
        let Some(sub) = t.GetGUID(&MF_MT_SUBTYPE).ok().and_then(subtype_name) else { continue };
        let fs = t.GetUINT64(&MF_MT_FRAME_SIZE).unwrap_or(0);
        let fr = t.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or(0);
        out.push(Format { subtype: sub, w: (fs >> 32) as u32, h: fs as u32, fps: ((fr >> 32) as u32, (fr as u32).max(1)) });
    }
    out
}

unsafe fn reader_for(link: &str) -> Result<(IMFMediaSource, IMFSourceReader), String> {
    let mut attrs: Option<IMFAttributes> = None;
    MFCreateAttributes(&mut attrs, 2).map_err(|e| e.to_string())?;
    let attrs = attrs.ok_or("no attributes")?;
    attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID).map_err(|e| e.to_string())?;
    attrs.SetString(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &HSTRING::from(link)).map_err(|e| e.to_string())?;
    let source = MFCreateDeviceSource(&attrs).map_err(|e| format!("open the camera: {e}"))?;
    let reader = MFCreateSourceReaderFromMediaSource(&source, None).map_err(|e| format!("camera reader: {e}"))?;
    Ok((source, reader))
}

/// Every video capture device Media Foundation sees, with its native formats.
pub fn list() -> Result<Vec<Camera>, String> {
    startup()?;
    unsafe {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 1).map_err(|e| e.to_string())?;
        let attrs = attrs.ok_or("no attributes")?;
        attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID).map_err(|e| e.to_string())?;
        let (mut arr, mut n) = (std::ptr::null_mut::<Option<IMFActivate>>(), 0u32);
        MFEnumDeviceSources(&attrs, &mut arr, &mut n).map_err(|e| format!("cameras: {e}"))?;
        let acts: Vec<Option<IMFActivate>> = (0..n as usize).map(|k| std::ptr::read(arr.add(k))).collect();
        if !arr.is_null() { CoTaskMemFree(Some(arr as *const _)); }
        let mut out = Vec::new();
        for a in acts.into_iter().flatten() {
            let name = string(&a, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
            let link = string(&a, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK);
            let (formats, busy) = match reader_for(&link) {
                Ok((source, reader)) => { let f = native_formats(&reader); drop(reader); let _ = source.Shutdown(); (f, None) }
                Err(e) => (Vec::new(), Some(e)),
            };
            out.push(Camera { name, link, formats, busy });
        }
        Ok(out)
    }
}

/// The format to read: the asked one if offered, else the largest picture at the highest rate, NV12 before
/// YUY2 before MJPEG at equal size (an uncompressed format has nothing to decode).
pub fn pick(formats: &[Format], want: Option<(u32, u32)>) -> Option<Format> {
    let rank = |f: &Format| (f.w as u64 * f.h as u64, (f.fps.0 as u64 * 1000) / f.fps.1 as u64, match f.subtype { "NV12" => 2, "YUY2" => 1, _ => 0 });
    let pool: Vec<&Format> = match want { Some((w, h)) => formats.iter().filter(|f| f.w == w && f.h == h).collect(), None => formats.iter().collect() };
    pool.into_iter().max_by_key(|f| rank(f)).cloned()
}

/// One frame as the camera sent it: its format, size, the buffer's row pitch, the bytes, a sequence number.
/// `space`: the YUV colour space of an NV12 / YUY2 frame, as the media type says (none said: BT.601 limited).
pub struct Raw { pub format: Format, pub pitch: usize, pub data: Vec<u8>, pub seq: u64, pub ts100: i64, pub space: crate::yuv::Space }

/// A camera being read on its own thread; the latest frame is kept.
pub struct CamIn { latest: Arc<Mutex<Option<Raw>>>, stop: Arc<AtomicBool>, pub link: String, pub format: Format, pub error: Arc<Mutex<Option<String>>> }

impl Drop for CamIn { fn drop(&mut self) { self.stop.store(true, Ordering::SeqCst); } }

impl CamIn {
    pub fn open(link: &str, format: Format) -> Result<Self, String> {
        startup()?;
        let latest = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let (l, st, er, ln, fmt) = (latest.clone(), stop.clone(), error.clone(), link.to_string(), format.clone());
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new().name("camera".into()).spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let opened = (|| -> Result<(IMFMediaSource, IMFSourceReader), String> {
                let (source, reader) = reader_for(&ln)?;
                // The native type itself (no conversion): find it again on this reader and select it.
                let mut chosen = None;
                for k in 0.. {
                    let Ok(t) = reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, k) else { break };
                    let fs = t.GetUINT64(&MF_MT_FRAME_SIZE).unwrap_or(0);
                    let fr = t.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or(0);
                    if t.GetGUID(&MF_MT_SUBTYPE).ok() == Some(subtype_guid(fmt.subtype)) && (fs >> 32) as u32 == fmt.w && fs as u32 == fmt.h
                        && ((fr >> 32) as u32, (fr as u32).max(1)) == fmt.fps { chosen = Some(t); break; }
                }
                let t = chosen.ok_or("the camera no longer offers that format")?;
                reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &t).map_err(|e| format!("select the format: {e}"))?;
                Ok((source, reader))
            })();
            let (source, reader) = match opened { Ok(x) => { let _ = tx.send(Ok(())); x } Err(e) => { let _ = tx.send(Err(e)); return } };
            let mut seq = 0u64;
            while !st.load(Ordering::SeqCst) {
                let (mut flags, mut ts, mut sample) = (0u32, 0i64, None::<IMFSample>);
                if let Err(e) = reader.ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample)) {
                    *er.lock().unwrap() = Some(format!("read: {e}")); break;
                }
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 || flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 { *er.lock().unwrap() = Some("the camera stopped".into()); break; }
                let Some(sample) = sample else { continue };
                let Ok(buf) = sample.ConvertToContiguousBuffer() else { continue };
                let (mut p, mut len) = (std::ptr::null_mut::<u8>(), 0u32);
                if buf.Lock(&mut p, None, Some(&mut len)).is_err() { continue; }
                let data = std::slice::from_raw_parts(p, len as usize).to_vec();
                let _ = buf.Unlock();
                let pitch = match fmt.subtype { "YUY2" => fmt.w as usize * 2, "NV12" => fmt.w as usize, _ => 0 };
                seq += 1;
                *l.lock().unwrap() = Some(Raw { format: fmt.clone(), pitch, data, seq, ts100: ts, space: crate::yuv::Space::BT601_LIMITED });
            }
            drop(reader);
            let _ = source.Shutdown();
        }).map_err(|e| e.to_string())?;
        rx.recv().map_err(|_| "the camera thread died".to_string())??;
        Ok(CamIn { latest, stop, link: link.to_string(), format, error })
    }

    /// The latest frame (its sequence number tells a new one), or None before the first.
    pub fn latest(&self) -> Option<(u64, std::sync::MutexGuard<'_, Option<Raw>>)> {
        let g = self.latest.lock().unwrap();
        let seq = g.as_ref()?.seq;
        Some((seq, g))
    }
}

/// A PREVIEW of a frame as RGBA, on the CPU (BT.601 limited for NV12 / YUY2; MJPEG through the `image`
/// crate) — for looking at what a camera sends, not the conversion the engine will draw with.
pub fn preview_rgba(r: &Raw) -> Result<(u32, u32, Vec<u8>), String> {
    let (w, h) = (r.format.w as usize, r.format.h as usize);
    let px = |y: f64, u: f64, v: f64| -> [u8; 4] {
        let l = (y - 16.0) * 1.164;
        let (u, v) = (u - 128.0, v - 128.0);
        [(l + 1.596 * v).round().clamp(0.0, 255.0) as u8, (l - 0.392 * u - 0.813 * v).round().clamp(0.0, 255.0) as u8, (l + 2.017 * u).round().clamp(0.0, 255.0) as u8, 255]
    };
    let mut out = vec![0u8; w * h * 4];
    match r.format.subtype {
        "YUY2" => {
            if r.data.len() < w * h * 2 { return Err("a short YUY2 frame".into()); }
            for y in 0..h { for x in 0..w {
                let b = y * r.pitch + (x & !1) * 2;
                let (yy, u, v) = (r.data[b + (x & 1) * 2], r.data[b + 1], r.data[b + 3]);
                out[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&px(yy as f64, u as f64, v as f64));
            } }
        }
        "NV12" => {
            let pp = r.pitch.max(w);
            if r.data.len() < pp * h * 3 / 2 { return Err("a short NV12 frame".into()); }
            for y in 0..h { for x in 0..w {
                let c = pp * h + (y / 2) * pp + (x & !1);
                out[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&px(r.data[y * pp + x] as f64, r.data[c] as f64, r.data[c + 1] as f64));
            } }
        }
        _ => {
            let img = image::load_from_memory_with_format(&r.data, image::ImageFormat::Jpeg).map_err(|e| format!("MJPEG: {e}"))?.to_rgba8();
            return Ok((img.width(), img.height(), img.into_raw()));
        }
    }
    Ok((w as u32, h as u32, out))
}

/// A frame → the picture the engine draws (item 2d step 3), held to the APP's picture of the same frame:
/// `app` is the colour space of the app's own camera VideoFrame (Chromium labels the C270 BT.601 limited).
///
/// MEASURED (scripts/test-camera-shared.cjs, frames paired by content — Chromium stamps an image one frame
/// later than Windows does): beside Chromium the shared reader gets FULL-range NV12 while the app's I420 of
/// the same frame is LIMITED, and that I420 is EXACTLY the full frame compressed to limited range:
///   - Y' = ((Y × 3517 + b) >> 12) + 16, a 12-bit fixed-point scale (b anywhere in 2035..2054 fits all 256
///     values; plain round(16 + Y × 219/255) misses 7 of them);
///   - C' = round(128 + (C − 128) × 224/255), every value.
/// So a full-range frame drawn for a limited-range app is requantised that way first, then converted like the
/// app's: 99.99% of channels identical, max 1 (the float residue MP4 has too). Converted directly from full
/// range instead: ~60% identical, max 2 on one run and max 8 on another — not the app's picture.
///
/// NV12 is converted on the GPU; MJPEG (beside an MJPEG holder) is decoded on the CPU — JPEG is full-range
/// BT.601 by definition — and NOT yet measured against Chromium's MJPEG decode.
pub fn picture(gpu: &crate::Gpu, conv: &crate::yuv::GpuConvert, r: &Raw, app: crate::yuv::Space) -> Result<crate::compose::Picture, String> {
    let (w, h) = (r.format.w, r.format.h);
    match r.format.subtype {
        "NV12" => {
            let (p, hh) = (r.pitch, h as usize);
            if p < w as usize || r.data.len() < p * hh + p * hh.div_ceil(2) { return Err("a short NV12 frame".into()); }
            let requant = r.space.full_range && !app.full_range;
            let data: std::borrow::Cow<[u8]> = if requant { std::borrow::Cow::Owned(to_limited(&r.data, p * hh)) } else { std::borrow::Cow::Borrowed(&r.data) };
            let space = if requant { crate::yuv::Space { bt709: r.space.bt709, full_range: false } } else { r.space };
            let f = crate::yuv::Nv12 { coded: (w, h), visible: [0, 0, w, h], y: &data[..p * hh], y_stride: p, uv: &data[p * hh..], uv_stride: p };
            Ok(conv.picture_in(gpu, &f, space))
        }
        "MJPG" => {
            let img = image::load_from_memory_with_format(&r.data, image::ImageFormat::Jpeg).map_err(|e| format!("MJPEG: {e}"))?.to_rgba8();
            let (iw, ih) = (img.width(), img.height());
            Ok(crate::compose::Picture::coded_frame(iw, ih, img.into_raw(), [0, 0, iw, ih]))
        }
        other => Err(format!("a {other} camera frame (the shared reader gives NV12 or MJPEG)")),
    }
}

/// Full-range NV12 → limited, as the app's frame was made (see `picture`): `luma` bytes of Y, then chroma.
pub fn to_limited(data: &[u8], luma: usize) -> Vec<u8> {
    let ly: [u8; 256] = std::array::from_fn(|v| (((v as u32 * 3517 + 2048) >> 12) + 16) as u8);
    let lc: [u8; 256] = std::array::from_fn(|v| (128.0 + (v as f64 - 128.0) * 224.0 / 255.0).round() as u8);
    data.iter().enumerate().map(|(i, &v)| if i < luma { ly[v as usize] } else { lc[v as usize] }).collect()
}

/// Item 2d step 4 — the app's fingerprint of a frame (src/renderer/engine/cameraFingerprint.ts), computed
/// from an engine frame: the mean Y of a 16 × 9 grid over the picture, in the APP's range (a full-range frame
/// is requantised exactly as the app's frame was made — see `picture`). For MJPEG, from the decoded RGB in
/// BT.601 limited (close, not exact: only used to tell cameras apart).
pub const FP_COLS: usize = 16;
pub const FP_ROWS: usize = 9;
pub fn fingerprint(r: &Raw, app: crate::yuv::Space) -> Option<Vec<u8>> {
    let (w, h) = (r.format.w as usize, r.format.h as usize);
    let (y, stride): (std::borrow::Cow<[u8]>, usize) = match r.format.subtype {
        "NV12" if r.data.len() >= r.pitch * h => {
            let luma = &r.data[..r.pitch * h];
            if r.space.full_range && !app.full_range { (std::borrow::Cow::Owned(to_limited(luma, luma.len())), r.pitch) } else { (std::borrow::Cow::Borrowed(luma), r.pitch) }
        }
        "MJPG" => {
            let img = image::load_from_memory_with_format(&r.data, image::ImageFormat::Jpeg).ok()?.to_rgb8();
            let px: Vec<u8> = img.pixels().map(|p| (16.0 + (65.481 * p[0] as f64 + 128.553 * p[1] as f64 + 24.966 * p[2] as f64) / 255.0).round() as u8).collect();
            (std::borrow::Cow::Owned(px), img.width() as usize)
        }
        _ => return None,
    };
    let mut out = Vec::with_capacity(FP_COLS * FP_ROWS);
    for row in 0..FP_ROWS {
        let (y0, y1) = (row * h / FP_ROWS, (row + 1) * h / FP_ROWS);
        for col in 0..FP_COLS {
            let (x0, x1) = (col * w / FP_COLS, (col + 1) * w / FP_COLS);
            let mut sum = 0u64;
            for yy in y0..y1 { for xx in x0..x1 { sum += y[yy * stride + xx] as u64; } }
            // JS Math.round: half up.
            out.push(((sum as f64 / ((y1 - y0) * (x1 - x0)).max(1) as f64) + 0.5).floor() as u8);
        }
    }
    Some(out)
}

/// How alike two fingerprints are: their correlation (Pearson), 1 = the same picture. A correlation, not a
/// distance: the app's fingerprint is taken moments before the engine reads, and a camera's auto exposure
/// moves the whole picture meanwhile (MEASURED: a mean distance of 1.7–4.0 levels for the same camera,
/// against a limit that had to stay small to tell cameras apart). Gain and offset do not move a correlation.
/// A flat picture (a black stage) has none to give: 0, so it can never decide between cameras.
pub fn fp_likeness(a: &[u8], b: &[u8]) -> f64 {
    let n = a.len().min(b.len()) as f64;
    if n == 0.0 { return 0.0; }
    let (ma, mb) = (a.iter().map(|&v| v as f64).sum::<f64>() / n, b.iter().map(|&v| v as f64).sum::<f64>() / n);
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) { let (dx, dy) = (*x as f64 - ma, *y as f64 - mb); sab += dx * dy; saa += dx * dx; sbb += dy * dy; }
    if saa < 1.0 || sbb < 1.0 { 0.0 } else { sab / (saa * sbb).sqrt() }
}

/// "<name> (<vid>:<pid>)" → its parts (the app's track label; cameraFingerprint.ts splitCameraLabel).
pub fn split_label(label: &str) -> (String, Option<(String, String)>) {
    let t = label.trim();
    if let Some(open) = t.rfind(" (") {
        let ids = &t[open + 2..];
        if ids.len() == 10 && ids.ends_with(')') && ids.as_bytes()[4] == b':' && ids[..4].chars().chain(ids[5..9].chars()).all(|c| c.is_ascii_hexdigit()) {
            return (t[..open].to_string(), Some((ids[..4].to_ascii_lowercase(), ids[5..9].to_ascii_lowercase())));
        }
    }
    (t.to_string(), None)
}

/// Which of the engine's cameras is the app's camera `label`, its picture `fp` (the app's fingerprint) when
/// there is one. Name + vid:pid decide when one camera matches; several identical ones are told apart by
/// picture: each is read SHARED, and the most alike wins only if it is alike (correlation ≥ FP_ALIKE) and
/// clearly more so than the next (by ≥ FP_MARGIN). Returns the link and how it was decided, or why not.
/// MEASURED on the C270 (a low-texture scene: a wall and two plugs): the same camera 0.86–0.97 with the
/// app's fingerprint up to ~8 s old, the same camera rotated 180° −0.7 to −0.8.
pub const FP_ALIKE: f64 = 0.8;
pub const FP_MARGIN: f64 = 0.2;
pub fn resolve(label: &str, fp: Option<&[u8]>, app: crate::yuv::Space) -> Result<(String, String), String> {
    let (name, ids) = split_label(label);
    let mut cams = list()?;
    // TEST ONLY (scripts/test-camera-shared.cjs, one camera on the bench): ARTLUX_CAM_TWIN=same|flip adds a
    // decoy of the same model, "twin:<link>", that reads the real camera — its picture as is (`same`: two
    // cameras that cannot be told apart) or rotated 180° (`flip`: one looking elsewhere). It exercises the
    // picture rule on real frames; two real identical cameras are still to be tried.
    let twin = std::env::var("ARTLUX_CAM_TWIN").ok();
    if twin.is_some() { if let Some(c) = cams.iter().find(|c| c.name == name).cloned() { cams.push(Camera { link: format!("twin:{}", c.link), ..c }); } }
    let matches: Vec<&Camera> = cams.iter().filter(|c| c.name == name && ids.as_ref().is_none_or(|(v, p)| c.link.to_ascii_lowercase().contains(&format!("vid_{v}&pid_{p}")))).collect();
    // The picture of one candidate, read shared (the app holds the camera), as a fingerprint.
    let read_fp = |link: &str| -> Option<Vec<u8>> {
        let (link, flip) = match link.strip_prefix("twin:") { Some(l) => (l, twin.as_deref() == Some("flip")), None => (link, false) };
        let s = crate::camshared::SharedIn::open(link).ok()?;
        let t0 = std::time::Instant::now();
        while t0.elapsed().as_secs_f64() < 3.0 {
            if let Some((seq, g)) = s.latest() { if seq >= 2 { return fingerprint(g.as_ref()?, app).map(|mut f| { if flip { f.reverse(); } f }); } }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        None
    };
    match (matches.len(), fp) {
        (0, _) => Err(format!("\"{label}\" is not a camera the engine can read (Media Foundation does not list it — a DirectShow-only device?)")),
        (1, None) => Ok((matches[0].link.clone(), "the only camera with that name and vid:pid".into())),
        (1, Some(f)) => {
            let d = read_fp(&matches[0].link).map(|e| format!("; picture likeness {:.3}", fp_likeness(f, &e))).unwrap_or_default();
            Ok((matches[0].link.clone(), format!("the only camera with that name and vid:pid{d}")))
        }
        (n, None) => Err(format!("{n} cameras are \"{label}\": the app's picture is needed to tell them apart")),
        (n, Some(f)) => {
            let mut scored: Vec<(f64, &Camera)> = matches.iter().filter_map(|c| read_fp(&c.link).map(|e| (fp_likeness(f, &e), *c))).collect();
            scored.sort_by(|a, b| b.0.total_cmp(&a.0));
            let list = scored.iter().map(|(d, c)| format!("{:.3} {}", d, c.link)).collect::<Vec<_>>().join(", ");
            match scored.as_slice() {
                [(d, c), rest @ ..] if *d >= FP_ALIKE && rest.first().is_none_or(|(d2, _)| d - d2 >= FP_MARGIN) => Ok((c.link.clone(), format!("by picture among {n} \"{name}\": {list}"))),
                _ => Err(format!("{n} cameras are \"{label}\" and the picture does not settle it: {list}")),
            }
        }
    }
}
