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
pub struct Raw { pub format: Format, pub pitch: usize, pub data: Vec<u8>, pub seq: u64, pub ts100: i64 }

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
                *l.lock().unwrap() = Some(Raw { format: fmt.clone(), pitch, data, seq, ts100: ts });
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
            if r.data.len() < w * h * 3 / 2 { return Err("a short NV12 frame".into()); }
            for y in 0..h { for x in 0..w {
                let c = w * h + (y / 2) * w + (x & !1);
                out[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&px(r.data[y * w + x] as f64, r.data[c] as f64, r.data[c + 1] as f64));
            } }
        }
        _ => {
            let img = image::load_from_memory_with_format(&r.data, image::ImageFormat::Jpeg).map_err(|e| format!("MJPEG: {e}"))?.to_rgba8();
            return Ok((img.width(), img.height(), img.into_raw()));
        }
    }
    Ok((w as u32, h as u32, out))
}
