#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WASM_DIR="${ROOT_DIR}/extension/orcatune/wasm"
BUILD_DIR="${WASM_DIR}/build"
DIST_DIR="${ROOT_DIR}/extension/orcatune/wasm"

EM_PREFIX="/opt/homebrew/Cellar/emscripten/5.0.5/libexec"
export PATH="/opt/homebrew/opt/python@3.14/bin:/opt/homebrew/bin:${PATH}"
export PYTHON="/opt/homebrew/opt/python@3.14/bin/python3.14"
export EM_LLVM_ROOT="${EM_PREFIX}/llvm/bin"
export EM_BINARYEN_ROOT="${EM_PREFIX}/binaryen"

if ! command -v emcmake >/dev/null 2>&1; then
    echo "Missing emcmake. Install/activate Emscripten first."
    exit 1
fi

rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

emcmake cmake -S "${WASM_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${BUILD_DIR}" --config Release -j 8

if [[ -f "${BUILD_DIR}/orcatune_bungee.js" && -f "${BUILD_DIR}/orcatune_bungee.wasm" ]]; then
    cp "${BUILD_DIR}/orcatune_bungee.js" "${DIST_DIR}/orcatune_bungee.js"
    cp "${BUILD_DIR}/orcatune_bungee.wasm" "${DIST_DIR}/orcatune_bungee.wasm"
fi

echo "WASM build done -> ${DIST_DIR}/orcatune_bungee.{js,wasm}"
