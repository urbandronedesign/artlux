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
    /// E6f: a WINDOWED output — an ordinary decorated window the operator moves and resizes, opened where the
    /// app's (hidden) window is: its CONTENT rect in physical pixels (x, y, w, h). None = fullscreen on `display`.
    pub window: Option<(i32, i32, u32, u32)>,
    /// The output's name — a windowed output's title, as the app titles its window.
    pub title: String,
    /// E6f: a windowed output's badge — the raster key (`badge:<surface>`) of the app's own bitmap, drawn at
    /// BADGE_AT × the window's scale with BADGE_OPACITY, as the app's window draws it (components/brand/badge.ts).
    pub badge: Option<String>,
    /// E6f: an NDI SEND of this output — its source name and the app's capture cap (ProjectorApp captureNdi: the
    /// window's pixels, fitted within it). Sent every ≥ 33 ms, as the app's window sends.
    pub ndi: Option<NdiOut>,
}

#[derive(Clone, PartialEq)]
pub struct NdiOut { pub name: String, pub max: (u32, u32) }

/// E6f: the app's capture size (ProjectorGL.captureRGBA): the window's size, or fitted within the cap — aspect kept,
/// each side `max(1, round(side × r))`, never upscaled.
pub fn ndi_fit(cw: u32, ch: u32, (mw, mh): (u32, u32)) -> (u32, u32) {
    if cw <= mw && ch <= mh { return (cw, ch); }
    let r = (mw as f64 / cw as f64).min(mh as f64 / ch as f64);
    (((cw as f64 * r).round() as u32).max(1), ((ch as f64 * r).round() as u32).max(1))
}

/// E6f: where and how the app draws a windowed output's badge (components/brand/badge.ts BADGE, CSS pixels).
const BADGE_AT: (f64, f64) = (14.0, 12.0);
// 0.85 as CHROMIUM APPLIES IT: a layer's opacity is quantised to 8 bits (round(0.85 × 255) = 217) — measured: at
// exactly 0.85 every one of 674 differing badge pixels was the app's value minus 1 (238 × 0.85 = 202.3 → 202, the
// app 203 = 238 × 217/255 = 202.5).
const BADGE_OPACITY: f32 = 217.0 / 255.0;
const BADGE_WGSL: &str = r#"
@group(0) @binding(0) var t: texture_2d<f32>;
struct U { off: vec2<f32>, op: f32, pad: f32 };
@group(0) @binding(1) var<uniform> u: U;
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    // 1:1 texel copy (the bitmap is at the window's scale), premultiplied, times the layer's opacity — drawn on the
    // SWAPCHAIN, top-down, after the flip: window chrome over the output, never IN it (the app's NDI capture reads
    // its GL canvas, under the DOM badge — measured: a badge in the raster put 2 659 pixels into the NDI frame).
    return textureLoad(t, vec2<i32>(p.xy - u.off), 0) * u.op;
}
"#;

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
    /// E6f: raster key → (generation, picture) of each windowed output's badge.
    pub badges: HashMap<String, (u64, Arc<Picture>)>,
    /// E6f: output id → (version, venue) of each calibrated output in RENDER mode (calib3d.rs) — drawn instead of
    /// its surface. The surfaces the venue shows are published in `pictures` as `venue:<surface id>`.
    pub calib: HashMap<String, (u64, Arc<crate::calib3d::View>)>,
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

struct Out {
    spec: Spec, window: Arc<Window>, stop: Arc<AtomicBool>, thread: Option<std::thread::JoinHandle<()>>,
    /// E6f, windowed: the content rect last reported to main, and when the window last moved or resized.
    reported: Option<(i32, i32, u32, u32)>, moved_at: Option<std::time::Instant>,
}

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
                // E6f: a windowed output is NOT reopened when its rect changes — it is moved (below).
                s.window.is_some() != o.window.is_some() || (s.window.is_none() && (s.display.bounds != o.display.bounds || s.display.index != o.display.index))
                    || s.surface_id != o.surface_id || s.baked != o.baked || s.ndi != o.ndi
            });
            if !keep.contains(&id) || moved { self.close(&id); }
        }
        // E6f: a windowed output main PLACED (its layout of windowed outputs) where the operator's window is not.
        // The rect it sends back after the engine's own report is that report — no move, no loop.
        for spec in &specs {
            let (Some(r), Some(o)) = (spec.window, self.outs.get_mut(&spec.id)) else { continue };
            if o.reported != Some(r) && Self::content_rect(&o.window) != Some(r) {
                Self::place_content(&o.window, r);
                o.reported = Some(r);
                eprintln!("artlux-engine: output '{}' windowed, {}x{} at ({}, {}) — placed by the host", spec.id, r.2, r.3, r.0, r.1);
            }
            o.spec.title = spec.title.clone();
            o.window.set_title(&spec.title);
        }
        let mut refused = Vec::new();
        for spec in specs {
            if self.outs.contains_key(&spec.id) { continue; }
            let (attrs, place) = if let Some((x, y, w, h)) = spec.window {
                // E6f: WINDOWED — decorated, movable, resizable, NOT topmost (the app's windowed output is an ordinary
                // window too), shown without taking focus (the app's showInactive), on the taskbar like the app's.
                // Placed by its CONTENT rect: created there, then shifted by the frame once the frame is known.
                if !monitors.iter().any(|m| { let (p, s) = (m.position(), m.size()); x < p.x + s.width as i32 && x + w as i32 > p.x && y < p.y + s.height as i32 && y + h as i32 > p.y }) {
                    refused.push((spec.id.clone(), format!("its window ({w}x{h} at {x}, {y}) is on no display")));
                    continue;
                }
                (Window::default_attributes().with_title(spec.title.clone()).with_visible(true).with_active(false)
                    .with_position(winit::dpi::PhysicalPosition::new(x, y)).with_inner_size(PhysicalSize::new(w, h)),
                 format!("windowed, {w}x{h} at ({x}, {y})"))
            } else {
                let i = match match_display(&monitors, &spec.display) { Ok(i) => i, Err(e) => { refused.push((spec.id.clone(), e)); continue; } };
                let m = &monitors[i];
                (Window::default_attributes()
                    .with_title(format!("ArtLux output — {}", spec.id))
                    .with_visible(true)
                    .with_decorations(false)
                    .with_fullscreen(Some(Fullscreen::Borderless(Some(m.clone())))),
                 format!("on {}", m.name().unwrap_or_else(|| format!("display {i}"))))
            };
            let window = match el.create_window(attrs) { Ok(w) => Arc::new(w), Err(e) => { refused.push((spec.id.clone(), format!("window: {e}"))); continue; } };
            if let Some(r) = spec.window { Self::place_content(&window, r); }
            let surface = match self.gpu.instance.create_surface(window.clone()) { Ok(s) => s, Err(e) => { refused.push((spec.id.clone(), format!("surface: {e}"))); continue; } };
            let stop = Arc::new(AtomicBool::new(false));
            let (gpu, w2, st, sh, sp) = (self.gpu.clone(), window.clone(), stop.clone(), self.shared.clone(), spec.clone());
            let thread = std::thread::Builder::new().name(format!("present:{}", spec.id))
                .spawn(move || present(gpu, w2, surface, st, sh, sp)).ok();
            eprintln!("artlux-engine: output '{}' {place}", spec.id);
            let reported = spec.window;
            self.outs.insert(spec.id.clone(), Out { spec, window, stop, thread, reported, moved_at: None });
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

    /// E6f: a window's CONTENT rect on the screen, physical pixels.
    fn content_rect(w: &Window) -> Option<(i32, i32, u32, u32)> {
        let (p, s) = (w.inner_position().ok()?, w.inner_size());
        Some((p.x, p.y, s.width, s.height))
    }
    /// E6f: put a window's CONTENT at `r` — winit places the OUTER frame, so shift by the frame's own offset.
    fn place_content(w: &Window, (x, y, cw, ch): (i32, i32, u32, u32)) {
        let _ = w.request_inner_size(PhysicalSize::new(cw, ch));
        if let (Ok(o), Ok(i)) = (w.outer_position(), w.inner_position()) {
            w.set_outer_position(winit::dpi::PhysicalPosition::new(x - (i.x - o.x), y - (i.y - o.y)));
        }
    }
    /// E6f: tell main where each windowed output now is, once a move / resize has settled (`force`: now) — main
    /// puts the app's hidden window there, so the fallback reappears where the operator left this one, at its size.
    fn report_outputs(&mut self, force: bool) {
        for (id, o) in self.outs.iter_mut() {
            let Some(at) = o.moved_at else { continue };
            if !force && at.elapsed() < PLACE_SETTLE { continue; }
            o.moved_at = None;
            if o.window.is_minimized().unwrap_or(false) { continue; }
            let Some(r) = Self::content_rect(&o.window) else { continue };
            if o.reported == Some(r) { continue; }
            o.reported = Some(r);
            eprintln!("artlux-engine: output '{id}' windowed, {}x{} at ({}, {})", r.2, r.3, r.0, r.1);
            (self.view_event)(format!(r#"{{"type":"outputPlace","id":{},"x":{},"y":{},"w":{},"h":{}}}"#, serde_json::to_string(id).unwrap_or_default(), r.0, r.1, r.2, r.3));
        }
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
        // E6f: a WINDOWED output is the operator's window too — closed from its title bar it is closed in the app
        // (main closes the app's window as if the operator had), and its moves are reported.
        if let Some(oid) = self.outs.iter().find(|(_, o)| o.window.id() == id && o.spec.window.is_some()).map(|(k, _)| k.clone()) {
            match e {
                WindowEvent::CloseRequested => {
                    eprintln!("artlux-engine: output '{oid}' closed from its title bar");
                    self.close(&oid);
                    (self.view_event)(format!(r#"{{"type":"outputClosed","id":{}}}"#, serde_json::to_string(&oid).unwrap_or_default()));
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => { if let Some(o) = self.outs.get_mut(&oid) { o.moved_at = Some(std::time::Instant::now()); } }
                _ => {}
            }
            return;
        }
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
                                // Whose drawing the drag moves: the selected venue model's (a model gizmo), else the fixtures'.
                                let ids = s.scene.as_ref().map(|(_, sc)| if g.model { sc.selected_model.iter().cloned().collect() } else { sc.look.selected.clone() }).unwrap_or_default();
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
        self.report_outputs(false);
        let settle = self.view.as_ref().and_then(|v| v.moved_at).into_iter().chain(self.outs.values().filter_map(|o| o.moved_at)).min().map(|t| t + PLACE_SETTLE);
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
    // E6f: the badge pass (a windowed output only) and the badge as last uploaded.
    let badge_pipe = spec.badge.as_ref().map(|_| {
        let m = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("badge"), source: wgpu::ShaderSource::Wgsl(BADGE_WGSL.into()) });
        d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("badge"), layout: None,
            vertex: wgpu::VertexState { module: &m, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &m, entry_point: Some("fs"), targets: &[Some(wgpu::ColorTargetState {
                format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        })
    });
    let mut badge_tex: Option<(u64, wgpu::BindGroup, u32, u32)> = None;
    // E6f: the venue renderer of a calibrated output in render mode, made the first time it is one.
    let mut calib_r: Option<crate::calib3d::Renderer> = None;
    // E6f: with a RESIDUAL WARP, the venue is drawn into its own canvas, which the warp stage then bends (path B).
    let mut calib_canvas: Option<(u32, u32, wgpu::Texture, wgpu::TextureView)> = None;
    let mut calib_content: Option<projector::CanvasContent> = None;
    let mut calib_warp: Option<projector::Warp> = None;
    // E6f: this output's NDI send — the app's capture of its window (a LINEAR blit, flipped to top-first: crop.rs
    // samples bilinearly at each pixel's centre from level 0, upside down), every ≥ 33 ms.
    #[cfg(feature = "ndi")]
    let ndi_send = spec.ndi.as_ref().map(|n| (crate::ndi::NdiSend::new(&n.name), n.max, crate::crop::Cropper::new(&gpu)));
    let mut ndi_at = std::time::Instant::now() - Duration::from_secs(1);
    // E6h: this output's last picture, for main to show across an engine death (hold.rs ProjHold) — the raster turned
    // top-first by the same exact same-size crop the NDI capture uses, every PROJ_EVERY.
    let mut proj_hold = crate::hold::ProjHold::open(&spec.id).map(|h| (h, crate::crop::Cropper::new(&gpu)));
    let mut proj_hold_at = std::time::Instant::now() - crate::hold::PROJ_EVERY;
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
            // E6f: not a WINDOWED output — that one is an ordinary window, like the app's.
            if spec.window.is_none() { window.set_window_level(WindowLevel::AlwaysOnTop); }
        }
        // What to show now: the surface's picture and this output's settings, as last published.
        let (pic, opts, booting, badge, calib) = {
            let s = shared.lock().unwrap();
            // E6f: in render mode, the venue and the pictures of the surfaces it shows.
            let calib = s.calib.get(&spec.id).map(|(_, v)| {
                let pics: HashMap<String, (u64, Arc<Picture>)> = v.surfaces().into_iter()
                    .filter_map(|sid| s.pictures.get(&format!("venue:{sid}")).cloned().map(|p| (sid, p))).collect();
                (v.clone(), pics)
            });
            (s.pictures.get(&spec.surface_id).cloned(), s.opts.get(&spec.id).cloned(), s.booting, spec.badge.as_ref().and_then(|k| s.badges.get(k).cloned()), calib)
        };
        let (ov, o) = opts.unwrap_or((0, spec.opts.clone()));
        let gen = pic.as_ref().map_or(0, |p| p.0);
        // E6f: RENDER-FROM-PROJECTOR — the venue from the solved projector, every frame (its pictures move; the
        // draw is the app's per-frame scene render), into the same bottom-up raster the flip pass presents.
        if let (Some((view, pics)), false, Some((tex, _))) = (&calib, booting, &raster) {
            let target = tex.create_view(&Default::default());
            let r = calib_r.get_or_insert_with(|| crate::calib3d::Renderer::new(&gpu, &spec.id));
            if view.warped {
                // PATH B (ProjectorApp): the scene's canvas — undimmed, its element hidden — is the SOURCE of the
                // ordinary warp stage, uploaded as any canvas (CanvasContent) and drawn with the output's corner pin /
                // Bézier ONLY: every photometric stage identity (no feather, gamma 1, unit gain, no lift — the post pass
                // already applied the blend look), brightness × opacity in the warp, aa 1.
                let (w, h) = (size.width, size.height);
                if calib_canvas.as_ref().map(|c| (c.0, c.1)) != Some((w, h)) {
                    let t = d.create_texture(&wgpu::TextureDescriptor {
                        label: Some("calib3d canvas"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
                    let v = t.create_view(&Default::default());
                    calib_canvas = Some((w, h, t, v));
                }
                let cv = &calib_canvas.as_ref().unwrap().3;
                r.draw(&gpu, view, pics, cv, w, h, 1.0);
                let ct = calib_content.get_or_insert_with(|| projector::CanvasContent::new(&gpu)).upload(&gpu, cv, w, h);
                let po = projector::Opts { soft: [0.0; 4], blend_gamma: 2.2, gamma: 1.0, color_gain: [1.0; 3], black_lift: [0.0; 3], aa: 1, ..o.clone() };
                calib_warp.get_or_insert_with(|| projector::Warp::new(&gpu)).draw(&gpu, ct, &po, &target, wgpu::TextureFormat::Rgba8Unorm, w, h);
            } else {
                r.draw(&gpu, view, pics, &target, size.width, size.height, o.brightness);
            }
            drawn = None;
        } else if drawn != Some((gen, ov, booting, size)) {
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
        #[cfg(feature = "ndi")]
        if let (Some((send, max, cut)), Some((rt, _))) = (&ndi_send, &raster) {
            if ndi_at.elapsed() >= Duration::from_millis(33) {
                ndi_at = std::time::Instant::now();
                let (w, h) = ndi_fit(size.width, size.height, *max);
                let shot = cut.crop(&gpu, rt, [0.0, size.height as f64, size.width as f64, -(size.height as f64)], w, h);
                match crate::crop::Cropper::read(&gpu, &shot) { Ok(px) => send.send(w, h, px), Err(e) => eprintln!("artlux-engine: output '{}': NDI capture: {e}", spec.id) }
            }
        }
        #[cfg(not(feature = "ndi"))]
        let _ = &mut ndi_at;
        if let (Some((hold, cut)), Some((rt, _)), false) = (&mut proj_hold, &raster, booting) {
            if proj_hold_at.elapsed() >= crate::hold::PROJ_EVERY {
                proj_hold_at = std::time::Instant::now();
                let shot = cut.crop(&gpu, rt, [0.0, size.height as f64, size.width as f64, -(size.height as f64)], size.width, size.height);
                if let Ok(px) = crate::crop::Cropper::read(&gpu, &shot) { hold.record(size.width, size.height, &px); }
            }
        }
        let tex = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => { std::thread::sleep(Duration::from_millis(8)); continue; }
            _ => { configured = None; continue; }
        };
        let view = tex.texture.create_view(&Default::default());
        // E6f: the badge's texture and bindings, (re)made when its bitmap changes.
        if let (Some(bp), Some((bg, b))) = (&badge_pipe, &badge) {
            if badge_tex.as_ref().map(|t| t.0) != Some(*bg) {
                use wgpu::util::DeviceExt;
                let bt = d.create_texture_with_data(&gpu.queue, &wgpu::TextureDescriptor {
                    label: Some("badge"), size: wgpu::Extent3d { width: b.w, height: b.h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
                    dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
                }, wgpu::util::TextureDataOrder::LayerMajor, &b.rgba);
                let scale = window.scale_factor();
                let (bx, by) = ((BADGE_AT.0 * scale).round() as u32, (BADGE_AT.1 * scale).round() as u32);
                let u: [f32; 4] = [bx as f32, by as f32, BADGE_OPACITY, 0.0];
                let ubuf = d.create_buffer(&wgpu::BufferDescriptor { label: Some("badge"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
                gpu.queue.write_buffer(&ubuf, 0, &u.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>());
                let bview = bt.create_view(&Default::default());
                let bind = d.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &bp.get_bind_group_layout(0), entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&bview) },
                    wgpu::BindGroupEntry { binding: 1, resource: ubuf.as_entire_binding() },
                ] });
                badge_tex = Some((*bg, bind, bx, by));
            }
        }
        let mut enc = d.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("flip"), color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], ..Default::default() });
            pass.set_pipeline(&pipe); pass.set_bind_group(0, raster.as_ref().map(|r| &r.1), &[]); pass.draw(0..3, 0..1);
            // E6f: the windowed output's badge, OVER the flipped output (the app's DOM order).
            if let (Some(bp), Some((_, bind, bx, by)), Some((_, b))) = (&badge_pipe, &badge_tex, &badge) {
                let (bw, bh) = (b.w.min(size.width.saturating_sub(*bx)), b.h.min(size.height.saturating_sub(*by)));
                if bw > 0 && bh > 0 {
                    pass.set_pipeline(bp); pass.set_bind_group(0, bind, &[]);
                    pass.set_viewport(*bx as f32, *by as f32, bw as f32, bh as f32, 0.0, 1.0);
                    pass.set_scissor_rect(*bx, *by, bw, bh);
                    pass.draw(0..3, 0..1);
                }
            }
        }
        gpu.queue.submit([enc.finish()]);
        window.pre_present_notify();
        gpu.queue.present(tex);
    }
}
