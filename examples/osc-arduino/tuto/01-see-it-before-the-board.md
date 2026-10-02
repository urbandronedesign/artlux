# 1 — See it before the board

Before you plug anything in, get ArtLux to send and watch the messages come back. ArtLux can send OSC
to itself on `127.0.0.1` ("this computer"), and its **OSC Monitor** shows everything it receives. Once
the messages look right here, a board that later does nothing has a network problem or a board
problem, not a timeline problem. Knowing that halves your search.

## Turn on OSC receive

1. Open **Preferences ▸ OSC / Tracking**.
2. Turn **OSC receive** on. Leave **Listen port** at `10000` and **Bind address** at **All**.

   You see a `[osc] listening on udp/10000` line in the log.

## Watch the blink

1. **File ▸ Open…** and pick `examples/osc-arduino/01-blink-loopback.artlux`.
2. Open the timeline (`Ctrl+T`). There is one lane called **LED (loopback)**, a square wave that steps
   between 0 and 1 every second.
3. Open **View ▸ OSC Monitor…** (`Ctrl+Shift+M`).
4. Press **Space** to play.

   In the monitor, the address `/led` appears at about **1 Hz**, and its last value flips between `1`
   and `0`. On the lane, the readout under the name shows the value and a **sent** count that goes up
   once a second.

5. Pause and drag the playhead back and forth across a step.

   Every time you cross a step, another message arrives. A track sends when its value **changes**,
   whether that comes from playback, a scrub or a seek. It does not send 30 copies of the same value
   per second.

## Make your own track

1. Under the last lane, click **+ OSC**. A new track appears and its **settings** open next to it.
2. Set **Address** to `/hello`. Keep **Type** on `int`, and set **Range** to `0` to `10`. Click **Done**.
3. On the lane, double-click to add a few keys at different heights.
4. Play.

   `/hello` appears in the OSC Monitor, counting through the numbers your curve passes. An `int` track
   rounds the curve, so it only sends when the whole number changes.

**Which type to pick:**

| Type | On the wire | Use it for |
|---|---|---|
| `bool` | `True` / `False` | On/off: a relay, an LED, a solenoid. The curve is **on at 0.5 and above**. |
| `int` | a whole number | A PWM level 0–255, a servo angle, a step number. |
| `float` | a decimal number | Anything that wants a smooth value, for example 0.0–1.0. |

**Hold vs linear.** A new OSC track starts with **hold** keys, so the value jumps from key to key. That
is what an on/off cue is. Click a key and change its ease to **linear** or **bezier** for a fade. Fades
only make sense on `int` and `float` tracks.

## What you have now

A track that sends, and a way to *see* what it sends without any hardware. Keep the OSC Monitor in
mind: in chapter 4 it is step one of every diagnosis.

Next: [2 — One Arduino on a cable](02-one-arduino.md).
