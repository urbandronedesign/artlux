// THE OUTPUT ENGINE'S CORE — the send thread, the frame codec's decode side, the Art-Net / sACN / ArtSync
// packet builders and the USB serial writers. No Node in here: the napi addon (lib.rs, feature "napi",
// on by default — the shipped output-engine.node) and the native render engine (engine/artlux-engine,
// plans/native-engine.md E1c) are two front doors onto THIS code, so the wire is built by one
// implementation whichever process sends it.
//
// Moved VERBATIM from lib.rs; only the handle (`OutputEngine`) is new — it is what lib.rs's statics were.

use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::serial;

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

#[derive(Default, Clone, Copy)]
pub struct StatsData {
    pub pps: u32,        // packets per second
    pub fps: u32,        // frames sent per second (incl. keep-alive)
    pub universes: u32,  // universes in the last frame
    // USB DMX writer health. `universes` counts a serial destination whether or not the widget is
    // actually there, so on its own it cannot tell a lit rig from one whose interface was unplugged
    // — the network half keeps reporting perfectly and nothing looks wrong. These two can.
    pub serial_ok: u32,   // ports with a live writer
    pub serial_down: u32, // ports whose writer has died and is waiting on a retry
}

struct Shared {
    slot: Mutex<Slot>,
    cv: Condvar,
    stats: Mutex<StatsData>,
    fps: AtomicU32,
    keep_alive: AtomicBool,
    sync: AtomicBool,
}

/// One running output engine: its send thread, and the slot frames are handed through.
pub struct OutputEngine {
    shared: Arc<Shared>,
}

impl OutputEngine {
    /// Start the send thread. `broadcast` is the socket's initial SO_BROADCAST (each target sets its own).
    pub fn start(broadcast: bool) -> OutputEngine {
        let shared = Arc::new(Shared {
            slot: Mutex::new(Slot { bytes: Vec::new(), version: 0, stop: false }),
            cv: Condvar::new(),
            stats: Mutex::new(StatsData::default()),
            fps: AtomicU32::new(44),
            keep_alive: AtomicBool::new(true),
            sync: AtomicBool::new(false),
        });
        let worker = shared.clone();
        thread::spawn(move || sender_loop(worker, broadcast));
        OutputEngine { shared }
    }

    /// Pacing rate (keep-alive resend interval), keep-alive on/off, ArtSync after each frame.
    pub fn configure(&self, fps: f64, keep_alive: bool, sync: bool) {
        self.shared.fps.store((fps.max(1.0) as u32).clamp(1, 1000), Ordering::Relaxed);
        self.shared.keep_alive.store(keep_alive, Ordering::Relaxed);
        self.shared.sync.store(sync, Ordering::Relaxed);
    }

    /// Hand the send thread one frame (shared/frameCodec's binary format). It replaces any frame not yet sent.
    pub fn push_frame(&self, frame: &[u8]) {
        let mut s = self.shared.slot.lock().unwrap();
        s.bytes.clear();
        s.bytes.extend_from_slice(frame);
        s.version = s.version.wrapping_add(1);
        self.shared.cv.notify_one();
    }

    pub fn stats(&self) -> StatsData {
        *self.shared.stats.lock().unwrap()
    }

    /// Stop the send thread (and release the USB widgets with it).
    pub fn close(&self) {
        let mut s = self.shared.slot.lock().unwrap();
        s.stop = true;
        self.shared.cv.notify_one();
    }
}

/// USB serial devices that could be a DMX interface: (OS path, human label).
pub fn list_serial_devices() -> Vec<(String, String)> {
    serial::list_dmx_ports()
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
    let mut artnet_seq: HashMap<String, u8> = HashMap::new();
    let mut sacn_seq: HashMap<String, u8> = HashMap::new();
    let mut last_sent: HashMap<String, Vec<u8>> = HashMap::new();
    // Serial (ENTTEC) destinations. Owned by this thread, but every write goes through a per-port
    // writer thread — see serial.rs on why a USB device must never be written to inline.
    let mut serial_ports = serial::SerialPorts::new();
    let mut last_version: u64 = 0;
    let mut last_bytes: Vec<u8> = Vec::new();
    let mut win_start = Instant::now();
    let mut pkt_count: u32 = 0;
    let mut frame_count: u32 = 0;

    loop {
        let fps = shared.fps.load(Ordering::Relaxed).max(1);
        let timeout = Duration::from_millis((1000 / fps as u64).max(1));
        let keep_alive = shared.keep_alive.load(Ordering::Relaxed);
        let sync = shared.sync.load(Ordering::Relaxed);

        // wait for a new frame or the pacing timeout
        let mut to_send: Option<(Vec<u8>, bool)> = None; // (bytes, force)
        {
            let s = shared.slot.lock().unwrap();
            let (s, _res) = shared
                .cv
                .wait_timeout_while(s, timeout, |s| s.version == last_version && !s.stop)
                .unwrap();
            if s.stop {
                // Release the USB widgets with the rest of the engine — a writer thread left alive
                // would hold the COM port open and the next launch could not reopen it.
                serial_ports.close();
                break;
            }
            if s.version != last_version {
                last_version = s.version;
                last_bytes = s.bytes.clone();
                to_send = Some((last_bytes.clone(), false));
            } else if keep_alive && !last_bytes.is_empty() {
                // pacing timeout, no new frame -> re-send last frame (force past sparse)
                to_send = Some((last_bytes.clone(), true));
            }
        }

        if let Some((bytes, force)) = to_send {
            let (pkts, unis) = send_frame_bytes(
                &bytes, force, sync, &socket, &mut cur_broadcast, &mut artnet_seq, &mut sacn_seq, &mut last_sent,
                &mut serial_ports,
            );
            pkt_count += pkts;
            frame_count += 1;
            let (serial_ok, serial_down) = serial_ports.status();
            if let Ok(mut st) = shared.stats.lock() {
                st.universes = unis;
                st.serial_ok = serial_ok;
                st.serial_down = serial_down;
            }
        }

        if win_start.elapsed() >= Duration::from_secs(1) {
            if let Ok(mut st) = shared.stats.lock() {
                st.pps = pkt_count;
                st.fps = frame_count;
            }
            pkt_count = 0;
            frame_count = 0;
            win_start = Instant::now();
        }
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

#[allow(clippy::too_many_arguments)]
fn send_frame_bytes(
    b: &[u8],
    force: bool,
    sync: bool,
    socket: &UdpSocket,
    cur_broadcast: &mut bool,
    artnet_seq: &mut HashMap<String, u8>,
    sacn_seq: &mut HashMap<String, u8>,
    last_sent: &mut HashMap<String, Vec<u8>>,
    serial_ports: &mut serial::SerialPorts,
) -> (u32, u32) {
    let mut packets: u32 = 0;
    let mut universes: u32 = 0;
    // Unique Art-Net destinations this frame, for a trailing ArtSync (ip, port, broadcast).
    let mut artnet_dests: Vec<(String, u16, bool)> = Vec::new();
    if b.len() < 4 {
        return (0, 0);
    }
    let mut i = 0usize;
    let target_count = rd_u32(b, &mut i);
    for _ in 0..target_count {
        if i + 8 > b.len() {
            return (packets, universes);
        }
        let protocol = b[i]; i += 1;
        let broadcast = b[i] != 0; i += 1;
        let sparse = b[i] != 0; i += 1;
        let priority = b[i]; i += 1;
        let port = rd_u16(b, &mut i);
        let ip_len = rd_u16(b, &mut i) as usize;
        if i + ip_len > b.len() { return (packets, universes); }
        let ip = String::from_utf8_lossy(&b[i..i + ip_len]).to_string();
        i += ip_len;
        let uni_count = rd_u16(b, &mut i);
        let is_sacn = protocol == 1;
        // protocol 2 = ENTTEC DMX USB Pro. The COM path travels in the same `ip` field the UDP
        // protocols use for their address — the wire format between JS and here needed no change.
        let is_serial = protocol == 2;

        if !is_serial && !is_sacn && *cur_broadcast != broadcast {
            socket.set_broadcast(broadcast).ok();
            *cur_broadcast = broadcast;
        }
        if !is_serial && !is_sacn && sync && !artnet_dests.iter().any(|(d, p, _)| d == &ip && *p == port) {
            artnet_dests.push((ip.clone(), port, broadcast));
        }

        for _ in 0..uni_count {
            if i + 4 > b.len() { return (packets, universes); }
            let universe = rd_u16(b, &mut i);
            let dlen = rd_u16(b, &mut i) as usize;
            if i + dlen > b.len() { return (packets, universes); }
            let data = &b[i..i + dlen];
            i += dlen;
            universes += 1;

            // A SERIAL widget drives exactly ONE universe, so there is no address to resolve and
            // no sequence number to keep — just the frame, handed to the port's writer thread.
            if is_serial {
                if serial_ports.send(&ip, data) {
                    packets += 1;
                }
                continue;
            }

            let dest = if is_sacn && broadcast {
                format!("239.255.{}.{}", (universe >> 8) & 0xff, universe & 0xff)
            } else {
                ip.clone()
            };
            let dport = if is_sacn { SACN_PORT } else { port };
            let key = format!("{}:{}:{}", dest, dport, universe);

            if sparse && !force {
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
                // Art-Net sequence is per port-address (per universe), like sACN — a single
                // global counter makes each universe's seq jump by N, which monitors read as
                // dropped packets.
                let mut seq = artnet_seq.get(&key).copied().unwrap_or(0).wrapping_add(1);
                if seq == 0 { seq = 1; } // Art-Net: 0 disables sequence tracking
                artnet_seq.insert(key.clone(), seq);
                build_artnet(seq, universe, data)
            };
            let _ = socket.send_to(&pkt, format!("{}:{}", dest, dport));
            packets += 1;
        }
    }

    // After all ArtDmx packets, broadcast/unicast an ArtSync so nodes latch + output
    // simultaneously (tear-free multi-universe). One per unique Art-Net destination.
    if sync && !artnet_dests.is_empty() {
        let pkt = build_artsync();
        for (dest, port, bcast) in &artnet_dests {
            if *cur_broadcast != *bcast {
                socket.set_broadcast(*bcast).ok();
                *cur_broadcast = *bcast;
            }
            let _ = socket.send_to(&pkt, format!("{}:{}", dest, port));
            packets += 1;
        }
    }

    (packets, universes)
}

// ArtSync (OpSync 0x5200): 8-byte ID + opcode + ProtVer + 2 aux bytes.
fn build_artsync() -> [u8; 14] {
    let mut p = [0u8; 14];
    p[..12].copy_from_slice(&ARTNET_HEADER);
    p[9] = 0x52; // OpSync high byte (override OpOutput 0x50)
    p
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
