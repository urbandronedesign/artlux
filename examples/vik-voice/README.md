# Voice control with VIK

**Say "show me the forest" and the show goes there.** [VIK](https://github.com/b2renger/voice-interaction-kit),
the Voice Interaction Kit, listens, understands what was asked (in English, French and other languages), answers
out loud, and sends ArtLux an **OSC** message. Everything runs on this computer: no cloud, no account.

| File | What it is |
|---|---|
| `vik-voice.artlux` | Five scenes (**Attract**, **Ember**, **Tide**, **Grove**, **Blackout**), each a built-in effect, no media. A show machine drawn as a hub: Attract in the middle, one performance per corner, each performance returning to Attract after 10 s. Five **global rules** take the voice into any state from anywhere: `/vik/Attract`, `/vik/Ember`, `/vik/Tide`, `/vik/Grove`, `/vik/Blackout`. |
| [`artlux-scenes.vik.json`](https://github.com/b2renger/voice-interaction-kit/blob/main/examples/artlux/artlux-scenes.vik.json) | The VIK agent, in VIK's repository: a **Scenes** table (one row per scene, with the words people use for it) and one pattern that sends OSC when someone mentions a scene. |

```
  "show me the forest"
        │  the microphone
        ▼
  VIK ── decides: the Scenes table, entry Grove ── says "Here is Grove."
        │  OSC, 127.0.0.1:10000
        ▼
  ArtLux ── /artlux/scene/recall Grove   (chapter 1: the look)
         ── /vik/Grove                    (chapter 2: the show machine)
```

Nothing leaves this computer: VIK sends to `127.0.0.1`, and the project's output is aimed at `127.0.0.1` too.

**The walkthrough is [tuto/](tuto/README.md)**: change scenes by voice, then let the voice drive the show machine.
