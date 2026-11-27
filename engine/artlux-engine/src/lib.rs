//! THE ARTLUX ENGINE — E0 skeleton (plans/native-engine.md §3, §6, §6b).
//!
//! What exists so far is the part every later phase stands on:
//!   - ONE wgpu device on the platform's native API: D3D12 on Windows (Vulkan as the alternative),
//!     Metal on macOS, Vulkan on Linux. `ARTLUX_ENGINE_BACKEND=vulkan|dx12|metal` overrides it.
//!   - The SOFTWARE-ADAPTER RULE (§6): a CPU rasterizer (WARP, lavapipe, SwiftShader) never runs a
//!     show by accident. It is refused unless the caller allows it — CI does, because the hosted
//!     runners have no GPU; a venue machine never should.
//!   - The two GPU jobs the engine exists for, in their smallest exact form, with a CPU reference:
//!     an offscreen RENDER read back to bytes (what an output window / a view presents), and LED
//!     SAMPLING by compute (what becomes Art-Net). Both are integer-exact by construction, so one
//!     set of committed goldens holds on every adapter — a hardware GPU here, WARP on the Windows
//!     runner, lavapipe on Linux, Metal on macOS.

use std::fmt;

pub mod card;
pub mod hapimport;
pub mod serve;
pub mod pack;
pub mod wire;
pub mod layout;
pub mod sample;
pub mod compose;
pub mod yuv;
pub mod mp4demux;
#[cfg(windows)]
pub mod mf;
#[cfg(windows)]
pub mod encode;
#[cfg(windows)]
pub mod cam;
#[cfg(windows)]
pub mod camshared;
pub mod effects;
pub mod projector;
pub mod calib3d;
pub mod runtime;
pub mod outputs;
pub mod view3d;
pub mod beams;
pub mod labels;
pub mod gizmo;
pub mod grid;
pub mod prof;
pub mod preroll;
pub mod scenegpu;
pub mod post;
pub mod ao;
pub mod shader;
pub mod blobs;
pub mod comp;
pub mod bakescale;
pub mod crop;
pub mod eval;
pub mod transport;
pub mod audio;
pub mod light;
pub mod lightpack;
#[cfg(feature = "ndi")]
pub mod ndi;
pub mod windows;
pub mod hold;
#[cfg(windows)]
pub mod share;
#[cfg(windows)]
pub mod spout;

/// BUILT ONCE PER DEVICE, AND KEPT — plans/engine-optimisation-and-deferred-3d.md O1-1. A pipeline (with its sampler,
/// its layout…) is a shader COMPILE on DX12 (naga → HLSL → the DX compiler), and several were made on the hot path:
/// two per LED tick, two per new picture on every projector, a whole layout per baked-map draw. Each now lives in a
/// `static` of this type, built on first use for a (device, key) and cloned out after (wgpu handles are reference
/// counted, so a clone is a pointer). Per DEVICE because a test may open more than one; the key is whatever the
/// pipeline depends on beyond the device (a target format, a sample count), `()` when nothing.
pub struct PerDevice<K, T>(std::sync::Mutex<Vec<(wgpu::Device, K, T)>>);

impl<K: PartialEq + Clone, T: Clone> PerDevice<K, T> {
    pub const fn new() -> Self { PerDevice(std::sync::Mutex::new(Vec::new())) }
    pub fn get(&self, d: &wgpu::Device, key: K, make: impl FnOnce() -> T) -> T {
        // Built under the lock: two threads asking at once build it once (a presenter and the render thread may).
        let mut v = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, _, t)) = v.iter().find(|(dev, k, _)| dev == d && *k == key) { return t.clone(); }
        let t = make();
        v.push((d.clone(), key, t.clone()));
        t
    }
}

// ── O3-1: WAIT FOR YOUR OWN WORK, NOT THE WHOLE GPU ─────────────────────────────────────────────────────────────
// Every thread shares ONE device and queue (serve.rs). A `poll(Wait { submission_index: None })` waits for EVERYTHING
// queued — so the render thread's LED read-back, its MP4 slot, Spout, waited for a calibrated 4K venue a presenter had
// just submitted, and the Art-Net tick moved with projector load (plans/engine-optimisation-and-deferred-3d.md R1;
// measured after O2: a film on a calibrated venue, the render tick 2.7 → 3.8 ms because the waits met the venue's
// draw). The queue completes in order, so waiting on a submission's own index waits for it and what came before —
// never for what other threads submit after.

thread_local! { static LAST_SUBMIT: std::cell::RefCell<Option<wgpu::SubmissionIndex>> = const { std::cell::RefCell::new(None) }; }

/// `queue.submit`, remembering the index as this thread's latest (for `wait_own`).
pub fn submit<I: IntoIterator<Item = wgpu::CommandBuffer>>(gpu: &Gpu, cmds: I) -> wgpu::SubmissionIndex {
    let i = gpu.queue.submit(cmds);
    LAST_SUBMIT.with(|l| *l.borrow_mut() = Some(i.clone()));
    i
}

/// Waits until this thread's latest `submit` has completed (and what was queued before it) — not later work.
pub fn wait_own(gpu: &Gpu) -> Result<(), EngineError> {
    let idx = LAST_SUBMIT.with(|l| l.borrow().clone());
    gpu.device.poll(wgpu::PollType::Wait { submission_index: idx, timeout: None }).map(|_| ()).map_err(|e| EngineError::Gpu(e.to_string()))
}

/// O3-2 / O3-3 — A READ-BACK IN FLIGHT. Started right after the copy that fills `buf` is submitted (`idx`); then either
/// `try_take` on a later pass (never blocks: the GPU had a frame to finish it) or `wait` (blocks on ITS submission only).
pub struct PendingRead { buf: wgpu::Buffer, len: usize, idx: wgpu::SubmissionIndex, rx: std::sync::mpsc::Receiver<Result<(), wgpu::BufferAsyncError>> }

impl PendingRead {
    pub fn start(buf: wgpu::Buffer, len: usize, idx: wgpu::SubmissionIndex) -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |r| { let _ = tx.send(r); });
        PendingRead { buf, len, idx, rx }
    }
    fn bytes(&self, r: Result<(), wgpu::BufferAsyncError>) -> Result<Vec<u8>, EngineError> {
        r.map_err(|e| EngineError::Gpu(e.to_string()))?;
        let out = self.buf.slice(..).get_mapped_range().map_err(|e| EngineError::Gpu(e.to_string()))?[..self.len].to_vec();
        self.buf.unmap();
        Ok(out)
    }
    /// The bytes if the GPU has finished, else None — no wait.
    pub fn try_take(&self, gpu: &Gpu) -> Option<Result<Vec<u8>, EngineError>> {
        let _ = gpu.device.poll(wgpu::PollType::Poll);
        match self.rx.try_recv() {
            Ok(r) => Some(self.bytes(r)),
            Err(std::sync::mpsc::TryRecvError::Empty) => None,
            Err(e) => Some(Err(EngineError::Gpu(e.to_string()))),
        }
    }
    /// The bytes, waiting for this read's own submission (normally long done when the caller is a tick later).
    pub fn wait(self, gpu: &Gpu) -> Result<Vec<u8>, EngineError> {
        gpu.device.poll(wgpu::PollType::Wait { submission_index: Some(self.idx.clone()), timeout: None }).map_err(|e| EngineError::Gpu(e.to_string()))?;
        let r = self.rx.recv().map_err(|e| EngineError::Gpu(e.to_string()))?;
        self.bytes(r)
    }
}

/// Which native API this platform renders with (§6 table, "GPU backend").
pub fn native_backends() -> wgpu::Backends {
    match std::env::var("ARTLUX_ENGINE_BACKEND").ok().as_deref() {
        Some("vulkan") => return wgpu::Backends::VULKAN,
        Some("dx12") => return wgpu::Backends::DX12,
        Some("metal") => return wgpu::Backends::METAL,
        _ => {}
    }
    if cfg!(windows) {
        wgpu::Backends::DX12
    } else if cfg!(target_os = "macos") {
        wgpu::Backends::METAL
    } else {
        wgpu::Backends::VULKAN
    }
}

/// How an adapter may be chosen.
#[derive(Clone, Copy, Debug, Default)]
pub struct AdapterPolicy {
    /// A software adapter may be used when no hardware one exists (CI only).
    pub allow_software: bool,
    /// Pick the software adapter even when hardware exists (to prove the CI path on a GPU machine).
    pub force_software: bool,
}

#[derive(Debug)]
pub enum EngineError {
    NoAdapter(String),
    SoftwareRefused(String),
    Device(String),
    Gpu(String),
}
impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::NoAdapter(s) => write!(f, "no usable GPU adapter: {s}"),
            EngineError::SoftwareRefused(s) => write!(
                f,
                "only a SOFTWARE adapter is available ({s}); it cannot run a show. \
                 Pass --allow-software for tests only"
            ),
            EngineError::Device(s) => write!(f, "the GPU device could not be opened: {s}"),
            EngineError::Gpu(s) => write!(f, "GPU error: {s}"),
        }
    }
}
impl std::error::Error for EngineError {}

pub fn is_software(info: &wgpu::AdapterInfo) -> bool {
    info.device_type == wgpu::DeviceType::Cpu
}

pub fn describe(info: &wgpu::AdapterInfo) -> String {
    format!(
        "{} ({:?}, {:?}, driver {} {})",
        info.name, info.backend, info.device_type, info.driver, info.driver_info
    )
}

/// Every adapter the native API offers, best first: discrete, integrated, other, software.
pub fn list_adapters() -> Vec<wgpu::AdapterInfo> {
    let backends = native_backends();
    let instance = new_instance(backends);
    let mut infos: Vec<_> = pollster::block_on(instance.enumerate_adapters(backends))
        .iter()
        .map(|a| a.get_info())
        .collect();
    infos.sort_by_key(rank);
    infos
}

fn rank(info: &wgpu::AdapterInfo) -> u8 {
    match info.device_type {
        wgpu::DeviceType::DiscreteGpu => 0,
        wgpu::DeviceType::IntegratedGpu => 1,
        wgpu::DeviceType::VirtualGpu => 2,
        wgpu::DeviceType::Other => 3,
        wgpu::DeviceType::Cpu => 4,
    }
}

fn new_instance(backends: wgpu::Backends) -> wgpu::Instance {
    new_instance_with(backends, None)
}

/// A window system's display (X11 / Wayland need it to make surfaces; Windows and macOS do not).
pub type Display = Box<dyn wgpu::wgt::WgpuHasDisplayHandle>;

fn new_instance_with(backends: wgpu::Backends, display: Option<Display>) -> wgpu::Instance {
    let mut desc = match display {
        Some(d) => wgpu::InstanceDescriptor::new_with_display_handle(d),
        None => wgpu::InstanceDescriptor::new_without_display_handle(),
    };
    desc.backends = backends;
    wgpu::Instance::new(desc)
}

/// The engine's one device.
pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
}

impl Gpu {
    pub fn open(policy: AdapterPolicy) -> Result<Gpu, EngineError> {
        Self::open_with(policy, None)
    }

    /// The same, for an engine that will present to windows of this display.
    pub fn open_with(policy: AdapterPolicy, display: Option<Display>) -> Result<Gpu, EngineError> {
        let backends = native_backends();
        let instance = new_instance_with(backends, display);
        let mut adapters = pollster::block_on(instance.enumerate_adapters(backends));
        if adapters.is_empty() {
            return Err(EngineError::NoAdapter(format!("{backends:?} offers none")));
        }
        adapters.sort_by_key(|a| rank(&a.get_info()));
        let pick = if policy.force_software {
            adapters.into_iter().find(|a| is_software(&a.get_info())).ok_or_else(|| {
                EngineError::NoAdapter(format!("{backends:?} offers no software adapter"))
            })?
        } else {
            let first = adapters.into_iter().next().expect("checked non-empty");
            let info = first.get_info();
            if is_software(&info) && !policy.allow_software {
                return Err(EngineError::SoftwareRefused(describe(&info)));
            }
            first
        };
        let info = pick.get_info();
        // BC (DXT) textures: HAP's frames ARE BC blocks, uploaded as they are (E0d). Every desktop GPU
        // and both software adapters have it; where one does not, HAP takes the CPU-decode fallback.
        // NV12 (item 2c-3b): a hardware decoder's frames are NV12 textures, read as their two planes.
        // Adapter-specific format features: 8× MSAA on a half-float target — three.js's EffectComposer default, which the
        // calibrated venue's post pass is held to (calib3d.rs).
        let wanted = (wgpu::Features::TEXTURE_COMPRESSION_BC | wgpu::Features::TEXTURE_FORMAT_NV12 | wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES) & pick.features();
        let (device, queue) = pollster::block_on(pick.request_device(&wgpu::DeviceDescriptor {
            label: Some("artlux-engine"),
            required_features: wanted,
            ..Default::default()
        }))
        .map_err(|e| EngineError::Device(e.to_string()))?;
        Ok(Gpu { instance, adapter: pick, device, queue, info })
    }

    fn wait(&self) -> Result<(), EngineError> {
        self.device
            .poll(wgpu::PollType::Wait { submission_index: None, timeout: None })
            .map(|_| ())
            .map_err(|e| EngineError::Gpu(e.to_string()))
    }

    /// Map a COPY_DST|MAP_READ buffer and return its first `len` bytes.
    fn read_buffer(&self, buf: &wgpu::Buffer, len: usize) -> Result<Vec<u8>, EngineError> {
        let slice = buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        // O3-1: this thread's own latest submission (the copy, when its caller used `submit`); if the map has not
        // landed by then the copy was submitted some other way — the whole device, as before, so this never hangs.
        wait_own(self)?;
        let r = match rx.try_recv() { Ok(r) => r, Err(_) => { self.wait()?; rx.recv().map_err(|e| EngineError::Gpu(e.to_string()))? } };
        r.map_err(|e| EngineError::Gpu(e.to_string()))?;
        let out = slice.get_mapped_range().map_err(|e| EngineError::Gpu(e.to_string()))?[..len].to_vec();
        buf.unmap();
        Ok(out)
    }
}

/// Read an RGBA8 texture back to the CPU (rows tightly packed, row 0 first) — for harnesses and tests.
pub fn read_texture_rgba(gpu: &Gpu, tex: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
    let stride = (w * 4).div_ceil(256) * 256;
    let buf = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (stride * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut enc = gpu.device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
    gpu.queue.submit([enc.finish()]);
    let raw = gpu.read_buffer(&buf, (stride * h) as usize).unwrap_or_default();
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h as usize { let o = y * stride as usize; if o + (w * 4) as usize <= raw.len() { out.extend_from_slice(&raw[o..o + (w * 4) as usize]); } }
    out
}

// ── 1. AN OFFSCREEN RENDER, READ BACK ────────────────────────────────────────────────────────────────
// A full-screen triangle whose fragment colour is a function of the INTEGER pixel position only, in
// steps of 1/255: no interpolation, no filtering, no rounding ties — so every conformant rasterizer
// writes the same bytes, and the golden is the CPU reference below.

pub const FRAME: u32 = 64;

const FRAME_WGSL: &str = r#"
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // One triangle covering the target: (-1,-1) (3,-1) (-1,3).
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<u32>(pos.xy);              // pixel centre (x + 0.5) -> its integer column
    let quad = (p.x / 32u) + 2u * (p.y / 32u);
    let r = f32(p.x * 4u) / 255.0;          // 0, 4, ... 252: a ramp across
    let g = f32(p.y * 4u) / 255.0;          // and down
    let b = f32(quad * 60u + 15u) / 255.0;  // 15, 75, 135, 195 per quadrant
    return vec4<f32>(r, g, b, 1.0);
}
"#;

/// What every adapter must produce for the frame: RGBA8, row-major, top row first.
pub fn frame_reference() -> Vec<u8> {
    let mut v = Vec::with_capacity((FRAME * FRAME * 4) as usize);
    for y in 0..FRAME {
        for x in 0..FRAME {
            let quad = x / 32 + 2 * (y / 32);
            v.extend_from_slice(&[(x * 4) as u8, (y * 4) as u8, (quad * 60 + 15) as u8, 255]);
        }
    }
    v
}

pub fn render_frame(gpu: &Gpu) -> Result<Vec<u8>, EngineError> {
    let d = &gpu.device;
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let target = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("frame"),
        size: wgpu::Extent3d { width: FRAME, height: FRAME, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("frame"),
        source: wgpu::ShaderSource::Wgsl(FRAME_WGSL.into()),
    });
    let pipeline = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("frame"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            targets: &[Some(format.into())],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    // 64 px × 4 B = 256 B per row: already the copy alignment, so no row padding to strip.
    let bytes = (FRAME * FRAME * 4) as u64;
    let readback = d.create_buffer(&wgpu::BufferDescriptor {
        label: Some("frame readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = d.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("frame"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.draw(0..3, 0..1);
    }
    enc.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(FRAME * 4), rows_per_image: Some(FRAME) },
        },
        wgpu::Extent3d { width: FRAME, height: FRAME, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([enc.finish()]);
    gpu.read_buffer(&readback, bytes as usize)
}

// ── 2. LED SAMPLING BY COMPUTE ───────────────────────────────────────────────────────────────────────
// The engine's reason to exist: a content texture in, one RGB triple per LED out, packed for the wire.
// Point sampling at a UV (today's WebGPUMapper does the same in WGSL). Exactness: the UVs are pixel
// centres of a power-of-two texture, (k + 0.5) / W, which f32 represents exactly, and a stored 8-bit
// value read back as n/255 and multiplied by 255 rounds to n on any IEEE GPU.

pub const LED_TEX: u32 = 32;

const LED_WGSL: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> uvs: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> rgb: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i >= arrayLength(&uvs)) { return; }
    let dim = textureDimensions(src);
    let uv = clamp(uvs[i], vec2<f32>(0.0), vec2<f32>(1.0));
    let p = min(vec2<u32>(uv * vec2<f32>(dim)), dim - vec2<u32>(1u));
    let c = textureLoad(src, p, 0);
    let b = vec3<u32>(round(c.rgb * 255.0));
    rgb[i] = b.r | (b.g << 8u) | (b.b << 16u);
}
"#;

/// The test content: a deterministic RGBA8 pattern (a cheap hash, so neighbours differ).
pub fn led_texture() -> Vec<u8> {
    let mut v = Vec::with_capacity((LED_TEX * LED_TEX * 4) as usize);
    for y in 0..LED_TEX {
        for x in 0..LED_TEX {
            let h = (x.wrapping_mul(73) ^ y.wrapping_mul(151)).wrapping_mul(2654435761);
            v.extend_from_slice(&[(h >> 24) as u8, (h >> 16) as u8, (h >> 8) as u8, 255]);
        }
    }
    v
}

/// The LEDs: a strip across, a strip down and a diagonal — 3 × 32 pixel-centre UVs.
pub fn led_uvs() -> Vec<[f32; 2]> {
    let c = |k: u32| (k as f32 + 0.5) / LED_TEX as f32;
    let mut v = Vec::new();
    for k in 0..LED_TEX { v.push([c(k), c(7)]); }
    for k in 0..LED_TEX { v.push([c(20), c(k)]); }
    for k in 0..LED_TEX { v.push([c(k), c(LED_TEX - 1 - k)]); }
    v
}

/// What every adapter must produce: RGB per LED, in LED order (the DMX byte order of an RGB strip).
pub fn leds_reference() -> Vec<u8> {
    let tex = led_texture();
    let mut out = Vec::new();
    for [u, v] in led_uvs() {
        let x = ((u * LED_TEX as f32) as u32).min(LED_TEX - 1);
        let y = ((v * LED_TEX as f32) as u32).min(LED_TEX - 1);
        let i = ((y * LED_TEX + x) * 4) as usize;
        out.extend_from_slice(&tex[i..i + 3]);
    }
    out
}

pub fn sample_leds(gpu: &Gpu) -> Result<Vec<u8>, EngineError> {
    let d = &gpu.device;
    let size = wgpu::Extent3d { width: LED_TEX, height: LED_TEX, depth_or_array_layers: 1 };
    let tex = d.create_texture(&wgpu::TextureDescriptor {
        label: Some("content"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        tex.as_image_copy(),
        &led_texture(),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(LED_TEX * 4), rows_per_image: Some(LED_TEX) },
        size,
    );
    sample_points(gpu, &tex, &led_uvs())
}

/// Point-sample `tex` at `uvs` by compute: RGB per point, in order. Any sampleable float format —
/// RGBA8, BGRA8, a BC texture (the GPU decodes the blocks as it reads).
pub fn sample_points(gpu: &Gpu, tex: &wgpu::Texture, uvs: &[[f32; 2]]) -> Result<Vec<u8>, EngineError> {
    let d = &gpu.device;
    let uv_bytes: Vec<u8> = uvs.iter().flat_map(|p| p.iter().flat_map(|f| f.to_le_bytes())).collect();
    let uv_buf = d.create_buffer(&wgpu::BufferDescriptor {
        label: Some("uvs"),
        size: uv_bytes.len() as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    gpu.queue.write_buffer(&uv_buf, 0, &uv_bytes);
    let out_len = (uvs.len() * 4) as u64;
    let out = d.create_buffer(&wgpu::BufferDescriptor {
        label: Some("rgb"),
        size: out_len,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = d.create_buffer(&wgpu::BufferDescriptor {
        label: Some("rgb readback"),
        size: out_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("leds"),
        source: wgpu::ShaderSource::Wgsl(LED_WGSL.into()),
    });
    let pipeline = d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("leds"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("leds"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&tex.create_view(&Default::default())) },
            wgpu::BindGroupEntry { binding: 1, resource: uv_buf.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: out.as_entire_binding() },
        ],
    });
    let mut enc = d.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.dispatch_workgroups((uvs.len() as u32).div_ceil(64), 1, 1);
    }
    enc.copy_buffer_to_buffer(&out, 0, &readback, 0, out_len);
    gpu.queue.submit([enc.finish()]);
    let packed = gpu.read_buffer(&readback, out_len as usize)?;
    // u32 per LED (r | g<<8 | b<<16, little-endian) -> the wire's 3 bytes.
    Ok(packed.chunks_exact(4).flat_map(|c| [c[0], c[1], c[2]]).collect())
}

// ── THE SELF-TEST ────────────────────────────────────────────────────────────────────────────────────

pub const GOLDEN_FRAME: &[u8] = include_bytes!("../tests/golden/frame64.rgba");
pub const GOLDEN_LEDS: &[u8] = include_bytes!("../tests/golden/leds96.rgb");

/// Runs both jobs on `gpu` and compares them to the committed goldens. Returns one line per check.
pub fn selftest(gpu: &Gpu) -> Result<Vec<String>, Vec<String>> {
    let mut lines = vec![format!("adapter: {}", describe(&gpu.info))];
    let mut ok = true;
    let mut check = |what: &str, got: Result<Vec<u8>, EngineError>, want: &[u8]| match got {
        Ok(g) if g == want => lines.push(format!("ok   {what}: {} bytes match the golden", g.len())),
        Ok(g) => {
            ok = false;
            let first = g.iter().zip(want).position(|(a, b)| a != b).unwrap_or(g.len().min(want.len()));
            lines.push(format!("FAIL {what}: {} bytes vs golden {}; first difference at byte {first}", g.len(), want.len()));
        }
        Err(e) => {
            ok = false;
            lines.push(format!("FAIL {what}: {e}"));
        }
    };
    check("offscreen render, read back", render_frame(gpu), GOLDEN_FRAME);
    check("LED sampling by compute", sample_leds(gpu), GOLDEN_LEDS);
    // HAP's blocks as a BC texture (or the CPU fallback where the adapter has no BC) — E0d.
    match hapimport::bc_selftest(gpu) {
        Ok((px, path)) => check(&format!("a HAP frame (BC1) through hap.rs, as a {path}"), Ok(px), &hapimport::BC1_GOLDEN),
        Err(e) => check("a HAP frame (BC1) through hap.rs", Err(e), &hapimport::BC1_GOLDEN),
    }
    if ok { Ok(lines) } else { Err(lines) }
}
