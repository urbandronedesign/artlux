//! HAP frame decoding: parse the HAP section structure of a single video sample and produce
//! the raw GPU-block (DXT/BC) bytes, undoing the optional Snappy second-stage compression.
//! Spec: https://github.com/Vidvox/hap/blob/master/documentation/HapVideoDRAFT.md
//!
//! Section header: 3-byte little-endian length + 1-byte type. If the length is 0 it's an
//! extended header: the type byte stays at offset 3 and a 4-byte little-endian length follows.
//! The top-level section type byte packs the texture format (low nibble) and the second-stage
//! compressor (high nibble): None=0xA, Snappy=0xB, Complex/chunked=0xC.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HapFormat {
    Dxt1,          // RGB_DXT1 (BC1)            — Hap
    Dxt5,          // RGBA_DXT5 (BC3)           — Hap Alpha
    ScaledYCoCg,   // scaled YCoCg in DXT5 (BC3) — Hap Q
    Rgtc1,         // A_RGTC1 (BC4)             — Hap (alpha-only)
    Bptc,          // RGBA_BPTC_UNORM (BC7)     — Hap 7
}

const COMPRESSOR_NONE: u8 = 0xA;
const COMPRESSOR_SNAPPY: u8 = 0xB;
const COMPRESSOR_COMPLEX: u8 = 0xC;

const SECTION_DECODE_INSTRUCTIONS: u8 = 0x01;
const SECTION_CHUNK_COMPRESSOR_TABLE: u8 = 0x02;
const SECTION_CHUNK_SIZE_TABLE: u8 = 0x03;
const SECTION_CHUNK_OFFSET_TABLE: u8 = 0x04;

pub struct Decoded {
    pub format: HapFormat,
    pub data: Vec<u8>, // raw BC/DXT block bytes
}

fn texture_format(low_nibble: u8) -> Result<HapFormat, String> {
    match low_nibble {
        0x0B => Ok(HapFormat::Dxt1),
        0x0E => Ok(HapFormat::Dxt5),
        0x0F => Ok(HapFormat::ScaledYCoCg),
        0x01 => Ok(HapFormat::Rgtc1),
        0x0C => Ok(HapFormat::Bptc),
        other => Err(format!("unsupported HAP texture format 0x{other:02X}")),
    }
}

/// Read a section header at `buf[pos]`; return (type_byte, payload_start, payload_len, next_pos).
fn read_header(buf: &[u8], pos: usize) -> Result<(u8, usize, usize, usize), String> {
    if pos + 4 > buf.len() {
        return Err("truncated HAP section header".into());
    }
    let len24 = buf[pos] as usize | (buf[pos + 1] as usize) << 8 | (buf[pos + 2] as usize) << 16;
    let ty = buf[pos + 3];
    if len24 == 0 {
        if pos + 8 > buf.len() {
            return Err("truncated extended HAP header".into());
        }
        let len = u32::from_le_bytes([buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]]) as usize;
        Ok((ty, pos + 8, len, pos + 8 + len))
    } else {
        Ok((ty, pos + 4, len24, pos + 4 + len24))
    }
}

fn snappy_decode(src: &[u8]) -> Result<Vec<u8>, String> {
    let mut dec = snap::raw::Decoder::new();
    dec.decompress_vec(src).map_err(|e| format!("snappy: {e}"))
}

/// Decode one HAP frame (a single texture; multi-image HapM is not yet supported).
pub fn decode_frame(buf: &[u8]) -> Result<Decoded, String> {
    let (ty, data_start, data_len, _next) = read_header(buf, 0)?;
    if data_start + data_len > buf.len() {
        return Err("HAP section overruns frame".into());
    }
    let second_stage = (ty >> 4) & 0x0F;
    let format = texture_format(ty & 0x0F)?;
    let section = &buf[data_start..data_start + data_len];

    let data = match second_stage {
        COMPRESSOR_NONE => section.to_vec(),
        COMPRESSOR_SNAPPY => snappy_decode(section)?,
        COMPRESSOR_COMPLEX => decode_complex(section)?,
        other => return Err(format!("unsupported HAP compressor 0x{other:X}")),
    };
    Ok(Decoded { format, data })
}

/// Chunked ("complex") frame: a Decode Instructions Container describes N chunks (per-chunk
/// second-stage compressor + compressed size, optionally explicit offsets); the chunk data
/// follows. Each chunk is decompressed independently and concatenated in order.
fn decode_complex(section: &[u8]) -> Result<Vec<u8>, String> {
    let (ty, di_start, di_len, after_di) = read_header(section, 0)?;
    if ty != SECTION_DECODE_INSTRUCTIONS {
        return Err(format!("expected decode-instructions container, got 0x{ty:02X}"));
    }
    if di_start + di_len > section.len() {
        return Err("decode-instructions overruns section".into());
    }
    let di = &section[di_start..di_start + di_len];

    let mut compressors: Vec<u8> = Vec::new();
    let mut sizes: Vec<u32> = Vec::new();
    let mut offsets: Vec<u32> = Vec::new();

    let mut p = 0usize;
    while p < di.len() {
        let (sty, s_start, s_len, s_next) = read_header(di, p)?;
        if s_start + s_len > di.len() {
            return Err("chunk table overruns instructions".into());
        }
        let table = &di[s_start..s_start + s_len];
        match sty {
            SECTION_CHUNK_COMPRESSOR_TABLE => compressors = table.to_vec(),
            SECTION_CHUNK_SIZE_TABLE => {
                sizes = table
                    .chunks_exact(4)
                    .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect()
            }
            SECTION_CHUNK_OFFSET_TABLE => {
                offsets = table
                    .chunks_exact(4)
                    .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect()
            }
            _ => {} // ignore unknown tables
        }
        p = s_next;
    }

    let n = compressors.len();
    if n == 0 || sizes.len() != n {
        return Err("invalid HAP chunk tables".into());
    }
    // Chunk data begins right after the decode-instructions container. Offsets (when present)
    // are relative to that point; otherwise chunks are stored sequentially.
    let chunk_region = &section[after_di..];
    let mut out: Vec<u8> = Vec::new();
    let mut seq = 0usize;
    for i in 0..n {
        let start = if offsets.len() == n { offsets[i] as usize } else { seq };
        let end = start + sizes[i] as usize;
        if end > chunk_region.len() {
            return Err("HAP chunk overruns frame".into());
        }
        let raw = &chunk_region[start..end];
        match compressors[i] {
            COMPRESSOR_NONE => out.extend_from_slice(raw),
            COMPRESSOR_SNAPPY => out.extend_from_slice(&snappy_decode(raw)?),
            other => return Err(format!("unsupported chunk compressor 0x{other:X}")),
        }
        seq = end;
    }
    Ok(out)
}
