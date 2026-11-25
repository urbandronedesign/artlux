//! E1f-1 — THE ENGINE RUNS THE LED OUTPUT AT RUNTIME, from the document the host sends it.
//!
//! "The host evaluates, the engine draws": the app keeps evaluating the show (scenes, the timeline, the
//! state machine, overrides) into the EFFECTIVE surfaces and fixtures of the moment, and decides, per
//! surface, which SOURCE the engine is to draw (src/renderer/engine/nativeLink.ts — it knows bakes, codecs,
//! slices; the engine does not guess). The engine composes its own atlas from those sources, samples, packs
//! and sends — every step already proven against the app (E1b–E1d).
//!
//! OWNERSHIP IS ALL OR NOTHING, per document. There is one wire: the engine sends only when it can draw
//! EVERY sampled surface (and places every light's bytes, which the host evaluates — E1f-2); otherwise it says why and stays silent, and the app keeps the
//! wire (main mutes the app's frames only while the engine owns it — src/main/engineHost.ts). Losing
//! ownership empties the send thread, so its keep-alive cannot repeat a stale frame over the app's.
//!
//! Messages (JSON lines, main → engine; see serve.rs for the transport):
//!   {"type":"output","broadcast":b,"fps":n,"keepAlive":b,"sync":b}        the output engine's settings
//!   {"type":"doc","doc":{rev, fixtures, surfaces, controllers, defaults, gamma, port, outputEnabled,
//!                        sources: {surfaceId: {kind: image|effect|hap|none|unsupported, path?, why?}}}}
//!   {"type":"tick","rev":r,"t":showTime,"brightness":b,"hap":{surfaceId: frameIndex},
//!    "lights":{fixtureId: [byte, …]}}   one frame; `doc.lights` lists the fixtures the host says are lights
//! engine → main: {"type":"owns","rev":r,"owns":bool,"why":"…"} once per document.

use crate::compose::{self, Picture, TexCache};
use crate::effects::{Params, Rng, SurfaceEffect};
use crate::{layout, pack, wire, Gpu};
use artlux_output_engine::core::OutputEngine;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// E3a: a timeline surface composited by the engine (comp.rs) — its canvas size (0 for a single LAYER surface,
/// which is its track's picture itself), and its tracks back-most first: (hidden source key, opacity, blend,
/// E3c: the clip's timing — the engine evaluates its alpha and clip-local time from the playhead).
#[derive(PartialEq, Clone)]
struct CompSpec { w: u32, h: u32, single: bool, layers: Vec<(String, f32, String, Option<crate::eval::ClipTime>, crate::eval::Track)> }

#[derive(PartialEq)]
enum Source { Slice(String, [f64; 4]), Image(String), Effect(Params), Hap(String), Spout(String), Ndi(String), Mp4(String, i64), Camera(CamSpec), Shader(crate::shader::Spec), Raster, Blobs(u32, u32), Comp(CompSpec), None }

/// Item 2d step 5: a camera surface as the host describes it — the app's track label (which camera), the
/// colour space of the app's own VideoFrames (what the engine's picture is held to — cam::picture), and
/// whether the app sees another camera with the SAME label (then the picture decides — cam::resolve).
#[derive(PartialEq, Clone, Debug)]
struct CamSpec { label: String, app: crate::yuv::Space, twins: bool }

struct Doc {
    rev: u64,
    lfix: Vec<layout::Fixture>,
    surfaces: Vec<layout::Surface>,
    pfix: Vec<pack::Fixture>,
    controllers: Vec<pack::Controller>,
    defaults: pack::Defaults,
    lut: [u8; 256],
    port: u16,
    sources: HashMap<String, Source>,
    opacity: HashMap<String, f32>,
    /// E3d: the AUTHORED opacities (the document's); `opacity` is these with the engine's lanes laid over.
    base_opacity: HashMap<String, f32>,
    owns: bool,
    /// E1f-2: the fixtures the HOST says are lights (indices into pfix).
    lights: Vec<usize>,
}

pub struct Runtime {
    gpu: Arc<Gpu>,
    out: Option<OutputEngine>,
    /// E6h: the last frame on the wire, kept where main reads it after a death (hold.rs).
    hold: Option<crate::hold::Hold>,
    /// E6i: the shared-memory sections main writes rasters into, by name (Windows).
    #[cfg(windows)]
    shm_maps: HashMap<String, artlux_output_engine::shm::Map>,
    broadcast: bool,
    out_cfg: (f64, bool, bool),
    doc: Option<Doc>,
    pictures: HashMap<String, Picture>,
    gens: HashMap<String, u64>,
    images: HashMap<String, Arc<Picture>>,
    effects: HashMap<String, SurfaceEffect>,
    /// E2: one shader runner per SHADER surface (its program and its feedback history — shader.rs).
    shaders: HashMap<String, crate::shader::Runner>,
    sources_summary: String,
    /// E2: a shader surface on an engine projector, drawn AGAIN at that output's size by its own runner
    /// (`<sid>@proj`, its own feedback history) — as the app's projector window runs its own copy.
    proj_pictures: HashMap<String, Picture>,
    /// E2: the pictures the APP draws and ships on change (`raster` sources — text first): surface id (or
    /// `<id>@proj`, the copy at a projector display's size) → (the host's sequence, the picture).
    rasters: HashMap<String, (u64, Arc<Picture>)>,
    /// E2: the tracking-blob renderer (blobs.rs), made on first use.
    blobs: Option<crate::blobs::Blobs>,
    /// E3a: the timeline compositor (comp.rs), made on first use, and each still picture's upload by key.
    compositor: Option<crate::comp::Compositor>,
    comp_tex: HashMap<String, (u64, wgpu::Texture)>,
    rng: Rng,
    cache: TexCache,
    gen: u64,
    path_gens: HashMap<String, u64>,
    pub frames: u64,
    // ── E1f-3: projector outputs (outputs.rs) ──
    outputs: Option<(winit::event_loop::EventLoopProxy<crate::outputs::Cmd>, Arc<std::sync::Mutex<crate::outputs::Shared>>)>,
    /// The outputs of the current document the engine is to drive: (output id, surface id, the output's JSON).
    projectors: Vec<(String, String, Value)>,
    proj_published: HashMap<String, u64>,
    proj_opts: HashMap<String, f64>,
    /// E6f: the surfaces calibrated outputs' venues show (published as `venue:<sid>`), what was published, and a version.
    calib_surfaces: Vec<String>,
    venue_published: HashMap<String, u64>,
    calib_ver: u64,
    opts_ver: u64,
    /// E1f "2a": one Spout receiver per surface, kept while its source is that sender (spout.rs SpoutIn).
    #[cfg(windows)]
    spouts: HashMap<String, (String, crate::spout::SpoutIn)>,
    /// Item 2b: one NDI receiver (its own thread) per surface, and the last frame number drawn.
    #[cfg(feature = "ndi")]
    ndis: HashMap<String, (crate::ndi::NdiIn, u64)>,
    /// Item 2c-4: one MP4 decoder per surface (mf.rs — on the GPU where the decoder takes the device), and
    /// the GPU conversion they share (yuv.rs).
    #[cfg(windows)]
    mp4s: HashMap<String, (String, crate::mf::Mp4In)>,
    conv: Option<crate::yuv::GpuConvert>,
    /// Item 2d step 5: one SHARED camera reader per surface (camshared.rs — the app keeps the camera), the
    /// label it was resolved from, and the last frame drawn.
    #[cfg(windows)]
    cams: HashMap<String, (String, crate::camshared::SharedIn, u64)>,
    /// Twin cameras (one model twice) resolved BY PICTURE: (surface, label) → link. Kept across documents.
    resolved: HashMap<(String, String), String>,
    /// Twin cameras waiting for the app's fingerprint (it comes with the ticks): surface → label.
    pending_cams: HashMap<String, String>,
    /// The last document, to answer it AGAIN once a pending camera is resolved (`redo`).
    pub last_doc: Option<Value>,
    pub redo: bool,
    // ── E4a: the engine's 3D view (view3d.rs) ──
    /// What the view's presenter reads, and whether a view is open (set by the windows thread too: closing
    /// the window from its title bar clears it).
    view: Option<(Arc<std::sync::Mutex<crate::view3d::Shared>>, Arc<std::sync::atomic::AtomicBool>)>,
    view_scene_ver: u64,
    view_published: HashMap<String, u64>,
    view_colors_gen: u64,
    view_last_summary: String,
    /// E3c: values the engine evaluated that differed from the app's (logged), and the document last announced.
    clock_diffs: u64,
    /// E3: the engine's own transport clock, run from the app's anchors and checked every frame (transport.rs).
    transport: crate::transport::Transport,
    /// E3h: the clock lanes and lights are DRAWN at this tick — the engine's own (playhead, show time), or the
    /// app's when the engine has no clock to read or it strays (see `draw_clock`). Stats: (own, the app's, light
    /// ticks whose drawn bytes moved on from the app's frame).
    draw_at: Option<(f64, f64)>,
    draw_stats: (u64, u64, u64),
    /// The largest single byte the engine's clock moved from the app's frame (a sanity bound on the drift).
    draw_max_step: u8,
    /// E3i: composite tracks drawn at the engine's own clock / held at the app's playhead across a clip boundary.
    comp_draw: (u64, u64),
    /// E3j: each video file's frame table, read once (the engine CHOOSES a video track's frame from its clip time).
    vids: HashMap<String, Option<crate::eval::VidTable>>,
    /// E3j: video-track frames at the app's instant — the engine's choice equal to the frame the app showed, or not
    /// (the app shows what its decoder has READY, so a frame it has not decoded yet is a different one).
    frame_agree: (u64, u64),
    clock_ticks: u64,
    /// E3k: this tick, a track drawn from the clip it cuts to: layer key → that clip's source key.
    comp_sub: HashMap<String, String>,
    /// E3k: tracks drawn from the next clip across a cut; decoders handed from a next clip to its track; next
    /// clips the engine could not draw (logged once each).
    next_drawn: u64,
    handovers: u64,
    clip_bad: std::collections::HashSet<String>,
    /// The file each picture key was last given (E3k: a track's key outlives its clip).
    src_paths: HashMap<String, String>,
    /// E3k: hidden MP4 sources whose colour space the ENGINE judges (the app had no decoded frame to judge).
    judge: std::collections::HashSet<String>,
    clock_rev: u64,
    /// E3d: the automation lanes the engine evaluates, this tick's effect overrides (surface → speed,
    /// intensity), and the check's counters.
    lanes: Vec<LaneRt>,
    auto_fx: HashMap<String, (Option<f64>, Option<f64>)>,
    auto_diffs: u64,
    auto_ticks: u64,
    /// E3e: the light show as the engine evaluates it, and the check's counters.
    show: crate::light::Show,
    light_diffs: u64,
    light_ticks: u64,
    /// E3f: the lights' profiles (None: an older host sent none) and each light fixture as the document has it
    /// (profileId, profileMode, dmx — automation already folded in); the byte check's counters.
    rig: Option<crate::lightpack::Rig>,
    light_fix: HashMap<String, Value>,
    byte_diffs: u64,
    byte_ticks: u64,
    /// E3f: this tick's bytes for each light as the ENGINE solved them — the ones placed on the wire.
    light_solved: HashMap<String, Vec<u8>>,
    /// E4b: what every light is doing this tick (lightpack Head::resolve), for the 3D view's beams — resolved only
    /// while a view is open, from the same stack its bytes were packed with.
    light_beams: HashMap<String, crate::lightpack::Beam>,
    /// E6f: the slice cutter, and what each slice was last cut from (source generation, rectangle, size).
    cropper: Option<crate::crop::Cropper>,
    slice_keys: HashMap<String, String>,
    /// E6a: the bake in flight — one surface drawn at the app's stepped clock and encoded here (encode.rs).
    #[cfg(windows)]
    bake: Option<Bake>,
}

/// E6a: one bake — the file being written and what each frame cost (drawing, reading back, encoding).
#[cfg(windows)]
struct Bake { out: crate::encode::Mp4Writer, scaler: crate::bakescale::Scaler, surface: String, w: u32, h: u32, draw_ms: f64, read_ms: f64, enc_ms: f64, started: std::time::Instant, blank: u64 }

#[derive(Clone, Copy, PartialEq)]
enum AutoLeaf { Opacity, Speed, Intensity }

/// E3d: one automation lane as the engine samples it (timeline.ts LaneRT).
struct LaneRt { path: String, sid: String, leaf: AutoLeaf, keys: Vec<crate::eval::Key>, log: bool, eps: f64, show: bool }

impl Runtime {
    pub fn new(gpu: Arc<Gpu>) -> Self {
        Runtime { gpu, out: None, hold: crate::hold::Hold::open(), #[cfg(windows)] shm_maps: HashMap::new(), broadcast: false, out_cfg: (44.0, true, false), doc: None, pictures: HashMap::new(), gens: HashMap::new(),
            images: HashMap::new(), effects: HashMap::new(), shaders: HashMap::new(), sources_summary: String::new(), proj_pictures: HashMap::new(), rasters: HashMap::new(), blobs: None, compositor: None, comp_tex: HashMap::new(), rng: Rng::new(0x5eed), cache: TexCache::default(), gen: 0, path_gens: HashMap::new(), frames: 0,
            outputs: None, projectors: Vec::new(), proj_published: HashMap::new(), proj_opts: HashMap::new(), calib_surfaces: Vec::new(), venue_published: HashMap::new(), calib_ver: 0, opts_ver: 0,
            #[cfg(windows)] spouts: HashMap::new(),
            #[cfg(feature = "ndi")] ndis: HashMap::new(),
            #[cfg(windows)] mp4s: HashMap::new(), conv: None,
            #[cfg(windows)] cams: HashMap::new(), resolved: HashMap::new(), pending_cams: HashMap::new(), last_doc: None, redo: false,
            view: None, view_scene_ver: 0, view_published: HashMap::new(), view_colors_gen: 0, view_last_summary: String::new(), clock_diffs: 0, transport: Default::default(), draw_at: None, draw_stats: (0, 0, 0), draw_max_step: 0, comp_draw: (0, 0), vids: HashMap::new(), frame_agree: (0, 0), clock_ticks: 0, comp_sub: HashMap::new(), next_drawn: 0, handovers: 0, clip_bad: Default::default(), src_paths: HashMap::new(), judge: Default::default(), clock_rev: 0, lanes: Vec::new(), auto_fx: HashMap::new(), auto_diffs: 0, auto_ticks: 0, show: Default::default(), light_diffs: 0, light_ticks: 0, rig: None, light_fix: HashMap::new(), byte_diffs: 0, byte_ticks: 0, light_solved: HashMap::new(), light_beams: HashMap::new(), cropper: None, slice_keys: HashMap::new(),
            #[cfg(windows)] bake: None }
    }

    /// E4a: the 3D view's shared state and its open flag (serve.rs makes them; the windows thread shares them).
    pub fn set_view(&mut self, shared: Arc<std::sync::Mutex<crate::view3d::Shared>>, open: Arc<std::sync::atomic::AtomicBool>) {
        self.view = Some((shared, open));
    }
    fn view_open(&self) -> bool { self.view.as_ref().is_some_and(|(_, o)| o.load(std::sync::atomic::Ordering::SeqCst)) }

    /// E4a: `{"type":"scene3d", models, leds, lights}` — what the 3D view draws, from the editor's own scene.
    /// E3a: one timeline surface — compositeLayers in the engine. A single LAYER surface is its track's picture,
    /// with the clip alpha baked in when it is under 0.999 (timeline.layerDrawable); a stack or the program is
    /// every track drawn over a transparent canvas of the app's size.
    fn composite(&mut self, sid: &str, spec: &CompSpec, v: &Value) {
        if self.compositor.is_none() { self.compositor = Some(crate::comp::Compositor::new(&self.gpu)); }
        // Each track's picture as a texture: a GPU picture copied from its visible rect, a CPU one uploaded
        // once per generation.
        let mut texs: Vec<(wgpu::Texture, f32, f32, String, u32, u32)> = Vec::new();
        for (layer, opacity, blend, _, _) in &spec.layers {
            let alpha = v["comp"][sid][layer].as_f64().unwrap_or(1.0) as f32;
            // E3k: across a cut the engine's clock reached first, the track's picture is the NEXT clip's.
            let key = self.comp_sub.get(layer).cloned().unwrap_or_else(|| layer.clone());
            let key = &key;
            let Some(p) = self.pictures.get(key) else { continue };   // not ready this frame: skipped, as the app does
            let gen = self.gens.get(key).copied().unwrap_or(0);
            let tex = match &p.tex {
                Some(t) => crate::projector::content_texture_from(&self.gpu, t, p.crop.unwrap_or([0, 0, p.w, p.h])),
                None => {
                    if self.comp_tex.get(key).map(|e| e.0) != Some(gen) {
                        self.comp_tex.insert(key.clone(), (gen, crate::projector::content_texture(&self.gpu, p.w, p.h, &p.rgba)));
                    }
                    self.comp_tex[key].1.clone()
                }
            };
            let (pw, ph) = p.shown();
            texs.push((tex, alpha, *opacity, blend.clone(), pw, ph));
        }
        if spec.single {
            match texs.first() {
                None => { self.pictures.remove(sid); }
                Some((tex, alpha, _, _, pw, ph)) => {
                    let (pw, ph) = (*pw, *ph);
                    let t = if *alpha >= 0.999 { tex.clone() } else {
                        self.compositor.as_ref().unwrap().render(&self.gpu, pw, ph, &[crate::comp::Layer { tex, alpha: *alpha, opacity: 1.0, blend: "normal" }])
                    };
                    self.pictures.insert(sid.to_string(), Picture::gpu_frame(pw, ph, t, [0, 0, pw, ph]));
                    self.gen += 1; self.gens.insert(sid.to_string(), self.gen << 2 | 2);
                }
            }
            return;
        }
        if spec.w == 0 || spec.h == 0 { self.pictures.remove(sid); return; }
        let layers: Vec<crate::comp::Layer> = texs.iter().map(|(t, a, o, b, _, _)| crate::comp::Layer { tex: t, alpha: *a, opacity: *o, blend: b.as_str() }).collect();
        let t = self.compositor.as_ref().unwrap().render(&self.gpu, spec.w, spec.h, &layers);
        self.pictures.insert(sid.to_string(), Picture::gpu_frame(spec.w, spec.h, t, [0, 0, spec.w, spec.h]));
        self.gen += 1; self.gens.insert(sid.to_string(), self.gen << 2 | 2);
    }

    /// E6f — a SLICE: the rectangle `r` (0..1 of the source's shown picture) of surface `of`'s picture, at the app's size
    /// round(w·r.w) × round(h·r.h), sampled as the app's canvas does (crop.rs). Re-cut only when the source's picture,
    /// the rectangle or the size changed; no source picture = nothing (black, as the app shows).
    fn slice(&mut self, sid: &str, of: &str, r: [f64; 4]) {
        let Some(p) = self.pictures.get(of) else { self.pictures.remove(sid); return };
        let gen = self.gens.get(of).copied().unwrap_or(0);
        let [vx, vy, vw, vh] = p.crop.unwrap_or([0, 0, p.w, p.h]);
        let (dw, dh) = (((vw as f64 * r[2]).round() as u32).max(1), ((vh as f64 * r[3]).round() as u32).max(1));
        let key = format!("{gen}|{r:?}|{vw}x{vh}");
        if self.slice_keys.get(sid) == Some(&key) && self.pictures.contains_key(sid) { return; }
        let src = match &p.tex {
            Some(t) => t.clone(),
            None => {
                // A CPU picture is uploaded once per generation (stills: once), level 0 only.
                if self.comp_tex.get(of).map(|e| e.0) != Some(gen) {
                    self.comp_tex.insert(of.to_string(), (gen, crate::projector::content_texture(&self.gpu, p.w, p.h, &p.rgba)));
                }
                self.comp_tex[of].1.clone()
            }
        };
        if self.cropper.is_none() { self.cropper = Some(crate::crop::Cropper::new(&self.gpu)); }
        let rect = [vx as f64 + r[0] * vw as f64, vy as f64 + r[1] * vh as f64, r[2] * vw as f64, r[3] * vh as f64];
        let tex = self.cropper.as_ref().unwrap().crop(&self.gpu, &src, rect, dw, dh);
        self.pictures.insert(sid.to_string(), Picture::gpu_frame(dw, dh, tex, [0, 0, dw, dh]));
        self.gen += 1; self.gens.insert(sid.to_string(), self.gen << 2 | 2);
        self.slice_keys.insert(sid.to_string(), key);
    }

    /// E2: `{"type":"raster","surface","gen","w","h","path"}` — a picture the app drew (main wrote its straight-
    /// alpha RGBA, row 0 at the top). Read now: main deletes the file once the next one is announced.
    pub fn raster(&mut self, v: &Value) {
        let Some(sid) = v["surface"].as_str() else { return };
        let (w, h, g) = (v["w"].as_u64().unwrap_or(0) as u32, v["h"].as_u64().unwrap_or(0) as u32, v["gen"].as_u64().unwrap_or(0));
        // E6i: through SHARED MEMORY (Windows, artlux_output_engine::shm) — the section main named, the slot and the
        // sequence it wrote; a picture overwritten before it was copied is dropped (the next one is already coming).
        let read: std::io::Result<Vec<u8>> = match (v["shm"].as_str(), v["path"].as_str()) {
            (Some(name), _) => self.shm_read(name, v),
            (None, Some(path)) => std::fs::read(path),
            _ => return,
        };
        match read {
            Ok(px) if px.len() == (w as usize) * (h as usize) * 4 && w > 0 => {
                // A CANVAS picture (premultiplied here, no mips) — as the app's compositor draws a bitmap.
                let pic = Arc::new(Picture::canvas(w, h, px));
                // E6f: a windowed output's BADGE (`badge:<surface>`) — the presenters composite it (outputs.rs).
                if sid.starts_with("badge:") { if let Some((_, sh)) = &self.outputs { sh.lock().unwrap().badges.insert(sid.to_string(), (g, pic)); } return; }
                self.rasters.insert(sid.to_string(), (g, pic));
            }
            Ok(px) => eprintln!("artlux-engine: raster {sid}: {} bytes for {w}x{h}", px.len()),
            Err(e) => eprintln!("artlux-engine: raster {sid}: {e}"),
        }
    }

    #[cfg(windows)]
    fn shm_read(&mut self, name: &str, v: &Value) -> std::io::Result<Vec<u8>> {
        use artlux_output_engine::shm;
        let (cap, slot, seq) = (v["cap"].as_u64().unwrap_or(0) as usize, v["slot"].as_u64().unwrap_or(0) as usize, v["seq"].as_u64().unwrap_or(0));
        let len = (v["w"].as_u64().unwrap_or(0) * v["h"].as_u64().unwrap_or(0) * 4) as usize;
        if !self.shm_maps.contains_key(name) {
            let m = shm::Map::open(name, shm::section_len(cap)).ok_or_else(|| std::io::Error::other(format!("shared memory {name} cannot be opened")))?;
            // One section per surface: a new name for this surface (a larger picture) replaces its old one.
            let prefix = name.rsplit_once('-').map(|x| format!("{}-", x.0)).unwrap_or_default();
            self.shm_maps.retain(|k, _| !k.starts_with(&prefix));
            self.shm_maps.insert(name.to_string(), m);
        }
        shm::read(&self.shm_maps[name], cap, slot, seq, len).ok_or_else(|| std::io::Error::other("overwritten before it was read"))
    }
    #[cfg(not(windows))]
    fn shm_read(&mut self, _name: &str, _v: &Value) -> std::io::Result<Vec<u8>> { Err(std::io::Error::other("shared memory is Windows-only")) }

    pub fn scene3d(&mut self, v: &Value) {
        let Some((shared, _)) = &self.view else { return };
        self.view_scene_ver += 1;
        let sc = crate::view3d::Scene::parse(v);
        let leds: usize = sc.leds.iter().map(|f| f.pos.len() / 3).sum();
        let summary = format!("{} models, {} pixel fixtures ({} LEDs), {} lights", sc.models.len(), sc.leds.len(), leds, sc.lights.len());
        if summary != self.view_last_summary { eprintln!("artlux-engine: 3D view scene: {summary}"); self.view_last_summary = summary; }
        shared.lock().unwrap().scene = Some((self.view_scene_ver, Arc::new(sc)));
    }
    /// E4a: `{"type":"view3d","open":b,"camera":{position,target,fov}}` — open (where the editor looks
    /// from) or close the 3D view window.
    pub fn view3d(&mut self, v: &Value) {
        let Some((shared, open)) = &self.view else { eprintln!("artlux-engine: no window system — no 3D view"); return };
        let want = v["open"].as_bool().unwrap_or(false);
        if want && v["camera"].is_null() { eprintln!("artlux-engine: 3D view: opened with no camera"); }
        if want {
            let c = &v["camera"];
            let p = |k: &str| -> Option<[f32; 3]> { let a = c[k].as_array()?; Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32]) };
            if let (Some(eye), Some(t)) = (p("position"), p("target")) {
                let mut s = shared.lock().unwrap();
                s.cam = crate::view3d::Cam::from_pose(eye, t, c["fov"].as_f64().unwrap_or(50.0) as f32);
                eprintln!("artlux-engine: 3D view camera: eye {eye:?} target {t:?} fov {}", c["fov"]);
                s.cam_set += 1;
            }
            // E4b: where it was last (main's prefs), applied by the windows thread when it creates the window.
            shared.lock().unwrap().place = crate::view3d::Place::from_json(&v["place"]);
            // Everything is republished to a fresh view.
            self.view_published.clear();
            self.view_colors_gen = 0;
        }
        open.store(want, std::sync::atomic::Ordering::SeqCst);
        eprintln!("artlux-engine: 3D view {} (asked by the host)", if want { "open" } else { "close" });
        match &self.outputs {
            Some((proxy, _)) => { if let Err(e) = proxy.send_event(crate::outputs::Cmd::View3d(want)) { eprintln!("artlux-engine: 3D view: the windows thread is gone ({e})"); } }
            None => eprintln!("artlux-engine: 3D view: no windows thread"),
        }
    }

    /// E4a: the live state the 3D view draws — every surface's picture (the screens show them) and the
    /// composed LED buffer with each pixel fixture's offset in it (the packer's walk, pack.rs).
    fn publish_view(&mut self, doc: &Doc, raw: &[u8]) {
        let Some((shared, _)) = &self.view else { return };
        let mut sh = shared.lock().unwrap();
        for (sid, p) in &self.pictures {
            let Some(&g) = self.gens.get(sid) else { continue };
            if self.view_published.get(sid) != Some(&g) {
                sh.pictures.insert(sid.clone(), (g, Arc::new(Picture { w: p.w, h: p.h, rgba: p.rgba.clone(), mips: p.mips, crop: p.crop, tex: p.tex.clone() })));
                self.view_published.insert(sid.clone(), g);
            }
        }
        sh.pictures.retain(|sid, _| self.pictures.contains_key(sid));
        self.view_published.retain(|sid, _| self.pictures.contains_key(sid));
        let mut bases = HashMap::new();
        let mut off = 0usize;
        for f in &doc.pfix { bases.insert(f.id.clone(), off); off += f.led_count.max(0) as usize; }
        if self.view_colors_gen == 0 {
            let lit = raw.chunks_exact(4).filter(|p| p[0] > 0 || p[1] > 0 || p[2] > 0).count();
            eprintln!("artlux-engine: 3D view colours: {} LEDs, {} lit (doc owns the wire: {})", raw.len() / 4, lit, doc.owns);
        }
        self.view_colors_gen += 1;
        sh.colors = Some((self.view_colors_gen, Arc::new(raw.to_vec()), Arc::new(bases)));
        sh.beams = Arc::new(self.light_beams.clone());
    }

    /// E1f-3: the windows thread the projector outputs live on (serve.rs starts it).
    pub fn set_outputs(&mut self, proxy: winit::event_loop::EventLoopProxy<crate::outputs::Cmd>, shared: Arc<std::sync::Mutex<crate::outputs::Shared>>) {
        self.outputs = Some((proxy, shared));
    }

    /// E6f: can this engine send NDI?
    fn ndi_ready() -> Result<(), String> {
        #[cfg(feature = "ndi")] { crate::ndi::runtime() }
        #[cfg(not(feature = "ndi"))] { Err("this engine was built without NDI".to_string()) }
    }

    /// E1f-3: the document's projector outputs. ALL OR NOTHING, like the wire: when any enabled output is
    /// one the engine cannot draw (the host says why: calibrated, hardware-warped, an NDI send this engine cannot make, a source
    /// the engine lacks...) it opens NONE and the app keeps every output. Err(why) when it will not drive
    /// them; Ok(n) when it asked the windows thread for n outputs (whose report answers main).
    pub fn projectors(&mut self, d: &Value) -> Result<usize, String> {
        let all = d["projectors"].as_array().cloned().unwrap_or_default();
        // E6i step 2 — OWNED PER OUTPUT. An output the engine cannot show (its `why`, or an NDI send without NDI here)
        // stays the app's, ALONE: the others are still the engine's. It used to be all-or-nothing — one calibration
        // session open put every output of the show back in the app's windows.
        let name = |p: &Value| p["name"].as_str().unwrap_or(p["id"].as_str().unwrap_or("?")).to_string();
        let mut refused: Vec<(String, String)> = Vec::new();
        let list: Vec<Value> = all.into_iter().filter(|p| {
            let w = p["why"].as_str().map(str::to_string)
                // E6f: an NDI SEND needs NDI here — built with it, and its runtime on this machine (else the app sends it).
                .or_else(|| if p["ndi"].is_object() { Self::ndi_ready().err().map(|w| format!("an NDI send — {w}")) } else { None });
            match w { Some(w) => { refused.push((p["id"].as_str().unwrap_or_default().to_string(), format!("output '{}': {w}", name(p)))); false } None => true }
        }).collect();
        let why = if self.outputs.is_none() { Some("the engine has no window system here".to_string()) }
            else if list.is_empty() && refused.is_empty() { Some("no projector output is enabled".to_string()) }
            // Every output refused: the answer is the refusals themselves (no window opens to report them).
            else if list.is_empty() { Some(refused.iter().map(|r| r.1.clone()).collect::<Vec<_>>().join("; ")) }
            else { None };
        let specs: Vec<crate::outputs::Spec> = if why.is_some() { Vec::new() } else { list.iter().map(|p| crate::outputs::Spec {
            id: p["id"].as_str().unwrap_or_default().to_string(),
            surface_id: p["surfaceId"].as_str().unwrap_or_default().to_string(),
            display: crate::windows::DisplayMatch {
                bounds: (|| Some((p["bounds"]["x"].as_i64()? as i32, p["bounds"]["y"].as_i64()? as i32, p["bounds"]["width"].as_u64()? as u32, p["bounds"]["height"].as_u64()? as u32)))(),
                index: None,
            },
            opts: crate::projector::Opts::from_json(&p["output"], 1.0, 4),
            // E6f: a windowed output's content rect (main's, from the app's window), physical pixels.
            window: (|| Some((p["window"]["x"].as_i64()? as i32, p["window"]["y"].as_i64()? as i32, p["window"]["width"].as_u64()? as u32, p["window"]["height"].as_u64()? as u32)))(),
            title: p["title"].as_str().or(p["name"].as_str()).unwrap_or_default().to_string(),
            badge: p["badge"].as_str().map(str::to_string),
            ndi: p["ndi"]["name"].as_str().map(|n| crate::outputs::NdiOut { name: n.to_string(), max: (p["ndi"]["maxW"].as_u64().unwrap_or(1280) as u32, p["ndi"]["maxH"].as_u64().unwrap_or(720) as u32) }),
            baked: p["baked"].as_object().and_then(|b| Some(crate::outputs::BakedFiles {
                key: b.get("key")?.as_str()?.to_string(),
                w: b.get("w")?.as_u64()? as u32, h: b.get("h")?.as_u64()? as u32,
                uv: b.get("uv")?.as_str()?.to_string(),
                alpha: b.get("alpha").and_then(|a| Some((a["w"].as_u64()? as u32, a["h"].as_u64()? as u32, a["file"].as_str()?.to_string()))),
            })),
        }).collect() };
        self.projectors = if why.is_some() { Vec::new() } else {
            list.iter().map(|p| {
                // E2: the display's CSS size rides with the output settings (main's `css`) — a shader on this
                // output is drawn at it, as the app's projector window draws it.
                let mut out = p["output"].clone();
                if let Some(o) = out.as_object_mut() { o.insert("css".into(), p["css"].clone()); }
                (p["id"].as_str().unwrap_or_default().to_string(), p["surfaceId"].as_str().unwrap_or_default().to_string(), out)
            }).collect()
        };
        self.proj_opts.clear();
        // E6f: each calibrated output's VENUE (render-from-projector — calib3d.rs), and the surfaces it shows, whose
        // pictures publish_projectors adds as `venue:<sid>`. A venue the engine cannot read is a refusal.
        self.calib_surfaces.clear();
        if let Some((_, shared)) = &self.outputs {
            let mut sh = shared.lock().unwrap();
            sh.calib.clear();
            // Reported with the windows that opened (outputs.rs App::set), as the outputs the app keeps.
            sh.refused = if why.is_none() { refused.clone() } else { Vec::new() };
            if why.is_none() {
                for p in &list {
                    if p["calib"].is_null() { continue; }
                    match crate::calib3d::View::parse(&p["calib"]) {
                        Some(v) => {
                            let id = p["id"].as_str().unwrap_or_default().to_string();
                            for sid in v.surfaces() { if !self.calib_surfaces.contains(&sid) { self.calib_surfaces.push(sid); } }
                            eprintln!("artlux-engine: output '{id}': render-from-projector, {} venue model(s), surfaces {:?}", v.models.len(), v.surfaces());
                            self.calib_ver += 1;
                            sh.calib.insert(id, (self.calib_ver, Arc::new(v)));
                        }
                        None => eprintln!("artlux-engine: output '{}': an unreadable venue", p["id"].as_str().unwrap_or("?")),
                    }
                }
            }
            sh.pictures.retain(|k, _| !k.starts_with("venue:"));
            self.venue_published.clear();
        }
        if let Some((proxy, _)) = &self.outputs { let _ = proxy.send_event(crate::outputs::Cmd::Set(specs.clone())); }
        match why { Some(w) => Err(w), None => Ok(specs.len()) }
    }

    /// E1f-3: publish the projected surfaces' pictures and each output's settings for this tick.
    fn publish_projectors(&mut self, doc: &Doc, v: &Value) {
        let Some((_, shared)) = &self.outputs else { return };
        if self.projectors.is_empty() { return; }
        let pb = v["proj"]["brightness"].as_f64().unwrap_or(1.0);
        let mut sh = shared.lock().unwrap();
        sh.booting = v["proj"]["booting"].as_bool().unwrap_or(false);
        // E6f: the surfaces a calibrated output's venue shows — the MAIN-SIZE picture (the app streams the projector
        // window `createImageBitmap(getDrawable(surface))`, never the display-size raster), as `venue:<sid>`.
        for sid in &self.calib_surfaces {
            if let (Some(&g), Some(p)) = (self.gens.get(sid), self.pictures.get(sid)) {
                if self.venue_published.get(sid) != Some(&g) {
                    sh.pictures.insert(format!("venue:{sid}"), (g, Arc::new(Picture { w: p.w, h: p.h, rgba: p.rgba.clone(), mips: p.mips, crop: p.crop, tex: p.tex.clone() })));
                    self.venue_published.insert(sid.clone(), g);
                }
            }
        }
        for (id, sid, out) in &self.projectors {
            if let (Some(&g), Some(p)) = (self.gens.get(sid), self.proj_pictures.get(sid).or_else(|| self.pictures.get(sid))) {
                if self.proj_published.get(sid) != Some(&g) {
                    sh.pictures.insert(sid.clone(), (g, Arc::new(Picture { w: p.w, h: p.h, rgba: p.rgba.clone(), mips: p.mips, crop: p.crop, tex: p.tex.clone() })));
                    self.proj_published.insert(sid.clone(), g);
                }
            } else if !self.pictures.contains_key(sid) {
                sh.pictures.remove(sid); self.proj_published.remove(sid);
            }
            // The app draws a projector at projectorBrightness x the surface's own opacity (ProjectorApp).
            let b = pb * doc.opacity.get(sid).copied().unwrap_or(1.0) as f64;
            if self.proj_opts.get(id) != Some(&b) {
                self.proj_opts.insert(id.clone(), b);
                self.opts_ver += 1;
                sh.opts.insert(id.clone(), (self.opts_ver, crate::projector::Opts::from_json(out, b, 4)));
            }
        }
    }

    pub fn output(&mut self, v: &Value) {
        let broadcast = v["broadcast"].as_bool().unwrap_or(false);
        self.out_cfg = (v["fps"].as_f64().unwrap_or(44.0), v["keepAlive"].as_bool().unwrap_or(true), v["sync"].as_bool().unwrap_or(false));
        // The core binds its socket for broadcast (or not) when it starts: a change means a new one.
        if self.out.is_some() && broadcast != self.broadcast { if let Some(o) = self.out.take() { o.close(); } }
        self.broadcast = broadcast;
        if let Some(o) = &self.out { o.configure(self.out_cfg.0, self.out_cfg.1, self.out_cfg.2); }
    }

    fn send(&mut self, frame: &[u8]) {
        if self.out.is_none() {
            let o = OutputEngine::start(self.broadcast);
            o.configure(self.out_cfg.0, self.out_cfg.1, self.out_cfg.2);
            self.out = Some(o);
        }
        if let Some(o) = &self.out { o.push_frame(frame); }
        if let Some(h) = &mut self.hold { h.record(frame); }
    }

    /// A new document. Returns (rev, owns, why) — the answer main is waiting for.
    pub fn doc(&mut self, d: &Value) -> (u64, bool, String) {
        let rev = d["rev"].as_u64().unwrap_or(0);
        let was_owning = self.doc.as_ref().is_some_and(|x| x.owns);
        let verdict = self.load(d);
        let (owns, why) = match &verdict { Ok(()) => (true, String::new()), Err(w) => (false, w.clone()) };
        if let Some(doc) = &mut self.doc { doc.owns = owns; }
        if was_owning && !owns {
            // Hand the wire back CLEANLY: an empty frame, so the send thread's keep-alive has nothing to
            // repeat over the app's frames.
            self.send(&0u32.to_le_bytes());
        }
        (rev, owns, why)
    }

    fn load(&mut self, d: &Value) -> Result<(), String> {
        let rev = d["rev"].as_u64().unwrap_or(0);
        let parse = |k: &str| d[k].clone();
        let lfix: Vec<layout::Fixture> = serde_json::from_value(parse("fixtures")).map_err(|e| format!("fixtures: {e}"))?;
        let surfaces: Vec<layout::Surface> = serde_json::from_value(parse("surfaces")).map_err(|e| format!("surfaces: {e}"))?;
        let pfix: Vec<pack::Fixture> = serde_json::from_value(parse("fixtures")).map_err(|e| format!("fixtures: {e}"))?;
        let controllers: Vec<pack::Controller> = serde_json::from_value(parse("controllers")).unwrap_or_default();
        let defaults: pack::Defaults = serde_json::from_value(parse("defaults")).map_err(|e| format!("defaults: {e}"))?;
        let mut sources = HashMap::new();
        let mut opacity = HashMap::new();
        for s in d["surfaces"].as_array().into_iter().flatten() {
            let id = s["id"].as_str().unwrap_or_default().to_string();
            if let Some(o) = s["content"]["opacity"].as_f64() { opacity.insert(id.clone(), o as f32); }
            let src = &d["sources"][&id];
            let source = match src["kind"].as_str().unwrap_or("none") {
                "image" => Source::Image(src["path"].as_str().unwrap_or_default().to_string()),
                "effect" => Source::Effect(Params::from_json(&s["content"])),
                "hap" => Source::Hap(src["path"].as_str().unwrap_or_default().to_string()),
                "spout" => Source::Spout(src["name"].as_str().unwrap_or_default().to_string()),
                "ndi" => Source::Ndi(src["name"].as_str().unwrap_or_default().to_string()),
                "mp4" => Source::Mp4(src["path"].as_str().unwrap_or_default().to_string(), src["durUs"].as_f64().unwrap_or(0.0).round() as i64),
                "camera" => Source::Camera(CamSpec {
                    label: src["label"].as_str().unwrap_or_default().to_string(),
                    app: crate::yuv::Space { bt709: src["bt709"].as_bool().unwrap_or(false), full_range: src["fullRange"].as_bool().unwrap_or(false) },
                    twins: src["twins"].as_bool().unwrap_or(false),
                }),
                "shader" => Source::Shader(crate::shader::Spec::from_json(src)),
                "raster" => Source::Raster,
                "comp" => Source::Comp(CompSpec {
                    w: src["w"].as_u64().unwrap_or(0) as u32, h: src["h"].as_u64().unwrap_or(0) as u32, single: src["single"].as_bool().unwrap_or(false),
                    layers: src["layers"].as_array().into_iter().flatten().map(|l| (l["key"].as_str().unwrap_or_default().to_string(), l["opacity"].as_f64().unwrap_or(1.0) as f32, l["blend"].as_str().unwrap_or("normal").to_string(), crate::eval::ClipTime::from_json(&l["clip"]), crate::eval::Track::from_json(l))).collect(),
                }),
                "blobs" => Source::Blobs(src["w"].as_u64().unwrap_or(1920).clamp(2, 4096) as u32, src["h"].as_u64().unwrap_or(1024).clamp(2, 4096) as u32),
                // E6f: a rectangle of ANOTHER surface's picture (x, y, w, h of it, 0..1) — drawn after every other source.
                "slice" => Source::Slice(src["of"].as_str().unwrap_or_default().to_string(), [src["rect"]["x"].as_f64().unwrap_or(0.0), src["rect"]["y"].as_f64().unwrap_or(0.0), src["rect"]["w"].as_f64().unwrap_or(1.0), src["rect"]["h"].as_f64().unwrap_or(1.0)]),
                "none" => Source::None,
                _ => Source::None,
            };
            sources.insert(id, source);
        }
        // E3a: a composite's tracks — hidden sources `layer:<id>`, sampled by no fixture, drawn only to be
        // composited. Same kinds as a surface's; an effect clip carries its own content.
        for (key, src) in d["sources"].as_object().into_iter().flatten() {
            if !key.starts_with("layer:") && !key.starts_with("clip:") { continue; }   // E3k: a next clip is `clip:<id>`
            let source = match src["kind"].as_str().unwrap_or("none") {
                "image" => Source::Image(src["path"].as_str().unwrap_or_default().to_string()),
                "effect" => Source::Effect(Params::from_json(&src["content"])),
                "shader" => Source::Shader(crate::shader::Spec::from_json(src)),
                "raster" => Source::Raster,
                // E3b: a track's video clip — the same sources as a surface's, keyed by the track.
                "hap" => Source::Hap(src["path"].as_str().unwrap_or_default().to_string()),
                "mp4" => Source::Mp4(src["path"].as_str().unwrap_or_default().to_string(), src["durUs"].as_f64().unwrap_or(0.0).round() as i64),
                _ => Source::None,
            };
            // E3k: an MP4 the app has decoded no frame of — the engine judges its colour space itself.
            if src["judge"] == "engine" { self.judge.insert(key.clone()); } else { self.judge.remove(key); }
            sources.insert(key.clone(), source);
        }
        // What each surface's source resolved to, once per change (diagnostic: which kinds the engine was given).
        let kinds: Vec<String> = d["surfaces"].as_array().into_iter().flatten().map(|s| { let id = s["id"].as_str().unwrap_or_default(); let k = &d["sources"][id]; format!("{}={}{}", s["name"].as_str().unwrap_or(id), k["kind"].as_str().unwrap_or("?"), k["why"].as_str().map(|w| format!(" ({w})")).unwrap_or_default()) }).collect();
        let summary = kinds.join(", ");
        if summary != self.sources_summary { eprintln!("artlux-engine: sources: {summary}"); self.sources_summary = summary; }
        let mut doc = Doc { rev, lfix, surfaces, pfix, controllers, defaults, lut: pack::gamma_lut(d["gamma"].as_f64().unwrap_or(1.0)),
            port: d["port"].as_u64().unwrap_or(6454) as u16, sources, base_opacity: opacity.clone(), opacity, owns: false, lights: Vec::new() };
        self.load_lanes(&d["lanes"]);
        let show = crate::light::Show::from_json(&d["lighting"]);
        if !show.is_empty() && self.show.is_empty() { eprintln!("artlux-engine: lighting: the light show is evaluated by the engine and checked against the app's"); }
        self.show = show;
        let light_ids: Vec<&str> = d["lights"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).collect();
        doc.lights = doc.pfix.iter().enumerate().filter(|(_, f)| light_ids.contains(&f.id.as_str())).map(|(i, _)| i).collect();
        for &i in &doc.lights { doc.pfix[i].light = true; }
        // E3f: the lights' profiles, and the light fixtures themselves, for the byte solve.
        let had_rig = self.rig.is_some();
        self.rig = d.get("profiles").filter(|p| p.is_object()).map(crate::lightpack::Rig::from_json);
        if self.rig.is_some() && !had_rig && !light_ids.is_empty() { eprintln!("artlux-engine: light bytes: every light's DMX is solved by the engine and checked against the app's"); }
        self.light_fix = d["fixtures"].as_array().into_iter().flatten().filter(|f| f["id"].as_str().is_some_and(|id| light_ids.contains(&id))).map(|f| (f["id"].as_str().unwrap_or_default().to_string(), f.clone())).collect();
        // A surface whose SOURCE changed (another file, another kind) starts from nothing: its picture and
        // generation belong to the old source.
        if let Some(old) = &self.doc {
            for (k, src) in &doc.sources {
                // A shader whose SIZE alone changed (a surface being dragged) keeps its picture and history.
                let same_shader = matches!((old.sources.get(k), src), (Some(Source::Shader(a)), Source::Shader(b)) if a.source == b.source && a.inputs == b.inputs && a.last_frame == b.last_frame);
                if old.sources.get(k) != Some(src) && !same_shader && !matches!((old.sources.get(k), src), (Some(Source::Effect(_)), Source::Effect(_))) {
                    self.pictures.remove(k); self.gens.remove(k);
                }
            }
        }
        #[cfg(windows)]
        self.spouts.retain(|k, _| matches!(doc.sources.get(k), Some(Source::Spout(_))));
        #[cfg(feature = "ndi")]
        self.ndis.retain(|k, _| matches!(doc.sources.get(k), Some(Source::Ndi(_))));
        // E3k: THE DECODER THAT DECODED A NEXT CLIP AHEAD IS HANDED TO ITS TRACK. When the app crosses the cut its
        // document names that clip's file under the track (`layer:<id>`), and the `clip:<id>` key is gone; without
        // this the retain below would close the warm decoder and the track would open a cold one at the cut.
        #[cfg(windows)]
        {
            let wanted: Vec<(String, String)> = doc.sources.iter().filter_map(|(k, s)| match s {
                Source::Mp4(p, _) if self.mp4s.get(k).is_none_or(|(q, _)| q != p) => Some((k.clone(), p.clone())),
                _ => None,
            }).collect();
            for (k, p) in wanted {
                let from = self.mp4s.iter().find(|(f, (q, _))| f.starts_with("clip:") && *q == p && !doc.sources.contains_key(*f)).map(|(f, _)| f.clone());
                if let Some(from) = from {
                    let e = self.mp4s.remove(&from).unwrap();
                    self.mp4s.insert(k.clone(), e);
                    // …with the frame it decoded: the picture and its generation are that file's.
                    if let Some(pic) = self.pictures.remove(&from) { self.pictures.insert(k.clone(), pic); }
                    if let Some(g) = self.gens.remove(&from) { self.gens.insert(k.clone(), g); }
                    self.handovers += 1;
                    if self.handovers <= 20 { eprintln!("artlux-engine: clock: {from}'s decoder handed to {k} at the cut ({} so far)", self.handovers); }
                }
            }
        }
        // A key whose FILE changed (a track cutting to another clip) must not keep the old file's frame: its
        // generation is a frame number, which the new file can share.
        for (k, s) in &doc.sources {
            let p = match s { Source::Hap(p) | Source::Mp4(p, _) | Source::Image(p) => p, _ => continue };
            #[cfg(windows)]
            let handed = self.mp4s.get(k).is_some_and(|(q, _)| q == p);   // a decoder handed over at the cut brought its frame
            #[cfg(not(windows))]
            let handed = false;
            if self.src_paths.get(k).is_some_and(|q| q != p) && !handed { self.gens.remove(k); self.pictures.remove(k); }
            self.src_paths.insert(k.clone(), p.clone());
        }
        self.src_paths.retain(|k, _| doc.sources.contains_key(k));
        self.clip_bad.retain(|k| doc.sources.contains_key(k));
        #[cfg(windows)]
        self.mp4s.retain(|k, (p, _)| matches!(doc.sources.get(k), Some(Source::Mp4(q, _)) if q == p));
        #[cfg(windows)]
        self.cams.retain(|k, (l, _, _)| matches!(doc.sources.get(k), Some(Source::Camera(c)) if &c.label == l));
        self.pending_cams.retain(|k, l| matches!(doc.sources.get(k), Some(Source::Camera(c)) if &c.label == l));
        // Keep the effects' state (Fire's heat) across documents for surfaces that are still effects.
        self.effects.retain(|k, _| matches!(doc.sources.get(k), Some(Source::Effect(_))));
        self.shaders.retain(|k, r| matches!(doc.sources.get(k.trim_end_matches("@proj")), Some(Source::Shader(s)) if r.fits(s)));
        self.proj_pictures.retain(|k, _| matches!(doc.sources.get(k), Some(Source::Shader(_) | Source::Raster)));
        self.rasters.retain(|k, _| matches!(doc.sources.get(k.trim_end_matches("@proj")), Some(Source::Raster)) || !doc.sources.contains_key(k.trim_end_matches("@proj")));
        let ids: Vec<String> = doc.sources.keys().cloned().collect();
        self.cache.retain(&|k| ids.iter().any(|i| i == k));
        self.pictures.retain(|k, _| ids.iter().any(|i| i == k));
        let verdict = self.verdict(d, &mut doc);
        self.doc = Some(doc);
        self.last_doc = Some(d.clone());
        verdict
    }

    /// Can the engine draw EVERYTHING this document samples? The host's per-surface answer, plus the
    /// fixtures (a light's channels are the host's precedence stack — not sent yet, E1f-2).
    fn verdict(&mut self, d: &Value, doc: &mut Doc) -> Result<(), String> {
        if !d["outputEnabled"].as_bool().unwrap_or(false) { return Err("output is off".into()); }
        // E1f-2: lights are DRIVEN — their bytes come in each tick. Which fixtures are lights is the host's
        // call (services/fixtureKind.ts), sent as `lights`; the engine never infers it from a profileId.
        let mut sampled: Vec<String> = layout::surface_order(&doc.lfix, &doc.surfaces);
        // E6f: a slice draws its SOURCE surface — which must pass the same verdict, fixture or not.
        for sid in sampled.clone() {
            if let Some(of) = d["sources"][&sid]["of"].as_str().filter(|_| d["sources"][&sid]["kind"] == "slice") {
                if !sampled.iter().any(|x| x == of) { sampled.push(of.to_string()); }
            }
        }
        for sid in &sampled {
            let src = &d["sources"][sid];
            match src["kind"].as_str() {
                Some("image") | Some("effect") | Some("hap") | Some("spout") | Some("none") | Some("raster") | Some("blobs") | Some("slice") => {}
                // E3a: every track of the composite must be a kind the engine draws; stills are loaded here.
                Some("comp") => {
                    for l in src["layers"].as_array().into_iter().flatten() {
                        let key = l["key"].as_str().unwrap_or_default();
                        let ks = &d["sources"][key];
                        match ks["kind"].as_str() {
                            Some("image") => {
                                let p = ks["path"].as_str().unwrap_or_default().to_string();
                                if !self.images.contains_key(&p) {
                                    let pic = compose::load_image(std::path::Path::new(&p)).map_err(|e| format!("surface '{}': timeline clip: {e}", name_of(d, sid)))?;
                                    self.images.insert(p, Arc::new(pic));
                                }
                            }
                            Some("effect") | Some("raster") | Some("none") => {}
                            // E3b: a track's video — HAP read once to prove the file, an MP4 decoder opened per
                            // TRACK (as per surface), so a file the engine cannot read leaves the show to the app.
                            Some("hap") => {
                                let p = ks["path"].as_str().unwrap_or_default();
                                crate::hapimport::read_frame(p, 0).map_err(|e| format!("surface '{}': timeline HAP clip: {e}", name_of(d, sid)))?;
                            }
                            Some("mp4") => {
                                #[cfg(windows)]
                                {
                                    let Some(Source::Mp4(p, _)) = doc.sources.get(key) else { unreachable!() };
                                    if self.mp4s.get(key).is_none_or(|(q, _)| q != p) {
                                        let rx = crate::mf::Mp4In::open_with(p, Some(&self.gpu)).map_err(|e| format!("surface '{}': timeline MP4 clip: {e}", name_of(d, sid)))?;
                                        if let Some(why) = &rx.software_why { eprintln!("artlux-engine: timeline track {key}: MP4 decoded in software ({why})"); }
                                        self.mp4s.insert(key.to_string(), (p.clone(), rx));
                                    }
                                }
                                #[cfg(not(windows))]
                                return Err(format!("surface '{}': the engine decodes MP4 on Windows only so far", name_of(d, sid)));
                            }
                            Some("shader") => {
                                let Some(Source::Shader(spec)) = doc.sources.get(key) else { unreachable!() };
                                if self.shaders.get(key).is_none_or(|r| !r.fits(spec)) {
                                    let r = crate::shader::Runner::new(&self.gpu, spec).map_err(|e| format!("surface '{}': timeline shader clip: {}", name_of(d, sid), e.lines().next().unwrap_or("")))?;
                                    self.shaders.insert(key.to_string(), r);
                                }
                            }
                            k => return Err(format!("surface '{}': a timeline clip the engine does not draw ({})", name_of(d, sid), k.unwrap_or("?"))),
                        }
                    }
                }
                // E2: compiled HERE, so a text naga cannot take leaves the show to the app, with naga's log.
                Some("shader") => {
                    let Some(Source::Shader(spec)) = doc.sources.get(sid) else { unreachable!() };
                    if self.shaders.get(sid).is_none_or(|r| !r.fits(spec)) {
                        let r = crate::shader::Runner::new(&self.gpu, spec).map_err(|e| format!("surface '{}': shader: {}", name_of(d, sid), e.lines().next().unwrap_or("")))?;
                        self.shaders.insert(sid.clone(), r);
                    }
                }
                Some("camera") => {
                    #[cfg(windows)]
                    { let Some(Source::Camera(c)) = doc.sources.get(sid) else { unreachable!() }; let c = c.clone(); self.ensure_camera(sid, &c).map_err(|e| format!("surface '{}': {e}", name_of(d, sid)))?; }
                    #[cfg(not(windows))]
                    return Err(format!("surface '{}': the engine reads cameras on Windows only so far", name_of(d, sid)));
                }
                // Item 2b: only an engine BUILT with NDI (the `ndi` feature links the SDK) can take it.
                Some("ndi") if cfg!(feature = "ndi") => {
                    // The runtime is delay-loaded: no NDI install here = the app keeps the show, with this reason.
                    #[cfg(feature = "ndi")]
                    crate::ndi::runtime().map_err(|e| format!("surface '{}': {e}", name_of(d, sid)))?;
                }
                Some("ndi") => return Err(format!("surface '{}': this engine build has no NDI (built without the NDI SDK)", name_of(d, sid))),
                // Item 2c-4: the decoder is opened HERE, so a file the engine cannot read (fragmented MP4, a
                // codec this machine lacks) leaves the show to the app with that reason.
                Some("mp4") => {
                    #[cfg(windows)]
                    {
                        let Some(Source::Mp4(p, _)) = doc.sources.get(sid) else { unreachable!() };
                        if self.mp4s.get(sid).is_none_or(|(q, _)| q != p) {
                            let rx = crate::mf::Mp4In::open_with(p, Some(&self.gpu)).map_err(|e| format!("surface '{}': MP4 {e}", name_of(d, sid)))?;
                            if let Some(why) = &rx.software_why { eprintln!("artlux-engine: surface '{}': MP4 decoded in software ({why})", name_of(d, sid)); }
                            self.mp4s.insert(sid.clone(), (p.clone(), rx));
                        }
                    }
                    #[cfg(not(windows))]
                    return Err(format!("surface '{}': the engine decodes MP4 on Windows only so far", name_of(d, sid)));
                }
                _ => return Err(format!("surface '{}': {}", name_of(d, sid), src["why"].as_str().unwrap_or("not a source the engine draws"))),
            }
            if let Some(Source::Image(p)) = doc.sources.get(sid) {
                if !self.images.contains_key(p) {
                    let pic = compose::load_image(std::path::Path::new(p)).map_err(|e| format!("surface '{}': {e}", name_of(d, sid)))?;
                    self.images.insert(p.clone(), Arc::new(pic));
                }
            }
            if let Some(Source::Hap(p)) = doc.sources.get(sid) {
                crate::hapimport::read_frame(p, 0).map_err(|e| format!("surface '{}': HAP {e}", name_of(d, sid)))?;
            }
        }
        Ok(())
    }

    /// One frame at show time `t`. Nothing is sent unless the engine owns the wire for document `rev`.
    pub fn tick(&mut self, v: &Value) -> Result<(), String> {
        // E3o: the audio clock's rate, read each tick (two atomics in the audio library — no waiting on its thread).
        // The device callback's own STAMP (sample index + the wall time it ran): exact pairs, not a buffer-coarse count.
        match crate::audio::audio_stamp() {
            Some((n, wall, rate)) => self.transport.audio.feed(wall, n as f64 / rate),
            None => if self.transport.audio.measured() > 0.0 { self.transport.audio.clear(); },
        }
        self.transport.tick(v);   // E3: the engine's own clock, before anything needs a document
        self.transport.publish(); // E3p: …and the audio thread holds the sound to it
        self.draw_at = self.draw_clock(v);
        let Some(mut doc) = self.doc.take() else { return Ok(()) };
        self.evaluate_lanes(&mut doc, v);
        self.light_solved.clear();
        self.light_beams.clear();
        if v["rev"].as_u64() == Some(doc.rev) { self.evaluate_lighting(v); }   // the app's overlays are THIS document's
        let ev = self.evaluate_clock(&doc, v);
        let r = self.tick_with(&mut doc, ev.as_ref().unwrap_or(v));
        self.doc = Some(doc);
        r
    }

    /// E3h — WHAT THE ENGINE DRAWS AT: its OWN clock (transport.rs, read as this tick is handled), no longer the
    /// app's frame time. The lanes and the light show carry all their data in the document, so they are
    /// evaluated there; the CHECKS stay at the app's instant (`ph` / `t`), where the app's values are true. The
    /// app's numbers are used instead when the engine has no clock (no anchor yet, a bake) or when its clock is
    /// more than STRAY from the app's frame — an event the app has not drawn yet, or a loop wrap between the two —
    /// so a drawn value is never further from the app's than a frame's trip through main.
    /// NOT the composite: the document carries each track's ACTIVE clip at the app's playhead, and the app
    /// decodes the video frames, so a track drawn at a later time would cross a clip boundary the document does
    /// not describe yet.
    fn draw_clock(&mut self, v: &Value) -> Option<(f64, f64)> {
        const STRAY: f64 = 0.25;
        let (ph, st) = (v["ph"].as_f64()?, v["t"].as_f64()?);
        match self.transport.own() {
            Some((p, s)) if (p - ph).abs() < STRAY && (s - st).abs() < STRAY => { self.draw_stats.0 += 1; Some((p, s)) }
            _ => { self.draw_stats.1 += 1; Some((ph, st)) }
        }
    }

    /// E3d: the document's automation lanes — the ones the engine evaluates (nativeLink.engineLane: a surface's
    /// opacity, an effect's speed and intensity).
    fn load_lanes(&mut self, l: &Value) {
        let mut next = Vec::new();
        for x in l["lanes"].as_array().into_iter().flatten() {
            let path = x["path"].as_str().unwrap_or_default().to_string();
            let parts: Vec<&str> = path.split('.').collect();
            let leaf = match (parts.first(), parts.get(2), parts.get(3), parts.len()) {
                (Some(&"surfaces"), Some(&"content"), Some(&"opacity"), 4) => AutoLeaf::Opacity,
                (Some(&"surfaces"), Some(&"content"), Some(&"speed"), 4) => AutoLeaf::Speed,
                (Some(&"surfaces"), Some(&"content"), Some(&"intensity"), 4) => AutoLeaf::Intensity,
                _ => continue,
            };
            let keys: Vec<crate::eval::Key> = x["kfs"].as_array().into_iter().flatten().filter_map(crate::eval::Key::from_json).collect();
            if keys.is_empty() { continue; }
            next.push(LaneRt { sid: parts[1].to_string(), path, leaf, keys, log: x["log"].as_bool().unwrap_or(false), eps: x["eps"].as_f64().unwrap_or(0.0), show: x["clock"].as_str() == Some("show") });
        }
        if next.len() != self.lanes.len() || next.iter().zip(&self.lanes).any(|(a, b)| a.path != b.path) {
            eprintln!("artlux-engine: automation: {} lane(s) evaluated by the engine{}", next.len(), if next.is_empty() { String::new() } else { format!(" ({})", next.iter().map(|l| l.path.as_str()).collect::<Vec<_>>().join(", ")) });
        }
        self.lanes = next;
    }

    /// E3d — THE ENGINE SAMPLES ITS AUTOMATION LANES (plans/native-engine.md §4), as timeline.ts
    /// sampleAutomation does: each lane at its clock (the show time or the playhead), laid over the document's
    /// authored values. EXACTLY — the app pushes a value only once it moved by the lane's epsilon (half a UI
    /// step: a guard for the audio lock), so a slow ramp advances there every few frames, in a phase set by when
    /// sampling began; no second copy can follow that phase, and none should. By construction the app's held
    /// value is within epsilon of the exact sample — and that is what is CHECKED (`auto`, the app's value this
    /// frame): further apart logs `automation: differs`.
    fn evaluate_lanes(&mut self, doc: &mut Doc, v: &Value) {
        self.auto_fx.clear();
        if self.lanes.is_empty() {
            if doc.opacity != doc.base_opacity { doc.opacity = doc.base_opacity.clone(); }
            return;
        }
        let (Some(ph), Some(st)) = (v["ph"].as_f64(), v["t"].as_f64()) else { return };
        let (dph, dst) = self.draw_at.unwrap_or((ph, st));
        let mut opacity = doc.base_opacity.clone();
        for l in &self.lanes {
            let at_app = crate::eval::sample_lane(&l.keys, if l.show { st } else { ph }, l.log);
            if let Some(app) = v["auto"][&l.path].as_f64() {
                if !((app - at_app).abs() < l.eps + 1e-9) {
                    self.auto_diffs += 1;
                    if self.auto_diffs <= 20 { eprintln!("artlux-engine: automation: differs — {} at playhead {ph} / show {st}: app {app}, engine {at_app} (eps {})", l.path, l.eps); }
                }
            }
            // E3h: the value DRAWN is the lane at the engine's own clock.
            let val = if (dph, dst) == (ph, st) { at_app } else { crate::eval::sample_lane(&l.keys, if l.show { dst } else { dph }, l.log) };
            match l.leaf {
                AutoLeaf::Opacity => { opacity.insert(l.sid.clone(), val as f32); }
                AutoLeaf::Speed => { self.auto_fx.entry(l.sid.clone()).or_default().0 = Some(val); }
                AutoLeaf::Intensity => { self.auto_fx.entry(l.sid.clone()).or_default().1 = Some(val); }
            }
        }
        doc.opacity = opacity;
        self.auto_ticks += 1;
        if self.auto_ticks % 120 == 1 { eprintln!("artlux-engine: automation: {} tick(s) sampled, {} difference(s) from the app so far (document {})", self.auto_ticks, self.auto_diffs, doc.rev); }
    }

    /// E3e — THE ENGINE EVALUATES THE LIGHT SHOW (plans/native-engine.md §4): every active lighting clip's roles
    /// on its group's fixtures and every colour lane's colour (light.rs, the port of the app's two players), at
    /// the playhead — and CHECKS them against what the app's players published this frame (`lroles`, `lcolors`):
    /// the same fixtures, the same roles, every value within 1e-9, or `lighting: differs` is logged. The light
    /// bytes on the wire are still the app's (its packer solves roles and colours into DMX); this is the parity
    /// harness on the show before that moves.
    fn evaluate_lighting(&mut self, v: &Value) {
        let ours = match (self.show.on && !self.show.is_empty(), v["ph"].as_f64()) {
            (true, Some(ph)) => { let (r, c) = (self.show.roles(ph), self.show.colors(ph)); self.check_show(ph, &r, &c, v); Some((r, c)) }
            _ => None,
        };
        self.check_bytes(v, ours.as_ref(), true);
        // E3h: the bytes PLACED are the show at the engine's own clock — solved again when it has moved on from
        // the app's frame (the check above stays at the app's instant, where the app's bytes are true).
        if let (Some(_), Some(ph), Some((dph, _))) = (ours.as_ref(), v["ph"].as_f64(), self.draw_at) {
            if dph != ph {
                let checked = self.light_solved.clone();
                let drawn = (self.show.roles(dph), self.show.colors(dph));
                self.check_bytes(v, Some(&drawn), false);
                if self.light_solved != checked {
                    self.draw_stats.2 += 1;
                    for (id, b) in &self.light_solved {
                        if let Some(c) = checked.get(id) { for (x, y) in b.iter().zip(c) { self.draw_max_step = self.draw_max_step.max(x.abs_diff(*y)); } }
                    }
                }
            }
        }
        let (own, app, moved) = self.draw_stats;
        if (own + app) % 600 == 1 && own + app > 1 {
            eprintln!("artlux-engine: clock: lanes and lights drawn at the engine's own clock on {own} tick(s), at the app's frame on {app}; {moved} light tick(s) placed bytes the clock had moved on from the app's frame (largest step {} of 255)", self.draw_max_step);
        }
    }

    /// E3e: the engine's light show against the app's players' (`lroles`, `lcolors`).
    fn check_show(&mut self, ph: f64, roles: &crate::light::Roles, colors: &crate::light::Colors, v: &Value) {
        let n = |x: &Value| x.as_f64().unwrap_or(f64::NAN);   // the app's NaN arrives as null
        let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 || (a.is_nan() && b.is_nan());
        let mut why: Vec<String> = Vec::new();
        let app_roles = v["lroles"].as_object().cloned().unwrap_or_default();
        for (f, m) in roles {
            for (r, x) in m {
                let a = &app_roles.get(f).map(|o| o[r].clone()).unwrap_or(Value::Null);
                if a.is_null() && !x.is_nan() { why.push(format!("{f}.{r}: app none, engine {x}")); } else if !close(n(a), *x) { why.push(format!("{f}.{r}: app {a}, engine {x}")); }
            }
        }
        for (f, o) in &app_roles {
            for r in o.as_object().into_iter().flatten().map(|(k, _)| k) {
                if !roles.get(f).is_some_and(|m| m.contains_key(r)) { why.push(format!("{f}.{r}: app {}, engine none", o[r])); }
            }
        }
        let app_colors = v["lcolors"].as_object().cloned().unwrap_or_default();
        for (f, c) in colors {
            let ok = match (app_colors.get(f), c) {
                (Some(a), crate::light::Color::Rgb(x)) => a["kind"] == "rgb" && (0..3).all(|i| close(n(&a["rgb"][i]), x[i])),
                (Some(a), crate::light::Color::Cct(t)) => a["kind"] == "cct" && close(n(&a["t"]), *t),
                (None, _) => false,
            };
            if !ok { why.push(format!("{f} colour: app {}, engine {}", app_colors.get(f).cloned().unwrap_or(Value::Null), c.to_json())); }
        }
        for f in app_colors.keys() { if !colors.contains_key(f) { why.push(format!("{f} colour: app {}, engine none", app_colors[f])); } }
        self.light_ticks += 1;
        if !why.is_empty() {
            self.light_diffs += 1;
            if self.light_diffs <= 20 { eprintln!("artlux-engine: lighting: differs at playhead {ph} — {}", why.iter().take(4).cloned().collect::<Vec<_>>().join("; ")); }
        }
        if self.light_ticks % 120 == 1 {
            let nr: usize = roles.values().map(|m| m.len()).sum();
            eprintln!("artlux-engine: lighting: {} tick(s) evaluated ({} role value(s), {} colour(s) this tick), {} tick(s) differing from the app so far", self.light_ticks, nr, colors.len(), self.light_diffs);
        }
    }

    /// E3f — THE ENGINE SOLVES EVERY LIGHT'S DMX (plans/native-engine.md §4): through the fixture's profile
    /// (lightpack.rs, the port of profilePack / colorEngine and frameEngine's precedence stack), from the
    /// document's fixture (its authored values, automation folded in) and this frame's layers over it — the
    /// light show's roles and colours as the ENGINE evaluated them (the app's `lroles` / `lcolors` when the
    /// engine does not evaluate the show), and the inputs that are events rather than time: the fired pose cue
    /// (`lcue`), the faders under a hand (`llive`), the channels an automation lane owns (`lown`). CHECKED byte
    /// for byte against what the app packed (`lights`): `light bytes: differs`. The ENGINE's bytes are the ones
    /// placed on the wire (`light_solved`); the app's stand in for a light the engine was not given.
    /// `check` false: solve and place only (E3h — the bytes at the engine's own clock, no comparison).
    fn check_bytes(&mut self, v: &Value, ours: Option<&(crate::light::Roles, crate::light::Colors)>, check: bool) {
        let (Some(rig), Some(app)) = (self.rig.as_mut(), v["lights"].as_object()) else { return };
        if app.is_empty() { return; }
        let map = |x: &Value| -> HashMap<String, f64> { x.as_object().into_iter().flatten().map(|(k, y)| (k.clone(), y.as_f64().unwrap_or(f64::NAN))).collect() };
        let maps = |x: &Value| -> HashMap<String, HashMap<String, f64>> { x.as_object().into_iter().flatten().map(|(k, y)| (k.clone(), map(y))).collect() };
        let (app_roles, app_colors);
        let (roles, colors) = match ours {
            Some((r, c)) => (r, c),
            None => {
                app_roles = maps(&v["lroles"]);
                app_colors = v["lcolors"].as_object().into_iter().flatten().filter_map(|(k, c)| Some((k.clone(), crate::light::Color::from_json(c)?))).collect::<crate::light::Colors>();
                (&app_roles, &app_colors)
            }
        };
        let (cue, live) = (maps(&v["lcue"]), maps(&v["llive"]));
        let owned: HashMap<String, std::collections::HashSet<String>> = v["lown"].as_object().into_iter().flatten().map(|(k, a)| (k.clone(), a.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect())).collect();
        let mut why: Vec<String> = Vec::new();
        let mut nbytes = 0usize;
        let view_open = self.view.as_ref().is_some_and(|(_, o)| o.load(std::sync::atomic::Ordering::Relaxed));
        for (id, bytes) in app {
            let want: Vec<u64> = bytes.as_array().into_iter().flatten().map(|b| b.as_u64().unwrap_or(0)).collect();
            let got: Vec<u8> = match self.light_fix.get(id) {
                Some(f) => match rig.head(f) {
                    Some(head) => head.pack(&f["dmx"], &crate::lightpack::Over { owned: owned.get(id), color: colors.get(id), cue: cue.get(id), roles: roles.get(id), live: live.get(id) }),
                    None => Vec::new(),
                },
                None => { why.push(format!("{id}: not a light in the document")); continue; }
            };
            if view_open {
                if let (Some(f), Some(head)) = (self.light_fix.get(id), rig.head(&self.light_fix[id])) {
                    let o = crate::lightpack::Over { owned: owned.get(id), color: colors.get(id), cue: cue.get(id), roles: roles.get(id), live: live.get(id) };
                    self.light_beams.insert(id.clone(), head.resolve(&f["dmx"], &o));
                }
            }
            nbytes += got.len();
            let differs = got.len() != want.len() || got.iter().zip(&want).any(|(a, b)| *a as u64 != *b);
            self.light_solved.insert(id.clone(), got.clone());
            if differs {
                let at = got.iter().zip(&want).position(|(a, b)| *a as u64 != *b).unwrap_or(got.len().min(want.len()));
                why.push(format!("{id} (channel {}): app {:?}, engine {:?}", at + 1, want, got));
            }
        }
        if !check { return; }
        self.byte_ticks += 1;
        if !why.is_empty() {
            self.byte_diffs += 1;
            if self.byte_diffs <= 20 { eprintln!("artlux-engine: light bytes: differs at playhead {} — {}", v["ph"], why.iter().take(3).cloned().collect::<Vec<_>>().join("; ")); }
        }
        if self.byte_ticks % 120 == 1 {
            eprintln!("artlux-engine: light bytes: {} tick(s) solved ({} light(s), {} byte(s) this tick), {} tick(s) differing from the app so far", self.byte_ticks, app.len(), nbytes, self.byte_diffs);
        }
    }

    /// E3c — THE ENGINE EVALUATES THE TIMELINE'S TIME (plans/native-engine.md §4). From the playhead (`ph`) and
    /// each track's clip timing in the document, every composited track's clip alpha (content opacity × fades)
    /// and clip-local time — eval.rs, the port of the app's own formulas (`test:eval-parity`). The app still
    /// sends its values while both exist: each one is CHECKED against the engine's, and a difference is logged
    /// (`clock: differs`), which is the parity harness running on the show itself. The engine's values are the
    /// ones drawn. None when the tick carries no playhead (an older host) — the app's values are then used.
    fn evaluate_clock(&mut self, doc: &Doc, v: &Value) -> Option<Value> {
        self.comp_sub.clear();
        let ph = v["ph"].as_f64()?;
        let mut w = v.clone();
        let mut n = 0usize;
        for (sid, src) in &doc.sources {
            let Source::Comp(spec) = src else { continue };
            for (key, _, _, clip, track) in &spec.layers {
                let Some(c) = clip else { continue };
                let (a, t) = (crate::eval::clip_alpha(c, ph), crate::eval::clip_time(c, ph));
                for (what, app, ours) in [("alpha", v["comp"][sid][key].as_f64(), a), ("time", v["times"][key].as_f64(), t)] {
                    if let Some(app) = app {
                        if (app - ours).abs() > 1e-9 {
                            self.clock_diffs += 1;
                            if self.clock_diffs <= 20 { eprintln!("artlux-engine: clock: differs — {key} {what} at playhead {ph}: app {app}, engine {ours}"); }
                        }
                    }
                }
                // E3i: the engine CHOOSES the clip too (activeClip): at the app's playhead it must be the one the
                // document describes.
                let ours_id = crate::eval::active_clip(&track.spans, ph);
                if v["rev"].as_u64() == Some(doc.rev) && track.id.is_some() && !track.spans.is_empty() && ours_id != track.id.as_deref() {
                    self.clock_diffs += 1;
                    if self.clock_diffs <= 20 { eprintln!("artlux-engine: clock: differs — {key} clip at playhead {ph}: app {:?}, engine {ours_id:?}", track.id); }
                }
                // E3i: DRAWN at the engine's own clock while the clip under it is still the one the document
                // describes; across a boundary the app has not reached yet (the document holds the outgoing clip's
                // picture and timing) the track is drawn at the app's playhead, for that tick.
                let t_app = t;
                let mut across = false;
                let (a, t) = match self.draw_at {
                    Some((dph, _)) if dph != ph => {
                        let under = crate::eval::active_clip(&track.spans, dph);
                        if track.id.is_some() && under == track.id.as_deref() {
                            self.comp_draw.0 += 1;
                            (crate::eval::clip_alpha(c, dph), crate::eval::clip_time(c, dph))
                        } else if let Some((nk, nc, _)) = track.next.as_ref().filter(|(nk, _, nid)| under == Some(nid.as_str()) && self.pictures.contains_key(nk) && !self.clip_bad.contains(nk)) {
                            // E3k: the engine's clock is past the cut and the next clip is decoded: draw IT.
                            self.next_drawn += 1;
                            across = true;
                            self.comp_sub.insert(key.clone(), nk.clone());
                            (crate::eval::clip_alpha(nc, dph), crate::eval::clip_time(nc, dph))
                        } else { self.comp_draw.1 += 1; (a, t) }
                    }
                    _ => (a, t),
                };
                w["comp"][sid][key] = a.into();
                w["times"][key] = t.into();
                // E3k: the next clip — its time (drawn across the cut, else its first frame, decoded AHEAD).
                if let Some((nk, nc, _)) = &track.next {
                    let nt = if across { t } else { crate::eval::clip_time(nc, nc.start) };
                    w["times"][nk] = nt.into();
                    if let Some(table) = self.vid_table(doc.sources.get(nk)) { w[if table.is_hap() { "hap" } else { "mp4" }][nk] = table.frame(nt).into(); }
                }
                // E3j: a VIDEO track's frame, chosen by the engine from the clip time as the app's codec does
                // (eval.rs VidTable::frame) — checked at the app's instant against the frame the app showed, and
                // drawn at the clip time above (the engine's clock). Before, the frame was the app's.
                if let Some(table) = self.vid_table(doc.sources.get(key)).filter(|_| !across) {
                    let (want, ours) = (table.frame(t_app), table.frame(t));
                    let app = if table.is_hap() { v["hap"][key].as_i64() } else { v["mp4"][key].as_i64() };
                    if let Some(app) = app {
                        if app == want { self.frame_agree.0 += 1; } else {
                            self.frame_agree.1 += 1;
                            if self.frame_agree.1 <= 12 { eprintln!("artlux-engine: clock: frame — {key} at clip time {t_app:.4}: the clip time names {want}, the app showed {app}"); }
                        }
                    }
                    w[if table.is_hap() { "hap" } else { "mp4" }][key] = ours.into();
                }
                n += 1;
            }
        }
        if n > 0 { self.clock_ticks += 1; }
        if self.next_drawn > 0 && n > 0 && self.clock_ticks % 300 == 0 {
            eprintln!("artlux-engine: clock: the next clip drawn across a cut {} time(s); {} decoder(s) handed over", self.next_drawn, self.handovers);
        }
        if n > 0 && (self.clock_rev != doc.rev || self.clock_ticks % 300 == 0) {
            self.clock_rev = doc.rev;
            eprintln!("artlux-engine: clock: {n} track(s) evaluated from the playhead (document {}; {} difference(s) from the app so far; drawn at the engine's own clock {} time(s), held at the app's playhead across a clip boundary {} time(s); video frames chosen by the engine: {} the app's, {} not the app's)", doc.rev, self.clock_diffs, self.comp_draw.0, self.comp_draw.1, self.frame_agree.0, self.frame_agree.1);
        }
        Some(w)
    }

    /// E3j: a video source's frame table, read once per file (None: not a video, or unreadable — the app's frame
    /// is then drawn, as before).
    fn vid_table(&mut self, src: Option<&Source>) -> Option<crate::eval::VidTable> {
        let (path, hap, dur) = match src? { Source::Hap(p) => (p.clone(), true, 0), Source::Mp4(p, d) => (p.clone(), false, *d), _ => return None };
        self.vids.entry(path.clone()).or_insert_with(|| {
            let t = if hap {
                crate::hapimport::mov::parse(&path).ok().map(|m| crate::eval::VidTable::Hap { fps: m.fps, frames: m.frames.len() })
            } else {
                crate::mp4demux::open(&path).ok().map(|(tr, _)| {
                    let mut ts: Vec<i64> = tr.samples.iter().map(|s| tr.ts_us(s)).collect();
                    ts.sort_unstable();
                    crate::eval::VidTable::Mp4 { ts, dur_us: dur as f64 }
                })
            };
            if t.is_none() { eprintln!("artlux-engine: clock: {path} has no frame table — its frames stay the app's"); }
            t
        }).clone()
    }

    fn tick_with(&mut self, doc: &mut Doc, v: &Value) -> Result<(), String> {
        // The pictures are needed by the wire AND by the projectors, each owned on its own (E1f-3).
        // E4a: an open 3D view needs the pictures and the LED colours too, owned wire or not.
        let viewing = self.view_open();
        if (!doc.owns && self.projectors.is_empty() && !viewing) || v["rev"].as_u64() != Some(doc.rev) { return Ok(()); }
        let brightness = v["brightness"].as_f64().unwrap_or(1.0) as f32;
        self.draw_sources(doc, v)?;
        self.publish_projectors(doc, v);
        if !doc.owns && !viewing { return Ok(()); }
        self.place_and_send(doc, v, brightness, viewing)
    }

    /// Every source's picture for this tick (`pictures`), the timeline composites last — what the wire, the
    /// projectors, the 3D view and (E6a) a bake all read.
    fn draw_sources(&mut self, doc: &mut Doc, v: &Value) -> Result<(), String> {
        let t = v["t"].as_f64().unwrap_or(0.0);
        for (sid, src) in &doc.sources {
            match src {
                Source::Image(p) => {
                    // A still: one generation PER FILE, stable across documents (a timeline animating an
                    // opacity sends a new document every frame) — so its mips are built once, not per frame.
                    let next = self.path_gens.len() as u64;
                    let g = *self.path_gens.entry(p.clone()).or_insert(next) << 2;
                    if self.gens.get(sid) != Some(&g) || !self.pictures.contains_key(sid) {
                        // Loaded on first use: the LED verdict loads only the stills fixtures SAMPLE, and a
                        // surface shown only by a projector (E1f-3) is drawn too.
                        if !self.images.contains_key(p) {
                            let pic = compose::load_image(std::path::Path::new(p)).map_err(|e| format!("surface {sid}: {e}"))?;
                            self.images.insert(p.clone(), Arc::new(pic));
                        }
                        let pic = self.images[p].clone();
                        self.pictures.insert(sid.clone(), Picture { w: pic.w, h: pic.h, rgba: pic.rgba.clone(), mips: pic.mips, crop: pic.crop, tex: pic.tex.clone() });
                        self.gens.insert(sid.clone(), g);
                    }
                }
                Source::Effect(params) => {
                    // E3d: an automated speed / intensity, as the engine sampled it this tick.
                    let mut params = *params;
                    if let Some((s, i)) = self.auto_fx.get(sid) { if let Some(s) = s { params.speed = *s; } if let Some(i) = i { params.intensity = *i; } }
                    let params = &params;
                    let e = self.effects.entry(sid.clone()).or_default();
                    // A timeline clip's effect runs at its CLIP-LOCAL time (the tick's `times`), as the app's does.
                    let rgba = e.render(*params, v["times"][sid].as_f64().unwrap_or(t), &mut self.rng).to_vec();
                    self.pictures.insert(sid.clone(), Picture::canvas(crate::effects::FW as u32, crate::effects::FH as u32, rgba));
                    self.gen += 1; self.gens.insert(sid.clone(), self.gen << 2 | 2);
                }
                Source::Hap(p) => {
                    // THE FRAME THE APP IS SHOWING (its index, sent by the host), not a clock of our own.
                    let idx = v["hap"][sid].as_u64().unwrap_or(0) as usize;
                    let key = ((idx as u64) << 2) | 1;
                    if self.gens.get(sid) != Some(&key) || !self.pictures.contains_key(sid) {
                        if self.clip_bad.contains(sid) { continue; }
                        let pic = crate::hapimport::read_frame(p, idx).and_then(|(w, h, fmt, blocks, _)| compose::hap_picture(&self.gpu, fmt, w, h, &blocks).map_err(|e| e.to_string()));
                        match pic {
                            Ok(pic) => { self.pictures.insert(sid.clone(), pic); self.gens.insert(sid.clone(), key); }
                            // E3k: a next clip the engine cannot draw holds its track; it never fails the tick.
                            Err(e) if sid.starts_with("clip:") => { eprintln!("artlux-engine: clock: {sid} not drawn ahead: {e}"); self.clip_bad.insert(sid.clone()); }
                            Err(e) => return Err(e),
                        }
                    }
                }
                Source::Spout(name) => {
                    // A live source: a new picture every frame (Spout has no reliable frame counter — see
                    // native/spout-receiver), so every frame is a new generation.
                    #[cfg(windows)]
                    {
                        if self.spouts.get(sid).is_none_or(|(n, _)| n != name) {
                            self.spouts.insert(sid.clone(), (name.clone(), crate::spout::SpoutIn::new(name)?));
                        }
                        match self.spouts.get_mut(sid).unwrap().1.frame(&self.gpu)? {
                            Some(pic) => { self.pictures.insert(sid.clone(), pic); self.gen += 1; self.gens.insert(sid.clone(), self.gen << 2 | 3); }
                            None => { self.pictures.remove(sid); }   // no sender (yet): black, as the app shows
                        }
                    }
                    #[cfg(not(windows))]
                    { let _ = name; self.pictures.remove(sid); }
                }
                Source::Ndi(name) => {
                    #[cfg(feature = "ndi")]
                    {
                        if self.ndis.get(sid).is_none_or(|(n, _)| &n.name != name) {
                            self.ndis.insert(sid.clone(), (crate::ndi::NdiIn::new(name), 0));
                        }
                        // The size of the app's own NDI canvas (the host sends it): scaled by the app's arithmetic.
                        let size = v["ndi"][sid].as_array().and_then(|a| Some((a.first()?.as_u64()? as u32, a.get(1)?.as_u64()? as u32)));
                        let (rx, last) = self.ndis.get_mut(sid).unwrap();
                        if let Some((w, h, rgba, seq)) = rx.frame(size) {
                            if *last != seq || self.gens.get(sid).is_none() || !self.pictures.contains_key(sid) {
                                *last = seq;
                                self.pictures.insert(sid.clone(), Picture::canvas(w, h, rgba));
                                self.gen += 1; self.gens.insert(sid.clone(), self.gen << 2 | 2);
                            }
                        }
                        // No frame yet: the app's canvas shows nothing either — black.
                    }
                    #[cfg(not(feature = "ndi"))]
                    { let _ = name; self.pictures.remove(sid); }
                }
                Source::Mp4(_path, dur_us) => {
                    // THE FRAME THE APP IS SHOWING: its VideoFrame.timestamp, sent by the host. A looping surface's
                    // decoder runs in ABSOLUTE time (each loop adds the file's duration — mp4Decoder tsOfAbs), so
                    // it is folded back into the file here.
                    #[cfg(windows)]
                    if let Some(abs) = v["mp4"][sid].as_i64() {
                        let key = ((abs.max(0) as u64) << 2) | 1;
                        if self.gens.get(sid) != Some(&key) || !self.pictures.contains_key(sid) {
                            let local = if *dur_us > 0 { abs - abs.div_euclid(*dur_us) * dur_us } else { abs };
                            // The verdict opens the decoders of the surfaces the LEDS sample; a surface only a
                            // PROJECTOR shows is opened on first use (as stills are loaded on first use above).
                            let ahead = sid.starts_with("clip:");
                            if ahead && self.clip_bad.contains(sid) { continue; }
                            if self.mp4s.get(sid).is_none_or(|(q, _)| q != _path) {
                                match crate::mf::Mp4In::open_with(_path, Some(&self.gpu)) {
                                    Ok(rx) => {
                                        // E3k: a next clip's colour space is judged HERE — the app has decoded no frame
                                        // of it yet. The engine draws BT.709 limited range (unspecified counts as it).
                                        let c = rx.colour();
                                        let ok = matches!(c.matrix, "bt709" | "?") && matches!(c.primaries, "bt709" | "?") && c.full_range != Some(true) && matches!(c.transfer, "bt709" | "iec61966-2-1" | "?");
                                        if ahead && !ok {
                                            eprintln!("artlux-engine: clock: {sid} not drawn ahead: colour {}/{}/{}/{:?} (the engine draws BT.709 limited only)", c.matrix, c.primaries, c.transfer, c.full_range);
                                            self.clip_bad.insert(sid.clone());
                                            continue;
                                        }
                                        if !ok && self.judge.contains(sid) {
                                            return Err(format!("track {sid}: an MP4 in colour space {}/{}/{}/{:?} (the engine draws BT.709 limited range only)", c.matrix, c.primaries, c.transfer, c.full_range));
                                        }
                                        self.mp4s.insert(sid.clone(), (_path.clone(), rx));
                                    }
                                    Err(e) if ahead => { eprintln!("artlux-engine: clock: {sid} not drawn ahead: MP4 {e}"); self.clip_bad.insert(sid.clone()); continue; }
                                    Err(e) => return Err(format!("surface {sid}: MP4 {e}")),
                                }
                            }
                            let conv = self.conv.get_or_insert_with(|| crate::yuv::GpuConvert::new(&self.gpu));
                            if let Some((_, rx)) = self.mp4s.get_mut(sid) {
                                match rx.picture(&self.gpu, conv, local) {
                                    Ok(pic) => { self.pictures.insert(sid.clone(), pic); self.gens.insert(sid.clone(), key); }
                                    Err(e) if ahead => { eprintln!("artlux-engine: clock: {sid} not drawn ahead: {e}"); self.clip_bad.insert(sid.clone()); }
                                    Err(e) => return Err(format!("surface {sid}: {e}")),
                                }
                            }
                        }
                    }
                    #[cfg(not(windows))]
                    { let _ = dur_us; self.pictures.remove(sid); }
                }
                Source::Camera(c) => {
                    // A live source: the NEWEST frame the shared reader has (as the app draws its newest), drawn
                    // when it is a new one. A surface only a projector shows is opened here on first use.
                    #[cfg(windows)]
                    {
                        if !self.cams.contains_key(sid) {
                            if let Some(fp) = v["camfp"][sid].as_array() { self.try_resolve(sid, c, fp); }
                            if self.ensure_camera(sid, c).is_err() { self.pictures.remove(sid); continue; }
                        }
                        let (_, rx, last) = self.cams.get_mut(sid).unwrap();
                        if let Some((seq, g)) = rx.latest() {
                            if seq != *last || !self.pictures.contains_key(sid) {
                                *last = seq;
                                let conv = self.conv.get_or_insert_with(|| crate::yuv::GpuConvert::new(&self.gpu));
                                let pic = crate::cam::picture(&self.gpu, conv, g.as_ref().unwrap(), c.app).map_err(|e| format!("surface {sid}: camera {e}"))?;
                                drop(g);
                                self.pictures.insert(sid.clone(), pic);
                                self.gen += 1; self.gens.insert(sid.clone(), self.gen << 2 | 2);
                            }
                        }
                        // No frame yet: nothing drawn (black), as the app before its first frame.
                    }
                    #[cfg(not(windows))]
                    { let _ = c; self.pictures.remove(sid); }
                }
                // Held (the app's guard froze it): the last frame stays, as the app's does.
                Source::Shader(spec) if spec.hold && self.pictures.contains_key(sid) => {}
                Source::Shader(spec) => {
                    // Compiled on first use too: a surface shown only by a projector or the 3D view is drawn
                    // without the LED verdict having seen it. A text that will not compile draws nothing.
                    if self.shaders.get(sid).is_none_or(|r| !r.fits(spec)) {
                        match crate::shader::Runner::new(&self.gpu, spec) {
                            Ok(r) => { self.shaders.insert(sid.clone(), r); }
                            Err(e) => { eprintln!("artlux-engine: surface {sid}: shader: {}", e.lines().next().unwrap_or("")); self.pictures.remove(sid); continue; }
                        }
                    }
                    if !self.pictures.contains_key(sid) { eprintln!("artlux-engine: surface {sid}: shader drawn by the engine ({}x{}, {} inputs{})", spec.w, spec.h, spec.inputs.len(), if spec.last_frame { ", feedback" } else { "" }); }
                    let st = v["times"][sid].as_f64().unwrap_or(t);   // a timeline clip: its clip-local time
                    let tex = self.shaders.get_mut(sid).unwrap().render(&self.gpu, spec.w, spec.h, st, &v["shader"][sid]);
                    self.pictures.insert(sid.clone(), Picture::gpu_frame(spec.w, spec.h, tex, [0, 0, spec.w, spec.h]));
                    // On an engine projector: drawn again at that output's own size (the largest, if several).
                    let css = self.projectors.iter().filter(|(_, s, _)| s == sid).filter_map(|(_, _, o)| Some((o["css"][0].as_f64()?, o["css"][1].as_f64()?))).max_by(|a, b| (a.0 * a.1).total_cmp(&(b.0 * b.1)));
                    match css {
                        Some((cw, ch)) => {
                            let (pw, ph) = crate::shader::size_for(cw * ch, spec.w as f64 / spec.h.max(1) as f64);
                            let key = format!("{sid}@proj");
                            if !self.shaders.contains_key(&key) {
                                if let Ok(r) = crate::shader::Runner::new(&self.gpu, spec) { self.shaders.insert(key.clone(), r); }
                            }
                            if let Some(r) = self.shaders.get_mut(&key) {
                                let tex = r.render(&self.gpu, pw, ph, st, &v["shader"][sid]);
                                self.proj_pictures.insert(sid.clone(), Picture::gpu_frame(pw, ph, tex, [0, 0, pw, ph]));
                            }
                        }
                        None => { self.proj_pictures.remove(sid); }
                    }
                    self.gen += 1; self.gens.insert(sid.clone(), self.gen << 2 | 2);
                }
                // E2: the app's own raster, as it last shipped it (black until the first arrives — it is sent
                // before the document that names it, so that is never on the wire).
                Source::Raster => {
                    match self.rasters.get(sid) {
                        Some((g, pic)) => {
                            let key = (*g << 2) | 1;
                            if self.gens.get(sid) != Some(&key) || !self.pictures.contains_key(sid) {
                                self.pictures.insert(sid.clone(), Picture { w: pic.w, h: pic.h, rgba: pic.rgba.clone(), mips: pic.mips, crop: pic.crop, tex: pic.tex.clone() });
                                self.gens.insert(sid.clone(), key);
                            }
                        }
                        None => { self.pictures.remove(sid); }
                    }
                    match self.rasters.get(&format!("{sid}@proj")) {
                        Some((_, pic)) => { self.proj_pictures.insert(sid.clone(), Picture { w: pic.w, h: pic.h, rgba: pic.rgba.clone(), mips: pic.mips, crop: pic.crop, tex: pic.tex.clone() }); }
                        None => { self.proj_pictures.remove(sid); }
                    }
                }
                // E2: tracking blobs, drawn from what the app drew this frame (blobs.rs). No instances this
                // tick (the app has not drawn the surface yet): transparent, as the app's canvas starts.
                Source::Blobs(w, h) => {
                    if self.blobs.is_none() { self.blobs = Some(crate::blobs::Blobs::new(&self.gpu)); }
                    let f = |k: &str| -> Vec<f32> { v["blobs"][sid][k].as_array().into_iter().flatten().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect() };
                    let tex = self.blobs.as_ref().unwrap().render(&self.gpu, *w, *h, &f("b"), &f("t"));
                    self.pictures.insert(sid.clone(), Picture::gpu_frame(*w, *h, tex, [0, 0, *w, *h]));
                    self.gen += 1; self.gens.insert(sid.clone(), self.gen << 2 | 2);
                }
                Source::Comp(_) => {}   // composited below, once its tracks are drawn
                Source::Slice(..) => {}  // E6f: cut below, once every other picture is drawn
                Source::None => { self.pictures.remove(sid); }
            }
        }
        // E3a: the timeline composites, from the tracks' pictures drawn above (comp.rs).
        let comps: Vec<(String, CompSpec)> = doc.sources.iter().filter_map(|(k, s)| if let Source::Comp(c) = s { Some((k.clone(), c.clone())) } else { None }).collect();
        for (sid, spec) in comps { self.composite(&sid, &spec, v); }
        // E6f: the slices, from the pictures drawn above (a slice of a composite included; slices do not nest).
        let slices: Vec<(String, String, [f64; 4])> = doc.sources.iter().filter_map(|(k, s)| if let Source::Slice(of, r) = s { Some((k.clone(), of.clone(), *r)) } else { None }).collect();
        for (sid, of, r) in slices { self.slice(&sid, &of, r); }
        // Twin cameras waiting for the app's picture: resolve with the fingerprint this tick carries, then the
        // document is answered AGAIN (serve.rs) — the engine may own it now.
        #[cfg(windows)]
        {
            let waiting: Vec<(String, String)> = self.pending_cams.iter().map(|(k, l)| (k.clone(), l.clone())).collect();
            for (sid, _) in waiting {
                let Some(Source::Camera(c)) = doc.sources.get(&sid) else { continue }; let c = c.clone();
                if let Some(fp) = v["camfp"][&sid].as_array() { if self.try_resolve(&sid, &c, fp) { self.pending_cams.remove(&sid); self.redo = true; } }
            }
        }
        Ok(())
    }

    fn place_and_send(&mut self, doc: &mut Doc, v: &Value, brightness: f32, viewing: bool) -> Result<(), String> {
        // E3f: each light's channels as the ENGINE solved them this tick (lightpack.rs, checked against the
        // app's). E1f-2's fallback: the host's, as ITS precedence stack wrote them — for a tick the engine did not
        // solve (a document it does not have yet, an older host with no profiles). None at all = a light nobody
        // could describe, which writes nothing, exactly as packUniverses does.
        for &i in &doc.lights {
            let id = doc.pfix[i].id.clone();
            if let Some(b) = self.light_solved.get(&id) { doc.pfix[i].light_channels = b.clone(); continue; }
            doc.pfix[i].light_channels = v["lights"][&id].as_array()
                .map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0).min(255) as u8).collect()).unwrap_or_default();
        }
        let fd = compose::FrameDoc { fixtures: &doc.lfix, surfaces: &doc.surfaces, pictures: &self.pictures, opacity: &doc.opacity, brightness };
        let raw = compose::frame_cached(&self.gpu, &fd, Some((&mut self.cache, &self.gens))).map_err(|e| e.to_string())?;
        if viewing { self.publish_view(doc, &raw); }
        if !doc.owns { return Ok(()); }
        let dests = pack::pack(&raw, &doc.pfix, &doc.controllers, &doc.defaults, &doc.lut);
        let frame = wire::encode_frame(&dests, doc.port);
        self.send(&frame);
        self.frames += 1;
        Ok(())
    }

    /// The SENDER's own counters (packets/s, frames/s incl. keep-alive, universes in the last frame) — the same
    /// numbers the app's output engine reports, from the same core. Reported with each `sent`, so while the
    /// engine owns the wire the operator's LIVE / pps readout is the wire's truth and not the muted app's zeros.
    pub fn wire_stats(&self) -> (u32, u32, u32) {
        self.out.as_ref().map(|o| { let s = o.stats(); (s.pps, s.fps, s.universes) }).unwrap_or((0, 0, 0))
    }

    pub fn close(&mut self) {
        if let Some(o) = self.out.take() { o.close(); }
        if let Some((proxy, _)) = &self.outputs { let _ = proxy.send_event(crate::outputs::Cmd::Quit); }
    }
}

// ── E6a: A BAKE DRAWN BY THE ENGINE ──────────────────────────────────────────────────────────────────────────
// The app keeps the bake's ORCHESTRATION (plugins/bake bakeRunner.ts): it steps its clock frame by frame, runs the
// show's evaluation at each step (the state machine, scenes, automation) and settles its own decoders, so the
// document and the tick it sends describe exactly that frame. The engine draws the surface from them — the same
// sources the wire and the projectors read, at the app's STEPPED clock (never its own: a bake's clock does not
// run) — scales it to the file's size and encodes it (encode.rs). The picture never crosses a process; one frame
// is one request, answered when it is in the encoder, so nothing is coalesced and nothing dropped.
#[cfg(windows)]
impl Runtime {
    /// `{"type":"bakeBegin", surface, path, w, h, fps, bitrate, audio}` → the encoder's name.
    pub fn bake_begin(&mut self, m: &Value) -> Result<Value, String> {
        if self.bake.is_some() { return Err("a bake is already in flight in the engine".into()); }
        let doc = self.doc.as_ref().ok_or("the engine has no document yet")?;
        let sid = m["surface"].as_str().ok_or("no surface named")?.to_string();
        match doc.sources.get(&sid) {
            None => return Err(format!("the engine's document has no surface {sid}")),
            Some(Source::None) => return Err("the engine does not draw this surface's content".into()),
            Some(Source::Spout(_) | Source::Ndi(_) | Source::Camera(_) | Source::Blobs(..)) => return Err("a live source — it shows whatever arrives, and stepping a clock does not move it".into()),
            _ => {}
        }
        let s = crate::encode::Settings {
            w: m["w"].as_u64().unwrap_or(0) as u32, h: m["h"].as_u64().unwrap_or(0) as u32,
            fps: m["fps"].as_f64().unwrap_or(0.0), bitrate: m["bitrate"].as_u64().unwrap_or(8_000_000) as u32,
            audio: m["audio"].as_bool().unwrap_or(false),
        };
        let path = m["path"].as_str().ok_or("no file named")?;
        let out = crate::encode::Mp4Writer::create(path, &s)?;   // E6b: encoded on its own thread
        let encoder = out.encoder().to_string();
        eprintln!("artlux-engine: bake: surface {sid} → {path} ({}x{} @ {} fps, {encoder}{})", s.w, s.h, s.fps, if s.audio { ", AAC" } else { "" });
        self.bake = Some(Bake { out, scaler: crate::bakescale::Scaler::new(&self.gpu, s.w, s.h), surface: sid, w: s.w, h: s.h, draw_ms: 0.0, read_ms: 0.0, enc_ms: 0.0, started: std::time::Instant::now(), blank: 0 });
        Ok(serde_json::json!({ "encoder": encoder }))
    }

    /// `{"type":"bakeFrame", tick, pcm?}` — `tick` is exactly the live tick for this frame (nativeLink.frame), `pcm`
    /// this frame's sound (interleaved stereo f32, base64), written before the picture as the app's bake does.
    pub fn bake_frame(&mut self, m: &Value) -> Result<Value, String> {
        let Some(mut doc) = self.doc.take() else { return Err("the engine has no document".into()) };
        let r = self.bake_frame_with(&mut doc, m);
        self.doc = Some(doc);
        r
    }

    fn bake_frame_with(&mut self, doc: &mut Doc, m: &Value) -> Result<Value, String> {
        use base64::Engine as _;
        if self.bake.is_none() { return Err("no bake in flight".into()); }
        let v = &m["tick"];
        if v["rev"].as_u64() != Some(doc.rev) { return Err(format!("a frame of document {} — the engine has document {}", v["rev"], doc.rev)); }
        let (Some(ph), Some(st)) = (v["ph"].as_f64(), v["t"].as_f64()) else { return Err("a frame with no time".into()) };
        // The surface must still be one the engine draws: a document that changed under the bake (the surface's
        // content swapped, a binding made live) would otherwise record black frames that look like a finished file.
        match doc.sources.get(&self.bake.as_ref().unwrap().surface) {
            None | Some(Source::None) => return Err("the engine no longer draws this surface — its content changed under the bake".into()),
            _ => {}
        }
        let t0 = std::time::Instant::now();
        // AT THE APP'S STEPPED CLOCK: the lanes, the clips and the video frames all from (ph, t) as sent.
        self.draw_at = Some((ph, st));
        self.evaluate_lanes(doc, v);
        let ev = self.evaluate_clock(doc, v);
        self.draw_sources(doc, ev.as_ref().unwrap_or(v))?;
        let t1 = std::time::Instant::now();
        let b = self.bake.as_mut().unwrap();
        let (w, h) = (b.w, b.h);
        let mut nv12 = false;
        let px = match self.pictures.get(&b.surface) {
            // The picture at the file's size (bakescale.rs): the CONTENT only, filling the frame — the warp, blend
            // and calibration stay live and apply to the file later (docs/BAKE.md).
            // E6c: NV12 straight from the GPU where the width allows (a multiple of 4), else RGBA for the CPU.
            Some(p) if b.scaler.gpu_nv12() => { let f = b.scaler.frame_nv12(&self.gpu, p, self.gens.get(&b.surface).copied().unwrap_or(0))?; nv12 = true; f }
            Some(p) => b.scaler.frame(&self.gpu, p, self.gens.get(&b.surface).copied().unwrap_or(0))?,
            None => { b.blank += 1; vec![0u8; (w * h * 4) as usize] }   // drew nothing this frame: black, as the app's canvas
        };
        let t2 = std::time::Instant::now();
        if let Some(s) = m["pcm"].as_str() {
            let raw = base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| format!("sound: {e}"))?;
            let pcm: Vec<f32> = raw.chunks_exact(4).map(|q| f32::from_le_bytes([q[0], q[1], q[2], q[3]])).collect();
            b.out.audio(pcm)?;
        }
        // The pictures are premultiplied (and opaque where a video is): the colour video is the surface over black.
        if nv12 { b.out.frame_nv12(px)?; } else { b.out.frame(px)?; }   // queued to the encoder thread; the next frame is drawn meanwhile
        let t3 = std::time::Instant::now();
        b.draw_ms += (t1 - t0).as_secs_f64() * 1000.0;
        b.read_ms += (t2 - t1).as_secs_f64() * 1000.0;
        b.enc_ms += (t3 - t2).as_secs_f64() * 1000.0;
        Ok(serde_json::json!({ "frame": b.out.frames() }))
    }

    /// `{"type":"bakeEnd"}` → the file is closed; what it holds and what it cost.
    pub fn bake_end(&mut self) -> Result<Value, String> {
        let b = self.bake.take().ok_or("no bake in flight")?;
        let (frames, audio, encoder, path) = (b.out.frames(), b.out.audio_samples(), b.out.encoder().to_string(), b.out.path.clone());
        let f0 = std::time::Instant::now();
        let enc_total = b.out.finish()?;
        let n = frames.max(1) as f64;
        let secs = b.started.elapsed().as_secs_f64();
        eprintln!("artlux-engine: bake: {frames} frame(s){} written to {path} in {secs:.1} s ({encoder}); per frame: draw {:.2} ms, read back {:.2} ms, handed to the encoder {:.2} ms (encoding {:.2} ms on its own thread); queue drained and file closed in {:.0} ms{}",
            if audio > 0 { format!(" + {audio} sample(s) of sound") } else { String::new() },
            b.draw_ms / n, b.read_ms / n, b.enc_ms / n, enc_total / n, f0.elapsed().as_secs_f64() * 1000.0,
            if b.blank > 0 { format!("; {} frame(s) the surface drew nothing (black)", b.blank) } else { String::new() });
        Ok(serde_json::json!({ "frames": frames, "audioSamples": audio, "encoder": encoder, "path": path, "blank": b.blank,
            "drawMs": b.draw_ms / n, "readMs": b.read_ms / n, "handMs": b.enc_ms / n, "encodeMs": enc_total / n, "seconds": secs }))
    }

    /// `{"type":"bakeCancel"}`: the encoder is dropped unfinished and the half file deleted — a file that plays for
    /// most of its length and then stops reads as a finished one.
    pub fn bake_cancel(&mut self) -> Result<Value, String> {
        if let Some(b) = self.bake.take() {
            let path = b.out.path.clone();
            drop(b);
            let _ = std::fs::remove_file(&path);
            eprintln!("artlux-engine: bake: cancelled, {path} removed");
        }
        Ok(Value::Null)
    }
}

#[cfg(not(windows))]
impl Runtime {
    pub fn bake_begin(&mut self, _m: &Value) -> Result<Value, String> { Err("the engine encodes a bake with Media Foundation — Windows only so far".into()) }
    pub fn bake_frame(&mut self, _m: &Value) -> Result<Value, String> { Err("no bake in flight".into()) }
    pub fn bake_end(&mut self) -> Result<Value, String> { Err("no bake in flight".into()) }
    pub fn bake_cancel(&mut self) -> Result<Value, String> { Ok(Value::Null) }
}

#[cfg(windows)]
impl Runtime {
    /// The surface's camera, read SHARED: resolved by label (one camera of that name and vid:pid), or — twins —
    /// by the picture resolution already made (`resolved`). Refused, with the reason, when the engine cannot
    /// draw it as the app does: not a camera Media Foundation lists, twins not identified yet, or a holder
    /// streaming MJPEG (the engine's own MJPEG decode is not measured against Chromium's yet — step 3).
    fn ensure_camera(&mut self, sid: &str, c: &CamSpec) -> Result<(), String> {
        if self.cams.get(sid).is_some_and(|(l, _, _)| l == &c.label) { return Self::mjpeg_check(&self.cams[sid].1); }
        let link = match self.resolved.get(&(sid.to_string(), c.label.clone())) {
            Some(l) => l.clone(),
            None => match crate::cam::resolve(&c.label, None, c.app) {
                Ok((l, _)) => l,
                Err(e) if c.twins || e.contains("picture is needed") => {
                    self.pending_cams.insert(sid.to_string(), c.label.clone());
                    return Err(format!("identifying which \"{}\" by its picture ({e})", c.label));
                }
                Err(e) => return Err(e),
            },
        };
        let rx = crate::camshared::SharedIn::open(&link).map_err(|e| format!("camera \"{}\": {e}", c.label))?;
        Self::mjpeg_check(&rx)?;
        self.cams.insert(sid.to_string(), (c.label.clone(), rx, 0));
        Ok(())
    }

    fn mjpeg_check(rx: &crate::camshared::SharedIn) -> Result<(), String> {
        if rx.controller.starts_with("MJPG") { Err(format!("the app's camera streams MJPEG ({}) — the engine's MJPEG decode is not yet measured against the app's", rx.controller)) } else { Ok(()) }
    }

    /// Twins: resolve by the app's fingerprint `fp`. True once resolved (kept for this surface and label).
    fn try_resolve(&mut self, sid: &str, c: &CamSpec, fp: &[Value]) -> bool {
        let fp: Vec<u8> = fp.iter().map(|x| x.as_u64().unwrap_or(0).min(255) as u8).collect();
        match crate::cam::resolve(&c.label, Some(&fp), c.app) {
            Ok((link, why)) => { eprintln!("artlux-engine: camera \"{}\" for surface {sid}: {why}", c.label); self.resolved.insert((sid.to_string(), c.label.clone()), link); true }
            Err(e) => { eprintln!("artlux-engine: camera \"{}\" for surface {sid}: {e}", c.label); false }
        }
    }
}

fn name_of(d: &Value, sid: &str) -> String {
    d["surfaces"].as_array().into_iter().flatten().find(|s| s["id"] == sid).and_then(|s| s["name"].as_str()).unwrap_or(sid).to_string()
}
