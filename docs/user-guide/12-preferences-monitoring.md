# 12. Preferences & monitoring

## Preferences

Open from the title‑bar **Preferences** icon, **File ▸ Preferences…**, or **Ctrl/Cmd+,**. It's a single
scrolling panel with collapsible sections.

![The Preferences panel](images/14-preferences.png)
*Preferences: DMX Output, Engine, and OSC / Tracking sections.*

**DMX Output** — the global output defaults:

- **Protocol** — Art‑Net or sACN.
- **Output enabled** — master on/off for network output.
- **Target IP** / **Port** — where packets go (Art‑Net default port 6454).
- **Broadcast / multicast**.
- **Discover devices** — scan the network for Art‑Net nodes.

**Engine** — the output loop:

- **FPS** — output frame rate.
- **Keep‑alive** — keep streaming unchanged universes.
- **Synchronous output (ArtSync)** — synchronized universe release.
- **Gamma** — global output gamma (1.0–3.0).

**OSC / Tracking** — external control + LiDAR:

- **OSC receive** — enable the listener.
- **Listen port** / **Bind addr…** — where to listen (pick a NIC or *All interfaces*).
- **Control prefix** — the OSC address namespace (e.g. `/artlux`).

See [OSC.md](../OSC.md) for the full address map.

**Audio** — the output device and the spatial rig (only when the native audio engine is built):

- **Output device** — a dropdown **grouped by driver type**. On Windows the same interface appears under
  *Windows Audio* (shared — routes through the Windows mixer, usually stereo) **and** *Windows Audio
  (Exclusive Mode)* — pick **Exclusive Mode** for a multichannel rig; it hands ArtLux the card's discrete
  outputs. **Sample rate** and **buffer size** pin the device; the *Open:* line reports what was **actually**
  opened (a stereo card asked for 8 channels reports 2 back). **Reconnect** re-opens the named device after
  a cable bump.
- **Spatial output** — *Binaural* (headphones, HRTF) or *Speaker layout* (a real array: quad, 5.1, 7.1,
  octagon, cube…).
- **Speaker check** *(speaker mode)* — **hold** a speaker to hear pink noise from exactly that output, and
  set which device **channel** each speaker is wired to. This is how you commission a ring whose speakers
  aren't cabled 1:1 — see the walkthrough in [chapter 7 ▸ Commissioning a speaker rig](07-audio.md).
- **Meters** — a live per-channel level meter.

These settings are **per-machine** (they describe this computer's sound card), so they are stored in
Preferences, not in the project — opening a show never re-patches the venue's audio. See
[AUDIO.md ▸ Devices and speakers](../AUDIO.md) for the reference.

---

## DMX Monitor

The **DMX Monitor** dock tab shows the **live, per‑fixture pixel output** — exactly what's going on the
wire.

![The DMX Monitor](images/07-dmx-monitor.png)
*The DMX Monitor: totals (Fixtures / Channels / Universes) and a live color strip per fixture. The **LIVE** badge is lit while output runs.*

Use it to confirm output is flowing, channel counts are what you expect, and color order is right
(the strip should show the colors you intend). In the demo: 2 fixtures, 1264 channels, 3 universes.

---

## OSC Monitor

**View ▸ OSC Monitor…** (**Ctrl/Cmd+Shift+M**) opens a sniffer for the incoming OSC / LiDAR feed.

![The OSC Monitor](images/15-osc-monitor.png)
*The OSC Monitor: rate (msg/s), address count and active blob count, a per‑address table (Hz / Count / Last value), Pause / Clear / Raw log, and an address filter.*

If it reads *"OSC receive is off"*, enable it in **Preferences ▸ OSC / Tracking**. This is the first
place to look when tracking content or external control isn't responding.

---

## Health metrics (Prometheus & Grafana)

ArtLux can publish live health metrics — output FPS, packets/sec, active universes, CPU, memory — for a
dashboard, on this machine or another on the network. It's cheap on the show machine: ArtLux only
exposes a tiny text page at `http://127.0.0.1:9464/metrics`; **Prometheus** scrapes it and **Grafana**
draws the dashboard.

- **Disable / move it:** loopback‑only by default. `ARTLUX_METRICS=0` disables it;
  `ARTLUX_METRICS_HOST=0.0.0.0` lets another machine/Docker read it; `ARTLUX_METRICS_PORT` changes the
  port (default `9464`).
- **Dashboard:** open Grafana (default `http://localhost:3001`, `admin`/`admin`) and pick the **ArtLux**
  dashboard; `artlux_output_up` reads **LIVE** while output runs.

Full setup (Docker one‑liner, native path, ready‑made dashboard) is in [MONITORING.md](../MONITORING.md).

➡ Next: [Tracking (LiDAR · camera · Augmenta)](13-tracking.md)
