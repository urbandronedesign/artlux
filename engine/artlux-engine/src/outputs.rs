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
    /// E4b: where the left button went down and how far the cursor has travelled since — a press that ends
    /// within CLICK_PX of where it started is a CLICK (a pick), anything further was an orbit.
    press: Option<(f64, f64)>, travel: f64,
    /// Shift or Ctrl held: a click ADDS to (or takes from) the editor's selection.
    additive: bool,
    /// E4b: the place last reported, its un-maximised rect, and when it last changed — reported to main
    /// PLACE_SETTLE after the last move / resize (a drag is hundreds of events; main writes a prefs file).
    reported: Option<crate::view3d::Place>, normal: Option<(i32, i32, u32, u32)>, moved_at: Option<std::time::Instant>,
    /// E4b: a gizmo drag — the handle, the gizmo as grabbed, where along the axis the press was, the offset last
    /// sent and when (moves are sent at most every MOVE_EVERY).
    grab: Option<Grab>,
}
const MOVE_EVERY: Duration = Duration::from_millis(16);
/// A held gizmo handle: which, the gizmo as grabbed, the reading at the press and the last one (a rotate's angle
/// unwrapped across ±π), the gesture last sent and when.
struct Grab { axis: usize, g: crate::gizmo::Gizmo, r0: f32, r_prev: f32, unwrapped: f32, last: crate::gizmo::Gesture, sent: std::time::Instant }
const PLACE_SETTLE: Duration = Duration::from_millis(500);
const CLICK_PX: f64 = 4.0;

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
    /// Tells main what the operator did in the window: `{"type":"view3d","open":false}` (closed from its title
    /// bar) or `{"type":"view3dPick",…}` (a click — E4b). Main relays both to the editor.
    view_event: Box<dyn Fn(String) + Send>,
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
        let mut attrs = Window::default_attributes()
            .with_title("ArtLux — 3D view (engine)")
            .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 760.0))
            .with_visible(true);
        // E4b: where the operator had it, if that screen is still here (view3d.rs Place).
        let place = self.view_shared.lock().unwrap().place;
        let monitors: Vec<(i32, i32, u32, u32)> = el.available_monitors().map(|m| (m.position().x, m.position().y, m.size().width, m.size().height)).collect();
        match place {
            Some(p) if p.on_screen(&monitors) => {
                attrs = attrs.with_position(winit::dpi::PhysicalPosition::new(p.x, p.y)).with_inner_size(PhysicalSize::new(p.w, p.h)).with_maximized(p.max);
                eprintln!("artlux-engine: 3D view placed where it was: {}", p.to_json());
            }
            Some(p) => eprintln!("artlux-engine: 3D view: its saved place {} is on no screen now — opened at the default", p.to_json()),
            None => {}
        }
        let window = match el.create_window(attrs) { Ok(w) => Arc::new(w), Err(e) => { eprintln!("artlux-engine: 3D view window: {e}"); return; } };
        let surface = match self.gpu.instance.create_surface(window.clone()) { Ok(s) => s, Err(e) => { eprintln!("artlux-engine: 3D view surface: {e}"); return; } };
        let stop = Arc::new(AtomicBool::new(false));
        let (gpu, w2, st, sh) = (self.gpu.clone(), window.clone(), stop.clone(), self.view_shared.clone());
        let thread = std::thread::Builder::new().name("present:view3d".into()).spawn(move || crate::view3d::present(gpu, w2, surface, st, sh)).ok();
        eprintln!("artlux-engine: 3D view open");
        self.view_open.store(true, Ordering::SeqCst);
        let reported = place.filter(|p| p.on_screen(&monitors));
        self.view = Some(View { window, stop, thread, cursor: None, orbit: false, pan: false, press: None, travel: 0.0, additive: false,
            reported, normal: reported.map(|p| (p.x, p.y, p.w, p.h)), moved_at: None, grab: None });
    }
    /// E4b: the window's place now — its un-maximised rect while maximised.
    fn place_now(v: &mut View) -> Option<crate::view3d::Place> {
        let max = v.window.is_maximized();
        if !max && !v.window.is_minimized().unwrap_or(false) {
            let (p, s) = (v.window.outer_position().ok()?, v.window.inner_size());
            v.normal = Some((p.x, p.y, s.width, s.height));
        }
        let (x, y, w, h) = v.normal?;
        Some(crate::view3d::Place { x, y, w, h, max })
    }
    /// Report the place if it changed (`force`: now, else once it has settled).
    fn report_place(&mut self, force: bool) {
        let Some(v) = self.view.as_mut() else { return };
        let Some(at) = v.moved_at else { return };
        if !force && at.elapsed() < PLACE_SETTLE { return; }
        v.moved_at = None;
        let Some(p) = Self::place_now(v) else { return };
        if v.reported == Some(p) { return; }
        v.reported = Some(p);
        eprintln!("artlux-engine: 3D view place: {}", p.to_json());
        (self.view_event)(format!(r#"{{"type":"view3dPlace","place":{}}}"#, p.to_json()));
    }
    fn close_view(&mut self) {
        self.report_place(true);
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
            WindowEvent::CloseRequested => { self.close_view(); (self.view_event)(r#"{"type":"view3d","open":false}"#.to_string()); }
            WindowEvent::ModifiersChanged(m) => { v.additive = m.state().shift_key() || m.state().control_key(); }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => { v.moved_at = Some(std::time::Instant::now()); }
            WindowEvent::MouseInput { state, button, .. } => {
                let down = state == ElementState::Pressed;
                match button { MouseButton::Left => v.orbit = down, MouseButton::Right | MouseButton::Middle => v.pan = down, _ => {} }
                // E4b: a press on a gizmo handle grabs it — no orbit, no pick.
                if button == MouseButton::Left && down {
                    if let Some((cx, cy)) = v.cursor {
                        let size = v.window.inner_size();
                        let mut s = self.view_shared.lock().unwrap();
                        let g = s.scene.as_ref().and_then(|(_, sc)| sc.gizmo);
                        if let (Some(g), Some(axis)) = (g, s.hover_axis) {
                            let (o, d) = s.cam.ray(cx as f32, cy as f32, size.width as f32, size.height as f32);
                            if let Some(r0) = crate::gizmo::reading(&g, axis, o, d) {
                                let ids = s.scene.as_ref().map(|(_, sc)| sc.look.selected.clone()).unwrap_or_default();
                                s.drag = Some(crate::gizmo::Drag { ids, at: g.at, q: g.q, g: crate::gizmo::Gesture::NONE, axis, ended_at_scene: None });
                                drop(s);
                                v.grab = Some(Grab { axis, g, r0, r_prev: r0, unwrapped: r0, last: crate::gizmo::Gesture::NONE, sent: std::time::Instant::now() });
                                v.orbit = false;
                                v.press = None;
                                eprintln!("artlux-engine: 3D view gizmo: grabbed the {} {} handle", ["X", "Y", "Z"][axis], match g.mode { crate::gizmo::Mode::Move => "move", crate::gizmo::Mode::Rotate => "rotate", crate::gizmo::Mode::Scale => "scale" });
                                (self.view_event)(format!(r#"{{"type":"view3dGizmo","phase":"start",{}}}"#, crate::gizmo::Gesture::NONE.to_json()));
                                return;
                            }
                        }
                    }
                }
                if button == MouseButton::Left && !down {
                    if let Some(gr) = v.grab.take() {
                        let last = gr.last;
                        let mut s = self.view_shared.lock().unwrap();
                        let ver = s.scene.as_ref().map(|(ver, _)| *ver);
                        if let Some(dg) = s.drag.as_mut() { dg.g = last; dg.ended_at_scene = ver; }
                        drop(s);
                        let turned = 2.0 * last.rot[3].clamp(-1.0, 1.0).acos().to_degrees();
                        eprintln!("artlux-engine: 3D view gizmo: released at [{:.4}, {:.4}, {:.4}] turned {:.2} deg scaled [{:.3}, {:.3}, {:.3}]",
                            last.delta[0], last.delta[1], last.delta[2], turned, last.scale[0], last.scale[1], last.scale[2]);
                        (self.view_event)(format!(r#"{{"type":"view3dGizmo","phase":"end",{}}}"#, last.to_json()));
                        return;
                    }
                }
                if button == MouseButton::Left {
                    if down { v.press = v.cursor; v.travel = 0.0; }
                    else if let (Some((x, y)), true) = (v.press.take(), v.travel <= CLICK_PX) {
                        // A click: the fixture under it, from the camera as it is now. None = empty space, which
                        // clears the editor's selection — what a click on nothing does in the editor's view.
                        let size = v.window.inner_size();
                        let s = self.view_shared.lock().unwrap();
                        let picked = s.scene.as_ref().and_then(|(_, sc)| {
                            let (o, d) = s.cam.ray(x as f32, y as f32, size.width as f32, size.height as f32);
                            let px = 2.0 * (s.cam.fov.to_radians() / 2.0).tan() / (size.height as f32).max(1.0);
                            crate::view3d::pick_any(sc, &s.meshes, o, d, px)
                        });
                        drop(s);
                        let js = |x: &str| serde_json::to_string(x).unwrap_or_else(|_| "null".into());
                        let (id, model, what) = match &picked {
                            Some(crate::view3d::Picked::Fixture(f)) => (js(f), "null".to_string(), f.clone()),
                            Some(crate::view3d::Picked::Model(m)) => ("null".to_string(), js(m), format!("model {m}")),
                            None => ("null".to_string(), "null".to_string(), "(nothing)".to_string()),
                        };
                        eprintln!("artlux-engine: 3D view pick: {what}{}", if v.additive { " (add)" } else { "" });
                        (self.view_event)(format!(r#"{{"type":"view3dPick","id":{id},"model":{model},"add":{}}}"#, v.additive));
                    }
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let Some((x, y)) = v.cursor {
                    let (dx, dy) = ((position.x - x) as f32, (position.y - y) as f32);
                    if v.press.is_some() { v.travel += ((dx * dx + dy * dy) as f64).sqrt(); }
                    // E4b: a gizmo drag — the pull along the held axis, read off the cursor's ray each move.
                    if let Some(gr) = v.grab.as_mut() {
                        let size = v.window.inner_size();
                        let mut s = self.view_shared.lock().unwrap();
                        let (o, d) = s.cam.ray(position.x as f32, position.y as f32, size.width as f32, size.height as f32);
                        if let Some(r) = crate::gizmo::reading(&gr.g, gr.axis, o, d) {
                            // A rotate's angle is unwrapped: a drag past half a turn keeps counting.
                            let r = if gr.g.mode == crate::gizmo::Mode::Rotate {
                                let mut step = r - gr.r_prev;
                                if step > std::f32::consts::PI { step -= std::f32::consts::TAU; } else if step < -std::f32::consts::PI { step += std::f32::consts::TAU; }
                                gr.r_prev = r;
                                gr.unwrapped += step;
                                gr.unwrapped
                            } else { r };
                            let ge = crate::gizmo::gesture(&gr.g, gr.axis, gr.r0, r);
                            if let Some(dg) = s.drag.as_mut() { dg.g = ge; }
                            drop(s);
                            if ge != gr.last && gr.sent.elapsed() >= MOVE_EVERY {
                                gr.last = ge; gr.sent = std::time::Instant::now();
                                (self.view_event)(format!(r#"{{"type":"view3dGizmo","phase":"move",{}}}"#, ge.to_json()));
                            } else if ge != gr.last {
                                gr.last = ge;   // the release sends the final gesture whatever the throttle held back
                            }
                        }
                        v.cursor = Some((position.x, position.y));
                        return;
                    }
                    // Hover: which handle a press would grab.
                    if !v.orbit && !v.pan {
                        let size = v.window.inner_size();
                        let mut s = self.view_shared.lock().unwrap();
                        let hot = s.scene.as_ref().and_then(|(_, sc)| sc.gizmo).and_then(|g| {
                            let (w, h) = (size.width as f32, size.height as f32);
                            let (vp, _, _) = crate::view3d::camera_frame(&s.cam, w / h.max(1.0));
                            let px = 2.0 * (s.cam.fov.to_radians() / 2.0).tan() / h.max(1.0);
                            crate::gizmo::hit(&g, &vp, s.cam.eye(), px, w, h, position.x as f32, position.y as f32)
                        });
                        s.hover_axis = hot;
                    }
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
        self.report_place(false);
        let settle = self.view.as_ref().and_then(|v| v.moved_at).map(|t| t + PLACE_SETTLE);
        el.set_control_flow(if !self.closing.is_empty() { ControlFlow::WaitUntil(std::time::Instant::now() + Duration::from_millis(5)) }
            else if let Some(t) = settle { ControlFlow::WaitUntil(t) } else { ControlFlow::Wait });
    }
}

/// What the render thread hands the windows thread once it is ready: the outputs' shared state and report,
/// and (E4a) the 3D view's shared state, its open flag and the "closed from its title bar" callback.
type Go = (Arc<Mutex<Shared>>, Box<dyn Fn(Vec<String>, Vec<(String, String)>) + Send>,
           Arc<Mutex<crate::view3d::Shared>>, Arc<AtomicBool>, Box<dyn Fn(String) + Send>);

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
        let Ok((shared, report, view_shared, view_open, view_event)) = go_rx.recv() else { return };
        let mut app = App { gpu, shared, outs: HashMap::new(), closing: Vec::new(), report,
            view: None, view_shared, view_open, view_event, view_closing: Vec::new() };
        let _ = el.run_app(&mut app);
    }).map_err(|_| None)?;
    let (proxy, gpu) = rx.recv().map_err(|_| None)??;
    Ok(Pending { gpu, proxy: Some(proxy), go: go_tx })
}

impl Pending {
    /// Start the outputs; returns the proxy the render thread sends `Cmd`s through.
    pub fn attach(mut self, shared: Arc<Mutex<Shared>>, report: Box<dyn Fn(Vec<String>, Vec<(String, String)>) + Send>,
                  view: Arc<Mutex<crate::view3d::Shared>>, view_open: Arc<AtomicBool>, view_event: Box<dyn Fn(String) + Send>) -> Option<EventLoopProxy<Cmd>> {
        self.go.send((shared, report, view, view_open, view_event)).ok()?;
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
