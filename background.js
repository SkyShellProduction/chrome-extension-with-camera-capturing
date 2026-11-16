// Фоновый service worker: управляет камерой (через offscreen-документ) и пишет историю в IndexedDB.
import { getSettings, saveSettings, STATE_COLORS } from './common.js';
import * as db from './db.js';
import * as activity from './activity.js';

const OFFSCREEN_URL = 'offscreen.html';
const GAP_MS = 60000; // heartbeat идёт каждые 15 с; если его не было минуту — значит, был разрыв

// Состояние блокировки спрашиваем у системы, а не храним в переменной:
// service worker может быть выгружен Chrome в любой момент, и переменная потеряется.
async function isLocked() {
  try { return (await chrome.idle.queryState(60)) === 'locked'; } catch { return false; }
}

// ---------- последовательная запись в storage, чтобы не было гонок ----------
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch(e => console.error(e));
  return queue;
}

// ---------- offscreen-документ с камерой ----------
async function hasOffscreen() {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Определение присутствия человека за компьютером по веб-камере'
    });
  } catch (e) {
    if (!String(e).includes('single offscreen')) throw e;
  }
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

// ---------- запись сегментов (IndexedDB) ----------
// segment = { id, s: 'present'|'phone'|'away', start, end, open }

// Сообщаем открытым страницам (попап, статистика), что история изменилась
function notify() {
  return chrome.storage.local.set({ lastWrite: Date.now() });
}

function recordState(state, since) {
  return serial(async () => {
    const now = Date.now();
    const last = await db.getLast();
    let start = Math.min(since || now, now);

    // Долго не было heartbeat (сон ноутбука, браузер завис) — этот промежуток не считаем
    if (last && last.open && now - last.end > GAP_MS) {
      last.open = false;
      await db.putSegment(last);
      start = Math.max(start, last.end);
    }

    if (last && last.open) {
      if (last.s === state) { last.end = now; await db.putSegment(last); await notify(); return; }
      start = Math.min(Math.max(start, last.start), now);
      last.end = start;
      last.open = false;
      if (last.end <= last.start) await db.deleteSegment(last.id);
      else await db.putSegment(last);
    } else if (last) {
      start = Math.min(Math.max(start, last.end), now); // last.end может быть "в будущем" после перевода часов
    }
    await db.putSegment({ s: state, start, end: now, open: true });
    await chrome.storage.local.set({ currentState: state, lastWrite: now });
    setBadge(state);
    activity.refresh(); // "отошёл" ставит учёт вкладок на паузу
  });
}

function heartbeat() {
  return serial(async () => {
    const now = Date.now();
    const last = await db.getLast();
    if (last && last.open) {
      if (now - last.end > GAP_MS) {
        // Разрыв (компьютер спал без блокировки): закрываем старый интервал на последнем известном
        // моменте и начинаем новый с того же состояния — сон не попадёт в "за компьютером"
        last.open = false;
        await db.putSegment(last);
        await db.putSegment({ s: last.s, start: now, end: now, open: true });
      } else {
        last.end = now;
        await db.putSegment(last);
      }
    } else {
      // Открытого интервала нет (например, историю заменили импортом) — продолжаем текущее состояние
      const { currentState } = await chrome.storage.local.get('currentState');
      if (!db.VALID_STATES.includes(currentState)) return;
      await db.putSegment({ s: currentState, start: Math.max(now - 15000, last ? last.end : 0), end: now, open: true });
    }
    await notify();
  });
}

function closeCurrent() {
  return serial(async () => {
    const last = await db.getLast();
    if (last && last.open) { last.open = false; await db.putSegment(last); }
    await chrome.storage.local.set({ currentState: 'off', lastWrite: Date.now() });
  });
}

// Удаление старой истории — не чаще раза в 6 часов
async function pruneIfNeeded() {
  const { lastPrune = 0 } = await chrome.storage.local.get('lastPrune');
  if (Date.now() - lastPrune < 6 * 3600000) return;
  const { keepDays } = await getSettings();
  await serial(() => db.deleteOlderThan(Date.now() - keepDays * 86400000));
  await activity.prune();
  await chrome.storage.local.set({ lastPrune: Date.now() });
}

// Перенос истории из chrome.storage (версия 1.0) в IndexedDB
async function migrateFromStorage() {
  const { segments } = await chrome.storage.local.get('segments');
  if (!Array.isArray(segments) || !segments.length) {
    if (segments) await chrome.storage.local.remove('segments');
    return;
  }
  await serial(async () => {
    const { segments: list } = db.normalizeImported({ segments });
    await db.importSegments(list, 'merge');
    await chrome.storage.local.remove('segments');
    console.log(`Перенесено в IndexedDB: ${list.length} интервалов`);
  });
}

function setBadge(state) {
  const text = { present: 'ON', phone: 'TEL', away: 'AFK', off: '' }[state] ?? '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: STATE_COLORS[state] || '#5f6368' });
}

// ---------- старт / стоп ----------
async function start() {
  await saveSettings({ enabled: true });
  await chrome.storage.local.remove('lastError');
  await ensureOffscreen();
}

async function stop() {
  await saveSettings({ enabled: false });
  await closeOffscreen();
  await closeCurrent();
  setBadge('off');
  activity.refresh();
}

async function resumeIfEnabled() {
  await migrateFromStorage();
  // Если браузер был закрыт — последний интервал остался "открытым" с концом на последнем heartbeat.
  await serial(async () => {
    const last = await db.getLast();
    if (last && last.open && Date.now() - last.end > GAP_MS) { last.open = false; await db.putSegment(last); }
  });
  pruneIfNeeded();
  const { enabled } = await getSettings();
  if (!enabled) setBadge('off');
  else if (!(await isLocked())) await ensureOffscreen();
}

// ---------- блокировка экрана: выключаем камеру ----------
chrome.idle.onStateChanged.addListener(async (state) => {
  activity.refresh(); // блокировка экрана ставит учёт вкладок на паузу
  const { enabled } = await getSettings();
  if (!enabled) return;
  if (state === 'locked') {
    await closeOffscreen();
    await recordState('away', Date.now());
  } else if (state === 'active' && !(await hasOffscreen())) {
    // Разблокировали экран: всё время блокировки засчитываем как "отошёл" и включаем камеру
    await serial(async () => {
      const last = await db.getLast();
      if (last && last.open && last.s === 'away') { last.end = Date.now(); await db.putSegment(last); await notify(); }
    });
    await ensureOffscreen();
  }
});

// ---------- события расширения ----------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: 'setup.html' });
  chrome.alarms.create('watchdog', { periodInMinutes: 1 });
  resumeIfEnabled();
});

chrome.runtime.onStartup.addListener(resumeIfEnabled);

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'shot') { activity.captureShot(); return; }
  if (a.name !== 'watchdog') return;
  activity.tick();
  pruneIfNeeded();
  const { enabled } = await getSettings();
  // если offscreen-документ упал — поднимаем заново
  if (enabled && !(await isLocked()) && !(await hasOffscreen())) await ensureOffscreen();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // это сообщение для offscreen-документа

  switch (msg.type) {
    case 'getSettings':
      getSettings().then(sendResponse);
      return true;
    case 'state':
      recordState(msg.state, msg.since);
      break;
    case 'heartbeat':
      heartbeat();
      break;
    case 'error':
      chrome.storage.local.set({ lastError: { kind: msg.error, message: msg.message, at: Date.now() } });
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
      closeOffscreen();
      break;
    case 'calibrated':
      saveSettings({ baselineRatio: msg.ratio }).then(s =>
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'settings', settings: s }).catch(() => {}));
      break;
    case 'start':
      start().then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'stop':
      stop().then(() => sendResponse({ ok: true }));
      return true;
    case 'settingsChanged':
      getSettings().then(s =>
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'settings', settings: s }).catch(() => {}));
      activity.scheduleShots();
      activity.refresh();
      break;
    case 'shotNow':
      activity.captureShot({ manual: true }).then(sendResponse, e => sendResponse({ error: String(e) }));
      return true;
  }
});

// Учёт вкладок: слушатели должны регистрироваться синхронно при каждом запуске воркера
activity.register();
activity.boot();
chrome.alarms.get('watchdog').then(a => { if (!a) chrome.alarms.create('watchdog', { periodInMinutes: 1 }); });

// Перенос старой истории при каждом пробуждении service worker (если переносить нечего — это один быстрый get)
migrateFromStorage();
