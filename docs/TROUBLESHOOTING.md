# Troubleshooting — start from what you can see

**This page holds no answers of its own.** It is an index: you arrive knowing a *symptom*, and it sends
you to the page that owns it. Every fix lives beside the feature it belongs to, because that is the copy
that gets updated when the feature changes.

Read down the left column until a line matches what is actually in front of you.

---

## Nothing is coming out

| What you see | Where the answer is |
|---|---|
| Fixtures are dark; the app looks fine | [Patching & routing](user-guide/04-patching-and-routing.md) — a fixture with no surface, or no patch, sends nothing |
| Output is on, the DMX Monitor shows traffic, the rig is still dark | [Outputs](OUTPUTS.md) — target IP, universe, protocol, and per-fixture overrides |
| Art-Net worked yesterday, nothing today | [Installing](user-guide/17-installing.md#troubleshooting) — a firewall rule follows the network *profile*, which a re-plugged switch can change |
| A projector output is black | [Projector outputs](user-guide/08-projector-outputs.md) — display picked, output enabled, a surface assigned |
| Everything native is dead at once | [INSTALL.md ▸ Troubleshooting](INSTALL.md#troubleshooting) — usually the VC++ redistributable |

## There is no sound

| What you see | Where the answer is |
|---|---|
| The audio UI is all there and nothing plays | [DEVELOPMENT.md ▸ no sound?](DEVELOPMENT.md#the-audio-ui-is-all-there-and-nothing-plays--no-sound) — the engine addon, then the output device |
| Only 2 channels open on a multi-output interface | [Audio ▸ Commissioning a speaker rig](user-guide/07-audio.md#commissioning-a-speaker-rig), step 5 — on a vendor driver, ASIO is the only route to outputs 3+ |
| A speaker blips from the wrong box | [Audio ▸ Commissioning a speaker rig](user-guide/07-audio.md#commissioning-a-speaker-rig) — the patch, then the *Placed* pass that catches a mirrored room |
| A reverb on the master does nothing | [Audio ▸ The master strip](user-guide/07-audio.md#the-master-strip) — it is dropped after the decode, by design |
| A sound restarted when it should not have (or the reverse) | [Audio ▸ three containers](user-guide/07-audio.md) — the behaviour follows the container, and there is no flag |
| A fader will not move | [Audio ▸ Automation](user-guide/07-audio.md#automation) — a `LANE` badge means a curve owns it |

## The picture is wrong

| What you see | Where the answer is |
|---|---|
| An NDI source is missing from the list | [NDI ▸ the sources list is empty](NDI.md#troubleshooting) — mDNS does not cross a VLAN; check the network before the app |
| A Spout sender is not appearing | [SPOUT.md](SPOUT.md) — Windows only, and the sender must be running first |
| A video stutters or will not play | [Video codecs](CODECS.md) — HAP vs MP4, and what each costs |
| A shader holds still | [Shaders](SHADERS.md) — it advances with the transport; press play |
| A strip shows a vague wash where the shader looks good on screen | [`examples/shader/`](../examples/shader/README.md) — a strip samples one line across the picture |
| Projected blobs are mirrored or rotated | [Tracking ▸ Tips & troubleshooting](user-guide/13-tracking.md#tips--troubleshooting) — Flip H / Flip V / Rotate on the content |
| A projected edge does not match the physical one | [Calibration](user-guide/10-calibration.md), or corner-pin in [Projector outputs](user-guide/08-projector-outputs.md) |

## The show does not behave

| What you see | Where the answer is |
|---|---|
| The state graph does nothing | [Show / state machine ▸ Tips](user-guide/14-show-state-machine.md#tips--troubleshooting) — the machine is disabled by default |
| A show will not loop, or advances too early | [Show / state machine ▸ Tips](user-guide/14-show-state-machine.md#tips--troubleshooting) — *hold at end*, *requireEnd*, and what counts as an end |
| It looks hung but reports playing | [Show / state machine ▸ Tips](user-guide/14-show-state-machine.md#tips--troubleshooting) — that is a state holding |
| It starts black for a few seconds | [Show / state machine ▸ Tips](user-guide/14-show-state-machine.md#tips--troubleshooting) — the cold-start preload gate |
| A zone rule never fires | [Tracking ▸ Tips & troubleshooting](user-guide/13-tracking.md#tips--troubleshooting) — the scene may be listening-off to that zone |
| A moving head points the wrong way | [Moving lights ▸ Troubleshooting](user-guide/16-moving-lights.md#troubleshooting) |
| A cue is overridden by something you cannot see | [Encoding a light show](LIGHTING-SHOW.md) — precedence between takes, clips and live values |

## Nothing is arriving from outside

| What you see | Where the answer is |
|---|---|
| No blobs at all | [Tracking ▸ Tips](user-guide/13-tracking.md#tips--troubleshooting) — ping the tracker first; being on one subnet is not enough |
| `EADDRNOTAVAIL` in the log | [OSC ▸ Troubleshooting](OSC.md#troubleshooting) — the bind address is not a local NIC |
| OSC is enabled and the monitor is silent | [OSC ▸ Troubleshooting](OSC.md#troubleshooting) — the prefix, the port, and the amber monitor |
| An OSC control does nothing | [OSC ▸ Troubleshooting](OSC.md#troubleshooting) — the sender must use the control prefix |
| One person shows as two | [Tracking ▸ Tips](user-guide/13-tracking.md#tips--troubleshooting) — *Merge people*, and the merge radius |
| MediaPipe does nothing | [Tracking](user-guide/13-tracking.md) — on a released build the assets ship; on a source checkout they do not |
| An Augmenta box is silent | [AUGMENTA.md](AUGMENTA.md) — it shares the one OSC listener, so the port is the app's |

## Calibration will not converge

| What you see | Where the answer is |
|---|---|
| The checkerboard is not detected | [CALIBRATION.md ▸ Troubleshooting](CALIBRATION.md#troubleshooting) — light, flatness, and *inner* corner counts |
| "Only N corners decoded" | [CALIBRATION.md ▸ Troubleshooting](CALIBRATION.md#troubleshooting) — focus, contrast, room light |
| The error is high, or the frustum is unstable | [CALIBRATION.md ▸ Troubleshooting](CALIBRATION.md#troubleshooting) — more poses, more spread, non-coplanar points |
| The calibration engine is reported unavailable | [INSTALL.md ▸ Troubleshooting](INSTALL.md#troubleshooting) — the OpenCV DLL beside `calib.node` |

## Installing and starting

| What you see | Where the answer is |
|---|---|
| Windows SmartScreen blocks the download | [Installing](user-guide/17-installing.md#the-warning-you-will-see-first) |
| Defender calls the installer a trojan | [INSTALL.md ▸ Antivirus](INSTALL.md#antivirus--when-defender-calls-the-installer-a-trojan) |
| macOS says the app is damaged, or cannot be verified | [INSTALL.md ▸ macOS and Linux](INSTALL.md#macos-and-linux--read-this-before-you-double-click) — the build is not notarised; right-click, Open |
| The AppImage does nothing | [INSTALL.md ▸ macOS and Linux](INSTALL.md#macos-and-linux--read-this-before-you-double-click) — `chmod +x`, and FUSE 2 |
| The Launcher cannot find a release | [LAUNCHER.md ▸ Troubleshooting](LAUNCHER.md#troubleshooting) |
| A venue PC needs checking before you leave | [Installing ▸ Verify the install](user-guide/17-installing.md#verify-the-install-before-you-leave) |

## It was running and now it is not

| What you see | Where the answer is |
|---|---|
| A white or blank screen, with the app still up | [WATCHDOG.md ▸ the white screen](WATCHDOG.md#the-white-screen--why-it-needed-its-own-detector) |
| It restarted by itself, repeatedly | [WATCHDOG.md ▸ crash-loop circuit breaker](WATCHDOG.md#crash-loop-circuit-breaker) |
| It will not quit, or quits twice | [Keyboard reference](user-guide/15-keyboard-reference.md) — the quit routes differ per platform and per build |
| You need to know what this machine did | [LOGGING.md](LOGGING.md) — one JSONL file per run, with a diff against the last boot |
| You want to watch it from another machine | [MONITORING.md](MONITORING.md) — the metrics endpoint, and how to set the variable on an installed app |

---

**Still stuck?** [LOGGING.md](LOGGING.md) says where this machine's session log is and what it records —
config, timings, which media cost the time, and everything that failed. It is the first thing to read
when the symptom is "it worked last week", because it carries a diff of what changed since the last boot.
