//! D2a-0 — GPU TIME PER PASS (plans/engine-d2-many-lights.md). Every engine number before this was CPU time (prof.rs)
//! plus nvidia-smi's machine-wide load, which cannot tell the lighting pass from the beams. With ARTLUX_ENGINE_STATS=1
//! and an adapter that has timestamps INSIDE encoders (the RTX box's DX12 does; WARP does not), a thread marks points
//! between its passes and the GPU's own clock times each stretch: `mark(enc, "gpu.light")` names the work since the
//! previous mark. The stretches land in the thread's prof table beside its CPU stages, so the 5-second stats line
//! reads `gpu.gbuffer … · gpu.light … · gpu.frame …`.
//!
//! Off — or on an adapter without the feature — `GpuTimer::new` returns None and nothing is requested, written or
//! read: absent means NOT MEASURED, never an error. Read-back is a ring of mapped buffers, collected a frame or more
//! later with a non-blocking poll, so measuring never makes the thread wait for the GPU.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The features the device asks for when measuring (lib.rs adds them only with ARTLUX_ENGINE_STATS=1).
pub const FEATURES: wgpu::Features = wgpu::Features::TIMESTAMP_QUERY.union(wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS);
const MARKS: u32 = 32;
const RING: usize = 4;

struct Slot {
    buf: wgpu::Buffer,
    /// 0 free, 1 waiting for its map, 2 mapped (ready to read), 3 the map failed.
    state: Arc<AtomicU8>,
    labels: Vec<&'static str>,
}

pub struct GpuTimer {
    qs: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    ring: Vec<Slot>,
    /// This frame: the slot its marks go to (None = all slots still in flight: this frame is not measured).
    cur: Option<usize>,
    labels: Vec<&'static str>,
    period_ns: f32,
}

impl GpuTimer {
    pub fn new(gpu: &crate::Gpu) -> Option<GpuTimer> {
        if !crate::prof::on() || !gpu.device.features().contains(FEATURES) { return None; }
        let d = &gpu.device;
        let qs = d.create_query_set(&wgpu::QuerySetDescriptor { label: Some("gpu time"), ty: wgpu::QueryType::Timestamp, count: MARKS });
        let size = MARKS as u64 * 8;
        let resolve = d.create_buffer(&wgpu::BufferDescriptor { label: Some("gpu time resolve"), size, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let ring = (0..RING).map(|_| Slot {
            buf: d.create_buffer(&wgpu::BufferDescriptor { label: Some("gpu time read"), size, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
            state: Arc::new(AtomicU8::new(0)),
            labels: Vec::new(),
        }).collect();
        Some(GpuTimer { qs, resolve, ring, cur: None, labels: Vec::new(), period_ns: gpu.queue.get_timestamp_period() })
    }

    /// A new frame: picks a free slot and writes the first mark (the frame's start).
    pub fn begin(&mut self, enc: &mut wgpu::CommandEncoder) {
        self.labels.clear();
        self.cur = self.ring.iter().position(|s| s.state.load(Ordering::Acquire) == 0);
        self.mark(enc, "start");
    }

    /// The work encoded since the previous mark is `label`.
    pub fn mark(&mut self, enc: &mut wgpu::CommandEncoder, label: &'static str) {
        if self.cur.is_none() || self.labels.len() as u32 >= MARKS { return; }
        enc.write_timestamp(&self.qs, self.labels.len() as u32);
        self.labels.push(label);
    }

    /// The frame's marks resolved and copied to its slot (before `submit`).
    pub fn end(&mut self, enc: &mut wgpu::CommandEncoder) {
        let Some(k) = self.cur else { return };
        let n = self.labels.len() as u32;
        if n < 2 { self.cur = None; return; }
        enc.resolve_query_set(&self.qs, 0..n, &self.resolve, 0);
        enc.copy_buffer_to_buffer(&self.resolve, 0, &self.ring[k].buf, 0, n as u64 * 8);
        self.ring[k].labels = std::mem::take(&mut self.labels);
    }

    /// After `submit`: the slot's read-back requested, and every slot whose map has landed read into the prof table.
    pub fn after_submit(&mut self, d: &wgpu::Device) {
        if let Some(k) = self.cur.take() {
            let st = self.ring[k].state.clone();
            st.store(1, Ordering::Release);
            let n = self.ring[k].labels.len() as u64;
            self.ring[k].buf.slice(..n * 8).map_async(wgpu::MapMode::Read, move |r| st.store(if r.is_ok() { 2 } else { 3 }, Ordering::Release));
        }
        let _ = d.poll(wgpu::PollType::Poll);
        for s in &mut self.ring {
            match s.state.load(Ordering::Acquire) {
                2 => {
                    let n = s.labels.len();
                    let ts: Vec<u64> = match s.buf.slice(..n as u64 * 8).get_mapped_range() {
                        Ok(v) => v.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect(),
                        Err(_) => Vec::new(),
                    };
                    s.buf.unmap();
                    let ns = |a: u64, b: u64| Duration::from_nanos((b.saturating_sub(a) as f64 * self.period_ns as f64) as u64);
                    if ts.len() == n && n > 1 {
                        for i in 1..n { crate::prof::add(s.labels[i], ns(ts[i - 1], ts[i])); }
                        crate::prof::add("gpu.frame", ns(ts[0], ts[n - 1]));
                    }
                    s.state.store(0, Ordering::Release);
                }
                3 => s.state.store(0, Ordering::Release),   // the map failed: nothing mapped, nothing read
                _ => {}
            }
        }
    }
}
