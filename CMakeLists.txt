cmake_minimum_required(VERSION 3.21)
project(roar)

set_property(GLOBAL PROPERTY OS_FOLDERS ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
# build.sh passes x86_64 + third_party/cef-x64 for the Intel half of a universal build.
set(PROJECT_ARCH "arm64" CACHE STRING "arm64 or x86_64")
set(CEF_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/cef" CACHE PATH "CEF binary distribution")
set(CMAKE_OSX_ARCHITECTURES "${PROJECT_ARCH}")
list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)

add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH} libcef_dll_wrapper)
add_subdirectory(src)
