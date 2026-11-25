//! E6h — THE LAST FRAME, KEPT WHERE MAIN CAN READ IT AFTER THIS PROCESS IS GONE (plans/native-engine.md E6h).
//!
//! When the engine dies, the wire must not go dark until it is restarted. Today the app's own frames take over
//! (the browser engine is the fallback); once that is deleted (E6i) nothing would. So the engine keeps the last
//! frame it put on the wire — the very bytes its sender was given (shared/frameCodec's binary frame, which main's
//! output addon takes as is) — in a file main names (`ARTLUX_ENGINE_HOLD`). On a death main reads it and puts it
//! on the wire through its own sender, whose keep-alive repeats it until a restarted engine owns the wire again.
//!
//! The file survives this process however it ends (a crash, a kill): it is the operating system's, not ours. It is
//! written so a death MID-WRITE never hands main a torn frame — two slots, the frame into the one not in use, THEN
//! the header that points at it, with a checksum main verifies (a header torn by the kill fails the check, and main
//! holds nothing rather than a wrong frame; the app's own path, or a dark wire, then — never garbage on a node).
//! Written only when the bytes change: a still show writes once.

use std::fs::File;

pub const MAGIC: &[u8; 8] = b"ALHOLD01";
/// Header: magic (8), seq (u64), slot (u32), len (u32), fnv1a-32 of the frame (u32), padding — 64 bytes.
pub const HEAD: u64 = 64;
/// One slot's capacity. A frame is ~530 bytes per universe: 4 MB is ~7 900 universes.
pub const CAP: u64 = 4 << 20;

pub fn fnv1a32(b: &[u8]) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for &x in b { h ^= x as u32; h = h.wrapping_mul(0x0100_0193); }
    h
}

pub struct Hold { f: File, last: Vec<u8>, slot: u64, seq: u64 }

impl Hold {
    /// The file main named, if it named one.
    pub fn open() -> Option<Hold> {
        let p = std::env::var("ARTLUX_ENGINE_HOLD").ok().filter(|p| !p.is_empty())?;
        let f = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&p)
            .map_err(|e| eprintln!("artlux-engine: hold file {p}: {e}")).ok()?;
        Some(Hold { f, last: Vec::new(), slot: 1, seq: 0 })
    }

    /// Record a frame that went to the wire. An EMPTY frame (no targets — the engine handing the wire back) is not
    /// a frame to hold: main holds only for an engine that OWNED the wire when it died.
    pub fn record(&mut self, frame: &[u8]) {
        if frame.len() <= 4 || frame[..4] == [0, 0, 0, 0] || frame.len() as u64 > CAP || frame == &self.last[..] { return; }
        let slot = self.slot ^ 1;
        self.seq += 1;
        let mut head = [0u8; HEAD as usize];
        head[..8].copy_from_slice(MAGIC);
        head[8..16].copy_from_slice(&self.seq.to_le_bytes());
        head[16..20].copy_from_slice(&(slot as u32).to_le_bytes());
        head[20..24].copy_from_slice(&(frame.len() as u32).to_le_bytes());
        head[24..28].copy_from_slice(&fnv1a32(frame).to_le_bytes());
        if write_at(&self.f, HEAD + slot * CAP, frame).and_then(|_| write_at(&self.f, 0, &head)).is_err() { return; }
        self.slot = slot;
        self.last.clear();
        self.last.extend_from_slice(frame);
    }
}

#[cfg(windows)]
fn write_at(f: &File, at: u64, b: &[u8]) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0;
    while done < b.len() { done += f.seek_write(&b[done..], at + done as u64)?; }
    Ok(())
}
#[cfg(unix)]
fn write_at(f: &File, at: u64, b: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.write_all_at(b, at)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fnv_is_the_hosts() {
        // engineHost.ts fnv1a32 — the same numbers both sides.
        assert_eq!(fnv1a32(b""), 0x811c9dc5);
        assert_eq!(fnv1a32(b"a"), 0xe40c292c);
    }
    #[test]
    fn records_into_the_other_slot_then_points_at_it() {
        let p = std::env::temp_dir().join(format!("artlux-hold-test-{}.bin", std::process::id()));
        std::env::set_var("ARTLUX_ENGINE_HOLD", &p);
        let mut h = Hold::open().unwrap();
        let a = [1u8, 0, 0, 0, 9, 9, 9];
        h.record(&a);
        h.record(&[0, 0, 0, 0]);          // empty: ignored
        let b = std::fs::read(&p).unwrap();
        assert_eq!(&b[..8], MAGIC);
        let slot = u32::from_le_bytes(b[16..20].try_into().unwrap()) as u64;
        let len = u32::from_le_bytes(b[20..24].try_into().unwrap()) as usize;
        let at = (HEAD + slot * CAP) as usize;
        assert_eq!(&b[at..at + len], &a);
        assert_eq!(u32::from_le_bytes(b[24..28].try_into().unwrap()), fnv1a32(&a));
        let _ = std::fs::remove_file(&p);
    }
}
