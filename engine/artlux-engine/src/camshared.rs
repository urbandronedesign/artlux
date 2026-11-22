//! Item 2d — the engine reads a camera ANOTHER process holds. Windows' Camera Frame Server lets a WinRT
//! MediaCapture open a device in SharedReadOnly mode: the controlling app keeps the camera and its format,
//! and readers get the same stream. With Chromium (the app's getUserMedia) as the controller, the app keeps
//! its cameras exactly as today and the engine reads them alongside — no hand-over, and no camera gap when
//! the engine dies. (A plain Media Foundation open is EXCLUSIVE: a second process fails with 0xC00D3704,
//! measured — so `cam.rs`'s own reader is for a camera nobody else holds, and this is the runtime path.)
//! Owner's decision, 2026-11-22: "the app keeps its cameras, the engine reads them shared".
//!
//! Frames always come out as NV12, whatever the controller chose: the frame reader converts (an MJPEG stream
//! — what Chromium picks for a 720p UVC webcam — is decoded by Windows' own decoder, once more than in the
//! app). One GPU conversion path in the engine, and the picture is a tolerance against the app's, never
//! byte-identical (two JPEG decoders).

use crate::cam::{Format, Raw};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use windows::core::{Interface, HSTRING};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Imaging::BitmapBufferAccessMode;
use windows::Media::Capture::Frames::{MediaFrameArrivedEventArgs, MediaFrameReader, MediaFrameReaderStartStatus, MediaFrameSourceKind};
use windows::Media::Capture::{MediaCapture, MediaCaptureFailedEventHandler, MediaCaptureInitializationSettings, MediaCaptureMemoryPreference, MediaCaptureSharingMode, StreamingCaptureMode};
use windows::Win32::System::WinRT::{IBufferByteAccess, IMemoryBufferByteAccess};

fn e(w: &'static str) -> impl Fn(windows::core::Error) -> String { move |x| format!("{w}: {x}") }

/// A camera read SHARED: the latest frame (NV12) is kept, as `cam::CamIn` keeps its own.
pub struct SharedIn {
    latest: Arc<Mutex<Option<Raw>>>,
    /// Frames that arrived (a new one each time the count moves).
    pub arrived: Arc<AtomicU64>,
    /// Why the stream stopped, once it has (the controller closing the camera, the device unplugged…).
    pub error: Arc<Mutex<Option<String>>>,
    pub link: String,
    /// The CONTROLLER's format as the source reports it (e.g. "MJPG 1280x720 @ 30/1"); frames are NV12.
    pub controller: String,
    mc: MediaCapture,
    reader: MediaFrameReader,
}

impl Drop for SharedIn {
    fn drop(&mut self) {
        let _ = self.reader.StopAsync().map(|a| a.join());
        let _ = self.reader.Close();
        let _ = self.mc.Close();
    }
}

impl SharedIn {
    /// Open `link` (the symbolic link `cam::list` gives) shared. Fails when Windows refuses a shared read —
    /// the caller retries later, as it does an NDI source that is not there yet.
    pub fn open(link: &str) -> Result<Self, String> {
        let s = MediaCaptureInitializationSettings::new().map_err(e("settings"))?;
        s.SetVideoDeviceId(&HSTRING::from(link)).map_err(e("device id"))?;
        s.SetStreamingCaptureMode(StreamingCaptureMode::Video).map_err(e("mode"))?;
        s.SetSharingMode(MediaCaptureSharingMode::SharedReadOnly).map_err(e("sharing"))?;
        s.SetMemoryPreference(MediaCaptureMemoryPreference::Cpu).map_err(e("memory"))?;
        let mc = MediaCapture::new().map_err(e("MediaCapture"))?;
        mc.InitializeWithSettingsAsync(&s).map_err(e("initialize"))?.join().map_err(e("initialize (shared)"))?;
        let mut src = None;
        for kv in mc.FrameSources().map_err(e("sources"))? {
            let v = kv.Value().map_err(e("source"))?;
            if v.Info().and_then(|i| i.SourceKind()).ok() == Some(MediaFrameSourceKind::Color) { src = Some(v); break; }
        }
        let src = src.ok_or("no colour source")?;
        let fps_of = |f: &windows::Media::Capture::Frames::MediaFrameFormat| f.FrameRate().ok().map(|r| (r.Numerator().unwrap_or(0), r.Denominator().unwrap_or(1).max(1))).unwrap_or((0, 1));
        let cur = src.CurrentFormat().map_err(e("format"))?;
        let fps = fps_of(&cur);
        let controller = {
            let vf = cur.VideoFormat().ok();
            format!("{} {}x{} @ {}/{}", cur.Subtype().map(|s| s.to_string()).unwrap_or_default(),
                vf.as_ref().and_then(|v| v.Width().ok()).unwrap_or(0), vf.as_ref().and_then(|v| v.Height().ok()).unwrap_or(0), fps.0, fps.1)
        };
        let latest = Arc::new(Mutex::new(None::<Raw>));
        let arrived = Arc::new(AtomicU64::new(0));
        let error = Arc::new(Mutex::new(None::<String>));
        {
            let er = error.clone();
            mc.Failed(&MediaCaptureFailedEventHandler::new(move |_, a| {
                let why = a.as_ref().and_then(|a| a.Message().ok()).map(|m| m.to_string()).unwrap_or_else(|| "the capture failed".into());
                *er.lock().unwrap() = Some(why);
                Ok(())
            })).map_err(e("failed handler"))?;
        }
        // NV12 first: Windows converts a YUY2 or NV12 controller's stream for us. Beside an MJPEG controller it
        // REFUSES every conversion (OutputFormatNotSupported, measured for NV12/YUY2/BGRA8/ARGB32/RGB32) and
        // only the MJPEG itself can be read — so then the compressed frames are taken as they are.
        let mut reader = None;
        for mjpg in [false, true] {
            let sub = if mjpg { HSTRING::from("MJPG") } else { windows::Media::MediaProperties::MediaEncodingSubtypes::Nv12().map_err(e("NV12"))? };
            let r = mc.CreateFrameReaderWithSubtypeAsync(&src, &sub).map_err(e("reader"))?.join().map_err(e("reader"))?;
            let (l, a, er) = (latest.clone(), arrived.clone(), error.clone());
            r.FrameArrived(&TypedEventHandler::<MediaFrameReader, MediaFrameArrivedEventArgs>::new(move |r, _| {
                let Some(r) = r.as_ref() else { return Ok(()) };
                let Ok(f) = r.TryAcquireLatestFrame() else { return Ok(()) };
                let ts = f.SystemRelativeTime().ok().and_then(|t| t.Value().ok()).map(|d| d.Duration).unwrap_or(0);
                match if mjpg { copy_mjpg(&f, fps) } else { copy_nv12(&f, fps) } {
                    Ok(raw) => {
                        let seq = a.fetch_add(1, Ordering::SeqCst) + 1;
                        *l.lock().unwrap() = Some(Raw { seq, ts100: ts, ..raw });
                    }
                    Err(x) => { er.lock().unwrap().get_or_insert(x); }
                }
                Ok(())
            })).map_err(e("frame handler"))?;
            let st = r.StartAsync().map_err(e("start"))?.join().map_err(e("start"))?;
            if st == MediaFrameReaderStartStatus::Success { reader = Some(r); break; }
            let _ = r.Close();
            if mjpg || st != MediaFrameReaderStartStatus::OutputFormatNotSupported || !controller.starts_with("MJPG") {
                return Err(format!("start: {st:?} (the controller's format: {controller})"));
            }
        }
        let reader = reader.ok_or("no reader")?;
        Ok(SharedIn { latest, arrived, error, link: link.to_string(), controller, mc, reader })
    }

    /// The latest frame (its sequence number tells a new one), or None before the first.
    pub fn latest(&self) -> Option<(u64, std::sync::MutexGuard<'_, Option<Raw>>)> {
        let g = self.latest.lock().unwrap();
        let seq = g.as_ref()?.seq;
        Some((seq, g))
    }
}

/// One MJPEG frame, compressed, as the controller's camera sent it (decoded later, like `cam.rs`'s own MJPEG).
fn copy_mjpg(f: &windows::Media::Capture::Frames::MediaFrameReference, fps: (u32, u32)) -> Result<Raw, String> {
    let fmt = f.Format().map_err(e("format"))?;
    let vf = fmt.VideoFormat().map_err(e("video format"))?;
    let (w, h) = (vf.Width().map_err(e("width"))?, vf.Height().map_err(e("height"))?);
    let b = f.BufferMediaFrame().and_then(|b| b.Buffer()).map_err(e("MJPEG buffer"))?;
    let n = b.Length().map_err(e("length"))? as usize;
    let access: IBufferByteAccess = b.cast().map_err(e("byte access"))?;
    let p = unsafe { access.Buffer().map_err(e("bytes"))? };
    let data = unsafe { std::slice::from_raw_parts(p, n) }.to_vec();
    Ok(Raw { format: Format { subtype: "MJPG", w, h, fps }, pitch: 0, data, seq: 0, ts100: 0 })
}

/// One frame's NV12 planes, copied out of its SoftwareBitmap into `cam::Raw`'s layout: Y rows at `pitch`,
/// then the interleaved UV rows at the same pitch, right after the Y plane.
fn copy_nv12(f: &windows::Media::Capture::Frames::MediaFrameReference, fps: (u32, u32)) -> Result<Raw, String> {
    let bmp = f.VideoMediaFrame().and_then(|v| v.SoftwareBitmap()).map_err(e("bitmap"))?;
    let (w, h) = (bmp.PixelWidth().map_err(e("width"))? as usize, bmp.PixelHeight().map_err(e("height"))? as usize);
    let buf = bmp.LockBuffer(BitmapBufferAccessMode::Read).map_err(e("lock"))?;
    if buf.GetPlaneCount().map_err(e("planes"))? != 2 { return Err("not an NV12 bitmap".into()); }
    let (py, puv) = (buf.GetPlaneDescription(0).map_err(e("plane 0"))?, buf.GetPlaneDescription(1).map_err(e("plane 1"))?);
    let r = buf.CreateReference().map_err(e("reference"))?;
    let access: IMemoryBufferByteAccess = r.cast().map_err(e("byte access"))?;
    let (mut p, mut cap) = (std::ptr::null_mut::<u8>(), 0u32);
    unsafe { access.GetBuffer(&mut p, &mut cap).map_err(e("buffer"))?; }
    let all = unsafe { std::slice::from_raw_parts(p, cap as usize) };
    let pitch = py.Stride as usize;
    let (ch, uvp) = (h.div_ceil(2), puv.Stride as usize);
    let mut data = vec![0u8; pitch * h + pitch * ch];
    let row = |start: i32, stride: usize, k: usize, n: usize| -> Result<&[u8], String> {
        let a = start as usize + k * stride;
        all.get(a..a + n).ok_or_else(|| "a short NV12 frame".to_string())
    };
    for y in 0..h { data[y * pitch..y * pitch + w].copy_from_slice(row(py.StartIndex, pitch, y, w)?); }
    let uvw = w.div_ceil(2) * 2;
    for y in 0..ch { let o = pitch * h + y * pitch; data[o..o + uvw].copy_from_slice(row(puv.StartIndex, uvp, y, uvw)?); }
    drop(r);
    Ok(Raw { format: Format { subtype: "NV12", w: w as u32, h: h as u32, fps }, pitch, data, seq: 0, ts100: 0 })
}
