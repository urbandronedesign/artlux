# 17. Installing ArtLux

Two situations, and they are genuinely different: the machine you *build shows on*, and the **venue
PC** you leave behind running a show for weeks. This chapter is the short version for both. When
something goes wrong, [INSTALL.md](../INSTALL.md) is the long one.

---

## The easy path: the Launcher

**`ArtLuxLauncher.exe` is the thing to download.** It is a small separate Windows program that
installs ArtLux and everything ArtLux needs, checks that the machine can actually run a show, finds
your projects, and opens them.

It exists because installing used to be a *procedure* rather than a download, and because ArtLux
itself cannot help you before it is installed or when it is broken.

Four tabs:

| Tab | What it is for |
|---|---|
| **Install** | see every ArtLux on this machine, and install or upgrade in one click |
| **Projects** | everything on the machine ArtLux can open, with **Create** for a new one — and which mode they open in |
| **Examples** | the example sets ArtLux ships, copied somewhere you can actually save |
| **Health** | the preflight — can this machine run a show? |

**Which mode a project opens in** is chosen on the Projects tab, above the list, and applies to the
Examples tab too:

- **Normal** — the editor as it ships.
- **Calibration** — the editor *plus* the projector‑alignment workbench, so a machine you are about
  to align comes up ready. This is the same thing as **File ▸ Open Calibration Workbench…** inside
  ArtLux, except that the in‑app route has to save and restart the app to get there, and this one
  does not. See [Projector calibration](10-calibration.md).

The choice is remembered. It needs ArtLux **0.25.1 or newer**; on an older install the launcher says
so rather than opening the ordinary editor and letting you hunt for the missing **Calib** rail entry.
And a mode can only be chosen for an ArtLux that is *starting* — if one is already running, the
project opens in it, in whatever mode that copy was launched in, and the launcher tells you so.

Three things the Install tab does that are worth knowing:

- **It verifies the download before running it.** ArtLux is not code‑signed, so the checksum is the
  only integrity guarantee there is. A mismatch is refused and the file deleted.
- **It will not install over a running ArtLux**, and it re‑reads the registry afterwards rather than
  trusting the installer's exit code.
- **It catches the double install.** Releases before 22 July 2026 installed *per user*; the installer
  is now *per machine*, and Windows treats those as different products — so it will never replace one
  with the other. You get two installs, two Start Menu entries, and whichever version matches the
  shortcut you happened to click. The launcher spots this and offers to remove the old one.

---

## The warning you will see first

**ArtLux and the Launcher are not code‑signed**, by decision. Windows therefore greets a freshly
downloaded installer with:

> **Windows protected your PC** — Microsoft Defender SmartScreen prevented an unrecognised app from
> starting.

…and the only obvious button is **Don't run**.

**This is expected.** Click **More info**, then **Run anyway**.

Tell whoever is installing it what to expect *before* they see it. This is the point where people
quietly give up, or assume the download is corrupt and go hunting for another copy.

If there is no **More info** link at all, Windows is refusing outright because the file still carries
its download mark. Right‑click the `.exe` ▸ **Properties** ▸ tick **Unblock**, then run it again.

> Signing would remove this warning and is **not** planned — so do not wait for a signed build. The
> published checksum is what vouches for the file.

---

## Say yes to the administrator prompt

The installer asks for administrator rights, and it genuinely needs them: declining produces an
install with **no redistributables and no firewall rules**, which looks like an ordinary failure and
behaves like a broken app much later. If you decline by accident, run the installer again.

---

## Before you install on a venue PC: preflight

A show PC is the machine you will not be standing next to. Check it *before* you install, not after
you have driven home.

The **Check** tab of the Launcher runs the preflight for you. It answers: does this machine have the
GPU features ArtLux needs, the runtime libraries, a network path for Art‑Net, and enough of a display
setup to drive projectors?

Read the result as a table of **FAIL** and **WARN** lines. A FAIL is blocking. A WARN is usually a
feature you are not using on this machine (no NDI on a PC with no network video, say).

---

## Verify the install before you leave

A packaged ArtLux has no console window, so you cannot read the boot log to check that everything
loaded. Verify it two ways instead.

**1. The preflight report.** Re‑run the **Check** tab after installing. A good install reports **zero
failures**, with all eight native components present and every one reporting that its imports
resolve — that is the check which catches a component that is *present but unloadable*, the failure
mode that otherwise shows up as "this feature silently does nothing".

**2. In the app.** Launch ArtLux and confirm two things by eye:

- an **NDI** entry appears in a surface's content picker;
- the projector calibration wizard opens without an "addon unavailable" message.

Native components in ArtLux **degrade gracefully** — a missing one disables its feature and logs a
line rather than crashing. That is good for a show and bad for spotting a bad install, which is
exactly why these two checks are worth doing by hand.

**Do this before you leave the venue.**

---

## Upgrading a machine that already has ArtLux

Use the Launcher's **Install** tab; it handles the awkward parts. If you are doing it by hand, the
order that matters is:

1. **Close ArtLux completely** — including any projector windows and a broadcast‑mode instance.
2. **Remove the old install** properly (not just the folder), or Windows may keep both.
3. **Clear stale firewall rules** left by the previous version.
4. Install, then verify as above.

Back up your settings first if you have tuned them; preferences live in your user profile, not in the
project.

---

## Troubleshooting

**The Start Menu shortcut opens an old version.** The double‑install problem above. Open the
Launcher's Install tab — it will name both and offer to remove the old one.

**A feature is missing with no error.** Almost always a native component that did not ship or cannot
load. Re‑run the preflight; look for the component whose imports do not resolve.

**The app icon is stale after an upgrade.** Windows caches icons; the app itself is fine. See
[INSTALL.md](../INSTALL.md) for the cache reset.

**Art‑Net does not leave the machine.** Check the firewall rules exist and are enabled — a declined
UAC prompt during install is the usual cause.

---

Full procedures: [INSTALL.md](../INSTALL.md) · the Launcher in depth: [LAUNCHER.md](../LAUNCHER.md)

⬅ Back to the [User Guide index](README.md)
