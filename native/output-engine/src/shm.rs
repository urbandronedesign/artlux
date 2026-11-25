//! E6i — PICTURES FROM THE APP TO THE ENGINE THROUGH SHARED MEMORY (Windows).
//!
//! A surface the engine cannot draw is drawn by the app and shown by the engine (a `raster` source, nativeLink
//! shipFallbacks) — at video rate for a video or a live overlay. Its pixels used to go renderer → main → a FILE →
//! the engine: 8 MB written and read back per 1080p frame. Now main copies them into a named shared-memory section
//! (CreateFileMapping on the paging file — memory, never the disk) and the engine copies them straight out.
//!
//! One section per picture and size: a 64-byte header, then TWO slots of `cap` bytes. The header holds each slot's
//! sequence number (u64 at 8 and 16). The writer ZEROES the slot's sequence, copies the picture in, then writes the
//! new sequence; the reader checks the sequence the message named BEFORE and AFTER its copy — a slot overwritten
//! while it was being copied fails the second check and the picture is dropped, never shown torn. Two slots, written
//! alternately, so a reader a frame behind is not overwritten under its feet.
//!
//! Both halves are here because both processes link this crate: main through the Node addon (output-engine.node,
//! `shmWrite`), the engine directly (runtime.rs `raster`).

use std::sync::atomic::{AtomicU64, Ordering};

pub const HEAD: usize = 64;

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    pub type Handle = *mut c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileMappingW(file: Handle, attrs: *const c_void, protect: u32, size_hi: u32, size_lo: u32, name: *const u16) -> Handle;
        fn OpenFileMappingW(access: u32, inherit: i32, name: *const u16) -> Handle;
        fn MapViewOfFile(map: Handle, access: u32, off_hi: u32, off_lo: u32, bytes: usize) -> *mut c_void;
        fn UnmapViewOfFile(base: *const c_void) -> i32;
        fn CloseHandle(h: Handle) -> i32;
    }
    const PAGE_READWRITE: u32 = 0x04;
    const FILE_MAP_WRITE: u32 = 0x0002;
    const FILE_MAP_READ: u32 = 0x0004;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

    /// A mapped view of a named section.
    pub struct Map { h: Handle, p: *mut u8, pub len: usize }
    unsafe impl Send for Map {}
    unsafe impl Sync for Map {}
    impl Map {
        pub fn create(name: &str, len: usize) -> Option<Map> {
            let n = wide(name);
            let h = unsafe { CreateFileMappingW(INVALID_HANDLE_VALUE, std::ptr::null(), PAGE_READWRITE, (len as u64 >> 32) as u32, len as u32, n.as_ptr()) };
            if h.is_null() { return None; }
            let p = unsafe { MapViewOfFile(h, FILE_MAP_WRITE | FILE_MAP_READ, 0, 0, len) } as *mut u8;
            if p.is_null() { unsafe { CloseHandle(h) }; return None; }
            Some(Map { h, p, len })
        }
        pub fn open(name: &str, len: usize) -> Option<Map> {
            let n = wide(name);
            let h = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, n.as_ptr()) };
            if h.is_null() { return None; }
            let p = unsafe { MapViewOfFile(h, FILE_MAP_READ, 0, 0, len) } as *mut u8;
            if p.is_null() { unsafe { CloseHandle(h) }; return None; }
            Some(Map { h, p, len })
        }
        pub fn ptr(&self) -> *mut u8 { self.p }
    }
    impl Drop for Map {
        fn drop(&mut self) { unsafe { UnmapViewOfFile(self.p as *const c_void); CloseHandle(self.h); } }
    }
}
#[cfg(windows)]
pub use win::Map;

#[cfg(windows)]
fn seq_at(m: &Map, slot: usize) -> &AtomicU64 { unsafe { &*(m.ptr().add(8 + slot * 8) as *const AtomicU64) } }

/// The section's size for pictures of up to `cap` bytes.
pub fn section_len(cap: usize) -> usize { HEAD + 2 * cap }

/// Main: copy `data` into `slot` of a section of capacity `cap`, published as `seq` (never 0).
#[cfg(windows)]
pub fn write(m: &Map, cap: usize, slot: usize, seq: u64, data: &[u8]) -> bool {
    if slot > 1 || data.len() > cap || m.len < section_len(cap) || seq == 0 { return false; }
    let s = seq_at(m, slot);
    s.store(0, Ordering::Release);
    std::sync::atomic::fence(Ordering::SeqCst);
    unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), m.ptr().add(HEAD + slot * cap), data.len()); }
    std::sync::atomic::fence(Ordering::SeqCst);
    s.store(seq, Ordering::Release);
    true
}

/// The engine: the picture `seq` in `slot`, `len` bytes — or None if it is not (or no longer) there.
#[cfg(windows)]
pub fn read(m: &Map, cap: usize, slot: usize, seq: u64, len: usize) -> Option<Vec<u8>> {
    if slot > 1 || len > cap || m.len < section_len(cap) || seq == 0 { return None; }
    let s = seq_at(m, slot);
    if s.load(Ordering::Acquire) != seq { return None; }
    let mut out = vec![0u8; len];
    unsafe { std::ptr::copy_nonoverlapping(m.ptr().add(HEAD + slot * cap), out.as_mut_ptr(), len); }
    std::sync::atomic::fence(Ordering::SeqCst);
    if s.load(Ordering::Acquire) != seq { return None; }
    Some(out)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn a_picture_crosses_and_an_overwrite_is_seen() {
        let name = format!("Local\\ArtLuxShmTest-{}", std::process::id());
        let cap = 16;
        let w = Map::create(&name, section_len(cap)).unwrap();
        let r = Map::open(&name, section_len(cap)).unwrap();
        assert!(write(&w, cap, 1, 7, &[1, 2, 3, 4]));
        assert_eq!(read(&r, cap, 1, 7, 4), Some(vec![1, 2, 3, 4]));
        assert_eq!(read(&r, cap, 1, 8, 4), None);          // a sequence that is not there
        assert!(write(&w, cap, 1, 9, &[5, 6, 7, 8]));
        assert_eq!(read(&r, cap, 1, 7, 4), None);          // overwritten: the old picture is gone, not torn
        assert_eq!(read(&r, cap, 1, 9, 4), Some(vec![5, 6, 7, 8]));
    }
}
