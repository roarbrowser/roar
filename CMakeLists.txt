cmake_minimum_required(VERSION 3.21)
project(roar)

set_property(GLOBAL PROPERTY OS_FOLDERS ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
# build.sh passes x86_64 + third_party/cef-x64 for the Intel half of a universal build.
if(WIN32)
  set(PROJECT_ARCH "x86_64" CACHE STRING "x86_64 or arm64")  # scripts/build.ps1
else()
  set(PROJECT_ARCH "arm64" CACHE STRING "arm64 or x86_64")
endif()
set(CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/cef" CACHE PATH "CEF binary distribution")
set(CMAKE_OSX_ARCHITECTURES "${PROJECT_ARCH}")
list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
# Keep this checkout's path (a home folder) out of the binary: CEF's wrapper logs __FILE__.
add_compile_options("-ffile-prefix-map=${CMAKE_SOURCE_DIR}/=")
# Release builds (release.sh) are for other Macs, which have no checkout to rebuild from.
option(ROAR_RELEASE "Build for distribution: no source checkout baked in" OFF)

add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH} libcef_dll_wrapper)
add_subdirectory(src)
