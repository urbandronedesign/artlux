# OSC tracks → Arduino boards

**A timeline lane whose value goes out over the network.** An OSC track sends its curve as an OSC
message (an address such as `/led` plus one `int`, `float` or `bool`) to one or more `IP:port`
destinations whenever the value changes. This set drives Arduino boards with Ethernet shields, but
anything that receives OSC over UDP will do.

| File | What it shows |
|---|---|
| `01-blink-loopback.artlux` | One track blinking `/led` into ArtLux's own OSC Monitor. **No hardware needed.** |
| `02-two-boards.artlux` | One LED track per board (`192.168.10.177`, `.178`) plus one dimmer track sent to both. |
| [`arduino/artlux_osc_led/artlux_osc_led.ino`](arduino/artlux_osc_led/artlux_osc_led.ino) | Sketch: one board, `/led` on pin 3. |
| [`arduino/artlux_osc_board/artlux_osc_board.ino`](arduino/artlux_osc_board/artlux_osc_board.ino) | Sketch for several boards: set `BOARD_NUMBER`; `/led` on pin 3, `/dim` on pin 5. |

`01` sends only to this computer. `02` sends to `192.168.10.x` addresses, which do nothing until boards
with those addresses are connected.

**The walkthrough is [tuto/](tuto/README.md)**: watch it with no hardware, wire and network one board,
scale to several, and debug it when nothing happens.
