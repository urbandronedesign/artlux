//! E1b — UNIVERSE PACKING in the engine: the canonical LED buffer + the patch → DMX universes per
//! destination. A PORT of src/renderer/engine/packUniverses.ts, held to it BYTE FOR BYTE by
//! scripts/test-pack-parity.cjs — every rule below is the TypeScript's, including its JavaScript
//! truthiness (`||` treats "" as absent, `??` only null), because the two must agree on every rig until
//! the browser engine is deleted (plan §8 risk 2).
//!
//! A LIGHT fixture's channels are not computed here: the host evaluates its precedence stack and sends
//! the bytes (`light_channels`), the engine only places them — "the host evaluates, the engine draws"
//! (§4, E1–E2). Which fixtures ARE lights is the host's call too (services/fixtureKind.ts owns it).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub protocol: String,
    pub ip: String,
    pub broadcast: bool,
}

// ⚠ THE ROUTING FIELDS ARE `Value`, NOT TYPED. Project files in the wild hold what the app tolerated,
// not what its types say — a generated rig on this PC stores a controller's `protocol` as the NUMBER 0,
// and JavaScript's `||` quietly treats that as absent. The engine must send the same bytes as today for
// any file a venue has, so these fields are taken raw and read with JavaScript's rules (see `Js`).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Controller {
    pub id: String,
    #[serde(default)] pub protocol: Value,
    #[serde(default)] pub ip: Value,
    #[serde(default)] pub broadcast: Value,
    #[serde(default)] pub port: Value,
    #[serde(default)] pub priority: Value,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OutputOverride {
    #[serde(default)] pub protocol: Value,
    #[serde(default)] pub ip: Value,
    #[serde(default)] pub broadcast: Value,
    #[serde(default)] pub port: Value,
    #[serde(default)] pub priority: Value,
    #[serde(default)] pub sparse: Value,
}

/// JavaScript's reading of a JSON value: truthiness, `??`'s "nullish", and template-string text.
trait Js {
    fn truthy(&self) -> bool;
    fn nullish(&self) -> bool;
    fn text(&self) -> String;
}
impl Js for Value {
    fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
            Value::String(s) => !s.is_empty(),
            _ => true,
        }
    }
    fn nullish(&self) -> bool { self.is_null() }
    fn text(&self) -> String {
        match self {
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
}
/// `a || b`: the first truthy, else the LAST operand as it is (JavaScript returns it, falsy or not).
fn or<'a>(a: &'a Value, b: &'a Value) -> &'a Value { if a.truthy() { a } else { b } }
/// `a ?? b`.
fn coalesce<'a>(a: &'a Value, b: &'a Value) -> &'a Value { if a.nullish() { b } else { a } }

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub id: String,
    pub universe: i64,
    pub start_address: i64,
    pub led_count: i64,
    #[serde(default)]
    pub channels_per_pixel: Value,
    /// A string enum; anything else (a stale generator wrote the number 0) reads as RGB here — where the
    /// TypeScript packer THROWS and loses the frame. The parity harness reports such cases, excluded.
    #[serde(default)]
    pub color_order: Value,
    pub controller_id: Option<String>,
    pub output: Option<OutputOverride>,
    /// A light (the host decided): its channels are `light_channels`, written in order.
    #[serde(default)]
    pub light: bool,
    #[serde(default)]
    pub light_channels: Vec<u8>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Destination {
    pub key: String,
    pub ip: Value,
    pub protocol: Value,
    pub broadcast: Value,
    pub sparse: Value,
    pub priority: Value,
    /// Universe → its 512 channels. BTreeMap: ordered, as the parity harness canonicalises both sides.
    pub universes: BTreeMap<i64, Vec<u8>>,
}

/// `Math.round(Math.pow(i / 255, g) * 255)`, with JavaScript's rounding (half up) and its `gamma && gamma > 0`.
pub fn gamma_lut(gamma: f64) -> [u8; 256] {
    let g = if gamma > 0.0 { gamma } else { 1.0 };
    let mut lut = [0u8; 256];
    for (i, v) in lut.iter_mut().enumerate() {
        *v = ((i as f64 / 255.0).powf(g) * 255.0 + 0.5).floor() as u8;
    }
    lut
}

fn color_order(o: Option<&str>) -> [usize; 3] {
    match o.unwrap_or("RGB") {
        "RBG" => [0, 2, 1],
        "GRB" => [1, 0, 2],
        "GBR" => [1, 2, 0],
        "BRG" => [2, 0, 1],
        "BGR" => [2, 1, 0],
        _ => [0, 1, 2],
    }
}

pub fn pack(raw: &[u8], fixtures: &[Fixture], controllers: &[Controller], def: &Defaults, lut: &[u8; 256]) -> Vec<Destination> {
    let ctrls: BTreeMap<&str, &Controller> = controllers.iter().map(|c| (c.id.as_str(), c)).collect();
    // Insertion-ordered destinations (the TS object's key order), each keyed as destKey() spells it.
    let mut order: Vec<String> = Vec::new();
    let mut dests: BTreeMap<String, Destination> = BTreeMap::new();
    let mut offset: i64 = 0;

    for f in fixtures {
        let ctrl = f.controller_id.as_deref().and_then(|id| ctrls.get(id).copied());
        let none = Value::Null;
        let (o_proto, o_ip, o_bc, o_port, o_prio, o_sparse) = match f.output.as_ref() {
            Some(o) => (&o.protocol, &o.ip, &o.broadcast, &o.port, &o.priority, &o.sparse),
            None => (&none, &none, &none, &none, &none, &none),
        };
        let (c_proto, c_ip, c_bc, c_port, c_prio) = match ctrl {
            Some(c) => (&c.protocol, &c.ip, &c.broadcast, &c.port, &c.priority),
            None => (&none, &none, &none, &none, &none),
        };
        // resolveDest — `f.output?.x || ctrl?.x || def.x` for protocol and ip, `??` for broadcast.
        let def_proto = Value::String(def.protocol.clone());
        let def_ip = Value::String(def.ip.clone());
        let def_bc = Value::Bool(def.broadcast);
        let protocol = or(or(o_proto, c_proto), &def_proto).clone();
        let wire_ip = or(or(o_ip, c_ip), &def_ip).clone();
        let broadcast = coalesce(coalesce(o_bc, c_bc), &def_bc).clone();
        let port = or(o_port, c_port).clone();   // `f.output?.port || ctrl?.port` — may stay falsy
        let enttec = protocol.as_str() == Some("enttec");
        // For a USB widget the COM path IS the address: `wire.port ?? ''`.
        let ip = if enttec { if port.nullish() { Value::String(String::new()) } else { port.clone() } } else { wire_ip.clone() };
        let priority = coalesce(o_prio, c_prio).clone();
        let sparse = coalesce(o_sparse, &Value::Bool(false)).clone();
        // destKey
        let key = if enttec {
            format!("enttec|{}", if port.nullish() { String::new() } else { port.text() })
        } else {
            format!("{}|{}|{}", protocol.text(), wire_ip.text(), if broadcast.truthy() { 1 } else { 0 })
        };
        if !dests.contains_key(&key) {
            order.push(key.clone());
            dests.insert(key.clone(), Destination { key: key.clone(), ip, protocol, broadcast, sparse: Value::Bool(false), priority, universes: BTreeMap::new() });
        }
        let dest = dests.get_mut(&key).expect("inserted above");
        // `dest.sparse || sparse` — JavaScript keeps the VALUE, not a bool.
        if !dest.sparse.truthy() { dest.sparse = sparse; }

        let mut universe = f.universe;
        let mut channel = f.start_address - 1;
        // writeCh: spill into the next universe past channel 512; a universe exists only once written.
        let mut write = |val: u8, dest: &mut Destination| {
            if channel >= 512 { universe += 1; channel = 0; }
            let arr = dest.universes.entry(universe).or_insert_with(|| vec![0u8; 512]);
            if (0..512).contains(&channel) { arr[channel as usize] = val; }
            channel += 1;
        };

        if f.light {
            for &v in &f.light_channels { write(v, dest); }
            offset += f.led_count;
            continue;
        }
        let o = color_order(f.color_order.as_str());
        // `(f.channelsPerPixel ?? 4) === 4` — strictly the NUMBER 4 writes the white channel.
        let four = f.channels_per_pixel.nullish() || f.channels_per_pixel.as_f64() == Some(4.0);
        for _ in 0..f.led_count.max(0) {
            let idx = offset * 4;
            if idx + 3 >= raw.len() as i64 { break; }
            let idx = idx as usize;
            let px = [raw[idx], raw[idx + 1], raw[idx + 2]];
            write(lut[px[o[0]] as usize], dest);
            write(lut[px[o[1]] as usize], dest);
            write(lut[px[o[2]] as usize], dest);
            if four { write(lut[raw[idx + 3] as usize], dest); }
            offset += 1;
        }
    }
    order.into_iter().map(|k| dests.remove(&k).expect("ordered key")).collect()
}

// ── The parity harness's entry: a batch of cases in, their destinations (and LUTs) out ──────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub name: String,
    pub defaults: Defaults,
    pub gamma: f64,
    pub controllers: Vec<Controller>,
    pub fixtures: Vec<Fixture>,
    pub raw: Vec<u8>,
}

#[derive(Deserialize)]
pub struct Batch {
    pub cases: Vec<Case>,
    #[serde(default)]
    pub gammas: Vec<f64>,
}

#[derive(Serialize)]
pub struct CaseOut {
    pub name: String,
    pub destinations: Vec<Destination>,
}

#[derive(Serialize)]
pub struct BatchOut {
    pub cases: Vec<CaseOut>,
    pub luts: Vec<Vec<u8>>,
}

pub fn run_batch(b: &Batch) -> BatchOut {
    let cases = b.cases.iter().map(|c| {
        let lut = gamma_lut(c.gamma);
        CaseOut { name: c.name.clone(), destinations: pack(&c.raw, &c.fixtures, &c.controllers, &c.defaults, &lut) }
    }).collect();
    BatchOut { cases, luts: b.gammas.iter().map(|&g| gamma_lut(g).to_vec()).collect() }
}
