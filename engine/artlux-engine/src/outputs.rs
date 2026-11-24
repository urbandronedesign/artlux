//! E1f-3 — THE PROJECTOR OUTPUTS AT RUNTIME: the engine's own windows, fed by the live document.
//!
//! In `--serve`, a WINDOWS THREAD runs a winit event loop (with_any_thread: the stdin reader keeps the main
//! thread, as in E1a) and keeps one borderless, fullscreen, TOPMOST window per projector output the engine
//! owns, on the display it names (windows.rs match_display: exact physical bounds — the host converts —
//! and an output whose display is missing is NOT opened anywhere else). Each window has its own PRESENTER
//! thread (E0b's shape: FIFO on its own display, visible from creation, never joined from the window
//! thread): it redraws the raster through projector.rs — byte-identical to the app's ProjectorGL (E1e-1) —
//! whenever its surface's picture or its settings change, and flips it onto the swapchain every vblank.
//!
//! The pictures come from the render thread (runtime.rs), which already composes every surface's source
//! for the LEDs: it publishes the projected surfaces' pictures here with a generation, so a still is
//! uploaded (and mipped) once and an effect or a HAP frame each time it moves.
//!
//! TOPMOST is the fallback, not decoration: the app keeps its own projector windows open UNDER these
//! (told they are covered, so they stop drawing). The engine dying takes its windows with it and the
//! app's are already on the display — main uncovers them and they draw on their next frame.

use crate::compose::Picture;
use crate::projector::{self, Opts};
use crate::windows::{match_display, DisplayMatch};
use crate::Gpu;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::monitor::MonitorHandle;
use winit::window::{Fullscreen, Window, WindowId, WindowLevel};

/// One output, as the document describes it.
#[derive(Clone)]
pub struct Spec {
    pub id: String,
    pub surface_id: String,
    pub display: DisplayMatch,
    pub opts: Opts,
    /// Item 3: the output's imported calibration map (the files main wrote), drawn instead of the warp.
    pub baked: Option<BakedFiles>,
}

/// A baked map as files: `uv` (f32 u, v, spare per projector pixel, NaN = no content) and an optional 8-bit
/// rig blend. `key` changes when the map does (the window is then reopened with the new one).
#[derive(Clone, PartialEq)]
pub struct BakedFiles { pub key: String, pub w: u32, pub h: u32, pub uv: String, pub alpha: Option<(u32, u32, String)> }

/// What the presenters read, shared with the render thread.
#[derive(Default)]
pub struct Shared {
    /// surface id → (generation, picture)
    pub pictures: HashMap<String, (u64, Arc<Picture>)>,
    /// output id → (settings version, settings) — brightness × opacity included, per tick.
    pub opts: HashMap<String, (u64, Opts)>,
    /// The app's cold-start hold: while the show boots every output shows BLACK, as the app's do.
    pub booting: bool,
}

/// E4a: `View3d(true)` opens the engine's 3D view window (view3d.rs), `false` closes it.
pub enum Cmd { Set(Vec<Spec>), View3d(bool), Quit }

/// E4a: the open 3D view — an ordinary window (decorated, movable to any screen, resizable), its presenter,
/// and the mouse state that drives its camera.
struct View {
    window: Arc<Window>, stop: Arc<AtomicBool>, thread: Option<std::thread::JoinHandle<()>>,
    cursor: Option<(f64, f64)>, orbit: bool, pan: bool,
}

struct Out { spec: Spec, window: Arc<Window>, stop: Arc<AtomicBool>, thread: Option<std::thread::JoinHandle<()>> }

struct App {
    gpu: Arc<Gpu>,
    shared: Arc<Mutex<Shared>>,
    outs: HashMap<String, Out>,
    closing: Vec<Out>,
    /// Called with the ids actually open, and the reason for each one that is not.
    report: Box<dyn Fn(Vec<String>, Vec<(String, String)>) + Send>,
    // ── E4a ──
    view: Option<View>,
    view_shared: Arc<Mutex<crate::view3d::Shared>>,
    view_open: Arc<AtomicBool>,
    /// Called when the operator closes the view from its title bar (main relays it to the editor).
    view_closed: Box<dyn Fn() + Send>,
    /// Presenters of closed views, reaped like the outputs'.
    view_closing: Vec<View>,
}

impl App {
    fn set(&mut self, el: &ActiveEventLoop, specs: Vec<Spec>) {
        let monitors: Vec<MonitorHandle> = el.available_monitors().collect();
        let keep: Vec<String> = specs.iter().map(|s| s.id.clone()).collect();
        for id in self.outs.keys().cloned().collect::<Vec<_>>() {
            let moved = specs.iter().find(|s| s.id == id).is_some_and(|s| {
                let o = &self.outs[&id].spec;
                s.display.bounds != o.display.bounds || s.display.index != o.display.index || s.surface_id != o.surface_id || s.baked != o.baked
            });
            if !keep.contains(&id) || moved { self.close(&id); }
        }
        let mut refused = Vec::new();
        for spec in specs {
            if self.outs.contains_key(&spec.id) { continue; }
            let i = match match_display(&monitors, &spec.display) { Ok(i) => i, Err(e) => { refused.push((spec.id.clone(), e)); continue; } };
            let m = &monitors[i];
            let attrs = Window::default_attributes()
                .with_title(format!("ArtLux output — {}", spec.id))
                .with_visible(true)
                .with_decorations(false)
                .with_fullscreen(Some(Fullscreen::Borderless(Some(m.clone()))));
            let window = match el.create_window(attrs) { Ok(w) => Arc::new(w), Err(e) => { refused.push((spec.id.clone(), format!("window: {e}"))); continue; } };
            let surface = match self.gpu.instance.create_surface(window.clone()) { Ok(s) => s, Err(e) => { refused.push((spec.id.clone(), format!("surface: {e}"))); continue; } };
            let stop = Arc::new(AtomicBool::new(false));
            let (gpu, w2, st, sh, sp) = (self.gpu.clone(), window.clone(), stop.clone(), self.shared.clone(), spec.clone());
            let thread = std::thread::Builder::new().name(format!("present:{}", spec.id))
                .spawn(move || present(gpu, w2, surface, st, sh, sp)).ok();
            eprintln!("artlux-engine: output '{}' on {}", spec.id, m.name().unwrap_or_else(|| format!("display {i}")));
            self.outs.insert(spec.id.clone(), Out { spec, window, stop, thread });
        }
        (self.report)(self.outs.keys().cloned().collect(), refused);
    }

    fn open_view(&mut self, el: &ActiveEventLoop) {
        if self.view.is_some() { if let Some(v) = &self.view { v.window.focus_window(); } return; }
        let attrs = Window::default_attributes()
            .with_title("ArtLux — 3D view (engine)")
            .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 760.0))
            .with_visible(true);
        let window = match el.create_window(attrs) { Ok(w) => Arc::new(w), Err(e) => { eprintln!("artlux-engine: 3D view window: {e}"); return; } };
        let surface = match self.gpu.instance.create_surface(window.clone()) { Ok(s) => s, Err(e) => { eprintln!("artlux-engine: 3D view surface: {e}"); return; } };
        let stop = Arc::new(AtomicBool::new(false));
        let (gpu, w2, st, sh) = (self.gpu.clone(), window.clone(), stop.clone(), self.view_shared.clone());
        let thread = std::thread::Builder::new().name("present:view3d".into()).spawn(move || crate::view3d::present(gpu, w2, surface, st, sh)).ok();
        eprintln!("artlux-engine: 3D view open");
        self.view_open.store(true, Ordering::SeqCst);
        self.view = Some(View { window, stop, thread, cursor: None, orbit: false, pan: false });
    }
    fn close_view(&mut self) {
        if self.view.is_some() { eprintln!("artlux-engine: 3D view closed"); }
        if let Some(v) = self.view.take() { v.window.set_visible(false); v.stop.store(true, Ordering::SeqCst); self.view_closing.push(v); }
        self.view_open.store(false, Ordering::SeqCst);
    }

    // Never join from the window thread (windows.rs close()): hide, stop, reap later.
    fn close(&mut self, id: &str) {
        if let Some(o) = self.outs.remove(id) { o.window.set_visible(false); o.stop.store(true, Ordering::SeqCst); self.closing.push(o); }
    }
    fn reap(&mut self) {
        self.closing.retain_mut(|o| {
            if o.thread.as_ref().is_none_or(|t| t.is_finished()) { if let Some(t) = o.thread.take() { let _ = t.join(); } false } else { true }
        });
        self.view_closing.retain_mut(|o| {
            if o.thread.as_ref().is_none_or(|t| t.is_finished()) { if let Some(t) = o.thread.take() { let _ = t.join(); } false } else { true }
        });
    }
}

impl ApplicationHandler<Cmd> for App {
    fn resumed(&mut self, _el: &ActiveEventLoop) {}
    fn user_event(&mut self, el: &ActiveEventLoop, cmd: Cmd) {
        match cmd {
            Cmd::Set(specs) => self.set(el, specs),
            Cmd::View3d(true) => self.open_view(el),
            Cmd::View3d(false) => self.close_view(),
            Cmd::Quit => { for id in self.outs.keys().cloned().collect::<Vec<_>>() { self.close(&id); } self.close_view(); el.exit(); }
        }
    }
    fn window_event(&mut self, _el: &ActiveEventLoop, id: WindowId, e: WindowEvent) {
        // An OUTPUT is not closed from the wall: the host decides what is open (an Alt-F4 on a projector
        // would otherwise silently hand the display back to nobody). The 3D VIEW is the operator's own
        // window: its title bar closes it, and its mouse drives its camera.
        let Some(v) = self.view.as_mut().filter(|v| v.window.id() == id) else { return };
        use winit::event::{ElementState, MouseButton, MouseScrollDelta};
        match e {
            WindowEvent::CloseRequested => { self.close_view(); (self.view_closed)(); }
            WindowEvent::MouseInput { state, button, .. } => {
                let down = state == ElementState::Pressed;
                match button { MouseButton::Left => v.orbit = down, MouseButton::Right | MouseButton::Middle => v.pan = down, _ => {} }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some((x, y)) = v.cursor {
                    let (dx, dy) = ((position.x - x) as f32, (position.y - y) as f32);
                    if v.orbit || v.pan {
                        let h = v.window.inner_size().height as f32;
                        let mut s = self.view_shared.lock().unwrap();
                        if v.orbit { s.cam.orbit(dx, dy); } else { s.cam.pan(dx, dy, h); }
                    }
                }
                v.cursor = Some((position.x, position.y));
            }
            WindowEvent::CursorLeft { .. } => { v.cursor = None; }
            WindowEvent::MouseWheel { delta, .. } => {
                let n = match delta { MouseScrollDelta::LineDelta(_, y) => y, MouseScrollDelta::PixelDelta(p) => (p.y / 60.0) as f32 };
                self.view_shared.lock().unwrap().cam.zoom(n);
            }
            _ => {}
        }
    }
    fn about_to_wait(&mut self, el: &ActiveEventLoop) {
        self.reap();
        el.set_control_flow(if self.closing.is_empty() { ControlFlow::Wait } else { ControlFlow::WaitUntil(std::time::Instant::now() + Duration::from_millis(5)) });
    }
}

/// What the render thread hands the windows thread once it is ready: the outputs' shared state and report,
/// and (E4a) the 3D view's shared state, its open flag and the "closed from its title bar" callback.
type Go = (Arc<Mutex<Shared>>, Box<dyn Fn(Vec<String>, Vec<(String, String)>) + Send>,
           Arc<Mutex<crate::view3d::Shared>>, Arc<AtomicBool>, Box<dyn Fn() + Send>);

/// The windows thread OPENS THE GPU. Measured: a device opened on another thread (the stdin thread) made
/// surfaces that were valid when created and "Invalid surface" when the presenter configured them — the
/// presenter panicked and took the engine with it. Opened here, on the event loop's thread with its
/// display handle — exactly as E0b / E1e-2 do (windows.rs), which present fine — they work.
pub struct Pending {
    pub gpu: Arc<Gpu>,
    proxy: Option<EventLoopProxy<Cmd>>,
    go: std::sync::mpsc::Sender<Go>,
}

/// Start the windows thread and open the GPU on it. Err(None): no window system (open the GPU without
/// windows); Err(Some(e)): the GPU itself refused (no usable adapter — the engine exits 2).
pub fn prepare(policy: crate::AdapterPolicy) -> Result<Pending, Option<crate::EngineError>> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(EventLoopProxy<Cmd>, Arc<Gpu>), Option<crate::EngineError>>>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<Go>();
    std::thread::Builder::new().name("windows".into()).spawn(move || {
        let mut b = EventLoop::<Cmd>::with_user_event();
        #[cfg(windows)]
        { use winit::platform::windows::EventLoopBuilderExtWindows; b.with_any_thread(true); }
        let el = match b.build() { Ok(e) => e, Err(e) => { eprintln!("artlux-engine: no window event loop: {e}"); let _ = tx.send(Err(None)); return; } };
        let display: crate::Display = Box::new(el.owned_display_handle());
        let gpu = match Gpu::open_with(policy, Some(display)) { Ok(g) => Arc::new(g), Err(e) => { let _ = tx.send(Err(Some(e))); return; } };
        let _ = tx.send(Ok((el.create_proxy(), gpu.clone())));
        let Ok((shared, report, view_shared, view_open, view_closed)) = go_rx.recv() else { return };
        let mut app = App { gpu, shared, outs: HashMap::new(), closing: Vec::new(), report,
            view: None, view_shared, view_open, view_closed, view_closing: Vec::new() };
        let _ = el.run_app(&mut app);
    }).map_err(|_| None)?;
    let (proxy, gpu) = rx.recv().map_err(|_| None)??;
    Ok(Pending { gpu, proxy: Some(proxy), go: go_tx })
}

impl Pending {
    /// Start the outputs; returns the proxy the render thread sends `Cmd`s through.
    pub fn attach(mut self, shared: Arc<Mutex<Shared>>, report: Box<dyn Fn(Vec<String>, Vec<(String, String)>) + Send>,
                  view: Arc<Mutex<crate::view3d::Shared>>, view_open: Arc<AtomicBool>, view_closed: Box<dyn Fn() + Send>) -> Option<EventLoopProxy<Cmd>> {
        self.go.send((shared, report, view, view_open, view_closed)).ok()?;
        self.proxy.take()
    }
}

/// One output's presenter: redraw the raster when the picture or the settings move, flip it every vblank.
fn present(gpu: Arc<Gpu>, window: Arc<Window>, surface: wgpu::Surface<'static>, stop: Arc<AtomicBool>, shared: Arc<Mutex<Shared>>, spec: Spec) {
    let d = &gpu.device;
    let caps = surface.get_capabilities(&gpu.adapter);
    // NON-sRGB, like the app's canvas (E1e-2): the shader's output is the signal, stored as is.
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("flip"), source: wgpu::ShaderSource::Wgsl(crate::windows::FLIP_WGSL.into()) });
    let pipe = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("flip"), layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
    });
    let mut configured: Option<PhysicalSize<u32>> = None;
    let mut raster: Option<(wgpu::Texture, wgpu::BindGroup)> = None;
    let mut content: Option<(u64, wgpu::Texture)> = None;
    // Item 3: the calibration map, uploaded ONCE (a map is ~10 MB; the app also uploads it once).
    let baked: Option<projector::Baked> = spec.baked.as_ref().and_then(|b| {
        let raw = std::fs::read(&b.uv).map_err(|e| eprintln!("artlux-engine: output '{}': map {}: {e}", spec.id, b.uv)).ok()?;
        let uv: Vec<f32> = raw.chunks_exact(4).map(|q| f32::from_le_bytes([q[0], q[1], q[2], q[3]])).collect();
        if uv.len() < (b.w * b.h * 3) as usize { eprintln!("artlux-engine: output '{}': the map is short", spec.id); return None; }
        let alpha = b.alpha.as_ref().and_then(|(aw, ah, f)| std::fs::read(f).ok().map(|d| (*aw, *ah, d)));
        Some(projector::baked_upload(&gpu, b.w, b.h, &uv, alpha.as_ref().map(|(aw, ah, d)| (*aw, *ah, d.as_slice()))))
    });
    let mut drawn: Option<(u64, u64, bool, PhysicalSize<u32>)> = None;   // (picture gen, opts version, booting, size)
    while !stop.load(Ordering::SeqCst) {
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 { std::thread::sleep(Duration::from_millis(50)); continue; }
        if configured != Some(size) {
            surface.configure(d, &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format, width: size.width, height: size.height,
                present_mode: wgpu::PresentMode::Fifo, desired_maximum_frame_latency: 2, alpha_mode: caps.alpha_modes[0],
                view_formats: vec![], color_space: wgpu::SurfaceColorSpace::Auto,
            });
            let tex = d.create_texture(&wgpu::TextureDescriptor {
                label: Some("projector raster"), size: wgpu::Extent3d { width: size.width, height: size.height, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
            let view = tex.create_view(&Default::default());
            let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0),
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }] });
            raster = Some((tex, bind));
            configured = Some(size);
            drawn = None;
            // TOPMOST only AFTER the swapchain exists. Created always-on-top AND borderless-fullscreen, the
            // window's surface could not be configured at all ("Invalid surface", measured; without the
            // level it presents). Raised now, it sits above the app's covered window on this display.
            window.set_window_level(WindowLevel::AlwaysOnTop);
        }
        // What to show now: the surface's picture and this output's settings, as last published.
        let (pic, opts, booting) = {
            let s = shared.lock().unwrap();
            (s.pictures.get(&spec.surface_id).cloned(), s.opts.get(&spec.id).cloned(), s.booting)
        };
        let (ov, o) = opts.unwrap_or((0, spec.opts.clone()));
        let gen = pic.as_ref().map_or(0, |p| p.0);
        if drawn != Some((gen, ov, booting, size)) {
            if let Some((tex, _)) = &raster {
                let target = tex.create_view(&Default::default());
                match (&pic, booting) {
                    (Some((g, p)), false) => {
                        if content.as_ref().map(|c| c.0) != Some(*g) {
                            // Item 2c-4: a picture already on the GPU (an MP4 frame — the render thread and these
                            // presenters share ONE device, serve.rs) is copied there, its visible rect only.
                            content = Some((*g, match &p.tex {
                                Some(t) => projector::content_texture_from(&gpu, t, p.crop.unwrap_or([0, 0, p.w, p.h])),
                                None => projector::content_texture(&gpu, p.w, p.h, &p.rgba),
                            }));
                        }
                        if let Some((_, ct)) = &content {
                            match &baked {
                                Some(b) => projector::draw_baked(&gpu, ct, b, &o, &target, wgpu::TextureFormat::Rgba8Unorm, size.width, size.height),
                                None => projector::draw(&gpu, ct, &o, &target, wgpu::TextureFormat::Rgba8Unorm, size.width, size.height),
                            }
                        }
                    }
                    // Booting, or no picture: BLACK — the app's output draws black there too.
                    _ => {
                        let mut enc = d.create_command_encoder(&Default::default());
                        enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("black"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &target, depth_slice: None, resolve_target: None,
                            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
                        gpu.queue.submit([enc.finish()]);
                    }
                }
            }
            drawn = Some((gen, ov, booting, size));
        }
        let tex = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => { std::thread::sleep(Duration::from_millis(8)); continue; }
            _ => { configured = None; continue; }
        };
        let view = tex.texture.create_view(&Default::default());
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("flip"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&pipe); pass.set_bind_group(0, raster.as_ref().map(|r| &r.1), &[]); pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
        window.pre_present_notify();
        gpu.queue.present(tex);
    }
}
