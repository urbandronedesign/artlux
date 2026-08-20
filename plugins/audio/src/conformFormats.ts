// WHICH SOURCES MUST BE CONFORMED BEFORE THE ENGINE CAN PLAY THEM — one table, both processes.
//
// The native engine registers WAV/AIFF/FLAC/Ogg and nothing else (native/audio-engine/src/engine.cpp,
// `formats()`). Everything else has to become a cached WAV first (conform.main.ts). MAIN needs this to
// decide whether a conform request is even worth starting; the RENDERER needs it to decide whether a
// clip's path must be translated before it reaches `audioClient.loadClip`.
//
// ⚠ IT LIVES IN ITS OWN FILE BECAUSE conform.main.ts IMPORTS `electron`. Importing that module from the
// renderer to reuse one regex would drag the main-process half of the plugin into the window. And the
// two halves must not each keep their own copy: a format main will conform but the renderer does not
// TRANSLATE is a clip that stays silent forever, with a conform sitting in the cache that nothing ever
// asks for — the failure this file exists to make unrepresentable.

/** Video containers: conformed for their soundtrack (the engine cannot open an ISO-BMFF file). */
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm)$/i;

/**
 * Audio containers the engine has no decoder for.
 *
 * MP3 is here rather than in the engine because JUCE's mp3 decoder is a build flag (JUCE_USE_MP3AUDIOFORMAT)
 * that carries JUCE's own patent disclaimer, and ArtLux does not take on a licence obligation it can avoid.
 * Chromium's decoder ships with Electron and carries none of ours, so an mp3 goes down the conform's
 * whole-file `decodeAudioData` branch and the venue plays the resulting WAV.
 */
const AUDIO_CONFORM_EXT = /\.(mp3)$/i;

export const isVideoContainer = (p: string): boolean => VIDEO_EXT.test(p);

/** True when `p` cannot be handed to the engine as-is and needs its conform first. */
export const needsConform = (p: string): boolean => !!p && (VIDEO_EXT.test(p) || AUDIO_CONFORM_EXT.test(p));
