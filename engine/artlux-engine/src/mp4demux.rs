//! Item 2c-2 — a small MP4 demuxer: the video track's samples, as the app's mp4box hands them to WebCodecs.
//!
//! WHY NOT the platform's own demux (Media Foundation's source reader): it names frames by its own clock,
//! and on these files that clock is not the app's — measured on WebCodecs-encoded H.264 (ctts present): the
//! reader labelled frames 0 and 1 both 0 µs and frame 2 33 333 µs, the right pictures under the wrong times;
//! and it handed back the encoder's padding rows blanked, where the app's decoder keeps them (yuv.rs reads
//! them). The app demuxes with mp4box and gives every sample its composition time; the engine does the
//! same, and feeds the decoder itself (mf.rs).
//!
//! A sample's time is the app's EXACTLY: `(cts / timescale) × 1e6`, coerced to an integer as an
//! EncodedVideoChunk's `long long` timestamp is (truncation) — the VideoFrame.timestamp the host sends.
//! No edit list is applied: mp4box's `cts` does not apply one either.
//!
//! Plain Rust on purpose — the macOS / Linux decoders will take the same samples.
//! Fragmented MP4 (moof) is not handled: refused, the app keeps that surface.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Codec { Avc, Hevc }

pub struct Sample { pub offset: u64, pub size: u32, pub cts: i64, pub dur: u32, pub key: bool }

pub struct Track {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub timescale: u32,
    /// The parameter sets (SPS / PPS, + VPS for HEVC) from avcC / hvcC, without start codes.
    pub params: Vec<Vec<u8>>,
    /// Bytes of each NAL's length prefix in a sample (avcC / hvcC lengthSizeMinusOne + 1).
    pub nal_len: usize,
    /// DECODE order, as stored.
    pub samples: Vec<Sample>,
}

impl Track {
    /// The app's timestamp of a sample (µs, truncated like an EncodedVideoChunk's).
    pub fn ts_us(&self, s: &Sample) -> i64 { ((s.cts as f64 / self.timescale as f64) * 1e6) as i64 }
    pub fn dur_us(&self, s: &Sample) -> i64 { ((s.dur as f64 / self.timescale as f64) * 1e6) as i64 }

    /// A sample as Annex B (start codes), with the parameter sets in front of a key frame — what a Media
    /// Foundation H.264 / H.265 decoder takes.
    pub fn annex_b(&self, s: &Sample, data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(data.len() + 64);
        if s.key { for p in &self.params { out.extend_from_slice(&[0, 0, 0, 1]); out.extend_from_slice(p); } }
        let mut i = 0;
        while i + self.nal_len <= data.len() {
            let mut n = 0usize;
            for b in &data[i..i + self.nal_len] { n = n << 8 | *b as usize; }
            i += self.nal_len;
            if i + n > data.len() { return Err("a NAL unit runs past its sample".into()); }
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(&data[i..i + n]);
            i += n;
        }
        Ok(out)
    }
}

fn be(b: &[u8]) -> u64 { b.iter().fold(0u64, |a, &x| a << 8 | x as u64) }

/// The boxes in `b`: (type, body).
fn boxes(b: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 8 <= b.len() {
        let mut size = be(&b[i..i + 4]) as usize;
        let ty: [u8; 4] = b[i + 4..i + 8].try_into().unwrap();
        let mut head = 8;
        if size == 1 { if i + 16 > b.len() { break; } size = be(&b[i + 8..i + 16]) as usize; head = 16; }
        if size == 0 { size = b.len() - i; }
        if size < head || i + size > b.len() { break; }
        out.push((ty, &b[i + head..i + size]));
        i += size;
    }
    out
}
fn child<'a>(b: &'a [u8], ty: &[u8; 4]) -> Option<&'a [u8]> { boxes(b).into_iter().find(|(t, _)| t == ty).map(|(_, c)| c) }

/// The top-level boxes of the file, by seeking (an mdat can be gigabytes): (type, offset of body, body size).
fn top(f: &mut File) -> Result<Vec<([u8; 4], u64, u64)>, String> {
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut out = Vec::new();
    let mut at = 0u64;
    while at + 8 <= len {
        let mut h = [0u8; 16];
        f.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
        f.read_exact(&mut h[..8]).map_err(|e| e.to_string())?;
        let mut size = be(&h[..4]);
        let ty: [u8; 4] = h[4..8].try_into().unwrap();
        let mut head = 8;
        if size == 1 { f.read_exact(&mut h[8..16]).map_err(|e| e.to_string())?; size = be(&h[8..16]); head = 16; }
        if size == 0 { size = len - at; }
        if size < head { break; }
        out.push((ty, at + head, size - head));
        at += size;
    }
    Ok(out)
}

pub fn open(path: &str) -> Result<(Track, File), String> {
    let mut f = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let tops = top(&mut f)?;
    if tops.iter().any(|(t, _, _)| t == b"moof") { return Err("a fragmented MP4 (the engine reads plain MP4 only)".into()); }
    let &(_, off, size) = tops.iter().find(|(t, _, _)| t == b"moov").ok_or("no moov box")?;
    let mut moov = vec![0u8; size as usize];
    f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    f.read_exact(&mut moov).map_err(|e| e.to_string())?;
    for (t, trak) in boxes(&moov) {
        if &t != b"trak" { continue; }
        let Some(mdia) = child(trak, b"mdia") else { continue };
        let Some(hdlr) = child(mdia, b"hdlr") else { continue };
        if hdlr.len() < 12 || &hdlr[8..12] != b"vide" { continue; }
        return parse_track(mdia).map(|t| (t, f));
    }
    Err("no video track".into())
}

fn parse_track(mdia: &[u8]) -> Result<Track, String> {
    let mdhd = child(mdia, b"mdhd").ok_or("no mdhd")?;
    let timescale = if mdhd[0] == 1 { be(&mdhd[20..24]) } else { be(&mdhd[12..16]) } as u32;
    let stbl = child(child(mdia, b"minf").ok_or("no minf")?, b"stbl").ok_or("no stbl")?;
    // stsd: one visual sample entry.
    let stsd = child(stbl, b"stsd").ok_or("no stsd")?;
    let entries = boxes(&stsd[8..]);
    let (ety, entry) = entries.first().ok_or("an empty stsd")?;
    let codec = match ety { b"avc1" | b"avc3" => Codec::Avc, b"hvc1" | b"hev1" => Codec::Hevc,
        other => return Err(format!("a {} video (the engine decodes H.264 / H.265)", String::from_utf8_lossy(other))) };
    if entry.len() < 78 { return Err("a short sample entry".into()); }
    let (width, height) = (be(&entry[24..26]) as u32, be(&entry[26..28]) as u32);
    let inner = &entry[78..];
    let (params, nal_len) = match codec {
        Codec::Avc => {
            let c = child(inner, b"avcC").ok_or("no avcC")?;
            let nal_len = (c[4] & 3) as usize + 1;
            let mut params = Vec::new();
            let mut i = 6;
            for _ in 0..(c[5] & 0x1f) { let n = be(&c[i..i + 2]) as usize; params.push(c[i + 2..i + 2 + n].to_vec()); i += 2 + n; }
            let pps = c[i]; i += 1;
            for _ in 0..pps { let n = be(&c[i..i + 2]) as usize; params.push(c[i + 2..i + 2 + n].to_vec()); i += 2 + n; }
            (params, nal_len)
        }
        Codec::Hevc => {
            let c = child(inner, b"hvcC").ok_or("no hvcC")?;
            let nal_len = (c[21] & 3) as usize + 1;
            let mut params = Vec::new();
            let mut i = 23;
            for _ in 0..c[22] {
                let n_nalus = be(&c[i + 1..i + 3]); i += 3;
                for _ in 0..n_nalus { let n = be(&c[i..i + 2]) as usize; params.push(c[i + 2..i + 2 + n].to_vec()); i += 2 + n; }
            }
            (params, nal_len)
        }
    };
    // Timing: stts (decode deltas) + ctts (composition offsets; version 1 is signed).
    let stts = child(stbl, b"stts").ok_or("no stts")?;
    let mut dts: Vec<(i64, u32)> = Vec::new();
    let mut t = 0i64;
    for e in 0..be(&stts[4..8]) as usize {
        let (n, d) = (be(&stts[8 + e * 8..12 + e * 8]), be(&stts[12 + e * 8..16 + e * 8]) as u32);
        for _ in 0..n { dts.push((t, d)); t += d as i64; }
    }
    let count = dts.len();
    let mut ctts = vec![0i64; count];
    if let Some(c) = child(stbl, b"ctts") {
        let v1 = c[0] == 1;
        let mut k = 0;
        for e in 0..be(&c[4..8]) as usize {
            let n = be(&c[8 + e * 8..12 + e * 8]);
            let raw = be(&c[12 + e * 8..16 + e * 8]) as u32;
            // SIGNED IN BOTH VERSIONS. Version 0 is unsigned on paper, but encoders write negative offsets into it
            // (a B-frame presented before it decodes, no edit list) and mp4box — the app's parser — reads them as
            // the small negatives they are. Read as unsigned they put two frames of every three ~4 × 10⁹ ticks in
            // the future: measured on a 1080p25 H.264 film (E3j), where the engine's frame table held every third
            // frame only.
            let _ = v1;
            let off = raw as i32 as i64;
            for _ in 0..n { if k < count { ctts[k] = off; } k += 1; }
        }
    }
    // Sync samples (absent: every sample is one).
    let mut key = vec![child(stbl, b"stss").is_none(); count];
    if let Some(s) = child(stbl, b"stss") { for e in 0..be(&s[4..8]) as usize { let n = be(&s[8 + e * 4..12 + e * 4]) as usize; if n >= 1 && n <= count { key[n - 1] = true; } } }
    // Sizes.
    let stsz = child(stbl, b"stsz").ok_or("no stsz")?;
    let fixed = be(&stsz[4..8]) as u32;
    let sizes: Vec<u32> = (0..count).map(|k| if fixed != 0 { fixed } else { be(&stsz[12 + k * 4..16 + k * 4]) as u32 }).collect();
    // Offsets: chunks (stco / co64) × samples per chunk (stsc).
    let chunks: Vec<u64> = if let Some(c) = child(stbl, b"stco") { (0..be(&c[4..8]) as usize).map(|k| be(&c[8 + k * 4..12 + k * 4])).collect() }
        else if let Some(c) = child(stbl, b"co64") { (0..be(&c[4..8]) as usize).map(|k| be(&c[8 + k * 8..16 + k * 8])).collect() }
        else { return Err("no chunk offsets".into()) };
    let stsc = child(stbl, b"stsc").ok_or("no stsc")?;
    let runs: Vec<(usize, usize)> = (0..be(&stsc[4..8]) as usize).map(|e| (be(&stsc[8 + e * 12..12 + e * 12]) as usize, be(&stsc[12 + e * 12..16 + e * 12]) as usize)).collect();
    let mut samples = Vec::with_capacity(count);
    let mut k = 0usize;
    for (ci, &base) in chunks.iter().enumerate() {
        let chunk_no = ci + 1;
        let per = runs.iter().rev().find(|(first, _)| *first <= chunk_no).map(|r| r.1).unwrap_or(0);
        let mut at = base;
        for _ in 0..per {
            if k >= count { break; }
            samples.push(Sample { offset: at, size: sizes[k], cts: dts[k].0 + ctts[k], dur: dts[k].1, key: key[k] });
            at += sizes[k] as u64;
            k += 1;
        }
    }
    if samples.len() != count { return Err(format!("the sample table is inconsistent ({} of {count} samples placed)", samples.len())); }
    Ok(Track { codec, width, height, timescale, params, nal_len, samples })
}
