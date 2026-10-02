# 4 — When nothing happens

Work through the layers **in order**, from ArtLux to the LED. Each step tells you which side the fault
is on. Do not skip to "the sketch is wrong": that is the least likely cause.

## 1. Is ArtLux sending?

Look at the **sent** count on the lane, next to the value.

- **It is not going up while you play.** ArtLux is not sending.
  - Is the track **on**? (Lightning toggle at the left of the lane.)
  - Is the value actually **changing**? A track sends on change, and a flat curve sends once. Click the
    **send now** button (the paper plane) to send it again.
  - Does the track have a destination that is **ticked**?
- **It is going up.** ArtLux is sending. Go to step 2.

To see the messages themselves, add `127.0.0.1` : `10000` as an extra destination and open **View ▸ OSC
Monitor…** (`Ctrl+Shift+M`) with OSC receive on (see [chapter 1](01-see-it-before-the-board.md)). The
address and value you see there are exactly what the board gets.

## 2. Can the PC reach the board?

Open the track's **settings**. Under each destination, ArtLux shows what happened when it tried to
send there:

| What it says | What it means | Fix |
|---|---|---|
| `N sent — left this machine` | The PC put the message on the network. | Go to step 3. |
| `EHOSTUNREACH` / `ENETUNREACH` | No network card on this PC is on that range. | Give the PC's Ethernet port a fixed address on the board's range ([chapter 2, step 3](02-one-arduino.md#3-give-the-pc-a-fixed-address)). |
| Yellow **No network card here is on …** | Same as above, spotted before sending. | Same. |
| `ENOTFOUND` | You typed a name, not an IP address. | Use the board's IP address. |

Then, in a terminal:

```
ping 192.168.10.177
```

| Ping | Serial Monitor | Most likely |
|---|---|---|
| Fails | `link off` | Cable or shield. Try another cable, reseat the shield, press reset. Two boards: check the switch is powered. |
| Fails | link ON, `Arduino IP: 192.168.10.177` | The PC is not on `192.168.10.x`, the address is on the **Wi-Fi** card instead of the Ethernet card, or another device already has that IP. |
| Fails | `Arduino IP: 0.0.0.0` | The shield did not start. Check the sketch's `Ethernet.begin(mac, ip)` and the shield model. |
| Works | — | The network is fine. Go to step 3. |

**"Left this machine" is not "arrived".** UDP has no receipt. A board that is unplugged still counts as
sent. That is why ping comes next, and why the board's own Serial output is the final word.

## 3. Is the board receiving?

Open the **Serial Monitor** (9600 baud) and click **Test ▸ True** in the track's settings.

- **Nothing printed.** Packets reach the board's address but not your sketch. The **port** in the
  track's destination does not match `localPort` / `LOCAL_PORT` in the sketch (`8000`).
- **`Packet received` but nothing else.** The **address does not match**. `/led` in ArtLux has to equal
  `msg.dispatch("/led", …)` in the sketch **exactly**: it is case-sensitive, so `/LED` is a different
  address, and so is `/led ` with a trailing space.
- **`OSC error: …`** The packet is not OSC, or it is cut short. Make sure nothing else is sending to that
  port, and that the OSC library is the CNMAT one.
- **`LED set to: 1`** but the LED stays dark. It is wiring: LED the wrong way round, the wrong pin, or
  pin 13 / 10–12 (used by the shield).

## 4. Problems that only show up later

| Symptom | Cause | Fix |
|---|---|---|
| One board works; with two, they take turns dropping out | Both boards have the **same MAC** (or the same IP) | Use `artlux_osc_board.ino` with a different `BOARD_NUMBER` on each ([chapter 3](03-several-boards.md)). |
| After a board resets, its LED is wrong until the next cue | UDP is fire-and-forget, so the board missed the message | Set **Re-send every** to 1–2 s on that track, or press **send now**. |
| Fades stutter, or the board stops answering during a long fade | Too many messages for an Uno printing to Serial | Lower **Max rate** (e.g. 15 Hz), set `VERBOSE = false`. |
| Everything worked yesterday | Windows reset the adapter to automatic addressing, or a different USB-Ethernet dongle is in use | Redo [chapter 2, step 3](02-one-arduino.md#3-give-the-pc-a-fixed-address) on the adapter in use today. |
| Works on the bench, not at the venue | The venue network uses another range, or blocks broadcast | Ask for the range, give the boards and the PC addresses in it, and use one destination per board instead of `.255`. |

## Seeing the packets on the wire (optional)

If you need proof of exactly what crosses the cable, **Wireshark** with the capture filter
`udp port 8000` shows every datagram. Right-click one → **Decode As… → OSC** to read the address and
value.
