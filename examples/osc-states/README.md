# OSC states — moving the show from a device

**Your own OSC addresses, accepted only from the device you name.** A tablet, an Arduino or another
show PC moves the state machine by sending addresses such as `/show/next`. Several devices can send at
the same time, and a binding can be limited to one of them.

| File | What it is |
|---|---|
| `osc-states.artlux` | Three states, **Idle → Show → Finale**, each with its own look (built-in effects, no media). |
| `osc-sender.cjs` | Pretends to be two OSC devices on this computer: **Tablet** (`127.0.0.1:9001`) and **Intruder** (`127.0.0.1:9002`). It needs Node only. |

Nothing leaves this computer. The project has no output controller, and the script sends to `127.0.0.1`.

## What is bound

| Address | From | Where it is set | What happens |
|---|---|---|---|
| `/show/next` | **Tablet** only | `osc` trigger on **Idle → Show** and **Show → Finale** | advances one state, with a 1.5 s fade |
| `/show/home` | any sender | `osc` trigger on a **global rule** into Idle | back to Idle from anywhere, with a 2 s fade |
| `/show/finale` | **Tablet** only | **OSC jump** on the Finale state | straight to Finale from anywhere, with no fade |

## Run it

**1. Turn OSC on and name the Tablet.** Open **Preferences ▸ OSC / Tracking**:
- **OSC receive** on, **Listen port** `10000`, **Bind address** *All* (or `127.0.0.1`);
- under **State trigger senders**, click **add** and fill in: name **`Tablet`**, IP **`127.0.0.1`**,
  port **`9001`**.

The name has to be exactly `Tablet`, because that is what the project's bindings refer to. Until you
add it, the editor shows a warning on those bindings and they don't fire. That's on purpose: a
project opened on a new machine must never start accepting every device on the network.

> **Shortcut:** start the script first (step 3), press a key, and `127.0.0.1:9001` appears under
> **Seen recently**. Click it to add it as a sender, then rename it `Tablet`.

**2. Open the project.** **File ▸ Open…** → `osc-states.artlux`. The state machine is enabled and starts
in **Idle**.

**3. Send.** From the repository folder, run either of these:

```bash
node examples/osc-states/osc-sender.cjs demo   # scripted: every case below, with narration
node examples/osc-states/osc-sender.cjs        # interactive: n / f / h / i / j, q to quit
```

If ArtLux listens on a different port, add `--port 10001`. For another computer, add
`--host 192.168.0.10`. Each "tap" sends `1` and then `0`, the way a TouchOSC button does on press and
release.

## What you should see (the demo)

1. **Intruder** sends `/show/next`. Nothing happens, because the binding names the Tablet.
2. **Tablet** sends `/show/next`. Idle → Show. The release (`0`) does not fire a second time.
3. **Tablet** sends `/show/next`. Show → Finale.
4. **Intruder** sends `/show/home`. The show returns to Idle, because the home rule accepts any sender.
5. **Tablet** sends `/show/finale`. The show cuts straight to Finale, with no fade. That's the OSC jump.
6. **Tablet** sends `/show/next` in Finale. No transition leaves Finale on that address, so the message
   is **dropped**. When the next message brings the show back to Idle, the dropped message doesn't fire.

## Make it yours

- **Click a transition** to see its `osc` trigger. You can change the sender or the address there, or
  press **Learn** and then press the button on your real device to fill both in.
- **Click Finale** and open **OSC jump** to see the jump binding.
- **A real tablet:** add it as a sender with its own IP. Leave the port blank unless the app always
  sends from the same port; most pick a random one. Then point the bindings at that sender.

Reference: [STATE-MACHINE.md › Triggering states from OSC devices](../../docs/STATE-MACHINE.md#triggering-states-from-osc-devices) ·
[OSC.md](../../docs/OSC.md).
