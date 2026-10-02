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
