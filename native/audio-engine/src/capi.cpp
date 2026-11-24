// THE AUDIO ENGINE AS A C LIBRARY — artlux_audio.dll (E3, plans/native-engine.md: "JUCE in the engine process").
//
// The same core as the N-API addon (core.h: the bus, the clips, the device, metering, the control thread), behind a
// plain C surface the native engine (Rust, engine/artlux-engine/src/audio.rs) loads at run time — so sound, picture
// and DMX can come from ONE process and, in the end, ONE clock: the samples this library has handed the device
// (`artlux_audio_clock`).
//
// The rules are the addon's. Every call that touches the engine runs on the ONE control thread, in call order
// (Windows: also JUCE's message thread, an STA pumping window messages — see the note in engine.cpp). A call that
// answers BLOCKS its caller until the control thread has run it; one that does not answer is queued and returns at
// once. The clock is two atomics, read from any thread without the control thread at all.
//
// Strings in are UTF-8. An answer is JSON written into the caller's buffer (truncated to fit, always terminated);
// the return value is 0 on success, 1 on failure (the buffer then holds the error).
#include "core.h"

#if defined(_WIN32)
#define ARTLUX_AUDIO_API extern "C" __declspec(dllexport)
#else
#define ARTLUX_AUDIO_API extern "C" __attribute__((visibility("default")))
#endif

namespace {

std::once_flag gStarted;
void startControl() {
#ifdef ARTLUX_AUDIO_CONTROL_THREAD
  std::call_once(gStarted, [] { control::start(); });
#endif
}

// Run `f` on the control thread and wait for it (inline where there is no control thread).
template <typename F> auto runSync(F f) -> decltype(f()) {
  startControl();
#ifdef ARTLUX_AUDIO_CONTROL_THREAD
  std::packaged_task<decltype(f())()> task(std::move(f));
  auto fut = task.get_future();
  control::post([&task] { task(); });
  return fut.get();
#else
  return f();
#endif
}

void runAsync(std::function<void()> f) {
  startControl();
#ifdef ARTLUX_AUDIO_CONTROL_THREAD
  control::post([f = std::move(f)] { try { f(); } catch (...) {} });
#else
  try { f(); } catch (...) {}
#endif
}

int answer(char* out, int cap, const juce::String& s, int code) {
  if (out && cap > 0) {
    const std::string u = s.toStdString();
    const size_t n = std::min(u.size(), (size_t) cap - 1);
    std::memcpy(out, u.data(), n);
    out[n] = 0;
  }
  return code;
}

} // namespace

ARTLUX_AUDIO_API void artlux_audio_close();

// 2: artlux_audio_call (the relay's one door) added.
ARTLUX_AUDIO_API int artlux_audio_abi() { return 2; }

ARTLUX_AUDIO_API int artlux_audio_version(char* out, int cap) {
  return answer(out, cap, juce::SystemStats::getJUCEVersion(), 0);
}

// configure(json) — the addon's cfg object as JSON: { deviceType?, deviceName?, channels?, sampleRate?,
// bufferSize?, mode?, layout?, patch? }. Answers { deviceName, deviceType, sampleRate, bufferSize, channels }.
ARTLUX_AUDIO_API int artlux_audio_configure(const char* json, char* out, int cap) {
  const juce::var o = juce::JSON::parse(juce::String::fromUTF8(json ? json : "{}"));
  const auto str = [&](const char* k, const char* d) { return o.hasProperty(k) && o[k].isString() ? o[k].toString() : juce::String(d); };
  const auto num = [&](const char* k, double d) { return o.hasProperty(k) && (o[k].isDouble() || o[k].isInt() || o[k].isInt64()) ? (double) o[k] : d; };
  Engine::DeviceCfg cfg;
  cfg.type = str("deviceType", "");
  cfg.name = str("deviceName", "");
  cfg.channels = (int) num("channels", 2);
  cfg.sampleRate = num("sampleRate", 0);
  cfg.bufferSize = (int) num("bufferSize", 0);
  cfg.mode = str("mode", "binaural") == "speakers" ? OutMode::Speakers : OutMode::Binaural;
  cfg.layout = str("layout", "stereo");
  if (auto* a = o["patch"].getArray()) for (auto& x : *a) cfg.patch.push_back((int) x);
  return runSync([&]() -> int {
    try {
      Engine::OpenedCfg got;
      const juce::String err = ensureEngine().configure(cfg, got);
      if (err.isNotEmpty()) return answer(out, cap, "audio configure failed: " + err, 1);
      auto* r = new juce::DynamicObject();
      r->setProperty("deviceName", got.deviceName);
      r->setProperty("deviceType", got.deviceType);
      r->setProperty("sampleRate", got.sampleRate);
      r->setProperty("bufferSize", got.bufferSize);
      r->setProperty("channels", got.channels);
      return answer(out, cap, juce::JSON::toString(juce::var(r), true), 0);
    } catch (const std::exception& e) { return answer(out, cap, juce::String("audio engine: ") + e.what(), 1); }
  });
}

// loadClip(id, path) — answers { durationSec, channels, sampleRate }.
ARTLUX_AUDIO_API int artlux_audio_load_clip(const char* id, const char* path, char* out, int cap) {
  const std::string sid = id ? id : "";
  const juce::String p = juce::String::fromUTF8(path ? path : "");
  return runSync([&]() -> int {
    Clip* clip = nullptr; juce::String err;
    if (!ensureEngine().loadClip(sid, p, clip, err)) return answer(out, cap, err, 1);
    auto* r = new juce::DynamicObject();
    r->setProperty("durationSec", clip->lengthSec);
    r->setProperty("channels", clip->channels);
    r->setProperty("sampleRate", clip->sampleRate);
    return answer(out, cap, juce::JSON::toString(juce::var(r), true), 0);
  });
}

ARTLUX_AUDIO_API void artlux_audio_unload_clip(const char* id) { std::string s = id ? id : ""; runAsync([s] { ensureEngine().unloadClip(s); }); }
// playClip(id, seekSec, gain) — seek is a SOURCE offset, as the addon's.
ARTLUX_AUDIO_API void artlux_audio_play_clip(const char* id, double seek, double gain) { std::string s = id ? id : ""; runAsync([s, seek, gain] { ensureEngine().playClip(s, seek, (float) gain); }); }
ARTLUX_AUDIO_API void artlux_audio_stop_clip(const char* id) { std::string s = id ? id : ""; runAsync([s] { ensureEngine().stopClip(s); }); }
ARTLUX_AUDIO_API void artlux_audio_set_clip_gain(const char* id, double gain) { std::string s = id ? id : ""; runAsync([s, gain] { ensureEngine().setClipGain(s, (float) gain); }); }
ARTLUX_AUDIO_API void artlux_audio_set_master_gain(double gain) { runAsync([gain] { ensureEngine().setMasterGain((float) gain); }); }
ARTLUX_AUDIO_API void artlux_audio_stop_all() { runAsync([] { ensureEngine().stopAll(); }); }

// THE AUDIO CLOCK — samples handed to the device since the engine was made, and the rate they play at (0 with no
// device open). Two atomics: any thread, no control-thread round trip. Blocks nothing.
ARTLUX_AUDIO_API long long artlux_audio_clock(double* rate) {
  if (!gEngine) { if (rate) *rate = 0; return 0; }
  if (rate) *rate = gEngine->liveRate();
  return (long long) gEngine->renderedSamples();
}

// getMeters() — { peak, rms } (the rest of the addon's meters follow with the driver).
ARTLUX_AUDIO_API int artlux_audio_meters(char* out, int cap) {
  return runSync([&]() -> int {
    auto* r = new juce::DynamicObject();
    r->setProperty("peak", (double) ensureEngine().peak());
    r->setProperty("rms", (double) ensureEngine().rms());
    r->setProperty("deviceLive", ensureEngine().deviceLive());
    return answer(out, cap, juce::JSON::toString(juce::var(r), true), 0);
  });
}

// [{ id, type, bypass?, params?: {k: number}, opts?: {k: string} }] → EffectSpec — the addon's parseEffects, as
// tolerant (a malformed node is skipped, a malformed param dropped; the effect's setParams clamps the rest).
static std::vector<EffectSpec> parseEffectsVar(const juce::var& v) {
  std::vector<EffectSpec> out;
  auto* arr = v.getArray();
  if (!arr) return out;
  for (auto& ev : *arr) {
    auto* o = ev.getDynamicObject();
    if (!o || !ev["type"].isString()) continue;
    EffectSpec s;
    s.type = ev["type"].toString().toStdString();
    s.id = ev["id"].isString() ? ev["id"].toString().toStdString() : s.type;
    s.bypass = ev["bypass"].isBool() && (bool) ev["bypass"];
    if (auto* p = ev["params"].getDynamicObject())
      for (auto& kv : p->getProperties()) if (kv.value.isDouble() || kv.value.isInt() || kv.value.isInt64()) s.params[kv.name.toString().toStdString()] = (float) (double) kv.value;
    if (auto* p = ev["opts"].getDynamicObject())
      for (auto& kv : p->getProperties()) if (kv.value.isString()) s.opts[kv.name.toString().toStdString()] = kv.value.toString().toStdString();
    out.push_back(std::move(s));
  }
  return out;
}

// THE RELAY'S ONE DOOR (ABI 2): `{ "op": <addon method>, "args": [...] }` → the addon's answer as JSON (null for a
// call that answers nothing). Every live method of audio_engine.node, by the addon's own name and argument order,
// so the native engine forwards plugins/audio's calls without knowing them (engine/…/src/audio.rs `serve`).
ARTLUX_AUDIO_API int artlux_audio_call(const char* json, char* out, int cap) {
  const juce::var m = juce::JSON::parse(juce::String::fromUTF8(json ? json : "{}"));
  const juce::String op = m["op"].toString();
  const juce::var a = m["args"];
  const auto s = [&](int i) { return a[i].toString().toStdString(); };
  const auto d = [&](int i, double dflt) { const juce::var& x = a[i]; return (x.isDouble() || x.isInt() || x.isInt64()) ? (double) x : dflt; };
  const auto none = [&] { return answer(out, cap, "null", 0); };
  if (op == "juceVersion") return answer(out, cap, juce::JSON::toString(juce::SystemStats::getJUCEVersion()), 0);
  if (op == "configure") return artlux_audio_configure(juce::JSON::toString(a[0], true).toRawUTF8(), out, cap);
  if (op == "loadClip") return artlux_audio_load_clip(s(0).c_str(), s(1).c_str(), out, cap);
  if (op == "unloadClip") { artlux_audio_unload_clip(s(0).c_str()); return none(); }
  if (op == "playClip") { artlux_audio_play_clip(s(0).c_str(), d(1, 0.0), d(2, 1.0)); return none(); }
  if (op == "stopClip") { artlux_audio_stop_clip(s(0).c_str()); return none(); }
  if (op == "setClipGain") { artlux_audio_set_clip_gain(s(0).c_str(), d(1, 1.0)); return none(); }
  if (op == "setMasterGain") { artlux_audio_set_master_gain(d(0, 1.0)); return none(); }
  if (op == "stopAll") { artlux_audio_stop_all(); return none(); }
  if (op == "close") { artlux_audio_close(); return none(); }
  if (op == "setClipSpatial") {
    const std::string id = s(0); const float x = (float) d(1, 0), y = (float) d(2, 0), z = (float) d(3, 0); const bool omni = (bool) a[4];
    runAsync([id, x, y, z, omni] { ensureEngine().setClipSpatial(id, x, y, z, omni); });
    return none();
  }
  if (op == "clearClipSpatial") { const std::string id = s(0); runAsync([id] { ensureEngine().clearClipSpatial(id); }); return none(); }
  if (op == "setClipEffects") {
    const std::string id = s(0); auto specs = std::make_shared<std::vector<EffectSpec>>(parseEffectsVar(a[1]));
    runAsync([id, specs] { ensureEngine().setClipEffects(id, std::move(*specs)); });
    return none();
  }
  if (op == "setMasterEffects") {
    auto specs = std::make_shared<std::vector<EffectSpec>>(parseEffectsVar(a[0]));
    runAsync([specs] { ensureEngine().setMasterEffects(std::move(*specs)); });
    return none();
  }
  if (op == "setTestTone") { const int ch = (int) d(0, -1); const float g = (float) d(1, 0.5); runAsync([ch, g] { ensureEngine().setTestTone(ch, g); }); return none(); }
  if (op == "getDevices") {
    return runSync([&]() -> int {
      juce::Array<juce::var> arr;
      for (auto& e : ensureEngine().listOutputDevices()) {
        auto* o = new juce::DynamicObject();
        o->setProperty("type", e.type); o->setProperty("name", e.name); o->setProperty("isDefault", e.isDefault);
        arr.add(juce::var(o));
      }
      return answer(out, cap, juce::JSON::toString(juce::var(arr), true), 0);
    });
  }
  if (op == "getMeters") {
    return runSync([&]() -> int {
      auto& e = ensureEngine();
      auto* o = new juce::DynamicObject();
      o->setProperty("peak", (double) e.peak()); o->setProperty("rms", (double) e.rms());
      o->setProperty("peakL", (double) e.chPeak(0)); o->setProperty("peakR", (double) e.chPeak(1));
      juce::Array<juce::var> ch; for (int i = 0; i < kMaxMeterCh; ++i) ch.add((double) e.chPeak(i));
      o->setProperty("peaks", ch);
      o->setProperty("speakers", e.speakerCount()); o->setProperty("masterFxChannels", e.masterFxChannels());
      o->setProperty("deviceChannels", e.deviceChannels());
      o->setProperty("clipped", e.takeClipped());   // latched since the last poll, then cleared — as the addon
      o->setProperty("deviceLive", e.deviceLive());
      return answer(out, cap, juce::JSON::toString(juce::var(o), true), 0);
    });
  }
  if (op == "getSpectrum") {
    return runSync([&]() -> int {
      std::array<float, SpectrumAnalyser::kBands> bands {};
      ensureEngine().spectrum(bands.data());
      juce::Array<juce::var> arr; for (float b : bands) arr.add((double) b);
      return answer(out, cap, juce::JSON::toString(juce::var(arr), true), 0);
    });
  }
  // THE OFFLINE RENDER (a bake), on THIS engine — the clips a bake plays are the ones loaded here. Samples come back
  // as base64 of the raw float32s, INTERLEAVED (frames × channels): exact, which a decimal rendering is not.
  if (op == "offlineBegin") {
    const juce::var c = a[0];
    const auto num = [&](const char* k, double dflt) { return (c[k].isDouble() || c[k].isInt() || c[k].isInt64()) ? (double) c[k] : dflt; };
    const double sr = num("sampleRate", 48000.0); const int block = (int) num("blockSize", 512), channels = (int) num("channels", 2);
    return runSync([&]() -> int {
      juce::String err;
      const bool ok = ensureEngine().offlineBegin(sr, block, channels, err);
      auto* o = new juce::DynamicObject();
      o->setProperty("ok", ok);
      if (!ok) o->setProperty("error", err);
      return answer(out, cap, juce::JSON::toString(juce::var(o), true), 0);
    });
  }
  if (op == "offlinePull") {
    const int frames = (int) d(0, 0);
    return runSync([&]() -> int {
      auto& eng = ensureEngine();
      std::vector<float> buf;
      if (frames > 0 && eng.isOffline()) {
        const int ch = eng.offlineChannelCount();
        buf.assign((size_t) frames * (size_t) ch, 0.0f);
        const int got = eng.offlinePull(buf.data(), frames);
        buf.resize((size_t) got * (size_t) ch);   // a short read hands back only what is real
      }
      const juce::String b64 = juce::Base64::toBase64(buf.data(), buf.size() * sizeof(float));
      return answer(out, cap, juce::JSON::toString(juce::var(b64)), 0);
    });
  }
  if (op == "offlineEnd") { runSync([]() -> int { ensureEngine().offlineEnd(); return 0; }); return none(); }
  return answer(out, cap, "audio engine: no such call '" + op + "'", 1);
}

// close() — the device closed and the engine destroyed, on a live process (the one place ~AudioDeviceManager is
// safe — see the note on gEngine in core.h). Waits for every call posted before it.
ARTLUX_AUDIO_API void artlux_audio_close() {
  runSync([]() -> int { if (gEngine) { gEngine->closeDevice(); delete gEngine; gEngine = nullptr; } return 0; });
}
