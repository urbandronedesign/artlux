//! E6a — A BAKE ENCODED BY THE ENGINE: H.264 + AAC into an MP4, through Media Foundation's SINK WRITER
//! (plans/native-engine.md §9, E6: "render non-realtime, encode with Media Foundation hardware encoders").
//!
//! The app's bake encoded in the renderer (mediabunny over WebCodecs — plugins/bake bakeRunner.ts); a frame the
//! ENGINE draws is encoded here instead, so the picture never crosses a process. Same file contract as the app's:
//!   · H.264 High, 4:2:0, a key frame every second (a sparse GOP makes looping and scrubbing the result costly),
//!     NO B-frames — the app's frame-exact reader (mp4Decoder frameExact) walks a GOP forward, and reordering
//!     only makes that walk longer;
//!   · BT.709, LIMITED range, said so in the stream (VUI) and in the media type — what the engine and the app
//!     both draw an MP4 as when it says nothing (mf.rs colour, runtime.rs "unspecified counts as it");
//!   · AAC-LC stereo 48 kHz at 192 kbps, the app's numbers; its PCM is the same offline pull the app encoded.
//!   · timestamps are a FUNCTION OF THE INDEX (round(i·10⁷/fps)), never a running sum — the bake's own rule.
//!
//! The colour is written into the stream's VUI by the encoder from the media types below (measured: NVENC writes
//! BT.709 / limited — `sps_colour` reads it back out of the file). NVENC refuses the ICodecAPI colour properties
//! outright, so they are not set; Media Foundation's DECODER does not report a VUI either (mf.rs colour → "?").
//!
//! RGB → NV12 is done HERE, on the CPU, with the BT.709 limited matrix written out: the sink writer would insert
//! its own colour converter for an RGB input, and which matrix that one uses is the converter's choice — a 601
//! matrix on an HD picture is a hue shift nobody notices until it is on a wall next to the original.
//!
//! The encoder is whatever Media Foundation picks with hardware transforms ENABLED (NVENC / Quick Sync / AMF on
//! a GPU that has one, the Microsoft software encoder otherwise); `encoder()` names it, so a test and the log
//! say which one wrote the file.

#![allow(non_upper_case_globals)]

use windows::core::{Interface, GUID, HSTRING};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

pub const AUDIO_RATE: u32 = 48_000;
pub const AUDIO_CH: u32 = 2;

pub struct Settings { pub w: u32, pub h: u32, pub fps: f64, pub bitrate: u32, pub audio: bool }

pub struct Mp4Out {
    writer: IMFSinkWriter,
    video: u32,
    audio: Option<u32>,
    w: u32,
    h: u32,
    fps: f64,
    frames: u64,
    audio_samples: u64,
    nv12: Vec<u8>,
    encoder: String,
    pub path: String,
}

fn e(what: &str) -> impl Fn(windows::core::Error) -> String + '_ { move |x| format!("{what}: {x}") }

/// The frame rate as Media Foundation wants it: a ratio. 29.97 / 59.94 / 23.976 are the NTSC ones (×1000/1001).
pub fn rate_ratio(fps: f64) -> (u32, u32) {
    let r = fps.round();
    if r > 0.0 && (fps - r).abs() < 1e-6 { return (r as u32, 1); }
    let ntsc = fps * 1.001;
    if (ntsc - ntsc.round()).abs() < 1e-3 { return ((ntsc.round() as u32) * 1000, 1001); }
    ((fps * 1000.0).round() as u32, 1000)
}

/// Frame `i`'s presentation time in 100 ns units — a function of the index.
pub fn frame_time(i: u64, fps: f64) -> i64 { ((i as f64) * 1e7 / fps).round() as i64 }

fn colour(t: &IMFMediaType) -> windows::core::Result<()> {
    unsafe {
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)
    }
}

impl Mp4Out {
    pub fn create(path: &str, s: &Settings) -> Result<Self, String> {
        if s.w < 2 || s.h < 2 || s.w % 2 != 0 || s.h % 2 != 0 { return Err(format!("{}x{}: H.264 needs even dimensions", s.w, s.h)); }
        if !(s.fps > 0.0) { return Err("no frame rate".into()); }
        crate::mf::startup()?;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 4).map_err(e("attributes"))?;
            let attrs = attrs.ok_or("attributes")?;
            // ARTLUX_BAKE_SOFTWARE=1 (tests): the Microsoft software encoder, as on a machine with no hardware one.
            let hw = std::env::var("ARTLUX_BAKE_SOFTWARE").map_or(true, |v| v != "1");
            attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, hw as u32).map_err(e("attributes"))?;
            // Non-realtime: never drop or wait on a clock — the writer takes every sample as fast as it can.
            attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1).map_err(e("attributes"))?;
            attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4).map_err(e("attributes"))?;
            let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path), None, &attrs).map_err(e("the file"))?;
            let (num, den) = rate_ratio(s.fps);

            let out = MFCreateMediaType().map_err(e("media type"))?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(e("video type"))?;
            out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(e("video type"))?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, s.bitrate.max(100_000)).map_err(e("video type"))?;
            out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(e("video type"))?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, (s.w as u64) << 32 | s.h as u64).map_err(e("video type"))?;
            out.SetUINT64(&MF_MT_FRAME_RATE, (num as u64) << 32 | den as u64).map_err(e("video type"))?;
            out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, 1u64 << 32 | 1).map_err(e("video type"))?;
            out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32).map_err(e("video type"))?;
            colour(&out).map_err(e("video colour"))?;
            let video = writer.AddStream(&out).map_err(e("the H.264 stream"))?;

            let inp = MFCreateMediaType().map_err(e("media type"))?;
            inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(e("input type"))?;
            inp.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(e("input type"))?;
            inp.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(e("input type"))?;
            inp.SetUINT64(&MF_MT_FRAME_SIZE, (s.w as u64) << 32 | s.h as u64).map_err(e("input type"))?;
            inp.SetUINT64(&MF_MT_FRAME_RATE, (num as u64) << 32 | den as u64).map_err(e("input type"))?;
            inp.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, 1u64 << 32 | 1).map_err(e("input type"))?;
            inp.SetUINT32(&MF_MT_DEFAULT_STRIDE, s.w).map_err(e("input type"))?;
            colour(&inp).map_err(e("input colour"))?;
            // The GOP, no B-frames and the stream's colour, as ENCODING PARAMETERS (keys are ICodecAPI GUIDs): the
            // writer hands them to the encoder while it is configured, which is when the Microsoft software
            // encoder takes them — set afterwards through ICodecAPI it keeps B-frames (measured: reordered frames,
            // and the decoded index one off at each key frame) and writes no VUI.
            let gop = s.fps.round().max(1.0) as u32;
            let mut enc: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut enc, 6).map_err(e("attributes"))?;
            let enc = enc.ok_or("attributes")?;
            for (g, v) in [(CODECAPI_AVEncMPVGOPSize, gop), (CODECAPI_AVEncMPVDefaultBPictureCount, 0),
                (CODECAPI_AVEncVideoOutputColorPrimaries, eAVEncVideoColorPrimaries_BT709.0 as u32),
                (CODECAPI_AVEncVideoOutputColorTransferFunction, eAVEncVideoColorTransferFunction_22_709.0 as u32),
                (CODECAPI_AVEncVideoOutputColorTransferMatrix, eAVEncVideoColorTransferMatrix_BT709.0 as u32),
                (CODECAPI_AVEncVideoOutputColorNominalRange, eAVEncVideoColorNominalRange_16_235.0 as u32)] {
                enc.SetUINT32(&g, v).map_err(e("attributes"))?;
            }
            writer.SetInputMediaType(video, &inp, &enc).map_err(e("no H.264 encoder takes this picture"))?;

            let mut encoder = String::from("?");
            let mut mft: *mut core::ffi::c_void = std::ptr::null_mut();
            if writer.GetServiceForStream(video, &GUID::zeroed(), &IMFTransform::IID, &mut mft).is_ok() && !mft.is_null() {
                let t = IMFTransform::from_raw(mft);
                if let Ok(a) = t.GetAttributes() {
                    let string = |g: &GUID| -> Option<String> {
                        let (mut p, mut n) = (windows::core::PWSTR::null(), 0u32);
                        a.GetAllocatedString(g, &mut p, &mut n).ok()?;
                        let s = p.to_string().unwrap_or_default();
                        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as _));
                        Some(s)
                    };
                    let hw = string(&MFT_ENUM_HARDWARE_URL_Attribute).is_some();
                    let name = string(&MFT_FRIENDLY_NAME_Attribute);
                    encoder = format!("{}{}", name.unwrap_or_else(|| "Microsoft H.264 encoder".into()), if hw { " (hardware)" } else { " (software)" });
                }
            }

            let audio = if s.audio {
                let ao = MFCreateMediaType().map_err(e("media type"))?;
                ao.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(e("audio type"))?;
                ao.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(e("audio type"))?;
                ao.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(e("audio type"))?;
                ao.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_RATE).map_err(e("audio type"))?;
                ao.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CH).map_err(e("audio type"))?;
                ao.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000).map_err(e("audio type"))?;   // 192 kbps
                let a = writer.AddStream(&ao).map_err(e("the AAC stream"))?;
                let ai = MFCreateMediaType().map_err(e("media type"))?;
                ai.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(e("audio input"))?;
                ai.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(e("audio input"))?;
                ai.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(e("audio input"))?;
                ai.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_RATE).map_err(e("audio input"))?;
                ai.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CH).map_err(e("audio input"))?;
                ai.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2 * AUDIO_CH).map_err(e("audio input"))?;
                ai.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 2 * AUDIO_CH * AUDIO_RATE).map_err(e("audio input"))?;
                writer.SetInputMediaType(a, &ai, None).map_err(e("no AAC encoder takes stereo 48 kHz"))?;
                Some(a)
            } else { None };

            writer.BeginWriting().map_err(e("begin writing"))?;
            Ok(Mp4Out { writer, video, audio, w: s.w, h: s.h, fps: s.fps, frames: 0, audio_samples: 0, nv12: vec![0; (s.w * s.h * 3 / 2) as usize], encoder, path: path.to_string() })
        }
    }

    pub fn encoder(&self) -> &str { &self.encoder }
    pub fn frames(&self) -> u64 { self.frames }
    pub fn audio_samples(&self) -> u64 { self.audio_samples }

    fn write(&self, stream: u32, data: &[u8], time: i64, dur: i64) -> Result<(), String> {
        unsafe {
            let buf = MFCreateMemoryBuffer(data.len() as u32).map_err(e("buffer"))?;
            let mut p: *mut u8 = std::ptr::null_mut();
            buf.Lock(&mut p, None, None).map_err(e("buffer"))?;
            std::ptr::copy_nonoverlapping(data.as_ptr(), p, data.len());
            buf.Unlock().map_err(e("buffer"))?;
            buf.SetCurrentLength(data.len() as u32).map_err(e("buffer"))?;
            let s = MFCreateSample().map_err(e("sample"))?;
            s.AddBuffer(&buf).map_err(e("sample"))?;
            s.SetSampleTime(time).map_err(e("sample"))?;
            s.SetSampleDuration(dur).map_err(e("sample"))?;
            self.writer.WriteSample(stream, &s).map_err(e("encoding"))
        }
    }

    /// The next frame: straight RGBA, top row first, exactly w × h. Laid over BLACK (the app's colour video is the
    /// surface over black — premultiplied: a picture that is already premultiplied passes through unchanged).
    pub fn frame(&mut self, rgba: &[u8], premultiplied: bool) -> Result<(), String> {
        if rgba.len() != (self.w * self.h * 4) as usize { return Err(format!("a {}-byte frame for {}x{}", rgba.len(), self.w, self.h)); }
        let mut nv12 = std::mem::take(&mut self.nv12);
        to_nv12(rgba, self.w as usize, self.h as usize, premultiplied, &mut nv12);
        let (t0, t1) = (frame_time(self.frames, self.fps), frame_time(self.frames + 1, self.fps));
        let r = self.write(self.video, &nv12, t0, t1 - t0);
        self.nv12 = nv12;
        r?;
        self.frames += 1;
        Ok(())
    }

    /// E6c: the next frame ALREADY NV12 (converted on the GPU — bakescale.rs, the same BT.709 limited arithmetic as
    /// `to_nv12`): w × h luma, then the interleaved chroma.
    pub fn frame_nv12(&mut self, nv12: &[u8]) -> Result<(), String> {
        if nv12.len() != (self.w * self.h * 3 / 2) as usize { return Err(format!("a {}-byte NV12 frame for {}x{}", nv12.len(), self.w, self.h)); }
        let (t0, t1) = (frame_time(self.frames, self.fps), frame_time(self.frames + 1, self.fps));
        self.write(self.video, nv12, t0, t1 - t0)?;
        self.frames += 1;
        Ok(())
    }

    /// Interleaved stereo f32 (the offline pull's), appended after what was written so far.
    pub fn audio(&mut self, pcm: &[f32]) -> Result<(), String> {
        let Some(a) = self.audio else { return Ok(()) };
        let n = pcm.len() / AUDIO_CH as usize;
        if n == 0 { return Ok(()); }
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for &x in &pcm[..n * AUDIO_CH as usize] {
            let v = (x.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let t0 = (self.audio_samples as f64 * 1e7 / AUDIO_RATE as f64).round() as i64;
        let t1 = ((self.audio_samples + n as u64) as f64 * 1e7 / AUDIO_RATE as f64).round() as i64;
        self.write(a, &bytes, t0, t1 - t0)?;
        self.audio_samples += n as u64;
        Ok(())
    }

    /// Close the file: the encoder drains, the muxer writes its index. Until this returns the file is not an MP4.
    pub fn finish(self) -> Result<(), String> {
        unsafe { self.writer.Finalize().map_err(e("finalising the file")) }
    }
}

// ── E6b: THE ENCODER ON ITS OWN THREAD ─────────────────────────────────────────────────────────────────────────
// A bake frame on the render thread was draw + read back + ENCODE in series (3.0 + 1.3 + 2.6 ms at 1080p, the
// encode being the RGB → NV12 conversion and the sink writer's copy). The writer below owns the Mp4Out on a thread of
// its own: the render thread hands it each frame's pixels (moved, not copied) and goes on to draw the next. A bounded
// queue (QUEUE frames) holds the render thread back when the encoder falls behind, so memory stays a few frames.
// Order is kept — sound and pictures share the one queue — and an encoder error is reported on the next call.

const QUEUE: usize = 3;
enum Job { Frame(Vec<u8>), Nv12(Vec<u8>), Audio(Vec<f32>) }

pub struct Mp4Writer {
    tx: Option<std::sync::mpsc::SyncSender<Job>>,
    thread: Option<std::thread::JoinHandle<Result<f64, String>>>,
    error: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// Set by a cancel: the thread stops at its next job and never closes the file (a queue still full is dropped).
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    encoder: String,
    frames: u64,
    audio_samples: u64,
    pub path: String,
}

impl Mp4Writer {
    pub fn create(path: &str, s: &Settings) -> Result<Self, String> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Job>(QUEUE);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let error = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (p, st, err, stop) = (path.to_string(), Settings { w: s.w, h: s.h, fps: s.fps, bitrate: s.bitrate, audio: s.audio }, error.clone(), cancel.clone());
        let thread = std::thread::Builder::new().name("bake encoder".into()).spawn(move || -> Result<f64, String> {
            // Made ON this thread, used only here: the sink writer never crosses threads.
            let mut out = match Mp4Out::create(&p, &st) { Ok(o) => { let _ = ready_tx.send(Ok(o.encoder().to_string())); o } Err(e) => { let _ = ready_tx.send(Err(e.clone())); return Err(e); } };
            let mut ms = 0.0;
            while let Ok(job) = rx.recv() {
                if stop.load(std::sync::atomic::Ordering::SeqCst) { return Ok(ms); }
                let t0 = std::time::Instant::now();
                let r = match job { Job::Frame(px) => out.frame(&px, true), Job::Nv12(f) => out.frame_nv12(&f), Job::Audio(pcm) => out.audio(&pcm) };
                ms += t0.elapsed().as_secs_f64() * 1000.0;
                if let Err(e) = r { *err.lock().unwrap() = Some(e.clone()); return Err(e); }
            }
            if stop.load(std::sync::atomic::Ordering::SeqCst) { return Ok(ms); }
            out.finish()?;   // the sender dropped: every frame is in — close the file
            Ok(ms)
        }).map_err(|e| format!("the encoder thread: {e}"))?;
        let encoder = ready_rx.recv().map_err(|_| "the encoder thread ended".to_string())??;
        Ok(Mp4Writer { tx: Some(tx), thread: Some(thread), error, cancel, encoder, frames: 0, audio_samples: 0, path: path.to_string() })
    }
    pub fn encoder(&self) -> &str { &self.encoder }
    pub fn frames(&self) -> u64 { self.frames }
    pub fn audio_samples(&self) -> u64 { self.audio_samples }
    fn send(&mut self, j: Job) -> Result<(), String> {
        if let Some(e) = self.error.lock().unwrap().clone() { return Err(e); }
        self.tx.as_ref().ok_or("the bake is closed")?.send(j).map_err(|_| self.error.lock().unwrap().clone().unwrap_or_else(|| "the encoder stopped".into()))
    }
    /// A frame: w × h RGBA (premultiplied — laid over black), moved to the encoder.
    pub fn frame(&mut self, px: Vec<u8>) -> Result<(), String> { self.send(Job::Frame(px))?; self.frames += 1; Ok(()) }
    /// E6c: a frame converted to NV12 on the GPU.
    pub fn frame_nv12(&mut self, f: Vec<u8>) -> Result<(), String> { self.send(Job::Nv12(f))?; self.frames += 1; Ok(()) }
    pub fn audio(&mut self, pcm: Vec<f32>) -> Result<(), String> { let n = pcm.len() as u64 / AUDIO_CH as u64; self.send(Job::Audio(pcm))?; self.audio_samples += n; Ok(()) }
    /// Every queued frame encoded, the file closed. The encoder's own time in all (ms).
    pub fn finish(mut self) -> Result<f64, String> {
        drop(self.tx.take());
        self.thread.take().map(|t| t.join().map_err(|_| "the encoder thread panicked".to_string())?).unwrap_or(Err("no encoder".into()))
    }
}

impl Drop for Mp4Writer {
    /// Dropped unfinished (a cancel, an error): the encoder stops without closing the file — the caller deletes it.
    fn drop(&mut self) {
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        drop(self.tx.take());
        if let Some(t) = self.thread.take() { let _ = t.join(); }
    }
}

/// Straight (or premultiplied) RGBA over black → NV12, BT.709 limited range. Chroma from the 2×2 block's mean.
/// Rows are split across threads: a 4K frame is 8 M pixels.
pub fn to_nv12(rgba: &[u8], w: usize, h: usize, premultiplied: bool, out: &mut Vec<u8>) {
    out.resize(w * h * 3 / 2, 0);
    let (y_plane, uv_plane) = out.split_at_mut(w * h);
    const KR: f32 = 0.2126; const KB: f32 = 0.0722; const KG: f32 = 1.0 - KR - KB;
    let px = |i: usize| -> [f32; 3] {
        let p = &rgba[i * 4..i * 4 + 4];
        let a = if premultiplied { 1.0 } else { p[3] as f32 / 255.0 };
        [p[0] as f32 / 255.0 * a, p[1] as f32 / 255.0 * a, p[2] as f32 / 255.0 * a]
    };
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 16);
    let pairs = h / 2;
    let per = pairs.div_ceil(threads).max(1);
    std::thread::scope(|sc| {
        for (k, (yc, uvc)) in y_plane.chunks_mut(per * 2 * w).zip(uv_plane.chunks_mut(per * w)).enumerate() {
            sc.spawn(move || {
                let r0 = k * per;
                for (j, uvrow) in uvc.chunks_mut(w).enumerate() {
                    let ry = r0 + j;   // the row pair
                    for x2 in 0..w / 2 {
                        let (mut sb, mut sr) = (0.0f32, 0.0f32);
                        for dy in 0..2 {
                            for dx in 0..2 {
                                let (x, y) = (x2 * 2 + dx, ry * 2 + dy);
                                let [r, g, b] = px(y * w + x);
                                let yl = KR * r + KG * g + KB * b;
                                yc[(j * 2 + dy) * w + x] = (16.0 + 219.0 * yl + 0.5).floor().clamp(0.0, 255.0) as u8;
                                sb += (b - yl) / (2.0 * (1.0 - KB));
                                sr += (r - yl) / (2.0 * (1.0 - KR));
                            }
                        }
                        uvrow[x2 * 2] = (128.0 + 224.0 * sb / 4.0 + 0.5).floor().clamp(0.0, 255.0) as u8;
                        uvrow[x2 * 2 + 1] = (128.0 + 224.0 * sr / 4.0 + 0.5).floor().clamp(0.0, 255.0) as u8;
                    }
                }
            });
        }
    });
}

/// The colour an H.264 stream DECLARES: its SPS's VUI `video_signal_type` — (full range, primaries, transfer,
/// matrix) as the ITU codes (1 = BT.709), or None when the SPS says nothing. Read from the file itself, so the
/// self-test does not depend on what a decoder chooses to report.
pub fn sps_colour(sps: &[u8]) -> Option<(bool, u8, u8, u8)> {
    // RBSP: drop the emulation-prevention bytes (00 00 03).
    let mut b = Vec::with_capacity(sps.len());
    let mut zeros = 0;
    for &x in sps.iter().skip(1) { if zeros >= 2 && x == 3 { zeros = 0; continue; } zeros = if x == 0 { zeros + 1 } else { 0 }; b.push(x); }
    let mut pos = 0usize;
    let mut bit = |n: usize| -> Option<u32> { let mut v = 0u32; for _ in 0..n { let byte = *b.get(pos / 8)?; v = v << 1 | ((byte >> (7 - pos % 8)) & 1) as u32; pos += 1; } Some(v) };
    let ue = |bit: &mut dyn FnMut(usize) -> Option<u32>| -> Option<u32> { let mut z = 0; while bit(1)? == 0 { z += 1; if z > 31 { return None; } } Some((1u32 << z) - 1 + bit(z)?) };
    let profile = bit(8)?; bit(16)?;
    ue(&mut bit)?;
    if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(&profile) {
        if ue(&mut bit)? == 3 { bit(1)?; }
        ue(&mut bit)?; ue(&mut bit)?; bit(1)?;
        if bit(1)? == 1 { return None; }   // scaling matrices: not written by these encoders
    }
    ue(&mut bit)?;
    match ue(&mut bit)? { 0 => { ue(&mut bit)?; } 1 => { bit(1)?; ue(&mut bit)?; ue(&mut bit)?; for _ in 0..ue(&mut bit)? { ue(&mut bit)?; } } _ => {} }
    ue(&mut bit)?; bit(1)?; ue(&mut bit)?; ue(&mut bit)?;
    if bit(1)? == 0 { bit(1)?; }
    bit(1)?;
    if bit(1)? == 1 { for _ in 0..4 { ue(&mut bit)?; } }
    if bit(1)? == 0 { return None; }   // no VUI
    if bit(1)? == 1 && bit(8)? == 255 { bit(32)?; }
    if bit(1)? == 1 { bit(1)?; }
    if bit(1)? == 0 { return None; }   // no video_signal_type
    bit(3)?;
    let full = bit(1)? == 1;
    if bit(1)? == 0 { return Some((full, 2, 2, 2)); }   // 2 = unspecified
    Some((full, bit(8)? as u8, bit(8)? as u8, bit(8)? as u8))
}

/// `--mp4-compare <bake.mp4> <ref.mp4> [--start S]`: every frame of a BAKE held against a REFERENCE (the source film,
/// or another bake) of the same size. For bake frame k at time t (its own timestamp + S seconds) the reference
/// frame on screen at t is j (the last at or before t + 1 ms, as the app's codec answers); the bake frame is
/// compared, on luma and chroma, with reference frames j−1, j and j+1. `off` counts frames closer to a NEIGHBOUR
/// than to j — a frame early or late, which a mean difference alone does not see.
pub fn compare(bake: &str, reference: &str, start_s: f64) -> serde_json::Value {
    let fail = |e: String| serde_json::json!({ "ok": false, "error": e });
    let times = |p: &str| -> Result<Vec<i64>, String> { let (t, _) = crate::mp4demux::open(p)?; let mut v: Vec<i64> = t.samples.iter().map(|s| t.ts_us(s)).collect(); v.sort_unstable(); Ok(v) };
    let (bt, rt) = match (times(bake), times(reference)) { (Ok(a), Ok(b)) => (a, b), (Err(e), _) | (_, Err(e)) => return fail(e) };
    let (mut b, mut r) = match (crate::mf::Mp4In::open(bake), crate::mf::Mp4In::open(reference)) { (Ok(a), Ok(b)) => (a, b), (Err(e), _) | (_, Err(e)) => return fail(e) };
    // Mean absolute difference of the VISIBLE picture, every 2nd pixel: luma, and the chroma pairs.
    let mad = |a: &crate::mf::Frame, c: &crate::mf::Frame| -> Result<(f64, f64), String> {
        let ([_, _, w, h], [_, _, w2, h2]) = (a.visible, c.visible);
        if (w, h) != (w2, h2) { return Err(format!("{w}x{h} against {w2}x{h2}")); }
        let (na, nc) = (a.nv12(), c.nv12());
        let (mut sy, mut n) = (0u64, 0u64);
        for y in (0..h as usize).step_by(2) { for x in (0..w as usize).step_by(2) { sy += na.y[y * na.y_stride + x].abs_diff(nc.y[y * nc.y_stride + x]) as u64; n += 1; } }
        let (mut sc, mut m) = (0u64, 0u64);
        for y in (0..h as usize / 2).step_by(2) { for x in (0..w as usize).step_by(2) { sc += na.uv[y * na.uv_stride + x].abs_diff(nc.uv[y * nc.uv_stride + x]) as u64; m += 1; } }
        Ok((sy as f64 / n.max(1) as f64, sc as f64 / m.max(1) as f64))
    };
    let (mut worst_y, mut worst_c, mut sum_y, mut off, mut offs) = (0.0f64, 0.0f64, 0.0f64, 0u64, Vec::new());
    for (k, &ts) in bt.iter().enumerate() {
        let fa = match b.planes_at(ts) { Ok(f) => f, Err(e) => return fail(format!("bake frame {k}: {e}")) };
        let t = ts + (start_s * 1e6).round() as i64;
        let j = rt.iter().rposition(|&x| x <= t + 1000).unwrap_or(0);
        let mut best = (f64::MAX, 0i64, 0.0);
        let mut at_j = (0.0, 0.0);
        for d in [-1i64, 0, 1] {
            let jj = j as i64 + d;
            if jj < 0 || jj as usize >= rt.len() { continue; }
            let fr = match r.planes_at(rt[jj as usize]) { Ok(f) => f, Err(e) => return fail(format!("reference frame {jj}: {e}")) };
            let (y, c) = match mad(&fa, &fr) { Ok(v) => v, Err(e) => return fail(e) };
            if d == 0 { at_j = (y, c); }
            if y < best.0 { best = (y, d, c); }
        }
        if best.1 != 0 && best.0 < at_j.0 - 0.05 { off += 1; if offs.len() < 8 { offs.push(serde_json::json!({ "frame": k, "nearest": best.1, "madAt": at_j.0, "madNearest": best.0 })); } }
        worst_y = worst_y.max(at_j.0); worst_c = worst_c.max(at_j.1); sum_y += at_j.0;
    }
    serde_json::json!({ "ok": true, "frames": bt.len(), "referenceFrames": rt.len(), "worstLuma": worst_y, "worstChroma": worst_c,
        "meanLuma": sum_y / bt.len().max(1) as f64, "off": off, "offFrames": offs })
}

/// `--encode-selftest`: encode a COUNTER video (each frame's index in 16 black / white blocks, four flat colour
/// patches, a ramp) with a tone, then decode it back with the engine's own decoder (mf.rs) and read every frame:
/// the index each frame carries must be its own (no frame dropped, doubled or reordered), every timestamp must be
/// round(i · 10⁶ / fps) µs, and the patches must come back within a compression's error of what went in.
pub fn selftest(path: &str, w: u32, h: u32, fps: f64, frames: u64) -> serde_json::Value {
    let fail = |e: String| serde_json::json!({ "ok": false, "error": e });
    let t0 = std::time::Instant::now();
    let mut out = match Mp4Out::create(path, &Settings { w, h, fps, bitrate: 8_000_000, audio: true }) { Ok(o) => o, Err(e) => return fail(e) };
    let (wu, hu) = (w as usize, h as usize);
    let band = hu / 8;
    let patches: [[u8; 3]; 4] = [[220, 40, 40], [40, 200, 60], [50, 60, 220], [128, 128, 128]];
    let picture = |i: u64| -> Vec<u8> {
        let mut px = vec![0u8; wu * hu * 4];
        for y in 0..hu {
            for x in 0..wu {
                let o = (y * wu + x) * 4;
                let c: [u8; 3] = if y < band {
                    if (i >> (x * 16 / wu)) & 1 == 1 { [255, 255, 255] } else { [0, 0, 0] }
                } else if y < hu * 5 / 8 { patches[x * 4 / wu] }
                else { let v = (x * 255 / wu.max(1)) as u8; [v, v, v] };
                px[o..o + 3].copy_from_slice(&c); px[o + 3] = 255;
            }
        }
        px
    };
    let samples_at = |i: u64| -> u64 { ((i as f64) * AUDIO_RATE as f64 / fps).round() as u64 };
    let mut cursor = 0u64;
    let mut encode_ms = 0.0;
    for i in 0..frames {
        let px = picture(i);
        let n = samples_at(i + 1) - cursor;
        let pcm: Vec<f32> = (0..n).flat_map(|k| { let t = (cursor + k) as f32 / AUDIO_RATE as f32; let v = 0.25 * (std::f32::consts::TAU * 440.0 * t).sin(); [v, v] }).collect();
        cursor += n;
        let e0 = std::time::Instant::now();
        if let Err(e) = out.audio(&pcm).and_then(|_| out.frame(&px, false)) { return fail(format!("frame {i}: {e}")); }
        encode_ms += e0.elapsed().as_secs_f64() * 1000.0;
    }
    let encoder = out.encoder().to_string();
    let (nf, na) = (out.frames(), out.audio_samples());
    let f0 = std::time::Instant::now();
    if let Err(e) = out.finish() { return fail(e); }
    let finish_ms = f0.elapsed().as_secs_f64() * 1000.0;
    let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let bytes = std::fs::read(path).unwrap_or_default();
    let has_aac = bytes.windows(4).any(|q| q == b"mp4a");

    // Read it back.
    let (track, _) = match crate::mp4demux::open(path) { Ok(t) => t, Err(e) => return fail(format!("demux: {e}")) };
    let mut ts: Vec<i64> = track.samples.iter().map(|s| track.ts_us(s)).collect();
    ts.sort_unstable();
    let ts_wrong = ts.iter().enumerate().filter(|(i, t)| (**t - ((*i as f64) * 1e6 / fps) as i64).abs() > 1).count();
    let b_frames = track.samples.windows(2).filter(|p| p[1].cts < p[0].cts).count();
    let keys = track.samples.iter().filter(|s| s.key).count();
    let vui = track.params.first().and_then(|p| sps_colour(p));
    let mut rx = match crate::mf::Mp4In::open(path) { Ok(r) => r, Err(e) => return fail(format!("decode: {e}")) };
    let c = rx.colour();
    let (mut wrong_index, mut worst) = (Vec::new(), 0i32);
    for (k, &t) in ts.iter().enumerate() {
        let f = match rx.planes_at(t) { Ok(f) => f, Err(e) => return fail(format!("decode frame {k}: {e}")) };
        let pic = crate::yuv::to_picture(&f.nv12());
        let at = |x: usize, y: usize| -> [i32; 3] { let o = (y * pic.w as usize + x) * 4; [pic.rgba[o] as i32, pic.rgba[o + 1] as i32, pic.rgba[o + 2] as i32] };
        let mut idx = 0u64;
        for b in 0..16 { if at((2 * b + 1) * wu / 32, band / 2)[0] > 128 { idx |= 1 << b; } }
        if idx != k as u64 && wrong_index.len() < 8 { wrong_index.push(serde_json::json!([k, idx])); }
        for (q, want) in patches.iter().enumerate() {
            let got = at((2 * q + 1) * wu / 8, hu * 3 / 8);
            for ch in 0..3 { worst = worst.max((got[ch] - want[ch] as i32).abs()); }
        }
    }
    serde_json::json!({
        "ok": true, "encoder": encoder, "frames": nf, "decoded": ts.len(), "audioSamples": na, "expectedAudio": samples_at(frames),
        "aac": has_aac, "bytes": bytes.len(), "timestampsWrong": ts_wrong, "reordered": b_frames, "keyFrames": keys,
        "wrongIndex": wrong_index, "patchWorst": worst,
        "vui": vui.map(|(f, p, t, m)| serde_json::json!({ "fullRange": f, "primaries": p, "transfer": t, "matrix": m })),
        "colour": { "matrix": c.matrix, "fullRange": c.full_range, "primaries": c.primaries, "transfer": c.transfer },
        "encodeMs": encode_ms, "finishMs": finish_ms, "totalMs": total_ms, "size": [w, h], "fps": fps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rates() {
        assert_eq!(rate_ratio(25.0), (25, 1));
        assert_eq!(rate_ratio(29.97), (30000, 1001));
        assert_eq!(rate_ratio(59.94), (60000, 1001));
        assert_eq!(rate_ratio(23.976), (24000, 1001));
        assert_eq!(frame_time(30, 30.0), 10_000_000);
        // A function of the index: frame 1000 of 29.97 is exactly 1000 × 1001/30000 s.
        assert_eq!(frame_time(1000, 30000.0 / 1001.0), 333_666_667);
    }
    #[test]
    fn nv12_levels() {
        let mut out = Vec::new();
        // white, black, red, a half-transparent white (straight) — 2x2 each would mix; use 2x2 of one colour.
        for (c, y, u, v) in [([255u8, 255, 255, 255], 235u8, 128u8, 128u8), ([0, 0, 0, 255], 16, 128, 128), ([255, 0, 0, 255], 63, 102, 240)] {
            let rgba: Vec<u8> = (0..4).flat_map(|_| c).collect();
            to_nv12(&rgba, 2, 2, false, &mut out);
            assert_eq!(&out[..], &[y, y, y, y, u, v], "{c:?}");
        }
        let half: Vec<u8> = (0..4).flat_map(|_| [255u8, 255, 255, 128]).collect();
        to_nv12(&half, 2, 2, false, &mut out);
        assert_eq!(out[0], 126, "straight alpha over black");
        to_nv12(&half, 2, 2, true, &mut out);
        assert_eq!(out[0], 235, "premultiplied passes through");
    }
}
