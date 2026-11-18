# 01 · Scenes by voice

> Project: [`../vik-voice.artlux`](../vik-voice.artlux) · VIK agent: [`artlux-scenes.vik.json`](https://github.com/b2renger/voice-interaction-kit/blob/main/examples/artlux/artlux-scenes.vik.json)
> You'll learn: ArtLux's **OSC receive**, **one OSC address per state** (`/vik/Grove`), and how VIK turns a
> sentence into that message.

## 1. ArtLux listens

1. **Preferences ▸ OSC / Tracking**: turn **OSC receive** on. **Listen port** `10000`, **Bind address** *All* (or
   `127.0.0.1`).
2. **File ▸ Open…** → `vik-voice.artlux`. The stage shows **Attract**, a slow rainbow.

The project's show machine has one state per scene, and one OSC address per state: `/vik/Attract`, `/vik/Ember`,
`/vik/Tide`, `/vik/Grove`, `/vik/Blackout`. A message on one of them takes the show into that state, which brings
its scene. [Chapter 2](02-the-show-machine-by-voice.md) shows where these addresses are set.

## 2. VIK understands

1. Install VIK, open it, and let it download its models (**Files ▸ Download all models** shows the progress).
2. Save [`artlux-scenes.vik.json`](https://github.com/b2renger/voice-interaction-kit/blob/main/examples/artlux/artlux-scenes.vik.json)
   (**Download raw file** on GitHub). In VIK, **Manage ▸ Import a file…** and pick it. The agent **ArtLux scenes**
   opens.
3. In VIK, **Settings ▸ OSC ▸ Send to** is `127.0.0.1:10000`: ArtLux, on this computer. For ArtLux on another
   computer, write its address instead, like `192.168.1.20:10000`.

Look at what the agent knows. **Knowledge ▸ Scenes** has one row per ArtLux scene:

| scene | looks like |
|---|---|
| `Attract \| start \| beginning \| accueil` | the waiting loop: soft and slow |
| `Ember \| fire \| flames \| embers \| feu` | warm glowing fire |
| `Tide \| sea \| ocean \| waves \| water \| mer` | blue waves of the sea |
| `Grove \| forest \| trees \| woods \| forêt` | green light of a forest |
| `Blackout \| dark \| darkness \| lights out \| noir` | everything off |

The first name of each row is the **scene's name in ArtLux**, letter for letter. The others are the words people
may use. **Interactions** has the pattern that uses it:

> **When** the person mentions an entry of **Scenes** → **Send OSC** address `/vik/{scene}`, no value
> → **Say** "Here is {scene}."

`{scene}` is filled with the first name of the row found: someone says "la forêt", the row is Grove, and the message
is `/vik/Grove`.

## 3. Talk

In VIK, click **Start**, and say:

| You say | ArtLux shows |
|---|---|
| "show me the forest", "the trees", "la forêt" | Grove |
| "the fire please", "flames", "le feu" | Ember |
| "I want to see the sea", "waves", "la mer" | Tide |
| "lights out", "darkness", "noir" | Blackout |
| "go back to the start" | Attract |

The scene changes **while VIK answers**: the message leaves at the moment VIK decides, before it speaks. VIK
understands more than the words in the table: "something warm and glowing" finds Ember, through the **looks like**
column.

In VIK's **Talk** view, **Why it answered** shows each decision: the row found, how sure VIK was, and the message
sent: `OSC to 127.0.0.1:10000: /vik/Grove.` No microphone? Type the sentence in the field under the
conversation: it is decided the same way.

## 4. What the show machine does

It follows the voice. Open **Show Machine** and say "show me the forest": the graph marks **Grove**, the state
lane says Grove, and 10 s later the show returns to **Attract** by itself. "Lights out" holds: Blackout has no
automatic way back, and "go back to the start" releases it.

How ArtLux maps each address to a state, how to edit the message in VIK, and how to change only the look in a
project with no show machine: go on to [chapter 2](02-the-show-machine-by-voice.md).

## When nothing happens

- **VIK's trace shows no OSC line.** The pattern did not fire: check which pattern was chosen, and that the agent
  is **ArtLux scenes**.
- **"OSC … not sent: no address in Settings".** Fill **Settings ▸ OSC ▸ Send to** in VIK.
- **The OSC line is there, ArtLux does not move.** Is **OSC receive** on, on the same port? Does the address match a
  global rule of the open project (`/vik/Grove`), letter for letter? Under **Preferences ▸ OSC / Tracking ▸ State trigger senders**, the
  devices **Seen recently** are listed: a `127.0.0.1:…` chip means VIK's messages arrive.
