# Tutorial — OSC tracks: driving Arduino boards from the timeline

An **OSC track** is a line on the timeline that does not change anything inside ArtLux. Its value is
**sent over the network** as an OSC message, so a device somewhere else can act on it: an Arduino with
an Ethernet shield switching an LED, another computer, a lighting desk. You draw the track like any
automation curve. ArtLux sends a message every time the value changes, while the show plays and while
you scrub.

Every track has three settings of its own:

- **Address**: the OSC address the message carries, for example `/led`. The receiver uses it to decide
  what to do.
- **Destinations**: one or more `IP:port` pairs. **Every destination gets every message**, so one track
  can drive one board or ten.
- **Type**: `int`, `float` or `bool`. This is the kind of number that goes on the wire.

```
  ArtLux timeline                                     your network
  ┌─────────────────────────────┐
  │ Board 1 · LED  ▁▁▇▇▁▁▇▇      │──  /led True  ──▶ 192.168.10.177:8000  Arduino 1
  │ Board 2 · LED  ▇▇▁▁▇▇▁▁      │──  /led False ──▶ 192.168.10.178:8000  Arduino 2
  │ Both · dimmer  ╱‾‾╲__╱‾‾     │──  /dim 128   ──▶ .177:8000 AND .178:8000
  └─────────────────────────────┘
```

## Before you start

- ArtLux, and this folder (**Help ▸ Docs & Tutorials** shows these pages inside the app).
- For chapter 1: **nothing else**. You watch the messages arrive back in ArtLux itself.
- For chapters 2–3: an **Arduino Uno or Mega** with an **Ethernet shield** (W5100 or W5500), an LED
  with a 220 Ω resistor, a USB cable, an Ethernet cable, and the **Arduino IDE** with the **OSC**
  library (by Adrian Freed / CNMAT, from the Library Manager). For two or more boards you also need a
  small Ethernet **switch**.

## The chapters

| | Chapter | You end up with |
|---|---|---|
| 1 | [See it before the board](01-see-it-before-the-board.md) | An OSC track blinking `/led` into ArtLux's own **OSC Monitor**. No hardware needed. |
| 2 | [One Arduino on a cable](02-one-arduino.md) | The PC and the board on the same network, and the LED following the timeline. |
| 3 | [Several boards](03-several-boards.md) | Two boards with their own addresses, one track each, and a dimmer track going to both. |
| 4 | [When nothing happens](04-when-nothing-happens.md) | A checklist that finds the fault one layer at a time, from the timeline to the LED. |

## The files

| File | What it is |
|---|---|
| [`01-blink-loopback.artlux`](../01-blink-loopback.artlux) | One `bool` track, `/led`, sent to `127.0.0.1:10000`, which is ArtLux itself. Blinks once a second. |
| [`02-two-boards.artlux`](../02-two-boards.artlux) | Two LED tracks (`192.168.10.177` and `.178`, port `8000`) and an `int` 0–255 `/dim` track that goes to both. |
| [`artlux_osc_led.ino`](../arduino/artlux_osc_led/artlux_osc_led.ino) | The single-board sketch: `/led` on pin 3, board at `192.168.10.177`. Printed in full in [chapter 2](02-one-arduino.md#2-flash-the-sketch). |
| [`artlux_osc_board.ino`](../arduino/artlux_osc_board/artlux_osc_board.ino) | The several-boards sketch: `/led` on pin 3, `/dim` on pin 5. Change `BOARD_NUMBER` per board. Printed in full in [chapter 3](03-several-boards.md#1-one-sketch-a-different-number-per-board). |

Reference: [docs/OSC.md → Sending OSC from the timeline](../../../docs/OSC.md#sending-osc-from-the-timeline-osc-tracks).
