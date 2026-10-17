# Included from src/CMakeLists.txt when OS_WINDOWS (set by CEF's cef_variables.cmake).
# Layout follows CEF's cefsimple: roar.exe beside libcef.dll and CEF's resources.
# Untested: written without a Windows toolchain (docs/windows-port.md).

list(APPEND ROAR_SRCS win/main.cc win/platform.cc)

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
target_compile_definitions(${CEF_TARGET} PRIVATE ROAR_SOURCE_DIR="${CMAKE_SOURCE_DIR}" UNICODE _UNICODE)
target_link_libraries(${CEF_TARGET} libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS} SQLite::SQLite3
  ws2_32 iphlpapi bcrypt shlwapi shell32 ole32 user32 dwmapi)
set_target_properties(${CEF_TARGET} PROPERTIES OUTPUT_NAME "Roar")

# CEF runtime next to the exe, then Roar's own resources (platform::ResourcePath is the exe dir).
COPY_FILES("${CEF_TARGET}" "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "${CEF_TARGET_OUT_DIR}")
COPY_FILES("${CEF_TARGET}" "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")
add_custom_command(TARGET ${CEF_TARGET} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${ROAR_RES}/ui" "${CEF_TARGET_OUT_DIR}/ui"
  VERBATIM)
