set(CEF_TARGET "roar")
set(CEF_HELPER_TARGET "roar_Helper")
set(CEF_HELPER_OUTPUT_NAME "Roar Helper")

set(ROAR_SHARED_SRCS shared.cc shared.h)
set(ROAR_SRCS
  ${ROAR_SHARED_SRCS}
  action_watch.cc action_watch.h
  agent_connect.cc agent_connect.h
  arc_import.cc arc_import.h
  browser_app.cc browser_app.h
  client.cc client.h
  controller.cc controller.h
  library.cc library.h
  link_clean.cc link_clean.h
  state.cc state.h
  mac/main.mm mac/platform.h mac/platform.mm mac/scripting.mm
  )
set(ROAR_HELPER_SRCS ${ROAR_SHARED_SRCS} mac/helper_main.cc)

SET_CEF_TARGET_OUT_DIR()
include_directories(${CMAKE_CURRENT_SOURCE_DIR})
set(CEF_APP "${CEF_TARGET_OUT_DIR}/Roar.app")
set(ROAR_RES "${CMAKE_SOURCE_DIR}/resources")

add_executable(${CEF_TARGET} MACOSX_BUNDLE ${ROAR_SRCS})
SET_EXECUTABLE_TARGET_PROPERTIES(${CEF_TARGET})
add_dependencies(${CEF_TARGET} libcef_dll_wrapper)
# Update Chromium runs scripts/update-cef.sh from this checkout.
target_compile_definitions(${CEF_TARGET} PRIVATE ROAR_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
target_link_libraries(${CEF_TARGET} libcef_dll_wrapper ${CEF_STANDARD_LIBS} "-framework Carbon" "-framework Security" "-framework QuartzCore" "-framework UserNotifications" sqlite3
  "-F${CMAKE_SOURCE_DIR}/third_party/Sparkle" "-framework Sparkle" "-Wl,-rpath,@executable_path/../Frameworks")
target_compile_options(${CEF_TARGET} PRIVATE "-F${CMAKE_SOURCE_DIR}/third_party/Sparkle")
set_target_properties(${CEF_TARGET} PROPERTIES
  MACOSX_BUNDLE_INFO_PLIST "${ROAR_RES}/Info.plist.in"
  OUTPUT_NAME "Roar")

add_custom_command(TARGET ${CEF_TARGET} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          "${CEF_BINARY_DIR}/Chromium Embedded Framework.framework"
          "${CEF_APP}/Contents/Frameworks/Chromium Embedded Framework.framework"
  COMMAND rm -rf "${CEF_APP}/Contents/Frameworks/Sparkle.framework"
  COMMAND ditto "${CMAKE_SOURCE_DIR}/third_party/Sparkle/Sparkle.framework" "${CEF_APP}/Contents/Frameworks/Sparkle.framework"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${ROAR_RES}/ui" "${CEF_APP}/Contents/Resources/ui"
  COMMAND ${CMAKE_COMMAND} -E copy "${ROAR_RES}/Roar.sdef" "${CEF_APP}/Contents/Resources/Roar.sdef"
  COMMAND ${CMAKE_COMMAND} -E copy "${ROAR_RES}/roar-mcp.sh" "${CEF_APP}/Contents/Resources/roar-mcp.sh"
  COMMAND ${CMAKE_COMMAND} -E copy "${ROAR_RES}/roar.icns" "${CEF_APP}/Contents/Resources/roar.icns"
  VERBATIM)

foreach(_suffix_list ${CEF_HELPER_APP_SUFFIXES})
  string(REPLACE ":" ";" _suffix_list ${_suffix_list})
  list(GET _suffix_list 0 _name_suffix)
  list(GET _suffix_list 1 _target_suffix)
  list(GET _suffix_list 2 _plist_suffix)
  set(_helper_target "${CEF_HELPER_TARGET}${_target_suffix}")
  set(_helper_output_name "${CEF_HELPER_OUTPUT_NAME}${_name_suffix}")
  set(_helper_info_plist "${CMAKE_CURRENT_BINARY_DIR}/helper-Info${_target_suffix}.plist")
  file(READ "${ROAR_RES}/helper-Info.plist.in" _plist_contents)
  string(REPLACE "\${EXECUTABLE_NAME}" "${_helper_output_name}" _plist_contents ${_plist_contents})
  string(REPLACE "\${PRODUCT_NAME}" "${_helper_output_name}" _plist_contents ${_plist_contents})
  string(REPLACE "\${BUNDLE_ID_SUFFIX}" "${_plist_suffix}" _plist_contents ${_plist_contents})
  file(WRITE ${_helper_info_plist} ${_plist_contents})

  add_executable(${_helper_target} MACOSX_BUNDLE ${ROAR_HELPER_SRCS})
  SET_EXECUTABLE_TARGET_PROPERTIES(${_helper_target})
  add_dependencies(${_helper_target} libcef_dll_wrapper)
  target_link_libraries(${_helper_target} libcef_dll_wrapper ${CEF_STANDARD_LIBS})
  set_target_properties(${_helper_target} PROPERTIES
    MACOSX_BUNDLE_INFO_PLIST ${_helper_info_plist}
    OUTPUT_NAME ${_helper_output_name})

  add_dependencies(${CEF_TARGET} "${_helper_target}")
  add_custom_command(TARGET ${CEF_TARGET} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CEF_TARGET_OUT_DIR}/${_helper_output_name}.app"
            "${CEF_APP}/Contents/Frameworks/${_helper_output_name}.app"
    VERBATIM)
endforeach()
