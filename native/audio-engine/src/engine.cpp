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
        const int m = juce::jmin(nSpeakers, outCh); // never write past the device's channels
        for (int s = 0; s < m; ++s)
          info.buffer->addFrom(s, info.startSample, speakerBuf[(size_t) s].data(), n);
      }
    }

    // ── Master: post-decode, PRE-metering (so the meters show what actually leaves the machine) ──
    juce::dsp::AudioBlock<float> full(*info.buffer);
    auto mblock = full.getSubBlock((size_t) info.startSample, (size_t) n);
    if (masterChain != nullptr) masterChain->process(mblock);
    juce::dsp::ProcessContextReplacing<float> mctx(mblock);
    masterGain.process(mctx); // post-insert fader, SmoothedValue-ramped ⇒ click-free
  }

  // ── Control (all take the lock, so they can't race the audio thread) ──────────────────────────
  void addClip(const std::string& id, std::unique_ptr<Clip> clip) {
    const juce::ScopedLock sl(lock);
    if (prepared) clip->transport->prepareToPlay(maxBlock, sampleRate);
    clips[id] = std::move(clip);
  }
  void removeClip(const std::string& id) {
    const juce::ScopedLock sl(lock);
    auto it = clips.find(id);
    if (it == clips.end()) return;
    it->second->transport->stop();
    it->second->transport->setSource(nullptr);
    clips.erase(it);
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
    const juce::ScopedLock sl(lock);
    for (auto& kv : clips) kv.second->transport->stop();
  }
  void clear() {
    const juce::ScopedLock sl(lock);
    for (auto& kv : clips) { kv.second->transport->stop(); kv.second->transport->setSource(nullptr); }
    clips.clear();
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
                      std::array<std::atomic<float>, kMaxMeterCh>& chPeaks)
    : src(s), peakOut(peak), rmsOut(rms), chOut(chPeaks) {}
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
  }
private:
  juce::AudioSource& src;
  std::atomic<float>& peakOut;
  std::atomic<float>& rmsOut;
  std::array<std::atomic<float>, kMaxMeterCh>& chOut;
};

class Engine {
public:
  Engine() : metering(bus, meterPeak, meterRms, meterCh) {}
  ~Engine() { closeDevice(); }

  juce::String configure(int outputChannels, OutMode mode, const juce::String& layout) {
    // Decode mode/layout is applied live (decoder-only) — changing it never reopens the device.
    bus.setMode(mode, layout);
    const int ch = juce::jlimit(1, 64, outputChannels);
    if (opened && ch == openedChannels) return {}; // already open on this config — don't interrupt playback
    if (opened) { deviceManager.removeAudioCallback(&player); player.setSource(nullptr); deviceManager.closeAudioDevice(); opened = false; }
    juce::String err = deviceManager.initialiseWithDefaultDevices(0, ch);
    if (err.isNotEmpty()) return err;
    // The device can open with FEWER channels than we asked for (8 on a stereo card gives 2). The master
    // chain must be built for what we actually got, or it would see a channel-count mismatch every block
    // and pass dry. Push it BEFORE addAudioCallback — that's what triggers prepareToPlay, which builds it.
    int actual = ch;
    if (auto* dev = deviceManager.getCurrentAudioDevice())
      actual = juce::jmax(1, dev->getActiveOutputChannels().countNumberOfSetBits());
    bus.setOutputChannels(actual);
    if (!readThread.isThreadRunning()) readThread.startThread();
    player.setSource(&metering);
    deviceManager.addAudioCallback(&player);
    opened = true;
    openedChannels = ch;
    return {};
  }

  juce::String currentDeviceName() {
    if (auto* dev = deviceManager.getCurrentAudioDevice()) return dev->getName();
    return {};
  }

  juce::StringArray listOutputDevices() {
    juce::StringArray names;
    juce::OwnedArray<juce::AudioIODeviceType> types;
    deviceManager.createAudioDeviceTypes(types);
    for (auto* t : types) { t->scanForDevices(); names.addArray(t->getDeviceNames(false)); }
    names.removeDuplicates(false);
    return names;
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

  void playClip(const std::string& id, double seekSec, float gain) {
    const juce::ScopedLock sl(bus.lock);
    if (Clip* c = bus.find(id)) {
      c->transport->setGain(gain);
      c->transport->setPosition(juce::jmax(0.0, seekSec));
      c->transport->start();
    }
  }
  void stopClip(const std::string& id) {
    const juce::ScopedLock sl(bus.lock);
    if (Clip* c = bus.find(id)) c->transport->stop();
  }
  void setClipGain(const std::string& id, float gain) {
    const juce::ScopedLock sl(bus.lock);
    if (Clip* c = bus.find(id)) c->transport->setGain(gain);
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
  void stopAll() { bus.stopAll(); }

  float peak() const { return meterPeak.load(); }
  float rms() const { return meterRms.load(); }
  float chPeak(int i) const { return (i >= 0 && i < kMaxMeterCh) ? meterCh[(size_t) i].load() : 0.0f; }
  int speakerCount() { return bus.speakerCount(); }
  int masterFxChannels() { return bus.masterChainChannels(); }
  int deviceChannels() const { return bus.observedChannels(); }

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
  MeteringAudioSource metering;                 // declared after bus + meters
  juce::TimeSliceThread readThread { "artlux-audio-read" };
  bool opened = false;
  int openedChannels = 0;
};

std::unique_ptr<Engine> gEngine;
Engine& ensureEngine() { if (!gEngine) gEngine = std::make_unique<Engine>(); return *gEngine; }

} // namespace

// ── N-API surface ───────────────────────────────────────────────────────────────────────────────
static Napi::String JuceVersion(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), juce::SystemStats::getJUCEVersion().toStdString());
}

// configure(outputChannels, mode?, layout?) — mode: 'binaural' (default, headphones) | 'speakers'.
// layout (speakers mode): stereo | quad | 5.0 | 5.1 | 7.0 | 7.1 | hexagon | octagon | cube.
static Napi::Value Configure(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const int outCh = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Int32Value() : 2;
  const std::string modeStr = info.Length() > 1 && info[1].IsString() ? info[1].As<Napi::String>().Utf8Value() : "binaural";
  const std::string layout = info.Length() > 2 && info[2].IsString() ? info[2].As<Napi::String>().Utf8Value() : "stereo";
  const OutMode mode = (modeStr == "speakers") ? OutMode::Speakers : OutMode::Binaural;
  juce::String err = ensureEngine().configure(outCh, mode, juce::String(layout));
  if (err.isNotEmpty()) { Napi::Error::New(env, ("audio configure failed: " + err).toStdString()).ThrowAsJavaScriptException(); return env.Null(); }
  return Napi::String::New(env, ensureEngine().currentDeviceName().toStdString());
}

static Napi::Value GetDevices(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const auto names = ensureEngine().listOutputDevices();
  auto arr = Napi::Array::New(env, (size_t) names.size());
  for (int i = 0; i < names.size(); ++i) arr.Set((uint32_t) i, Napi::String::New(env, names[i].toStdString()));
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
  exports.Set("stopAll", Napi::Function::New(env, StopAll));
  exports.Set("getMeters", Napi::Function::New(env, GetMeters));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("spatialProbe", Napi::Function::New(env, SpatialProbe));
  return exports;
}

NODE_API_MODULE(audio_engine, Init)
