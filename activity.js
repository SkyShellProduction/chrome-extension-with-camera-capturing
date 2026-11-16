// Отслеживание вкладок, фокуса браузера и периодические скриншоты.
// Работает в service worker. Всё состояние, которое нужно пережить выгрузку воркера,
// лежит в chrome.storage.session (очищается при перезапуске браузера) и IndexedDB.
import * as db from './db.js';
import { getSettings } from './common.js';

const GAP_MS = 3 * 60000;      // если интервал не обновлялся 3 мин — был сон/выгрузка, разрываем
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn).catch(e => console.error('[activity]', e)));

const sget = async (k) => (await chrome.storage.session.get(k))[k];
const sset = (o) => chrome.storage.session.set(o);
const notify = () => chrome.storage.local.set({ lastWrite: Date.now() });

export function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome-extension:' && u.hostname === chrome.runtime.id) return 'Desk Time Tracker';
    return u.hostname || u.protocol.replace(':', '');
  } catch { return ''; }
}
const tabUrl = (t) => t.url || t.pendingUrl || '';

async function isLocked() {
  try { return (await chrome.idle.queryState(60)) === 'locked'; } catch { return false; }
}

// Пауза: отслеживание выключено, экран заблокирован или камера видит, что вы отошли
async function isPaused(s) {
  if (!s.trackTabs) return true;
  if (await isLocked()) return true;
  const { currentState } = await chrome.storage.local.get('currentState');
  return s.enabled && currentState === 'away';
}

// ---------- журнал вкладок ----------
async function tabMap() { return (await sget('tabMap')) || {}; }

async function openTabRecord(tab, restored = false) {
  const map = await tabMap();
  if (map[tab.id]) return map[tab.id];
  const url = tabUrl(tab);
  const id = await db.put('tablog', {
    tabId: tab.id, openedAt: Date.now(), closedAt: null, end: Infinity,
    url, title: tab.title || '', domain: domainOf(url), activeMs: 0, pages: 1, restored
  });
  map[tab.id] = id;
  await sset({ tabMap: map });
  return id;
}

async function updateTabRecord(tab) {
  const id = (await tabMap())[tab.id] || await openTabRecord(tab);
  const rec = await db.get('tablog', id);
  if (!rec) return;
  const url = tabUrl(tab);
  if (url && url !== rec.url) { rec.url = url; rec.domain = domainOf(url); rec.pages = (rec.pages || 1) + 1; }
  if (tab.title) rec.title = tab.title;
  await db.put('tablog', rec);
}

async function closeTabRecord(tabId) {
  const map = await tabMap();
  const id = map[tabId];
  if (!id) return;
  const rec = await db.get('tablog', id);
  if (rec) { rec.closedAt = rec.end = Date.now(); await db.put('tablog', rec); }
  delete map[tabId];
  await sset({ tabMap: map });
}

// ---------- текущий интервал активности ----------
async function finish(rec, at) {
  rec.end = Math.max(rec.start, at);
  rec.open = false;
  await db.put('activity', rec);
  if (rec.kind === 'tab' && rec.tabRec) {
    const t = await db.get('tablog', rec.tabRec);
    if (t) { t.activeMs = (t.activeMs || 0) + (rec.end - rec.start); await db.put('tablog', t); }
  }
  await sset({ cur: null });
}

async function whatIsOnScreen() {
  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal', 'popup'] }); } catch {}
  if (!win || !win.focused || win.state === 'minimized') return { kind: 'blur' };
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab ? { kind: 'tab', tab } : { kind: 'blur' };
}

async function refreshInner() {
  const s = await getSettings();
  const now = Date.now();
  const cur = await sget('cur');
  let rec = cur ? await db.get('activity', cur.id) : null;
  if (rec && !rec.open) rec = null;
  if (rec && now - rec.end > GAP_MS) { await finish(rec, rec.end); rec = null; }

  if (await isPaused(s)) { if (rec) await finish(rec, now); await notify(); return; }

  const target = await whatIsOnScreen();
  const same = rec && rec.kind === target.kind &&
    (target.kind === 'blur' || (rec.tabId === target.tab.id && rec.url === tabUrl(target.tab)));

  if (same) {
    rec.end = now;
    if (target.tab?.title) rec.title = target.tab.title;
    await db.put('activity', rec);
    return;
  }
  if (rec) await finish(rec, now);

  const next = { kind: target.kind, start: now, end: now, open: true, url: '', domain: '', title: '' };
  if (target.kind === 'tab') {
    const t = target.tab;
    next.tabRec = await openTabRecord(t);
    next.tabId = t.id;
    next.url = tabUrl(t);
    next.domain = domainOf(next.url);
    next.title = t.title || '';
  }
  const id = await db.put('activity', next);
  await sset({ cur: { id } });
  await notify();
}

// ---------- инициализация после старта браузера / обновления расширения ----------
async function initInner() {
  if (await sget('inited')) return;
  const now = Date.now();
  const { lastAlive = now } = await chrome.storage.local.get('lastAlive');
  const recentlyAlive = now - lastAlive < GAP_MS; // расширение перезагрузили, а не браузер

  // Незакрытый интервал активности — закрываем на последнем известном моменте
  const last = await db.lastIn('activity');
  if (last && last.open) await finish(last, last.end);

  // Вкладки, которые были открыты: если браузер не перезапускался — продолжаем их записи
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(t => [t.id, t]));
  const openRecs = (await db.overlapping('tablog', now - 1, Infinity)).filter(r => r.end === Infinity);
  const map = {};
  for (const r of openRecs) {
    const t = byId.get(r.tabId);
    if (recentlyAlive && t && tabUrl(t) === r.url) { map[t.id] = r.id; continue; }
    r.closedAt = r.end = Math.max(r.openedAt, Math.min(lastAlive, now));
    await db.put('tablog', r);
  }
  await sset({ tabMap: map, cur: null, inited: true });
  for (const t of tabs) if (!map[t.id]) await openTabRecord(t, true);
}

const run = (fn) => serial(async () => { await initInner(); await fn(); });

// ---------- скриншоты ----------
function excluded(domain, list) {
  return String(list || '').split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean)
    .some(d => domain === d || domain.endsWith('.' + d));
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/data:(.*?);/)?.[1] || 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function captureShot({ manual = false } = {}) {
  const s = await getSettings();
  const result = async (r) => { await chrome.storage.local.set({ lastShot: { ts: Date.now(), ...r } }); return r; };

  if (!manual) {
    if (!s.screenshotsEnabled) return result({ skipped: 'выключено' });
    if (await isLocked()) return result({ skipped: 'экран заблокирован' });
    const { currentState } = await chrome.storage.local.get('currentState');
    if (s.screenshotSkipWhenAway && s.enabled && currentState === 'away') return result({ skipped: 'вы отошли' });
  }

  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch {}
  if (!win || win.state === 'minimized') return result({ skipped: 'браузер свёрнут' });
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab) return result({ skipped: 'нет активной вкладки' });
  const url = tabUrl(tab);
  const domain = domainOf(url);
  if (excluded(domain, s.screenshotExclude)) return result({ skipped: `сайт в исключениях (${domain})` });
  if (url.startsWith(chrome.runtime.getURL(''))) return result({ skipped: 'открыта страница расширения' });

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'jpeg', quality: 90 });
  } catch (e) {
    return result({ error: e.message }); // например, страницы chrome:// снимать нельзя
  }

  // Уменьшаем и пережимаем, чтобы скриншот занимал ~100 КБ
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
  const scale = Math.min(1, s.screenshotMaxWidth / bmp.width);
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: s.screenshotQuality });

  const ts = Date.now();
  const id = await db.put('shots', { ts, url, title: tab.title || '', domain, blob, w, h, size: blob.size, manual });
  await notify();
  return result({ ok: true, id, size: blob.size });
}

export async function scheduleShots() {
  const s = await getSettings();
  const existing = await chrome.alarms.get('shot');
  if (!s.screenshotsEnabled) { if (existing) await chrome.alarms.clear('shot'); return; }
  if (!existing || existing.periodInMinutes !== s.screenshotIntervalMin) {
    await chrome.alarms.create('shot', { delayInMinutes: s.screenshotIntervalMin, periodInMinutes: s.screenshotIntervalMin });
  }
}

export async function prune() {
  const s = await getSettings();
  const now = Date.now();
  await db.deleteBefore('activity', 'end', now - s.keepDays * 86400000);
  await db.deleteBefore('tablog', 'end', now - s.keepDays * 86400000);
  await db.deleteBefore('shots', 'ts', now - s.shotsKeepDays * 86400000);
}

// ---------- публичное API для background.js ----------
export const refresh = () => run(refreshInner);

// lastAlive пишем ПОСЛЕ инициализации: по нему initInner понимает, перезапускался ли браузер
const alive = () => chrome.storage.local.set({ lastAlive: Date.now() });

export function tick() {
  return refresh().then(alive);
}

let focusTimer = null;
export function register() {
  chrome.tabs.onCreated.addListener((tab) => run(() => openTabRecord(tab)));
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (!change.url && !change.title) return;
    run(async () => { await updateTabRecord(tab); if (tab.active) await refreshInner(); });
  });
  chrome.tabs.onRemoved.addListener((tabId) => run(async () => { await closeTabRecord(tabId); await refreshInner(); }));
  chrome.tabs.onActivated.addListener(() => refresh());
  chrome.tabs.onReplaced.addListener((added, removed) => run(async () => {
    const map = await tabMap();
    if (map[removed]) { map[added] = map[removed]; delete map[removed]; await sset({ tabMap: map }); }
  }));
  // При переключении между окнами Chrome сначала приходит "фокус потерян" — ждём немного, чтобы не мигать
  chrome.windows.onFocusChanged.addListener(() => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => refresh(), 600);
  });
}

export function boot() {
  scheduleShots();
  return refresh().then(alive);
}
