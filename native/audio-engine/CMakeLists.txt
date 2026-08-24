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

# ── ASIO: ON by default on Windows, because on real interfaces it is the only route to the outputs ───
#
# MEASURED, 2026-08-21, Scarlett 6i6 2nd gen. Same machine, same cables, one hour apart: on the generic
# USB audio-class driver it opened SIX channels on every WASAPI mode; with Focusrite's own driver
# installed it opened TWO, on every mode, at every requested count. A vendor driver commonly presents
# outputs 1-2 as the Windows endpoint and routes everything above through ASIO ONLY. On such a device
# ASIO is not a latency optimisation — it is the ONLY route to outputs 3 and up, and a venue installing
# a released build has no way to reach its own speakers without it.
#
# ⚠ NO SDK DOWNLOAD IS NEEDED, AND THE OLD FATAL_ERROR HERE WAS GUARDING NOTHING.
# JUCE 8.0.14 VENDORS the three ASIO headers at
#   modules/juce_audio_devices/native/asio/{asio.h,asiosys.h,iasiodrv.h}
# byte-for-byte identical to the SDK's common/ (verified with cmp), lists them in its own LICENSE.md,
# and JUCE_ASIO_USE_EXTERNAL_SDK defaults to 0 — so juce_audio_devices.cpp includes ITS copy and never
# looks at an include path. The previous block demanded ASIO_SDK_DIR contain iasiodrv.h and then added
# that directory to the include path, i.e. it hard-failed the build over a file the compile did not
# use. That requirement is why this had to be off by default and why CI could not build it; both
# reasons were false.
#
# ASIO_SDK_DIR is now genuinely optional and means what it says: point it at an external SDK and JUCE
# is told to prefer that copy over its own. Leave it empty for the vendored headers.
#
# ── THE LICENCE, READ FROM THE SDK's OWN LICENSE.txt (2.3.4, 2025-10-15) ────────────────────────────
# Dual-licensed — proprietary Steinberg ASIO Licence, or GPLv3, elected per project. The proprietary
# branch restricts distributing THE SDK, not a binary compiled against it (shipping an ASIO-enabled
# application is what every DAW does); its gate is "Before publishing a software under the proprietary
# license, you need to obtain a copy of the License Agreement signed by Steinberg Media Technologies
# GmbH." The GPLv3 branch requires the product itself be GPLv3. Attribution is required either way —
# see NOTICE and shared/credits.ts. Shipping ASIO is a decision the project owners have taken; this
# file only records what it rests on.
#
# Turn it off for a build with:  cmake -DARTLUX_ENABLE_ASIO=OFF   (or ARTLUX_ASIO=0 for build:audio)
if(WIN32)
  option(ARTLUX_ENABLE_ASIO "Build with ASIO support (Windows multichannel)" ON)
else()
  option(ARTLUX_ENABLE_ASIO "Build with ASIO support (Windows only)" OFF)
endif()
set(ASIO_SDK_DIR "" CACHE PATH "OPTIONAL external ASIO SDK 'common' directory; only used when ARTLUX_ASIO_USE_EXTERNAL=ON")
# ⚠ A SEPARATE BOOLEAN, NOT "is ASIO_SDK_DIR non-empty".
# A CMake CACHE entry cannot be cleared by passing an empty -D: cmake-js drops the argument entirely,
# so a tree once configured with a path goes on using it forever. Measured — a build run with no
# environment variables at all still printed "ASIO ENABLED using the EXTERNAL SDK at ...". The switch
# has to be a value that can be set to OFF, not an absence that cannot be expressed.
option(ARTLUX_ASIO_USE_EXTERNAL "Use an external ASIO SDK instead of JUCE's vendored headers" OFF)

if(ARTLUX_ENABLE_ASIO AND NOT WIN32)
  message(FATAL_ERROR "ARTLUX_ENABLE_ASIO=ON but ASIO is a Windows-only driver model.")
endif()

if(ARTLUX_ENABLE_ASIO)
  target_compile_definitions(${PROJECT_NAME} PRIVATE JUCE_ASIO=1)
  if(ARTLUX_ASIO_USE_EXTERNAL AND ASIO_SDK_DIR)
    if(NOT EXISTS "${ASIO_SDK_DIR}/iasiodrv.h")
      message(FATAL_ERROR "ASIO_SDK_DIR is set to '${ASIO_SDK_DIR}' but there is no iasiodrv.h there. Leave it empty to use JUCE's vendored headers.")
    endif()
    # JUCE_ASIO_USE_EXTERNAL_SDK=1 is REQUIRED for the include path to matter; without it JUCE includes
    # its own copy regardless of what is on the path, and an "external SDK" build silently is not one.
    target_compile_definitions(${PROJECT_NAME} PRIVATE JUCE_ASIO_USE_EXTERNAL_SDK=1)
    target_include_directories(${PROJECT_NAME} PRIVATE ${ASIO_SDK_DIR})
    message(STATUS "ArtLux: ASIO ENABLED using the EXTERNAL SDK at ${ASIO_SDK_DIR}.")
  else()
    message(STATUS "ArtLux: ASIO ENABLED using JUCE's vendored headers. This build carries Steinberg's terms — see NOTICE.")
  endif()
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
