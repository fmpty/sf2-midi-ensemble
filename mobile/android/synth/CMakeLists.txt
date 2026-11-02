cmake_minimum_required(VERSION 3.10.2)
project(nativesynth)

# 原生低延迟合成：AAudio 输出 + TinySoundFont 合成 SF2
add_library(nativesynth SHARED native_synth.cpp)

target_include_directories(nativesynth PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

set_target_properties(nativesynth PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)

target_compile_options(nativesynth PRIVATE -O3 -fno-exceptions -fno-rtti -Wall)

find_library(log-lib log)
find_library(aaudio-lib aaudio)

target_link_libraries(nativesynth ${log-lib} ${aaudio-lib})
