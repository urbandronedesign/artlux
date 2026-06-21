// Native Art-Net / sACN (E1.31) output engine for ArtLux, exposed via napi-rs.
// Mirrors the TypeScript transports (src/main/transport/{artnet,sacn}.ts) but
// builds + sends packets in Rust, removing the per-packet JS work.

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::Buffer;
use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::{Mutex, OnceLock};

const ARTNET_HEADER: [u8; 12] = [65, 114, 116, 45, 78, 101, 116, 0, 0, 80, 0, 14];
const ACN_ID: [u8; 12] = [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0, 0, 0];
const CID: [u8; 16] = [
    0xa1, 0x17, 0x10, 0x5e, 0x4c, 0x55, 0x42, 0x00, 0x9a, 0x2c, 0x10, 0x7f, 0x3b, 0xd0, 0xe1, 0x71,
];
const SOURCE_NAME: &[u8] = b"ArtLux";
const SACN_PORT: u16 = 5568;

struct Engine {
    sock: UdpSocket,
    broadcast: bool,
    artnet_seq: u8,
    sacn_seq: HashMap<String, u8>,
    last_sent: HashMap<String, Vec<u8>>,
}

static ENGINE: OnceLock<Mutex<Engine>> = OnceLock::new();

#[napi(object)]
pub struct UniverseData {
    pub universe: u32,
    pub data: Buffer,
}

#[napi(object)]
pub struct Target {
    pub ip: String,
    pub port: u32,
    pub protocol: String, // "artnet" | "sacn"
    pub broadcast: bool,   // artnet: UDP broadcast; sacn: multicast
    pub sparse: bool,
    pub priority: Option<u32>,
    pub universes: Vec<UniverseData>,
}

#[napi]
pub fn configure(broadcast: bool) -> napi::Result<()> {
    let engine = ENGINE.get_or_init(|| {
        let sock = UdpSocket::bind("0.0.0.0:0").expect("bind udp");
        sock.set_multicast_ttl_v4(16).ok();
        Mutex::new(Engine {
            sock,
            broadcast: false,
            artnet_seq: 0,
            sacn_seq: HashMap::new(),
            last_sent: HashMap::new(),
        })
    });
    let mut e = engine.lock().unwrap();
    if e.broadcast != broadcast {
        e.sock.set_broadcast(broadcast).ok();
        e.broadcast = broadcast;
    }
    Ok(())
}

#[napi]
pub fn is_ready() -> bool {
    ENGINE.get().is_some()
}

fn changed(e: &Engine, key: &str, data: &[u8]) -> bool {
    match e.last_sent.get(key) {
        Some(prev) => prev.as_slice() != data,
        None => true,
    }
}

fn build_artnet(seq: u8, universe: u16, data: &[u8]) -> Vec<u8> {
    let len = data.len().min(512);
    let mut p = vec![0u8; 18 + len];
    p[..12].copy_from_slice(&ARTNET_HEADER);
    p[12] = seq;
    p[13] = 0;
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
    // Root layer
    p[0] = 0x00; p[1] = 0x10; // preamble size 0x0010
    // post-amble 0x0000 already zero
    p[4..16].copy_from_slice(&ACN_ID);
    let root_len = (0x7000 | (total - 16)) as u16;
    p[16] = (root_len >> 8) as u8; p[17] = (root_len & 0xff) as u8;
    p[18..22].copy_from_slice(&[0, 0, 0, 0x04]); // root vector
    p[22..38].copy_from_slice(&CID);
    // Framing layer
    let frame_len = (0x7000 | (total - 38)) as u16;
    p[38] = (frame_len >> 8) as u8; p[39] = (frame_len & 0xff) as u8;
    p[40..44].copy_from_slice(&[0, 0, 0, 0x02]); // framing vector
    p[44..44 + SOURCE_NAME.len()].copy_from_slice(SOURCE_NAME);
    p[108] = priority;
    // sync addr 109-110 = 0
    p[111] = seq;
    // options 112 = 0
    p[113] = (universe >> 8) as u8; p[114] = (universe & 0xff) as u8;
    // DMP layer
    let dmp_len = (0x7000 | (total - 115)) as u16;
    p[115] = (dmp_len >> 8) as u8; p[116] = (dmp_len & 0xff) as u8;
    p[117] = 0x02; // DMP vector
    p[118] = 0xa1; // address & data type
    // first prop addr 119-120 = 0
    p[121] = 0x00; p[122] = 0x01; // address increment = 1
    let count = (len + 1) as u16;
    p[123] = (count >> 8) as u8; p[124] = (count & 0xff) as u8;
    p[125] = 0x00; // DMX start code
    p[126..126 + len].copy_from_slice(&data[..len]);
    p
}

#[napi]
pub fn send_frame(targets: Vec<Target>) -> napi::Result<()> {
    let engine = match ENGINE.get() {
        Some(e) => e,
        None => return Ok(()),
    };
    let mut e = engine.lock().unwrap();

    for t in &targets {
        let is_sacn = t.protocol == "sacn";
        if !is_sacn && e.broadcast != t.broadcast {
            e.sock.set_broadcast(t.broadcast).ok();
            e.broadcast = t.broadcast;
        }
        let priority = t.priority.unwrap_or(100) as u8;

        for u in &t.universes {
            let universe = u.universe as u16;
            let data: &[u8] = &u.data;
            let len = data.len().min(512);

            let dest = if is_sacn && t.broadcast {
                format!("239.255.{}.{}", (universe >> 8) & 0xff, universe & 0xff)
            } else {
                t.ip.clone()
            };
            let port = if is_sacn { SACN_PORT } else { t.port as u16 };
            let key = format!("{}:{}:{}", dest, port, universe);

            if t.sparse && !changed(&e, &key, &data[..len]) {
                continue;
            }
            e.last_sent.insert(key.clone(), data[..len].to_vec());

            let pkt = if is_sacn {
                let seq = e.sacn_seq.get(&key).copied().unwrap_or(0).wrapping_add(1);
                e.sacn_seq.insert(key.clone(), seq);
                build_sacn(seq, universe, data, priority)
            } else {
                e.artnet_seq = e.artnet_seq.wrapping_add(1);
                if e.artnet_seq == 0 { e.artnet_seq = 1; }
                build_artnet(e.artnet_seq, universe, data)
            };

            let addr = format!("{}:{}", dest, port);
            let _ = e.sock.send_to(&pkt, &addr);
        }
    }
    Ok(())
}

#[napi]
pub fn close() -> napi::Result<()> {
    if let Some(engine) = ENGINE.get() {
        let mut e = engine.lock().unwrap();
        e.sacn_seq.clear();
        e.last_sent.clear();
    }
    Ok(())
}
