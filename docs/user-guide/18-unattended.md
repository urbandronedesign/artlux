# 18. Running unattended

An installed show is different from a rehearsal. Nobody is sitting at the keyboard, the machine has
to come back on its own after a power cut, and "it worked when I left" has to still be true in three
weeks. This chapter is what to turn on before you walk away.

---

## 1. Broadcast mode — the show without the editor

**Broadcast mode** runs the outputs and Art‑Net with **no editor interface**: it loads a project,
opens every enabled output fullscreen, and streams. Nothing else.

From the editor, **File ▸ Launch in Broadcast Mode** saves the current project and relaunches
straight into the show. To start that way from a shortcut or a scheduled task:

```
ArtLux.exe --broadcast --project="C:\path\to\show.artlux"
```

Omit `--project` and it loads the last‑opened one.

**Controlling it once it is running:** a **system‑tray icon** (its tooltip is the project name;
right‑click for **Quit Broadcast**) and the global **Ctrl+Shift+Q**. That shortcut quits cleanly from
anywhere — including when a frameless fullscreen projector window has focus and there is no menu to
reach.

> There is also a `--headless` mode. Headless is engine‑only: Art‑Net, invisible, **no projectors**.
> Broadcast is headless plus the fullscreen projector outputs and the tray control. If your show has
> projectors, you want broadcast.

---

## 2. The watchdog — recovering without a human

A show goes dark in ways that do not look like a crash: the GPU device is lost, the render loop
stalls, the window stops responding, or output quietly stops leaving the machine. Nothing throws, and
the app looks like it is still running.

The **watchdog** watches for exactly that and relaunches the show.

**It is off by default, and it only arms in broadcast mode** — so it will never surprise you in the
editor. Turn it on in Preferences before you leave.

It works in two tiers, because they fail differently:

| | In‑app | OS supervisor |
|---|---|---|
| Catches | renderer or GPU crash, unresponsive window, frozen render loop, sustained output loss | the whole process gone — hard crash, or reboot |
| Reacts in | seconds | about a minute |

The second tier is a Windows Scheduled Task, and it is the one that matters after a power cut: the
in‑app watchdog cannot recover from its own process being dead.

**Recovery is a full relaunch, not a reload.** That is deliberate — a fresh process avoids the slow
accumulation that days of continuous running would otherwise cause. Expect a brief gap on the
projectors when it happens.

**It gives up rather than thrashing.** If the show crashes repeatedly, a circuit breaker stops the
relaunching instead of looping forever. A machine stuck in a relaunch loop is worse than one that is
plainly down: the second gets noticed.

### What to actually do

1. Enable the watchdog in Preferences.
2. Install the OS‑level task (see [WATCHDOG.md](../WATCHDOG.md) for the script).
3. Set Windows to log in automatically after a power cut, or tier 2 has nothing to start.
4. **Test it**: start the show, kill `ArtLux.exe` from Task Manager, and watch it come back.

That last step is the whole point. An untested watchdog is a belief, not a safety net.

---

## 3. A time‑of‑day schedule

Two independent layers, and it is worth knowing which one you want.

**Inside one project** — fire a cue, recall a scene, start or stop the transport at **HH:MM on chosen
weekdays**. This lives in the project file, so it travels with the show when you copy the folder.

**Across projects — the playlist** — switch the *whole loaded project* at a time of day. Gallery opens
at 10:00 with one show, the evening piece takes over at 18:00. This is a property of the *machine*,
not of any one project.

A playlist switch **relaunches** into the new project, so expect the same one‑ or two‑second projector
gap as a watchdog recovery. In exchange, every switch starts from a clean process — which is what
makes a rotation survive weeks rather than days.

The scheduler re‑reads the playlist on every start, so a crash or a reboot resumes on whichever
project is due *now* rather than replaying from the top.

---

## 4. The tablet remote

You will want to check on the show without carrying a keyboard. ArtLux can serve a small web page to
any phone or tablet on the same network: scenes, cues, transport, and the show's state.

Enable it in Preferences, then scan the QR code to pair a device. Devices are remembered per machine.

Read the [Show / state machine](14-show-state-machine.md) chapter for what the controls do, and
[SHOW-CONTROL.md](../SHOW-CONTROL.md) for the network and pairing details.

---

## 5. Watching from a distance

ArtLux can publish live metrics — frame rate, output state, what the show is doing — for a monitoring
dashboard. It costs nearly nothing when nobody is looking, because ArtLux only gathers the numbers
when something asks for them.

Worth setting up for an installation that runs for months. See
[Preferences & monitoring](12-preferences-monitoring.md).

---

## The pre‑flight before you leave the venue

- [ ] The show runs from **broadcast mode**, launched the way it will actually launch.
- [ ] Every projector output comes up fullscreen on the right display.
- [ ] Art‑Net is on the wire — confirm at a fixture, not just in the UI.
- [ ] The watchdog is enabled **and tested by killing the process**.
- [ ] The machine logs in by itself after a power cut, and starts the show.
- [ ] The schedule or playlist is set, and the machine's clock and time zone are right.
- [ ] The tablet remote pairs from the venue's own network.
- [ ] Somebody on site knows how to quit and restart the show.

That last line is not a joke. Leave a note by the machine with the two shortcuts: **Ctrl+Shift+Q** to
quit, and the desktop shortcut that starts the show again.

---

Deeper reference: [WATCHDOG.md](../WATCHDOG.md) · [SHOW‑CONTROL.md](../SHOW-CONTROL.md) ·
[OUTPUTS.md](../OUTPUTS.md)

⬅ Back to the [User Guide index](README.md)
