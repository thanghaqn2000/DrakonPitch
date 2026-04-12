cmake_minimum_required(VERSION 3.20)
project(orcatune_wasm LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(BUNGEE_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../modules/Bungee)

add_executable(orcatune_wasm
    ${CMAKE_CURRENT_SOURCE_DIR}/orcatune_wasm_entry.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../src/orcatune/OrcaTuneBungeeCore.cpp
    ${BUNGEE_ROOT}/src/Synthesis.cpp
    ${BUNGEE_ROOT}/src/Basic.cpp
    ${BUNGEE_ROOT}/src/Fourier.cpp
    ${BUNGEE_ROOT}/src/Grain.cpp
    ${BUNGEE_ROOT}/src/Grains.cpp
    ${BUNGEE_ROOT}/src/Input.cpp
    ${BUNGEE_ROOT}/src/Output.cpp
    ${BUNGEE_ROOT}/src/Partials.cpp
    ${BUNGEE_ROOT}/src/Resample.cpp
    ${BUNGEE_ROOT}/src/Stretch.cpp
    ${BUNGEE_ROOT}/src/Timing.cpp
    ${BUNGEE_ROOT}/src/Window.cpp
    ${BUNGEE_ROOT}/src/Assert.cpp
    ${BUNGEE_ROOT}/submodules/kissfft/kiss_fft.c
    ${BUNGEE_ROOT}/submodules/kissfft/kiss_fftr.c
    ${BUNGEE_ROOT}/submodules/kissfft/kiss_fftnd.c
    ${BUNGEE_ROOT}/submodules/kissfft/kiss_fftndr.c
    ${BUNGEE_ROOT}/submodules/kissfft/kfc.c
)

target_include_directories(orcatune_wasm PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../src
    ${BUNGEE_ROOT}
    ${BUNGEE_ROOT}/submodules
    ${BUNGEE_ROOT}/submodules/eigen
    ${BUNGEE_ROOT}/submodules/kissfft
)

target_compile_definitions(orcatune_wasm PRIVATE
    BUNGEE_SELF_TEST=0
    eigen_assert=BUNGEE_ASSERT1
)

set_target_properties(orcatune_wasm PROPERTIES
    OUTPUT_NAME "orcatune_bungee"
    SUFFIX ".js"
)

target_link_options(orcatune_wasm PRIVATE
    "-sWASM=1"
    "-sMODULARIZE=0"
    "-sEXPORT_ES6=0"
    "-g2"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sENVIRONMENT=web,worker"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_orcatune_create_processor','_orcatune_destroy_processor','_orcatune_set_semitones','_orcatune_reset','_orcatune_process_interleaved']"
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap']"
)
