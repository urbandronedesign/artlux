# Relicensing — can ArtLux grant commercial rights?

> **Status:** ⏳ **OPEN — decision deferred to later in 2026** (owner, 2026-08-07). Nothing is being
> built or changed on the strength of this document. It exists so the decision is made from a verified
> inventory rather than from `NOTICE`'s prose, which is accurate about JUCE and **wrong in one place**
> about what the git tree redistributes (§3.2).

## 1. The question

Today [LICENSE](../LICENSE) is a **Non-Commercial Educational Licence** — clause 2 withholds commercial
use entirely. The question asked was whether ArtLux can move to a licence that lets its users do **paid
work** with it: MIT, then Apache-2.0, then AGPLv3 were each considered in turn.

Distinguish two meanings of "commercial", because the answer differs:

- **Commercial USE** — a lighting designer runs a paid show on ArtLux. This is what was actually asked for.
- **Commercial DERIVATIVES** — an integrator builds a closed product on top of ArtLux and ships it.

Every option below grants the first. Only the permissive ones grant the second.

## 2. The blocker, in one paragraph

[`native/audio-engine/CMakeLists.txt:21`](../native/audio-engine/CMakeLists.txt) fetches **JUCE 8.0.14**
and links it into `audio_engine.node`, which [`package.json:112`](../package.json) ships inside **every
installer**. The authors hold free **Starter** seats. Starter permits *them* to distribute Products; it
does **not** permit them to authorise recipients to redistribute, sublicense or sell a JUCE-linked
binary — which is exactly what MIT and Apache-2.0 §2 both grant. Put either licence on this repo and the
licence text promises something the installer cannot deliver. Secondarily, Starter's $20k revenue cap
attaches to anyone who builds the engine (EULA §1.7, on download/install/use), and a permissive licence
has no mechanism to tell them so.

**Everything else in the tree is fine.** The audio engine is the whole problem.

## 3. Verified inventory

Checked against the working tree on 2026-08-07, not read off `NOTICE`. Re-verify before deciding — the
tree commits ~2.6×/day.

### 3.1 The JUCE surface is shallow

Own C++ is **1,651 lines** — [`src/engine.cpp`](../native/audio-engine/src/engine.cpp) (1,315) +
[`src/effects.h`](../native/audio-engine/src/effects.h) (336). The JUCE API it touches:

| Area | Classes |
|---|---|
| Device I/O | `AudioDeviceManager`, `AudioIODeviceType`, `AudioSourcePlayer`, `TimeSliceThread` |
| File playback | `AudioFormatManager`, `AudioFormatReaderSource`, `AudioTransportSource` |
| DSP | `dsp::Reverb`, `Gain`, `DelayLine`, `Compressor`, `BallisticsFilter`, `StateVariableTPTFilter`, `AudioBlock` |
| Utility | `String`, `jlimit`/`jmax`/`jmin`, `ScopedLock`, `Decibels`, `SmoothedValue`, `ScopedNoDenormals` |

That is a **miniaudio (MIT-0) + a few hundred lines of hand-rolled DSP** job, not a rewrite. This
matters: it is what makes option A affordable, and nobody should re-derive it.

### 3.2 Committed binaries — `NOTICE` §2 is wrong here

`git ls-files` returns three `.node` files. `audio_engine.node` is correctly **not** among them.

| File | Contains | Verdict |
|---|---|---|
| `native/ndi/ndi.node` | **NDI SDK code** — `Processing.NDI` / `NDIlib` strings present | ⚠ **`NOTICE` §2 says the SDK "is NOT redistributed". True of the installer; false of the git tree.** A permissive licence would purport to sublicense it |
| `native/calib/calib.node` | Links `opencv_world4110.dll` (Apache-2.0) dynamically — no OpenCV code inside | ✅ Fine |
| `native/nvwarp/nvwarp.node` | **The stub** — no `nvapi` string anywhere in it | ✅ Fine. Would not be, if a real-NVAPI build were ever committed |

### 3.3 Dependency licences

| Component | Licence | Note |
|---|---|---|
| **JUCE 8.0.14** | Starter EULA (or AGPLv3, at your election) | **The blocker** |
| **libspatialaudio 0.4.0** | **LGPL-2.1-or-later**, statically linked | Its LICENSE says verbatim *"released under LGPLv2.1 (or later) and is also available under a commercial license"*, and that VideoLabs/VideoLAN may relicense *"never more restrictive than the LGPL (like a BSD/MIT/Apache license)"*. **Asking them is a live option** — see §6 |
| `serialport` 4.9.0 | MPL-2.0, **no Exhibit B** (checked) | GPL-compatible; file-level copyleft only |
| `snap` / `texture2ddecoder` / `opencv` / `napi` | BSD-3 / MIT-or-Apache / MIT / MIT | ✅ |
| OpenCV 4.11, MediaPipe | Apache-2.0 | One-way compatible into GPLv3 ✅ |
| OFL fixture data | **MIT** — `LICENSE-OFL.txt` + `NOTICE.txt` already ship beside it | ✅ No issue |
| npm production tree | No GPL/AGPL. `caniuse-lite` CC-BY-4.0 (build data), `@resvg/resvg-js` MPL-2.0 (**devDependency**, not shipped) | ✅ |
| ASIO | Gated **off** by default, SDK not vendored (`CMakeLists.txt:84-98`) | ✅ Leave it off — enabling it adds Steinberg's terms |
| Copyright | Two humans across 690 commits (three git identities), matching LICENSE | Both must consent, in writing |

**Unverified — settle before deciding:** `spout2-rs` and `grafton-ndi` licences (not in the local cargo
registry); `webgl-constants` has **no `license` field at all** (transitive via three/drei); the
provenance of `examples/audio/assets/*.wav` (`make-assets.cjs` suggests synthesized, unconfirmed).

## 4. The four options

| | Commercial use | Closed derivatives | Engineering | JUCE |
|---|---|---|---|---|
| **A. Apache-2.0 / MIT, JUCE removed** | ✅ | ✅ | **Replace the audio engine** | Gone |
| **B. Apache-2.0, audio engine carved out** | ✅ (app minus audio) | ✅ | **None** | Stays, outside the grant |
| **C. AGPLv3** | ✅ | ❌ | **None** | AGPL election |
| **D. Status quo** | ❌ | ❌ | — | Starter |

Buying JUCE Indie/Pro is not a fifth option: it lifts *your* revenue cap but still cannot grant
recipients JUCE rights, so it unlocks nothing here.

### A — Permissive, JUCE removed

The only route that is fully honest and fully permissive. Replace JUCE per §3.1, dynamic-link or replace
libspatialaudio, stop committing `ndi.node`. **Apache-2.0 over MIT** — see §5.

### B — Permissive with the audio engine carved out

Relicense the repo Apache-2.0 **except** `native/audio-engine/`, which keeps its own JUCE-bound terms;
don't ship `audio_engine.node` in public installers. Everyone gets commercial rights to pixel-mapping,
projection, timeline and show-control; audio is build-it-yourself with your own JUCE seat.

**Architecturally already supported** — `plugins/audio` graceful-degrades to silence, which is the
documented behaviour. Zero engineering. Apache-2.0's §4(d) NOTICE requirement is what makes the carve-out
travel with forks instead of relying on someone reading a file. **This is the cheapest route to a real
answer, and the recommendation if a decision is wanted without a build.**

### C — AGPLv3

**JUCE offers AGPLv3 as an election**, so this route deletes the blocker outright: no seats, no revenue
cap, no granting rights you don't hold. And the rest of the stack lines up better than for Apache —
LGPL-2.1-or-later goes upward to GPLv3 with no election gymnastics, Apache-2.0 deps are one-way
compatible, `serialport`'s MPL carries no Exhibit B.

**§13 is narrower than its reputation.** Its text is *"**if you modify the Program**, your modified
version must prominently offer all users interacting with it remotely…"*. So:

- Running **unmodified** ArtLux on a paid show, tablet remote and all → **no obligation whatsoever**. Not
  distribution, not modification. This is precisely the case that was asked about.
- Forking it and deploying the fork → must offer Corresponding Source to whoever picks up the tablet
  (in practice, their own crew).
- Wanting a closed derivative → blocked. By design.

The §13 surface is real: [`server.ts:199`](../plugins/show-control/src/server.ts) binds `0.0.0.0` and
serves a control PWA.

**Its costs.** It repels commercial integrators *culturally* — blanket AGPL bans are common and no amount
of "§13 only fires on modification" overturns one. It forecloses a **proprietary plugin ecosystem**
(third-party plugins load in-process, so they'd inherit AGPL) — worth deciding deliberately now, while
[docs/ROADMAP.md](../docs/ROADMAP.md) still says third-party disk-loading isn't built. Dual licensing
stays open since the two authors own the copyright, but a commercial licensee would still need their own
JUCE seat, and any such offer must say so.

## 5. Why Apache-2.0 rather than MIT, if going permissive

Four things MIT cannot do, all of which this project specifically needs:

1. **§4(d) NOTICE propagation.** Derivative works must carry the NOTICE file forward, so the LGPL relink
   offer, the NDI® trademark attribution and the OFL/OpenCV credits *travel* instead of evaporating at
   the first fork. For a project whose `NOTICE` is 262 reasoned lines, this is structural, not cosmetic.
2. **§4(d) partly rescues LICENSE §3.** It requires NOTICE attributions to appear *"within a display
   generated by the Derivative Works, if and wherever such third-party notices normally appear"* — the
   splash and About dialog are exactly that. MIT loses the credits entirely.
3. **§8 liability** is far stronger than MIT's one sentence, covering "direct, indirect, special,
   incidental, or consequential damages of any character". This software drives mains-powered rigs.
   §9 then permits re-attaching LICENSE §7's safety paragraph as an appendix.
4. **§6 trademark** non-grant (protects "ArtLux", helps with NDI®); **§3** patent grant costs the authors
   nothing and is why commercial shops prefer Apache; **§5** gives inbound=outbound for PRs.

**The one wrinkle Apache introduces:** it is **incompatible with LGPL-2.1**, and libspatialaudio is
statically linked. Saved by *"or later"* — elect **LGPL-3.0** for it, which Apache-2.0 *is* compatible
with. That election must be actually taken and recorded. Under MIT or AGPL it never arises.

## 6. Two structural hazards

**In-process linking (AGPL only).** Both `audio-engine.node` and `ndi.node` load into the **same Electron
main process** — [`audioManager.ts:99`](../plugins/audio/src/audioManager.ts),
[`ndiManager.ts:43`](../plugins/ndi/src/ndiManager.ts). Elect AGPL for JUCE and the audio engine is AGPL,
while the NDI addon links a **proprietary SDK** in the same address space; the FSF's position is that
this forms a combined work. A §7 additional permission can be granted for **your own** code (do this,
covering NDI and NVAPI) but not on JUCE's behalf. The defensible position — the two addons never
reference each other and are merely aggregated — is not airtight. Clean structural fix: move the audio
engine out-of-process. **This hazard does not exist under Apache-2.0**; permissive licences don't care
what shares an address space.

**libspatialaudio has a cheaper exit than any of the above.** Its own LICENSE invites relicensing to
BSD/MIT/Apache and offers a commercial licence. One email to VideoLabs could remove the LGPL question
from options A and B entirely. Nobody has asked.

## 7. What has to change, whichever way it goes

- **Both authors consent in writing.** Joint copyright; the grant is effectively irrevocable for anything
  already shipped.
- **`NOTICE` §2 corrected** — the git tree *does* redistribute NDI SDK object code (§3.2). Either stop
  committing `ndi.node` or say so plainly.
- **`NOTICE`'s AGPL rejection rewritten, not deleted.** It argues at length that AGPL was rejected
  *because it grants commercial rights*. That reasoning was correct under the old goal and is inverted
  under the new one. Rewrite it so the next reader sees that **the goal changed, not the analysis**.
- **LICENSE §3's credit requirement** survives only partially (Apache §4(d)) or not at all (MIT). Decide
  whether that is acceptable before, not after.
- The three unverified items in §3.3 settled.

---

*Not legal advice — an engineer's inventory of what links what, verified against the tree. The JUCE and
NDI agreements in particular want a lawyer's eye before any tag is pushed under new terms.*
