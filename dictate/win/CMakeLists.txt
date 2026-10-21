# roar-dictate.exe: Roar's Windows dictation engine. Built by scripts/build-dictate.ps1 against
# sherpa-onnx's prebuilt shared libraries (SHERPA_DIR), never part of the CEF build.
cmake_minimum_required(VERSION 3.21)
project(roar_dictate CXX)
set(CMAKE_CXX_STANDARD 17)
add_executable(roar-dictate main.cc)
target_compile_definitions(roar-dictate PRIVATE UNICODE _UNICODE NOMINMAX)
target_include_directories(roar-dictate PRIVATE "${SHERPA_DIR}/include")
target_link_libraries(roar-dictate "${SHERPA_DIR}/lib/sherpa-onnx-c-api.lib" winhttp winmm)
