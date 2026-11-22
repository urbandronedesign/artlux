//! E0b — ENGINE WINDOWS: one per display, each presenting at ITS display's refresh (plan §3, §5, §6).
//!
//! The shape the engine will keep:
//!   - The window system's event loop owns the main thread (AppKit requires it on macOS, which is why
//!     the engine is its own binary and not a module inside Electron).
//!   - Each window PRESENTS ON ITS OWN THREAD with a FIFO (vsync) swapchain. Presenting several FIFO
//!     swapchains from one thread would tie every window to whichever vblank comes last — a 144 Hz
//!     projector held to a 60 Hz monitor's pace. One thread per window, blocked only on its own
//!     display, is what "each output at its own refresh, no cap" means in code.
//!   - THE REVEAL DEPENDS ON NOTHING. A window is created visible and its thread draws as soon as the
//!     surface exists. No "ready" event gates it: the Electron windows' `ready-to-show` that does not
//!     always fire in a packaged build cost a day twice (CLAUDE.md), and the engine does not repeat it.
//!
//! What it draws is a test card a probe can check from the SCREEN: four flat quadrants in pure colours
//! (red, green, blue, white — exact through an sRGB swapchain too, being 0 or 1 per channel) and, in a
//! black band across the top eighth, a magenta bar that moves one step per presented frame, so two
//! captures prove the window is live.

use crate::{describe, AdapterPolicy, EngineError, Gpu};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, KeyEvent, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::monitor::MonitorHandle;
use winit::window::{Fullscreen, Window, WindowId};

#[derive(Clone, Debug)]
pub struct WindowOptions {
    /// Borderless fullscreen on each display (an output); otherwise a window on each display.
    pub fullscreen: bool,
    /// Close everything after this long (a probe); None = until Esc / every window closed.
    pub run_for: Option<Duration>,
    pub policy: AdapterPolicy,
    /// E1e-2: PROJECTOR OUTPUTS instead of the test card — one window per output, on the display it names.
    pub projection: Option<Projection>,
}

/// Which display an output goes to. EXACT physical bounds first (what the host sends: Electron's display
/// bounds × its scale factor), then an index. An output that matches neither is NOT opened anywhere else:
/// a show on the wrong screen is worse than none — it is refused and said.
#[derive(Clone, Debug)]
pub struct DisplayMatch { pub bounds: Option<(i32, i32, u32, u32)>, pub index: Option<usize> }

#[derive(Clone)]
pub struct ProjectorOut {
    pub name: String,
    pub display: DisplayMatch,
    /// A borderless WINDOW at (x, y, w, h) relative to the display (a probe on a machine with one screen);
    /// None = borderless fullscreen on it (an output).
    pub window: Option<(i32, i32, u32, u32)>,
    pub opts: crate::projector::Opts,
    /// The content: RGBA8, straight alpha (a still for now — live sources come with the document channel).
    pub picture: Arc<(u32, u32, Vec<u8>)>,
}

#[derive(Clone)]
pub struct Projection { pub outputs: Vec<ProjectorOut> }
impl std::fmt::Debug for Projection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "Projection({} outputs)", self.outputs.len()) }
}

/// The display an output names, or why none.
pub fn match_display(monitors: &[MonitorHandle], m: &DisplayMatch) -> Result<usize, String> {
    if let Some((x, y, w, h)) = m.bounds {
        if let Some(i) = monitors.iter().position(|mon| { let (p, s) = (mon.position(), mon.size()); p.x == x && p.y == y && s.width == w && s.height == h }) {
            return Ok(i);
        }
        return Err(format!("no display at {w}x{h} ({x}, {y}) — displays here: {}", monitors.iter().map(|mon| { let (p, s) = (mon.position(), mon.size()); format!("{}x{} ({}, {})", s.width, s.height, p.x, p.y) }).collect::<Vec<_>>().join(", ")));
    }
    match m.index { Some(i) if i < monitors.len() => Ok(i), Some(i) => Err(format!("no display {i} ({} here)", monitors.len())), None => Err("the output names no display".into()) }
}

// The test card itself lives in card.rs (the shared-texture spike draws the same one).

/// One output: its window, and the thread presenting to it.
struct Output {
    window: Arc<Window>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

struct App {
    options: WindowOptions,
    gpu: Option<Arc<Gpu>>,
    outputs: HashMap<WindowId, Output>,
    /// Outputs told to stop whose presenter has not finished yet. Kept (window and all) until it has:
    /// the surface must go before its window, and the main thread must not WAIT for it — see close().
    closing: Vec<Output>,
    exiting: bool,
    deadline: Option<Instant>,
    error: Option<String>,
}

fn monitor_label(m: &MonitorHandle, i: usize) -> String {
    m.name().unwrap_or_else(|| format!("display {i}"))
}

impl App {
    fn open_outputs(&mut self, el: &ActiveEventLoop) -> Result<(), EngineError> {
        let gpu = match &self.gpu {
            Some(g) => g.clone(),
            None => {
                let g = Arc::new(Gpu::open_with(self.options.policy, Some(Box::new(el.owned_display_handle())))?);
                println!("engine device: {}", describe(&g.info));
                self.gpu = Some(g.clone());
                g
            }
        };
        let monitors: Vec<MonitorHandle> = el.available_monitors().collect();
        if monitors.is_empty() {
            return Err(EngineError::NoAdapter("the window system reports no display".into()));
        }
        if let Some(proj) = self.options.projection.clone() { return self.open_projection(el, gpu, &monitors, proj); }
        for (i, m) in monitors.iter().enumerate() {
            let label = monitor_label(m, i);
            let hz = m.refresh_rate_millihertz().map(|mhz| format!("{:.2} Hz", mhz as f64 / 1000.0)).unwrap_or_else(|| "refresh unknown".into());
            let pos = m.position();
            let size = m.size();
            let mut attrs = Window::default_attributes()
                .with_title(format!("ArtLux engine — {label}"))
                .with_visible(true);   // THE REVEAL: visible from creation, gated on nothing
            if self.options.fullscreen {
                attrs = attrs.with_fullscreen(Some(Fullscreen::Borderless(Some(m.clone()))));
            } else {
                // Half the display, inset on it — on THAT display, so each window is that display's.
                attrs = attrs
                    .with_position(PhysicalPosition::new(pos.x + size.width as i32 / 8, pos.y + size.height as i32 / 8))
                    .with_inner_size(PhysicalSize::new(size.width / 2, size.height / 2));
            }
            let window = Arc::new(el.create_window(attrs).map_err(|e| EngineError::Gpu(format!("window: {e}")))?);
            let surface = gpu
                .instance
                .create_surface(window.clone())
                .map_err(|e| EngineError::Gpu(format!("surface on {label}: {e}")))?;
            if !gpu.adapter.is_surface_supported(&surface) {
                return Err(EngineError::Gpu(format!("the adapter cannot present to {label}")));
            }
            println!("window on {label}: {}x{} at ({}, {}), display refresh {hz}{}", size.width, size.height, pos.x, pos.y,
                if self.options.fullscreen { ", borderless fullscreen" } else { "" });
            let stop = Arc::new(AtomicBool::new(false));
            let thread = {
                let (gpu, window, stop, label) = (gpu.clone(), window.clone(), stop.clone(), label.clone());
                std::thread::Builder::new()
                    .name(format!("present:{label}"))
                    .spawn(move || present_loop(gpu, window, surface, stop, label))
                    .map_err(|e| EngineError::Gpu(e.to_string()))?
            };
            self.outputs.insert(window.id(), Output { window, stop, thread: Some(thread) });
        }
        Ok(())
    }

    fn open_projection(&mut self, el: &ActiveEventLoop, gpu: Arc<Gpu>, monitors: &[MonitorHandle], proj: Projection) -> Result<(), EngineError> {
        let mut refused = Vec::new();
        for o in proj.outputs {
            let i = match match_display(monitors, &o.display) { Ok(i) => i, Err(e) => { eprintln!("output '{}' NOT opened: {e}", o.name); refused.push(o.name.clone()); continue; } };
            let m = &monitors[i];
            let (pos, size) = (m.position(), m.size());
            let hz = m.refresh_rate_millihertz().map(|mhz| format!("{:.2} Hz", mhz as f64 / 1000.0)).unwrap_or_else(|| "refresh unknown".into());
            let mut attrs = Window::default_attributes().with_title(format!("ArtLux output — {}", o.name)).with_visible(true).with_decorations(false);
            attrs = match o.window {
                None => attrs.with_fullscreen(Some(Fullscreen::Borderless(Some(m.clone())))),
                Some((x, y, w, h)) => attrs.with_position(PhysicalPosition::new(pos.x + x, pos.y + y)).with_inner_size(PhysicalSize::new(w, h)).with_resizable(false),
            };
            let window = Arc::new(el.create_window(attrs).map_err(|e| EngineError::Gpu(format!("window: {e}")))?);
            let surface = gpu.instance.create_surface(window.clone()).map_err(|e| EngineError::Gpu(format!("surface for '{}': {e}", o.name)))?;
            if !gpu.adapter.is_surface_supported(&surface) { return Err(EngineError::Gpu(format!("the adapter cannot present to '{}'", o.name))); }
            println!("output '{}' on {} ({}x{} at ({}, {}), {hz}){}", o.name, monitor_label(m, i), size.width, size.height, pos.x, pos.y,
                if o.window.is_none() { ", borderless fullscreen" } else { ", windowed (probe)" });
            let stop = Arc::new(AtomicBool::new(false));
            let thread = {
                let (gpu, window, stop, label) = (gpu.clone(), window.clone(), stop.clone(), o.name.clone());
                std::thread::Builder::new().name(format!("present:{label}"))
                    .spawn(move || projector_loop(gpu, window, surface, stop, label, o))
                    .map_err(|e| EngineError::Gpu(e.to_string()))?
            };
            self.outputs.insert(window.id(), Output { window, stop, thread: Some(thread) });
        }
        if self.outputs.is_empty() { return Err(EngineError::Gpu(format!("no output could be opened ({} refused)", refused.len()))); }
        Ok(())
    }

    /// NEVER JOIN A PRESENTER FROM HERE — a precaution, not a bug seen. This runs on the window thread,
    /// and DXGI documents that a Present on another thread can need the window's thread to process a
    /// message (a mode change, a fullscreen transition) before it returns; blocking that thread on the
    /// presenter is the textbook deadlock. (A join here did NOT hang in the E0b runs — 4/4 exited — so
    /// this is the shape kept for outputs, which will see mode changes, not a fix.) So: hide the window,
    /// tell the presenter to stop, keep pumping, and reap it in about_to_wait once it has finished.
    fn close(&mut self, id: WindowId) {
        if let Some(o) = self.outputs.remove(&id) {
            o.window.set_visible(false);
            o.stop.store(true, Ordering::SeqCst);
            self.closing.push(o);
        }
    }

    fn close_all(&mut self) {
        let ids: Vec<_> = self.outputs.keys().copied().collect();
        for id in ids { self.close(id); }
    }

    /// Join the presenters that have finished; drop their windows after them. True when none is left.
    fn reap(&mut self) -> bool {
        let mut i = 0;
        while i < self.closing.len() {
            if self.closing[i].thread.as_ref().map_or(true, |t| t.is_finished()) {
                let mut o = self.closing.swap_remove(i);
                if let Some(t) = o.thread.take() { let _ = t.join(); }   // finished: returns at once
                drop(o.window);
            } else {
                i += 1;
            }
        }
        self.closing.is_empty()
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if !self.outputs.is_empty() { return; }
        if let Err(e) = self.open_outputs(el) {
            self.error = Some(e.to_string());
            self.close_all();
            self.exiting = true;
        }
    }

    fn window_event(&mut self, el: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                self.close(id);
                if self.outputs.is_empty() { self.exiting = true; }
            }
            WindowEvent::KeyboardInput { event: KeyEvent { logical_key: Key::Named(NamedKey::Escape), state: ElementState::Pressed, .. }, .. } => {
                self.close_all();
                self.exiting = true;
            }
            _ => {}
        }
        let _ = el;
    }

    fn about_to_wait(&mut self, el: &ActiveEventLoop) {
        // The main thread only routes window events; it never waits on a GPU. Wake for the deadline.
        if matches!(self.deadline, Some(d) if Instant::now() >= d) {
            self.close_all();
            self.exiting = true;
        }
        let all_reaped = self.reap();
        if self.exiting && all_reaped {
            el.exit();
            return;
        }
        // While a presenter is stopping, look again shortly (and keep pumping its window's messages).
        if !self.closing.is_empty() {
            el.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(5)));
            return;
        }
        match self.deadline {
            Some(d) => el.set_control_flow(ControlFlow::WaitUntil(d)),
            None => el.set_control_flow(ControlFlow::Wait),
        }
    }
}

/// One window's presenter. Configures its swapchain to the window's size, then draws + presents
/// forever; FIFO blocks this thread — and only this thread — until this display's next vblank.
fn present_loop(gpu: Arc<Gpu>, window: Arc<Window>, surface: wgpu::Surface<'static>, stop: Arc<AtomicBool>, label: String) {
    let d = &gpu.device;
    let caps = surface.get_capabilities(&gpu.adapter);
    // Prefer a non-sRGB format (the engine composites in linear space and encodes itself, later);
    // the test card is exact either way.
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let card = crate::card::Card::new(d, format);
    let mut configured: Option<PhysicalSize<u32>> = None;
    let mut frame: u64 = 0;
    while !stop.load(Ordering::SeqCst) {
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 {
            // Minimised: nothing to present to. Not a busy loop.
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }
        if configured != Some(size) {
            surface.configure(d, &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                width: size.width,
                height: size.height,
                present_mode: wgpu::PresentMode::Fifo,   // vsync to THIS display
                desired_maximum_frame_latency: 2,
                alpha_mode: caps.alpha_modes[0],
                view_formats: vec![],
                color_space: wgpu::SurfaceColorSpace::Auto,   // SDR; HDR outputs are a later question
            });
            configured = Some(size);
        }
        let tex = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            // Covered or not ready: skip this frame without spinning. (Occluded windows present
            // nothing on some platforms; an OUTPUT is never covered, it is fullscreen on its display.)
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                std::thread::sleep(Duration::from_millis(8));
                continue;
            }
            other => {
                // Lost / outdated (a resize, a display change): reconfigure on the next turn.
                eprintln!("present:{label}: {other:?}, reconfiguring");
                configured = None;
                continue;
            }
        };
        let view = tex.texture.create_view(&Default::default());
        gpu.queue.submit([card.encode(&gpu, &view, size.width, size.height, frame)]);
        window.pre_present_notify();
        gpu.queue.present(tex);   // wgpu 30: presenting is the queue's, after the submit
        if frame == 0 { println!("first frame presented on {label} ({format:?}, FIFO)"); }
        frame += 1;
    }
}

const FLIP_WGSL: &str = r#"
@group(0) @binding(0) var raster: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    // The projector raster was drawn BOTTOM-UP, as the app's GL canvas is (projector.rs render): row y of
    // the screen is row h-1-y of it. An exact texel copy — no filter, no scale.
    let d = textureDimensions(raster);
    return textureLoad(raster, vec2<i32>(i32(pos.x), i32(d.y) - 1 - i32(pos.y)), 0);
}
"#;

/// One projector output's presenter: the raster drawn through projector.rs whenever the window's size
/// changes (the content is a still here), then flipped onto the swapchain at EVERY vblank of its own
/// display (FIFO blocks this thread and only this one).
fn projector_loop(gpu: Arc<Gpu>, window: Arc<Window>, surface: wgpu::Surface<'static>, stop: Arc<AtomicBool>, label: String, o: ProjectorOut) {
    let d = &gpu.device;
    let caps = surface.get_capabilities(&gpu.adapter);
    // NON-sRGB, like the app's canvas: the projector shader's output is the signal, stored as is.
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let (pw, ph, px) = &*o.picture;
    let content = crate::projector::content_texture(&gpu, *pw, *ph, px);
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("flip"), source: wgpu::ShaderSource::Wgsl(FLIP_WGSL.into()) });
    let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("flip"), layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let mut configured: Option<PhysicalSize<u32>> = None;
    let mut bind: Option<wgpu::BindGroup> = None;
    let mut frames: u64 = 0;
    while !stop.load(Ordering::SeqCst) {
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 { std::thread::sleep(Duration::from_millis(50)); continue; }
        if configured != Some(size) {
            surface.configure(d, &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format, width: size.width, height: size.height,
                present_mode: wgpu::PresentMode::Fifo, desired_maximum_frame_latency: 2, alpha_mode: caps.alpha_modes[0],
                view_formats: vec![], color_space: wgpu::SurfaceColorSpace::Auto,
            });
            let raster = d.create_texture(&wgpu::TextureDescriptor {
                label: Some("projector raster"), size: wgpu::Extent3d { width: size.width, height: size.height, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
            crate::projector::draw(&gpu, &content, &o.opts, &raster.create_view(&Default::default()), wgpu::TextureFormat::Rgba8Unorm, size.width, size.height);
            let view = raster.create_view(&Default::default());
            bind = Some(d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0),
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }] }));
            configured = Some(size);
        }
        let tex = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => { std::thread::sleep(Duration::from_millis(8)); continue; }
            other => { eprintln!("present:{label}: {other:?}, reconfiguring"); configured = None; continue; }
        };
        let view = tex.texture.create_view(&Default::default());
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("flip"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&pipe); pass.set_bind_group(0, bind.as_ref(), &[]); pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
        window.pre_present_notify();
        gpu.queue.present(tex);
        if frames == 0 { println!("first frame presented on '{label}' ({format:?}, FIFO, {}x{})", size.width, size.height); }
        frames += 1;
    }
    println!("output '{label}': {frames} frames presented");
}

/// Run the windows until Esc, every window closed, or `run_for`. Returns an error if any output
/// could not be opened.
pub fn run(options: WindowOptions) -> Result<(), String> {
    let el = EventLoop::new().map_err(|e| e.to_string())?;
    let deadline = options.run_for.map(|d| Instant::now() + d);
    let mut app = App { options, gpu: None, outputs: HashMap::new(), closing: Vec::new(), exiting: false, deadline, error: None };
    el.run_app(&mut app).map_err(|e| e.to_string())?;
    match app.error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}
