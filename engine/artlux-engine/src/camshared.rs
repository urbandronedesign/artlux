//! Item 2d — PROBE: can the engine read a camera ANOTHER process holds? Windows' Camera Frame Server lets a
//! WinRT MediaCapture open a device in SharedReadOnly mode: the controlling app keeps the camera and its
//! format, and readers get the same stream. If it works with Chromium as the controller, the app keeps its
//! cameras as today and the engine reads them alongside — no hand-over, no gap when the engine dies.
//! (A plain Media Foundation open is EXCLUSIVE: a second process fails with 0xC00D3704, measured.)

use windows::core::HSTRING;
use windows::Media::Capture::Frames::{MediaFrameReaderStartStatus, MediaFrameSourceKind};
use windows::Media::Capture::{MediaCapture, MediaCaptureInitializationSettings, MediaCaptureMemoryPreference, MediaCaptureSharingMode, StreamingCaptureMode};

/// Open `link` shared, read for `secs`, report: (frames, the format the controller set).
pub fn probe(link: &str, secs: f64) -> Result<(u64, String), String> {
    fn e(w: &'static str) -> impl Fn(windows::core::Error) -> String { move |x| format!("{w}: {x}") }
    let s = MediaCaptureInitializationSettings::new().map_err(e("settings"))?;
    s.SetVideoDeviceId(&HSTRING::from(link)).map_err(e("device id"))?;
    s.SetStreamingCaptureMode(StreamingCaptureMode::Video).map_err(e("mode"))?;
    s.SetSharingMode(MediaCaptureSharingMode::SharedReadOnly).map_err(e("sharing"))?;
    s.SetMemoryPreference(MediaCaptureMemoryPreference::Cpu).map_err(e("memory"))?;
    let mc = MediaCapture::new().map_err(e("MediaCapture"))?;
    mc.InitializeWithSettingsAsync(&s).map_err(e("initialize"))?.join().map_err(e("initialize (shared)"))?;
    let sources = mc.FrameSources().map_err(e("sources"))?;
    let mut src = None;
    for kv in sources { let v = kv.Value().map_err(e("source"))?; if v.Info().and_then(|i| i.SourceKind()).ok() == Some(MediaFrameSourceKind::Color) { src = Some(v); break; } }
    let src = src.ok_or("no colour source")?;
    let fmt = src.CurrentFormat().ok().map(|f| {
        let vf = f.VideoFormat().ok();
        format!("{} {}x{} @ {}/{}", f.Subtype().map(|s| s.to_string()).unwrap_or_default(),
            vf.as_ref().and_then(|v| v.Width().ok()).unwrap_or(0), vf.as_ref().and_then(|v| v.Height().ok()).unwrap_or(0),
            f.FrameRate().and_then(|r| r.Numerator()).unwrap_or(0), f.FrameRate().and_then(|r| r.Denominator()).unwrap_or(0))
    }).unwrap_or_default();
    let reader = mc.CreateFrameReaderAsync(&src).map_err(e("reader"))?.join().map_err(e("reader"))?;
    let st = reader.StartAsync().map_err(e("start"))?.join().map_err(e("start"))?;
    if st != MediaFrameReaderStartStatus::Success { return Err(format!("start: {st:?}")); }
    let (mut frames, mut last) = (0u64, None::<i64>);
    let until = std::time::Instant::now() + std::time::Duration::from_secs_f64(secs);
    while std::time::Instant::now() < until {
        if let Ok(f) = reader.TryAcquireLatestFrame() {
            let t = f.SystemRelativeTime().ok().and_then(|r| r.Value().ok()).map(|d| d.Duration);
            if t.is_some() && t != last { frames += 1; last = t; }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let _ = reader.StopAsync().map(|a| a.join());
    Ok((frames, fmt))
}
