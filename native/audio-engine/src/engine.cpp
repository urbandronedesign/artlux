// ArtLux native audio engine (Wave 3). JUCE playback + libspatialaudio ambisonic spatialisation.
//
// Signal chain:
//   spatial clips → downmix → CLIP FX (1ch) → AmbisonicEncoder(position) → ProcessAccumul ↘
//                                                                     B-format → Binauralizer(HRTF) ↘
//   non-spatial clips → CLIP FX (2ch) ────────────────────────────────────────────────────────────→ (+)
//                                        → MASTER FX (Nch) → master gain → MeteringAudioSource → device
//
// A plain MixerAudioSource can't be used for the spatial path: ambisonic encoding needs each source's
// signal SEPARATELY (a mixer has already summed them), so SpatialBus pulls every clip itself. That same
// constraint is why effects live on the CLIP (pre-encode) and on the MASTER (post-decode), and nowhere
// else — see effects.h.
//
// The engine is "dumb": JS (the plugins/audio playhead-driver) decides which bed clips are active for
// the current transport playhead and calls playClip/stopClip/gain/spatial/effects. Disk reads happen on
// a shared read-ahead thread, never on the audio callback.
#include <napi.h>
#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_dsp/juce_dsp.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "effects.h"

// libspatialaudio — ambisonic encode (per source position) → B-format → binaural decode (built-in MIT
// HRTF, no SOFA file needed). Namespace `spaudio`.
#include <AmbisonicEncoder.h>
#include <AmbisonicBinauralizer.h>
#include <AmbisonicDecoder.h>
#include <BFormat.h>

namespace {

// 1st-order: a 4-channel B-format. Cheap, and ample for <= 8 speakers / headphone binaural.
constexpr unsigned kAmbiOrder = 1;
constexpr float    kPosFadeMs = 20.0f; // encoder crossfades coefficients over a move (no zipper noise)

juce::AudioFormatManager& formats() {
  static juce::AudioFormatManager fm;
  static bool inited = false;
  if (!inited) { fm.registerBasicFormats(); inited = true; } // wav/aiff + flac/ogg (build flags)
  return fm;
}

// Our Cartesian convention (listener at origin: +x right, +y up, +z forward) → the ambisonic polar
// convention verified from libspatialaudio's own coefficients (W=1, Y=sin(az)cos(el)=LEFT,
// Z=sin(el)=UP, X=cos(az)cos(el)=FRONT): azimuth is anticlockwise from front, POSITIVE = LEFT.
// Hence atan2(-x, z) — our +x is right, so it must map to a negative azimuth.
spaudio::PolarPosition<float> toPolar(float x, float y, float z) {
  const float dist = std::sqrt(x * x + y * y + z * z);
  spaudio::PolarPosition<float> p;
  p.distance = dist;
  p.elevation = dist > 1.0e-6f ? std::asin(juce::jlimit(-1.0f, 1.0f, y / dist)) : 0.0f;
  p.azimuth = std::atan2(-x, z);
  return p;
}

// How the ambisonic B-format is rendered to the device.
enum class OutMode { Binaural, Speakers };

// The speaker layouts we expose (name → libspatialaudio preset). Binaural is headphones-only, so a
// multichannel install decodes the SAME B-format to a real speaker ring/cube instead.
spaudio::Amblib_SpeakerSetUps layoutFromName(const juce::String& n) {
  using S = spaudio::Amblib_SpeakerSetUps;
  if (n == "quad")    return S::kAmblib_Quad;
  if (n == "5.0")     return S::kAmblib_50;
  if (n == "5.1")     return S::kAmblib_51;
  if (n == "7.0")     return S::kAmblib_70;
  if (n == "7.1")     return S::kAmblib_71;
  if (n == "hexagon") return S::kAmblib_Hexagon;
  if (n == "octagon") return S::kAmblib_Octagon;
  if (n == "cube")    return S::kAmblib_Cube;      // 3D, 8 speakers
  return S::kAmblib_Stereo;
}

using artlux::EffectSpec;
using artlux::EffectChain;

struct Clip {
  std::unique_ptr<juce::AudioFormatReaderSource> reader;
  std::unique_ptr<juce::AudioTransportSource> transport;
  double sampleRate = 0.0;
  double lengthSec = 0.0;
  int channels = 0;
  bool spatial = false;
  std::unique_ptr<spaudio::AmbisonicEncoder> encoder;   // only when spatial
  spaudio::PolarPosition<float> pos {};
  // The authored chain (the truth — it outlives a device re-open and a spatial flip) and the prepared
  // DSP built from it (nullptr ⇒ dry). A spatial clip's chain is MONO, a flat one's is stereo, so
  // flipping `spatial` invalidates the chain and forces a rebuild.
  std::vector<EffectSpec> specs;
  std::unique_ptr<EffectChain> chain;
};

// Pulls every clip, encodes the spatial ones into one shared B-format, binaurally decodes that, and
// sums the non-spatial ones straight through. `lock` is held by the AUDIO thread for the whole block
// (the same discipline JUCE's own MixerAudioSource uses), so control calls that mutate clips/encoders
// are safe as long as they take it too.
class SpatialBus : public juce::AudioSource {
public:
  juce::CriticalSection lock;
  std::unordered_map<std::string, std::unique_ptr<Clip>> clips;

  // Called from Engine::configure's stack (the JS thread), with our audio callback NOT yet registered —
  // so allocating here is safe, and it already does (bformat/binaural/scratch).
  void prepareToPlay(int blockSize, double sr) override {
    const juce::ScopedLock sl(lock);
    sampleRate = sr;
    maxBlock = blockSize;
    prepared = true;
    scratch.setSize(2, blockSize);
    mono.assign((size_t) blockSize, 0.0f);
    decodeL.assign((size_t) blockSize, 0.0f);
    decodeR.assign((size_t) blockSize, 0.0f);
    bformat.Configure(kAmbiOrder, true, (unsigned) blockSize);
    unsigned tail = 0;
    binauralOk = binaural.Configure(kAmbiOrder, true, (unsigned) sr, (unsigned) blockSize, tail);
    configureDecoder();

    // Every chain is rebuilt from its specs: sample rate and block size may both have changed, and the
    // filter/delay/reverb states are sized from them.
    const juce::dsp::ProcessSpec mspec {
      sr, (juce::uint32) juce::jmax(1, blockSize), (juce::uint32) juce::jmax(1, outChannels)
    };
    masterGain.prepare(mspec);
    masterGain.setRampDurationSeconds(0.02); // ONCE — setRampDurationSeconds() resets + snaps the value
    masterGain.setGainLinear(masterGainTarget);
    masterGain.reset(); // snap to it: a prepared dsp::Gain sits at ZERO, so without this the whole output
                        // would fade in from silence every time the device opens (see GainFx::setParams)
    masterChain = EffectChain::build(masterSpecs, sr, blockSize, juce::jmax(1, outChannels), false);
    for (auto& kv : clips) {
      kv.second->transport->prepareToPlay(blockSize, sr);
      if (kv.second->spatial) configureEncoder(*kv.second);
      kv.second->chain = EffectChain::build(kv.second->specs, sr, blockSize, chanFor(*kv.second), true);
    }
  }

  // Switch how the B-format is rendered (binaural HRTF ↔ speaker-layout decode). Live: only the decoder
  // is reconfigured, so changing it never reopens the device or interrupts playback.
  void setMode(OutMode m, const juce::String& layoutName) {
    const juce::ScopedLock sl(lock);
    mode = m;
    layout = layoutName;
    if (prepared) configureDecoder();
  }
  int speakerCount() { const juce::ScopedLock sl(lock); return nSpeakers; }

  // Decoder speaker index → DEVICE CHANNEL. A venue's ring is almost never wired 1:1, and there is no
  // ladder in the audio callback. Sanitised on the way in: an out-of-range OR DUPLICATED entry (two
  // speakers CAN be pointed at the same channel — persisted prefs can be hand-edited, and the per-speaker
  // channel dropdowns in Preferences let an operator pick the same channel twice) is never silently
  // dropped — every slot is guaranteed a distinct device channel, so the result is ALWAYS a full
  // permutation of [0..kMaxSpeakers).
  void setPatch(const std::vector<int>& p) {
    const juce::ScopedLock sl(lock);
    patch.assign(kMaxSpeakers, -1);
    patchUsed.assign(kMaxSpeakers, false);   // member, not a local — see the declaration: no allocation
                                              // under `lock` once the vector has grown to size once
    for (int s = 0; s < kMaxSpeakers; ++s) {
      const int v = s < (int) p.size() ? p[(size_t) s] : s;
      if (v >= 0 && v < kMaxSpeakers && !patchUsed[(size_t) v]) { patch[(size_t) s] = v; patchUsed[(size_t) v] = true; }
    }
    // Anything still unfilled here was REJECTED by the pass above — out of range, or a duplicate whose
    // value an earlier slot already claimed. It must still land on SOME device channel: leaving it at -1
    // silently drops that decoder speaker (the write site skips a -1, so it's memory-safe, but the speaker
    // goes SILENT with no diagnostic) and breaks the "always a valid permutation" guarantee above.
    //
    // This can NOT fall back to `patch[s] = s` (a slot's own index) — that index may already be claimed by
    // a slot the pass above legitimately honoured. E.g. input [2, 2]: slot 0 claims channel 2 first, so
    // when slot 2 is considered its own index (2) is already taken; `patch[2] = 2` would just be rejected
    // again by `used[2]`, and the old code left it at -1 there — that was the bug. Instead walk a cursor
    // forward over the channels the pass above left genuinely FREE and hand out the next one. This always
    // terminates with every slot filled and the whole array a permutation: the pass above claims at most
    // one channel per slot, there are exactly kMaxSpeakers slots and kMaxSpeakers channels, so a still-
    // unfilled slot always means an as-yet-unclaimed channel exists for the cursor to find.
    int freeCh = 0;
    for (int s = 0; s < kMaxSpeakers; ++s) {
      if (patch[(size_t) s] >= 0) continue;
      while (freeCh < kMaxSpeakers && patchUsed[(size_t) freeCh]) ++freeCh;
      patch[(size_t) s] = freeCh;
      patchUsed[(size_t) freeCh] = true;
    }
  }

  // ⚠ THE TONE BYPASSES THE DECODER, AND THAT IS THE ENTIRE POINT. It is written straight onto a DEVICE
  // CHANNEL, after the decode and after the master chain. A tone routed through the ambisonic encoder
  // would prove the DECODER works — which we already know — and prove nothing about the PATCH, which is
  // the thing being commissioned. A test tone that routes through the thing under test is not a test.
  //
  // It is written BEFORE metering (the metering source wraps this bus), so the operator sees the channel
  // light up in Preferences — which is how the rig is verified with no hardware at all.
  void setTestTone(int deviceChannel, float g) {
    const juce::ScopedLock sl(lock);
    toneCh = deviceChannel; toneGain = g;
  }

  void releaseResources() override {
    const juce::ScopedLock sl(lock);
    prepared = false;
    for (auto& kv : clips) kv.second->transport->releaseResources();
  }

  void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override {
    // Reverb tails, delay feedback and filter states all decay towards zero and WILL denormal. Left
    // alone, the audio thread's cost climbs 10–100× minutes into a show, then drops out, with no code
    // change to blame. This must be the first line.
    const juce::ScopedNoDenormals noDenormals;
    info.clearActiveBufferRegion();
    const int n = info.numSamples;
    if (n <= 0 || info.buffer == nullptr) return;

    const juce::ScopedLock sl(lock);
    const int outCh = info.buffer->getNumChannels();
    observedCh.store(outCh); // so a chain built for the wrong channel count can't hide (see getMeters)
    bool anySpatial = false;
    bformat.Reset();

    for (auto& kv : clips) {
      Clip& c = *kv.second;
      scratch.clear();
      juce::AudioSourceChannelInfo si(&scratch, 0, n);
      // The transport applies the clip's gain, so the chain below is POST-FADER: riding a clip's gain
      // moves the signal through its own compressor's threshold. Correct for a bed player, but worth
      // knowing before you automate both at once.
      c.transport->getNextAudioBlock(si); // silent while stopped — but the chain still runs, so tails ring out

      if (c.spatial && c.encoder != nullptr) {
        // Ambisonic encoding is inherently mono-per-source. Fold the clip down FIRST, then run its
        // chain on the mono signal, then place it: a 2-channel reverb here would decorrelate L/R only
        // for this downmix to comb them back together. See effects.h.
        const float* l = scratch.getReadPointer(0);
        const float* r = scratch.getNumChannels() > 1 ? scratch.getReadPointer(1) : l;
        for (int i = 0; i < n; ++i) mono[(size_t) i] = 0.5f * (l[i] + r[i]);
        if (c.chain != nullptr) {
          float* mp[1] = { mono.data() };
          juce::dsp::AudioBlock<float> mb(mp, 1, (size_t) n); // named lvalue: ProcessContextReplacing can't bind a temporary
          c.chain->process(mb);
        }
        c.encoder->ProcessAccumul(mono.data(), (unsigned) n, &bformat, 0, 1.0f);
        anySpatial = true;
      } else {
        if (c.chain != nullptr) {
          juce::dsp::AudioBlock<float> sb(scratch);
          auto b = sb.getSubBlock(0, (size_t) n);
          c.chain->process(b);
        }
        for (int ch = 0; ch < outCh; ++ch) {
          const int src = juce::jmin(ch, scratch.getNumChannels() - 1);
          info.buffer->addFrom(ch, info.startSample, scratch, src, 0, n);
        }
      }
    }

    // NB: this used to be `if (!anySpatial) return;` — which would have skipped the master stage below
    // entirely whenever the bed had no spatial clip (i.e. the common case). Master effects would have
    // been wired, metered, and silently inert.
    if (anySpatial) {
      if (mode == OutMode::Binaural && binauralOk) {
        std::fill(decodeL.begin(), decodeL.begin() + n, 0.0f);
        std::fill(decodeR.begin(), decodeR.begin() + n, 0.0f);
        float* out[2] = { decodeL.data(), decodeR.data() };
        binaural.Process(&bformat, out, (unsigned) n);
        if (outCh > 0) info.buffer->addFrom(0, info.startSample, decodeL.data(), n);
        if (outCh > 1) info.buffer->addFrom(1, info.startSample, decodeR.data(), n);
      } else if (mode == OutMode::Speakers && decoderOk && nSpeakers > 0) {
        for (int s = 0; s < nSpeakers; ++s)
          std::fill(speakerBuf[(size_t) s].begin(), speakerBuf[(size_t) s].begin() + n, 0.0f);
        decoder.Process(&bformat, (unsigned) n, speakerPtrs.data());
        for (int s = 0; s < nSpeakers; ++s) {
          const int dst = (s < (int) patch.size()) ? patch[(size_t) s] : s;   // decoder speaker → device channel
          if (dst >= 0 && dst < outCh)                                        // never write past the device
            info.buffer->addFrom(dst, info.startSample, speakerBuf[(size_t) s].data(), n);
        }
      }
    }

    // ── Master: post-decode, PRE-metering (so the meters show what actually leaves the machine) ──
    juce::dsp::AudioBlock<float> full(*info.buffer);
    auto mblock = full.getSubBlock((size_t) info.startSample, (size_t) n);
    if (masterChain != nullptr) masterChain->process(mblock);
    juce::dsp::ProcessContextReplacing<float> mctx(mblock);
    masterGain.process(mctx); // post-insert fader, SmoothedValue-ramped ⇒ click-free

    // ── TEST TONE: post-everything, straight onto a device channel ──────────────────────────────────
    // Deliberately AFTER the master fader: a commissioning tone that the house fader can silence is a tone
    // that will have you checking a speaker cable while the software is muting it.
    if (toneCh >= 0 && toneCh < outCh && toneGain > 0.0f) {
      float* d = info.buffer->getWritePointer(toneCh, info.startSample);
      for (int i = 0; i < n; ++i) {
        const float w = toneRng.nextFloat() * 2.0f - 1.0f;   // white
        pinkB0 = 0.99765f * pinkB0 + w * 0.0990460f;         // → pink (Kellet). Broadband: a speaker is far
        pinkB1 = 0.96300f * pinkB1 + w * 0.2965164f;         //   easier to localise by ear than a sine, and
        pinkB2 = 0.57000f * pinkB2 + w * 1.0526913f;         //   a sine can null against a room mode.
        d[i] += (pinkB0 + pinkB1 + pinkB2 + w * 0.1848f) * 0.2f * toneGain;
      }
    }
  }

  // ── Control (all take the lock, so they can't race the audio thread) ──────────────────────────
  //
  // ── Adding: PREPARE NEVER UNDER THE LOCK ──────────────────────────────────────────────────────
  // The same disease as stop() below, and the same cure — and the rule was already written down, in
  // capitals, THREE LINES FURTHER ON. Somebody diagnosed it exactly, fixed stop(), and left addClip.
  //
  // AudioTransportSource::prepareToPlay() does not merely set a few fields. It asks its
  // BufferingAudioSource to PREFILL THE READ-AHEAD BUFFER — 0.25 s of audio, decoded FROM DISK on the
  // background reader thread — and then SPINS, Thread::sleep(5) at a time, until that thread reports
  // ready. The audio callback reaches getNextAudioBlock ONLY by taking `lock`, so for the whole prefill
  // it cannot produce one sample: the device gets silence, and the signal then resumes at whatever value
  // it had reached. A step discontinuity is broadband. That is the CLICK.
  //
  // At 48 kHz / 512 the audio thread's deadline is 10.7 ms. A WARM, page-cached read already blows it
  // (~12 ms, one block missed); a typical read misses three; a cold read off a spinning disk or a network
  // share misses eleven. And this is the HOTTER of the two paths: the driver has no audio preload tier
  // (plugin.renderer.ts says so in as many words), so a scene's sting is decoded ON ENTRY, EVERY ENTRY —
  // one blocking prepare under the audio lock ON EVERY GO, all night, in an unattended install.
  //
  // The clip is not in `clips` yet, so the audio thread cannot reach it: PREPARING IT NEEDS NO LOCK AT
  // ALL. Only the snapshot and the insert do, and both are O(1) with no I/O.
  //
  // ⚠ AND THE OBVIOUS FIX OPENS A RACE THAT MUST BE CLOSED. prepareToPlay() above re-prepares every clip
  // IN THE MAP (:140) — and a device re-open (a USB bump, a driver reload, an output-mode change) lands
  // exactly there. Fire it while we are preparing outside the lock and OUR CLIP IS NOT IN THE MAP YET, so
  // it is missed; we would then insert a clip prepared for 512@48k into an engine now running 256@44.1k.
  // So the insert RE-CHECKS the device and prepares again if it moved. It compares the SETTINGS, not a
  // generation counter, deliberately: a re-open that lands on the same block size and sample rate leaves
  // our preparation perfectly valid, and there is nothing to redo.
  void addClip(const std::string& id, std::unique_ptr<Clip> clip) {
    for (;;) {
      bool wasPrepared; int block; double rate;
      {
        const juce::ScopedLock sl(lock);
        wasPrepared = prepared; block = maxBlock; rate = sampleRate;
      }
      // ⚠ THE BLOCKING CALL, WITH NO LOCK HELD. This line is the entire fix. Do not hoist it into a
      // ScopedLock scope "for symmetry with the other control calls" — the symmetry is the bug.
      if (wasPrepared) clip->transport->prepareToPlay(block, rate);
      {
        const juce::ScopedLock sl(lock);
        if (prepared == wasPrepared && maxBlock == block && sampleRate == rate) {
          clips[id] = std::move(clip);   // the device did not move under us — commit
          return;
        }
      }
      // It did move. Drop the lock and prepare again against its new settings.
    }
  }
  // ── Stopping: NEVER under the lock ────────────────────────────────────────────────────────────
  // AudioTransportSource::stop() BLOCKS. It sets playing=false and then spins — up to 500 × 2 ms —
  // waiting for the audio thread to acknowledge by setting `stopped`, which it can only do from inside
  // AudioTransportSource::getNextAudioBlock. Our audio thread reaches that only by taking `lock`. So
  // calling stop() while holding `lock` is a deadlock that resolves by TIMEOUT: the audio callback is
  // starved for the full second. Measured on the real device: 1250 ms per stopped clip, 3750 ms for
  // three. The driver calls stopAll() on every pause, so this was a >1 s dropout every time.
  //
  // Every stop() therefore happens OUTSIDE the lock. That is safe because the clip map is mutated only
  // from the single N-API thread, so a Clip* obtained under the lock cannot be freed underneath us by
  // another control call — and with the lock released the audio thread runs, acknowledges, and stop()
  // returns within one block.
  void removeClip(const std::string& id) {
    std::unique_ptr<Clip> dead; // destroyed when this scope ends — outside the lock
    {
      const juce::ScopedLock sl(lock);
      auto it = clips.find(id);
      if (it == clips.end()) return;
      dead = std::move(it->second);
      clips.erase(it); // the audio thread can no longer reach it, so the rest needs no lock
    }
    dead->transport->stop();
    dead->transport->setSource(nullptr);
  }
  void stopClip(const std::string& id) {
    Clip* c = nullptr;
    { const juce::ScopedLock sl(lock); c = find(id); }
    if (c != nullptr) c->transport->stop();
  }
  Clip* find(const std::string& id) { // caller must hold the lock
    auto it = clips.find(id);
    return it == clips.end() ? nullptr : it->second.get();
  }
  void setSpatial(const std::string& id, float x, float y, float z) {
    const juce::ScopedLock sl(lock);
    Clip* c = find(id);
    if (c == nullptr) return;
    c->pos = toPolar(x, y, z);
    if (!c->spatial || c->encoder == nullptr) {
      c->spatial = true;
      configureEncoder(*c);              // first enable: allocate + configure
    } else {
      c->encoder->SetPosition(c->pos);   // a move: just re-aim (the fade smooths it)
      c->encoder->Refresh();
    }
  }
  void clearSpatial(const std::string& id) {
    const juce::ScopedLock sl(lock);
    if (Clip* c = find(id)) c->spatial = false;
  }

  // ── Effect chains ─────────────────────────────────────────────────────────────────────────────
  int chanFor(const Clip& c) const noexcept { return c.spatial ? 1 : 2; } // spatial ⇒ mono-first

  void setOutputChannels(int ch) {
    const juce::ScopedLock sl(lock);
    outChannels = juce::jmax(1, ch);
  }
  void setMasterGain(float g) {
    const juce::ScopedLock sl(lock);
    masterGainTarget = juce::jlimit(0.0f, 4.0f, g);
    masterGain.setGainLinear(masterGainTarget); // NEVER setRampDurationSeconds here — it resets + snaps
  }

  // Replace an effect chain (empty clipId ⇒ the master chain).
  //
  // Three phases, and the order IS the design: decide under the lock, BUILD OUTSIDE it, swap under it.
  // build() allocates (a reverb's HeapBlocks, a 2 s delay line) and the audio thread holds this lock for
  // the whole block — so building under it would steal an audio block and click on every effect edit.
  // `old` is declared before the lock scope so the discarded chain's destructor (a free()) also lands
  // outside. When nothing structural changed, the params update in place: no malloc, no reset, no click.
  void applyEffects(const std::string& clipId, std::vector<EffectSpec> specs) {
    const bool isMaster = clipId.empty();
    std::unique_ptr<EffectChain> old; // FIRST → destroyed LAST, outside the lock
    double sr = 48000.0;
    int mb = 512, nch = 2;
    bool ready = false;
    {
      const juce::ScopedLock sl(lock);
      Clip* c = isMaster ? nullptr : find(clipId);
      if (!isMaster && c == nullptr) return; // clip already gone
      sr = sampleRate;
      mb = maxBlock;
      ready = prepared;
      nch = isMaster ? juce::jmax(1, outChannels) : chanFor(*c);
      std::vector<EffectSpec>* curSpecs = isMaster ? &masterSpecs : &c->specs;
      std::unique_ptr<EffectChain>* curChain = isMaster ? &masterChain : &c->chain;
      if (ready && *curChain != nullptr && (*curChain)->channels() == nch && sameStructure(*curSpecs, specs)) {
        (*curChain)->updateParams(specs);
        *curSpecs = std::move(specs);
        return;
      }
      *curSpecs = specs; // remembered: prepareToPlay rebuilds every chain from its specs
    }
    if (!ready) return; // no device yet — prepareToPlay will build it from the specs we just stored
    auto next = EffectChain::build(specs, sr, mb, nch, !isMaster); // ← the expensive part, OUTSIDE the lock
    {
      const juce::ScopedLock sl(lock);
      if (isMaster) { old = std::move(masterChain); masterChain = std::move(next); }
      else if (Clip* c = find(clipId)) { old = std::move(c->chain); c->chain = std::move(next); }
    }
  }

  // A spatial flip changes the chain's channel count (2 ⇔ 1), which invalidates it — an un-rebuilt chain
  // would hit EffectChain::process's guard and go silently dry. Rebuild only when the shape really moved
  // (so dragging a source around the pad, which calls setSpatial every frame, costs nothing).
  void refreshClipChain(const std::string& id) {
    std::vector<EffectSpec> specs;
    {
      const juce::ScopedLock sl(lock);
      Clip* c = find(id);
      if (c == nullptr || c->specs.empty()) return;
      if (c->chain != nullptr && c->chain->channels() == chanFor(*c)) return; // shape unchanged
      specs = c->specs;
    }
    applyEffects(id, std::move(specs));
  }

  int masterChainChannels() {
    const juce::ScopedLock sl(lock);
    return masterChain != nullptr ? masterChain->channels() : 0;
  }
  int observedChannels() const noexcept { return observedCh.load(); }

  void stopAll() {
    std::vector<Clip*> cs;
    {
      const juce::ScopedLock sl(lock);
      cs.reserve(clips.size());
      for (auto& kv : clips) cs.push_back(kv.second.get());
    }
    for (Clip* c : cs) c->transport->stop(); // outside the lock — see removeClip
  }
  void clear() {
    std::unordered_map<std::string, std::unique_ptr<Clip>> dead;
    { const juce::ScopedLock sl(lock); dead.swap(clips); }
    for (auto& kv : dead) { kv.second->transport->stop(); kv.second->transport->setSource(nullptr); }
  }

  double sampleRate = 48000.0;

private:
  void configureEncoder(Clip& c) { // caller holds the lock
    if (c.encoder == nullptr) c.encoder = std::make_unique<spaudio::AmbisonicEncoder>();
    c.encoder->Configure(kAmbiOrder, true, (unsigned) juce::jmax(8000.0, sampleRate), kPosFadeMs);
    c.encoder->SetPosition(c.pos);
    c.encoder->Refresh();
  }

  void configureDecoder() { // caller holds the lock
    decoderOk = decoder.Configure(kAmbiOrder, true, (unsigned) maxBlock, (unsigned) sampleRate, layoutFromName(layout));
    nSpeakers = decoderOk ? (int) decoder.GetSpeakerCount() : 0;
    speakerBuf.assign((size_t) juce::jmax(0, nSpeakers), std::vector<float>((size_t) maxBlock, 0.0f));
    speakerPtrs.assign((size_t) juce::jmax(0, nSpeakers), nullptr);
    for (int i = 0; i < nSpeakers; ++i) speakerPtrs[(size_t) i] = speakerBuf[(size_t) i].data();
  }

  bool prepared = false;
  int maxBlock = 512;
  juce::AudioBuffer<float> scratch;
  std::vector<float> mono, decodeL, decodeR;
  spaudio::BFormat bformat;
  spaudio::AmbisonicBinauralizer binaural;
  bool binauralOk = false;
  OutMode mode = OutMode::Binaural;
  juce::String layout { "stereo" };
  spaudio::AmbisonicDecoder decoder;
  bool decoderOk = false;
  int nSpeakers = 0;
  std::vector<std::vector<float>> speakerBuf;
  std::vector<float*> speakerPtrs;

  static constexpr int kMaxSpeakers = 64;   // configure() clamps channels to 64; the patch must cover it
  std::vector<int> patch;                   // decoder speaker → device channel (identity by default)
  std::vector<bool> patchUsed;               // setPatch's scratch "which device channels are claimed" —
                                              // a MEMBER so it's grown once and reset (not reallocated) on
                                              // every setPatch call, same discipline as `patch` itself; a
                                              // local here would malloc on every call while `lock` is held
                                              // (the same disease addClip/stop's comments are about)
  int toneCh = -1;                          // -1 = off
  float toneGain = 0.0f;
  float pinkB0 = 0, pinkB1 = 0, pinkB2 = 0; // Paul Kellet's economy pink filter — no allocation, no state reset needed
  juce::Random toneRng;

  // Master insert chain + fader, applied post-decode. `outChannels` is what the device ACTUALLY opened
  // with (Engine::configure reads it back from the device — asking for 8 on a stereo card gives 2), and
  // the master chain is built for exactly that. `observedCh` is what the audio thread really sees: if it
  // ever disagrees with the chain's channel count, the chain has gone silently dry and getMeters() will
  // say so rather than letting it hide.
  int outChannels = 2;
  std::vector<EffectSpec> masterSpecs;
  std::unique_ptr<EffectChain> masterChain;
  juce::dsp::Gain<float> masterGain;
  float masterGainTarget = 1.0f;
  std::atomic<int> observedCh { 0 };
};

constexpr int kMaxMeterCh = 8;

// Taps the mixed output for the UI meters. PER-CHANNEL peaks are what make spatialisation verifiable
// rather than assumed: a hard-left source must give ch0 >> ch1 (a flipped azimuth shows up instantly),
// and under speaker decode the energy must land on the speakers nearest the source.
class MeteringAudioSource : public juce::AudioSource {
public:
  MeteringAudioSource(juce::AudioSource& s, std::atomic<float>& peak, std::atomic<float>& rms,
                      std::array<std::atomic<float>, kMaxMeterCh>& chPeaks, std::atomic<bool>& clipped)
    : src(s), peakOut(peak), rmsOut(rms), chOut(chPeaks), clipOut(clipped) {}
  void prepareToPlay(int n, double sr) override { src.prepareToPlay(n, sr); }
  void releaseResources() override { src.releaseResources(); }
  void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override {
    src.getNextAudioBlock(info);
    float peak = 0.0f, sumSq = 0.0f;
    int count = 0;
    std::array<float, kMaxMeterCh> ch {};
    if (info.buffer != nullptr) {
      for (int c = 0; c < info.buffer->getNumChannels(); ++c) {
        const float* d = info.buffer->getReadPointer(c, info.startSample);
        float cp = 0.0f;
        for (int i = 0; i < info.numSamples; ++i) {
          const float a = std::abs(d[i]);
          cp = juce::jmax(cp, a);
          sumSq += d[i] * d[i];
          ++count;
        }
        peak = juce::jmax(peak, cp);
        if (c < kMaxMeterCh) ch[(size_t) c] = cp;
      }
    }
    peakOut.store(peak);
    rmsOut.store(count > 0 ? std::sqrt(sumSq / (float) count) : 0.0f);
    for (int c = 0; c < kMaxMeterCh; ++c) chOut[(size_t) c].store(ch[(size_t) c]);
    // Clipping is LATCHED, not sampled. `peak` is one block's peak and the UI polls at ~10 Hz, so nine
    // blocks in ten are never seen — a clip indicator built on that would miss most of what it exists to
    // catch, which is worse than not having one. This sticks until getMeters() reads and clears it.
    if (peak >= 1.0f) clipOut.store(true);
  }
private:
  juce::AudioSource& src;
  std::atomic<float>& peakOut;
  std::atomic<float>& rmsOut;
  std::array<std::atomic<float>, kMaxMeterCh>& chOut;
  std::atomic<bool>& clipOut;
};

class Engine {
public:
  Engine() : metering(bus, meterPeak, meterRms, meterCh, meterClipped) {}
  ~Engine() { closeDevice(); }

  struct DeviceCfg {
    juce::String type;    // '' = keep the current device type
    juce::String name;    // '' = that type's default device
    int channels = 2;
    double sampleRate = 0; // 0 = the device's default
    int bufferSize = 0;    // 0 = the device's default
    OutMode mode = OutMode::Binaural;
    juce::String layout { "stereo" };
    std::vector<int> patch;   // decoder speaker → device channel (empty ⇒ identity)
  };

  struct OpenedCfg { juce::String deviceName, deviceType; double sampleRate = 0; int bufferSize = 0; int channels = 0; };

  juce::String configure(const DeviceCfg& c, OpenedCfg& out) {
    // Decode mode/layout is applied live (decoder-only) — changing it never reopens the device, so this
    // MUST run before every guard below: none of them (dead-device check, idempotence guard, the
    // snapshot block) is about the decoder, and a mode/layout-only change (same device, different
    // mode/layout) has to take effect even when — ESPECIALLY when — one of those guards ends this call
    // early without touching the device at all. That is deliberate and load-bearing; do not "clean up"
    // this ordering by moving it after the guards.
    //
    // ⚠ BUT THAT MEANS IT MUST BE ROLLED BACK, TOO. bus.setMode() rebuilds the ambisonic decoder — speaker
    // count, speakerBuf/speakerPtrs — for the REQUESTED layout immediately, SYNCHRONOUSLY, before we know
    // whether the requested DEVICE below will even open. If the open fails and the rollback block further
    // down puts the OLD device back, the decoder must be put back to the OLD mode/layout as well — or the
    // restored device plays through a decode built for the layout that just failed to open (wrong speaker
    // count, content routed to the wrong channels). Nothing else catches this: `opened`/`deviceLive` only
    // know about the device, and the masterFxChannels/deviceChannels diagnostic in GetMeters only checks
    // the POST-decode chain's width against the device — never the decode's mode/layout itself. See the
    // rollback block below, where prevMode/prevLayout are applied via a second bus.setMode() call.
    bus.setMode(c.mode, c.layout);
    bus.setPatch(c.patch);   // live, decoder-only — changing the patch never reopens the device
    const int ch = juce::jlimit(1, 64, c.channels);

    // ⚠ THE DEVICE CAN DIE UNDER US, AND `opened` DOES NOT KNOW. Nothing sets it false when the HARDWARE
    // goes away — a bumped USB cable, a driver reload, a Windows power-management cycle. JUCE knows
    // (getCurrentAudioDevice() returns nullptr); the engine simply never asked. Without this line the
    // Reconnect button takes the early return below and does nothing, and the only way back is a restart.
    if (deviceManager.getCurrentAudioDevice() == nullptr) opened = false;

    // ⚠ THE GUARD KEYS ON THE WHOLE SETUP, NOT JUST THE CHANNEL COUNT. It used to compare `ch` alone —
    // so SWITCHING DEVICE at the same channel count (the entire point of a device picker) would have hit
    // this early return and CHANGED NOTHING. The picker would have looked wired and been inert.
    if (opened && ch == openedChannels && c.type == openedType && c.name == openedName
        && c.sampleRate == openedRate && c.bufferSize == openedBuffer) {
      // The device didn't change, but bus.setMode() above may have — this is exactly how a mode/layout-only
      // change takes effect (see the comment above it). Record it, or a later rollback would read a STALE
      // openedMode/openedLayout (from before THIS call) instead of the one now actually live.
      openedMode = c.mode; openedLayout = c.layout;
      out = lastOpened;
      return {}; // already open on exactly this config — don't interrupt playback
    }

    // ⚠ A FAILED RECONFIGURE MUST NOT LEAVE THE ROOM SILENT. Task 3 made this reachable: configure() used
    // to only ever open the OS default (which essentially never errors); pinning a named device/type/rate/
    // buffer is exactly what makes "the operator asked for a combination the device won't grant" something
    // that gets clicked — a buffer size WASAPI Exclusive won't grant at the requested rate, an unsupported
    // sample rate, a device that vanished between enumeration and open. So before tearing down a device
    // that IS working, snapshot exactly what "working" means — the live driver type and the live
    // AudioDeviceSetup — so a failed open below can put the OLD one straight back instead of leaving
    // `opened` false with nothing registered to the callback. This MUST be captured before any mutation:
    // setCurrentAudioDeviceType() a few lines down changes what getCurrentAudioDeviceType() reports, and
    // closeAudioDevice() does not preserve it for us. Only meaningful when a device was actually open —
    // `opened` is already the corrected ground truth for that (the dead-device check above ran first).
    const bool hadGoodDevice = opened;
    juce::String prevType;
    juce::AudioDeviceManager::AudioDeviceSetup prevSetup;
    int prevActualChannels = 0;
    OutMode prevMode = OutMode::Binaural;
    juce::String prevLayout { "stereo" };
    if (hadGoodDevice) {
      prevType = deviceManager.getCurrentAudioDeviceType();
      deviceManager.getAudioDeviceSetup(prevSetup);
      prevActualChannels = lastOpened.channels; // what the bus was ACTUALLY configured for, not what was asked
      // prevMode/prevLayout come from openedMode/openedLayout, NOT from the bus: bus.setMode(c.mode,
      // c.layout) at the very top of this call has ALREADY overwritten the bus's mode/layout with the
      // REQUESTED (possibly-failing) values, so by the time we get here the bus itself can no longer tell
      // us what was live. openedMode/openedLayout are the engine's own record of the last mode/layout a
      // successful bus.setMode() call left in place — tracked in lockstep with openedType/openedName
      // (both here and at the idempotence-guard's early return above), and, like them, deliberately left
      // untouched on the rollback path below so they keep describing whatever ends up actually live.
      prevMode = openedMode;
      prevLayout = openedLayout;
    }

    if (opened) { deviceManager.removeAudioCallback(&player); player.setSource(nullptr); deviceManager.closeAudioDevice(); opened = false; }

    // First call: initialise() is what builds the device-type list that setCurrentAudioDeviceType() needs.
    if (!initialised) {
      deviceManager.initialise(0, ch, nullptr, true);
      initialised = true;
    }
    if (c.type.isNotEmpty() && c.type != deviceManager.getCurrentAudioDeviceType())
      deviceManager.setCurrentAudioDeviceType(c.type, true);

    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager.getAudioDeviceSetup(setup);
    setup.outputDeviceName = c.name;      // '' ⇒ the type's default device
    setup.inputDeviceName = {};
    setup.sampleRate = c.sampleRate;      // 0 ⇒ device default
    setup.bufferSize = c.bufferSize;      // 0 ⇒ device default
    setup.useDefaultInputChannels = false;
    setup.inputChannels.clear();
    setup.useDefaultOutputChannels = false;
    setup.outputChannels.clear();
    setup.outputChannels.setRange(0, ch, true);
    juce::String err = deviceManager.setAudioDeviceSetup(setup, true);
    if (err.isNotEmpty()) {
      // Nothing was open before this call (first-ever configure, or the previous device had already died —
      // see the dead-device invalidation above) — there is no "last known good" to roll back to.
      if (!hadGoodDevice) return err;

      // ⚠ ROLL BACK, NOT DOWN. Put the previous type + setup straight back — the SAME open sequence the
      // success path below uses, just with the OLD numbers — so the show keeps making sound. None of this
      // runs under `bus.lock`: it is JS/native-thread work, exactly like the open attempt above and the
      // teardown before it. See SpatialBus::addClip's comment block for why a blocking device open under
      // the audio lock is the one bug this engine cannot afford to repeat.
      if (deviceManager.getCurrentAudioDeviceType() != prevType)
        deviceManager.setCurrentAudioDeviceType(prevType, true);
      const juce::String rollbackErr = deviceManager.setAudioDeviceSetup(prevSetup, true);
      if (rollbackErr.isNotEmpty())
        return "requested device failed to open (" + err + ") AND the previous device could not be "
               "restored (" + rollbackErr + ") — audio is now silent, a restart is required";

      int restoredActual = prevActualChannels;
      if (auto* dev = deviceManager.getCurrentAudioDevice())
        restoredActual = juce::jmax(1, dev->getActiveOutputChannels().countNumberOfSetBits());
      bus.setOutputChannels(restoredActual);   // BEFORE setSource — see the success path below
      // Put the DECODE back too. bus.setMode(c.mode, c.layout) at the top of this call already rebuilt the
      // ambisonic decoder for the layout that just failed to open — the device being restored above was
      // never opened with that layout; it was opened (and is being put back) with prevMode/prevLayout. Skip
      // this and the restored device would be live and audible but decoding into the WRONG mode/layout —
      // looks wired, meters normally (masterFxChannels/deviceChannels only check the POST-decode chain's
      // width against the device, never the decode itself), and is silently wrong. Decoder-only, so — like
      // the call at the top of configure() — this cannot fail and does not touch the device.
      bus.setMode(prevMode, prevLayout);
      if (!readThread.isThreadRunning()) readThread.startThread();
      player.setSource(&metering);
      deviceManager.addAudioCallback(&player);
      opened = true;
      // openedType/openedName/openedChannels/openedRate/openedBuffer/openedMode/openedLayout/lastOpened
      // are DELIBERATELY left untouched here: the failed attempt never reached the point (below) where
      // they get overwritten, so they still describe exactly the setup — and now, the decode — we just put
      // back. Rewriting them to the REQUESTED (failed) setup would make the guard above believe that setup
      // is live — the operator's next attempt to fix it would then take the early return and do nothing,
      // the same trap the dead-device invalidation above exists to avoid.
      return err; // the requested setup still failed — the caller (and the Preferences panel) must know
    }

    // The device can open with FEWER channels than we asked for (8 on a stereo card gives 2), and at a
    // different rate/buffer than requested. The master chain must be built for what we ACTUALLY got, or it
    // sees a channel-count mismatch every block and passes dry. Push it BEFORE addAudioCallback — that is
    // what triggers prepareToPlay, which builds it.
    int actual = ch;
    if (auto* dev = deviceManager.getCurrentAudioDevice()) {
      actual = juce::jmax(1, dev->getActiveOutputChannels().countNumberOfSetBits());
      out.deviceName = dev->getName();
      out.sampleRate = dev->getCurrentSampleRate();
      out.bufferSize = dev->getCurrentBufferSizeSamples();
    }
    out.deviceType = deviceManager.getCurrentAudioDeviceType();
    out.channels = actual;
    bus.setOutputChannels(actual);
    if (!readThread.isThreadRunning()) readThread.startThread();
    player.setSource(&metering);
    deviceManager.addAudioCallback(&player);
    opened = true;
    openedChannels = ch; openedType = c.type; openedName = c.name;
    openedRate = c.sampleRate; openedBuffer = c.bufferSize;
    openedMode = c.mode; openedLayout = c.layout;
    lastOpened = out;
    return {};
  }

  // ⚠ IS THERE A DEVICE — WHICH IS NOT THE SAME QUESTION AS "DID THE ADDON LOAD".
  //
  // The UI's only probe was `audio:available`, and it reports ONLY whether the .node loaded. The addon is
  // still perfectly loaded when the interface is unplugged, so Preferences went on printing
  //     "Native JUCE + ambisonic engine active · output device: Focusrite Scarlett 2i2"
  // over a silent room, NAMING A DEVICE THAT WAS PHYSICALLY GONE. That is the same self-reporting-healthy
  // failure the missing-engine notice fixed in Session 0 — fixed once, in one place, and the lesson never
  // reached the device layer.
  //
  // Rides the meters poll, which already runs at 10 Hz and already crosses IPC (see GetMeters). No new
  // channel, no new timer.
  bool deviceLive() { return deviceManager.getCurrentAudioDevice() != nullptr; }

  struct DeviceEntry { juce::String type, name; bool isDefault; };

  // ⚠ NO NAME-LEVEL DEDUPE. One physical interface is enumerated under FOUR driver types — WASAPI shared,
  // WASAPI exclusive, WASAPI shared-low-latency, DirectSound — all under the SAME NAME. The old dedupe
  // collapsed them into one row and threw away the only thing that told them apart, which is why EXCLUSIVE
  // MODE — the thing that delivers discrete 8-channel output on Windows — was already compiled in, already
  // enumerated, and completely unreachable.
  std::vector<DeviceEntry> listOutputDevices() {
    std::vector<DeviceEntry> out;
    juce::OwnedArray<juce::AudioIODeviceType> types;
    deviceManager.createAudioDeviceTypes(types);
    for (auto* t : types) {
      t->scanForDevices();
      const auto names = t->getDeviceNames(false);
      const int def = t->getDefaultDeviceIndex(false);
      for (int i = 0; i < names.size(); ++i)
        out.push_back({ t->getTypeName(), names[i], i == def });
    }
    return out;
  }

  bool loadClip(const std::string& id, const juce::String& path, Clip*& out, juce::String& err) {
    juce::File f(path);
    if (!f.existsAsFile()) { err = "file not found: " + path; return false; }
    auto* rawReader = formats().createReaderFor(f);
    if (rawReader == nullptr) { err = "no decoder for " + path; return false; }
    auto clip = std::make_unique<Clip>();
    clip->sampleRate = rawReader->sampleRate;
    clip->channels = (int) rawReader->numChannels;
    clip->lengthSec = rawReader->sampleRate > 0 ? (double) rawReader->lengthInSamples / rawReader->sampleRate : 0.0;
    clip->reader = std::make_unique<juce::AudioFormatReaderSource>(rawReader, true);
    clip->transport = std::make_unique<juce::AudioTransportSource>();
    clip->transport->setSource(clip->reader.get(), 32768, &readThread, rawReader->sampleRate);
    out = clip.get();
    bus.removeClip(id); // replace any existing source under this id
    bus.addClip(id, std::move(clip));
    return true;
  }

  void unloadClip(const std::string& id) { bus.removeClip(id); }

  // A CLIP'S GAIN IS BOUNDED HERE, exactly as the master's is in setMasterGain — this is the last door
  // before the amplifier and it is the one door a number cannot be typed past. The persisted
  // AudioClip.gain / AudioTrack.gain are coerced for FINITENESS only on the JS side (sanitizeAudioClip),
  // so a hand-edited or tool-generated project carrying "gain": 20 used to arrive here verbatim and play
  // at 20×. The renderer now bounds it to the target's declared range (0..1.5) before it is sent; this is
  // the belt to that pair of braces, and it holds even for a caller that has not read the contract.
  static float boundedGain(float g) noexcept {
    return std::isfinite(g) ? juce::jlimit(0.0f, 4.0f, g) : 1.0f;
  }
  void playClip(const std::string& id, double seekSec, float gain) {
    const juce::ScopedLock sl(bus.lock);
    if (Clip* c = bus.find(id)) {
      c->transport->setGain(boundedGain(gain));
      c->transport->setPosition(juce::jmax(0.0, seekSec));
      c->transport->start();
    }
  }
  void stopClip(const std::string& id) { bus.stopClip(id); } // stops OUTSIDE the lock — see SpatialBus::removeClip
  void setClipGain(const std::string& id, float gain) {
    const juce::ScopedLock sl(bus.lock);
    if (Clip* c = bus.find(id)) c->transport->setGain(boundedGain(gain));
  }
  // Flipping `spatial` changes the clip chain's channel count (2 ⇔ 1), so the chain is rebuilt after —
  // refreshClipChain is a no-op when the shape didn't actually move, so dragging the positioner is free.
  void setClipSpatial(const std::string& id, float x, float y, float z) {
    bus.setSpatial(id, x, y, z);
    bus.refreshClipChain(id);
  }
  void clearClipSpatial(const std::string& id) {
    bus.clearSpatial(id);
    bus.refreshClipChain(id);
  }
  void setClipEffects(const std::string& id, std::vector<EffectSpec> specs) { bus.applyEffects(id, std::move(specs)); }
  void setMasterEffects(std::vector<EffectSpec> specs) { bus.applyEffects({}, std::move(specs)); } // {} ⇒ master
  void setMasterGain(float g) { bus.setMasterGain(g); }
  void setTestTone(int ch, float g) { bus.setTestTone(ch, g); }
  void stopAll() { bus.stopAll(); }

  float peak() const { return meterPeak.load(); }
  float rms() const { return meterRms.load(); }
  float chPeak(int i) const { return (i >= 0 && i < kMaxMeterCh) ? meterCh[(size_t) i].load() : 0.0f; }
  int speakerCount() { return bus.speakerCount(); }
  int masterFxChannels() { return bus.masterChainChannels(); }
  int deviceChannels() const { return bus.observedChannels(); }
  bool takeClipped() { return meterClipped.exchange(false); } // read-and-clear: "has it clipped since you last asked"

  void closeDevice() {
    if (opened) { deviceManager.removeAudioCallback(&player); player.setSource(nullptr); deviceManager.closeAudioDevice(); opened = false; }
    bus.clear();
    if (readThread.isThreadRunning()) readThread.stopThread(2000);
  }

private:
  juce::AudioDeviceManager deviceManager;
  juce::AudioSourcePlayer player;
  SpatialBus bus;
  std::atomic<float> meterPeak { 0.0f };
  std::atomic<float> meterRms { 0.0f };
  std::array<std::atomic<float>, kMaxMeterCh> meterCh {};
  std::atomic<bool> meterClipped { false };
  MeteringAudioSource metering;                 // declared after bus + meters
  juce::TimeSliceThread readThread { "artlux-audio-read" };
  bool opened = false;
  int openedChannels = 0;
  bool initialised = false;
  juce::String openedType, openedName;
  double openedRate = 0;
  int openedBuffer = 0;
  // The last mode/layout a SUCCESSFUL bus.setMode() call left in place — i.e. the decode that matches
  // whatever device is actually live. Tracked the same way as openedType/openedName (updated at the same
  // two sites: the idempotence-guard early return and the full open-success path; deliberately untouched
  // on the rollback path) so configure()'s rollback block has somewhere safe to read a PREVIOUS mode/layout
  // from — the bus's own mode/layout members are not safe to read there, because the unconditional
  // bus.setMode(c.mode, c.layout) at the top of configure() has already overwritten them with the
  // REQUESTED (possibly-failing) values by the time the rollback block runs.
  OutMode openedMode = OutMode::Binaural;
  juce::String openedLayout { "stereo" };
  OpenedCfg lastOpened;
};

std::unique_ptr<Engine> gEngine;
Engine& ensureEngine() { if (!gEngine) gEngine = std::make_unique<Engine>(); return *gEngine; }

} // namespace

// ── N-API surface ───────────────────────────────────────────────────────────────────────────────
static Napi::String JuceVersion(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), juce::SystemStats::getJUCEVersion().toStdString());
}

// configure(cfg) — cfg: { deviceType?, deviceName?, channels?, sampleRate?, bufferSize?, mode?, layout? }
// Returns the setup ACTUALLY OPENED: { deviceName, deviceType, sampleRate, bufferSize, channels }. It can
// differ from what was asked (a stereo card asked for 8ch reports 2 back) and the UI must show what it GOT.
static Napi::Value Configure(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  Napi::Object o = info.Length() > 0 && info[0].IsObject() ? info[0].As<Napi::Object>() : Napi::Object::New(env);
  const auto str = [&](const char* k, const char* dflt) -> std::string {
    return o.Has(k) && o.Get(k).IsString() ? o.Get(k).As<Napi::String>().Utf8Value() : std::string(dflt);
  };
  const auto num = [&](const char* k, double dflt) -> double {
    return o.Has(k) && o.Get(k).IsNumber() ? o.Get(k).As<Napi::Number>().DoubleValue() : dflt;
  };
  Engine::DeviceCfg cfg;
  cfg.type = juce::String(str("deviceType", ""));
  cfg.name = juce::String(str("deviceName", ""));
  cfg.channels = (int) num("channels", 2);
  cfg.sampleRate = num("sampleRate", 0);
  cfg.bufferSize = (int) num("bufferSize", 0);
  cfg.mode = (str("mode", "binaural") == "speakers") ? OutMode::Speakers : OutMode::Binaural;
  cfg.layout = juce::String(str("layout", "stereo"));
  if (o.Has("patch") && o.Get("patch").IsArray()) {
    auto a = o.Get("patch").As<Napi::Array>();
    for (uint32_t i = 0; i < a.Length(); ++i)
      cfg.patch.push_back(a.Get(i).IsNumber() ? a.Get(i).As<Napi::Number>().Int32Value() : (int) i);
  }

  Engine::OpenedCfg got;
  juce::String err = ensureEngine().configure(cfg, got);
  if (err.isNotEmpty()) { Napi::Error::New(env, ("audio configure failed: " + err).toStdString()).ThrowAsJavaScriptException(); return env.Null(); }

  auto r = Napi::Object::New(env);
  r.Set("deviceName", Napi::String::New(env, got.deviceName.toStdString()));
  r.Set("deviceType", Napi::String::New(env, got.deviceType.toStdString()));
  r.Set("sampleRate", Napi::Number::New(env, got.sampleRate));
  r.Set("bufferSize", Napi::Number::New(env, got.bufferSize));
  r.Set("channels", Napi::Number::New(env, got.channels));
  return r;
}

// getDevices() → [{ type, name, isDefault }]. One physical device appears once PER DRIVER TYPE — that is
// the point, not a bug: the type is what decides whether you get discrete multichannel.
static Napi::Value GetDevices(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const auto devs = ensureEngine().listOutputDevices();
  auto arr = Napi::Array::New(env, devs.size());
  for (size_t i = 0; i < devs.size(); ++i) {
    auto d = Napi::Object::New(env);
    d.Set("type", Napi::String::New(env, devs[i].type.toStdString()));
    d.Set("name", Napi::String::New(env, devs[i].name.toStdString()));
    d.Set("isDefault", Napi::Boolean::New(env, devs[i].isDefault));
    arr.Set((uint32_t) i, d);
  }
  return arr;
}

static Napi::Value LoadClip(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "loadClip(id, path)").ThrowAsJavaScriptException(); return env.Null();
  }
  const std::string id = info[0].As<Napi::String>().Utf8Value();
  const juce::String path = info[1].As<Napi::String>().Utf8Value();
  Clip* clip = nullptr; juce::String err;
  if (!ensureEngine().loadClip(id, path, clip, err)) {
    Napi::Error::New(env, err.toStdString()).ThrowAsJavaScriptException(); return env.Null();
  }
  auto obj = Napi::Object::New(env);
  obj.Set("durationSec", Napi::Number::New(env, clip->lengthSec));
  obj.Set("channels", Napi::Number::New(env, clip->channels));
  obj.Set("sampleRate", Napi::Number::New(env, clip->sampleRate));
  return obj;
}

static Napi::Value UnloadClip(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsString()) ensureEngine().unloadClip(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

static Napi::Value PlayClip(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsString()) {
    const std::string id = info[0].As<Napi::String>().Utf8Value();
    const double seek = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : 0.0;
    const float gain = info.Length() > 2 && info[2].IsNumber() ? (float) info[2].As<Napi::Number>().DoubleValue() : 1.0f;
    ensureEngine().playClip(id, seek, gain);
  }
  return info.Env().Undefined();
}

static Napi::Value StopClip(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsString()) ensureEngine().stopClip(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

static Napi::Value SetClipGain(const Napi::CallbackInfo& info) {
  if (info.Length() > 1 && info[0].IsString() && info[1].IsNumber())
    ensureEngine().setClipGain(info[0].As<Napi::String>().Utf8Value(), (float) info[1].As<Napi::Number>().DoubleValue());
  return info.Env().Undefined();
}

// setClipSpatial(id, x, y, z) — listener at origin, +x right, +y up, +z forward (metres).
static Napi::Value SetClipSpatial(const Napi::CallbackInfo& info) {
  if (info.Length() > 3 && info[0].IsString() && info[1].IsNumber() && info[2].IsNumber() && info[3].IsNumber()) {
    ensureEngine().setClipSpatial(
      info[0].As<Napi::String>().Utf8Value(),
      (float) info[1].As<Napi::Number>().DoubleValue(),
      (float) info[2].As<Napi::Number>().DoubleValue(),
      (float) info[3].As<Napi::Number>().DoubleValue());
  }
  return info.Env().Undefined();
}

static Napi::Value ClearClipSpatial(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsString()) ensureEngine().clearClipSpatial(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

// [{ id, type, bypass?, params?: {k: number}, opts?: {k: string} }] → std::vector<EffectSpec>.
// Runs on the JS thread, so allocating is fine. Deliberately TOLERANT: these arrive over a
// fire-and-forget IPC send, which has nobody to reject to — a malformed node is skipped, a malformed
// param is dropped, and the effect's own setParams() clamps whatever survives. Throwing here would
// take down an audio edit; being lenient just means a bad effect does nothing.
static std::vector<EffectSpec> parseEffects(const Napi::Value& v) {
  std::vector<EffectSpec> out;
  if (!v.IsArray()) return out;
  auto arr = v.As<Napi::Array>();
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    Napi::Value ev = arr.Get(i);
    if (!ev.IsObject()) continue;
    auto obj = ev.As<Napi::Object>();
    Napi::Value tv = obj.Get("type");
    if (!tv.IsString()) continue;
    EffectSpec s;
    s.type = tv.As<Napi::String>().Utf8Value();
    Napi::Value idv = obj.Get("id");
    s.id = idv.IsString() ? idv.As<Napi::String>().Utf8Value() : s.type;
    Napi::Value bv = obj.Get("bypass");
    s.bypass = bv.IsBoolean() && bv.As<Napi::Boolean>().Value();
    Napi::Value pv = obj.Get("params");
    if (pv.IsObject()) {
      auto po = pv.As<Napi::Object>();
      auto keys = po.GetPropertyNames();
      for (uint32_t k = 0; k < keys.Length(); ++k) {
        auto key = keys.Get(k).As<Napi::String>().Utf8Value();
        Napi::Value val = po.Get(key);
        if (val.IsNumber()) s.params[key] = (float) val.As<Napi::Number>().DoubleValue();
      }
    }
    Napi::Value ov = obj.Get("opts");
    if (ov.IsObject()) {
      auto oo = ov.As<Napi::Object>();
      auto keys = oo.GetPropertyNames();
      for (uint32_t k = 0; k < keys.Length(); ++k) {
        auto key = keys.Get(k).As<Napi::String>().Utf8Value();
        Napi::Value val = oo.Get(key);
        if (val.IsString()) s.opts[key] = val.As<Napi::String>().Utf8Value();
      }
    }
    out.push_back(std::move(s));
  }
  return out;
}

// setClipEffects(id, effects[]) — the insert chain on one source, applied before it is spatialised.
static Napi::Value SetClipEffects(const Napi::CallbackInfo& info) {
  if (info.Length() > 1 && info[0].IsString())
    ensureEngine().setClipEffects(info[0].As<Napi::String>().Utf8Value(), parseEffects(info[1]));
  return info.Env().Undefined();
}

// setMasterEffects(effects[]) — on the decoded N-channel output. 'reverb' nodes are DROPPED here:
// juce::dsp::Reverb is a <=2 channel processor and would silently pass dry on a multichannel decode.
static Napi::Value SetMasterEffects(const Napi::CallbackInfo& info) {
  if (info.Length() > 0) ensureEngine().setMasterEffects(parseEffects(info[0]));
  return info.Env().Undefined();
}

static Napi::Value SetMasterGain(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsNumber())
    ensureEngine().setMasterGain((float) info[0].As<Napi::Number>().DoubleValue());
  return info.Env().Undefined();
}

// setTestTone(deviceChannel, gain) — deviceChannel < 0 turns it off. Pink noise, straight onto a DEVICE
// CHANNEL, bypassing the decoder and the master fader (see Bus::setTestTone).
static Napi::Value SetTestTone(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const int ch = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Int32Value() : -1;
  const double g = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : 0.5;
  ensureEngine().setTestTone(ch, (float) g);
  return env.Undefined();
}

static Napi::Value StopAll(const Napi::CallbackInfo& info) { ensureEngine().stopAll(); return info.Env().Undefined(); }

static Napi::Value GetMeters(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  auto& e = ensureEngine();
  auto obj = Napi::Object::New(env);
  obj.Set("peak", Napi::Number::New(env, e.peak()));
  obj.Set("rms", Napi::Number::New(env, e.rms()));
  obj.Set("peakL", Napi::Number::New(env, e.chPeak(0)));
  obj.Set("peakR", Napi::Number::New(env, e.chPeak(1)));
  auto arr = Napi::Array::New(env, (size_t) kMaxMeterCh);
  for (int i = 0; i < kMaxMeterCh; ++i) arr.Set((uint32_t) i, Napi::Number::New(env, e.chPeak(i)));
  obj.Set("peaks", arr);                                              // per-channel (speaker) peaks
  obj.Set("speakers", Napi::Number::New(env, e.speakerCount()));      // 0 unless decoding to speakers
  // Diagnostics: an effect chain built for a different channel count than the audio thread actually sees
  // passes DRY — the worst kind of failure, since it looks wired and meters normally. Expose both numbers
  // so a mismatch is measurable (masterFxChannels is 0 when there is no master chain).
  obj.Set("masterFxChannels", Napi::Number::New(env, e.masterFxChannels()));
  obj.Set("deviceChannels", Napi::Number::New(env, e.deviceChannels()));
  obj.Set("clipped", Napi::Boolean::New(env, e.takeClipped())); // latched since the last poll, then cleared
  // IS THERE STILL A DEVICE. Rides this poll (already 10 Hz, already across IPC) rather than opening a new
  // channel — and it is a DIFFERENT QUESTION from `audio:available`, which reports only that the .node
  // loaded. The addon stays loaded when the interface is unplugged; the sound does not. See Engine::deviceLive.
  obj.Set("deviceLive", Napi::Boolean::New(env, e.deviceLive()));
  return obj;
}

static Napi::Value Close(const Napi::CallbackInfo& info) {
  if (gEngine) { gEngine->closeDevice(); gEngine.reset(); }
  return info.Env().Undefined();
}

// Diagnostic: libspatialaudio links and its chain runs (encode → B-format → binaural, MIT HRTF).
static Napi::Value SpatialProbe(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const unsigned sampleRate = 48000, block = 512;
  spaudio::AmbisonicEncoder enc;
  const bool encOk = enc.Configure(kAmbiOrder, true, sampleRate, 0.0f);
  enc.SetPosition(spaudio::PolarPosition<float>{ 1.5708f, 0.0f, 1.0f }); // 90 deg left
  enc.Refresh();
  spaudio::BFormat bf;
  const bool bfOk = bf.Configure(kAmbiOrder, true, block);
  spaudio::AmbisonicBinauralizer bin;
  unsigned tailLength = 0;
  const bool binOk = bin.Configure(kAmbiOrder, true, sampleRate, block, tailLength);

  std::vector<float> mono(block, 0.25f), left(block, 0.0f), right(block, 0.0f);
  float* out[2] = { left.data(), right.data() };
  bool ran = false;
  if (encOk && bfOk && binOk) {
    bf.Reset();
    enc.Process(mono.data(), block, &bf);
    bin.Process(&bf, out, block);
    ran = true;
  }
  float peak = 0.0f;
  for (unsigned i = 0; i < block; ++i) peak = juce::jmax(peak, std::abs(left[i]), std::abs(right[i]));

  auto obj = Napi::Object::New(env);
  obj.Set("encoder", Napi::Boolean::New(env, encOk));
  obj.Set("bformat", Napi::Boolean::New(env, bfOk));
  obj.Set("binauralizer", Napi::Boolean::New(env, binOk));
  obj.Set("ran", Napi::Boolean::New(env, ran));
  obj.Set("tailLength", Napi::Number::New(env, tailLength));
  obj.Set("outPeak", Napi::Number::New(env, peak));
  return obj;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  juce::MessageManager::getInstance(); // Windows device backends expect a message manager to exist
  exports.Set("juceVersion", Napi::Function::New(env, JuceVersion));
  exports.Set("configure", Napi::Function::New(env, Configure));
  exports.Set("getDevices", Napi::Function::New(env, GetDevices));
  exports.Set("loadClip", Napi::Function::New(env, LoadClip));
  exports.Set("unloadClip", Napi::Function::New(env, UnloadClip));
  exports.Set("playClip", Napi::Function::New(env, PlayClip));
  exports.Set("stopClip", Napi::Function::New(env, StopClip));
  exports.Set("setClipGain", Napi::Function::New(env, SetClipGain));
  exports.Set("setClipSpatial", Napi::Function::New(env, SetClipSpatial));
  exports.Set("clearClipSpatial", Napi::Function::New(env, ClearClipSpatial));
  exports.Set("setClipEffects", Napi::Function::New(env, SetClipEffects));
  exports.Set("setMasterEffects", Napi::Function::New(env, SetMasterEffects));
  exports.Set("setMasterGain", Napi::Function::New(env, SetMasterGain));
  exports.Set("setTestTone", Napi::Function::New(env, SetTestTone));
  exports.Set("stopAll", Napi::Function::New(env, StopAll));
  exports.Set("getMeters", Napi::Function::New(env, GetMeters));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("spatialProbe", Napi::Function::New(env, SpatialProbe));
  return exports;
}

NODE_API_MODULE(audio_engine, Init)
