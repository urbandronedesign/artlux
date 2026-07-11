// ArtLux native audio engine (Wave 3, P1). JUCE-backed stereo playback for the global audio bed.
//
// Signal chain:  clips (AudioTransportSource → AudioFormatReaderSource) → MixerAudioSource
//                → MeteringAudioSource → AudioSourcePlayer → AudioDeviceManager (device out).
//
// The engine is "dumb": JS (the plugins/audio playhead-driver) decides which bed clips are active
// for the current transport playhead and calls playClip/stopClip/seek/gain. Each clip owns a
// transport added to the mixer, so several play at once. Disk reads happen on a shared read-ahead
// thread (never the audio callback). Ambisonics / effects / spatialisation arrive in later phases.
#include <napi.h>
#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace {

juce::AudioFormatManager& formats() {
  static juce::AudioFormatManager fm;
  static bool inited = false;
  if (!inited) { fm.registerBasicFormats(); inited = true; } // wav/aiff + flac/ogg (build flags)
  return fm;
}

// Taps the mixed output to publish master peak/RMS for the UI meters. Pass-through otherwise.
class MeteringAudioSource : public juce::AudioSource {
public:
  MeteringAudioSource(juce::AudioSource& s, std::atomic<float>& peak, std::atomic<float>& rms)
    : src(s), peakOut(peak), rmsOut(rms) {}
  void prepareToPlay(int n, double sr) override { src.prepareToPlay(n, sr); }
  void releaseResources() override { src.releaseResources(); }
  void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override {
    src.getNextAudioBlock(info);
    float peak = 0.0f, sumSq = 0.0f; int count = 0;
    if (info.buffer != nullptr) {
      for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch) {
        const float* d = info.buffer->getReadPointer(ch, info.startSample);
        for (int i = 0; i < info.numSamples; ++i) { const float a = std::abs(d[i]); peak = juce::jmax(peak, a); sumSq += d[i] * d[i]; ++count; }
      }
    }
    peakOut.store(peak);
    rmsOut.store(count > 0 ? std::sqrt(sumSq / (float) count) : 0.0f);
  }
private:
  juce::AudioSource& src;
  std::atomic<float>& peakOut;
  std::atomic<float>& rmsOut;
};

struct Clip {
  std::unique_ptr<juce::AudioFormatReaderSource> reader;
  std::unique_ptr<juce::AudioTransportSource> transport;
  double sampleRate = 0.0;
  double lengthSec = 0.0;
  int channels = 0;
};

class Engine {
public:
  Engine() : metering(mixer, meterPeak, meterRms) {}
  ~Engine() { closeDevice(); }

  juce::String configure(int outputChannels) {
    const int ch = juce::jlimit(1, 64, outputChannels);
    if (opened && ch == openedChannels) return {}; // already open on this config — no-op, don't interrupt playback
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

    std::lock_guard<std::mutex> lock(mutex);
    if (auto it = clips.find(id); it != clips.end()) {
      mixer.removeInputSource(it->second->transport.get());
      it->second->transport->setSource(nullptr);
    }
    mixer.addInputSource(clip->transport.get(), false);
    out = clip.get();
    clips[id] = std::move(clip);
    return true;
  }

  void unloadClip(const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = clips.find(id); if (it == clips.end()) return;
    it->second->transport->stop();
    mixer.removeInputSource(it->second->transport.get());
    it->second->transport->setSource(nullptr);
    clips.erase(it);
  }

  void playClip(const std::string& id, double seekSec, float gain) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = clips.find(id); if (it == clips.end()) return;
    it->second->transport->setGain(gain);
    it->second->transport->setPosition(juce::jmax(0.0, seekSec));
    it->second->transport->start();
  }

  void stopClip(const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = clips.find(id); if (it == clips.end()) return;
    it->second->transport->stop();
  }

  void setClipGain(const std::string& id, float gain) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = clips.find(id); if (it == clips.end()) return;
    it->second->transport->setGain(gain);
  }

  void stopAll() {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto& kv : clips) kv.second->transport->stop();
  }

  float peak() const { return meterPeak.load(); }
  float rms() const { return meterRms.load(); }

  void closeDevice() {
    if (opened) { deviceManager.removeAudioCallback(&player); player.setSource(nullptr); deviceManager.closeAudioDevice(); opened = false; }
    { std::lock_guard<std::mutex> lock(mutex);
      for (auto& kv : clips) { kv.second->transport->stop(); mixer.removeInputSource(kv.second->transport.get()); kv.second->transport->setSource(nullptr); }
      clips.clear(); }
    if (readThread.isThreadRunning()) readThread.stopThread(2000);
  }

private:
  juce::AudioDeviceManager deviceManager;
  juce::AudioSourcePlayer player;
  juce::MixerAudioSource mixer;
  std::atomic<float> meterPeak { 0.0f };
  std::atomic<float> meterRms { 0.0f };
  MeteringAudioSource metering;                 // must be declared after mixer + meters
  juce::TimeSliceThread readThread { "artlux-audio-read" };
  std::unordered_map<std::string, std::unique_ptr<Clip>> clips;
  std::mutex mutex;
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

static Napi::Value StopAll(const Napi::CallbackInfo& info) { ensureEngine().stopAll(); return info.Env().Undefined(); }

static Napi::Value GetMeters(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  auto obj = Napi::Object::New(env);
  obj.Set("peak", Napi::Number::New(env, ensureEngine().peak()));
  obj.Set("rms", Napi::Number::New(env, ensureEngine().rms()));
  return obj;
}

static Napi::Value Close(const Napi::CallbackInfo& info) {
  if (gEngine) { gEngine->closeDevice(); gEngine.reset(); }
  return info.Env().Undefined();
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
  exports.Set("stopAll", Napi::Function::New(env, StopAll));
  exports.Set("getMeters", Napi::Function::New(env, GetMeters));
  exports.Set("close", Napi::Function::New(env, Close));
  return exports;
}

NODE_API_MODULE(audio_engine, Init)
