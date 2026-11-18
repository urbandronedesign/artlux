# 02 · The show machine by voice

> Project: [`../vik-voice.artlux`](../vik-voice.artlux) · the VIK agent of [chapter 1](01-scenes-by-voice.md)
> You'll learn: **global rules** with an **`osc` trigger**, how to **edit the OSC message** in VIK, and the scene
> recall, which changes the look only.

In chapter 1 the voice moved the show machine: the state changed, its scene came with the transition's fade, and
the performance returned to Attract after 10 s, as it does when you drive it by hand. Here is how both sides are
set up, so you can do the same in your own project.

## 1. The ArtLux side: one address per state

Open **Show Machine**. Select nothing, and look at **Global rules** in the inspector:

| Global rule | Into | Fade |
|---|---|---|
| `osc /vik/Attract` | Attract | 1.5 s |
| `osc /vik/Ember` | Ember | 1.5 s |
| `osc /vik/Tide` | Tide | 1.5 s |
| `osc /vik/Grove` | Grove | 1.5 s |
| `osc /vik/Blackout` | Blackout | 0.5 s |

A **global rule** is a transition from **every** state: whatever the show is doing, `/vik/Grove` takes it to Grove.
Its trigger is **`osc`**, with an address and **no sender**: any device may send it, VIK included. (To accept only
one device, name it in **Preferences ▸ OSC / Tracking ▸ State trigger senders** and pick it in the trigger. See
[`osc-states/`](../../osc-states/README.md).)

The graph draws the rest: from Attract, one **manual** link to each performance (the buttons on the state lane),
and from each performance an **`afterDelay` 10 s** link back. Each pair is curved: select a link and drag its
orange handles to bend it your way.

## 2. The VIK side: the OSC message

In VIK, open the agent **ArtLux scenes** ▸ **Interactions** ▸ the pattern **A scene**. Its **Send OSC** action has
two fields: the address `/vik/{scene}`, and an empty value. The address is filled from the row found: "la forêt"
gives `/vik/Grove`. Edits are saved as you type (the top bar says **Saved**; **Save** or **Ctrl+S** saves at once).

**To change the look only**, there is another message, which works with any project, show machine or not:

| | the show machine | the look only |
|---|---|---|
| address | `/vik/{scene}` | `/artlux/scene/recall` |
| value | *(empty)* | `{scene}` |

`/artlux/scene/recall <name>` recalls a scene by its name (or its id), exactly as clicking it in **Scenes & Cues**
would. It changes the **look**, not the **state**: a running show machine stays where it was, the graph keeps
marking that state, and the 10 s return never starts, because the machine never entered the performance. In a
project with a show machine, send the state's address.

## 3. Talk

Click **Start** in VIK, and say "the fire please". ArtLux crossfades into **Ember**, and the state lane says
**Ember**. Wait: after 10 s the show returns to **Attract** by itself. Say "show me the sea", then before 10 s "now
the forest": a global rule leaves from any state, so the show goes straight from Tide to Grove.

"Lights out" holds: Blackout has no automatic way back. "Go back to the start" (`/vik/Attract`) releases it.

> **After a scene recall, the look and the state may disagree.** A recall can leave the look on Grove with the
> machine in Attract. `/vik/Attract` then does nothing: a global rule into the state the machine is already in is
> skipped. Ask for any performance, and the machine takes over again.

## 4. Your own messages and triggers

What VIK sends, and when, is all in its **Interactions** view: a pattern's **When** is the trigger, its **Then**
lists what it does, in order. A few ideas for this project:

| When (VIK) | Then: Send OSC | ArtLux does |
|---|---|---|
| the person says "start the show", "let's go" | `/artlux/transport/play` | plays the timeline |
| the person says "stop", "pause" | `/artlux/transport/pause` | pauses it |
| the conversation starts | `/vik/Attract` | back to the attract loop when someone starts talking |
| the person mentions an entry of **Scenes** | `/artlux/cue/fire`, value `{cue}` (a column you add) | fires a cue |

All the control addresses are in [OSC.md](../../../docs/OSC.md). On the ArtLux side, any of your own addresses
can trigger a transition, a global rule or an **OSC jump** (a state's "go there now", which skips the graph and its
fade).

**Several places at once.** VIK's **Settings ▸ OSC ▸ Send to** takes several `address:port`, separated by commas:
ArtLux and an Arduino, or two ArtLux computers. Every message goes to all of them.

**Another language.** VIK's agent speaks the language set in **Persona ▸ Language**. The Scenes table can hold the
words of several languages at once (`Grove | forest | forêt | bosque`): VIK's decision model understands them all.
