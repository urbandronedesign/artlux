//! Item 2c-2 — MP4 (H.264 / H.265) DECODED BY THE ENGINE: the samples from mp4demux.rs (the app's
//! demux and timestamps), fed to Media Foundation's decoder TRANSFORM directly.
//!
//! Held to the app byte for byte: the codec standards make decoding bit-exact, so the engine's planes must
//! equal what the app's WebCodecs decoder hands back (`VideoFrame.copyTo` over the CODED rect — the
//! encoder's padding rows included, which yuv.rs reads). scripts/test-mp4-parity.cjs compares them.
//!
//! WHY NOT the source reader (tried first): its clock named the wrong frames on WebCodecs-encoded H.264
//! (frames 0 and 1 both at 0 µs), and its frames came back with the padding rows blanked. Fed by hand, the
//! decoder carries OUR timestamps (the app's) through its reordering, and writes the whole coded frame.
//!
//! Frames are asked for BY TIMESTAMP — the app's VideoFrame.timestamp, which the host sends at runtime. The
//! decoder runs forward to it; it is flushed and restarted at the key frame before only for a frame it
//! has passed (or one a GOP ahead). Software decode in system memory for now (a SYNC transform, no D3D
//! device): the planes are the same, and system memory is what the conversion (CPU) reads today.

#![allow(non_upper_case_globals)]   // Media Foundation enum constants, matched as patterns

use crate::mp4demux::{self, Codec, Track};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::mem::ManuallyDrop;
use std::sync::OnceLock;
use windows::core::{Interface, GUID};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};

/// The app matches a decoded frame to a timestamp within 2 µs (mp4Decoder frameExact: the chunk timestamp
/// is a `long long`, the sample time fractional).
const EPS_US: i64 = 2;

/// One decoded frame, laid out as VideoFrame.copyTo({rect: codedRect}) lays NV12 out: Y (coded_h rows), then
/// interleaved UV (coded_h / 2 rows), both at stride = coded width.
pub struct Frame {
    pub coded: (u32, u32),
    pub visible: [u32; 4],
    /// Presentation time, µs — the app's VideoFrame.timestamp for the same frame.
    pub ts_us: i64,
    pub data: Vec<u8>,
}

impl Frame {
    pub fn nv12(&self) -> crate::yuv::Nv12<'_> {
        let w = self.coded.0 as usize;
        let ysize = w * self.coded.1 as usize;
        crate::yuv::Nv12 { coded: self.coded, visible: self.visible, y: &self.data[..ysize], y_stride: w, uv: &self.data[ysize..], uv_stride: w }
    }
}

/// The colour description the decoder read from the stream, in WebCodecs' words — for the report only:
/// what the engine draws is decided on the APP's VideoFrame.colorSpace.
pub struct Colour { pub matrix: &'static str, pub full_range: Option<bool>, pub primaries: &'static str, pub transfer: &'static str }

fn startup() -> Result<(), String> {
    static S: OnceLock<Result<(), String>> = OnceLock::new();
    S.get_or_init(|| unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| format!("Media Foundation: {e}")) }).clone()
}

pub struct Mp4In {
    track: Track,
    file: File,
    mft: IMFTransform,
    out_type: Option<IMFMediaType>,
    coded: (u32, u32),
    visible: [u32; 4],
    stride: usize,
    provides_samples: bool,
    out_size: u32,
    /// The next sample (decode order) to feed.
    next: usize,
    /// Decoded, not yet shown — presentation order (the decoder's output order).
    queue: VecDeque<Frame>,
    last: Option<Frame>,
    drained: bool,
    pub path: String,
}

// Used from one thread at a time (the runtime's render thread owns it); a sync MFT is free-threaded.
unsafe impl Send for Mp4In {}

impl Mp4In {
    pub fn open(path: &str) -> Result<Self, String> {
        let (track, file) = mp4demux::open(path)?;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);   // already initialised (any mode) is fine
            startup()?;
            let sub = match track.codec { Codec::Avc => MFVideoFormat_H264, Codec::Hevc => MFVideoFormat_HEVC };
            let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: sub };
            let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
            let (mut list, mut n) = (std::ptr::null_mut::<Option<IMFActivate>>(), 0u32);
            MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER,
                Some(&input), Some(&output), &mut list, &mut n).map_err(|e| e.to_string())?;
            let acts: Vec<Option<IMFActivate>> = (0..n as usize).map(|k| std::ptr::read(list.add(k))).collect();
            if !list.is_null() { CoTaskMemFree(Some(list as *const _)); }
            let mft: IMFTransform = acts.into_iter().flatten().find_map(|a| a.ActivateObject::<IMFTransform>().ok())
                .ok_or_else(|| format!("{path}: no {:?} decoder on this machine", track.codec))?;
            let t = MFCreateMediaType().map_err(|e| e.to_string())?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            t.SetGUID(&MF_MT_SUBTYPE, &sub).map_err(|e| e.to_string())?;
            t.SetUINT64(&MF_MT_FRAME_SIZE, (track.width as u64) << 32 | track.height as u64).map_err(|e| e.to_string())?;
            t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
            mft.SetInputType(0, &t, 0).map_err(|e| format!("{path}: the decoder refuses this stream: {e}"))?;
            let mut me = Mp4In { track, file, mft, out_type: None, coded: (0, 0), visible: [0; 4], stride: 0, provides_samples: false, out_size: 0,
                next: 0, queue: VecDeque::new(), last: None, drained: false, path: path.to_string() };
            me.set_output()?;
            let _ = me.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
            let _ = me.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
            Ok(me)
        }
    }

    /// Choose the decoder's NV12 output (its own format — no conversion) and read its geometry: coded
    /// size (MF_MT_FRAME_SIZE), visible rect (the minimum display aperture, else the track's size).
    fn set_output(&mut self) -> Result<(), String> {
        unsafe {
            let mut k = 0;
            let t = loop {
                let t = self.mft.GetOutputAvailableType(0, k).map_err(|e| format!("{}: the decoder gives no NV12 (10-bit?): {e}", self.path))?;
                if t.GetGUID(&MF_MT_SUBTYPE).ok() == Some(MFVideoFormat_NV12) { break t; }
                k += 1;
            };
            self.mft.SetOutputType(0, &t, 0).map_err(|e| e.to_string())?;
            let fs = t.GetUINT64(&MF_MT_FRAME_SIZE).map_err(|e| e.to_string())?;
            self.coded = ((fs >> 32) as u32, fs as u32);
            let mut area = MFVideoArea::default();
            let got = t.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, std::slice::from_raw_parts_mut(&mut area as *mut _ as *mut u8, std::mem::size_of::<MFVideoArea>()), None);
            self.visible = if got.is_ok() && area.Area.cx > 0 && area.Area.cy > 0 {
                [area.OffsetX.value.max(0) as u32, area.OffsetY.value.max(0) as u32, area.Area.cx as u32, area.Area.cy as u32]
            } else { [0, 0, self.track.width.min(self.coded.0), self.track.height.min(self.coded.1)] };
            self.stride = t.GetUINT32(&MF_MT_DEFAULT_STRIDE).ok().map(|s| s as i32).filter(|s| *s > 0).map_or(self.coded.0 as usize, |s| s as usize);
            let info = self.mft.GetOutputStreamInfo(0).map_err(|e| e.to_string())?;
            self.provides_samples = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
            self.out_size = info.cbSize.max((self.stride * self.coded.1 as usize * 3 / 2) as u32);
            self.out_type = Some(t);
            Ok(())
        }
    }

    pub fn colour(&self) -> Colour {
        unsafe {
            let get = |g: &GUID| self.out_type.as_ref().and_then(|t| t.GetUINT32(g).ok());
            Colour {
                matrix: match get(&MF_MT_YUV_MATRIX).map(|v| MFVideoTransferMatrix(v as i32)) { Some(MFVideoTransferMatrix_BT709) => "bt709", Some(MFVideoTransferMatrix_BT601) => "smpte170m", Some(MFVideoTransferMatrix_BT2020_10) | Some(MFVideoTransferMatrix_BT2020_12) => "bt2020-ncl", _ => "?" },
                full_range: match get(&MF_MT_VIDEO_NOMINAL_RANGE).map(|v| MFNominalRange(v as i32)) { Some(MFNominalRange_16_235) => Some(false), Some(MFNominalRange_0_255) => Some(true), _ => None },
                primaries: match get(&MF_MT_VIDEO_PRIMARIES).map(|v| MFVideoPrimaries(v as i32)) { Some(MFVideoPrimaries_BT709) => "bt709", Some(MFVideoPrimaries_BT2020) => "bt2020", _ => "?" },
                transfer: match get(&MF_MT_TRANSFER_FUNCTION).map(|v| MFVideoTransferFunction(v as i32)) { Some(MFVideoTransFunc_709) => "bt709", Some(MFVideoTransFunc_sRGB) => "iec61966-2-1", Some(MFVideoTransFunc_2084) => "pq", _ => "?" },
            }
        }
    }

    /// Feed the next sample (or, past the last, drain), then collect what the decoder gives back.
    fn step(&mut self) -> Result<(), String> {
        unsafe {
            if self.next >= self.track.samples.len() {
                let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                let _ = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
                self.pull()?;
                self.drained = true;
                return Ok(());
            }
            let s = &self.track.samples[self.next];
            let mut raw = vec![0u8; s.size as usize];
            self.file.seek(SeekFrom::Start(s.offset)).and_then(|_| self.file.read_exact(&mut raw)).map_err(|e| format!("{}: {e}", self.path))?;
            let data = self.track.annex_b(s, &raw)?;
            let (ts, dur) = (self.track.ts_us(s), self.track.dur_us(s));
            let buf = MFCreateMemoryBuffer(data.len() as u32).map_err(|e| e.to_string())?;
            let mut p = std::ptr::null_mut::<u8>();
            buf.Lock(&mut p, None, None).map_err(|e| e.to_string())?;
            std::ptr::copy_nonoverlapping(data.as_ptr(), p, data.len());
            let _ = buf.Unlock();
            buf.SetCurrentLength(data.len() as u32).map_err(|e| e.to_string())?;
            let sample = MFCreateSample().map_err(|e| e.to_string())?;
            sample.AddBuffer(&buf).map_err(|e| e.to_string())?;
            sample.SetSampleTime(ts * 10).map_err(|e| e.to_string())?;
            sample.SetSampleDuration(dur * 10).map_err(|e| e.to_string())?;
            loop {
                match self.mft.ProcessInput(0, &sample, 0) {
                    Ok(()) => break,
                    Err(e) if e.code() == MF_E_NOTACCEPTING => { if self.pull()? == 0 { return Err(format!("{}: the decoder takes no input and gives no output", self.path)); } }
                    Err(e) => return Err(format!("{}: decode: {e}", self.path)),
                }
            }
            self.next += 1;
            self.pull()?;
            Ok(())
        }
    }

    /// Every frame the decoder has ready, into the queue. Returns how many.
    fn pull(&mut self) -> Result<usize, String> {
        let mut got = 0;
        unsafe {
            loop {
                let mine = if self.provides_samples { None } else {
                    let s = MFCreateSample().map_err(|e| e.to_string())?;
                    s.AddBuffer(&MFCreateMemoryBuffer(self.out_size).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                    Some(s)
                };
                let mut out = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(mine), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
                let mut status = 0u32;
                let r = self.mft.ProcessOutput(0, &mut out, &mut status);
                let sample = ManuallyDrop::take(&mut out[0].pSample);
                drop(ManuallyDrop::take(&mut out[0].pEvents));
                match r {
                    Ok(()) => {
                        let Some(sample) = sample else { continue };
                        let ts100 = sample.GetSampleTime().map_err(|e| e.to_string())?;
                        let f = self.copy(&sample, ts100 / 10)?;
                        if std::env::var_os("ARTLUX_MF_TRACE").is_some() { eprintln!("mf: frame ts {}", f.ts_us); }
                        self.queue.push_back(f);
                        got += 1;
                    }
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(got),
                    Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => self.set_output()?,
                    Err(e) => return Err(format!("{}: decode: {e}", self.path)),
                }
            }
        }
    }

    /// The sample's planes out at stride = coded width (the buffer's own pitch can be wider). The UV plane
    /// follows the Y plane at pitch × coded height.
    unsafe fn copy(&self, sample: &IMFSample, ts_us: i64) -> Result<Frame, String> {
        let (w, h) = (self.coded.0 as usize, self.coded.1 as usize);
        let buf = sample.GetBufferByIndex(0).map_err(|e| e.to_string())?;
        let mut data = vec![0u8; w * h * 3 / 2];
        let mut planes = |base: *const u8, pitch: usize| {
            for row in 0..h + h / 2 {
                data[row * w..row * w + w].copy_from_slice(std::slice::from_raw_parts(base.add(row * pitch), w));
            }
        };
        if let Ok(b2) = buf.cast::<IMF2DBuffer>() {
            let (mut p, mut pitch) = (std::ptr::null_mut::<u8>(), 0i32);
            b2.Lock2D(&mut p, &mut pitch).map_err(|e| e.to_string())?;
            if pitch > 0 { planes(p, pitch as usize); }
            let _ = b2.Unlock2D();
            if pitch <= 0 { return Err("a bottom-up decoder buffer (negative pitch)".into()); }
        } else {
            let (mut p, mut len) = (std::ptr::null_mut::<u8>(), 0u32);
            buf.Lock(&mut p, None, Some(&mut len)).map_err(|e| e.to_string())?;
            let ok = len as usize >= self.stride * (h + h / 2) - (self.stride - w);
            if ok { planes(p, self.stride); }
            let _ = buf.Unlock();
            if !ok { return Err(format!("a decoder buffer of {len} bytes for {w}×{h}")); }
        }
        Ok(Frame { coded: self.coded, visible: self.visible, ts_us, data })
    }

    /// Restart at the key frame (decode order) whose time is the last at or before `ts_us`.
    fn seek(&mut self, ts_us: i64) -> Result<(), String> {
        let s = &self.track.samples;
        let k = (0..s.len()).filter(|&k| s[k].key && self.track.ts_us(&s[k]) <= ts_us + EPS_US).last().unwrap_or(0);
        unsafe {
            self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0).map_err(|e| e.to_string())?;
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        }
        self.next = k;
        self.queue.clear();
        self.last = None;
        self.drained = false;
        Ok(())
    }

    /// The frame on screen at `ts_us`, as the app's decoder answers: the frame AT it (within 2 µs), else the
    /// last one starting before it — or, before the first presentation time, the first frame.
    pub fn frame_at(&mut self, ts_us: i64) -> Result<&Frame, String> {
        let behind = self.last.as_ref().is_some_and(|f| f.ts_us > ts_us + EPS_US);
        // A GOP or more ahead: restarting at its key frame beats decoding everything up to it.
        let s = &self.track.samples;
        let ahead = (self.next..s.len()).find(|&k| s[k].key).is_some_and(|k| k > self.next && self.track.ts_us(&s[k]) <= ts_us + EPS_US);
        if behind || ahead { self.seek(ts_us)?; }
        loop {
            if self.last.as_ref().is_some_and(|f| (f.ts_us - ts_us).abs() <= EPS_US) { break; }
            match self.queue.front() {
                Some(f) if f.ts_us <= ts_us + EPS_US => { self.last = self.queue.pop_front(); }
                Some(_) => { if self.last.is_none() { self.last = self.queue.pop_front(); } break; }
                None if self.drained => break,
                None => self.step()?,
            }
        }
        self.last.as_ref().ok_or_else(|| format!("{}: no frame at {ts_us} µs", self.path))
    }
}
