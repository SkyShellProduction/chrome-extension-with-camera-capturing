#!/usr/bin/env bash
# Downloads MediaPipe Tasks Vision and two models into the extension folder.
# Usage: bash setup-models.sh
set -euo pipefail
cd "$(dirname "$0")"

V="0.10.14"
CDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V"
mkdir -p vendor/wasm models

get() { echo "Downloading $1 ..."; curl -fL --retry 3 -o "$1" "$2"; }

get vendor/vision_bundle.mjs                     "$CDN/vision_bundle.mjs"
get vendor/wasm/vision_wasm_internal.js          "$CDN/wasm/vision_wasm_internal.js"
get vendor/wasm/vision_wasm_internal.wasm        "$CDN/wasm/vision_wasm_internal.wasm"
get vendor/wasm/vision_wasm_nosimd_internal.js   "$CDN/wasm/vision_wasm_nosimd_internal.js"
get vendor/wasm/vision_wasm_nosimd_internal.wasm "$CDN/wasm/vision_wasm_nosimd_internal.wasm"
get models/face_landmarker.task      "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
get models/efficientdet_lite0.tflite "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite"

echo
echo "Done. Open chrome://extensions and click Reload on Desk Time Tracker."
