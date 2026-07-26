// ENTTEC DMX USB PRO output — a USB-serial DMX transmitter alongside the UDP protocols.
//
// ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────────────────────────
// A USB WRITE MUST NEVER STALL THE NETWORK PACER. `sender_loop` is a single thread driving every
// Art-Net/sACN destination at `fps`. If a serial write happened inline and a widget were slow,
// unplugged, or its driver blocked, Art-Net would stop mid-show — a whole rig going dark because
// one USB device was pulled.
//
// So each port gets its OWN writer thread and a SINGLE-SLOT mailbox: the pacer drops the latest
// frame in and returns immediately, never waiting. If the writer is behind, the previous frame is
// simply overwritten and lost. That is correct rather than regrettable — DMX is a state protocol,
// not a stream, and a frame from 40 ms ago has no value once a newer one exists. The widget itself
// behaves the same way (ENTTEC's own docs say it drops rather than queues).
//
// ── THE PROTOCOL ─────────────────────────────────────────────────────────────────────────────
//   0x7E | label | len_lo | len_hi | data… | 0xE7
// Note the END delimiter differs from the start: 0xE7, not 0x7E. Label 6 is "Output Only Send DMX
// Packet", whose data is a start-code byte (0x00) followed by the channel bytes.
//
// The widget's own output rate is 1..40 packets/second, so pushing frames faster than that is
// wasted work at best. We pace at 40 Hz regardless of the app's display rate.

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const START: u8 = 0x7E;
const END: u8 = 0xE7;
const LABEL_OUTPUT_ONLY: u8 = 6;
const DMX_START_CODE: u8 = 0x00;

/// The widget tops out at 40 packets/second; anything faster is discarded by the hardware.
const MAX_PPS: u64 = 40;
const MIN_INTERVAL: Duration = Duration::from_millis(1000 / MAX_PPS);

/// Frame one universe into an ENTTEC "Output Only Send DMX Packet".
///
/// Pure, so it can be checked byte-for-byte without a device attached — which matters, because the
/// only other way to find a framing mistake is a rig that does not light.
pub fn build_packet(channels: &[u8]) -> Vec<u8> {
    // The payload is the start code plus the channel data. ENTTEC accepts a short universe and pads
    // it out itself, but never more than 512 channels.
    let n = channels.len().min(512);
    let len = n + 1; // + start code
    let mut out = Vec::with_capacity(len + 5);
    out.push(START);
    out.push(LABEL_OUTPUT_ONLY);
    out.push((len & 0xff) as u8);
    out.push(((len >> 8) & 0xff) as u8);
    out.push(DMX_START_CODE);
    out.extend_from_slice(&channels[..n]);
    out.push(END);
    out
}

struct Mailbox {
    /// The most recent frame, or None once the writer has taken it.
    pending: Mutex<Option<Vec<u8>>>,
    cv: Condvar,
    stop: AtomicBool,
    /// False once the port has failed to open — the destination is disabled, never retried in a
    /// tight loop, and never allowed to take the show down with it.
    alive: AtomicBool,
}

pub struct SerialPorts {
    ports: HashMap<String, Arc<Mailbox>>,
}

impl SerialPorts {
    pub fn new() -> Self {
        Self { ports: HashMap::new() }
    }

    /// Hand one universe to a port. NEVER BLOCKS. Returns false if the port is not usable.
    pub fn send(&mut self, path: &str, channels: &[u8]) -> bool {
        let mailbox = match self.ports.get(path) {
            Some(m) => m.clone(),
            None => {
                let m = Arc::new(Mailbox {
                    pending: Mutex::new(None),
                    cv: Condvar::new(),
                    stop: AtomicBool::new(false),
                    alive: AtomicBool::new(true),
                });
                spawn_writer(path.to_string(), m.clone());
                self.ports.insert(path.to_string(), m.clone());
                m
            }
        };
        if !mailbox.alive.load(Ordering::Relaxed) {
            return false;
        }
        // Latest-frame-wins. The lock is held only long enough to swap a Vec, and the guard is
        // dropped before `mailbox` goes out of scope (hence the explicit binding rather than
        // returning straight out of the `if let`).
        let queued = if let Ok(mut slot) = mailbox.pending.lock() {
            *slot = Some(build_packet(channels));
            true
        } else {
            false
        };
        if queued {
            mailbox.cv.notify_one();
        }
        queued
    }

    pub fn close(&mut self) {
        for m in self.ports.values() {
            m.stop.store(true, Ordering::Relaxed);
            m.cv.notify_all();
        }
        self.ports.clear();
    }
}

fn spawn_writer(path: String, mailbox: Arc<Mailbox>) {
    thread::spawn(move || {
        // The widget is an FTDI virtual COM port. The DMX wire runs at 250 kbaud, but that is the
        // widget's job on the far side — the USB side is a virtual port whose baud the driver
        // largely ignores. 115200 is what other implementations use and what the ENTTEC examples
        // show; the framing above is what actually matters.
        let port = serialport::new(&path, 115_200)
            .timeout(Duration::from_millis(50))
            .open();

        let mut port = match port {
            Ok(p) => p,
            Err(e) => {
                // Loud, once. Graceful degradation is the house rule for every native module here:
                // the destination goes quiet, the rest of the show carries on.
                eprintln!("[output-engine] serial open failed on {path}: {e}");
                mailbox.alive.store(false, Ordering::Relaxed);
                return;
            }
        };
        eprintln!("[output-engine] serial DMX open on {path}");

        let mut last_write = Instant::now() - MIN_INTERVAL;
        loop {
            if mailbox.stop.load(Ordering::Relaxed) {
                break;
            }
            // Take whatever is waiting; sleep if nothing is.
            let frame = {
                let Ok(mut slot) = mailbox.pending.lock() else { break };
                while slot.is_none() {
                    if mailbox.stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok((next, _)) = mailbox.cv.wait_timeout(slot, Duration::from_millis(200)) else { return };
                    slot = next;
                    if slot.is_none() && mailbox.stop.load(Ordering::Relaxed) {
                        return;
                    }
                }
                slot.take()
            };
            let Some(frame) = frame else { continue };

            // Pace to the widget's own ceiling. Sleeping HERE, on the writer thread, is exactly why
            // this is not done inline: the pacer thread must never wait on a USB device.
            let since = last_write.elapsed();
            if since < MIN_INTERVAL {
                thread::sleep(MIN_INTERVAL - since);
            }
            if port.write_all(&frame).is_err() {
                eprintln!("[output-engine] serial write failed on {path} — disabling this port");
                mailbox.alive.store(false, Ordering::Relaxed);
                return;
            }
            let _ = port.flush();
            last_write = Instant::now();
        }
    });
}

/// Serial ports that look like a DMX widget, for the device picker.
///
/// FTDI's vendor id (0x0403) covers the ENTTEC Pro and most compatible widgets. Ports that are not
/// USB (a motherboard COM header) are excluded — offering them would only invite someone to pick
/// one and wonder why nothing lights.
pub fn list_dmx_ports() -> Vec<(String, String)> {
    let Ok(ports) = serialport::available_ports() else { return Vec::new() };
    let mut out = Vec::new();
    for p in ports {
        if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
            let label = info
                .product
                .clone()
                .or_else(|| info.manufacturer.clone())
                .unwrap_or_else(|| format!("USB {:04x}:{:04x}", info.vid, info.pid));
            // FTDI-based widgets first, but do not HIDE the others: plenty of compatible interfaces
            // use a different bridge chip, and a hard vid filter would make them un-selectable with
            // no way for the operator to know why.
            let likely = info.vid == 0x0403;
            out.push((p.port_name.clone(), if likely { format!("{label} (DMX)") } else { label }));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The framing is the one part of this file that can be wrong in a way no log reveals: a bad
    // length or a wrong end byte makes the widget silently ignore the packet, and the rig simply
    // does not light. Checked byte-for-byte against the ENTTEC spec rather than against a device.
    #[test]
    fn frames_a_full_universe() {
        let pkt = build_packet(&[0u8; 512]);
        assert_eq!(pkt[0], 0x7E, "start delimiter");
        assert_eq!(pkt[1], 6, "label 6 = Output Only Send DMX Packet");
        // Length counts the start code plus the channels: 513 = 0x0201, little-endian.
        assert_eq!(pkt[2], 0x01, "length LSB");
        assert_eq!(pkt[3], 0x02, "length MSB");
        assert_eq!(pkt[4], 0x00, "DMX start code");
        assert_eq!(*pkt.last().unwrap(), 0xE7, "END delimiter is 0xE7, NOT 0x7E");
        assert_eq!(pkt.len(), 5 + 512 + 1);
    }

    #[test]
    fn carries_the_channel_data_in_order() {
        let pkt = build_packet(&[10, 20, 30]);
        assert_eq!(&pkt[..5], &[0x7E, 6, 4, 0, 0x00]);
        assert_eq!(&pkt[5..8], &[10, 20, 30]);
        assert_eq!(pkt[8], 0xE7);
    }

    #[test]
    fn clamps_past_512_rather_than_overflowing_the_length() {
        let pkt = build_packet(&[7u8; 600]);
        assert_eq!(pkt[2], 0x01);
        assert_eq!(pkt[3], 0x02);
        assert_eq!(pkt.len(), 5 + 512 + 1);
    }

    #[test]
    fn a_short_universe_is_sent_short() {
        // The widget pads to 512 itself; sending 24 channels for a 24-channel rig is legitimate.
        let pkt = build_packet(&[1, 2, 3, 4]);
        assert_eq!(pkt[2], 5);
        assert_eq!(pkt[3], 0);
        assert_eq!(pkt.len(), 10);
    }
}
