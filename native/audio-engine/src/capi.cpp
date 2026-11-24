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

ARTLUX_AUDIO_API int artlux_audio_abi() { return 1; }

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

// close() — the device closed and the engine destroyed, on a live process (the one place ~AudioDeviceManager is
// safe — see the note on gEngine in core.h). Waits for every call posted before it.
ARTLUX_AUDIO_API void artlux_audio_close() {
  runSync([]() -> int { if (gEngine) { gEngine->closeDevice(); delete gEngine; gEngine = nullptr; } return 0; });
}
