//! E1c — THE FRAME THE WIRE IS BUILT FROM: packed destinations → shared/frameCodec's binary frame, which the
//! output engine's send thread (native/output-engine/src/core.rs — the same code the app's addon runs)
//! turns into Art-Net / sACN / ArtSync / USB packets. A port of `encodeFrame` (shared/frameCodec.ts) and
//! of the destinations → targets step in services/mockSocketService.ts, held to them byte for byte by
//! scripts/test-pack-parity.cjs and end to end on the wire by scripts/test-wire-parity.cjs.
//!
//! JavaScript's coercions are ported with it, because loose project values reach here (pack.rs):
//!   - universes in `for…in` order — integer keys ascending, then any other key in insertion order;
//!   - `Math.max(0, Math.min(255, t.priority ?? 100))` stored into a Uint8Array (ToNumber; NaN → 0; truncate);
//!   - `dv.setUint16(u)` wraps a universe modulo 65536; `TextEncoder.encode(t.ip)` stringifies the value.

use crate::pack::Destination;
use serde_json::Value;

fn js_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(x) if x.fract() == 0.0 && x.abs() < 1e21 => format!("{}", x as i64),
            Some(x) => format!("{x}"),
            None => n.to_string(),
        },
        other => other.to_string(),
    }
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
/// JavaScript ToNumber, for the values a priority can hold.
fn to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => { let t = s.trim(); if t.is_empty() { 0.0 } else { t.parse::<f64>().unwrap_or(f64::NAN) } }
        _ => f64::NAN,
    }
}
/// `bytes[o] = Math.max(0, Math.min(255, p ?? 100))` — Math.min/max propagate NaN; a Uint8Array stores NaN as 0.
fn priority_byte(p: &Value) -> u8 {
    let x = if p.is_null() { 100.0 } else { to_number(p) };
    let c = if x.is_nan() { f64::NAN } else { x.min(255.0).max(0.0) };
    if c.is_nan() { 0 } else { c.trunc() as u8 }
}

/// `for (const k in universes)`: array-index keys (0 ..= 2^32-2) ascending, then the rest as inserted.
fn js_key_order(d: &Destination) -> Vec<i64> {
    let mut idx: Vec<i64> = d.inserted.iter().copied().filter(|&u| (0..=4_294_967_294).contains(&u)).collect();
    idx.sort_unstable();
    idx.extend(d.inserted.iter().copied().filter(|&u| !(0..=4_294_967_294).contains(&u)));
    idx
}

/// The frame for these destinations, every target on Art-Net port `port` (the app's setting).
pub fn encode_frame(dests: &[Destination], port: u16) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&(dests.len() as u32).to_le_bytes());
    for t in dests {
        b.push(match t.protocol.as_str() { Some("sacn") => 1, Some("enttec") => 2, _ => 0 });
        b.push(if truthy(&t.broadcast) { 1 } else { 0 });
        b.push(if truthy(&t.sparse) { 1 } else { 0 });
        b.push(priority_byte(&t.priority));
        b.extend_from_slice(&port.to_le_bytes());
        let ip = js_text(&t.ip).into_bytes();
        b.extend_from_slice(&(ip.len() as u16).to_le_bytes());
        b.extend_from_slice(&ip);
        let keys = js_key_order(t);
        b.extend_from_slice(&(keys.len() as u16).to_le_bytes());
        for u in keys {
            let arr = &t.universes[&u];
            let len = arr.len().min(512);
            b.extend_from_slice(&(u.rem_euclid(65536) as u16).to_le_bytes());
            b.extend_from_slice(&(len as u16).to_le_bytes());
            b.extend_from_slice(&arr[..len]);
        }
    }
    b
}
