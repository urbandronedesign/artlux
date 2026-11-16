# 01 · Scenes by voice

> Project: [`../vik-voice.artlux`](../vik-voice.artlux) · VIK agent: [`artlux-scenes.vik.json`](https://github.com/b2renger/voice-interaction-kit/blob/main/examples/artlux/artlux-scenes.vik.json)
> You'll learn: ArtLux's **OSC receive**, the address **`/artlux/scene/recall`**, and how VIK turns a sentence into
> that message.

## 1. ArtLux listens

1. **Preferences ▸ OSC / Tracking**: turn **OSC receive** on. **Listen port** `10000`, **Bind address** *All* (or
   `127.0.0.1`).
2. **File ▸ Open…** → `vik-voice.artlux`. The stage shows **Attract**, a slow rainbow.

`/artlux/scene/recall <name>` is one of ArtLux's control addresses ([OSC.md](../../../docs/OSC.md)): it recalls a
scene by its **name** (or its id), exactly as clicking it in **Scenes & Cues** would.

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

> **When** the person mentions an entry of **Scenes** → **Send OSC** address `/artlux/scene/recall`, value `{scene}`
> → **Say** "Here is {scene}."

`{scene}` is filled with the first name of the row found: someone says "la forêt", the row is Grove, and the message
is `/artlux/scene/recall Grove`.

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
sent: `OSC to 127.0.0.1:10000: /artlux/scene/recall Grove.` No microphone? Type the sentence in the field under the
conversation: it is decided the same way.

## 4. What the show machine does

Nothing: a recall changes the **look**, not the **state**. Open **Show Machine**: the machine is still in
**Attract**, and the 10 s returns never start, because the machine never entered Ember or Grove. For a show that
only needs to switch looks, that is all you need, and it works with any project.

For a show whose machine follows the voice (a performance that returns to Attract by itself, entry actions, a
fade per transition), go on to [chapter 2](02-the-show-machine-by-voice.md).

## When nothing happens

- **VIK's trace shows no OSC line.** The pattern did not fire: check which pattern was chosen, and that the agent
  is **ArtLux scenes**.
- **"OSC … not sent: no address in Settings".** Fill **Settings ▸ OSC ▸ Send to** in VIK.
- **The OSC line is there, ArtLux does not move.** Is **OSC receive** on, on the same port? Does the name match a
  scene of the open project, letter for letter? Under **Preferences ▸ OSC / Tracking ▸ State trigger senders**, the
  devices **Seen recently** are listed: a `127.0.0.1:…` chip means VIK's messages arrive.
