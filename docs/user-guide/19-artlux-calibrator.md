# 19 · ArtLux Calibrator

**ArtLux Calibrator** is the app you align a venue's projectors with. **ArtLux Show** builds and runs the
show. They open the **same project file**: the Calibrator writes the calibration into it, the Show plays it.

Only one of the two runs at a time, because only one may drive the projectors. If you start one while
the other is open, the open one asks whether to switch. To move a project between them, use
**File ▸ Open in ArtLux Calibrator…** in the Show, or **File ▸ Open in ArtLux Show…** in the Calibrator:
the project is saved, the app closes, and the other one opens it.

## The flow

The venue in 3D is always in the middle of the window. The rail on the left takes you through the steps:

| Step | What you do there |
|---|---|
| **Projection Outputs** | Put each projector on its display. |
| **Venue & Rig** | Load or update the venue model. |
| **Rig** | See every projector, what is done and what is next. |
| **Calibration** | Calibrate one projector. |
| **Blend** | Solve the blend where projectors overlap. |
| **Test & sign-off** | Check the result on the wall, sign it, hand it to the show. |
| **Recalibration** | Set up unattended recalibration. |

Each step keeps the same layout: the **projectors on the left**, the **venue in the centre**, the
**step's controls on the right**, with one main button at the bottom of the right column.

**A project opens on the UV checker.** Every screen the projectors light shows the
[UV checker](../SHADERS.md#the-uv-checker--a-test-source-that-knows-the-project) in Full HD, so you
judge the rig against a known image from the first second. The show's content is not lost:
- it is kept in the project, and **Test & sign-off ▸ Show content** brings it back;
- **ArtLux Show always opens the project with the show's content**, however you get there: the
  hand-off, **File ▸ Open in ArtLux Show…**, or a plain save and quit;
- opening a project and closing it without saving leaves the file as it was.

A scheduled recalibration handed over by ArtLux Show does not put the checker up.

## Rig

Every projector has a card with its **number**, its name, and its state — **✓ calibrated**,
**◐ calibrating**, **○ not calibrated**. Click a card to **focus** that projector: it becomes the one
thing drawn in teal, in the list and in 3D.

**Solo** shows only that projector on the wall; **Mute** turns that projector black. Both are for looking,
and neither is saved.

The right column lists what is left to do and offers the next step as its main button. Under it,
**This machine** checks that the computer can calibrate: displays, the calibration engine, a camera,
Blender, and whether ArtLux Show is installed for the hand-off.

## Calibration

Start from the Rig's main button, or **Recalibrate** a focused projector. The steps are on the right
— **Manual**, **Auto-Align** or **Board**, chosen at the top of the column (see
[Projector calibration](10-calibration.md) for what each does). The venue stays in the centre, where you
click the points. The camera — or, in Manual, the projector's own picture with your points — floats in a
small window over the venue; enlarge it with its corner button.

## Blend

Solve the blend once two or more projectors are calibrated, and read the inspector to check that every
lit point sums to one. Use **Solo** and **Mute** in the projector list to look at each projector's share
on the real wall.

## Test & sign-off

- **Test source**: **UV · Full HD** or **UV · 4K** puts the [UV checker](../SHADERS.md#the-uv-checker--a-test-source-that-knows-the-project)
  on every screen the projectors light, and it is what a project opens on. **Show content** puts the
  show back. The show's own content is kept in the project while the test plays, so saving during a
  test loses nothing, and ArtLux Show opens the project with its show content in any case.
- **Audience seat**: frame the wall in 3D from where the audience will stand and **Save this view**;
  **Go to the seat** brings you back there later.
- **Sign-off**: tick each check you have made on the wall, add your name, and **Sign off**. The sign-off
  is saved in the project with the time. If a projector is recalibrated afterwards, the Rig shows the
  sign-off as out of date.
- **Export calibration file…** writes a calibration file if the show needs one (see
  [Calibration files](10-calibration.md#calibration-files--make-one-when-you-need-one)).
- **Open in ArtLux Show** puts the show content back, saves, and hands the project to the Show.
  If this machine plays a calibration file that is older than your latest calibration or blend, it
  first offers to **export and replace** it. **File ▸ Open in ArtLux Show…** asks the same. See
  [Calibration files](10-calibration.md#calibration-files--make-one-when-you-need-one).

## Recalibration

Unattended recalibration is set up here: the camera, the thresholds, and whether it may change the
calibration. See [Running unattended](18-unattended.md).

It is **scheduled in ArtLux Show**, like any other show command. At the scheduled time the show pauses:
ArtLux Show saves, hands the machine to ArtLux Calibrator, which checks (or recalibrates) the projectors
on its own and then hands the machine back to the show. The projectors are dark or show markers for the
length of the check — typically a few seconds to a few minutes. If ArtLux Calibrator is not installed on
the show machine, the check is skipped and the show keeps playing; the machine log says so.

## What the Calibrator does not have

The timeline, LED fixtures and patching, the state machine, scenes and cues, audio, the tablet remote
and bake are in ArtLux Show. ArtLux Show, in turn, plays calibrations but has no calibration tools: no
wizards, no camera, no blend solve.
