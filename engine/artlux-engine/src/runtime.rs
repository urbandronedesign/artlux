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
/// which is its track's picture itself), and its tracks back-most first: (hidden source key, opacity, blend).
#[derive(PartialEq, Clone)]
struct CompSpec { w: u32, h: u32, single: bool, layers: Vec<(String, f32, String)> }

#[derive(PartialEq)]
enum Source { Image(String), Effect(Params), Hap(String), Spout(String), Ndi(String), Mp4(String, i64), Camera(CamSpec), Shader(crate::shader::Spec), Raster, Blobs(u32, u32), Comp(CompSpec), None }

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
    owns: bool,
    /// E1f-2: the fixtures the HOST says are lights (indices into pfix).
    lights: Vec<usize>,
}

pub struct Runtime {
    gpu: Arc<Gpu>,
    out: Option<OutputEngine>,
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
}

impl Runtime {
    pub fn new(gpu: Arc<Gpu>) -> Self {
        Runtime { gpu, out: None, broadcast: false, out_cfg: (44.0, true, false), doc: None, pictures: HashMap::new(), gens: HashMap::new(),
            images: HashMap::new(), effects: HashMap::new(), shaders: HashMap::new(), sources_summary: String::new(), proj_pictures: HashMap::new(), rasters: HashMap::new(), blobs: None, compositor: None, comp_tex: HashMap::new(), rng: Rng::new(0x5eed), cache: TexCache::default(), gen: 0, path_gens: HashMap::new(), frames: 0,
            outputs: None, projectors: Vec::new(), proj_published: HashMap::new(), proj_opts: HashMap::new(), opts_ver: 0,
            #[cfg(windows)] spouts: HashMap::new(),
            #[cfg(feature = "ndi")] ndis: HashMap::new(),
            #[cfg(windows)] mp4s: HashMap::new(), conv: None,
            #[cfg(windows)] cams: HashMap::new(), resolved: HashMap::new(), pending_cams: HashMap::new(), last_doc: None, redo: false,
            view: None, view_scene_ver: 0, view_published: HashMap::new(), view_colors_gen: 0, view_last_summary: String::new() }
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
        for (key, opacity, blend) in &spec.layers {
            let Some(p) = self.pictures.get(key) else { continue };   // not ready this frame: skipped, as the app does
            let alpha = v["comp"][sid][key].as_f64().unwrap_or(1.0) as f32;
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

    /// E2: `{"type":"raster","surface","gen","w","h","path"}` — a picture the app drew (main wrote its straight-
    /// alpha RGBA, row 0 at the top). Read now: main deletes the file once the next one is announced.
    pub fn raster(&mut self, v: &Value) {
        let (Some(sid), Some(path)) = (v["surface"].as_str(), v["path"].as_str()) else { return };
        let (w, h, g) = (v["w"].as_u64().unwrap_or(0) as u32, v["h"].as_u64().unwrap_or(0) as u32, v["gen"].as_u64().unwrap_or(0));
        match std::fs::read(path) {
            Ok(px) if px.len() == (w as usize) * (h as usize) * 4 && w > 0 => {
                // A CANVAS picture (premultiplied here, no mips) — as the app's compositor draws a bitmap.
                self.rasters.insert(sid.to_string(), (g, Arc::new(Picture::canvas(w, h, px))));
            }
            Ok(px) => eprintln!("artlux-engine: raster {sid}: {} bytes for {w}x{h}", px.len()),
            Err(e) => eprintln!("artlux-engine: raster {sid}: {e}"),
        }
    }

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
    }

    /// E1f-3: the windows thread the projector outputs live on (serve.rs starts it).
    pub fn set_outputs(&mut self, proxy: winit::event_loop::EventLoopProxy<crate::outputs::Cmd>, shared: Arc<std::sync::Mutex<crate::outputs::Shared>>) {
        self.outputs = Some((proxy, shared));
    }

    /// E1f-3: the document's projector outputs. ALL OR NOTHING, like the wire: when any enabled output is
    /// one the engine cannot draw (the host says why: calibrated, masked, hardware-warped, NDI-sent, a source
    /// the engine lacks...) it opens NONE and the app keeps every output. Err(why) when it will not drive
    /// them; Ok(n) when it asked the windows thread for n outputs (whose report answers main).
    pub fn projectors(&mut self, d: &Value) -> Result<usize, String> {
        let list = d["projectors"].as_array().cloned().unwrap_or_default();
        let why = if self.outputs.is_none() { Some("the engine has no window system here".to_string()) }
            else if list.is_empty() { Some("no projector output is enabled".to_string()) }
            else { list.iter().find_map(|p| p["why"].as_str().map(|w| format!("output '{}': {w}", p["name"].as_str().unwrap_or(p["id"].as_str().unwrap_or("?"))))) };
        let specs: Vec<crate::outputs::Spec> = if why.is_some() { Vec::new() } else { list.iter().map(|p| crate::outputs::Spec {
            id: p["id"].as_str().unwrap_or_default().to_string(),
            surface_id: p["surfaceId"].as_str().unwrap_or_default().to_string(),
            display: crate::windows::DisplayMatch {
                bounds: (|| Some((p["bounds"]["x"].as_i64()? as i32, p["bounds"]["y"].as_i64()? as i32, p["bounds"]["width"].as_u64()? as u32, p["bounds"]["height"].as_u64()? as u32)))(),
                index: None,
            },
            opts: crate::projector::Opts::from_json(&p["output"], 1.0, 4),
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
                    layers: src["layers"].as_array().into_iter().flatten().map(|l| (l["key"].as_str().unwrap_or_default().to_string(), l["opacity"].as_f64().unwrap_or(1.0) as f32, l["blend"].as_str().unwrap_or("normal").to_string())).collect(),
                }),
                "blobs" => Source::Blobs(src["w"].as_u64().unwrap_or(1920).clamp(2, 4096) as u32, src["h"].as_u64().unwrap_or(1024).clamp(2, 4096) as u32),
                "none" => Source::None,
                _ => Source::None,
            };
            sources.insert(id, source);
        }
        // E3a: a composite's tracks — hidden sources `layer:<id>`, sampled by no fixture, drawn only to be
        // composited. Same kinds as a surface's; an effect clip carries its own content.
        for (key, src) in d["sources"].as_object().into_iter().flatten() {
            if !key.starts_with("layer:") { continue; }
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
            sources.insert(key.clone(), source);
        }
        // What each surface's source resolved to, once per change (diagnostic: which kinds the engine was given).
        let kinds: Vec<String> = d["surfaces"].as_array().into_iter().flatten().map(|s| { let id = s["id"].as_str().unwrap_or_default(); let k = &d["sources"][id]; format!("{}={}{}", s["name"].as_str().unwrap_or(id), k["kind"].as_str().unwrap_or("?"), k["why"].as_str().map(|w| format!(" ({w})")).unwrap_or_default()) }).collect();
        let summary = kinds.join(", ");
        if summary != self.sources_summary { eprintln!("artlux-engine: sources: {summary}"); self.sources_summary = summary; }
        let mut doc = Doc { rev, lfix, surfaces, pfix, controllers, defaults, lut: pack::gamma_lut(d["gamma"].as_f64().unwrap_or(1.0)),
            port: d["port"].as_u64().unwrap_or(6454) as u16, sources, opacity, owns: false, lights: Vec::new() };
        let light_ids: Vec<&str> = d["lights"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).collect();
        doc.lights = doc.pfix.iter().enumerate().filter(|(_, f)| light_ids.contains(&f.id.as_str())).map(|(i, _)| i).collect();
        for &i in &doc.lights { doc.pfix[i].light = true; }
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
        let sampled: Vec<String> = layout::surface_order(&doc.lfix, &doc.surfaces);
        for sid in &sampled {
            let src = &d["sources"][sid];
            match src["kind"].as_str() {
                Some("image") | Some("effect") | Some("hap") | Some("spout") | Some("none") | Some("raster") | Some("blobs") => {}
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
        let Some(mut doc) = self.doc.take() else { return Ok(()) };
        let r = self.tick_with(&mut doc, v);
        self.doc = Some(doc);
        r
    }

    fn tick_with(&mut self, doc: &mut Doc, v: &Value) -> Result<(), String> {
        // The pictures are needed by the wire AND by the projectors, each owned on its own (E1f-3).
        // E4a: an open 3D view needs the pictures and the LED colours too, owned wire or not.
        let viewing = self.view_open();
        if (!doc.owns && self.projectors.is_empty() && !viewing) || v["rev"].as_u64() != Some(doc.rev) { return Ok(()); }
        let t = v["t"].as_f64().unwrap_or(0.0);
        let brightness = v["brightness"].as_f64().unwrap_or(1.0) as f32;
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
                        let (w, h, fmt, blocks, _) = crate::hapimport::read_frame(p, idx)?;
                        self.pictures.insert(sid.clone(), compose::hap_picture(&self.gpu, fmt, w, h, &blocks)?);
                        self.gens.insert(sid.clone(), key);
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
                            if self.mp4s.get(sid).is_none_or(|(q, _)| q != _path) {
                                let rx = crate::mf::Mp4In::open_with(_path, Some(&self.gpu)).map_err(|e| format!("surface {sid}: MP4 {e}"))?;
                                self.mp4s.insert(sid.clone(), (_path.clone(), rx));
                            }
                            let conv = self.conv.get_or_insert_with(|| crate::yuv::GpuConvert::new(&self.gpu));
                            if let Some((_, rx)) = self.mp4s.get_mut(sid) {
                                let pic = rx.picture(&self.gpu, conv, local).map_err(|e| format!("surface {sid}: {e}"))?;
                                self.pictures.insert(sid.clone(), pic);
                                self.gens.insert(sid.clone(), key);
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
                Source::None => { self.pictures.remove(sid); }
            }
        }
        // E3a: the timeline composites, from the tracks' pictures drawn above (comp.rs).
        let comps: Vec<(String, CompSpec)> = doc.sources.iter().filter_map(|(k, s)| if let Source::Comp(c) = s { Some((k.clone(), c.clone())) } else { None }).collect();
        for (sid, spec) in comps { self.composite(&sid, &spec, v); }
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
        self.publish_projectors(doc, v);
        if !doc.owns && !viewing { return Ok(()); }
        // E1f-2: each light's channels as THIS frame's precedence stack wrote them on the host (none sent = a
        // light the host could not describe, which writes nothing — exactly as packUniverses does).
        for &i in &doc.lights {
            let id = doc.pfix[i].id.clone();
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
