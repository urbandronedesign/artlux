// Native Art-Net / sACN (E1.31) output engine for ArtLux (napi-rs).
// A dedicated OS thread owns the UDP socket and paces transmission, woken by a
// condvar when JS calls push_frame() with a binary frame (shared/frameCodec).
// This decouples sending from the JS event loop (no GC/loop jitter) and hands
// off each frame as a single memcpy.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::Buffer;
use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;

const ARTNET_HEADER: [u8; 12] = [65, 114, 116, 45, 78, 101, 116, 0, 0, 80, 0, 14];
const ACN_ID: [u8; 12] = [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0, 0, 0];
const CID: [u8; 16] = [
    0xa1, 0x17, 0x10, 0x5e, 0x4c, 0x55, 0x42, 0x00, 0x9a, 0x2c, 0x10, 0x7f, 0x3b, 0xd0, 0xe1, 0x71,
];
const SOURCE_NAME: &[u8] = b"ArtLux";
const SACN_PORT: u16 = 5568;

struct Slot {
    bytes: Vec<u8>,
    version: u64,
    stop: bool,
}

struct Shared {
    slot: Mutex<Slot>,
    cv: Condvar,
}

static ENGINE: OnceLock<Arc<Shared>> = OnceLock::new();

#[napi]
pub fn configure(broadcast: bool) -> napi::Result<()> {
    ENGINE.get_or_init(|| {
        let shared = Arc::new(Shared {
            slot: Mutex::new(Slot { bytes: Vec::new(), version: 0, stop: false }),
            cv: Condvar::new(),
        });
        let worker = shared.clone();
        thread::spawn(move || sender_loop(worker, broadcast));
        shared
    });
    Ok(())
}

#[napi]
pub fn is_ready() -> bool {
    ENGINE.get().is_some()
}

#[napi]
pub fn push_frame(frame: Buffer) -> napi::Result<()> {
    if let Some(shared) = ENGINE.get() {
        let mut s = shared.slot.lock().unwrap();
        s.bytes.clear();
        s.bytes.extend_from_slice(&frame);
        s.version = s.version.wrapping_add(1);
        shared.cv.notify_one();
    }
    Ok(())
}

#[napi]
pub fn close() -> napi::Result<()> {
    if let Some(shared) = ENGINE.get() {
        let mut s = shared.slot.lock().unwrap();
        s.stop = true;
        shared.cv.notify_one();
    }
    Ok(())
}

fn sender_loop(shared: Arc<Shared>, init_broadcast: bool) {
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return,
    };
    socket.set_multicast_ttl_v4(16).ok();
    let mut cur_broadcast = false;
    if init_broadcast {
        socket.set_broadcast(true).ok();
        cur_broadcast = true;
    }
    let mut artnet_seq: u8 = 0;
    let mut sacn_seq: HashMap<String, u8> = HashMap::new();
    let mut last_sent: HashMap<String, Vec<u8>> = HashMap::new();
    let mut last_version: u64 = 0;

    loop {
        let bytes = {
            let mut s = shared.slot.lock().unwrap();
            while s.version == last_version && !s.stop {
                s = shared.cv.wait(s).unwrap();
            }
            if s.stop {
                break;
            }
            last_version = s.version;
            s.bytes.clone()
        };
        send_frame_bytes(
            &bytes, &socket, &mut cur_broadcast, &mut artnet_seq, &mut sacn_seq, &mut last_sent,
        );
    }
}

#[inline]
fn rd_u16(b: &[u8], i: &mut usize) -> u16 {
    let v = u16::from_le_bytes([b[*i], b[*i + 1]]);
    *i += 2;
    v
}
#[inline]
fn rd_u32(b: &[u8], i: &mut usize) -> u32 {
    let v = u32::from_le_bytes([b[*i], b[*i + 1], b[*i + 2], b[*i + 3]]);
    *i += 4;
    v
}

fn send_frame_bytes(
    b: &[u8],
    socket: &UdpSocket,
    cur_broadcast: &mut bool,
    artnet_seq: &mut u8,
    sacn_seq: &mut HashMap<String, u8>,
    last_sent: &mut HashMap<String, Vec<u8>>,
) {
    if b.len() < 4 {
        return;
    }
    let mut i = 0usize;
    let target_count = rd_u32(b, &mut i);
    for _ in 0..target_count {
        if i + 8 > b.len() {
            return;
        }
        let protocol = b[i]; i += 1;
        let broadcast = b[i] != 0; i += 1;
        let sparse = b[i] != 0; i += 1;
        let priority = b[i]; i += 1;
        let port = rd_u16(b, &mut i);
        let ip_len = rd_u16(b, &mut i) as usize;
        if i + ip_len > b.len() { return; }
        let ip = String::from_utf8_lossy(&b[i..i + ip_len]).to_string();
        i += ip_len;
        let uni_count = rd_u16(b, &mut i);
        let is_sacn = protocol == 1;

        if !is_sacn && *cur_broadcast != broadcast {
            socket.set_broadcast(broadcast).ok();
            *cur_broadcast = broadcast;
        }

        for _ in 0..uni_count {
            if i + 4 > b.len() { return; }
            let universe = rd_u16(b, &mut i);
            let dlen = rd_u16(b, &mut i) as usize;
            if i + dlen > b.len() { return; }
            let data = &b[i..i + dlen];
            i += dlen;

            let dest = if is_sacn && broadcast {
                format!("239.255.{}.{}", (universe >> 8) & 0xff, universe & 0xff)
            } else {
                ip.clone()
            };
            let dport = if is_sacn { SACN_PORT } else { port };
            let key = format!("{}:{}:{}", dest, dport, universe);

            if sparse {
                if let Some(prev) = last_sent.get(&key) {
                    if prev.as_slice() == data {
                        continue;
                    }
                }
            }
            last_sent.insert(key.clone(), data.to_vec());

            let pkt = if is_sacn {
                let seq = sacn_seq.get(&key).copied().unwrap_or(0).wrapping_add(1);
                sacn_seq.insert(key.clone(), seq);
                build_sacn(seq, universe, data, priority)
            } else {
                *artnet_seq = artnet_seq.wrapping_add(1);
                if *artnet_seq == 0 { *artnet_seq = 1; }
                build_artnet(*artnet_seq, universe, data)
            };
            let _ = socket.send_to(&pkt, format!("{}:{}", dest, dport));
        }
    }
}

fn build_artnet(seq: u8, universe: u16, data: &[u8]) -> Vec<u8> {
    let len = data.len().min(512);
    let mut p = vec![0u8; 18 + len];
    p[..12].copy_from_slice(&ARTNET_HEADER);
    p[12] = seq;
    p[14] = (universe & 0xff) as u8;
    p[15] = ((universe >> 8) & 0xff) as u8;
    p[16] = ((len >> 8) & 0xff) as u8;
    p[17] = (len & 0xff) as u8;
    p[18..18 + len].copy_from_slice(&data[..len]);
    p
}

fn build_sacn(seq: u8, universe: u16, data: &[u8], priority: u8) -> Vec<u8> {
    let len = data.len().min(512);
    let total = 126 + len;
    let mut p = vec![0u8; total];
    p[0] = 0x00; p[1] = 0x10;
    p[4..16].copy_from_slice(&ACN_ID);
    let root_len = (0x7000 | (total - 16)) as u16;
    p[16] = (root_len >> 8) as u8; p[17] = (root_len & 0xff) as u8;
    p[18..22].copy_from_slice(&[0, 0, 0, 0x04]);
    p[22..38].copy_from_slice(&CID);
    let frame_len = (0x7000 | (total - 38)) as u16;
    p[38] = (frame_len >> 8) as u8; p[39] = (frame_len & 0xff) as u8;
    p[40..44].copy_from_slice(&[0, 0, 0, 0x02]);
    p[44..44 + SOURCE_NAME.len()].copy_from_slice(SOURCE_NAME);
    p[108] = priority;
    p[111] = seq;
    p[113] = (universe >> 8) as u8; p[114] = (universe & 0xff) as u8;
    let dmp_len = (0x7000 | (total - 115)) as u16;
    p[115] = (dmp_len >> 8) as u8; p[116] = (dmp_len & 0xff) as u8;
    p[117] = 0x02;
    p[118] = 0xa1;
    p[121] = 0x00; p[122] = 0x01;
    let count = (len + 1) as u16;
    p[123] = (count >> 8) as u8; p[124] = (count & 0xff) as u8;
    p[125] = 0x00;
    p[126..126 + len].copy_from_slice(&data[..len]);
    p
}
