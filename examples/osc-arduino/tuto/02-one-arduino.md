# 2 — One Arduino on a cable

The setup here is the simplest one that works: an Ethernet cable straight from the PC to the Arduino's
shield, with no router. With no router, nothing hands out addresses, so **you give both ends a fixed
address on the same range**:

| | Address | Subnet mask |
|---|---|---|
| The PC's Ethernet port | `192.168.10.168` | `255.255.255.0` |
| The Arduino (set in the sketch) | `192.168.10.177` | — |

"Same range" means the **first three numbers match** (`192.168.10.`) and the last one differs. Skip
this step and nothing works. ArtLux's settings will tell you so (see step 5), but it cannot fix it for
you.

## 1. Wire the LED

LED long leg → **pin 3**, short leg → 220 Ω resistor → **GND**.

Not pin 13: on an Uno, pins **10–13 are used by the Ethernet shield** and pin **4** selects its SD card.
Pins 3, 5, 6 and 9 are free and can all dim (PWM).

## 2. Flash the sketch

1. In the Arduino IDE, **Library Manager**: install **OSC** (by Adrian Freed / CNMAT). Ethernet is
   built in.
2. Open **[`artlux_osc_led.ino`](../arduino/artlux_osc_led/artlux_osc_led.ino)** (clicking the link
   inside ArtLux shows the file in its folder), or copy the sketch below into a new Arduino sketch.
   Upload it.
3. Open the **Serial Monitor** at **9600** baud.

   You see `Arduino IP: 192.168.10.177`. If you see `Ethernet shield not found!`, the shield is not
   seated properly. If you see `Cable not connected (link off)`, plug in the cable and press the
   board's reset button.

### The sketch: `artlux_osc_led.ino`

<!-- generated:sketch-osc-led — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->

```cpp
/*
  ArtLux OSC track -> one LED on an Arduino with an Ethernet shield.

  Receives OSC on UDP port 8000 and switches an LED on /led.
  Accepts an int (0/1), a float (> 0.5 = on) or a bool (True/False), so it works with an ArtLux OSC
  track of any type.

  Hardware : Arduino Uno (or Mega) + Ethernet shield (W5100 / W5500), LED + 220 ohm resistor on pin 3.
  Libraries: Ethernet (built in), OSC by Adrian Freed / CNMAT (Library Manager: "OSC").

  Network  : this board is 192.168.10.177. Give the PC's Ethernet port a FIXED address on the same
             range, e.g. 192.168.10.168 / 255.255.255.0 (Windows: Win+R, ncpa.cpl -> the Ethernet
             adapter -> Properties -> IPv4). Full walkthrough: examples/osc-arduino/tuto/.
*/

#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <OSCMessage.h>

byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xED };  // must be UNIQUE per board on the network
IPAddress ip(192, 168, 10, 177);
unsigned int localPort = 8000;                         // = the port in the ArtLux track's destination
const int LED_PIN = 3;                                 // NOT 13: pins 10-13 are the shield's SPI bus

EthernetUDP Udp;

void setup() {
  Serial.begin(9600);
  pinMode(4, OUTPUT);
  digitalWrite(4, HIGH);        // deselect the shield's SD card (it shares the SPI bus)
  pinMode(LED_PIN, OUTPUT);

  Ethernet.begin(mac, ip);
  delay(1000);

  if (Ethernet.hardwareStatus() == EthernetNoHardware) {
    Serial.println("Ethernet shield not found!");
    while (true) delay(1);
  }
  if (Ethernet.linkStatus() == LinkOFF) {
    Serial.println("Cable not connected (link off)");
  }
  Serial.print("Arduino IP: ");
  Serial.println(Ethernet.localIP());

  Udp.begin(localPort);
}

void loop() {
  int size = Udp.parsePacket();
  if (size > 0) {
    Serial.print("Packet received, size ");
    Serial.println(size);

    OSCMessage msg;
    while (size--) msg.fill(Udp.read());

    if (!msg.hasError()) {
      msg.dispatch("/led", ledCallback);
    } else {
      Serial.print("OSC error: ");
      Serial.println(msg.getError());
    }
  }
}

void ledCallback(OSCMessage &msg) {
  int state = 0;
  if (msg.isInt(0))          state = msg.getInt(0);
  else if (msg.isFloat(0))   state = msg.getFloat(0) > 0.5;
  else if (msg.isBoolean(0)) state = msg.getBoolean(0);

  digitalWrite(LED_PIN, state);
  Serial.print("LED set to: ");
  Serial.println(state);
}
```

<!-- /generated:sketch-osc-led -->

The four lines that must agree with ArtLux are at the top: `ip` (the track's destination address),
`localPort` (the destination port), `"/led"` in `msg.dispatch` (the track's **Address**, exact case),
and `LED_PIN`.

## 3. Give the PC a fixed address

**Windows**

1. Press **Win+R**, type `ncpa.cpl`, press Enter.
2. Right-click the **Ethernet** adapter that the cable is plugged into (not Wi-Fi) → **Properties**.
3. Select **Internet Protocol Version 4 (TCP/IPv4)** → **Properties**.
4. Choose **Use the following IP address**: IP `192.168.10.168`, subnet mask `255.255.255.0`. Leave
   gateway and DNS **empty**. Click **OK** twice.

**macOS**: System Settings → Network → the Ethernet/USB-LAN adapter → **Details… → TCP/IP** → Configure
IPv4 **Manually**, address `192.168.10.168`, subnet mask `255.255.255.0`, router empty.

If your **Wi-Fi** is already on a `192.168.10.x` network, pick another range for the cable, for example
`192.168.50.168` on the PC and `192.168.50.177` in the sketch. Two network cards on the same range
confuse the PC about which card to send through.

## 4. Check the cable with ping

Open a terminal (Windows: **Win+R** → `cmd`) and type:

```
ping 192.168.10.177
```

You get `Reply from 192.168.10.177`. The Ethernet shield answers ping by itself, before your sketch is
involved. **If ping fails, stop here and go to [chapter 4](04-when-nothing-happens.md#2-can-the-pc-reach-the-board).
ArtLux cannot reach a board that ping cannot reach.**

## 5. Point the track at the board

1. Open `01-blink-loopback.artlux` again (or keep your own track from chapter 1).
2. On the **LED** lane, click the **settings** button (the sliders icon).
3. In **Destinations**, change `127.0.0.1` : `10000` to `192.168.10.177` : `8000`.
   - `8000` is `localPort` in the sketch. The two must match.
   - If a yellow line appears saying **No network card here is on 192.168.10.x**, step 3 did not take.
     Check that you set the address on the adapter the cable is actually plugged into.
4. Click **Test ▸ True**, then **Test ▸ False**.

   The LED turns on, then off. The Serial Monitor prints `Packet received` and `LED set to: 1` / `0`.
   The Test buttons work even when the track is switched off, so they are your fastest way to check
   whether the board is listening.

5. Click **Done** and press **Space**.

   The LED blinks with the timeline, and the **sent** count on the lane goes up once a second.

## Keep the loopback

Before Done, you can click **+ Add** and put `127.0.0.1` : `10000` back as a **second** destination.
Every destination gets every message, so the board blinks and the OSC Monitor keeps showing exactly
what was sent. Untick a destination to pause it without deleting it.

Next: [3 — Several boards](03-several-boards.md).
