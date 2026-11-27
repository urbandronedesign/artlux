//! O5-2a — ONE VENUE ON THE GPU (plans/engine-optimisation-and-deferred-3d.md O5-2, the first step of `SceneGpu`).
//!
//! Measured 2026-11-27 (bench `E:/zaki/artlux-engine-test/O5-scene`, three calibrated outputs over one 56 MB textured
//! GLB with the 3D view open): the file was PARSED four times — once per calibrated presenter (calib3d `glb`) and once
//! by the 3D view (view3d) — and each kept its own decoded images, uploaded its own vertex and index buffers and made
//! its own textures of the file's images (a calibrated output compiling a mip shader per map on the way). The O-3
//! finding: N + 1 copies of the venue, in RAM and in VRAM.
//!
//! Here, per file VERSION (path + size + mtime — an edited file is a new one):
//!   - `cpu`: the parse, ONCE — concurrent callers wait for the first, later ones take the result while anyone holds it;
//!   - `bufs`: the GPU buffers, once per (device, file, flavour) — the 3D view reads glTF's v as stored, the calibrated
//!     venue v flipped (modelScreens.flippedUv) with its second vertex buffer, so two flavours, never N;
//!   - `image`: a file image as a texture, once per (device, file, image, format) — the venue's sRGB mipped own maps,
//!     the 3D view's linear single-level ones.
//! Each cache holds WEAK references: what no consumer holds any more is freed, exactly as before, and a file nobody
//! shows does not stay resident. The consumers keep their own pipelines, shaders and draw paths (calib3d's pixel parity
//! is untouched — only residency is shared, never formats or arithmetic).

use crate::view3d::CpuGlb;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, Weak};

/// A parsed file, and the version it was parsed from.
pub struct Loaded { pub key: String, pub(crate) cpu: CpuGlb }

/// The file's version: what makes two requests the same parse.
pub fn file_key(path: &str) -> String {
    let m = std::fs::metadata(path).ok();
    let (len, mt) = m.map(|m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos()))).unwrap_or((0, 0));
    format!("{}|{len}|{mt}", crate::preroll::key(path))
}

type Slot = Arc<(Mutex<Option<Result<Arc<Loaded>, String>>>, Condvar)>;
enum CpuState { Loading(Slot), Done(Weak<Loaded>) }
static CPU: Mutex<Option<HashMap<String, CpuState>>> = Mutex::new(None);

/// The file, parsed ONCE however many outputs and views ask. Blocks — call it off a render / presenter thread (both
/// consumers do, on their loader threads).
pub fn cpu(path: &str) -> Result<Arc<Loaded>, String> {
    let key = file_key(path);
    let waiting = {
        let mut g = CPU.lock().unwrap_or_else(|e| e.into_inner());
        let m = g.get_or_insert_with(HashMap::new);
        m.retain(|_, s| !matches!(s, CpuState::Done(w) if w.strong_count() == 0));
        match m.get(&key) {
            Some(CpuState::Done(w)) => { if let Some(l) = w.upgrade() { eprintln!("artlux-engine: venue {path}: shared (parsed once)"); return Ok(l); } None }
            Some(CpuState::Loading(s)) => Some(s.clone()),
            None => None,
        }
    };
    if let Some(s) = waiting {
        let (lock, cv) = &*s;
        let mut r = lock.lock().unwrap_or_else(|e| e.into_inner());
        while r.is_none() { r = cv.wait(r).unwrap_or_else(|e| e.into_inner()); }
        eprintln!("artlux-engine: venue {path}: shared (waited for its parse)");
        return r.as_ref().unwrap().clone();
    }
    let slot: Slot = Arc::new((Mutex::new(None), Condvar::new()));
    CPU.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(key.clone(), CpuState::Loading(slot.clone()));
    let t0 = std::time::Instant::now();
    let r = crate::view3d::load_glb(path).map(|cpu| Arc::new(Loaded { key: key.clone(), cpu }));
    eprintln!("artlux-engine: venue {path}: parsed in {:.0} ms", t0.elapsed().as_secs_f64() * 1e3);
    {
        let mut g = CPU.lock().unwrap_or_else(|e| e.into_inner());
        let m = g.get_or_insert_with(HashMap::new);
        match &r { Ok(l) => { m.insert(key, CpuState::Done(Arc::downgrade(l))); } Err(_) => { m.remove(&key); } }
    }
    let (lock, cv) = &*slot;
    *lock.lock().unwrap_or_else(|e| e.into_inner()) = Some(r.clone());
    cv.notify_all();
    r
}

/// A file's primitives as GPU buffers, in `cpu.prims` order. `ex` (the calibrated flavour only): COLOR_0 + TANGENT.
pub struct GlbBufs { pub vb: Vec<wgpu::Buffer>, pub ib: Vec<wgpu::Buffer>, pub ex: Vec<wgpu::Buffer> }

static BUFS: Mutex<Vec<(wgpu::Device, String, bool, Weak<GlbBufs>)>> = Mutex::new(Vec::new());

/// The buffers of `l` on this device — `flip_v`: glTF's v turned to 1 − v in f32 (the calibrated venue's flavour,
/// modelScreens.flippedUv, with `ex`), else as stored (the 3D view's). Made once per (device, file, flavour).
pub fn bufs(gpu: &crate::Gpu, l: &Loaded, flip_v: bool) -> Arc<GlbBufs> {
    use wgpu::util::DeviceExt;
    let d = &gpu.device;
    let mut g = BUFS.lock().unwrap_or_else(|e| e.into_inner());
    g.retain(|e| e.3.strong_count() > 0);
    if let Some(b) = g.iter().find(|e| &e.0 == d && e.1 == l.key && e.2 == flip_v).and_then(|e| e.3.upgrade()) { return b; }
    let f32s = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let mut b = GlbBufs { vb: Vec::new(), ib: Vec::new(), ex: Vec::new() };
    for p in &l.cpu.prims {
        let vb = if flip_v {
            let mut v = p.verts.clone();
            for k in (0..v.len()).step_by(8) { v[k + 7] = 1.0 - v[k + 7]; }
            f32s(&v)
        } else { f32s(&p.verts) };
        b.vb.push(d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(if flip_v { "venue vb (calib)" } else { "venue vb (view)" }), contents: &vb, usage: wgpu::BufferUsages::VERTEX }));
        b.ib.push(d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("venue ib"), contents: &p.idx.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(), usage: wgpu::BufferUsages::INDEX }));
        if flip_v { b.ex.push(d.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("venue ex"), contents: &f32s(&p.extra), usage: wgpu::BufferUsages::VERTEX })); }
    }
    let b = Arc::new(b);
    g.push((d.clone(), l.key.clone(), flip_v, Arc::downgrade(&b)));
    b
}

/// What a file image is made into: the calibrated venue's own map (sRGB or linear, a full mip chain) or the 3D view's
/// picture (linear, one level).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ImageUse { VenueMap { srgb: bool }, View }

static IMAGES: Mutex<Vec<(wgpu::Device, String, usize, ImageUse, Weak<wgpu::Texture>)>> = Mutex::new(Vec::new());

/// File image `i` of `file_key` as a texture made by `make` — once per (device, file, image, use), while anyone holds it.
pub fn image(gpu: &crate::Gpu, file_key: &str, i: usize, u: ImageUse, make: impl FnOnce() -> wgpu::Texture) -> Arc<wgpu::Texture> {
    let d = &gpu.device;
    {
        let mut g = IMAGES.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|e| e.4.strong_count() > 0);
        if let Some(t) = g.iter().find(|e| &e.0 == d && e.1 == file_key && e.2 == i && e.3 == u).and_then(|e| e.4.upgrade()) { return t; }
    }
    // Made OUTSIDE the lock (an upload + mips of a big image); two makers at once both make it, one is kept — rare,
    // and still correct.
    let t = Arc::new(make());
    let mut g = IMAGES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t0) = g.iter().find(|e| &e.0 == d && e.1 == file_key && e.2 == i && e.3 == u).and_then(|e| e.4.upgrade()) { return t0; }
    g.push((d.clone(), file_key.to_string(), i, u, Arc::downgrade(&t)));
    t
}

/// Test / stats: how many parses, buffer sets and images are resident now.
pub fn resident() -> (usize, usize, usize) {
    let c = CPU.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map_or(0, |m| m.values().filter(|s| matches!(s, CpuState::Done(w) if w.strong_count() > 0)).count());
    let b = BUFS.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|e| e.3.strong_count() > 0).count();
    let i = IMAGES.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|e| e.4.strong_count() > 0).count();
    (c, b, i)
}

#[cfg(test)]
mod tests {
    /// Four outputs asking for one venue at once get ONE parse (the same `Loaded`), and it is freed when nobody holds it.
    #[test]
    fn one_parse_for_every_consumer() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/multi-projector/assets/models/panorama-venue.glb");
        let hs: Vec<_> = (0..4).map(|_| std::thread::spawn(move || super::cpu(p).unwrap())).collect();
        let got: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
        for g in &got[1..] { assert!(std::sync::Arc::ptr_eq(&got[0], g), "a second parse of the same file"); }
        let later = super::cpu(p).unwrap();
        assert!(std::sync::Arc::ptr_eq(&got[0], &later), "a later request re-parsed a file still held");
        let w = std::sync::Arc::downgrade(&later);
        drop(got); drop(later);
        assert!(w.upgrade().is_none(), "the store kept a venue nobody holds");
    }
}
