#include <napi.h>
#include "core.h"

// ── N-API surface ───────────────────────────────────────────────────────────────────────────────
//
// ⚠ THE ENGINE DOES NOT RUN ON THE JS THREAD (Windows). Every call that touches the Engine is POSTED, in
// call order, to ONE dedicated "audio control" thread, and the JS side gets a promise. That thread is
// also JUCE's MESSAGE THREAD: it creates the MessageManager and pumps window messages (an STA, like
// Electron's main thread), so whatever a driver or a JUCE device type posts to the message thread is
// dispatched there — serialised with every engine call, exactly as it was when everything ran on main.
//
// WHY. configure() opens the device, and a cold open of the default endpoint in WASAPI shared mode costs
// SECONDS (5.5 s measured on this rig's Realtek). It used to run synchronously on Electron main's JS
// thread, so for those seconds after every start-up main served NOTHING — no frame reached the DMX
// wire, no prefs read, no media byte, no tablet request (found by the native engine's handover test:
// main's event loop blocked ~7 s; plans/native-engine.md E1f-1). The same goes for a device scan, an
// offline render's detach/reattach, and a reconnect.
//
// Elsewhere (macOS, Linux) the calls run INLINE on the JS thread as before — same semantics, a promise
// that is already settled: on macOS JUCE's message thread must be the process's main thread, and the
// stall was measured on Windows.
//
// The pure-DSP helpers (juceVersion, analyseSamples, spatialProbe) touch no engine and stay synchronous.
// The control thread itself (namespace control) lives in core.h — the C API (capi.cpp) runs on it too.

static Napi::ThreadSafeFunction gTsfn;
// Calls awaiting an answer. The thread-safe function holds the event loop open ONLY while there are
// some: unref'd it could let Node exit under a pending configure; ref'd for good, it would keep a
// quitting process alive. Touched only on the JS thread.
static int gPending = 0;

// What a task hands back to the JS thread: build the JS value, settle the promise.
using Finish = std::function<void(Napi::Env, Napi::Promise::Deferred&)>;
struct Job { Napi::Promise::Deferred d; Finish finish; };

static Finish rejectWith(std::string msg) {
  return [msg = std::move(msg)](Napi::Env env, Napi::Promise::Deferred& d) { d.Reject(Napi::Error::New(env, msg).Value()); };
}

// Run `work` against the engine (on the control thread) and settle a promise with what it returns.
static Napi::Value runAsync(Napi::Env env, std::function<Finish()> work) {
  auto* job = new Job{ Napi::Promise::Deferred::New(env), nullptr };
  Napi::Promise p = job->d.Promise();
  auto run = [job, work = std::move(work)]() {
    try { job->finish = work(); }
    catch (const std::exception& e) { job->finish = rejectWith(std::string("audio engine: ") + e.what()); }
    catch (...) { job->finish = rejectWith("audio engine: unknown failure"); }
  };
#ifdef ARTLUX_AUDIO_CONTROL_THREAD
  if (gPending++ == 0) gTsfn.Ref(env);
  control::post([job, run]() {
    run();
    gTsfn.BlockingCall(job, [](Napi::Env env, Napi::Function, Job* j) {
      j->finish(env, j->d); delete j;
      if (--gPending == 0) gTsfn.Unref(env);
    });
  });
#else
  run();
  job->finish(env, job->d);
  delete job;
#endif
  return p;
}

// A fire-and-forget engine call (no answer), in order with every other call.
static void runVoid(std::function<void()> work) {
#ifdef ARTLUX_AUDIO_CONTROL_THREAD
  control::post(std::move(work));
#else
  work();
#endif
}

static Napi::String JuceVersion(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), juce::SystemStats::getJUCEVersion().toStdString());
}

// configure(cfg) → Promise<{ deviceName, deviceType, sampleRate, bufferSize, channels }> — the setup
// ACTUALLY OPENED, which can differ from what was asked (a stereo card asked for 8ch reports 2 back) and
// the UI must show what it GOT. Rejects with "audio configure failed: …".
// cfg: { deviceType?, deviceName?, channels?, sampleRate?, bufferSize?, mode?, layout?, patch? }
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
  return runAsync(env, [cfg]() -> Finish {
    Engine::OpenedCfg got;
    const juce::String err = ensureEngine().configure(cfg, got);
    if (err.isNotEmpty()) return rejectWith(("audio configure failed: " + err).toStdString());
    return [got](Napi::Env env, Napi::Promise::Deferred& d) {
      auto r = Napi::Object::New(env);
      r.Set("deviceName", Napi::String::New(env, got.deviceName.toStdString()));
      r.Set("deviceType", Napi::String::New(env, got.deviceType.toStdString()));
      r.Set("sampleRate", Napi::Number::New(env, got.sampleRate));
      r.Set("bufferSize", Napi::Number::New(env, got.bufferSize));
      r.Set("channels", Napi::Number::New(env, got.channels));
      d.Resolve(r);
    };
  });
}

// getDevices() → Promise<[{ type, name, isDefault }]>. One physical device appears once PER DRIVER TYPE —
// that is the point, not a bug: the type is what decides whether you get discrete multichannel.
static Napi::Value GetDevices(const Napi::CallbackInfo& info) {
  return runAsync(info.Env(), []() -> Finish {
    auto devs = ensureEngine().listOutputDevices();
    return [devs](Napi::Env env, Napi::Promise::Deferred& d) {
      auto arr = Napi::Array::New(env, devs.size());
      for (size_t i = 0; i < devs.size(); ++i) {
        auto o = Napi::Object::New(env);
        o.Set("type", Napi::String::New(env, devs[i].type.toStdString()));
        o.Set("name", Napi::String::New(env, devs[i].name.toStdString()));
        o.Set("isDefault", Napi::Boolean::New(env, devs[i].isDefault));
        arr.Set((uint32_t) i, o);
      }
      d.Resolve(arr);
    };
  });
}

// loadClip(id, path) → Promise<{ durationSec, channels, sampleRate }>; rejects when the file cannot be opened.
static Napi::Value LoadClip(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "loadClip(id, path)").ThrowAsJavaScriptException(); return env.Null();
  }
  const std::string id = info[0].As<Napi::String>().Utf8Value();
  const juce::String path = info[1].As<Napi::String>().Utf8Value();
  return runAsync(env, [id, path]() -> Finish {
    Clip* clip = nullptr; juce::String err;
    if (!ensureEngine().loadClip(id, path, clip, err)) return rejectWith(err.toStdString());
    // Copied NOW, on the control thread: the clip may be replaced by a later call before the JS side runs.
    const double len = clip->lengthSec; const int ch = clip->channels; const double sr = clip->sampleRate;
    return [len, ch, sr](Napi::Env env, Napi::Promise::Deferred& d) {
      auto obj = Napi::Object::New(env);
      obj.Set("durationSec", Napi::Number::New(env, len));
      obj.Set("channels", Napi::Number::New(env, ch));
      obj.Set("sampleRate", Napi::Number::New(env, sr));
      d.Resolve(obj);
    };
  });
}

static Napi::Value UnloadClip(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsString()) { std::string id = info[0].As<Napi::String>().Utf8Value(); runVoid([id] { ensureEngine().unloadClip(id); }); }
  return info.Env().Undefined();
}

static Napi::Value PlayClip(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsString()) {
    const std::string id = info[0].As<Napi::String>().Utf8Value();
    const double seek = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : 0.0;
    const float gain = info.Length() > 2 && info[2].IsNumber() ? (float) info[2].As<Napi::Number>().DoubleValue() : 1.0f;
    runVoid([id, seek, gain] { ensureEngine().playClip(id, seek, gain); });
  }
  return info.Env().Undefined();
}

static Napi::Value StopClip(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsString()) { std::string id = info[0].As<Napi::String>().Utf8Value(); runVoid([id] { ensureEngine().stopClip(id); }); }
  return info.Env().Undefined();
}

static Napi::Value SetClipGain(const Napi::CallbackInfo& info) {
  if (info.Length() > 1 && info[0].IsString() && info[1].IsNumber()) {
    std::string id = info[0].As<Napi::String>().Utf8Value(); const float g = (float) info[1].As<Napi::Number>().DoubleValue();
    runVoid([id, g] { ensureEngine().setClipGain(id, g); });
  }
  return info.Env().Undefined();
}

// setClipSpatial(id, x, y, z, omni?) — listener at origin, +x right, +y up, +z forward (metres).
static Napi::Value SetClipSpatial(const Napi::CallbackInfo& info) {
  if (info.Length() > 3 && info[0].IsString() && info[1].IsNumber() && info[2].IsNumber() && info[3].IsNumber()) {
    // The 4th argument is OPTIONAL and defaults to false, so an older renderer calling this with three
    // numbers keeps working unchanged. `ToBoolean` rather than IsBoolean+As: the renderer may send a
    // number, and a truthy 1 meaning "everywhere" should not be silently ignored.
    const bool omni = info.Length() > 4 && info[4].ToBoolean().Value();
    std::string id = info[0].As<Napi::String>().Utf8Value();
    const float x = (float) info[1].As<Napi::Number>().DoubleValue(), y = (float) info[2].As<Napi::Number>().DoubleValue(),
                z = (float) info[3].As<Napi::Number>().DoubleValue();
    runVoid([id, x, y, z, omni] { ensureEngine().setClipSpatial(id, x, y, z, omni); });
  }
  return info.Env().Undefined();
}

static Napi::Value ClearClipSpatial(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsString()) { std::string id = info[0].As<Napi::String>().Utf8Value(); runVoid([id] { ensureEngine().clearClipSpatial(id); }); }
  return info.Env().Undefined();
}

// [{ id, type, bypass?, params?: {k: number}, opts?: {k: string} }] → std::vector<EffectSpec>.
// Runs on the JS thread (it reads JS values), BEFORE the call is posted. Deliberately TOLERANT: these
// arrive over a fire-and-forget IPC send, which has nobody to reject to — a malformed node is skipped, a
// malformed param is dropped, and the effect's own setParams() clamps whatever survives. Throwing here
// would take down an audio edit; being lenient just means a bad effect does nothing.
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
  if (info.Length() > 1 && info[0].IsString()) {
    std::string id = info[0].As<Napi::String>().Utf8Value();
    auto specs = std::make_shared<std::vector<EffectSpec>>(parseEffects(info[1]));
    runVoid([id, specs] { ensureEngine().setClipEffects(id, std::move(*specs)); });
  }
  return info.Env().Undefined();
}

// setMasterEffects(effects[]) — on the decoded N-channel output. 'reverb' nodes are DROPPED here:
// juce::dsp::Reverb is a <=2 channel processor and would silently pass dry on a multichannel decode.
static Napi::Value SetMasterEffects(const Napi::CallbackInfo& info) {
  if (info.Length() > 0) {
    auto specs = std::make_shared<std::vector<EffectSpec>>(parseEffects(info[0]));
    runVoid([specs] { ensureEngine().setMasterEffects(std::move(*specs)); });
  }
  return info.Env().Undefined();
}

static Napi::Value SetMasterGain(const Napi::CallbackInfo& info) {
  if (info.Length() > 0 && info[0].IsNumber()) { const float g = (float) info[0].As<Napi::Number>().DoubleValue(); runVoid([g] { ensureEngine().setMasterGain(g); }); }
  return info.Env().Undefined();
}

// setTestTone(deviceChannel, gain) — deviceChannel < 0 turns it off. Pink noise, straight onto a DEVICE
// CHANNEL, bypassing the decoder and the master fader (see Bus::setTestTone).
static Napi::Value SetTestTone(const Napi::CallbackInfo& info) {
  const int ch = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Int32Value() : -1;
  const float g = (float) (info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : 0.5);
  runVoid([ch, g] { ensureEngine().setTestTone(ch, g); });
  return info.Env().Undefined();
}

static Napi::Value StopAll(const Napi::CallbackInfo& info) { runVoid([] { ensureEngine().stopAll(); }); return info.Env().Undefined(); }

// getSpectrum() → Promise<Float32Array>: the spectrum, as  values in 0..1. A separate call from
// GetMeters because it is polled at a DIFFERENT RATE: meters are a 10 Hz readout for a human eye, while a
// visual reacting to sound needs every frame it can get. Bundling them would force one of the two to be wrong.
static Napi::Value GetSpectrum(const Napi::CallbackInfo& info) {
  return runAsync(info.Env(), []() -> Finish {
    std::array<float, SpectrumAnalyser::kBands> bands {};
    ensureEngine().spectrum(bands.data());
    return [bands](Napi::Env env, Napi::Promise::Deferred& d) {
      auto arr = Napi::Float32Array::New(env, (size_t) SpectrumAnalyser::kBands);
      for (int i = 0; i < SpectrumAnalyser::kBands; ++i) arr[(size_t) i] = bands[(size_t) i];
      d.Resolve(arr);
    };
  });
}

// Analyse a caller-supplied mono buffer with the SAME window, scaling and band layout as the live
// tap. Two uses, and the second is why it exists at all: analysing a file offline, and proving the
// analyser is CORRECT on a machine with no audio device — where the live path can only ever return
// silence, so a tone test through it would pass by being empty. Pure DSP: synchronous.
static Napi::Value AnalyseSamples(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() < 2 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "analyseSamples(Float32Array, sampleRate)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto in = info[0].As<Napi::Float32Array>();
  const double sr = info[1].As<Napi::Number>().DoubleValue();
  SpectrumAnalyser an;
  an.pushMono(in.Data(), (int) in.ElementLength());
  float bands[SpectrumAnalyser::kBands];
  an.read(bands, sr);
  auto arr = Napi::Float32Array::New(env, (size_t) SpectrumAnalyser::kBands);
  for (int i = 0; i < SpectrumAnalyser::kBands; ++i) arr[(size_t) i] = bands[i];
  return arr;
}

// getMeters() → Promise<{ peak, rms, peakL, peakR, peaks[], speakers, masterFxChannels, deviceChannels,
// clipped, deviceLive }>.
static Napi::Value GetMeters(const Napi::CallbackInfo& info) {
  struct M { float peak, rms, l, r; std::array<float, kMaxMeterCh> ch; int speakers, fx, dev; bool clipped, live; };
  return runAsync(info.Env(), []() -> Finish {
    auto& e = ensureEngine();
    M m {};
    m.peak = e.peak(); m.rms = e.rms(); m.l = e.chPeak(0); m.r = e.chPeak(1);
    for (int i = 0; i < kMaxMeterCh; ++i) m.ch[(size_t) i] = e.chPeak(i);
    m.speakers = e.speakerCount(); m.fx = e.masterFxChannels(); m.dev = e.deviceChannels();
    m.clipped = e.takeClipped();   // latched since the last poll, then cleared
    m.live = e.deviceLive();
    return [m](Napi::Env env, Napi::Promise::Deferred& d) {
      auto obj = Napi::Object::New(env);
      obj.Set("peak", Napi::Number::New(env, m.peak));
      obj.Set("rms", Napi::Number::New(env, m.rms));
      obj.Set("peakL", Napi::Number::New(env, m.l));
      obj.Set("peakR", Napi::Number::New(env, m.r));
      auto arr = Napi::Array::New(env, (size_t) kMaxMeterCh);
      for (int i = 0; i < kMaxMeterCh; ++i) arr.Set((uint32_t) i, Napi::Number::New(env, m.ch[(size_t) i]));
      obj.Set("peaks", arr);                                         // per-channel (speaker) peaks
      obj.Set("speakers", Napi::Number::New(env, m.speakers));       // 0 unless decoding to speakers
      // Diagnostics: an effect chain built for a different channel count than the audio thread actually
      // sees passes DRY — the worst kind of failure, since it looks wired and meters normally. Expose both
      // numbers so a mismatch is measurable (masterFxChannels is 0 when there is no master chain).
      obj.Set("masterFxChannels", Napi::Number::New(env, m.fx));
      obj.Set("deviceChannels", Napi::Number::New(env, m.dev));
      obj.Set("clipped", Napi::Boolean::New(env, m.clipped));
      // IS THERE STILL A DEVICE — a DIFFERENT QUESTION from `audio:available`, which reports only that the
      // .node loaded. The addon stays loaded when the interface is unplugged; the sound does not.
      obj.Set("deviceLive", Napi::Boolean::New(env, m.live));
      d.Resolve(obj);
    };
  });
}

// close() — SYNCHRONOUS on purpose: it is the quit path, and the device must be closed before the process
// goes. It waits for every call posted before it (a configure still opening a device included).
static Napi::Value Close(const Napi::CallbackInfo& info) {
  // Destroyed HERE, on a live process with JUCE's statics still standing — the one place where
  // ~AudioDeviceManager is safe. See the note on gEngine.
  auto doClose = [] { if (gEngine) { gEngine->closeDevice(); delete gEngine; gEngine = nullptr; } };
#ifdef ARTLUX_AUDIO_CONTROL_THREAD
  std::promise<void> done;
  auto f = done.get_future();
  control::post([&done, doClose] { doClose(); done.set_value(); });
  f.wait();
#else
  doClose();
#endif
  return info.Env().Undefined();
}

// ---- NON-REALTIME RENDERING ---------------------------------------------------------------------
// offlineBegin({sampleRate, blockSize, channels}) -> Promise<{ ok, error? }>
static Napi::Value OfflineBegin(const Napi::CallbackInfo& info) {
  double sr = 48000.0;
  int block = 512, channels = 2;
  if (info.Length() > 0 && info[0].IsObject()) {
    auto o = info[0].As<Napi::Object>();
    if (o.Has("sampleRate") && o.Get("sampleRate").IsNumber()) sr = o.Get("sampleRate").As<Napi::Number>().DoubleValue();
    if (o.Has("blockSize") && o.Get("blockSize").IsNumber()) block = o.Get("blockSize").As<Napi::Number>().Int32Value();
    if (o.Has("channels") && o.Get("channels").IsNumber()) channels = o.Get("channels").As<Napi::Number>().Int32Value();
  }
  return runAsync(info.Env(), [sr, block, channels]() -> Finish {
    juce::String err;
    const bool ok = ensureEngine().offlineBegin(sr, block, channels, err);
    const std::string e = err.toStdString();
    return [ok, e](Napi::Env env, Napi::Promise::Deferred& d) {
      auto out = Napi::Object::New(env);
      out.Set("ok", Napi::Boolean::New(env, ok));
      if (!ok) out.Set("error", Napi::String::New(env, e));
      d.Resolve(out);
    };
  });
}

// offlinePull(frames) -> Promise<Float32Array>, INTERLEAVED (frames * channels). Empty when not rendering.
// A fresh array per call: the caller passes each block straight to an AudioEncoder, which takes ownership
// of the timing, and a shared buffer would be rewritten under an encode that had not finished with it.
static Napi::Value OfflinePull(const Napi::CallbackInfo& info) {
  const int frames = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Int32Value() : 0;
  return runAsync(info.Env(), [frames]() -> Finish {
    auto& eng = ensureEngine();
    auto buf = std::make_shared<std::vector<float>>();
    if (frames > 0 && eng.isOffline()) {
      const int ch = eng.offlineChannelCount();
      buf->assign((size_t) frames * (size_t) ch, 0.0f);
      const int got = eng.offlinePull(buf->data(), frames);
      // Short read: hand back only what is real rather than a tail of zeros an encoder would treat as
      // silence that was actually rendered.
      buf->resize((size_t) got * (size_t) ch);
    }
    return [buf](Napi::Env env, Napi::Promise::Deferred& d) {
      auto arr = Napi::Float32Array::New(env, buf->size());
      if (!buf->empty()) std::memcpy(arr.Data(), buf->data(), buf->size() * sizeof(float));
      d.Resolve(arr);
    };
  });
}

static Napi::Value OfflineEnd(const Napi::CallbackInfo& info) {
  return runAsync(info.Env(), []() -> Finish {
    ensureEngine().offlineEnd();
    return [](Napi::Env env, Napi::Promise::Deferred& d) { d.Resolve(env.Undefined()); };
  });
}

// Diagnostic: libspatialaudio links and its chain runs (encode → B-format → binaural, MIT HRTF). Pure DSP
// on local objects — no engine — so synchronous.
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
#ifdef ARTLUX_AUDIO_CONTROL_THREAD
  // The control thread creates the message manager (Windows device backends expect one to exist) and
  // runs every engine call — see the note above the N-API surface. The thread-safe function brings the
  // answers back to this thread; Unref'd, so it never keeps a quitting process alive.
  control::start();
  gTsfn = Napi::ThreadSafeFunction::New(env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), "artlux-audio-control", 0, 1);
  gTsfn.Unref(env);
#else
  juce::MessageManager::getInstance(); // device backends expect a message manager to exist
#endif
  exports.Set("juceVersion", Napi::Function::New(env, JuceVersion));
  exports.Set("configure", Napi::Function::New(env, Configure));
  exports.Set("getDevices", Napi::Function::New(env, GetDevices));
  exports.Set("getSpectrum", Napi::Function::New(env, GetSpectrum));
  exports.Set("analyseSamples", Napi::Function::New(env, AnalyseSamples));
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
  exports.Set("offlineBegin", Napi::Function::New(env, OfflineBegin));
  exports.Set("offlinePull", Napi::Function::New(env, OfflinePull));
  exports.Set("offlineEnd", Napi::Function::New(env, OfflineEnd));
  return exports;
}

NODE_API_MODULE(audio_engine, Init)
