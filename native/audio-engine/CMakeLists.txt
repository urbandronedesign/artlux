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

# ── ASIO: OFF by default, and that is a decision, not an oversight ───────────────────────────────────
# ASIO needs the Steinberg ASIO SDK, which is NOT redistributable and carries its own licence — it cannot
# be vendored here, and CI cannot fetch it. On top of that we have no ASIO hardware to test against, and
# this project ships nothing it cannot hear.
#
# WASAPI *exclusive* mode is compiled in unconditionally and is what delivers discrete multichannel output
# on Windows (see AudioSettings' device picker, which groups devices by driver type). ASIO buys lower
# latency, which a show bed does not need.
#
# To build with ASIO: download the SDK, then
#     cmake -DARTLUX_ENABLE_ASIO=ON -DASIO_SDK_DIR=C:/path/to/asiosdk/common
# See docs/DEVELOPMENT.md ▸ ASIO. NOTE: doing so adds a THIRD licence obligation (Steinberg's) to a build
# that already carries JUCE's — which is NOT YET ELECTED (see NOTICE) — and libspatialaudio's LGPL.
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
