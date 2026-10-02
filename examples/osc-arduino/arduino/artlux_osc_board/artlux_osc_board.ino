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
