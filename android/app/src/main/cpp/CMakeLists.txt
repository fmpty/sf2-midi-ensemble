cmake_minimum_required(VERSION 3.10.2)
project(nativesynth)

# Android 15+ / 16KB 页设备：ELF LOAD 段须 0x4000 对齐（与 ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES 双保险）
if(ANDROID)
    set(_16k_link "-Wl,-z,max-page-size=16384")
    string(APPEND CMAKE_SHARED_LINKER_FLAGS " ${_16k_link} -Wl,-z,common-page-size=16384")
    string(APPEND CMAKE_MODULE_LINKER_FLAGS " ${_16k_link} -Wl,-z,common-page-size=16384")
    string(APPEND CMAKE_EXE_LINKER_FLAGS " ${_16k_link} -Wl,-z,common-page-size=16384")
endif()

# 原生低延迟合成：AAudio 输出 + TinySoundFont 合成 SF2
add_library(nativesynth SHARED native_synth.cpp)

target_include_directories(nativesynth PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

set_target_properties(nativesynth PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)

target_compile_options(nativesynth PRIVATE -O3 -fno-exceptions -fno-rtti -Wall)

find_library(log-lib log)
find_library(aaudio-lib aaudio)

target_link_libraries(nativesynth ${log-lib} ${aaudio-lib})

target_link_options(nativesynth PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384")
