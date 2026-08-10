#pragma once

// The spectrum analyser: what the mixed output actually sounds like, as numbers a visual can react to.
//
// ── WHY IT IS SHAPED LIKE THIS ────────────────────────────────────────────────────────────────────
// The audio thread does the cheapest possible thing — a mono fold and a memcpy into a ring — and the
// FFT runs on the CALLER's thread inside read(). That split is deliberate:
//
//   · An FFT on the audio thread is a periodic spike in the one place a spike is a dropout. It is
//     affordable at 1024 points, but it buys nothing here: nothing downstream consumes spectra faster
//     than a screen refreshes.
//   · Analysis is not resynthesis. The overlap-add machinery a spectral EFFECT needs (hop size, a
//     second window after the IFFT, COLA) exists to reconstruct a signal without modulation artefacts.
//     We never reconstruct, so there is no overlap to satisfy and no hop to honour: each read simply
//     transforms the most recent kSize samples, which is exactly "what is playing now".
//
// ── THE DETAILS THAT ARE EASY TO GET WRONG ───────────────────────────────────────────────────────
//   · PERIODIC window, not symmetric. The DFT assumes its input loops; a symmetric Hann does not, and
//     the discontinuity smears energy across every bin. JUCE's windowing tables are symmetric, so the
//     table is built one sample LONGER and only the first kSize entries are used — the standard trick.
//   · Only kSize/2 + 1 bins carry information. Bin 0 is DC, bin kSize/2 is Nyquist.
//   · Magnitudes come out of a forward FFT scaled by the transform length, and two further factors
//     apply: the single-sided spectrum folds the negative frequencies onto the positive ones (×2), and
//     a Hann window has an average value of 0.5 (×2). Hence 4 / kSize, which is what makes the numbers
//     mean something rather than merely look responsive.
//
// Reference for the corrections and the periodic-window trap: https://audiodev.blog/fft-processing/
// (that article covers analysis→resynthesis; the resynthesis half deliberately has no counterpart here).

#include <juce_dsp/juce_dsp.h>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

class SpectrumAnalyser {
public:
  static constexpr int kOrder = 10;
  static constexpr int kSize = 1 << kOrder;        // 1024 → 46.9 Hz per bin at 48 kHz, ~21 ms of history
  static constexpr int kBins = kSize / 2 + 1;      // 513
  static constexpr int kBands = 16;                // what a visual actually wants

  // A LIMIT WORTH KNOWING RATHER THAN HIDING. At 1024 points and 48 kHz a bin is 46.9 Hz wide, while
  // the lowest log bands are narrower than that (band 0 spans 40–58 Hz). So the bottom four bands do
  // not resolve independently — they share bins, and a kick lights all of them together. That reads
  // correctly as bass energy and is the right trade: resolving 40 Hz apart needs a 4096-point window,
  // which is 85 ms of history, and a visual lagging a kick by 85 ms is a worse fault than four bands
  // that agree. Above roughly 200 Hz every band is independent.

  // The window a band reports over, in dB. -60 is a sensible floor for programme material: quieter
  // than that is a room tone, and mapping it to 0 keeps a visual still instead of twitching at noise.
  static constexpr float kFloorDb = -60.0f;

  SpectrumAnalyser()
    : fft(kOrder),
      // kSize + 1, then only the first kSize are used → a PERIODIC Hann out of a symmetric table.
      window((size_t) kSize + 1, juce::dsp::WindowingFunction<float>::hann, false),
      scratch((size_t) kSize * 2, 0.0f) {}

  /** Mono samples straight into the ring. The audio path and the offline path share it, so an
   *  offline check is a check of the SAME code and not of a second implementation that agrees. */
  void pushMono(const float* src, int n) noexcept {
    if (src == nullptr || n <= 0) return;
    int w = writePos.load(std::memory_order_relaxed);
    for (int i = 0; i < n; ++i) { ring[(size_t) w] = src[i]; w = (w + 1) & (kSize - 1); }
    writePos.store(w, std::memory_order_release);
    live.store(true, std::memory_order_relaxed);
  }

  /** AUDIO THREAD. Fold to mono and copy into the ring. No allocation, no locks, no transform. */
  void push(const juce::AudioBuffer<float>& buf, int start, int n) noexcept {
    const int nch = buf.getNumChannels();
    if (nch <= 0 || n <= 0) return;
    int w = writePos.load(std::memory_order_relaxed);
    const float norm = 1.0f / (float) nch;
    for (int i = 0; i < n; ++i) {
      float s = 0.0f;
      for (int c = 0; c < nch; ++c) s += buf.getReadPointer(c, start)[i];
      ring[(size_t) w] = s * norm;
      w = (w + 1) & (kSize - 1);
    }
    writePos.store(w, std::memory_order_release);
    live.store(true, std::memory_order_relaxed);
  }

  /**
   * CALLER'S THREAD. Transform the most recent kSize samples into `kBands` log-spaced bands, each a
   * 0..1 value where 1 is full scale and 0 is the floor.
   *
   * Log spacing because hearing is logarithmic and a linear split wastes fifteen of sixteen bands on
   * the top two octaves — a "spectrum" that only ever moves in its first bar.
   */
  void read(float* out, double sampleRate) noexcept {
    for (int b = 0; b < kBands; ++b) out[b] = 0.0f;
    if (!live.load(std::memory_order_relaxed) || sampleRate <= 0.0) return;

    // Copy the ring oldest→newest. The read position may sit anywhere, so this is two copies.
    const int w = writePos.load(std::memory_order_acquire);
    const int first = kSize - w;
    std::copy(ring.begin() + w, ring.end(), scratch.begin());
    std::copy(ring.begin(), ring.begin() + w, scratch.begin() + first);
    std::fill(scratch.begin() + kSize, scratch.end(), 0.0f); // the imaginary half

    window.multiplyWithWindowingTable(scratch.data(), (size_t) kSize);
    fft.performFrequencyOnlyForwardTransform(scratch.data());

    const float scale = 4.0f / (float) kSize; // single-sided (×2) × Hann coherent gain 0.5 (×2)
    const double binHz = sampleRate / (double) kSize;

    // 40 Hz because below it is mostly room and rumble; the top edge stops short of Nyquist so the
    // last band is not half-empty on a 44.1 kHz device.
    const double loHz = 40.0;
    const double hiHz = std::min(16000.0, sampleRate * 0.45);
    if (hiHz <= loHz) return;
    const double ratio = std::log(hiHz / loHz) / (double) kBands;

    for (int b = 0; b < kBands; ++b) {
      const double f0 = loHz * std::exp(ratio * (double) b);
      const double f1 = loHz * std::exp(ratio * (double) (b + 1));
      int k0 = (int) std::floor(f0 / binHz);
      int k1 = (int) std::ceil(f1 / binHz);
      k0 = juce::jlimit(1, kBins - 1, k0);            // skip DC: it is offset, not sound
      k1 = juce::jlimit(k0 + 1, kBins, k1);

      // PEAK across the band, not mean. A mean divides a tone's energy by however many bins the band
      // happens to span, so the same sine reads quieter in a wide high band than a narrow low one —
      // the bands would then measure their own width as much as the music.
      float mag = 0.0f;
      for (int k = k0; k < k1; ++k) mag = juce::jmax(mag, scratch[(size_t) k] * scale);

      const float db = juce::Decibels::gainToDecibels(mag, kFloorDb);
      out[b] = juce::jlimit(0.0f, 1.0f, (db - kFloorDb) / -kFloorDb);
    }
  }

  static constexpr int bandCount() { return kBands; }

private:
  juce::dsp::FFT fft;
  juce::dsp::WindowingFunction<float> window;
  std::array<float, kSize> ring {};
  std::vector<float> scratch;
  std::atomic<int> writePos { 0 };
  std::atomic<bool> live { false }; // no audio has ever reached us → report silence, not noise
};
