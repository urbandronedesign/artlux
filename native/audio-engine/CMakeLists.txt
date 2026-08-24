cmake_minimum_required(VERSION 3.23) # libspatialaudio uses FILE_SET HEADERS (3.23+)
cmake_policy(SET CMP0091 NEW)          # MSVC runtime library selectable via CMAKE_MSVC_RUNTIME_LIBRARY
project(audio_engine CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# N-API version — 8 is supported by Electron 42 (node 22). node-addon-api targets this.
add_definitions(-DNAPI_VERSION=8)

# node-addon-api is header-only; ask it where its headers live.
execute_process(
  COMMAND node -p "require('node-addon-api').include_dir"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)

# ── JUCE (fetched at configure time; shallow clone of a pinned release) ──────────────────────────
include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG        8.0.14
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(JUCE)

# ── libspatialaudio (ambisonic encode/decode + binaural HRTF) ───────────────────────────────────
# Built STATIC so the .node stays self-contained (it declares add_library() with no type, so it
# follows BUILD_SHARED_LIBS — our own addon is explicitly SHARED and unaffected). Added with
# EXCLUDE_FROM_ALL so its 4 test executables aren't built into our addon. Its MySofa dependency is
# optional (find_package(MySofa QUIET)) and we deliberately don't provide it: HAVE_MIT_HRTF ships a
# built-in HRTF dataset, so binaural decoding works with no external SOFA file (and no zlib chain).
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(HAVE_MIT_HRTF ON CACHE BOOL "" FORCE)
FetchContent_Declare(spatialaudio
  GIT_REPOSITORY https://github.com/videolabs/libspatialaudio.git
  GIT_TAG        0.4.0
  GIT_SHALLOW    TRUE
)
FetchContent_GetProperties(spatialaudio)
if(NOT spatialaudio_POPULATED)
  FetchContent_Populate(spatialaudio)
  # Upstream's tests/CMakeLists.txt is added unconditionally and its add_test() uses the
  # TARGET_RUNTIME_DLL_DIRS generator expression, which only exists in CMake 3.27+ — on 3.26 the
  # GENERATE step hard-fails. EXCLUDE_FROM_ALL doesn't help (add_test is evaluated at generate time),
  # so blank the file out: we don't build libspatialaudio's tests.
  file(WRITE ${spatialaudio_SOURCE_DIR}/tests/CMakeLists.txt
       "# Emptied by ArtLux: upstream tests need CMake 3.27+ and we don't build them.\n")
  add_subdirectory(${spatialaudio_SOURCE_DIR} ${spatialaudio_BINARY_DIR} EXCLUDE_FROM_ALL)
endif()

# ── The addon target ────────────────────────────────────────────────────────────────────────────
file(GLOB SOURCE_FILES "src/*.cpp")
add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR}
  ${spatialaudio_SOURCE_DIR}/include   # ambisonic headers
  ${spatialaudio_BINARY_DIR}           # its generated config.h
)

# JUCE global config — keep the spike lean (no curl/browser/ASIO; codecs enabled later in P0c).
target_compile_definitions(${PROJECT_NAME} PRIVATE
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_USE_FLAC=1
  JUCE_USE_OGGVORBIS=1
  JUCE_MODAL_LOOPS_PERMITTED=0
  JUCE_DISPLAY_SPLASH_SCREEN=0
  DONT_SET_USING_JUCE_NAMESPACE=1
)

# ── ASIO: OFF by default because the SDK cannot live in this repo, NOT because it is optional ────────
#
# ⚠ THIS BLOCK USED TO SAY TWO THINGS THAT MEASUREMENT DISPROVED (2026-08-21, Scarlett 6i6 2nd gen):
#
#   "we have no ASIO hardware to test against"  — we do now, and this path has been built and run.
#   "WASAPI exclusive delivers discrete multichannel; ASIO only buys latency"  — false on an interface
#   whose VENDOR driver is installed. Same machine, same cables, one hour apart: on the generic USB
#   audio-class driver the 6i6 opened SIX channels on every WASAPI mode; with Focusrite's own driver it
#   opened TWO, on every mode, at every requested count. A vendor driver commonly presents outputs 1-2
#   as the Windows endpoint and routes everything above that through ASIO ONLY. On such a device ASIO
#   is not an optimisation — it is the ONLY route to outputs 3 and up.
#
# WHY IT IS STILL OFF BY DEFAULT: the SDK cannot be committed here (see below), so a default-ON build
# would fail for everyone who has not downloaded it. That is a packaging constraint, not a judgement
# about whether ASIO is needed.
#
# ── THE LICENCE, READ FROM THE SDK's OWN LICENSE.txt (2.3.4, 2025-10-15) ────────────────────────────
# The SDK is DUAL-LICENSED — proprietary Steinberg ASIO Licence, or GPLv3, your choice per project.
#
#   PROPRIETARY: "The Software Development Kit may not be distributed in parts or its entirety without
#   prior written agreement" — so the SDK stays off this repo and out of CI. But that restricts the
#   SDK, NOT a binary compiled against it: shipping an ASIO-enabled application is exactly what every
#   DAW does. The real gate is the next sentence — "Before publishing a software under the proprietary
#   license, you need to obtain a copy of the License Agreement SIGNED by Steinberg Media Technologies
#   GmbH." Building and running locally needs nothing; PUBLISHING a release does.
#
#   GPLv3: no paperwork, but it would force ArtLux's own source under GPLv3, and the GPL GRANTS
#   COMMERCIAL RIGHTS — the precise thing LICENSE §2 withholds, and the same reason JUCE's AGPLv3
#   option was rejected (NOTICE item (a)). Unavailable while ArtLux is non-commercial; it becomes the
#   cheap route if the relicensing question in plans/licensing-relicensing.md ever lands on the GPL.
#
# To build with ASIO, prefer the env var so the configure pass is not skipped:
#     set ARTLUX_ASIO_SDK=<sdk>/common   then   npm run build:audio
#     cmake -DARTLUX_ENABLE_ASIO=ON -DASIO_SDK_DIR=<sdk>/common          (by hand, equivalent)
# See docs/DEVELOPMENT.md ▸ ASIO and NOTICE. This adds a THIRD licence position (Steinberg's) to a
# build that already carries JUCE's (Starter — elected 2026-07-25) and libspatialaudio's LGPL.
option(ARTLUX_ENABLE_ASIO "Build with ASIO support (requires the Steinberg ASIO SDK)" OFF)
set(ASIO_SDK_DIR "" CACHE PATH "Path to the ASIO SDK 'common' directory")

if(ARTLUX_ENABLE_ASIO)
  if(NOT ASIO_SDK_DIR OR NOT EXISTS "${ASIO_SDK_DIR}/iasiodrv.h")
    message(FATAL_ERROR "ARTLUX_ENABLE_ASIO=ON but ASIO_SDK_DIR does not contain iasiodrv.h. See docs/DEVELOPMENT.md.")
  endif()
  target_compile_definitions(${PROJECT_NAME} PRIVATE JUCE_ASIO=1)
  target_include_directories(${PROJECT_NAME} PRIVATE ${ASIO_SDK_DIR})
  message(STATUS "ArtLux: ASIO ENABLED — this adds Steinberg's licence terms to this build.")
else()
  target_compile_definitions(${PROJECT_NAME} PRIVATE JUCE_ASIO=0)
endif()

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
  spatialaudio
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_audio_basics
  juce::juce_dsp          # effect chains (P3). Depends only on juce_audio_formats — adds no new module.
  juce::juce_core
  juce::juce_events
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags
)

# Windows: generate the node.lib import library so the addon links against the host's exports.
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()
