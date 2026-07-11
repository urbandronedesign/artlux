// ArtLux audio effect chains (Wave 3, P3) — juce_dsp inserts for clips and for the master output.
//
// WHERE A CHAIN MAY LIVE. A spatial source is a point in an ambisonic field, so it cannot be summed
// into a bus before it is placed — the encoder needs each source's signal on its own. So there are
// exactly two insert points, and the channel count differs between them:
//
//   clip, spatial      1 ch  (downmixed to mono FIRST, then processed, then encoded — see below)
//   clip, non-spatial  2 ch
//   master             N ch  (post-decode: 2 for binaural, up to 8 for a speaker layout)
//
// MONO-FIRST FOR SPATIAL CLIPS is not an optimisation, it's a correctness fix: a 2-channel dsp::Reverb
// deliberately DEcorrelates L and R, and the very next thing the engine does to a spatial clip is fold
// it to mono — which would comb-filter that decorrelated field against itself. Process the mono signal.
//
// THREADING. Every EffectChain::build()/prepare() ALLOCATES and must never run on the audio thread, nor
// while SpatialBus::lock is held (the audio thread holds that lock for the whole block, so allocating
// under it steals an audio block → an audible dropout on every effect edit). setParams()/process() are
// allocation-free and run under the lock. See SpatialBus::applyEffects for the build-outside/swap-inside
// dance. All N-API entry points share one thread, so specs can't be mutated concurrently.
#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>
#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace artlux {

// One authored effect node, exactly as it arrives from JS.
//
// `params` are CONTINUOUS (automatable/fadeable in P4/P5); `opts` are DISCRETE choices (filter mode).
// They are separate maps on purpose: the fade engine interpolates numbers, so a mode living in `params`
// would eventually be handed 0.37 by a scene transition.
struct EffectSpec {
  std::string id, type;
  bool bypass = false;
  std::map<std::string, float> params;
  std::map<std::string, std::string> opts;
};

inline float pnum(const EffectSpec& s, const char* k, float def) {
  const auto it = s.params.find(k);
  return (it == s.params.end() || !std::isfinite(it->second)) ? def : it->second;
}
inline std::string popt(const EffectSpec& s, const char* k, const char* def) {
  const auto it = s.opts.find(k);
  return it == s.opts.end() ? std::string(def) : it->second;
}

// STRUCTURAL identity: the ordered list of (type, id). Params, opts and bypass are NOT structural — they
// update in place. String compares only (no allocation), so this is safe to evaluate under the audio lock.
inline bool sameStructure(const std::vector<EffectSpec>& a, const std::vector<EffectSpec>& b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i)
    if (a[i].id != b[i].id || a[i].type != b[i].type) return false;
  return true;
}

class Effect {
public:
  virtual ~Effect() = default;
  virtual void prepare(const juce::dsp::ProcessSpec& spec) = 0; // ALLOCATES — never on the audio thread
  virtual void setParams(const EffectSpec& s) = 0;              // must NOT allocate — runs under the lock
  virtual void process(juce::dsp::AudioBlock<float>& b) noexcept = 0;
  bool bypass = false;
};

// ── gain ────────────────────────────────────────────────────────────────────────────────────────
// N-channel safe. The only genuinely click-free node here (SmoothedValue ramp).
class GainFx final : public Effect {
public:
  void prepare(const juce::dsp::ProcessSpec& s) override {
    g.prepare(s);
    // ONCE, here. setRampDurationSeconds() calls reset() and SNAPS the current value — calling it from
    // setParams would click on every edit.
    g.setRampDurationSeconds(0.02);
  }
  void setParams(const EffectSpec& s) override {
    g.setGainDecibels(juce::jlimit(-60.0f, 12.0f, pnum(s, "gainDb", 0.0f)));
  }
  void process(juce::dsp::AudioBlock<float>& b) noexcept override {
    juce::dsp::ProcessContextReplacing<float> c(b); // needs a NAMED lvalue block — it can't bind a temporary
    g.process(c);
  }
private:
  juce::dsp::Gain<float> g;
};

// ── filter ──────────────────────────────────────────────────────────────────────────────────────
// 12 dB/oct LP / HP / BP. N-channel safe. There is deliberately no peaking/shelving EQ here —
// StateVariableTPTFilter has no gain parameter, so don't promise one in the UI.
class FilterFx final : public Effect {
public:
  void prepare(const juce::dsp::ProcessSpec& s) override {
    sr = s.sampleRate;
    f.prepare(s);
  }
  void setParams(const EffectSpec& s) override {
    using T = juce::dsp::StateVariableTPTFilterType;
    const auto m = popt(s, "mode", "lowpass");
    f.setType(m == "highpass" ? T::highpass : m == "bandpass" ? T::bandpass : T::lowpass);
    // setCutoffFrequency asserts the value is below Nyquist — clamp well under it.
    f.setCutoffFrequency(juce::jlimit(20.0f, (float) (0.45 * sr), pnum(s, "cutoff", 1000.0f)));
    f.setResonance(juce::jlimit(0.1f, 10.0f, pnum(s, "resonance", 0.707f)));
  }
  void process(juce::dsp::AudioBlock<float>& b) noexcept override {
    juce::dsp::ProcessContextReplacing<float> c(b);
    f.process(c);
  }
private:
  juce::dsp::StateVariableTPTFilter<float> f;
  double sr = 48000.0;
};

// ── reverb ──────────────────────────────────────────────────────────────────────────────────────
// CLIP CHAIN ONLY, 1–2 CHANNELS ONLY. Above 2 channels juce::dsp::Reverb asserts in Debug and — far
// worse — SILENTLY PASSES THE DRY SIGNAL in Release. A master reverb on a 6-channel decode would look
// wired, meter identically, and do nothing. So it is refused at two levels: EffectChain::build drops
// the node on the master, and `legal` hard-bypasses it here if it ever sees >2 channels anyway.
// A proper master reverb in an ambisonic rig is a diffuse B-format reverb — a different design, later.
class ReverbFx final : public Effect {
public:
  void prepare(const juce::dsp::ProcessSpec& s) override {
    legal = (s.numChannels == 1 || s.numChannels == 2);
    if (legal) rv.prepare(s); // → juce::Reverb::setSampleRate() → HeapBlock allocation
  }
  void setParams(const EffectSpec& s) override {
    auto p = rv.getParameters(); // no per-field setters exist — read/modify/write the struct
    p.roomSize = juce::jlimit(0.0f, 1.0f, pnum(s, "roomSize", 0.5f));
    p.damping  = juce::jlimit(0.0f, 1.0f, pnum(s, "damping", 0.5f));
    p.wetLevel = juce::jlimit(0.0f, 1.0f, pnum(s, "wet", 0.33f));
    p.dryLevel = juce::jlimit(0.0f, 1.0f, pnum(s, "dry", 0.4f));
    p.width    = juce::jlimit(0.0f, 1.0f, pnum(s, "width", 1.0f));
    p.freezeMode = 0.0f; // not exposed: its write is unsmoothed and clicks
    rv.setParameters(p);
  }
  void process(juce::dsp::AudioBlock<float>& b) noexcept override {
    if (!legal) return;
    juce::dsp::ProcessContextReplacing<float> c(b);
    rv.process(c);
  }
private:
  juce::dsp::Reverb rv;
  bool legal = false;
};

// ── delay ───────────────────────────────────────────────────────────────────────────────────────
// juce::dsp::DelayLine is a PURE delay — no feedback, no wet/dry — so the loop is hand-rolled.
// A default-constructed DelayLine holds 2 SAMPLES: setMaximumDelayInSamples() is what actually sizes
// it, and it ALLOCATES + clears. It therefore runs once in prepare(), for the full 2 s maximum, so that
// any timeMs in range is a pure setDelay() on the audio thread (alloc-free by construction).
class DelayFx final : public Effect {
public:
  void prepare(const juce::dsp::ProcessSpec& s) override {
    sr = s.sampleRate;
    nch = s.numChannels;
    maxSamples = (float) std::ceil(kMaxSec * s.sampleRate);
    line.setMaximumDelayInSamples((int) maxSamples + 4); // allocates — before prepare(), off the audio thread
    line.prepare(s);
    timeSamples.reset(s.sampleRate, 0.05); // glide, so a time edit tape-slides instead of clicking
    first = true;
  }
  void setParams(const EffectSpec& s) override {
    const float t = juce::jmin(maxSamples,
      juce::jlimit(1.0f, kMaxSec * 1000.0f, pnum(s, "timeMs", 250.0f)) * 0.001f * (float) sr);
    if (first) { timeSamples.setCurrentAndTargetValue(t); first = false; }
    else       { timeSamples.setTargetValue(t); }
    fb  = juce::jlimit(0.0f, 0.95f, pnum(s, "feedback", 0.35f)); // hard cap — 1.0 is an unbounded runaway
    mix = juce::jlimit(0.0f, 1.0f, pnum(s, "mix", 0.3f));
  }
  void process(juce::dsp::AudioBlock<float>& b) noexcept override {
    const size_t n = b.getNumSamples();
    const size_t c = juce::jmin<size_t>(nch, b.getNumChannels(), kMaxCh);
    float* p[kMaxCh];
    for (size_t ch = 0; ch < c; ++ch) p[ch] = b.getChannelPointer(ch);
    for (size_t i = 0; i < n; ++i) {
      // The delay length is shared across channels, so set it ONCE per sample (outside the channel
      // loop) — every channel must read the same tap or they'd drift apart.
      line.setDelay(timeSamples.getNextValue());
      for (size_t ch = 0; ch < c; ++ch) {
        const float in = p[ch][i];
        const float wet = line.popSample((int) ch, -1.0f, true);
        line.pushSample((int) ch, in + fb * wet);
        p[ch][i] = in * (1.0f - mix) + wet * mix;
      }
    }
  }
private:
  static constexpr float kMaxSec = 2.0f;
  static constexpr size_t kMaxCh = 8;
  juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> line;
  juce::SmoothedValue<float> timeSamples;
  double sr = 48000.0;
  size_t nch = 0;
  float maxSamples = 0.0f, fb = 0.35f, mix = 0.3f;
  bool first = true;
};

// ── compressor ──────────────────────────────────────────────────────────────────────────────────
// Hand-rolled on juce::dsp::BallisticsFilter rather than juce::dsp::Compressor, because that one is
// MULTI-MONO: it runs an independent envelope per channel. On a 2-ch clip that shifts the stereo image
// on every transient; on an 8-channel ambisonic DECODE it pumps each speaker separately and smears the
// spatial image into mush — the one thing this whole subsystem exists to protect. So: ONE detector fed
// the max across channels, ONE gain applied to all of them. (It also gets us makeup gain, which
// juce::dsp::Compressor doesn't have.)
class CompFx final : public Effect {
public:
  void prepare(const juce::dsp::ProcessSpec& s) override {
    auto mono = s;
    mono.numChannels = 1; // the detector is a single-channel side-chain
    det.prepare(mono);
    det.setLevelCalculationType(juce::dsp::BallisticsFilterLevelCalculationType::peak);
  }
  void setParams(const EffectSpec& s) override {
    thr    = juce::jlimit(-60.0f, 0.0f, pnum(s, "thresholdDb", -18.0f));
    ratio  = juce::jlimit(1.0f, 20.0f, pnum(s, "ratio", 4.0f)); // JUCE asserts ratio >= 1
    makeup = juce::jlimit(0.0f, 24.0f, pnum(s, "makeupDb", 0.0f));
    det.setAttackTime(juce::jlimit(0.1f, 200.0f, pnum(s, "attackMs", 10.0f)));
    det.setReleaseTime(juce::jlimit(5.0f, 2000.0f, pnum(s, "releaseMs", 100.0f)));
  }
  void process(juce::dsp::AudioBlock<float>& b) noexcept override {
    const size_t n = b.getNumSamples();
    const size_t c = juce::jmin<size_t>(b.getNumChannels(), kMaxCh);
    float* p[kMaxCh];
    for (size_t ch = 0; ch < c; ++ch) p[ch] = b.getChannelPointer(ch);
    const float slope = 1.0f - 1.0f / ratio;
    for (size_t i = 0; i < n; ++i) {
      float m = 0.0f;
      for (size_t ch = 0; ch < c; ++ch) m = juce::jmax(m, std::abs(p[ch][i]));
      const float envDb = juce::Decibels::gainToDecibels(det.processSample(0, m), -100.0f);
      const float over = envDb - thr;
      const float g = juce::Decibels::decibelsToGain((over > 0.0f ? -over * slope : 0.0f) + makeup, -100.0f);
      for (size_t ch = 0; ch < c; ++ch) p[ch][i] *= g; // one gain, every channel — no image shift
    }
  }
private:
  static constexpr size_t kMaxCh = 8;
  juce::dsp::BallisticsFilter<float> det;
  float thr = -18.0f, ratio = 4.0f, makeup = 0.0f;
};

// ── the chain ───────────────────────────────────────────────────────────────────────────────────
class EffectChain {
public:
  // JS THREAD ONLY — allocates (nodes, the delay buffer, the reverb's HeapBlocks).
  static std::unique_ptr<EffectChain> build(const std::vector<EffectSpec>& specs,
                                            double sr, int maxBlock, int numCh, bool allowReverb) {
    auto chain = std::unique_ptr<EffectChain>(new EffectChain());
    chain->numChannels = numCh;
    chain->allowReverb = allowReverb;
    const juce::dsp::ProcessSpec spec {
      sr, (juce::uint32) juce::jmax(1, maxBlock), (juce::uint32) juce::jmax(1, numCh)
    };
    for (const auto& s : specs) {
      std::unique_ptr<Effect> fx;
      if      (s.type == "gain")       fx = std::make_unique<GainFx>();
      else if (s.type == "filter")     fx = std::make_unique<FilterFx>();
      else if (s.type == "delay")      fx = std::make_unique<DelayFx>();
      else if (s.type == "compressor") fx = std::make_unique<CompFx>();
      else if (s.type == "reverb" && allowReverb) fx = std::make_unique<ReverbFx>();
      else continue; // unknown type, or reverb on the master → the node simply doesn't exist
      fx->prepare(spec);
      fx->setParams(s);
      fx->bypass = s.bypass;
      chain->nodes.push_back(std::move(fx));
    }
    return chain;
  }

  // UNDER THE LOCK. Allocation-free: setters only, no reset, no click. Reached only when
  // sameStructure() held, so the specs map 1:1 onto the nodes — except for entries build() skipped.
  void updateParams(const std::vector<EffectSpec>& specs) {
    size_t i = 0;
    for (const auto& s : specs) {
      if (s.type == "reverb" && !allowReverb) continue; // never got a node
      if (i >= nodes.size()) break;
      nodes[i]->setParams(s);
      nodes[i]->bypass = s.bypass;
      ++i;
    }
  }

  void process(juce::dsp::AudioBlock<float>& b) noexcept { // AUDIO THREAD
    if (nodes.empty()) return;
    // A channel-count mismatch means a chain outlived the shape it was built for (e.g. a spatial toggle
    // that failed to rebuild). Degrade to dry rather than assert — but it is a bug, not a mode.
    if ((int) b.getNumChannels() != numChannels) return;
    for (auto& n : nodes) if (!n->bypass) n->process(b);
  }

  int channels() const noexcept { return numChannels; }

private:
  std::vector<std::unique_ptr<Effect>> nodes;
  int numChannels = 0;
  bool allowReverb = true;
};

} // namespace artlux
