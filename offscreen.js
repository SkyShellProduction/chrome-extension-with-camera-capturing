// Offscreen-документ: держит камеру и раз в секунду прогоняет кадр через две локальные модели MediaPipe:
//  1) FaceLandmarker — есть ли лицо, наклон головы, куда смотрят глаза
//  2) ObjectDetector (EfficientDet, классы COCO) — есть ли в кадре "person" и "cell phone"
import { FilesetResolver, FaceLandmarker, ObjectDetector } from './vendor/vision_bundle.mjs';

// Глушим служебные логи MediaPipe (I/W-сообщения), чтобы Chrome не показывал их как ошибки
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const text = String(args[0] ?? '');
    if (/^[IW]\d{4} |^INFO: |XNNPACK|Graph successfully started/.test(text)) return;
    orig(...args);
  };
}

const url = (p) => chrome.runtime.getURL(p);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

let settings;
let faceModel, objModel, video, timer;
let stable = null;            // текущее подтверждённое состояние
const history = [];           // [{t, s}] сырые состояния за последние 2 минуты
let calibration = null;       // { until, values: [] }
let lastHeartbeat = 0;

async function createModel(Task, fileset, options) {
  // Сначала пробуем GPU, при ошибке — CPU
  try {
    return await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
  } catch (e) {
    console.warn('GPU недоступен, использую CPU', e);
    return await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
  }
}

async function init() {
  settings = await chrome.runtime.sendMessage({ type: 'getSettings' });

  try {
    const fileset = await FilesetResolver.forVisionTasks(url('vendor/wasm'));
    faceModel = await createModel(FaceLandmarker, fileset, {
      baseOptions: { modelAssetPath: url('models/face_landmarker.task') },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true
    });
    objModel = await createModel(ObjectDetector, fileset, {
      baseOptions: { modelAssetPath: url('models/efficientdet_lite0.tflite') },
      runningMode: 'VIDEO',
      scoreThreshold: 0.25,
      maxResults: 10,
      categoryAllowlist: ['person', 'cell phone']
    });
  } catch (e) {
    send({ type: 'error', error: 'models', message: String(e?.message || e) });
    return;
  }

  try {
    await openCamera();
  } catch (e) {
    send({ type: 'error', error: 'camera', message: `${e.name}: ${e.message}` });
    return;
  }

  send({ type: 'ready' });
  schedule();
}

async function openCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 15 } });
  video = document.getElementById('cam');
  video.srcObject = stream;
  await video.play();
  // Камера отключилась (сон, выдернули USB) — переподключаемся
  stream.getVideoTracks()[0].onended = () => reopenCamera();
}

// После сна ноутбука поток может "замёрзнуть": кадр не меняется. Тогда переоткрываем камеру.
let reopening = false, lastVideoTime = -1, frozenTicks = 0, lastTickAt = Date.now();
async function reopenCamera() {
  if (reopening) return;
  reopening = true;
  try { video?.srcObject?.getTracks().forEach(t => t.stop()); } catch {}
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await openCamera(); reopening = false; frozenTicks = 0; return; }
    catch { await new Promise(r => setTimeout(r, 3000)); }
  }
  reopening = false;
  send({ type: 'error', error: 'camera', message: 'Камера пропала и не переподключилась' });
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(tick, settings.intervalMs);
}

function analyze() {
  const ts = performance.now();
  const face = faceModel.detectForVideo(video, ts);
  const objs = objModel.detectForVideo(video, ts);

  let phoneScore = 0, personScore = 0;
  for (const d of objs.detections || []) {
    const c = d.categories[0];
    if (c.categoryName === 'cell phone') phoneScore = Math.max(phoneScore, c.score);
    if (c.categoryName === 'person') personScore = Math.max(personScore, c.score);
  }

  const faceFound = face.faceLandmarks.length > 0;
  let ratio = null, eyeDown = 0;
  if (faceFound) {
    const lm = face.faceLandmarks[0];
    // 10 — верх лба, 1 — кончик носа, 152 — подбородок.
    // Когда голова наклоняется вниз, нос в проекции "сползает" к подбородку и ratio растёт.
    ratio = (lm[1].y - lm[10].y) / (lm[152].y - lm[10].y);
    const cats = face.faceBlendshapes?.[0]?.categories || [];
    const get = (n) => cats.find(c => c.categoryName === n)?.score || 0;
    eyeDown = (get('eyeLookDownLeft') + get('eyeLookDownRight')) / 2;
  }

  const headDown = ratio !== null && ratio - settings.baselineRatio > settings.pitchDelta;
  const lookingDown = headDown || eyeDown > settings.eyeDownThreshold;
  const phoneSeen = phoneScore >= settings.phoneThreshold;

  let raw;
  if (!faceFound && personScore < 0.5 && !phoneSeen) raw = 'away';
  else if (phoneSeen && (lookingDown || !faceFound)) raw = 'phone';
  else if (lookingDown && settings.lookDownCountsAsPhone) raw = 'phone';
  else raw = 'present';

  return { raw, faceFound, ratio, eyeDown, headDown, phoneScore, personScore };
}

function delayFor(state) {
  const sec = state === 'away' ? settings.awayDelaySec
    : state === 'phone' ? settings.phoneDelaySec
    : settings.returnDelaySec;
  return Math.min(sec, 110) * 1000;
}

// Сглаживание: состояние меняется, только если новое "сырое" состояние держится
// заданное время в ≥75% кадров. Это убирает мигание из-за отдельных ошибок модели.
function updateState(raw) {
  const t = Date.now();
  history.push({ t, s: raw });
  while (history.length && t - history[0].t > 120000) history.shift();

  for (const s of ['away', 'phone', 'present']) {
    if (s === stable) continue;
    const need = delayFor(s);
    if (t - history[0].t < need - settings.intervalMs) continue; // мало данных
    const win = history.filter(h => t - h.t <= need);
    if (!win.length) continue;
    const frac = win.filter(h => h.s === s).length / win.length;
    if (frac >= 0.75) {
      stable = s;
      const first = win.find(h => h.s === s);
      send({ type: 'state', state: s, since: first.t });
      break;
    }
  }
}

function tick() {
  const now = Date.now();
  // Таймер "проспал" больше 30 с — компьютер был во сне. Старая история кадров больше не актуальна.
  if (now - lastTickAt > 30000) { history.length = 0; stable = null; reopenCamera(); }
  lastTickAt = now;

  if (reopening || !video || video.readyState < 2) return;

  if (video.currentTime === lastVideoTime) {
    if (++frozenTicks >= 5) { reopenCamera(); return; }
  } else {
    frozenTicks = 0;
    lastVideoTime = video.currentTime;
  }
  let r;
  try { r = analyze(); } catch (e) { console.error(e); return; }

  updateState(r.raw);

  if (calibration) {
    if (r.ratio !== null) calibration.values.push(r.ratio);
    if (Date.now() > calibration.until) finishCalibration();
  }

  // Живые сигналы для попапа (если он открыт)
  send({ type: 'raw', ...r, stable, calibrating: !!calibration });

  if (Date.now() - lastHeartbeat > 15000) {
    lastHeartbeat = Date.now();
    send({ type: 'heartbeat' });
  }
}

function finishCalibration() {
  const v = calibration.values.sort((a, b) => a - b);
  calibration = null;
  if (v.length < 3) {
    send({ type: 'calibrationFailed', reason: 'Лицо не найдено в кадре' });
    return;
  }
  const median = v[Math.floor(v.length / 2)];
  settings.baselineRatio = median;
  send({ type: 'calibrated', ratio: median });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'settings') {
    const intervalChanged = msg.settings.intervalMs !== settings.intervalMs;
    settings = msg.settings;
    if (intervalChanged) schedule();
  }
  if (msg.type === 'calibrate') {
    calibration = { until: Date.now() + 5000, values: [] };
  }
});

init();
