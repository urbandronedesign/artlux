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
//! has passed (or one a GOP ahead).
//!
//! Item 2c-3b — HARDWARE decode. The same transform, given a D3D11 device on the engine's own adapter
//! (MFT_MESSAGE_SET_D3D_MANAGER): it then decodes on the GPU's video block and hands back D3D11 textures.
//! Each frame shown is copied (on the GPU) into ONE shared NV12 texture the engine's D3D12 device also
//! opens, and converted there by yuv.rs GpuConvert — no frame crosses to the CPU. Where the transform
//! refuses the device (a GPU with no decoder for the codec), it decodes in software as before: the same
//! pictures, the CPU path. The decoded pictures are held to the app's by the same gate either way.

#![allow(non_upper_case_globals)]   // Media Foundation enum constants, matched as patterns

use crate::mp4demux::{self, Codec, Track};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::mem::ManuallyDrop;
use std::sync::OnceLock;
use windows::core::{Interface, GUID, PCWSTR};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory4};
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
    /// The planes in system memory (software decode) — empty for a hardware frame.
    pub data: Vec<u8>,
    /// A hardware frame: the decoder's texture (an array) and the slice, kept alive by its sample.
    hw: Option<(ID3D11Texture2D, u32, IMFSample)>,
}

impl Frame {
    pub fn is_hardware(&self) -> bool { self.hw.is_some() }
    pub fn nv12(&self) -> crate::yuv::Nv12<'_> {
        let w = self.coded.0 as usize;
        let ysize = w * self.coded.1 as usize;
        crate::yuv::Nv12 { coded: self.coded, visible: self.visible, y: &self.data[..ysize], y_stride: w, uv: &self.data[ysize..], uv_stride: w }
    }
}

/// The colour description the decoder read from the stream, in WebCodecs' words — for the report only:
/// what the engine draws is decided on the APP's VideoFrame.colorSpace.
#[derive(Clone)]
pub struct Colour { pub matrix: &'static str, pub full_range: Option<bool>, pub primaries: &'static str, pub transfer: &'static str }

pub(crate) fn startup() -> Result<(), String> {
    static S: OnceLock<Result<(), String>> = OnceLock::new();
    S.get_or_init(|| unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| format!("Media Foundation: {e}")) }).clone()
}

pub struct Mp4In {
    track: Track,
    /// The track's first presentation time (µs), found once at open (first_ts).
    first: i64,
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
    /// END_OF_STREAM + DRAIN sent; `drained` once the decoder has given its last frame.
    draining: bool,
    drained: bool,
    /// Hardware decode: the D3D11 device the decoder runs on, and the shared NV12 slot frames are copied into.
    hw: Option<Hw>,
    /// Why this decoder runs in software (None = hardware, or software asked for).
    pub software_why: Option<String>,
    pub path: String,
}

struct Hw {
    dev: ID3D11Device,
    ctx: ID3D11DeviceContext,
    _mgr: IMFDXGIDeviceManager,
    query: ID3D11Query,
    /// The shared NV12 texture (D3D12-created, D3D11-opened) and its wgpu side, made at the first frame.
    slot: Option<(ID3D11Texture2D, wgpu::Texture, (u32, u32))>,
}

/// A D3D11 device with VIDEO support on the adapter the engine's D3D12 device runs on (a shared texture
/// opens only there), multithread-protected (the transform uses it from its own threads).
fn d3d11_for(gpu: &crate::Gpu) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let luid = {
        let hal = unsafe { gpu.device.as_hal::<wgpu::hal::api::Dx12>() }.ok_or("the engine device is not D3D12")?;
        unsafe { hal.raw_device().GetAdapterLuid() }
    };
    unsafe {
        let factory: IDXGIFactory4 = CreateDXGIFactory1().map_err(|e| format!("DXGI factory: {e}"))?;
        let adapter: IDXGIAdapter = factory.EnumAdapterByLuid(luid).map_err(|e| format!("adapter by LUID: {e}"))?;
        let (mut dev, mut ctx) = (None, None);
        D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT, None,
            D3D11_SDK_VERSION, Some(&mut dev), None, Some(&mut ctx)).map_err(|e| format!("D3D11CreateDevice (video): {e}"))?;
        let dev: ID3D11Device = dev.ok_or("no D3D11 device")?;
        if let Ok(mt) = dev.cast::<ID3D11Multithread>() { let _ = mt.SetMultithreadProtected(true); }
        Ok((dev, ctx.ok_or("no D3D11 context")?))
    }
}

/// One NV12 texture both devices see: created by D3D11 (the decoder's side) with an NT shared handle, opened
/// by the engine's D3D12 device and wrapped as wgpu's NV12 texture. (The other way round — created in a
/// D3D12 shared heap, opened by D3D11 — is what the Spout slot does for BGRA; for NV12 D3D11's
/// OpenSharedResource1 REFUSED it, E_INVALIDARG, measured.)
fn nv12_slot(gpu: &crate::Gpu, dev: &ID3D11Device, w: u32, h: u32) -> Result<(ID3D11Texture2D, wgpu::Texture), String> {
    unsafe {
        let desc = D3D11_TEXTURE2D_DESC { Width: w, Height: h, MipLevels: 1, ArraySize: 1, Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 }, Usage: D3D11_USAGE_DEFAULT, BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0, MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED.0) as u32 };
        let mut t = None;
        dev.CreateTexture2D(&desc, None, Some(&mut t)).map_err(|e| format!("NV12 shared texture (D3D11): {e}"))?;
        let t11: ID3D11Texture2D = t.ok_or("no NV12 texture")?;
        let r1: windows::Win32::Graphics::Dxgi::IDXGIResource1 = t11.cast().map_err(|e| e.to_string())?;
        let handle = r1.CreateSharedHandle(None, (windows::Win32::Graphics::Dxgi::DXGI_SHARED_RESOURCE_READ | windows::Win32::Graphics::Dxgi::DXGI_SHARED_RESOURCE_WRITE).0, PCWSTR::null())
            .map_err(|e| format!("CreateSharedHandle (NV12): {e}"))?;
        let hal = gpu.device.as_hal::<wgpu::hal::api::Dx12>().ok_or("the engine device is not D3D12")?;
        let mut res: Option<ID3D12Resource> = None;
        let opened = hal.raw_device().OpenSharedHandle(handle, &mut res);
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        opened.map_err(|e| format!("D3D12 opens the NV12 slot: {e}"))?;
        let res = res.ok_or("no NV12 resource")?;
        let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
        let ht = wgpu::hal::dx12::Device::texture_from_raw(res, wgpu::TextureFormat::NV12, wgpu::TextureDimension::D2, size, 1, 1);
        drop(hal);
        let tex = gpu.device.create_texture_from_hal::<wgpu::hal::api::Dx12>(ht, &wgpu::TextureDescriptor {
            label: Some("mp4 nv12 (shared)"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::NV12, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
        }, wgpu::wgt::TextureUses::UNINITIALIZED);
        Ok((t11, tex))
    }
}

/// SOFTWARE frames only: the padding past the visible picture, made deterministic. Media Foundation's
/// software decoder leaves it UNWRITTEN on some frames (measured: the same frame, three runs — all eight
/// padding rows and their chroma differed on one, the visible picture identical every time), and the
/// conversion reads it at the last visible row and column. Filled with the edge, repeated — what most
/// encoders put there. (A hardware frame keeps the decoder's own padding: it is the app's, byte for byte.)
fn replicate_padding(data: &mut [u8], coded: (u32, u32), visible: [u32; 4]) {
    let (w, h) = (coded.0 as usize, coded.1 as usize);
    let (vx, vy, vw, vh) = (visible[0] as usize, visible[1] as usize, visible[2] as usize, visible[3] as usize);
    if vx != 0 || vy != 0 || vw == 0 || vh == 0 || vw > w || vh > h { return; }
    let (y, uv) = data.split_at_mut(w * h);
    // Y: columns past the edge, then rows.
    for row in 0..vh { let e = y[row * w + vw - 1]; y[row * w + vw..row * w + w].fill(e); }
    for row in vh..h { y.copy_within((vh - 1) * w..vh * w, row * w); }
    // UV (interleaved pairs, half size): the same, on chroma texels.
    let (cvw, cvh, ch) = (vw.div_ceil(2), vh.div_ceil(2), h / 2);
    for row in 0..cvh { let (u, v) = (uv[row * w + cvw * 2 - 2], uv[row * w + cvw * 2 - 1]);
        for c in cvw..w / 2 { uv[row * w + c * 2] = u; uv[row * w + c * 2 + 1] = v; } }
    for row in cvh..ch { uv.copy_within((cvh - 1) * w..cvh * w, row * w); }
}

impl Mp4In {
    /// Software decode (the CPU path).
    pub fn open(path: &str) -> Result<Self, String> { Self::open_with(path, None) }

    /// With `gpu`: hardware decode on the engine's adapter if the transform takes the device, else software
    /// (the reason in `software_why`).
    pub fn open_with(path: &str, gpu: Option<&crate::Gpu>) -> Result<Self, String> {
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
            // The D3D11 device FIRST (before the media types, as the transform expects).
            let (mut hw, mut software_why) = (None, None);
            if let Some(gpu) = gpu {
                let r = (|| -> Result<Hw, String> {
                    let aware = mft.GetAttributes().ok().and_then(|a| a.GetUINT32(&MF_SA_D3D11_AWARE).ok()).unwrap_or(0) != 0;
                    if !aware { return Err("the decoder is not D3D11-aware".into()); }
                    let (dev, ctx) = d3d11_for(gpu)?;
                    let (mut token, mut mgr) = (0u32, None);
                    MFCreateDXGIDeviceManager(&mut token, &mut mgr).map_err(|e| e.to_string())?;
                    let mgr = mgr.ok_or("no device manager")?;
                    mgr.ResetDevice(&dev, token).map_err(|e| e.to_string())?;
                    mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, mgr.as_raw() as usize).map_err(|e| format!("the decoder refuses the device: {e}"))?;
                    let mut q = None;
                    dev.CreateQuery(&D3D11_QUERY_DESC { Query: D3D11_QUERY_EVENT, MiscFlags: 0 }, Some(&mut q)).map_err(|e| e.to_string())?;
                    Ok(Hw { dev, ctx, _mgr: mgr, query: q.ok_or("no query")?, slot: None })
                })();
                match r { Ok(h) => hw = Some(h), Err(e) => software_why = Some(e) }
            }
            let t = MFCreateMediaType().map_err(|e| e.to_string())?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            t.SetGUID(&MF_MT_SUBTYPE, &sub).map_err(|e| e.to_string())?;
            t.SetUINT64(&MF_MT_FRAME_SIZE, (track.width as u64) << 32 | track.height as u64).map_err(|e| e.to_string())?;
            t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
            mft.SetInputType(0, &t, 0).map_err(|e| format!("{path}: the decoder refuses this stream: {e}"))?;
            let first = track.samples.iter().map(|s| track.ts_us(s)).min().unwrap_or(0);
            let mut me = Mp4In { track, first, file, mft, out_type: None, coded: (0, 0), visible: [0; 4], stride: 0, provides_samples: false, out_size: 0,
                next: 0, queue: VecDeque::new(), last: None, draining: false, drained: false, hw, software_why, path: path.to_string() };
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

    /// The track's first presentation time (µs) — above 0 in a file whose first frame is shown late (a B-frame
    /// composition offset with no edit list).
    pub fn first_ts(&self) -> i64 { self.first }

    /// O3-4: every frame's presentation time (µs), sorted — the timetable mp4worker.rs answers "the frame at t" from,
    /// without the decoder.
    pub fn frame_times(&self) -> Vec<i64> {
        let mut v: Vec<i64> = self.track.samples.iter().map(|s| self.track.ts_us(s)).collect();
        v.sort_unstable();
        v.dedup();
        v
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

    /// ONE move of the decoder: take a frame it has ready, else feed it the next sample (or, past the last,
    /// start draining). Returns false when nothing more will come (drained).
    ///
    /// ⚠ ONE FRAME AT A TIME, consumed before the next is asked for. A hardware decoder writes into a SMALL
    /// pool of textures, and every frame held (in the queue, or as the one shown) keeps one. Collecting
    /// everything it had ready — fine in software — exhausted the pool while draining the end of a file,
    /// and ProcessOutput then WAITED FOREVER for a free texture (measured: the engine hung on the last GOP).
    fn step(&mut self) -> Result<bool, String> {
        if self.drained { return Ok(false); }
        if self.pull_one()? { return Ok(true); }
        if self.drained { return Ok(false); }
        unsafe {
            if self.next >= self.track.samples.len() {
                if !self.draining {
                    let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                    let _ = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
                    self.draining = true;
                    return Ok(true);
                }
                self.drained = true;   // draining, and it gave nothing more
                return Ok(false);
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
            match self.mft.ProcessInput(0, &sample, 0) {
                Ok(()) => { self.next += 1; Ok(true) }
                // It wants its output taken first — but pull_one just found none: it is stuck.
                Err(e) if e.code() == MF_E_NOTACCEPTING => Err(format!("{}: the decoder takes no input and gives no output", self.path)),
                Err(e) => Err(format!("{}: decode: {e}", self.path)),
            }
        }
    }

    /// One frame from the decoder into the queue, if it has one ready.
    fn pull_one(&mut self) -> Result<bool, String> {
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
                        return Ok(true);
                    }
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => { if self.draining { self.drained = true; } return Ok(false); }
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
        // Hardware: the frame stays where the decoder wrote it (its texture array + slice).
        if self.hw.is_some() {
            if let Ok(dx) = buf.cast::<IMFDXGIBuffer>() {
                let mut tex: *mut core::ffi::c_void = std::ptr::null_mut();
                dx.GetResource(&ID3D11Texture2D::IID, &mut tex).map_err(|e| e.to_string())?;
                let tex = ID3D11Texture2D::from_raw(tex);
                let sub = dx.GetSubresourceIndex().map_err(|e| e.to_string())?;
                return Ok(Frame { coded: self.coded, visible: self.visible, ts_us, data: Vec::new(), hw: Some((tex, sub, sample.clone())) });
            }
        }
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
        replicate_padding(&mut data, self.coded, self.visible);
        Ok(Frame { coded: self.coded, visible: self.visible, ts_us, data, hw: None })
    }

    /// The frame on screen at `ts_us` as a picture on the engine's GPU: a hardware frame copied into the
    /// shared slot and converted there; a software one uploaded and converted.
    pub fn picture(&mut self, gpu: &crate::Gpu, conv: &crate::yuv::GpuConvert, ts_us: i64) -> Result<crate::compose::Picture, String> {
        let (coded, visible, hwf) = { let f = self.frame_at(ts_us)?; (f.coded, f.visible, f.hw.as_ref().map(|(t, s, _)| (t.clone(), *s))) };
        let Some((src, sub)) = hwf else { let f = self.last.as_ref().unwrap(); return Ok(conv.picture(gpu, &f.nv12())) };
        let hw = self.hw.as_mut().unwrap();
        if hw.slot.as_ref().is_none_or(|s| s.2 != coded) {
            let (t11, tex) = nv12_slot(gpu, &hw.dev, coded.0, coded.1)?;
            hw.slot = Some((t11, tex, coded));
        }
        let (t11, tex, _) = hw.slot.as_ref().unwrap();
        let wait_at = std::time::Instant::now();
        unsafe {
            let bx = D3D11_BOX { left: 0, top: 0, front: 0, right: coded.0, bottom: coded.1, back: 1 };
            hw.ctx.CopySubresourceRegion(t11, 0, 0, 0, 0, &src, sub, Some(&bx));
            hw.ctx.End(&hw.query);
            hw.ctx.Flush();
            // The copy must be COMPLETE before the engine's queue reads the slot (another device).
            loop {
                let mut done: i32 = 0;
                let _ = hw.ctx.GetData(&hw.query, Some(&mut done as *mut _ as *mut core::ffi::c_void), std::mem::size_of_val(&done) as u32, 0);
                if done != 0 { break; }
                std::thread::yield_now();
            }
        }
        let y = tex.create_view(&wgpu::TextureViewDescriptor { format: Some(wgpu::TextureFormat::R8Unorm), aspect: wgpu::TextureAspect::Plane0, ..Default::default() });
        let uv = tex.create_view(&wgpu::TextureViewDescriptor { format: Some(wgpu::TextureFormat::Rg8Unorm), aspect: wgpu::TextureAspect::Plane1, ..Default::default() });
        let out = conv.convert(gpu, &y, &uv, coded);
        // The slot is overwritten by the next frame's copy: the conversion must have read it first.
        let _ = crate::wait_own(gpu);   // O3-1: the conversion's own submission, not a presenter's venue after it
        crate::prof::add("mp4.wait", wait_at.elapsed());   // the D3D11 copy's spin + the device-wide wait
        Ok(crate::compose::Picture::gpu_frame(coded.0, coded.1, out, visible))
    }

    /// The frame at `ts_us` with its planes in system memory — a hardware frame READ BACK (the decoder gate
    /// compares the planes; the runtime never does this).
    pub fn planes_at(&mut self, ts_us: i64) -> Result<Frame, String> {
        let (coded, visible, ts, data, hwf) = { let f = self.frame_at(ts_us)?; (f.coded, f.visible, f.ts_us, f.data.clone(), f.hw.as_ref().map(|(t, s, _)| (t.clone(), *s))) };
        let Some((src, sub)) = hwf else { return Ok(Frame { coded, visible, ts_us: ts, data, hw: None }) };
        let hw = self.hw.as_ref().unwrap();
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC { Width: coded.0, Height: coded.1, MipLevels: 1, ArraySize: 1, Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 }, Usage: D3D11_USAGE_STAGING, BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0 };
            let mut st = None;
            hw.dev.CreateTexture2D(&desc, None, Some(&mut st)).map_err(|e| format!("staging: {e}"))?;
            let st = st.ok_or("no staging texture")?;
            let bx = D3D11_BOX { left: 0, top: 0, front: 0, right: coded.0, bottom: coded.1, back: 1 };
            hw.ctx.CopySubresourceRegion(&st, 0, 0, 0, 0, &src, sub, Some(&bx));
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            hw.ctx.Map(&st, 0, D3D11_MAP_READ, 0, Some(&mut m)).map_err(|e| format!("map: {e}"))?;
            let (w, h, pitch) = (coded.0 as usize, coded.1 as usize, m.RowPitch as usize);
            let mut data = vec![0u8; w * h * 3 / 2];
            // NV12 mapped: Y rows, then UV rows from pitch × height.
            for row in 0..h + h / 2 { data[row * w..row * w + w].copy_from_slice(std::slice::from_raw_parts((m.pData as *const u8).add(row * pitch), w)); }
            hw.ctx.Unmap(&st, 0);
            Ok(Frame { coded, visible, ts_us: ts, data, hw: None })
        }
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
        self.draining = false;
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
                None => { if !self.step()? { break; } }
            }
        }
        self.last.as_ref().ok_or_else(|| format!("{}: no frame at {ts_us} µs", self.path))
    }
}
