# Included from src/CMakeLists.txt when OS_WINDOWS (set by CEF's cef_variables.cmake).
# Layout follows CEF's cefsimple: roar.exe beside libcef.dll and CEF's resources.
# Untested: written without a Windows toolchain (docs/windows-port.md).

list(APPEND ROAR_SRCS win/main.cc win/platform.cc win/roar.rc)

SET_CEF_TARGET_OUT_DIR()
include_directories(${CMAKE_CURRENT_SOURCE_DIR})
set(ROAR_RES "${CMAKE_SOURCE_DIR}/resources")

# library.cc reads other browsers' history databases; Windows ships no sqlite3, so
# take it from vcpkg (`vcpkg install sqlite3:x64-windows-static`) or any CMake package.
find_package(SQLite3 REQUIRED)

ADD_LOGICAL_TARGET("libcef_lib" "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")

add_executable(${CEF_TARGET} WIN32 ${ROAR_SRCS})
SET_EXECUTABLE_TARGET_PROPERTIES(${CEF_TARGET})
add_dependencies(${CEF_TARGET} libcef_dll_wrapper)
target_compile_definitions(${CEF_TARGET} PRIVATE UNICODE _UNICODE)
# Update Chromium runs scripts/update-cef.sh from this checkout; releases don't carry the build machine's path.
if(ROAR_RELEASE)
  target_compile_definitions(${CEF_TARGET} PRIVATE ROAR_SOURCE_DIR="")
else()
  target_compile_definitions(${CEF_TARGET} PRIVATE ROAR_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
endif()
target_link_libraries(${CEF_TARGET} libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS} SQLite::SQLite3
  ws2_32 iphlpapi bcrypt shlwapi shell32 ole32 user32 dwmapi)

# WinSparkle (scripts/build.ps1 fetches it) and the version it compares against the appcast,
# read from the Mac Info.plist so both platforms ship the same numbers.
set(WINSPARKLE_DIR "${CMAKE_SOURCE_DIR}/third_party/winsparkle")
if(PROJECT_ARCH STREQUAL "arm64")
  set(WINSPARKLE_BIN "${WINSPARKLE_DIR}/ARM64/Release")
  set(ROAR_ARCH arm64)
else()
  set(WINSPARKLE_BIN "${WINSPARKLE_DIR}/x64/Release")
  set(ROAR_ARCH x64)
endif()
target_include_directories(${CEF_TARGET} PRIVATE "${WINSPARKLE_DIR}/include")
target_link_libraries(${CEF_TARGET} "${WINSPARKLE_BIN}/WinSparkle.lib")
file(READ "${CMAKE_SOURCE_DIR}/resources/Info.plist.in" _plist)
string(REGEX MATCH "CFBundleShortVersionString</key><string>([^<]+)" _ "${_plist}")
set(_short "${CMAKE_MATCH_1}")
string(REGEX MATCH "CFBundleVersion</key><string>([^<]+)" _ "${_plist}")
target_compile_definitions(${CEF_TARGET} PRIVATE ROAR_VERSION=L"${_short}" ROAR_BUILD=L"${CMAKE_MATCH_1}"
  ROAR_APPCAST="https://raw.githubusercontent.com/roarbrowser/roar/main/appcast-windows-${ROAR_ARCH}.xml")
set_target_properties(${CEF_TARGET} PROPERTIES OUTPUT_NAME "Roar")

# CEF runtime next to the exe, then Roar's own resources (platform::ResourcePath is the exe dir).
COPY_FILES("${CEF_TARGET}" "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "${CEF_TARGET_OUT_DIR}")
COPY_FILES("${CEF_TARGET}" "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")
add_custom_command(TARGET ${CEF_TARGET} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${ROAR_RES}/ui" "${CEF_TARGET_OUT_DIR}/ui"
  COMMAND ${CMAKE_COMMAND} -E copy "${WINSPARKLE_BIN}/WinSparkle.dll" "${CEF_TARGET_OUT_DIR}"
  VERBATIM)
