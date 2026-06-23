//! Minimal QuickTime / ISO-BMFF demuxer — just enough to pull the HAP video track's
//! per-frame byte ranges, dimensions and frame rate. We read only the `moov` metadata box
//! into memory (it's small); the actual frame bytes are read from the file on demand by
//! offset (the `mdat` payload can be many gigabytes).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

#[derive(Clone, Copy)]
pub struct Sample {
    pub offset: u64,
    pub size: u32,
}

pub struct MovVideo {
    pub width: u32,
    pub height: u32,
    pub codec: [u8; 4],
    pub fps: f64,
    pub frames: Vec<Sample>,
}

fn be32(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn be64(b: &[u8], o: usize) -> u64 {
    u64::from_be_bytes([
        b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7],
    ])
}
fn be16(b: &[u8], o: usize) -> u16 {
    u16::from_be_bytes([b[o], b[o + 1]])
}

/// Iterate the immediate child boxes within `buf`, calling `f(box_type, payload)`.
/// `payload` excludes the box header and borrows `buf` (so callers can keep the slice).
/// Stops on malformed sizes.
fn for_each_box<'a>(buf: &'a [u8], mut f: impl FnMut(&[u8; 4], &'a [u8])) {
    let mut p = 0usize;
    while p + 8 <= buf.len() {
        let mut size = be32(buf, p) as usize;
        let mut header = 8usize;
        if size == 1 {
            if p + 16 > buf.len() {
                break;
            }
            size = be64(buf, p + 8) as usize;
            header = 16;
        } else if size == 0 {
            size = buf.len() - p; // to end
        }
        if size < header || p + size > buf.len() {
            break;
        }
        let ty = [buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]];
        f(&ty, &buf[p + header..p + size]);
        p += size;
    }
}

/// Find the first immediate child box of `ty` within `buf` and return its payload.
fn find_box<'a>(buf: &'a [u8], ty: &[u8; 4]) -> Option<&'a [u8]> {
    let mut found: Option<&'a [u8]> = None;
    for_each_box(buf, |t, payload| {
        if found.is_none() && t == ty {
            found = Some(payload);
        }
    });
    found
}

/// Read the top-level `moov` box from the file without loading `mdat`.
fn read_moov(file: &mut File) -> Result<Vec<u8>, String> {
    let mut pos = 0u64;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut hdr = [0u8; 16];
    while pos + 8 <= len {
        file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
        let n = file.read(&mut hdr[..8]).map_err(|e| e.to_string())?;
        if n < 8 {
            break;
        }
        let mut size = be32(&hdr, 0) as u64;
        let mut header = 8u64;
        if size == 1 {
            file.read_exact(&mut hdr[8..16]).map_err(|e| e.to_string())?;
            size = be64(&hdr, 8);
            header = 16;
        } else if size == 0 {
            size = len - pos;
        }
        if size < header {
            return Err("bad box size".into());
        }
        if &hdr[4..8] == b"moov" {
            let payload_len = (size - header) as usize;
            let mut buf = vec![0u8; payload_len];
            file.seek(SeekFrom::Start(pos + header)).map_err(|e| e.to_string())?;
            file.read_exact(&mut buf).map_err(|e| e.to_string())?;
            return Ok(buf);
        }
        pos += size;
    }
    Err("no moov box".into())
}

struct Stbl<'a> {
    stsd: &'a [u8],
    stts: &'a [u8],
    stsc: &'a [u8],
    stsz: &'a [u8],
    stco: Option<&'a [u8]>,
    co64: Option<&'a [u8]>,
}

/// Locate the video track's stbl + media timescale inside the moov payload.
fn find_video_track<'a>(moov: &'a [u8]) -> Option<(Stbl<'a>, u32)> {
    let mut result: Option<(Stbl<'a>, u32)> = None;
    for_each_box(moov, |t, trak| {
        if result.is_some() || t != b"trak" {
            return;
        }
        let Some(mdia) = find_box(trak, b"mdia") else { return };
        let Some(hdlr) = find_box(mdia, b"hdlr") else { return };
        // hdlr: version/flags(4) + predefined(4) + handler_type(4)…
        if hdlr.len() < 12 || &hdlr[8..12] != b"vide" {
            return;
        }
        let Some(mdhd) = find_box(mdia, b"mdhd") else { return };
        // version(1)+flags(3); v0: ct(4)+mt(4)+timescale(4); v1: ct(8)+mt(8)+timescale(4)
        let timescale = if !mdhd.is_empty() && mdhd[0] == 1 {
            if mdhd.len() < 28 { return } else { be32(mdhd, 20) }
        } else {
            if mdhd.len() < 16 { return } else { be32(mdhd, 12) }
        };
        let Some(minf) = find_box(mdia, b"minf") else { return };
        let Some(stbl) = find_box(minf, b"stbl") else { return };
        let (Some(stsd), Some(stts), Some(stsc), Some(stsz)) = (
            find_box(stbl, b"stsd"),
            find_box(stbl, b"stts"),
            find_box(stbl, b"stsc"),
            find_box(stbl, b"stsz"),
        ) else {
            return;
        };
        result = Some((
            Stbl {
                stsd,
                stts,
                stsc,
                stsz,
                stco: find_box(stbl, b"stco"),
                co64: find_box(stbl, b"co64"),
            },
            timescale,
        ));
    });
    result
}

pub fn parse(path: &str) -> Result<MovVideo, String> {
    let mut file = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let moov = read_moov(&mut file)?;
    let (stbl, timescale) = find_video_track(&moov).ok_or("no HAP-capable video track")?;

    // --- sample description: codec fourcc + dimensions (VisualSampleEntry) ---
    // stsd: version/flags(4) + entry_count(4) + first entry box{ size(4) type(4) … }
    if stbl.stsd.len() < 16 {
        return Err("short stsd".into());
    }
    let entry = &stbl.stsd[8..]; // first sample entry box (size+type+payload)
    let codec = [entry[4], entry[5], entry[6], entry[7]];
    // VisualSampleEntry payload begins after the 8-byte box header; width@24, height@26.
    let vse = &entry[8..];
    if vse.len() < 28 {
        return Err("short sample entry".into());
    }
    let width = be16(vse, 24) as u32;
    let height = be16(vse, 26) as u32;

    // --- stsz: sample sizes ---
    if stbl.stsz.len() < 12 {
        return Err("short stsz".into());
    }
    let uniform = be32(stbl.stsz, 4);
    let sample_count = be32(stbl.stsz, 8) as usize;
    let sample_size = |i: usize| -> u32 {
        if uniform != 0 {
            uniform
        } else {
            be32(stbl.stsz, 12 + i * 4)
        }
    };

    // --- chunk offsets ---
    let chunk_offset = |i: usize| -> u64 {
        if let Some(co64) = stbl.co64 {
            be64(co64, 8 + i * 8)
        } else if let Some(stco) = stbl.stco {
            be32(stco, 8 + i * 4) as u64
        } else {
            0
        }
    };
    let chunk_count = if let Some(co64) = stbl.co64 {
        be32(co64, 4) as usize
    } else if let Some(stco) = stbl.stco {
        be32(stco, 4) as usize
    } else {
        0
    };

    // --- stsc: samples per chunk (run-length: first_chunk, samples_per_chunk, sdi) ---
    let stsc_count = be32(stbl.stsc, 4) as usize;
    let stsc_entry = |i: usize| -> (u32, u32) {
        let o = 8 + i * 12;
        (be32(stbl.stsc, o), be32(stbl.stsc, o + 4))
    };

    // Expand to a per-chunk "samples in this chunk" lookup, then compute each sample's
    // absolute offset = chunk_offset + Σ(sizes of earlier samples in the same chunk).
    let mut frames: Vec<Sample> = Vec::with_capacity(sample_count);
    let mut sample_idx = 0usize;
    for chunk in 0..chunk_count {
        // samples_per_chunk for this chunk = the last stsc entry whose first_chunk <= chunk+1
        let mut spc = 0u32;
        for e in 0..stsc_count {
            let (first_chunk, samples) = stsc_entry(e);
            if (first_chunk as usize) <= chunk + 1 {
                spc = samples;
            } else {
                break;
            }
        }
        let mut off = chunk_offset(chunk);
        for _ in 0..spc {
            if sample_idx >= sample_count {
                break;
            }
            let sz = sample_size(sample_idx);
            frames.push(Sample { offset: off, size: sz });
            off += sz as u64;
            sample_idx += 1;
        }
    }
    if frames.is_empty() {
        return Err("no samples".into());
    }

    // --- stts: total duration → fps ---
    let stts_count = be32(stbl.stts, 4) as usize;
    let mut total_dur: u64 = 0;
    let mut total_samples: u64 = 0;
    for e in 0..stts_count {
        let o = 8 + e * 8;
        let count = be32(stbl.stts, o) as u64;
        let delta = be32(stbl.stts, o + 4) as u64;
        total_dur += count * delta;
        total_samples += count;
    }
    let fps = if total_dur > 0 && timescale > 0 {
        total_samples as f64 * timescale as f64 / total_dur as f64
    } else {
        30.0
    };

    Ok(MovVideo { width, height, codec, fps, frames })
}
