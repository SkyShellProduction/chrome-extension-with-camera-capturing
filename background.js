import { getSettings, saveSettings, STATE_COLORS } from './common.js';
import * as db from './db.js';
import * as activity from './activity.js';

const OFFSCREEN_URL = 'offscreen.html';
const GAP_MS = 60000; // heartbeats come every 15 s; a minute without one means a gap (sleep, freeze)

// Ask the system instead of keeping a variable: the service worker can be unloaded at any time.
async function isLocked() {
  try { return (await chrome.idle.queryState(60)) === 'locked'; } catch { return false; }
}

let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch(e => console.error(e));
  return queue;
}

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
      justification: 'Detecting whether the user is at the computer using the webcam'
    });
  } catch (e) {
    if (!String(e).includes('single offscreen')) throw e;
  }
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

function notify() {
  return chrome.storage.local.set({ lastWrite: Date.now() });
}

function recordState(state, since) {
  return serial(async () => {
    const now = Date.now();
    const last = await db.getLast();
    let start = Math.min(since || now, now);

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
      start = Math.min(Math.max(start, last.end), now);
    }
    await db.putSegment({ s: state, start, end: now, open: true });
    await chrome.storage.local.set({ currentState: state, lastWrite: now });
    setBadge(state);
    activity.refresh();
  });
}

function heartbeat() {
  return serial(async () => {
    const now = Date.now();
    const last = await db.getLast();
    if (last && last.open) {
      if (now - last.end > GAP_MS) {
        // Close the old interval at its last known moment so sleep isn't counted as desk time
        last.open = false;
        await db.putSegment(last);
        await db.putSegment({ s: last.s, start: now, end: now, open: true });
      } else {
        last.end = now;
        await db.putSegment(last);
      }
    } else {
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

async function pruneIfNeeded() {
  const { lastPrune = 0 } = await chrome.storage.local.get('lastPrune');
  if (Date.now() - lastPrune < 6 * 3600000) return;
  const { keepDays } = await getSettings();
  await serial(() => db.deleteOlderThan(Date.now() - keepDays * 86400000));
  await activity.prune();
  await chrome.storage.local.set({ lastPrune: Date.now() });
}

// v1.0 kept history in chrome.storage; move it to IndexedDB
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
  });
}

function setBadge(state) {
  const text = { present: 'ON', phone: 'TEL', away: 'AFK', off: '' }[state] ?? '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: STATE_COLORS[state] || '#5f6368' });
}

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
  await serial(async () => {
    const last = await db.getLast();
    if (last && last.open && Date.now() - last.end > GAP_MS) { last.open = false; await db.putSegment(last); }
  });
  pruneIfNeeded();
  const { enabled } = await getSettings();
  if (!enabled) setBadge('off');
  else if (!(await isLocked())) await ensureOffscreen();
}

// Screen lock: turn the camera off and count the locked time as "away"
chrome.idle.onStateChanged.addListener(async (state) => {
  activity.refresh();
  const { enabled } = await getSettings();
  if (!enabled) return;
  if (state === 'locked') {
    await closeOffscreen();
    await recordState('away', Date.now());
  } else if (state === 'active' && !(await hasOffscreen())) {
    await serial(async () => {
      const last = await db.getLast();
      if (last && last.open && last.s === 'away') { last.end = Date.now(); await db.putSegment(last); await notify(); }
    });
    await ensureOffscreen();
  }
});

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
  if (enabled && !(await isLocked()) && !(await hasOffscreen())) await ensureOffscreen();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === 'offscreen') return;

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

// Listeners must be registered synchronously every time the worker starts
activity.register();
activity.boot();
chrome.alarms.get('watchdog').then(a => { if (!a) chrome.alarms.create('watchdog', { periodInMinutes: 1 }); });
migrateFromStorage();
