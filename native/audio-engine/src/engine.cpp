// ArtLux native audio engine (Wave 3). JUCE playback + libspatialaudio ambisonic spatialisation.
//
// Signal chain:
//   spatial clips → downmix → AmbisonicEncoder(position) → ProcessAccumul ↘
//                                                                     B-format → Binauralizer(HRTF) ↘
//   non-spatial clips ────────────────────────────────────────────────────────────────────────────→ (+)
//                                                        → MeteringAudioSource → AudioSourcePlayer → device
//
// A plain MixerAudioSource can't be used for the spatial path: ambisonic encoding needs each source's
// signal SEPARATELY (a mixer has already summed them), so SpatialBus pulls every clip itself.
//
// The engine is "dumb": JS (the plugins/audio playhead-driver) decides which bed clips are active for
// the current transport playhead and calls playClip/stopClip/gain/spatial. Disk reads happen on a shared
// read-ahead thread, never on the audio callback.
#include <napi.h>
#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

// libspatialaudio — ambisonic encode (per source position) → B-format → binaural decode (built-in MIT
// HRTF, no SOFA file needed). Namespace `spaudio`.
#include <AmbisonicEncoder.h>
#include <AmbisonicBinauralizer.h>
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

struct Clip {
  std::unique_ptr<juce::AudioFormatReaderSource> reader;
  std::unique_ptr<juce::AudioTransportSource> transport;
  double sampleRate = 0.0;
  double lengthSec = 0.0;
  int channels = 0;
  bool spatial = false;
  std::unique_ptr<spaudio::AmbisonicEncoder> encoder;   // only when spatial
  spaudio::PolarPosition<float> pos {};
};

// Pulls every clip, encodes the spatial ones into one shared B-format, binaurally decodes that, and
// sums the non-spatial ones straight through. `lock` is held by the AUDIO thread for the whole block
// (the same discipline JUCE's own MixerAudioSource uses), so control calls that mutate clips/encoders
// are safe as long as they take it too.
class SpatialBus : public juce::AudioSource {
public:
  juce::CriticalSection lock;
  std::unordered_map<std::string, std::unique_ptr<Clip>> clips;

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
    for (auto& kv : clips) {
      kv.second->transport->prepareToPlay(blockSize, sr);
      if (kv.second->spatial) configureEncoder(*kv.second);
    }
  }

  void releaseResources() override {
    const juce::ScopedLock sl(lock);
    prepared = false;
    for (auto& kv : clips) kv.second->transport->releaseResources();
  }

  void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override {
    info.clearActiveBufferRegion();
    const int n = info.numSamples;
    if (n <= 0 || info.buffer == nullptr) return;

    const juce::ScopedLock sl(lock);
    const int outCh = info.buffer->getNumChannels();
    bool anySpatial = false;
    bformat.Reset();

    for (auto& kv : clips) {
      Clip& c = *kv.second;
      scratch.clear();
      juce::AudioSourceChannelInfo si(&scratch, 0, n);
      c.transport->getNextAudioBlock(si); // silent while stopped — cheap

      if (c.spatial && c.encoder != nullptr) {
        // Ambisonic encoding is inherently mono-per-source: fold the clip down, then place it.
        const float* l = scratch.getReadPointer(0);
        const float* r = scratch.getNumChannels() > 1 ? scratch.getReadPointer(1) : l;
        for (int i = 0; i < n; ++i) mono[(size_t) i] = 0.5f * (l[i] + r[i]);
        c.encoder->ProcessAccumul(mono.data(), (unsigned) n, &bformat, 0, 1.0f);
        anySpatial = true;
      } else {
        for (int ch = 0; ch < outCh; ++ch) {
          const int src = juce::jmin(ch, scratch.getNumChannels() - 1);
          info.buffer->addFrom(ch, info.startSample, scratch, src, 0, n);
        }
      }
    }

    if (anySpatial && binauralOk) {
      std::fill(decodeL.begin(), decodeL.begin() + n, 0.0f);
      std::fill(decodeR.begin(), decodeR.begin() + n, 0.0f);
      float* out[2] = { decodeL.data(), decodeR.data() };
      binaural.Process(&bformat, out, (unsigned) n);
      if (outCh > 0) info.buffer->addFrom(0, info.startSample, decodeL.data(), n);
      if (outCh > 1) info.buffer->addFrom(1, info.startSample, decodeR.data(), n);
    }
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

  bool prepared = false;
  int maxBlock = 512;
  juce::AudioBuffer<float> scratch;
  std::vector<float> mono, decodeL, decodeR;
  spaudio::BFormat bformat;
  spaudio::AmbisonicBinauralizer binaural;
  bool binauralOk = false;
};

// Taps the mixed output for the UI meters. Per-channel peaks are what prove spatialisation is doing
// something (a hard-left source must give peakL >> peakR — a flipped azimuth shows up here immediately).
class MeteringAudioSource : public juce::AudioSource {
public:
  MeteringAudioSource(juce::AudioSource& s, std::atomic<float>& peak, std::atomic<float>& rms,
                      std::atomic<float>& pL, std::atomic<float>& pR)
    : src(s), peakOut(peak), rmsOut(rms), peakLOut(pL), peakROut(pR) {}
  void prepareToPlay(int n, double sr) override { src.prepareToPlay(n, sr); }
  void releaseResources() override { src.releaseResources(); }
  void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override {
    src.getNextAudioBlock(info);
    float peak = 0.0f, sumSq = 0.0f, pL = 0.0f, pR = 0.0f;
    int count = 0;
    if (info.buffer != nullptr) {
      for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch) {
        const float* d = info.buffer->getReadPointer(ch, info.startSample);
        float chPeak = 0.0f;
        for (int i = 0; i < info.numSamples; ++i) {
          const float a = std::abs(d[i]);
          chPeak = juce::jmax(chPeak, a);
          sumSq += d[i] * d[i];
          ++count;
        }
        peak = juce::jmax(peak, chPeak);
        if (ch == 0) pL = chPeak;
        if (ch == 1) pR = chPeak;
      }
    }
    peakOut.store(peak);
    rmsOut.store(count > 0 ? std::sqrt(sumSq / (float) count) : 0.0f);
    peakLOut.store(pL);
    peakROut.store(pR);
  }
private:
  juce::AudioSource& src;
  std::atomic<float>& peakOut;
  std::atomic<float>& rmsOut;
  std::atomic<float>& peakLOut;
  std::atomic<float>& peakROut;
};

class Engine {
public:
  Engine() : metering(bus, meterPeak, meterRms, meterPeakL, meterPeakR) {}
  ~Engine() { closeDevice(); }

  juce::String configure(int outputChannels) {
    const int ch = juce::jlimit(1, 64, outputChannels);
    if (opened && ch == openedChannels) return {}; // already open on this config — don't interrupt playback
    if (opened) { deviceManager.removeAudioCallback(&player); player.setSource(nullptr); deviceManager.closeAudioDevice(); opened = false; }
    juce::String err = deviceManager.initialiseWithDefaultDevices(0, ch);
    if (err.isNotEmpty()) return err;
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
  void setClipSpatial(const std::string& id, float x, float y, float z) { bus.setSpatial(id, x, y, z); }
  void clearClipSpatial(const std::string& id) { bus.clearSpatial(id); }
  void stopAll() { bus.stopAll(); }

  float peak() const { return meterPeak.load(); }
  float rms() const { return meterRms.load(); }
  float peakL() const { return meterPeakL.load(); }
  float peakR() const { return meterPeakR.load(); }

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
  std::atomic<float> meterPeakL { 0.0f };
  std::atomic<float> meterPeakR { 0.0f };
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

static Napi::Value Configure(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const int outCh = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Int32Value() : 2;
  juce::String err = ensureEngine().configure(outCh);
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

static Napi::Value StopAll(const Napi::CallbackInfo& info) { ensureEngine().stopAll(); return info.Env().Undefined(); }

static Napi::Value GetMeters(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  auto& e = ensureEngine();
  auto obj = Napi::Object::New(env);
  obj.Set("peak", Napi::Number::New(env, e.peak()));
  obj.Set("rms", Napi::Number::New(env, e.rms()));
  obj.Set("peakL", Napi::Number::New(env, e.peakL()));
  obj.Set("peakR", Napi::Number::New(env, e.peakR()));
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
  exports.Set("stopAll", Napi::Function::New(env, StopAll));
  exports.Set("getMeters", Napi::Function::New(env, GetMeters));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("spatialProbe", Napi::Function::New(env, SpatialProbe));
  return exports;
}

NODE_API_MODULE(audio_engine, Init)
