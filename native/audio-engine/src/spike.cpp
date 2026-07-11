// P0c — real device I/O. Opens the default output device via JUCE and streams audio on JUCE's
// audio thread. Two proofs: a synthesised sine tone (no asset) and file playback (AudioFormatManager
// decode of a WAV). If sound comes out of Electron 42, the native-audio gate is passed.
#include <napi.h>
#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <cmath>
#include <memory>

// ── A sine-tone source that runs on JUCE's realtime audio thread ────────────────────────────────
class ToneCallback : public juce::AudioIODeviceCallback {
public:
  std::atomic<double> freq { 440.0 };
  std::atomic<float>  amp  { 0.20f };

  void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
    sampleRate = device->getCurrentSampleRate();
    phase = 0.0;
  }
  void audioDeviceStopped() override {}

  void audioDeviceIOCallbackWithContext(const float* const*, int,
                                        float* const* out, int numOut, int numSamples,
                                        const juce::AudioIODeviceCallbackContext&) override {
    const double f = freq.load();
    const float  a = amp.load();
    const double inc = juce::MathConstants<double>::twoPi * f / sampleRate;
    for (int i = 0; i < numSamples; ++i) {
      const float s = static_cast<float>(std::sin(phase)) * a;
      phase += inc;
      if (phase > juce::MathConstants<double>::twoPi) phase -= juce::MathConstants<double>::twoPi;
      for (int ch = 0; ch < numOut; ++ch)
        if (out[ch] != nullptr) out[ch][i] = s;
    }
  }
private:
  double sampleRate = 48000.0;
  double phase = 0.0;
};

// ── Persistent engine state (survives across JS calls) ──────────────────────────────────────────
static std::unique_ptr<juce::AudioDeviceManager>      gDeviceManager;
static std::unique_ptr<ToneCallback>                  gTone;
static std::unique_ptr<juce::AudioSourcePlayer>       gPlayer;
static std::unique_ptr<juce::AudioTransportSource>    gTransport;
static std::unique_ptr<juce::AudioFormatReaderSource> gReaderSource;
static juce::AudioFormatManager                       gFormatManager;

static bool ensureDevice(juce::String& err) {
  if (gDeviceManager) return true;
  gDeviceManager = std::make_unique<juce::AudioDeviceManager>();
  err = gDeviceManager->initialiseWithDefaultDevices(0, 2);
  if (err.isNotEmpty()) { gDeviceManager.reset(); return false; }
  return true;
}

static Napi::Value StartTone(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  const double freq = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().DoubleValue() : 440.0;
  juce::String err;
  if (!ensureDevice(err)) {
    Napi::Error::New(env, ("device init failed: " + err).toStdString()).ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!gTone) gTone = std::make_unique<ToneCallback>();
  gTone->freq = freq;
  gDeviceManager->addAudioCallback(gTone.get());
  juce::String name = "unknown";
  if (auto* dev = gDeviceManager->getCurrentAudioDevice()) name = dev->getName();
  return Napi::String::New(env, name.toStdString());
}

static Napi::Value StopTone(const Napi::CallbackInfo& info) {
  if (gDeviceManager && gTone) gDeviceManager->removeAudioCallback(gTone.get());
  return info.Env().Undefined();
}

// Play a WAV/AIFF file through the transport (proves AudioFormatManager decode + device streaming).
static Napi::Value PlayFile(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "playFile(path) requires a string").ThrowAsJavaScriptException();
    return env.Null();
  }
  const juce::String path = info[0].As<Napi::String>().Utf8Value();
  juce::String err;
  if (!ensureDevice(err)) {
    Napi::Error::New(env, ("device init failed: " + err).toStdString()).ThrowAsJavaScriptException();
    return env.Null();
  }
  if (gFormatManager.getNumKnownFormats() == 0) gFormatManager.registerBasicFormats();

  juce::File file(path);
  auto* reader = gFormatManager.createReaderFor(file);
  if (reader == nullptr) {
    Napi::Error::New(env, ("no reader for " + path).toStdString()).ThrowAsJavaScriptException();
    return env.Null();
  }
  const double srcRate = reader->sampleRate;
  gReaderSource = std::make_unique<juce::AudioFormatReaderSource>(reader, true); // owns reader
  gTransport = std::make_unique<juce::AudioTransportSource>();
  gTransport->setSource(gReaderSource.get(), 0, nullptr, srcRate);
  gPlayer = std::make_unique<juce::AudioSourcePlayer>();
  gPlayer->setSource(gTransport.get());
  gDeviceManager->addAudioCallback(gPlayer.get());
  gTransport->setPosition(0.0);
  gTransport->start();
  return Napi::Number::New(env, gTransport->getLengthInSeconds());
}

static Napi::Value CloseEngine(const Napi::CallbackInfo& info) {
  if (gTransport) gTransport->stop();
  if (gDeviceManager) {
    if (gTone)   gDeviceManager->removeAudioCallback(gTone.get());
    if (gPlayer) gDeviceManager->removeAudioCallback(gPlayer.get());
    gDeviceManager->closeAudioDevice();
  }
  if (gPlayer) gPlayer->setSource(nullptr);
  if (gTransport) gTransport->setSource(nullptr);
  gPlayer.reset(); gTransport.reset(); gReaderSource.reset(); gTone.reset(); gDeviceManager.reset();
  return info.Env().Undefined();
}

static Napi::String JuceVersion(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), juce::SystemStats::getJUCEVersion().toStdString());
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  juce::MessageManager::getInstance(); // ensure a message manager exists (Windows device backends)
  exports.Set("juceVersion", Napi::Function::New(env, JuceVersion));
  exports.Set("startTone", Napi::Function::New(env, StartTone));
  exports.Set("stopTone", Napi::Function::New(env, StopTone));
  exports.Set("playFile", Napi::Function::New(env, PlayFile));
  exports.Set("close", Napi::Function::New(env, CloseEngine));
  return exports;
}

NODE_API_MODULE(audio_engine, Init)
