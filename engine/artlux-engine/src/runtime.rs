//! E1f-1 — THE ENGINE RUNS THE LED OUTPUT AT RUNTIME, from the document the host sends it.
//!
//! "The host evaluates, the engine draws": the app keeps evaluating the show (scenes, the timeline, the
//! state machine, overrides) into the EFFECTIVE surfaces and fixtures of the moment, and decides, per
//! surface, which SOURCE the engine is to draw (src/renderer/engine/nativeLink.ts — it knows bakes, codecs,
//! slices; the engine does not guess). The engine composes its own atlas from those sources, samples, packs
//! and sends — every step already proven against the app (E1b–E1d).
//!
//! OWNERSHIP IS ALL OR NOTHING, per document. There is one wire: the engine sends only when it can draw
//! EVERY sampled surface and every fixture; otherwise it says why and stays silent, and the app keeps the
//! wire (main mutes the app's frames only while the engine owns it — src/main/engineHost.ts). Losing
//! ownership empties the send thread, so its keep-alive cannot repeat a stale frame over the app's.
//!
//! Messages (JSON lines, main → engine; see serve.rs for the transport):
//!   {"type":"output","broadcast":b,"fps":n,"keepAlive":b,"sync":b}        the output engine's settings
//!   {"type":"doc","doc":{rev, fixtures, surfaces, controllers, defaults, gamma, port, outputEnabled,
//!                        sources: {surfaceId: {kind: image|effect|hap|none|unsupported, path?, why?}}}}
//!   {"type":"tick","rev":r,"t":showTime,"brightness":b,"hap":{surfaceId: frameIndex}}   one frame
//! engine → main: {"type":"owns","rev":r,"owns":bool,"why":"…"} once per document.

use crate::compose::{self, Picture, TexCache};
use crate::effects::{Params, Rng, SurfaceEffect};
use crate::{layout, pack, wire, Gpu};
use artlux_output_engine::core::OutputEngine;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(PartialEq)]
enum Source { Image(String), Effect(Params), Hap(String), None }

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
}

impl Runtime {
    pub fn new(gpu: Arc<Gpu>) -> Self {
        Runtime { gpu, out: None, broadcast: false, out_cfg: (44.0, true, false), doc: None, pictures: HashMap::new(), gens: HashMap::new(),
            images: HashMap::new(), effects: HashMap::new(), rng: Rng::new(0x5eed), cache: TexCache::default(), gen: 0, path_gens: HashMap::new(), frames: 0 }
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
                "none" => Source::None,
                _ => Source::None,
            };
            sources.insert(id, source);
        }
        let mut doc = Doc { rev, lfix, surfaces, pfix, controllers, defaults, lut: pack::gamma_lut(d["gamma"].as_f64().unwrap_or(1.0)),
            port: d["port"].as_u64().unwrap_or(6454) as u16, sources, opacity, owns: false };
        // A surface whose SOURCE changed (another file, another kind) starts from nothing: its picture and
        // generation belong to the old source.
        if let Some(old) = &self.doc {
            for (k, src) in &doc.sources {
                if old.sources.get(k) != Some(src) && !matches!((old.sources.get(k), src), (Some(Source::Effect(_)), Source::Effect(_))) {
                    self.pictures.remove(k); self.gens.remove(k);
                }
            }
        }
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
        if let Some(f) = d["fixtures"].as_array().into_iter().flatten().find(|f| !f["profileId"].is_null() && f["profileId"] != "") {
            return Err(format!("fixture '{}' is a light — the engine does not drive lights yet", f["name"].as_str().unwrap_or("?")));
        }
        let sampled: Vec<String> = layout::surface_order(&doc.lfix, &doc.surfaces);
        for sid in &sampled {
            let src = &d["sources"][sid];
            match src["kind"].as_str() {
                Some("image") | Some("effect") | Some("hap") | Some("none") => {}
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
        let Some(doc) = self.doc.take() else { return Ok(()) };
        let r = self.tick_with(&doc, v);
        self.doc = Some(doc);
        r
    }

    fn tick_with(&mut self, doc: &Doc, v: &Value) -> Result<(), String> {
        if !doc.owns || v["rev"].as_u64() != Some(doc.rev) { return Ok(()); }
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
                        let pic = self.images[p].clone();
                        self.pictures.insert(sid.clone(), Picture { w: pic.w, h: pic.h, rgba: pic.rgba.clone(), mips: pic.mips });
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
                Source::None => { self.pictures.remove(sid); }
            }
        }
        let fd = compose::FrameDoc { fixtures: &doc.lfix, surfaces: &doc.surfaces, pictures: &self.pictures, opacity: &doc.opacity, brightness };
        let raw = compose::frame_cached(&self.gpu, &fd, Some((&mut self.cache, &self.gens))).map_err(|e| e.to_string())?;
        let dests = pack::pack(&raw, &doc.pfix, &doc.controllers, &doc.defaults, &doc.lut);
        let frame = wire::encode_frame(&dests, doc.port);
        self.send(&frame);
        self.frames += 1;
        Ok(())
    }

    pub fn close(&mut self) { if let Some(o) = self.out.take() { o.close(); } }
}

fn name_of(d: &Value, sid: &str) -> String {
    d["surfaces"].as_array().into_iter().flatten().find(|s| s["id"] == sid).and_then(|s| s["name"].as_str()).unwrap_or(sid).to_string()
}
