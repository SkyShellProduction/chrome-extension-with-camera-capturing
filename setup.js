const $ = (id) => document.getElementById(id);
let modelsOk = false, camOk = false;

const REQUIRED = [
  'vendor/vision_bundle.mjs',
  'vendor/wasm/vision_wasm_internal.js',
  'vendor/wasm/vision_wasm_internal.wasm',
  'models/face_landmarker.task',
  'models/efficientdet_lite0.tflite'
];

async function checkModels() {
  const missing = [];
  for (const p of REQUIRED) {
    try {
      const r = await fetch(chrome.runtime.getURL(p), { method: 'HEAD' });
      if (!r.ok) missing.push(p);
    } catch { missing.push(p); }
  }
  modelsOk = missing.length === 0;
  $('models').innerHTML = modelsOk
    ? '<span class="ok">✓ Все файлы моделей на месте</span>'
    : `<span class="bad">Не хватает файлов:</span><ul>${missing.map(m => `<li><code>${m}</code></li>`).join('')}</ul>
       <p class="small">Запустите в папке расширения <code>setup-models.ps1</code> (Windows) или <code>setup-models.sh</code> (macOS/Linux),
       затем нажмите «Обновить» у расширения на <code>chrome://extensions</code> и откройте эту страницу снова.</p>`;
  updateButtons();
}

async function checkCamPermission() {
  try {
    const p = await navigator.permissions.query({ name: 'camera' });
    if (p.state === 'granted') { camOk = true; $('camStatus').innerHTML = '<span class="ok">✓ Разрешение уже есть</span>'; }
  } catch {}
  updateButtons();
}

$('grant').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const v = $('preview');
    v.srcObject = stream; v.style.display = 'block'; await v.play();
    camOk = true;
    $('camStatus').innerHTML = '<span class="ok">✓ Доступ получен</span>';
    // Превью показываем 3 секунды, потом освобождаем камеру для фонового режима
    setTimeout(() => { stream.getTracks().forEach(t => t.stop()); v.style.display = 'none'; }, 3000);
  } catch (e) {
    $('camStatus').innerHTML = `<span class="bad">${e.name}: ${e.message}</span>`;
  }
  updateButtons();
};

function updateButtons() {
  $('startCal').disabled = !(modelsOk && camOk);
}

$('startCal').onclick = async () => {
  $('startCal').disabled = true;
  $('calStatus').textContent = 'Загружаю модели…';
  await chrome.storage.local.remove('lastError');
  calibSent = false;
  await chrome.runtime.sendMessage({ type: 'start' });
  // Если трекер уже был запущен, сигнала 'ready' не будет — калибруем по живым данным
};

let calibSent = true;
function startCalibration() {
  if (calibSent) return;
  calibSent = true;
  $('calStatus').textContent = 'Смотрите в экран 5 секунд…';
  setTimeout(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'calibrate' }), 1000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ready' || msg.type === 'raw') startCalibration();
  if (msg.type === 'calibrated') {
    $('calStatus').innerHTML = '<span class="ok">✓ Готово! Трекер работает. Эту вкладку можно закрыть.</span>';
  }
  if (msg.type === 'calibrationFailed') {
    $('calStatus').innerHTML = `<span class="bad">${msg.reason}. Сядьте напротив камеры и попробуйте снова.</span>`;
    $('startCal').disabled = false;
  }
  if (msg.type === 'error') {
    $('calStatus').innerHTML = `<span class="bad">Ошибка (${msg.error}): ${msg.message}</span>`;
    $('startCal').disabled = false;
  }
});

checkModels();
checkCamPermission();
