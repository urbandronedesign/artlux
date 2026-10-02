# 3 — Several boards

Two boards need **a switch**: the PC has one Ethernet port. Plug the PC and every board into it. The
PC keeps `192.168.10.168`, and each board gets its own address.

## 1. One sketch, a different number per board

Open **[`artlux_osc_board.ino`](../arduino/artlux_osc_board/artlux_osc_board.ino)** (the full sketch
is printed below). The only line you change between boards is:

```cpp
#define BOARD_NUMBER 1                  // <-- change per board: 1, 2, 3 ...
```

| BOARD_NUMBER | Address | MAC ends in |
|---|---|---|
| 1 | `192.168.10.177` | `…:01` |
| 2 | `192.168.10.178` | `…:02` |

The number changes the **MAC address** too, and that matters. The first sketch, like most examples
online, hard-codes `DE:AD:BE:EF:FE:ED`. Two boards with the same MAC on one switch knock each other
off the network. You get "one board works, two don't, and which one works keeps changing".

This sketch listens on two addresses:

- `/led`: on/off LED on **pin 3**
- `/dim`: a second LED on **pin 5**, brightness `0`–`255`

Flash board 1 with `1` and board 2 with `2`, then `ping 192.168.10.177` and `ping 192.168.10.178`.

### The sketch: `artlux_osc_board.ino`

<!-- generated:sketch-osc-board — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->

```cpp
/*
  ArtLux OSC tracks -> SEVERAL Arduino boards, one sketch.

  Flash the SAME sketch on every board, changing only BOARD_NUMBER. It sets both the board's IP
  address (192.168.10.176 + BOARD_NUMBER) and the last byte of its MAC address: two boards with the
  same MAC on one network knock each other off it, and the symptom ("one board works, two boards
  don't, and which one works keeps changing") is miserable to diagnose.

    BOARD_NUMBER 1 -> 192.168.10.177     BOARD_NUMBER 2 -> 192.168.10.178    ...

  Handles two addresses:
    /led  on/off LED on pin 3   (int 0/1, float > 0.5, or bool)
    /dim  dimmed LED on pin 5   (int 0..255, or float 0..1)  - pin 5 is PWM on an Uno

  Matches examples/osc-arduino/02-two-boards.artlux. Walkthrough: examples/osc-arduino/tuto/.
  Hardware : Arduino Uno/Mega + Ethernet shield (W5100/W5500). Avoid pins 4 and 10-13 (shield).
  Libraries: Ethernet (built in), OSC by Adrian Freed / CNMAT (Library Manager: "OSC").
*/

#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <OSCMessage.h>

#define BOARD_NUMBER 1                  // <-- change per board: 1, 2, 3 ...

byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, (byte)(0x00 + BOARD_NUMBER) };
IPAddress ip(192, 168, 10, 176 + BOARD_NUMBER);
const unsigned int LOCAL_PORT = 8000;   // = the port in the ArtLux track's destination
const int LED_PIN = 3;
const int DIM_PIN = 5;
const bool VERBOSE = true;              // false once it works: Serial printing slows a fast /dim ramp

EthernetUDP Udp;
unsigned long packets = 0;
unsigned long lastReport = 0;

void setup() {
  Serial.begin(9600);
  pinMode(4, OUTPUT);
  digitalWrite(4, HIGH);                // deselect the shield's SD card (shares the SPI bus)
  pinMode(LED_PIN, OUTPUT);
  pinMode(DIM_PIN, OUTPUT);

  Ethernet.begin(mac, ip);
  delay(1000);

  if (Ethernet.hardwareStatus() == EthernetNoHardware) {
    Serial.println("Ethernet shield not found!");
    while (true) delay(1);
  }
  Serial.print("Board ");
  Serial.print(BOARD_NUMBER);
  Serial.print("  IP ");
  Serial.print(Ethernet.localIP());
  Serial.print("  port ");
  Serial.println(LOCAL_PORT);
  if (Ethernet.linkStatus() == LinkOFF) Serial.println("Cable not connected (link off)");

  Udp.begin(LOCAL_PORT);
}

void loop() {
  int size = Udp.parsePacket();
  if (size > 0) {
    packets++;
    OSCMessage msg;
    while (size--) msg.fill(Udp.read());
    if (!msg.hasError()) {
      msg.dispatch("/led", onLed);
      msg.dispatch("/dim", onDim);
    } else {
      Serial.print("OSC error: ");
      Serial.println(msg.getError());
    }
  }

  // Once every 5 s: link state + how many packets arrived. A count that stays at 0 while ArtLux
  // says it is sending means the packets are not reaching this board (address, port, cable, PC IP).
  if (millis() - lastReport > 5000) {
    lastReport = millis();
    Serial.print("link ");
    Serial.print(Ethernet.linkStatus() == LinkON ? "ON" : "OFF");
    Serial.print("  packets ");
    Serial.println(packets);
  }
}

void onLed(OSCMessage &msg) {
  int state = 0;
  if (msg.isInt(0))          state = msg.getInt(0) != 0;
  else if (msg.isFloat(0))   state = msg.getFloat(0) > 0.5;
  else if (msg.isBoolean(0)) state = msg.getBoolean(0);
  digitalWrite(LED_PIN, state);
  if (VERBOSE) { Serial.print("/led "); Serial.println(state); }
}

void onDim(OSCMessage &msg) {
  int level = 0;
  if (msg.isInt(0))        level = msg.getInt(0);
  else if (msg.isFloat(0)) level = (int)(msg.getFloat(0) * 255.0);
  level = constrain(level, 0, 255);
  analogWrite(DIM_PIN, level);
  if (VERBOSE) { Serial.print("/dim "); Serial.println(level); }
}
```

<!-- /generated:sketch-osc-board -->

To handle another address, add a `msg.dispatch("/yours", onYours);` line in `loop()` and write
`onYours` like `onDim`. Then add an OSC track in ArtLux with **Address** `/yours`.

## 2. Open the two-board show

**File ▸ Open…** → `examples/osc-arduino/02-two-boards.artlux`. It has three tracks:

| Track | Address | Type | Destinations |
|---|---|---|---|
| Board 1 · LED | `/led` | bool | `192.168.10.177:8000` |
| Board 2 · LED | `/led` | bool | `192.168.10.178:8000` |
| Both boards · dimmer | `/dim` | int 0–255 | `.177:8000` **and** `.178:8000` |

Press **Space**. The two pin-3 LEDs alternate every two seconds, and both pin-5 LEDs fade up and down
together.

Notice the two ways of addressing several boards:

- **One track per board** (the LED tracks). Each board gets its own curve. Both tracks use the same
  address (`/led`), which is fine: the IP is what tells them apart.
- **One track, several destinations** (the dimmer). Every board gets the same value at the same time.

## 3. Broadcast: every board at once

A destination whose last number is **255** (`192.168.10.255:8000`) goes to **every device on that
range** in one message. Use it for an all-boards blackout or "all on" without listing each board. Only
boards whose sketch listens on that port do anything with it.

## 4. Things that matter once there are many boards

- **Max rate.** A linear fade changes every frame. Each track sends at most **30 messages per second**
  by default, and always delivers the final value. Lower it in the track's settings if an Uno stutters
  during long fades. Also set `VERBOSE = false` in the sketch: printing to Serial is slower than the
  network.
- **Re-send every.** UDP has no delivery receipt. A board that rebooted, or a message that got lost,
  stays wrong until the curve next changes, and on a hold curve that can be minutes. The LED tracks in
  this show re-send their value **every 2 s** for exactly that reason. Leave it at `0` for tracks that
  are always moving.
- **Turning a track off.** The lightning toggle on the lane stops it sending. The board **keeps the
  last value it got**, the way a DMX fixture holds its last frame. For a known end state, put a key at
  the end of the curve.
- **Scenes.** OSC tracks live on a timeline like every other lane: on the **Global** timeline they run
  under every scene, and on a scene's timeline they run with that scene. See
  [docs/SCENE-TIMELINES.md](../../../docs/SCENE-TIMELINES.md).

Next: [4 — When nothing happens](04-when-nothing-happens.md).
