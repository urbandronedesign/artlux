// Native Art-Net / sACN (E1.31) output engine for ArtLux (napi-rs).
// A dedicated OS thread owns the UDP socket and paces transmission, woken by a
// condvar when JS calls push_frame() with a binary frame (shared/frameCodec).
// This decouples sending from the JS event loop (no GC/loop jitter) and hands
// off each frame as a single memcpy.
//
// The engine itself lives in core.rs. This file is the NODE front door (feature "napi", on by default —
// what ships as output-engine.node); the native render engine links core.rs directly (E1c), so both put
// the same bytes on the wire.

pub mod core;
mod serial;

#[cfg(feature = "napi")]
#[macro_use]
extern crate napi_derive;

#[cfg(feature = "napi")]
mod node {
    use crate::core::OutputEngine;
    use napi::bindgen_prelude::Buffer;
    use std::sync::OnceLock;

    static ENGINE: OnceLock<OutputEngine> = OnceLock::new();

    #[napi(object)]
    pub struct Stats {
        pub pps: u32,
        pub fps: u32,
        pub universes: u32,
        /// USB DMX ports with a live writer thread.
        pub serial_ok: u32,
        /// USB DMX ports whose widget is not currently reachable (waiting on a re-open).
        pub serial_down: u32,
    }

    #[napi]
    pub fn configure(broadcast: bool, fps: f64, keep_alive: bool, sync: bool) -> napi::Result<()> {
        let engine = ENGINE.get_or_init(|| OutputEngine::start(broadcast));
        engine.configure(fps, keep_alive, sync);
        Ok(())
    }

    #[napi]
    pub fn get_stats() -> Stats {
        if let Some(e) = ENGINE.get() {
            let s = e.stats();
            Stats { pps: s.pps, fps: s.fps, universes: s.universes, serial_ok: s.serial_ok, serial_down: s.serial_down }
        } else {
            Stats { pps: 0, fps: 0, universes: 0, serial_ok: 0, serial_down: 0 }
        }
    }

    #[napi]
    pub fn is_ready() -> bool {
        ENGINE.get().is_some()
    }

    #[napi]
    pub fn push_frame(frame: Buffer) -> napi::Result<()> {
        if let Some(e) = ENGINE.get() { e.push_frame(&frame); }
        Ok(())
    }

    /// One selectable DMX interface, for the Outputs device picker.
    #[napi(object)]
    pub struct SerialDevice {
        /// The OS port path — `COM3` on Windows, `/dev/ttyUSB0` elsewhere. This is what a Controller stores.
        pub path: String,
        /// Human label from the USB descriptor, so an operator picks a NAME rather than a number.
        pub label: String,
    }

    /// Enumerate USB serial devices that could be a DMX interface. Safe to call at any time; returns an
    /// empty list rather than failing when there is nothing attached (or no permission to look).
    #[napi]
    pub fn list_serial_devices() -> Vec<SerialDevice> {
        crate::core::list_serial_devices().into_iter().map(|(path, label)| SerialDevice { path, label }).collect()
    }

    #[napi]
    pub fn close() -> napi::Result<()> {
        if let Some(e) = ENGINE.get() { e.close(); }
        Ok(())
    }
}
