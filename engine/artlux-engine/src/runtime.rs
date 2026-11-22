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

#[derive(PartialEq)]
enum Source { Image(String), Effect(Params), Hap(String), Spout(String), Ndi(String), None }

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
}

impl Runtime {
    pub fn new(gpu: Arc<Gpu>) -> Self {
        Runtime { gpu, out: None, broadcast: false, out_cfg: (44.0, true, false), doc: None, pictures: HashMap::new(), gens: HashMap::new(),
            images: HashMap::new(), effects: HashMap::new(), rng: Rng::new(0x5eed), cache: TexCache::default(), gen: 0, path_gens: HashMap::new(), frames: 0,
            outputs: None, projectors: Vec::new(), proj_published: HashMap::new(), proj_opts: HashMap::new(), opts_ver: 0,
            #[cfg(windows)] spouts: HashMap::new(),
            #[cfg(feature = "ndi")] ndis: HashMap::new() }
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
            list.iter().map(|p| (p["id"].as_str().unwrap_or_default().to_string(), p["surfaceId"].as_str().unwrap_or_default().to_string(), p["output"].clone())).collect()
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
            if let (Some(&g), Some(p)) = (self.gens.get(sid), self.pictures.get(sid)) {
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
                "none" => Source::None,
                _ => Source::None,
            };
            sources.insert(id, source);
        }
        let mut doc = Doc { rev, lfix, surfaces, pfix, controllers, defaults, lut: pack::gamma_lut(d["gamma"].as_f64().unwrap_or(1.0)),
            port: d["port"].as_u64().unwrap_or(6454) as u16, sources, opacity, owns: false, lights: Vec::new() };
        let light_ids: Vec<&str> = d["lights"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).collect();
        doc.lights = doc.pfix.iter().enumerate().filter(|(_, f)| light_ids.contains(&f.id.as_str())).map(|(i, _)| i).collect();
        for &i in &doc.lights { doc.pfix[i].light = true; }
        // A surface whose SOURCE changed (another file, another kind) starts from nothing: its picture and
        // generation belong to the old source.
        if let Some(old) = &self.doc {
            for (k, src) in &doc.sources {
                if old.sources.get(k) != Some(src) && !matches!((old.sources.get(k), src), (Some(Source::Effect(_)), Source::Effect(_))) {
                    self.pictures.remove(k); self.gens.remove(k);
                }
            }
        }
        #[cfg(windows)]
        self.spouts.retain(|k, _| matches!(doc.sources.get(k), Some(Source::Spout(_))));
        #[cfg(feature = "ndi")]
        self.ndis.retain(|k, _| matches!(doc.sources.get(k), Some(Source::Ndi(_))));
        // Keep the effects' state (Fire's heat) across documents for surfaces that are still effects.
        self.effects.retain(|k, _| matches!(doc.sources.get(k), Some(Source::Effect(_))));
        let ids: Vec<String> = doc.sources.keys().cloned().collect();
        self.cache.retain(&|k| ids.iter().any(|i| i == k));
        self.pictures.retain(|k, _| ids.iter().any(|i| i == k));
        let verdict = self.verdict(d, &mut doc);
        self.doc = Some(doc);
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
                Some("image") | Some("effect") | Some("hap") | Some("spout") | Some("none") => {}
                // Item 2b: only an engine BUILT with NDI (the `ndi` feature links the SDK) can take it.
                Some("ndi") if cfg!(feature = "ndi") => {
                    // The runtime is delay-loaded: no NDI install here = the app keeps the show, with this reason.
                    #[cfg(feature = "ndi")]
                    crate::ndi::runtime().map_err(|e| format!("surface '{}': {e}", name_of(d, sid)))?;
                }
                Some("ndi") => return Err(format!("surface '{}': this engine build has no NDI (built without the NDI SDK)", name_of(d, sid))),
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
        if (!doc.owns && self.projectors.is_empty()) || v["rev"].as_u64() != Some(doc.rev) { return Ok(()); }
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
                    let rgba = e.render(*params, t, &mut self.rng).to_vec();
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
                Source::None => { self.pictures.remove(sid); }
            }
        }
        self.publish_projectors(doc, v);
        if !doc.owns { return Ok(()); }
        // E1f-2: each light's channels as THIS frame's precedence stack wrote them on the host (none sent = a
        // light the host could not describe, which writes nothing — exactly as packUniverses does).
        for &i in &doc.lights {
            let id = doc.pfix[i].id.clone();
            doc.pfix[i].light_channels = v["lights"][&id].as_array()
                .map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0).min(255) as u8).collect()).unwrap_or_default();
        }
        let fd = compose::FrameDoc { fixtures: &doc.lfix, surfaces: &doc.surfaces, pictures: &self.pictures, opacity: &doc.opacity, brightness };
        let raw = compose::frame_cached(&self.gpu, &fd, Some((&mut self.cache, &self.gens))).map_err(|e| e.to_string())?;
        let dests = pack::pack(&raw, &doc.pfix, &doc.controllers, &doc.defaults, &doc.lut);
        let frame = wire::encode_frame(&dests, doc.port);
        self.send(&frame);
        self.frames += 1;
        Ok(())
    }

    pub fn close(&mut self) {
        if let Some(o) = self.out.take() { o.close(); }
        if let Some((proxy, _)) = &self.outputs { let _ = proxy.send_event(crate::outputs::Cmd::Quit); }
    }
}

fn name_of(d: &Value, sid: &str) -> String {
    d["surfaces"].as_array().into_iter().flatten().find(|s| s["id"] == sid).and_then(|s| s["name"].as_str()).unwrap_or(sid).to_string()
}
