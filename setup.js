const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    ? '<span class="ok">✓ All model files are in place</span>'
    : `<span class="bad">Missing files:</span><ul>${missing.map(m => `<li><code>${m}</code></li>`).join('')}</ul>
       <p class="small">Run <code>setup-models.sh</code> (macOS/Linux) or <code>setup-models.ps1</code> (Windows) in the extension folder,
       then click Reload on <code>chrome://extensions</code> and open this page again.</p>`;
  updateButtons();
}

async function checkCamPermission() {
  try {
    const p = await navigator.permissions.query({ name: 'camera' });
    if (p.state === 'granted') { camOk = true; $('camStatus').innerHTML = '<span class="ok">✓ Permission already granted</span>'; }
  } catch {}
  updateButtons();
}

$('grant').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const v = $('preview');
    v.srcObject = stream; v.style.display = 'block'; await v.play();
    camOk = true;
    $('camStatus').innerHTML = '<span class="ok">✓ Access granted</span>';
    // Show a short preview, then release the camera for background use
    setTimeout(() => { stream.getTracks().forEach(t => t.stop()); v.style.display = 'none'; }, 3000);
  } catch (e) {
    $('camStatus').innerHTML = `<span class="bad">${esc(e.name)}: ${esc(e.message)}</span>`;
  }
  updateButtons();
};

function updateButtons() {
  $('startCal').disabled = !(modelsOk && camOk);
}

let calibSent = true;

$('startCal').onclick = async () => {
  $('startCal').disabled = true;
  $('calStatus').textContent = 'Loading models…';
  await chrome.storage.local.remove('lastError');
  calibSent = false;
  // If the tracker is already running there is no 'ready' message, so live 'raw' messages trigger calibration
  await chrome.runtime.sendMessage({ type: 'start' });
};

function startCalibration() {
  if (calibSent) return;
  calibSent = true;
  $('calStatus').textContent = 'Look at the screen for 5 seconds…';
  setTimeout(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'calibrate' }), 1000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ready' || msg.type === 'raw') startCalibration();
  if (msg.type === 'calibrated') {
    $('calStatus').innerHTML = '<span class="ok">✓ Done! The tracker is running. You can close this tab.</span>';
  }
  if (msg.type === 'calibrationFailed') {
    $('calStatus').innerHTML = `<span class="bad">${esc(msg.reason)}. Sit in front of the camera and try again.</span>`;
    $('startCal').disabled = false;
  }
  if (msg.type === 'error') {
    $('calStatus').innerHTML = `<span class="bad">Error (${esc(msg.error)}): ${esc(msg.message)}</span>`;
    $('startCal').disabled = false;
  }
});

checkModels();
checkCamPermission();
