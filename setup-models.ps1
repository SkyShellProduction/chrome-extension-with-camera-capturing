# Скачивает библиотеку MediaPipe Tasks Vision и две модели в папку расширения.
# Запуск: правый клик -> "Выполнить с помощью PowerShell"
# или в терминале:  powershell -ExecutionPolicy Bypass -File .\setup-models.ps1

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-Location $PSScriptRoot

$v = "0.10.14"
$cdn = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$v"
$files = @{
  "vendor/vision_bundle.mjs"                    = "$cdn/vision_bundle.mjs"
  "vendor/wasm/vision_wasm_internal.js"         = "$cdn/wasm/vision_wasm_internal.js"
  "vendor/wasm/vision_wasm_internal.wasm"       = "$cdn/wasm/vision_wasm_internal.wasm"
  "vendor/wasm/vision_wasm_nosimd_internal.js"  = "$cdn/wasm/vision_wasm_nosimd_internal.js"
  "vendor/wasm/vision_wasm_nosimd_internal.wasm"= "$cdn/wasm/vision_wasm_nosimd_internal.wasm"
  "models/face_landmarker.task"                 = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
  "models/efficientdet_lite0.tflite"            = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite"
}

New-Item -ItemType Directory -Force -Path "vendor/wasm", "models" | Out-Null
foreach ($f in $files.Keys) {
  Write-Host "Скачиваю $f ..."
  Invoke-WebRequest -Uri $files[$f] -OutFile $f -UseBasicParsing
}
Write-Host ""
Write-Host "Готово. Теперь откройте chrome://extensions и нажмите 'Обновить' у Desk Time Tracker." -ForegroundColor Green
Read-Host "Нажмите Enter для выхода"
