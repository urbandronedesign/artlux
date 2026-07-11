cmake_minimum_required(VERSION 3.22)
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

# ── The addon target ────────────────────────────────────────────────────────────────────────────
file(GLOB SOURCE_FILES "src/*.cpp")
add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})

# JUCE global config — keep the spike lean (no curl/browser/ASIO; codecs enabled later in P0c).
target_compile_definitions(${PROJECT_NAME} PRIVATE
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_ASIO=0
  JUCE_USE_FLAC=1
  JUCE_USE_OGGVORBIS=1
  JUCE_MODAL_LOOPS_PERMITTED=0
  JUCE_DISPLAY_SPLASH_SCREEN=0
  DONT_SET_USING_JUCE_NAMESPACE=1
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_audio_basics
  juce::juce_core
  juce::juce_events
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags
)

# Windows: generate the node.lib import library so the addon links against the host's exports.
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()
